/**
 * The resource-allocation long-task run registry: the persisted fact source at
 * `$DSH_HOME/storages/resource-allocation/runs.json`.
 *
 * Every run the `resource_run` tool launches gets one record here; the record is
 * the durable identity of the run (systemd transient units disappear with
 * `--collect`, and /proc facts are transient). The record carries:
 *
 * ```json
 * {
 *   "schemaVersion": 1,
 *   "revision": 7,
 *   "updatedAt": 1786896000000,
 *   "runs": [
 *     {
 *       "id": "m3k5q7a1",
 *       "projectId": "math",
 *       "taskId": "solver-batch",
 *       "owner": { "kind": "session", "sessionId": "session-…", "goalId": null, "jobId": null },
 *       "command": ["sleep", "120"],
 *       "limits": { "cpuMaxCores": 1, "memoryMaxBytes": 1073741824, "tasksMax": 16 },
 *       "unit": "resource-allocation-math-m3k5q7a1.service",
 *       "pid": null,
 *       "status": "running",
 *       "startedAt": 1786896000000,
 *       "finishedAt": null,
 *       "exitCode": null,
 *       "reason": null,
 *       "revision": 3,
 *       "updatedAt": 1786896005000
 *     }
 *   ]
 * }
 * ```
 *
 * State machine: `queued → launching → running → completed | failed | stopped`.
 * Every transition is validated; terminal states never transition further.
 *
 * Concurrency (ops-generalization §2): every write is an atomic durable
 * replace (temp + fsync + rename) guarded by compare-and-swap on the
 * top-level `revision`. A writer passes the revision it read; on conflict it
 * re-reads and retries (bounded). Two processes never write the same file
 * at the same time.
 *
 * @module resource-allocation/runs
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileDurable } from "./registry.js";

/** Read a file if present, returning null on any failure. */
function tryRead(path) {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

export const RUNS_SCHEMA_VERSION = 1;
export const RUNS_FILE_NAME = "runs.json";

export const RUN_STATUSES = Object.freeze(["queued", "launching", "running", "completed", "failed", "stopped"]);
export const RUN_TERMINAL_STATUSES = Object.freeze(["completed", "failed", "stopped"]);
export const RUN_ACTIVE_STATUSES = Object.freeze(["queued", "launching", "running"]);

/** Allowed status transitions (state machine). */
export const RUN_TRANSITIONS = Object.freeze({
	queued: ["launching", "failed"],
	launching: ["running", "failed"],
	running: ["completed", "failed", "stopped"],
	completed: [],
	failed: [],
	stopped: []
});

export const OWNER_KINDS = Object.freeze(["session", "goal", "job"]);

/**
 * Default limits for runs whose task declares no limits section. Conservative
 * single-core background defaults; tasks override them in their manifest and
 * the caller may override per invocation (resource_run `limits`).
 */
export const DEFAULT_LIMITS = Object.freeze({
	cpuMaxCores: 1,
	memoryMaxBytes: 1 << 30, // 1 GiB
	tasksMax: 16
});

/** systemd transient units created for resource-allocation runs are niced like
 * every other dsh background work (hardware-guard policy: nice 10). */
export const DEFAULT_NICE_LEVEL = 10;

const OWNER_KEYS = Object.freeze(["kind", "sessionId", "agentId", "goalId", "jobId"]);

/** Terminal runs older than this are pruned unless configured otherwise. */
export const DEFAULT_RUNS_RETENTION_DAYS = 14;
export const DAY_MS = 86_400_000;

/** Canonical transient-unit prefix created by resource_run. */
export const RUN_UNIT_PREFIX = "resource-allocation-";
/** Prefix used by pre-v1.0 dsh-ops runs; still accepted for reconciliation/stop. */
export const LEGACY_RUN_UNIT_PREFIX = "dsh-ops-";
const RUN_KEYS = Object.freeze(["id", "projectId", "taskId", "owner", "command", "limits", "unit", "pid", "status", "startedAt", "finishedAt", "exitCode", "reason", "revision", "updatedAt"]);

function isFiniteNumber(value) {
	return typeof value === "number" && Number.isFinite(value);
}

function isNonEmptyString(value) {
	return typeof value === "string" && value.length > 0;
}

/** Run ids are lowercase base36 (unit-name safe) and unique per launch. */
export function makeRunId(now = Date.now()) {
	return `${now.toString(36)}${randomBytes(3).toString("hex")}`;
}

/**
 * The systemd transient unit name for a run:
 * `resource-allocation-<projectId>-<runId>.service`. Project ids and run ids are
 * lowercase alphanumerics, so the result is always a valid unit name.
 */
export function runUnitName(projectId, runId) {
	return `${RUN_UNIT_PREFIX}${projectId}-${runId}.service`;
}

/** Whether a unit name is valid for the run naming scheme. */
export function isValidRunUnitName(unit) {
	return typeof unit === "string"
		&& unit.length <= 255
		&& /^(?:resource-allocation-|dsh-ops-)[a-z0-9][a-z0-9-._]*\.service$/.test(unit);
}

function validateOwner(owner, errors, where) {
	if (typeof owner !== "object" || owner === null || Array.isArray(owner)) {
		errors.push(`${where} owner must be an object`);
		return;
	}
	for (const key of Object.keys(owner)) {
		if (!OWNER_KEYS.includes(key)) errors.push(`${where} owner has unknown key ${key}`);
	}
	if (!OWNER_KINDS.includes(owner.kind)) errors.push(`${where} owner.kind invalid: ${owner.kind}`);
	if (owner.sessionId !== null && owner.sessionId !== undefined && !isNonEmptyString(owner.sessionId)) errors.push(`${where} owner.sessionId must be a string or null`);
	if (owner.agentId !== null && owner.agentId !== undefined && !isNonEmptyString(owner.agentId)) errors.push(`${where} owner.agentId must be a string or null`);
	if (owner.goalId !== null && owner.goalId !== undefined && !isNonEmptyString(owner.goalId)) errors.push(`${where} owner.goalId must be a string or null`);
	if (owner.jobId !== null && owner.jobId !== undefined && !isNonEmptyString(owner.jobId)) errors.push(`${where} owner.jobId must be a string or null`);
}

function validateLimits(limits, errors, where) {
	if (typeof limits !== "object" || limits === null || Array.isArray(limits)) {
		errors.push(`${where} limits must be an object`);
		return;
	}
	for (const key of ["cpuMaxCores", "memoryMaxBytes", "tasksMax"]) {
		if (!isFiniteNumber(limits[key]) || limits[key] <= 0) errors.push(`${where} limits.${key} invalid: ${limits[key]}`);
	}
	if (limits.memoryHighBytes !== undefined && limits.memoryHighBytes !== null && (!Number.isInteger(limits.memoryHighBytes) || limits.memoryHighBytes < 1)) errors.push(`${where} limits.memoryHighBytes invalid: ${limits.memoryHighBytes}`);
}

/** Validate one persisted run record. */
export function validateRun(run, errors, where = "run") {
	if (typeof run !== "object" || run === null || Array.isArray(run)) {
		errors.push(`${where} must be an object`);
		return;
	}
	for (const key of Object.keys(run)) {
		if (!RUN_KEYS.includes(key)) errors.push(`${where} has unknown key ${key}`);
	}
	if (!isNonEmptyString(run.id)) errors.push(`${where} id must be a non-empty string`);
	if (!isNonEmptyString(run.projectId)) errors.push(`${where} projectId must be a non-empty string`);
	if (!isNonEmptyString(run.taskId)) errors.push(`${where} taskId must be a non-empty string`);
	validateOwner(run.owner, errors, where);
	if (!Array.isArray(run.command) || run.command.length === 0 || run.command.some((part) => typeof part !== "string" || part.length === 0)) {
		errors.push(`${where} command must be a non-empty array of non-empty strings`);
	}
	validateLimits(run.limits, errors, where);
	if (!isValidRunUnitName(run.unit)) errors.push(`${where} unit invalid: ${run.unit}`);
	if (run.pid !== null && (!Number.isInteger(run.pid) || run.pid <= 0)) errors.push(`${where} pid invalid: ${run.pid}`);
	if (!RUN_STATUSES.includes(run.status)) errors.push(`${where} status invalid: ${run.status}`);
	if (!Number.isInteger(run.startedAt) || run.startedAt < 0) errors.push(`${where} startedAt invalid: ${run.startedAt}`);
	if (run.finishedAt !== null && (!Number.isInteger(run.finishedAt) || run.finishedAt < 0)) errors.push(`${where} finishedAt invalid: ${run.finishedAt}`);
	if (run.exitCode !== null && (!Number.isInteger(run.exitCode) || run.exitCode < 0)) errors.push(`${where} exitCode invalid: ${run.exitCode}`);
	if (run.reason !== null && typeof run.reason !== "string") errors.push(`${where} reason must be a string or null`);
	if (!Number.isInteger(run.revision) || run.revision < 1) errors.push(`${where} revision invalid: ${run.revision}`);
	if (!Number.isInteger(run.updatedAt) || run.updatedAt < 0) errors.push(`${where} updatedAt invalid: ${run.updatedAt}`);
}

/** Build an empty runs document. */
export function emptyRunsDoc(now = Date.now()) {
	return {
		schemaVersion: RUNS_SCHEMA_VERSION,
		revision: 0,
		updatedAt: now,
		runs: []
	};
}

/**
 * Structural validation of a runs document. A corrupt file is surfaced, never
 * silently repaired: writes are refused until the operator fixes or removes
 * it (same contract as the project registry).
 */
export function validateRunsDoc(doc) {
	const errors = [];
	if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return { ok: false, errors: ["runs document is not an object"] };
	if (doc.schemaVersion !== RUNS_SCHEMA_VERSION) errors.push(`runs schemaVersion must be ${RUNS_SCHEMA_VERSION} (got ${doc.schemaVersion})`);
	if (!Number.isInteger(doc.revision) || doc.revision < 0) errors.push(`runs revision invalid: ${doc.revision}`);
	if (!Number.isInteger(doc.updatedAt) || doc.updatedAt < 0) errors.push(`runs updatedAt invalid: ${doc.updatedAt}`);
	if (!Array.isArray(doc.runs)) errors.push("runs must be an array");
	else {
		const seen = new Set();
		for (const run of doc.runs) {
			validateRun(run, errors);
			if (run !== null && typeof run === "object" && typeof run.id === "string") {
				if (seen.has(run.id)) errors.push(`duplicate run id: ${run.id}`);
				seen.add(run.id);
			}
		}
	}
	return { ok: errors.length === 0, errors };
}

/** Whether a status transition is allowed by the state machine. */
export function isAllowedTransition(from, to) {
	return (RUN_TRANSITIONS[from] ?? []).includes(to);
}

/** Serialize for display: null fields stay null; text stays text. */
function cloneRun(run) {
	return JSON.parse(JSON.stringify(run));
}

/** Normalize a retention setting; negative/non-numeric values are invalid. */
export function normalizeRetentionDays(value, fallback = DEFAULT_RUNS_RETENTION_DAYS) {
if (value === undefined || value === null) return fallback;
return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Timestamp used to age one run. Terminal runs should always have finishedAt. */
export function runRetentionTimestamp(run) {
for (const value of [run?.finishedAt, run?.updatedAt, run?.startedAt]) {
if (Number.isInteger(value) && value >= 0) return value;
}
return null;
}

/**
 * Pure retention decision: terminal runs strictly older than the cutoff are
 * removed; queued/launching/running records are always retained regardless of
 * age. Returns a new runs array/document and the removed records.
 */
export function pruneRunsDoc(doc, { retentionDays, runsRetentionDays, days: daysAlias, now = Date.now() } = {}) {
const requestedDays = retentionDays ?? runsRetentionDays ?? daysAlias;
const days = normalizeRetentionDays(requestedDays, DEFAULT_RUNS_RETENTION_DAYS);
if (days === null) return { ok: false, errors: [`runsRetentionDays must be a finite number >= 0 (got ${requestedDays})`] };
if (!Number.isFinite(now) || now < 0) return { ok: false, errors: [`now must be a finite timestamp >= 0 (got ${now})`] };
if (doc === null || typeof doc !== "object" || Array.isArray(doc) || !Array.isArray(doc.runs)) {
return { ok: false, errors: ["runs document must contain a runs[] array"] };
}
const cutoff = now - days * DAY_MS;
const runs = doc.runs;
const kept = [];
const removed = [];
for (const run of runs) {
const timestamp = runRetentionTimestamp(run);
if (RUN_TERMINAL_STATUSES.includes(run?.status) && timestamp !== null && timestamp < cutoff) removed.push(run);
else kept.push(run);
}
return {
ok: true,
cutoff,
retentionDays: days,
document: { ...doc, runs: kept },
kept,
removed,
removedIds: removed.map((run) => run.id),
removedCount: removed.length
};
}

/**
 * The persisted run registry. Reads always hit the file so concurrent
 * instances observe each other's CAS writes; nothing lives in process memory
 * as a fact source.
 */
export class RunRegistry {
	constructor({ dir, now = () => Date.now() } = {}) {
		this.dir = dir;
		this.path = join(dir, RUNS_FILE_NAME);
		this.now = now;
	}

	/** Load the document; a missing file becomes an empty durable registry. */
	load() {
		const text = tryRead(this.path);
		if (text === null) {
			const doc = emptyRunsDoc(this.now());
			try {
				writeFileDurable(this.path, JSON.stringify(doc, null, 2));
			} catch (error) {
				return { doc, path: this.path, error: `cannot create runs registry: ${String(error?.message ?? error)}` };
			}
			return { doc, path: this.path };
		}
		let parsed = null;
		try {
			parsed = JSON.parse(text);
		} catch {
			return { doc: null, path: this.path, error: `runs registry ${this.path} is not valid JSON` };
		}
		const check = validateRunsDoc(parsed);
		if (!check.ok) return { doc: null, path: this.path, error: `runs registry ${this.path} is corrupt: ${check.errors.join("; ")}` };
		return { doc: parsed, path: this.path };
	}

	/** All run records (chronological by startedAt, then id). */
	list() {
		const loaded = this.load();
		if (loaded.doc === null) return [];
		return [...loaded.doc.runs].sort((a, b) => (a.startedAt - b.startedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	}

	/** One run record by id, or null. */
	get(runId) {
		const loaded = this.load();
		if (loaded.doc === null) return null;
		return loaded.doc.runs.find((run) => run.id === runId) ?? null;
	}

	/**
	 * CAS create of a new run record. `expectedRevision` must equal the
	 * current document revision (0 for a fresh registry); on conflict the
	 * call fails with `code: "conflict"` and the caller re-reads and retries.
	 */
	create(runInput, { expectedRevision } = {}) {
		const loaded = this.load();
		if (loaded.doc === null) return { ok: false, code: "corrupt", errors: [loaded.error] };
		const expected = expectedRevision === undefined || expectedRevision === null ? loaded.doc.revision : expectedRevision;
		if (expected !== loaded.doc.revision) {
			return { ok: false, code: "conflict", currentRevision: loaded.doc.revision, errors: [`runs registry revision moved: expected ${expected}, current ${loaded.doc.revision}`] };
		}
		const run = { ...cloneRun(runInput), revision: 1, updatedAt: this.now() };
		const runErrors = [];
		validateRun(run, runErrors);
		if (runErrors.length > 0) return { ok: false, code: "invalid", errors: runErrors };
		if (loaded.doc.runs.some((item) => item.id === run.id)) {
			return { ok: false, code: "conflict", errors: [`run id ${run.id} already exists`] };
		}
		const check = validateRunsDoc({ ...loaded.doc, revision: loaded.doc.revision + 1, updatedAt: this.now(), runs: [...loaded.doc.runs, run] });
		if (!check.ok) return { ok: false, code: "invalid", errors: check.errors };
		const next = { ...loaded.doc, revision: loaded.doc.revision + 1, updatedAt: run.updatedAt, runs: [...loaded.doc.runs, run] };
		try {
			writeFileDurable(this.path, JSON.stringify(next, null, 2));
		} catch (error) {
			return { ok: false, code: "io", errors: [String(error?.message ?? error)] };
		}
		// Verify the write won the race (a concurrent writer would have moved
		// the revision past ours); report a conflict so the caller retries.
		const verify = this.load();
		if (verify.doc === null || verify.doc.revision !== next.revision) {
			return { ok: false, code: "conflict", currentRevision: verify.doc?.revision ?? 0, errors: ["runs registry revision moved during write"] };
		}
		return { ok: true, registryRevision: next.revision, run };
	}

	/**
	 * CAS update of one run. `patch` may set any of status/pid/exitCode/
	 * finishedAt/reason; a status change is validated against the state
	 * machine (terminal states refuse further transitions). Every successful
	 * update bumps both the run revision and the document revision.
	 */
	update(runId, patch, { expectedRevision } = {}) {
		const loaded = this.load();
		if (loaded.doc === null) return { ok: false, code: "corrupt", errors: [loaded.error] };
		const expected = expectedRevision === undefined || expectedRevision === null ? loaded.doc.revision : expectedRevision;
		if (expected !== loaded.doc.revision) {
			return { ok: false, code: "conflict", currentRevision: loaded.doc.revision, errors: [`runs registry revision moved: expected ${expected}, current ${loaded.doc.revision}`] };
		}
		const current = loaded.doc.runs.find((run) => run.id === runId) ?? null;
		if (current === null) return { ok: false, code: "not-found", errors: [`run ${runId} does not exist`] };
		const allowedPatchKeys = ["status", "pid", "exitCode", "finishedAt", "reason"];
		for (const key of Object.keys(patch)) {
			if (!allowedPatchKeys.includes(key)) return { ok: false, code: "invalid", errors: [`run patch has unknown key ${key}`] };
		}
		const nextStatus = patch.status === undefined ? current.status : patch.status;
		if (patch.status !== undefined && patch.status !== current.status && !isAllowedTransition(current.status, nextStatus)) {
			return { ok: false, code: "invalid-transition", errors: [`run ${runId} cannot transition ${current.status} → ${nextStatus}`] };
		}
		const next = cloneRun(current);
		if (patch.status !== undefined) next.status = patch.status;
		if (patch.pid !== undefined) next.pid = patch.pid;
		if (patch.exitCode !== undefined) next.exitCode = patch.exitCode;
		if (patch.finishedAt !== undefined) next.finishedAt = patch.finishedAt;
		if (patch.reason !== undefined) next.reason = patch.reason;
		next.revision += 1;
		next.updatedAt = this.now();
		const nextDoc = { ...loaded.doc, revision: loaded.doc.revision + 1, updatedAt: next.updatedAt, runs: loaded.doc.runs.map((run) => (run.id === runId ? next : run)) };
		const check = validateRunsDoc(nextDoc);
		if (!check.ok) return { ok: false, code: "invalid", errors: check.errors };
		try {
			writeFileDurable(this.path, JSON.stringify(nextDoc, null, 2));
		} catch (error) {
			return { ok: false, code: "io", errors: [String(error?.message ?? error)] };
		}
		const verify = this.load();
		if (verify.doc === null || verify.doc.revision !== nextDoc.revision) {
			return { ok: false, code: "conflict", currentRevision: verify.doc?.revision ?? 0, errors: ["runs registry revision moved during write"] };
		}
		return { ok: true, registryRevision: nextDoc.revision, run: next };
	}

	/**
	 * CAS mutation with a bounded retry loop: `mutator(doc)` returns either
	 * `{ write: nextDoc }` (write the document) or `{ skip: true }` (no-op
	 * success). After each atomic write the revision is re-read to verify the
	 * write won the race; a lost race re-runs the mutator. Bounded to `attempts`.
	 * @returns {{ok: true, registryRevision?, skipped?: boolean} | {ok: false, code, errors}}
	 */
	/**
	 * CAS-prune terminal runs older than `retentionDays` (default 14 days).
	 * Active/queued records are never removed. Each attempt re-reads the file;
	 * a lost CAS race retries unless an explicit expectedRevision was supplied.
	 * The fact file is rewritten only when something expires.
	 */
	pruneTerminalRuns({ retentionDays, runsRetentionDays, days: daysAlias, now = this.now(), expectedRevision, attempts = 3 } = {}) {
		const requestedDays = retentionDays ?? runsRetentionDays ?? daysAlias;
		const days = normalizeRetentionDays(requestedDays, DEFAULT_RUNS_RETENTION_DAYS);
		if (days === null) return { ok: false, code: "invalid", errors: [`runsRetentionDays must be a finite number >= 0 (got ${requestedDays})`] };
		if (!Number.isFinite(now) || now < 0) return { ok: false, code: "invalid", errors: [`now must be a finite timestamp >= 0 (got ${now})`] };
		const cutoff = now - days * DAY_MS;
		for (let attempt = 0; attempt < Math.max(1, attempts); attempt++) {
			const loaded = this.load();
			if (loaded.doc === null) return { ok: false, code: "corrupt", errors: [loaded.error] };
			if (expectedRevision !== undefined && expectedRevision !== null && expectedRevision !== loaded.doc.revision) {
				return { ok: false, code: "conflict", currentRevision: loaded.doc.revision, errors: [`runs registry revision moved: expected ${expectedRevision}, current ${loaded.doc.revision}`] };
			}
			const decision = pruneRunsDoc(loaded.doc, { retentionDays: days, now });
			if (!decision.ok) return { ok: false, code: "invalid", errors: decision.errors };
			if (decision.removedCount === 0) {
				return { ok: true, removed: [], removedIds: [], removedCount: 0, registryRevision: loaded.doc.revision, cutoff, retentionDays: days };
			}
			const next = { ...decision.document, revision: loaded.doc.revision + 1, updatedAt: now };
			const check = validateRunsDoc(next);
			if (!check.ok) return { ok: false, code: "invalid", errors: check.errors };
			try {
				writeFileDurable(this.path, JSON.stringify(next, null, 2));
			} catch (error) {
				return { ok: false, code: "io", errors: [String(error?.message ?? error)] };
			}
			const verify = this.load();
			if (verify.doc !== null && verify.doc.revision === next.revision) {
				return {
					ok: true,
					removed: decision.removed,
					removedIds: decision.removedIds,
					removedCount: decision.removedCount,
					registryRevision: next.revision,
					cutoff,
					retentionDays: days
				};
			}
			if (expectedRevision !== undefined && expectedRevision !== null) {
				return { ok: false, code: "conflict", currentRevision: verify.doc?.revision ?? 0, errors: ["runs registry revision moved during prune"] };
			}
		}
		return { ok: false, code: "conflict", errors: ["runs registry too busy: prune CAS retries exhausted"] };
	}

	mutate(mutator, { attempts = 3 } = {}) {
		for (let attempt = 0; attempt < attempts; attempt++) {
			const loaded = this.load();
			if (loaded.doc === null) return { ok: false, code: "corrupt", errors: [loaded.error] };
			const decision = mutator(loaded.doc);
			if (decision === null || decision === undefined) return { ok: true };
			if (decision.skip === true) return { ok: true, skipped: true };
			if (decision.write !== undefined) {
				const next = { ...decision.write, revision: loaded.doc.revision + 1, updatedAt: this.now() };
				const check = validateRunsDoc(next);
				if (!check.ok) return { ok: false, code: "invalid", errors: check.errors };
				try {
					writeFileDurable(this.path, JSON.stringify(next, null, 2));
				} catch (error) {
					return { ok: false, code: "io", errors: [String(error?.message ?? error)] };
				}
				// Verify the write won the race: another writer between our load
				// and rename would have moved the revision past ours.
				const verify = this.load();
				if (verify.doc !== null && verify.doc.revision === next.revision) {
					return { ok: true, registryRevision: next.revision };
				}
				continue; // lost the race → re-read and retry
			}
			return { ok: false, code: "invalid", errors: ["mutator must return { write } or { skip }"] };
		}
		return { ok: false, code: "conflict", errors: ["runs registry too busy: CAS retries exhausted"] };
	}
}

/**
 * Derive effective limits for a run: the task's manifest limits, overridden
 * per invocation by the resource_run caller. Defaults apply when the task declares
 * no limits section (manifest validation guarantees completeness otherwise).
 * @returns {{cpuMaxCores, memoryMaxBytes, tasksMax, memoryHighBytes|null}}
 */
export function deriveLimits(task, overrides = {}) {
	const base = task?.limits ?? DEFAULT_LIMITS;
	const pick = (key, value) => (isFiniteNumber(value) && value > 0 ? value : base[key]);
	const memoryHigh = Number.isInteger(base.memoryHighBytes) && base.memoryHighBytes >= 1 ? base.memoryHighBytes : null;
	return {
		cpuMaxCores: pick("cpuMaxCores", overrides?.cpuMaxCores),
		memoryMaxBytes: pick("memoryMaxBytes", overrides?.memoryMaxBytes),
		tasksMax: pick("tasksMax", overrides?.tasksMax),
		memoryHighBytes: memoryHigh
	};
}
