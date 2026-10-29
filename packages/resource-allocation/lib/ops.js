/**
 * Canonical resource-allocation API and HTML fallback.
 *
 * Mounted as the `resource-allocation/api` row:
 *  - GET  /resources/projects       HTML fallback (self-refresh, no client bundle)
 *  - GET  /resources/projects.json  full project/run/queue/session projection
 *  - POST /resources/projects       the single write action:
 *       {action:"register-discovered", path:"..."}
 *
 * The POST is fail-closed: it requires `x-resource-action: 1`; when an Origin
 * header is present it must be same-origin with the request Host, and a
 * cross-site Sec-Fetch-Site is refused. The target must be a manifest that
 * discovery listed as `unregistered`, inside a configured root, re-read and
 * re-validated before the CAS registry write. Nothing is started, stopped or
 * adopted by this route.
 *
 * Legacy GET /ops/projects(.json) redirects to the canonical URL for one
 * release with `Deprecation: true`. `/ops/processes*` is deliberately not
 * registered anymore: the duplicate fleet page is gone, not merely renamed.
 *
 * Queue data is embedded in `projects.json` as `waiting`; there is no
 * separate Queue route or tab, and this projection never writes queue.json.
 *
 * @module resource-allocation/api
 */
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import { ensureTaskUnitsAdopted, observeRegistry } from "./adopt.js";
import { reconcileRuns, stopRun } from "./launch.js";
import { readManifestForRegistration, resolveRegisterTarget, normalizeDiscovery } from "./discover.js";
import { readQueueDoc } from "./queue.js";
import { readProcessUsage } from "./process-usage.js";
import { QueueRegistry } from "./scheduler/queue.js";
import { ProjectRegistry } from "./registry.js";
import { DEFAULT_RUNS_RETENTION_DAYS, normalizeRetentionDays, RunRegistry } from "./runs.js";
import { boundObservation, normalizePageLimits } from "./bounds.js";
import { defaultStorageDir, prepareStorage } from "./storage.js";
import { renderHtml, renderJson } from "./render.js";

export const name = "resource-allocation-api";
export const inject = ["webServer"];

/** Canonical routes registered by this row. */
export const ROUTE_PROJECTS = "/resources/projects";
export const ROUTE_PROJECTS_JSON = "/resources/projects.json";
/** On-demand high-usage process lookup; explicitly user-triggered, read-only. */
export const ROUTE_PROCESSES_JSON = "/resources/processes.json";
/** One-release compatibility redirects; no duplicate renderer. */
export const LEGACY_ROUTE_PROJECTS = "/ops/projects";
export const LEGACY_ROUTE_PROJECTS_JSON = "/ops/projects.json";

/** Default queue fact source under the canonical storage directory. */
export function defaultQueuePath() {
return dshHomePath("storages", "resource-allocation", "queue.json");
}

function normalizeStatusFiles(config) {
const raw = Array.isArray(config) ? config : [];
return raw
.filter((entry) => entry !== null && typeof entry === "object" && typeof entry.path === "string" && entry.path.length > 0)
.map((entry) => ({
project: typeof entry.project === "string" && entry.project.length > 0 ? entry.project : entry.path,
path: entry.path
}));
}

function send(res, status, body, type = "text/plain; charset=utf-8") {
res.statusCode = status;
res.setHeader("Content-Type", type);
res.setHeader("Cache-Control", "no-store");
res.setHeader("X-Content-Type-Options", "nosniff");
res.setHeader("Referrer-Policy", "same-origin");
res.end(body);
}

function sendJson(res, status, value) {
const body = JSON.stringify(value);
res.setHeader("X-Resource-Json-Bytes", String(Buffer.byteLength(body, "utf8")));
return send(res, status, body, "application/json; charset=utf-8");
}

function headerValue(req, name) {
const headers = req?.headers;
if (headers === null || headers === undefined) return null;
if (typeof headers.get === "function") {
const value = headers.get(name);
return typeof value === "string" ? value : null;
}
const lower = String(name).toLowerCase();
for (const [key, value] of Object.entries(headers)) {
if (key.toLowerCase() !== lower) continue;
if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : null;
return typeof value === "string" ? value : null;
}
return null;
}

/** True when an Origin URL exactly matches the request Host. */
export function isSameOriginRequest(req, url) {
const origin = headerValue(req, "origin");
if (origin === null || origin.length === 0) return false;
let parsed;
try {
parsed = new URL(origin);
} catch {
return false;
}
const host = headerValue(req, "host") ?? url.host;
return typeof host === "string" && host.length > 0 && parsed.host.toLowerCase() === host.toLowerCase();
}

/**
 * Fail-closed write authorization. The custom header is always required; an
 * Origin, when supplied, must be same-origin. Cross-site fetch metadata is
 * refused even if the header was attempted.
 */
export function authorizeResourceWrite(req, url) {
const action = headerValue(req, "x-resource-action");
if (action === null || action.trim() !== "1") {
return { ok: false, status: 403, error: "write refused: missing or invalid x-resource-action: 1 header" };
}
const origin = headerValue(req, "origin");
if (origin !== null && origin.length > 0 && !isSameOriginRequest(req, url)) {
return { ok: false, status: 403, error: "write refused: Origin is not same-origin with this DSH endpoint" };
}
const fetchSite = headerValue(req, "sec-fetch-site");
if (fetchSite !== null && fetchSite.toLowerCase() === "cross-site") {
return { ok: false, status: 403, error: "write refused: cross-site request metadata" };
}
return { ok: true };
}

/** 308 preserves the method and body; the compatibility window is one release. */
function redirectLegacy(res, canonicalPath, search = "") {
res.statusCode = 308;
res.setHeader("Location", `${canonicalPath}${search}`);
res.setHeader("Deprecation", "true");
res.setHeader("Link", `<${canonicalPath}>; rel="successor-version"`);
res.setHeader("Cache-Control", "no-store");
res.setHeader("X-Content-Type-Options", "nosniff");
res.setHeader("Referrer-Policy", "same-origin");
res.end();
}

/** Minimal but structurally valid observation used when rendered HTML would
 * still exceed the hard HTML budget. The JSON exposure remains the full
 * (display-bounded) projection; HTML is only a fallback. */
function htmlBudgetFallback(observation, { limit, renderedBytes }) {
const next = {
...observation,
projects: [],
sessions: [],
unitFacts: {},
runs: observation.runs === null || observation.runs === undefined
? observation.runs
: { ...observation.runs, items: [], truncated: true },
waiting: observation.waiting === null || observation.waiting === undefined
? observation.waiting
: { ...observation.waiting, entries: [], unassigned: [], truncated: true, unassignedTruncated: true },
discovered: observation.discovered === null || observation.discovered === undefined
? observation.discovered
: { ...observation.discovered, items: [], truncated: true },
unassigned: observation.unassigned === null || observation.unassigned === undefined
? observation.unassigned
: { ...observation.unassigned, runs: [], queueItems: [], orphans: [], truncated: true },
truncated: true
};
next.bounds = {
...observation.bounds,
truncated: true,
report: {
...observation.bounds?.report,
htmlBytes: { limit, total: renderedBytes, returned: null, truncated: true }
}
};
return next;
}

/**
 * Build the request handler over injectable registries/adapters. Kept as a
 * free function so tests exercise the boot-registered code path.
 *
 * `runs` is optional; when present active runs are reconciled and terminal
 * runs older than `runsRetentionDays` are pruned before projection. The
 * returned observation is always display-bounded (`boundObservation`).
 */
export function createHandler({
registry,
runs = null,
statusFiles = [],
refreshSeconds = 15,
systemd,
proc,
queuePath = null,
readQueue = readQueueDoc,
discovery = null,
queue = null,
runsRetentionDays = DEFAULT_RUNS_RETENTION_DAYS,
pageLimits = {},
processUsage = readProcessUsage,
now = () => Date.now()
}) {
const retentionDays = normalizeRetentionDays(runsRetentionDays, DEFAULT_RUNS_RETENTION_DAYS) ?? DEFAULT_RUNS_RETENTION_DAYS;
const refresh = Number.isFinite(Number(refreshSeconds)) ? Math.max(1, Math.min(3600, Math.floor(Number(refreshSeconds)))) : 15;
const clock = typeof now === "function" ? now : () => now;
const effectivePageLimits = normalizePageLimits(pageLimits);
const maxHtmlBytes = effectivePageLimits.maxHtmlBytes;

const observe = async () => {
// Idempotent observe-only registration (never writes systemd state).
try {
ensureTaskUnitsAdopted(registry, systemd === undefined ? {} : { systemd });
} catch {
/* observation continues */
}
if (runs !== null && runs !== undefined) {
try {
await reconcileRuns({ runs, systemd, now: clock });
} catch {
/* observation continues */
}
try {
runs.pruneTerminalRuns({ retentionDays, now: clock() });
} catch {
/* retention is best effort; never hide the observation */
}
}
const queue = queuePath === null || queuePath === undefined ? null : readQueue(queuePath);
const observation = observeRegistry({
registry,
runs,
statusFiles,
queue,
...(discovery !== null && discovery !== undefined && { discovery }),
...(systemd !== undefined && { systemd }),
...(proc !== undefined && { proc }),
now: clock
});
return boundObservation(observation, pageLimits);
};

return async function handler(req, res) {
try {
const url = new URL(req.url ?? "/", "http://dsh.internal");
const method = (req.method ?? "GET").toUpperCase();

// One-release legacy redirects. /ops/processes is intentionally absent.
if (url.pathname === LEGACY_ROUTE_PROJECTS) return redirectLegacy(res, ROUTE_PROJECTS, url.search);
if (url.pathname === LEGACY_ROUTE_PROJECTS_JSON) return redirectLegacy(res, ROUTE_PROJECTS_JSON, url.search);

if (url.pathname === ROUTE_PROCESSES_JSON) {
if (method !== "GET") return sendJson(res, 405, { ok: false, error: "GET only" });
const requestedSession = url.searchParams.get("sessionId");
const scope = url.searchParams.get("scope") === "system" ? "system" : "session";
if (scope === "session" && (requestedSession === null || requestedSession.trim() === "")) {
return sendJson(res, 400, { ok: false, error: "sessionId is required when scope=session" });
}
const sort = url.searchParams.get("sort") === "cpu" ? "cpu" : "rss";
const limitParam = url.searchParams.get("limit");
const processSnapshot = await processUsage({
	sessionId: scope === "session" ? requestedSession.trim() : null,
	limit: limitParam === null ? undefined : Number(limitParam),
	sort
});
return sendJson(res, 200, { ok: true, ...processSnapshot });
}
if (url.pathname === ROUTE_PROJECTS_JSON) {
if (method !== "GET") return sendJson(res, 405, { ok: false, error: "GET only" });
return sendJson(res, 200, renderJson(await observe()));
}
if (url.pathname === ROUTE_PROJECTS) {
if (method === "POST") {
const authorization = authorizeResourceWrite(req, url);
if (!authorization.ok) return sendJson(res, authorization.status, { ok: false, error: authorization.error });
return handleProjectsPost(req, res, { registry, discovery, runs, queue, systemd });
}
if (method !== "GET") return sendJson(res, 405, { ok: false, error: "GET or POST only" });
const observation = await observe();
let html = renderHtml(observation, { refreshSeconds: refresh });
let htmlBytes = Buffer.byteLength(html, "utf8");
if (htmlBytes > maxHtmlBytes) {
html = renderHtml(htmlBudgetFallback(observation, { limit: maxHtmlBytes, renderedBytes: htmlBytes }), { refreshSeconds: refresh });
htmlBytes = Buffer.byteLength(html, "utf8");
}
if (htmlBytes > maxHtmlBytes) {
// Even the structural fallback can only exceed the budget when an
// operator configured an unrealistically tiny HTML cap. Return a
// fixed, valid notice rather than truncating HTML mid-tag.
html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>Resource allocation / projects</title></head><body><h1>Resource allocation / projects</h1><p>Response exceeded the configured HTML display bound; use <a href="${ROUTE_PROJECTS_JSON}">${ROUTE_PROJECTS_JSON}</a>.</p></body></html>`;
htmlBytes = Buffer.byteLength(html, "utf8");
}
res.setHeader("X-Resource-Html-Bytes", String(htmlBytes));
return send(res, 200, html, "text/html; charset=utf-8");
}
return send(res, 404, "not found");
} catch (error) {
return send(res, 500, String(error?.message ?? error));
}
};
}

/**
 * The single write action: register a manifest discovery just listed as
 * `unregistered`. The path is re-resolved against the live scan (inside a
 * configured realpath-checked root), re-read/re-validated, then CAS-created
 * with expectedRevision 0. Adoption remains observe-only.
 */
async function handleProjectsPost(req, res, { registry, discovery, runs = null, queue = null, systemd }) {
let parsed;
try {
parsed = JSON.parse((await readBody(req)).toString("utf8"));
} catch (error) {
return sendJson(res, 400, { ok: false, error: `invalid JSON body: ${String(error?.message ?? error)}` });
}
const action = parsed?.action;
if (action === "stop-run") {
if (runs === null || runs === undefined) return sendJson(res, 503, { ok: false, error: "run registry is unavailable" });
if (parsed?.confirm !== "STOP") return sendJson(res, 400, { ok: false, error: "stop-run requires confirm: STOP" });
const runId = typeof parsed?.runId === "string" ? parsed.runId.trim() : "";
if (runId === "") return sendJson(res, 400, { ok: false, error: "runId is required" });
const result = await stopRun({ runs, runId, allowOperator: true, systemd });
if (!result.ok) {
const status = result.code === "not-found" ? 404 : result.code === "stop-failed" ? 502 : 409;
return sendJson(res, status, { ok: false, ...result });
}
return sendJson(res, 200, { ok: true, ...result, text: result.code === "already-terminal" ? `already ${result.status}` : `stopped ${runId}` });
}
if (action === "cancel-queue") {
if (queue === null || queue === undefined) return sendJson(res, 503, { ok: false, error: "queue registry is unavailable" });
if (parsed?.confirm !== "CANCEL") return sendJson(res, 400, { ok: false, error: "cancel-queue requires confirm: CANCEL" });
const itemId = typeof parsed?.itemId === "string" ? parsed.itemId.trim() : "";
if (itemId === "") return sendJson(res, 400, { ok: false, error: "itemId is required" });
const result = queue.transition(itemId, "killed", { by: "web-ui", reason: "cancelled by Resources operator" });
if (!result.ok) {
const status = result.code === "not-found" ? 404 : result.code === "conflict" ? 409 : 400;
return sendJson(res, status, { ok: false, ...result, error: (result.errors ?? []).join("; ") || result.code });
}
return sendJson(res, 200, { ok: true, ...result, text: `cancelled ${itemId}` });
}
if (action === "set-monitor") {
if (parsed?.confirm !== "MONITOR") return sendJson(res, 400, { ok: false, error: "set-monitor requires confirm: MONITOR" });
const projectId = typeof parsed?.projectId === "string" ? parsed.projectId.trim() : "";
if (projectId === "") return sendJson(res, 400, { ok: false, error: "projectId is required" });
const taskId = typeof parsed?.taskId === "string" && parsed.taskId.trim() !== "" ? parsed.taskId.trim() : null;
if (typeof parsed?.monitored !== "boolean") return sendJson(res, 400, { ok: false, error: "monitored must be a boolean" });
const result = registry.setMonitoring(projectId, { taskId, monitored: parsed.monitored, expectedRevision: parsed?.expectedRevision });
if (!result.ok) {
const status = result.code === "not-found" ? 404 : result.code === "conflict" ? 409 : 400;
return sendJson(res, status, { ok: false, ...result, error: (result.errors ?? []).join("; ") || result.code });
}
return sendJson(res, 200, { ok: true, ...result, text: `${parsed.monitored ? "monitoring" : "paused monitoring"} ${taskId === null ? `project ${projectId}` : `task ${projectId}/${taskId}`}` });
}
if (action !== "register-discovered") {
return sendJson(res, 400, { ok: false, error: `unknown action ${JSON.stringify(action)}; expected register-discovered | stop-run | cancel-queue | set-monitor` });
}
const loaded = registry.load();
if (loaded.doc === null) return sendJson(res, 409, { ok: false, error: loaded.error ?? "registry unreadable" });
const target = resolveRegisterTarget({ path: parsed?.path, discovery, registryDoc: loaded.doc });
if (!target.ok) return sendJson(res, 400, { ok: false, error: target.error });
const read = readManifestForRegistration(target.path);
if (!read.ok) return sendJson(res, 400, { ok: false, error: read.error });
const result = registry.upsert(read.manifest, { expectedRevision: 0 });
if (!result.ok) {
const status = result.code === "conflict" ? 409 : 400;
return sendJson(res, status, { ok: false, code: result.code, error: (result.errors ?? ["register failed"]).join("; ") });
}
return sendJson(res, 200, {
ok: true,
projectId: read.manifest.project.id,
revision: result.entry?.revision ?? null,
path: target.path,
text: `registered project ${read.manifest.project.id} (revision ${result.entry?.revision ?? "?"}); adoption stays observe-only`
});
}

function readBody(req, limit = 65536) {
return new Promise((resolvePromise, reject) => {
const chunks = [];
let size = 0;
req.on("data", (chunk) => {
const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
size += piece.length;
if (size > limit) {
reject(new Error("body too large"));
req.destroy?.();
return;
}
chunks.push(piece);
});
req.on("end", () => resolvePromise(Buffer.concat(chunks)));
req.on("error", reject);
});
}

export function apply(ctx, config = {}) {
if (config?.enabled === false) return;
const refreshSeconds = Number.isFinite(Number(config?.refreshSeconds)) ? Number(config.refreshSeconds) : 15;
const statusFiles = normalizeStatusFiles(config?.statusFiles);
const discovery = normalizeDiscovery(config?.discover);
const pageLimits = config?.pageLimits ?? config?.limits ?? {};

// Prefer the main row's shared registries. A page-only mount still uses
// canonical storage (migrating legacy files first, never deleting them).
const resource = (typeof ctx.get === "function" ? ctx.get("resourceAllocation") : null)
?? (typeof ctx.get === "function" ? ctx.get("ops") : null)
?? null;
const runsRetentionDays = normalizeRetentionDays(
config?.runsRetentionDays ?? resource?.runsRetentionDays,
DEFAULT_RUNS_RETENTION_DAYS
) ?? DEFAULT_RUNS_RETENTION_DAYS;
let registry = resource?.registry ?? null;
let runs = resource?.runs ?? null;
let queue = resource?.queue ?? null;
let queuePath = typeof config?.queueFile === "string" && config.queueFile.length > 0 ? config.queueFile : null;
if (registry === null || runs === null) {
const sharedDir = resource?.dir ?? resource?.storageDir ?? null;
const prepared = prepareStorage({
dir: typeof config?.storageDir === "string" && config.storageDir.length > 0
? config.storageDir
: sharedDir,
legacyDir: typeof config?.legacyStorageDir === "string" && config.legacyStorageDir.length > 0 ? config.legacyStorageDir : null
});
registry ??= new ProjectRegistry({ dir: prepared.dir });
runs ??= new RunRegistry({ dir: prepared.dir });
queue ??= new QueueRegistry({ dir: prepared.dir });
}
if (queue === null) queue = new QueueRegistry({ dir: registry.dir });
if (queuePath === null) queuePath = typeof resource?.queue?.path === "string" ? resource.queue.path : defaultQueuePath();

const handler = createHandler({ registry, runs, statusFiles, refreshSeconds, queuePath, discovery, queue, runsRetentionDays, pageLimits });

ctx.effect(() => {
const disposeProjects = ctx.webServer.register({ kind: "exact", path: ROUTE_PROJECTS, handler });
const disposeJson = ctx.webServer.register({ kind: "exact", path: ROUTE_PROJECTS_JSON, handler });
const disposeProcesses = ctx.webServer.register({ kind: "exact", path: ROUTE_PROCESSES_JSON, handler });
const disposeLegacyProjects = ctx.webServer.register({ kind: "exact", path: LEGACY_ROUTE_PROJECTS, handler });
const disposeLegacyJson = ctx.webServer.register({ kind: "exact", path: LEGACY_ROUTE_PROJECTS_JSON, handler });
return () => {
disposeProjects();
disposeJson();
disposeProcesses();
disposeLegacyProjects();
disposeLegacyJson();
};
}, "resource-allocation: routes");
}
