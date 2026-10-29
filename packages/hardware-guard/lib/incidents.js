/**
 * Durable incident log for hardware-guard events (pressure transitions,
 * kills, admission denials summaries). Written as append-only JSONL with
 * fsync so records survive the exact hard-shutdown failure mode this plugin
 * exists to prevent.
 *
 * v1.0 lifecycle: when the active file would exceed `incidentsMaxBytes`
 * (default 2 MiB), it is rotated to exactly one `incidents.jsonl.1` archive
 * and a new active file is started. The in-memory ring remains bounded by
 * `incidentsMaxEntries`; on-disk history remains bounded by one active file
 * plus one archive. An individual record larger than the byte budget is
 * replaced by a small truncation marker rather than being allowed to make
 * the active log unbounded.
 *
 * @module hardware-guard/incidents
 */
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync
} from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULTS, shared } from "./state.js";

const MIN_ROTATE_BYTES = 256;
const TRUNCATION_REASON = "incident payload exceeded incidentsMaxBytes; detail omitted to keep the on-disk log bounded";

/** Absolute active incident-log path for a storage directory. */
export function incidentsLogPath(dir = shared.storageDir, config = shared.config) {
	if (typeof dir !== "string" || dir.length === 0) return null;
	return join(dir, config?.incidentsFileName ?? DEFAULTS.incidentsFileName);
}

/** Sanitized rotation budget (tests may use a small value; production is 2 MiB). */
export function incidentsByteBudget(config = shared.config) {
	const raw = Number(config?.incidentsMaxBytes);
	return Number.isFinite(raw) && raw > 0 ? Math.max(MIN_ROTATE_BYTES, Math.floor(raw)) : DEFAULTS.incidentsMaxBytes;
}

/** Build the smallest valid marker that still fits the byte budget. */
function compactIncidentLine(incident, maxBytes, reason) {
	const kind = typeof incident.kind === "string" ? incident.kind : String(incident.kind ?? "");
	const candidates = [
		{ at: incident.at, atMs: incident.atMs, kind: kind.slice(0, 80), truncated: true, reason: reason.slice(0, 160) },
		{ at: incident.at, atMs: incident.atMs, kind: kind.slice(0, 32), truncated: true },
		{ truncated: true }
	];
	for (const candidate of candidates) {
		const line = `${JSON.stringify(candidate)}\n`;
		if (Buffer.byteLength(line, "utf8") <= maxBytes) return line;
	}
	return '{"truncated":true}\n';
}

/** Serialize one incident, falling back to a bounded truncation marker. */
function serializedIncident(incident, maxBytes) {
	const line = `${JSON.stringify(incident)}\n`;
	return Buffer.byteLength(line, "utf8") <= maxBytes
		? line
		: compactIncidentLine(incident, maxBytes, TRUNCATION_REASON);
}

/**
 * Rotate the active log to `<log>.1` when adding `incomingBytes` would push
 * it over budget. The archive is replaced, never appended, so there is at
 * most one `.1` file. Best effort and never throws.
 *
 * @returns {boolean} whether a rotation happened
 */
export function rotateIncidentLogIfNeeded(path, maxBytes = incidentsByteBudget(), incomingBytes = 0) {
	if (typeof path !== "string" || path.length === 0) return false;
	let size;
	try {
		size = statSync(path).size;
	} catch {
		return false;
	}
	if (size === 0) return false;
	if (size < maxBytes && size + Math.max(0, incomingBytes) <= maxBytes) return false;
	const archive = `${path}.1`;
	try {
		if (existsSync(archive)) rmSync(archive, { force: true });
		renameSync(path, archive);
		return true;
	} catch {
		/* keep appending to the active file; rotation will retry next record */
		return false;
	}
}

/** Append + fsync without rewriting the whole file. */
function appendFileDurable(path, text) {
	mkdirSync(dirname(path), { recursive: true });
	const fd = openSync(path, "a");
	try {
		writeFileSync(fd, text, { encoding: "utf8" });
		try {
			fsyncSync(fd);
		} catch {
			/* the append is still ordered by close; durability is best effort */
		}
	} finally {
		closeSync(fd);
	}
}

/** Append one incident, keep the in-memory ring capped, persist the file. */
export function recordIncident(kind, detail) {
	const config = shared.config ?? DEFAULTS;
	const incident = {
		at: new Date().toISOString(),
		atMs: Date.now(),
		kind,
		...detail
	};
	if (!Array.isArray(shared.incidents)) shared.incidents = [];
	shared.incidents.unshift(incident);
	const maxEntries = Number.isInteger(config.incidentsMaxEntries) && config.incidentsMaxEntries > 0
		? config.incidentsMaxEntries
		: DEFAULTS.incidentsMaxEntries;
	if (shared.incidents.length > maxEntries) shared.incidents.length = maxEntries;
	const path = incidentsLogPath(shared.storageDir, config);
	if (path === null) return incident;
	const maxBytes = incidentsByteBudget(config);
	let line;
	try {
		line = serializedIncident(incident, maxBytes);
	} catch (error) {
		// BigInt/circular detail must never break a watchdog or boot path.
		line = compactIncidentLine(incident, maxBytes, `incident detail could not be serialized: ${String(error?.message ?? error)}`);
	}
	try {
		rotateIncidentLogIfNeeded(path, maxBytes, Buffer.byteLength(line, "utf8"));
		appendFileDurable(path, line);
	} catch {
		/* persistence is best-effort */
	}
	return incident;
}

/** Load persisted incidents into the in-memory ring (archive first, active last). */
export function loadIncidents() {
	const path = incidentsLogPath();
	if (path === null) return;
	const readLog = (candidate) => {
		try {
			return readFileSync(candidate, "utf8");
		} catch {
			return null;
		}
	};
	// The `.1` archive holds older history; the active file holds newer records.
	// Reading both preserves the newest bound across a rotation; reading only
	// the archive also recovers a crash between rename and append.
	const archiveText = readLog(`${path}.1`);
	const activeText = readLog(path);
	if (archiveText === null && activeText === null) {
		shared.incidents = [];
		return;
	}
	const loaded = [];
	for (const text of [archiveText, activeText]) {
		if (text === null) continue;
		for (const line of text.split("\n")) {
			if (line.trim().length === 0) continue;
			try {
				loaded.push(JSON.parse(line));
			} catch {
				/* skip corrupt lines */
			}
		}
	}
	const maxEntries = Number.isInteger(shared.config?.incidentsMaxEntries) && shared.config.incidentsMaxEntries > 0
		? shared.config.incidentsMaxEntries
		: DEFAULTS.incidentsMaxEntries;
	shared.incidents = loaded.reverse().slice(0, maxEntries);
}

/** Render recent incidents for the tool / context injection. */
export function renderIncidents(limit = 10) {
	const entries = shared.incidents.slice(0, limit);
	if (entries.length === 0) return "no incidents recorded";
	return entries.map((entry) => `${entry.at} [${entry.kind}] ${JSON.stringify(omit(entry, ["at", "atMs", "kind"]))}`).join("\n");
}

function omit(object, keys) {
	const out = {};
	for (const [key, value] of Object.entries(object)) {
		if (keys.includes(key)) continue;
		out[key] = value;
	}
	return out;
}
