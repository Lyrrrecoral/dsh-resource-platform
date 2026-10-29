/**
 * Linux /proc process-tree inspection for the watchdog.
 *
 * The harness spawns tool subprocesses as detached process groups, but while
 * the harness lives they remain reachable through /proc ancestry. Each tick
 * rebuilds a pid → ppid map and walks from the harness pid to enumerate every
 * descendant, its comm, RSS and run state.
 *
 * @module hardware-guard/proc-tree
 */
import { readdirSync, readFileSync } from "node:fs";

/** Read a file, returning null on any failure. */
function tryRead(path) {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

/**
 * Parse one /proc/<pid>/stat line. The comm field may contain spaces and
 * parentheses, so parsing starts after the LAST ")".
 * @returns {{pid, comm, state, ppid, rssBytes, vsizeBytes, cpuTicks}} or null
 */
export function parseProcStat(text) {
	if (text === null) return null;
	const close = text.lastIndexOf(")");
	if (close < 0) return null;
	const head = text.slice(0, close + 1);
	const open = head.indexOf("(");
	if (open < 1) return null;
	const pid = Number(head.slice(0, open - 1).trim().split(/\s+/).at(-1));
	const comm = head.slice(open + 1, close);
	const rest = text.slice(close + 1).trim().split(/\s+/);
	// fields after comm: state(3) ppid(4) ... utime(14) stime(15) ... vsize(23) rss(24)
	// => rest[0]=state, rest[1]=ppid, rest[11]=utime, rest[12]=stime,
	//    rest[20]=vsize, rest[21]=rss
	const state = rest[0];
	const ppid = Number(rest[1]);
	const vsizeBytes = Number(rest[20]);
	const rssPages = Number(rest[21]);
	const rssBytes = Number.isFinite(rssPages) ? rssPages * 4096 : 0;
	const cpuTicks = Number(rest[11]) + Number(rest[12]);
	if (!Number.isFinite(pid) || !Number.isFinite(ppid)) return null;
	return {
		pid,
		ppid,
		comm,
		state,
		rssBytes,
		vsizeBytes: Number.isFinite(vsizeBytes) ? vsizeBytes : 0,
		cpuTicks: Number.isFinite(cpuTicks) ? cpuTicks : 0
	};
}

/**
 * Snapshot the full process table from /proc.
 * @returns {Map<number, {pid, ppid, comm, state, rssBytes}>} pid → entry
 */
export function readProcessTable() {
	const table = new Map();
	let entries;
	try {
		entries = readdirSync("/proc");
	} catch {
		return table;
	}
	for (const name of entries) {
		const pid = Number(name);
		if (!Number.isInteger(pid) || pid <= 0) continue;
		const parsed = parseProcStat(tryRead(`/proc/${pid}/stat`));
		if (parsed !== null && parsed.pid === pid) table.set(pid, parsed);
	}
	return table;
}

/**
 * List every live descendant of `rootPid` (excluding the root itself).
 * @param {Map} table - result of {@link readProcessTable}
 * @param {number} rootPid - the harness pid
 * @returns {Array} descendant entries
 */
export function listDescendants(table, rootPid) {
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
	while (stack.length > 0) {
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

/** Total RSS of a set of entries. */
export function sumRss(entries) {
	return entries.reduce((total, entry) => total + entry.rssBytes, 0);
}

/**
 * Parse a /proc/<pid>/environ buffer (NUL-separated KEY=VALUE) into a plain
 * object of the FIRST occurrence of each key. Processes started with a
 * marked compute environment inherit it, so this is how the watchdog
 * confirms a descendant's compute identity. Returns {} on any failure —
 * unreadable environ is NEVER confirmed compute.
 */
export function parseProcEnviron(text) {
	const out = {};
	if (text === null || text === undefined) return out;
	for (const entry of text.split("\0")) {
		const eq = entry.indexOf("=");
		if (eq <= 0) continue;
		const key = entry.slice(0, eq);
		if (out[key] === undefined) out[key] = entry.slice(eq + 1);
	}
	return out;
}

/** Read and parse /proc/<pid>/environ; {} when unreadable. */
export function readProcEnviron(pid) {
	return parseProcEnviron(tryRead(`/proc/${pid}/environ`));
}
