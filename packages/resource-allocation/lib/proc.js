/**
 * Read-only /proc fact readers for process-tree and cgroup classification.
 *
 * Every function is pure over injectable inputs (a file-content resolver
 * and an optional /proc root), so unit tests exercise the classification
 * logic with fixture data while the default resolver reads the real /proc.
 * Nothing in this module writes to /proc, signals, or kills anything —
 * the observer contract of resource-allocation v0.1 is display-only.
 *
 * @module resource-allocation/proc
 */
import { readdirSync, readFileSync } from "node:fs";
import { basename } from "node:path";

const PAGE_SIZE = 4096;

/** Default resolver: read a file under /proc, returning null on any failure. */
export function readProcFile(path) {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

/**
 * Parse one /proc/<pid>/stat line. The comm field may contain spaces and
 * parentheses, so parsing starts after the LAST ")".
 * @returns {{pid, ppid, comm, state, rssBytes}} or null
 */
export function parseProcStat(text) {
	if (typeof text !== "string" || text.length === 0) return null;
	const close = text.lastIndexOf(")");
	if (close < 0) return null;
	const head = text.slice(0, close + 1);
	const open = head.indexOf("(");
	if (open < 1) return null;
	const pid = Number(head.slice(0, open - 1).trim().split(/\s+/).at(-1));
	const comm = head.slice(open + 1, close);
	const rest = text.slice(close + 1).trim().split(/\s+/);
	// fields after comm: state(3) ppid(4) ... utime(14) stime(15) ... rss(24)
	const state = rest[0];
	const ppid = Number(rest[1]);
	const utimeTicks = Number(rest[11]);
	const stimeTicks = Number(rest[12]);
	const rssPages = Number(rest[21]);
	if (!Number.isFinite(pid) || !Number.isFinite(ppid)) return null;
	return {
		pid,
		ppid,
		comm,
		state,
		utimeTicks: Number.isFinite(utimeTicks) ? utimeTicks : 0,
		stimeTicks: Number.isFinite(stimeTicks) ? stimeTicks : 0,
		rssBytes: Number.isFinite(rssPages) ? rssPages * PAGE_SIZE : 0
	};
}

/**
 * Parse /proc/<pid>/cgroup into the deepest cgroup path.
 * cgroup v2 lines are `0::/system.slice/unit.service`; v1 files hold one
 * line per controller hierarchy. The last line wins.
 * @returns {string|null} e.g. "/system.slice/dsh-web.service"
 */
export function parseCgroupPath(text) {
	if (typeof text !== "string" || text.length === 0) return null;
	const lines = text.trim().split("\n");
	const last = lines.at(-1) ?? "";
	const index = last.lastIndexOf(":");
	if (index < 0) return last.length > 0 ? last : null;
	const path = last.slice(index + 1);
	return path.length > 0 ? path : null;
}

/** Parse /proc/<pid>/cmdline into an argv array. */
export function parseCmdline(text) {
	if (typeof text !== "string" || text.length === 0) return [];
	return text.split("\0").filter((part) => part.length > 0);
}

/**
 * Parse /proc/<pid>/environ for the DSH session identity of an unmanaged
 * process (orphan owner hint). Returns null when absent — the hint is
 * best-effort, never required.
 */
export function parseSessionId(text) {
	if (typeof text !== "string" || text.length === 0) return null;
	for (const entry of text.split("\0")) {
		if (entry.startsWith("DSH_SESSION_ID=")) {
			const value = entry.slice("DSH_SESSION_ID=".length);
			return value.length > 0 ? value : null;
		}
	}
	return null;
}

/**
 * Snapshot the full process table from /proc.
 * @param {object} [options] - {root = "/proc", read = readProcFile, readdir = readdirSync}
 * @returns {Map<number, {pid, ppid, comm, state, rssBytes}>} pid → entry
 */
export function readProcessTable({ root = "/proc", read = readProcFile, readdir = readdirSync } = {}) {
	const table = new Map();
	let entries;
	try {
		entries = readdir(root);
	} catch {
		return table;
	}
	for (const name of entries) {
		const pid = Number(name);
		if (!Number.isInteger(pid) || pid <= 0) continue;
		const parsed = parseProcStat(read(`${root}/${pid}/stat`));
		if (parsed !== null && parsed.pid === pid) table.set(pid, parsed);
	}
	return table;
}

/**
 * List every live descendant of `rootPid` (excluding the root itself) via a
 * ppid walk, bounded by `limit` entries so a hostile tree cannot blow up the
 * page render.
 */
export function listDescendants(table, rootPid, { limit = 512 } = {}) {
	const children = new Map();
	for (const entry of table.values()) {
		let list = children.get(entry.ppid);
		if (list === undefined) {
			list = [];
			children.set(entry.ppid, list);
		}
		list.push(entry);
	}
	const out = [];
	const stack = [rootPid];
	const seen = new Set();
	while (stack.length > 0 && out.length < limit) {
		const pid = stack.pop();
		if (seen.has(pid)) continue;
		seen.add(pid);
		for (const child of children.get(pid) ?? []) {
			out.push(child);
			stack.push(child.pid);
		}
	}
	return out;
}

/**
 * Read the classification facts for one pid: stat, cgroup path, argv, and
 * the DSH session id when present.
 * @returns {{pid, ppid, comm, state, rssBytes, cgroup, argv, sessionId}|null}
 */
export function readProcFacts(pid, { root = "/proc", read = readProcFile } = {}) {
	const stat = parseProcStat(read(`${root}/${pid}/stat`));
	if (stat === null) return null;
	const cgroup = parseCgroupPath(read(`${root}/${pid}/cgroup`));
	const argv = parseCmdline(read(`${root}/${pid}/cmdline`));
	const sessionId = parseSessionId(read(`${root}/${pid}/environ`));
	return { ...stat, cgroup, argv, sessionId };
}

/**
 * Whether an argv matches a set of interest tokens. Matching is
 * argv-element-basename equality (case-insensitive): a wrapper like
 * `timeout 1800 /workspace/tool/build/tool ...` matches the token
 * `solver` through its path argument, while a shell script whose text
 * merely mentions "solver" does not.
 */
export function argvMatchesTokens(argv, tokens) {
	if (!Array.isArray(argv) || argv.length === 0 || tokens.size === 0) return false;
	for (const element of argv) {
		if (typeof element !== "string" || element.length === 0) continue;
		const base = basename(element).toLowerCase();
		if (base.length > 0 && tokens.has(base)) return true;
	}
	return false;
}
