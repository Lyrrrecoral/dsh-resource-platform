/**
 * On-demand high-usage process snapshot for the Resources > Projects lookup.
 *
 * Read-only by construction: it samples /proc twice (RSS + CPU ticks), reads
 * cmdline/environ/cgroup for attribution, and never signals or mutates a
 * process. The endpoint is explicitly user-triggered; no background sampler
 * and no model-facing tool are added.
 *
 * CPU% is an approximation from the Linux clock-tick delta (default 100 Hz)
 * over the sample window. RSS is exact (pages × 4096 at read time).
 *
 * @module resource-allocation/process-usage
 */
import { readdirSync } from "node:fs";
import { parseCgroupPath, parseCmdline, parseSessionId, readProcessTable, readProcFile } from "./proc.js";

export const DEFAULT_PROCESS_LIMIT = 20;
export const MAX_PROCESS_LIMIT = 100;

function clampLimit(value) {
const n = Number(value);
return Number.isFinite(n) ? Math.max(1, Math.min(MAX_PROCESS_LIMIT, Math.floor(n))) : DEFAULT_PROCESS_LIMIT;
}

function inDshWeb(cgroup) {
return typeof cgroup === "string" && cgroup.includes("/dsh-web.service");
}

/** Pure ranking helper (exported for tests and alternate fact sources). */
export function rankProcessUsage(rows, { limit = DEFAULT_PROCESS_LIMIT, sort = "rss" } = {}) {
const list = Array.isArray(rows) ? rows.filter((row) => row !== null && typeof row === "object") : [];
const ranked = [...list].sort((left, right) => {
if (sort === "cpu") return (right.cpuPct ?? 0) - (left.cpuPct ?? 0) || (right.rssBytes ?? 0) - (left.rssBytes ?? 0);
return (right.rssBytes ?? 0) - (left.rssBytes ?? 0) || (right.cpuPct ?? 0) - (left.cpuPct ?? 0);
});
return ranked.slice(0, clampLimit(limit));
}

/**
 * Take one bounded, user-triggered process-usage snapshot.
 *
 * @param {object} [options]
 * @param {string|null} [options.sessionId] only processes carrying
 *   DSH_SESSION_ID=<this>; null/empty means system-wide.
 * @param {number} [options.limit]
 * @param {"rss"|"cpu"} [options.sort]
 * @param {string} [options.root] /proc root (tests)
 * @param {number} [options.sampleMs] CPU sample window; 0 is allowed in tests
 * @param {function} [options.read] file reader
 * @param {function} [options.readdir] directory reader
 * @param {function} [options.sleep] async delay (tests)
 * @returns {Promise<object>} JSON-safe snapshot
 */
export async function readProcessUsage({
sessionId = null,
limit = DEFAULT_PROCESS_LIMIT,
sort = "rss",
root = "/proc",
sampleMs = 120,
read = readProcFile,
readdir = readdirSync,
sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
} = {}) {
const safeLimit = clampLimit(limit);
const scope = typeof sessionId === "string" && sessionId.length > 0 ? "session" : "system";
const fileReader = typeof read === "function" ? read : readProcFile;
const tableOptions = { root, read: fileReader, readdir };
const before = readProcessTable(tableOptions);
const windowMs = Math.max(0, Number(sampleMs) || 0);
if (windowMs > 0) await sleep(windowMs);
const after = readProcessTable(tableOptions);
const elapsedMs = windowMs > 0 ? windowMs : 1;
const clkTck = 100; // Linux USER_HZ; documented approximation for display
const rows = [];
for (const [pid, stat] of after) {
const base = `${root}/${pid}`;
const environ = fileReader(`${base}/environ`) ?? "";
const ownerSessionId = parseSessionId(environ);
if (scope === "session" && ownerSessionId !== sessionId) continue;
const previous = before.get(pid);
const deltaTicks = previous === undefined
? 0
: Math.max(0, (stat.utimeTicks + stat.stimeTicks) - (previous.utimeTicks + previous.stimeTicks));
const cpuPct = Math.round((deltaTicks / clkTck / (elapsedMs / 1000)) * 1000) / 10;
const cgroup = parseCgroupPath(fileReader(`${base}/cgroup`) ?? "");
const argv = parseCmdline(fileReader(`${base}/cmdline`) ?? "");
const command = argv.join(" ");
rows.push({
pid,
ppid: stat.ppid,
comm: stat.comm,
state: stat.state,
rssBytes: stat.rssBytes,
cpuPct,
sessionId: ownerSessionId,
cgroup,
inDshWeb: inDshWeb(cgroup),
command: command.length > 500 ? `${command.slice(0, 499)}…` : command
});
}
return {
at: Date.now(),
scope,
sessionId: scope === "session" ? sessionId : null,
sort: sort === "cpu" ? "cpu" : "rss",
limit: safeLimit,
sampleMs: windowMs,
processes: rankProcessUsage(rows, { limit: safeLimit, sort })
};
}
