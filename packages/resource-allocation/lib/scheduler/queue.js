/**
 * The resource-allocation queue registry: the persisted fact source at
 * `$DSH_HOME/storages/resource-allocation/queue.json`.
 *
 * Document shape (conforms to schemas/queue.schema.json):
 *
 * ```json
 * {
 *   "schemaVersion": 1,
 *   "revision": 4,
 *   "updatedAt": 1786896000000,
 *   "queued":   [ {queue-item...} ],
 *   "running":  [ { "item": {queue-item...}, "allocation": {...} } ],
 *   "capacity": { "pressure": "ok", "headroomCpuCores": 2.5, "headroomMemBytes": 1234, "sampledAt": 1786896000000 },
 *   "lastDecision": { "revision": 4, "action": "admit", "reason": "...", "by": "resource_plan", "at": 1786896000000 }
 * }
 * ```
 *
 * Partition rule: items with status `queued` live in `queued[]`; every
 * post-admission status (admitted / running / throttled / paused and the
 * terminal completed / failed / killed) lives in `running[]` together with
 * the item's allocation. Terminal items stay in the document — the queue is
 * a fact source and never silently drops history (archiving is a later
 * version's job).
 *
 * State machine (validated on every transition):
 *
 * ```
 * queued    → admitted | failed | killed
 * admitted  → running | throttled | paused | completed | failed | killed
 * running   → throttled | paused | completed | failed | killed
 * throttled → running | paused | completed | failed | killed
 * paused    → running | completed | failed | killed
 * completed / failed / killed → (terminal)
 * ```
 *
 * v0.1 produces only: enqueue (queued), admission (queued→admitted),
 * throttle (running→throttled), pause (running|throttled→paused, preemptible
 * tasks only) and resume (paused|throttled→running). `killed` transitions are
 * recording-only and are never emitted with lastDecision.action "kill":
 * the scheduler never kills, kill is hardware-guard's true-runaway judgment.
 *
 * Concurrency (ops-generalization §2): `revision` is monotonic and every
 * write is compare-and-swap on it (expectedRevision), via atomic durable
 * replace (temp + fsync + rename + verify). A writer that loses the race
 * re-reads and retries (bounded). Every change rewrites `lastDecision` with
 * the new revision, action, reason, actor (`by`) and timestamp.
 *
 * @module resource-allocation/queue
 */
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { tryRead, writeFileDurable } from "./atomic.js";

export const QUEUE_SCHEMA_VERSION = 1;
export const QUEUE_FILE_NAME = "queue.json";

/** Default queueLimit applied when the caller does not pass a policy one. */
export const DEFAULT_QUEUE_LIMIT = 32;

export const ITEM_STATUSES = Object.freeze(["queued", "admitted", "running", "throttled", "paused", "completed", "failed", "killed"]);
export const TERMINAL_STATUSES = Object.freeze(["completed", "failed", "killed"]);
/** Statuses that hold an allocation slot (post-admission, unfinished). */
export const ALLOCATED_STATUSES = Object.freeze(["admitted", "running", "throttled", "paused"]);
export const QUEUED_ARR_STATUSES = Object.freeze(["queued"]);
export const RUNNING_ARR_STATUSES = Object.freeze(["admitted", "running", "throttled", "paused", "completed", "failed", "killed"]);
export const ACTIVE_STATUSES = Object.freeze(["queued", "admitted", "running", "throttled", "paused"]);

export const DECISION_ACTIONS = Object.freeze(["admit", "deny", "throttle", "pause", "resume", "kill", "reject", "noop"]);
export const PRESSURE_STATES = Object.freeze(["ok", "warn", "critical"]);

/** Allowed status transitions (state machine); terminal states have none. */
export const ITEM_TRANSITIONS = Object.freeze({
	queued: ["admitted", "failed", "killed"],
	admitted: ["running", "throttled", "paused", "completed", "failed", "killed"],
	running: ["throttled", "paused", "completed", "failed", "killed"],
	throttled: ["running", "paused", "completed", "failed", "killed"],
	paused: ["running", "completed", "failed", "killed"],
	completed: [],
	failed: [],
	killed: []
});

/** Whether a status transition is allowed by the state machine. */
export function isAllowedTransition(from, to) {
	return (ITEM_TRANSITIONS[from] ?? []).includes(to);
}

const ITEM_KEYS = Object.freeze(["id", "projectId", "taskId", "owner", "priority", "status", "request", "deadlineAt", "reason", "submittedAt", "lastTransitionAt"]);
const OWNER_KEYS = Object.freeze(["sessionId", "agentId", "goalId", "jobId", "runId"]);
const ALLOCATION_KEYS = Object.freeze(["cpuCores", "memBytes", "managerUnit", "pid", "cgroupPath"]);

function isNonEmptyString(value) {
	return typeof value === "string" && value.length > 0;
}

function isFiniteNumber(value) {
	return typeof value === "number" && Number.isFinite(value);
}

function collectUnknownKeys(object, allowed, errors, where) {
	if (typeof object !== "object" || object === null || Array.isArray(object)) return;
	for (const key of Object.keys(object)) {
		if (!allowed.includes(key)) errors.push(`${where} has unknown key ${key}`);
	}
}

/** Validate one owner object (all fields optional strings). */
export function validateOwner(owner, errors, where) {
	if (typeof owner !== "object" || owner === null || Array.isArray(owner)) {
		errors.push(`${where} owner must be an object`);
		return;
	}
	collectUnknownKeys(owner, OWNER_KEYS, errors, `${where} owner`);
	for (const key of OWNER_KEYS) {
		if (owner[key] !== undefined && typeof owner[key] !== "string") {
			errors.push(`${where} owner.${key} must be a string when present`);
		}
	}
}

/** Validate one resource request ({cpuCores, memBytes}). */
export function validateRequest(request, errors, where) {
	if (typeof request !== "object" || request === null || Array.isArray(request)) {
		errors.push(`${where} request must be an object`);
		return;
	}
	collectUnknownKeys(request, ["cpuCores", "memBytes"], errors, `${where} request`);
	if (!isFiniteNumber(request.cpuCores) || request.cpuCores <= 0) errors.push(`${where} request.cpuCores must be a number > 0`);
	if (!Number.isInteger(request.memBytes) || request.memBytes < 1) errors.push(`${where} request.memBytes must be an integer >= 1`);
}

/** Validate one queue item against queue.schema.json #/definitions/queue-item. */
export function validateQueueItem(item, errors, where = "item") {
	if (typeof item !== "object" || item === null || Array.isArray(item)) {
		errors.push(`${where} must be an object`);
		return;
	}
	collectUnknownKeys(item, ITEM_KEYS, errors, where);
	if (!isNonEmptyString(item.id)) errors.push(`${where} id must be a non-empty string`);
	if (!isNonEmptyString(item.projectId)) errors.push(`${where} projectId must be a non-empty string`);
	if (!isNonEmptyString(item.taskId)) errors.push(`${where} taskId must be a non-empty string`);
	validateOwner(item.owner, errors, where);
	if (!Number.isInteger(item.priority) || item.priority < 0 || item.priority > 100) errors.push(`${where} priority must be an integer 0..100`);
	if (!ITEM_STATUSES.includes(item.status)) errors.push(`${where} status invalid: ${item.status}`);
	validateRequest(item.request, errors, where);
	if (item.deadlineAt !== undefined && item.deadlineAt !== null && (!Number.isInteger(item.deadlineAt) || item.deadlineAt < 0)) {
		errors.push(`${where} deadlineAt must be an integer >= 0 or null`);
	}
	if (item.reason !== undefined && typeof item.reason !== "string") errors.push(`${where} reason must be a string when present`);
	if (!Number.isInteger(item.submittedAt) || item.submittedAt < 0) errors.push(`${where} submittedAt invalid: ${item.submittedAt}`);
	if (!Number.isInteger(item.lastTransitionAt) || item.lastTransitionAt < 0) errors.push(`${where} lastTransitionAt invalid: ${item.lastTransitionAt}`);
}

/** Validate one allocation object against queue.schema.json #/definitions/running-item. */
export function validateAllocation(allocation, errors, where) {
	if (typeof allocation !== "object" || allocation === null || Array.isArray(allocation)) {
		errors.push(`${where} allocation must be an object`);
		return;
	}
	collectUnknownKeys(allocation, ALLOCATION_KEYS, errors, `${where} allocation`);
	if (!isFiniteNumber(allocation.cpuCores) || allocation.cpuCores < 0) errors.push(`${where} allocation.cpuCores must be a number >= 0`);
	if (!Number.isInteger(allocation.memBytes) || allocation.memBytes < 0) errors.push(`${where} allocation.memBytes must be an integer >= 0`);
	if (typeof allocation.managerUnit !== "string") errors.push(`${where} allocation.managerUnit must be a string`);
	if (allocation.pid !== undefined && allocation.pid !== null && (!Number.isInteger(allocation.pid) || allocation.pid <= 0)) {
		errors.push(`${where} allocation.pid must be a positive integer or null`);
	}
	if (allocation.cgroupPath !== undefined && typeof allocation.cgroupPath !== "string") errors.push(`${where} allocation.cgroupPath must be a string when present`);
}

/** Validate one running entry ({item, allocation}). */
export function validateRunningEntry(entry, errors, where = "running entry") {
	if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
		errors.push(`${where} must be an object`);
		return;
	}
	collectUnknownKeys(entry, ["item", "allocation"], errors, where);
	validateQueueItem(entry.item, errors, `${where} item`);
	validateAllocation(entry.allocation, errors, where);
}

/** Validate one capacity object. */
export function validateCapacity(capacity, errors) {
	if (typeof capacity !== "object" || capacity === null || Array.isArray(capacity)) {
		errors.push("capacity must be an object");
		return;
	}
	collectUnknownKeys(capacity, ["pressure", "headroomCpuCores", "headroomMemBytes", "sampledAt"], errors, "capacity");
	if (!PRESSURE_STATES.includes(capacity.pressure)) errors.push(`capacity.pressure invalid: ${capacity.pressure}`);
	if (!isFiniteNumber(capacity.headroomCpuCores) || capacity.headroomCpuCores < 0) errors.push(`capacity.headroomCpuCores must be a number >= 0`);
	if (!Number.isInteger(capacity.headroomMemBytes) || capacity.headroomMemBytes < 0) errors.push(`capacity.headroomMemBytes must be an integer >= 0`);
	if (!Number.isInteger(capacity.sampledAt) || capacity.sampledAt < 0) errors.push(`capacity.sampledAt must be an integer >= 0`);
}

/** Validate one lastDecision object. */
export function validateLastDecision(decision, errors) {
	if (typeof decision !== "object" || decision === null || Array.isArray(decision)) {
		errors.push("lastDecision must be an object");
		return;
	}
	collectUnknownKeys(decision, ["revision", "action", "reason", "by", "at"], errors, "lastDecision");
	if (!Number.isInteger(decision.revision) || decision.revision < 1) errors.push(`lastDecision.revision must be an integer >= 1`);
	if (!DECISION_ACTIONS.includes(decision.action)) errors.push(`lastDecision.action invalid: ${decision.action}`);
	if (typeof decision.reason !== "string") errors.push("lastDecision.reason must be a string");
	if (typeof decision.by !== "string") errors.push("lastDecision.by must be a string");
	if (!Number.isInteger(decision.at) || decision.at < 0) errors.push("lastDecision.at must be an integer >= 0");
}

/**
 * Structural validation of a queue document. A corrupt fact source is
 * surfaced, never silently repaired: every write is refused until the
 * operator fixes or removes the file (same contract as resource-allocation registries).
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateQueueDoc(doc) {
	const errors = [];
	if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return { ok: false, errors: ["queue document is not an object"] };
	collectUnknownKeys(doc, ["schemaVersion", "revision", "updatedAt", "queued", "running", "capacity", "lastDecision"], errors, "queue document");
	if (doc.schemaVersion !== QUEUE_SCHEMA_VERSION) errors.push(`queue schemaVersion must be ${QUEUE_SCHEMA_VERSION} (got ${doc.schemaVersion})`);
	if (!Number.isInteger(doc.revision) || doc.revision < 1) errors.push(`queue revision invalid: ${doc.revision}`);
	if (!Number.isInteger(doc.updatedAt) || doc.updatedAt < 0) errors.push(`queue updatedAt invalid: ${doc.updatedAt}`);
	const seenIds = new Set();
	if (!Array.isArray(doc.queued)) errors.push("queue queued must be an array");
	else {
		for (const item of doc.queued) {
			validateQueueItem(item, errors, `queued item ${item?.id ?? "?"}`);
			if (item !== null && typeof item === "object") {
				if (item.status !== "queued") errors.push(`queued item ${item.id ?? "?"} must have status "queued" (got ${item.status})`);
				if (typeof item.id === "string") {
					if (seenIds.has(item.id)) errors.push(`duplicate queue item id: ${item.id}`);
					seenIds.add(item.id);
				}
			}
		}
	}
	if (!Array.isArray(doc.running)) errors.push("queue running must be an array");
	else {
		for (const entry of doc.running) {
			validateRunningEntry(entry, errors, `running entry ${entry?.item?.id ?? "?"}`);
			const item = entry?.item;
			if (item !== null && typeof item === "object") {
				if (typeof item.status === "string" && !RUNNING_ARR_STATUSES.includes(item.status)) {
					errors.push(`running item ${item.id ?? "?"} has status ${item.status}; running[] holds post-admission statuses only`);
				}
				if (typeof item.id === "string") {
					if (seenIds.has(item.id)) errors.push(`duplicate queue item id: ${item.id}`);
					seenIds.add(item.id);
				}
			}
		}
	}
	validateCapacity(doc.capacity, errors);
	validateLastDecision(doc.lastDecision, errors);
	return { ok: errors.length === 0, errors };
}

/** Build an empty, schema-conformant queue document (revision starts at 1). */
export function emptyQueueDoc(now = Date.now()) {
	return {
		schemaVersion: QUEUE_SCHEMA_VERSION,
		revision: 1,
		updatedAt: now,
		queued: [],
		running: [],
		capacity: { pressure: "ok", headroomCpuCores: 0, headroomMemBytes: 0, sampledAt: now },
		lastDecision: {
			revision: 1,
			action: "noop",
			reason: "queue initialized",
			by: "resource-allocation",
			at: now
		}
	};
}

/** Queue item ids are lowercase base36 (log-friendly) and unique. */
export function makeItemId(now = Date.now()) {
	return `${now.toString(36)}${randomBytes(3).toString("hex")}`;
}

/** Deep-copy a plain JSON document. */
export function clone(doc) {
	return JSON.parse(JSON.stringify(doc));
}

/**
 * Normalize an enqueue input into a schema-conformant queue item with status
 * "queued". Unknown keys are dropped (the caller's input is not a fact source
 * write — strict validation runs on the resulting item).
 */
export function normalizeItem(input, { now = Date.now() } = {}) {
	const item = {
		id: isNonEmptyString(input.id) ? input.id : makeItemId(now),
		projectId: input.projectId,
		taskId: input.taskId,
		owner: {},
		priority: input.priority,
		status: "queued",
		request: { cpuCores: input.request?.cpuCores, memBytes: input.request?.memBytes },
		submittedAt: input.submittedAt ?? now,
		lastTransitionAt: input.lastTransitionAt ?? now
	};
	for (const key of OWNER_KEYS) {
		if (typeof input.owner?.[key] === "string" && input.owner[key].length > 0) item.owner[key] = input.owner[key];
	}
	if (input.deadlineAt !== undefined && input.deadlineAt !== null) item.deadlineAt = input.deadlineAt;
	if (isNonEmptyString(input.reason)) item.reason = input.reason;
	return item;
}

/** Find an item across both arrays; returns {item, location, allocation}. */
function locateItem(doc, itemId) {
	const queued = doc.queued.findIndex((item) => item.id === itemId);
	if (queued >= 0) return { item: doc.queued[queued], location: "queued", index: queued, allocation: null };
	const running = doc.running.findIndex((entry) => entry.item.id === itemId);
	if (running >= 0) return { item: doc.running[running].item, location: "running", index: running, allocation: doc.running[running].allocation };
	return null;
}

/** All active items (queued[] + non-terminal running[]) as flat list. */
export function activeItems(doc) {
	return [
		...doc.queued,
		...doc.running.map((entry) => entry.item).filter((item) => !TERMINAL_STATUSES.includes(item.status))
	];
}

/**
 * The persisted queue registry. One instance per storage directory; reads
 * always hit the file so concurrent instances observe each other's CAS
 * writes. Nothing lives in process memory as a fact source.
 */
export class QueueRegistry {
	constructor({ dir, now = () => Date.now() } = {}) {
		this.dir = dir;
		this.path = join(dir, QUEUE_FILE_NAME);
		this.now = now;
	}

	/** Load the document; a missing file becomes an empty durable registry. */
	load() {
		const text = tryRead(this.path);
		if (text === null) {
			const doc = emptyQueueDoc(this.now());
			try {
				writeFileDurable(this.path, JSON.stringify(doc, null, 2));
			} catch (error) {
				return { doc, path: this.path, error: `cannot create queue registry: ${String(error?.message ?? error)}` };
			}
			return { doc, path: this.path };
		}
		let parsed = null;
		try {
			parsed = JSON.parse(text);
		} catch {
			return { doc: null, path: this.path, error: `queue registry ${this.path} is not valid JSON` };
		}
		const check = validateQueueDoc(parsed);
		if (!check.ok) return { doc: null, path: this.path, error: `queue registry ${this.path} is corrupt: ${check.errors.join("; ")}` };
		return { doc: parsed, path: this.path };
	}

	/** The current document snapshot, or null when corrupt. */
	list() {
		const loaded = this.load();
		return loaded.doc === null ? null : clone(loaded.doc);
	}

	/** One item by id (from either array), or null. */
	get(itemId) {
		const doc = this.list();
		if (doc === null) return null;
		const found = locateItem(doc, itemId);
		return found === null ? null : found.item;
	}

	/**
	 * Build a lastDecision record for the given revision.
	 */
	lastDecision(revision, action, reason, by, at = this.now()) {
		return { revision, action, reason, by, at };
	}

	/**
	 * CAS write helper shared by enqueue/transition/mutate: replace the
	 * document and verify the revision won the race.
	 */
	_write(nextDoc) {
		try {
			writeFileDurable(this.path, JSON.stringify(nextDoc, null, 2));
		} catch (error) {
			return { ok: false, code: "io", errors: [String(error?.message ?? error)] };
		}
		const verify = this.load();
		if (verify.doc === null || verify.doc.revision !== nextDoc.revision) {
			return { ok: false, code: "conflict", currentRevision: verify.doc?.revision ?? 0, errors: ["queue registry revision moved during write"] };
		}
		return { ok: true, registryRevision: nextDoc.revision };
	}

	/**
	 * CAS enqueue of one item into `queued[]` with status "queued".
	 *
	 * Refusals (queue full, duplicate active submission) still record a
	 * `lastDecision` with action "reject" and bump the revision — the decision
	 * log is part of the fact source. Invalid input fails without a write.
	 *
	 * @param {object} input - enqueue input; see normalizeItem()
	 * @param {object} options - {expectedRevision, by, queueLimit}
	 */
	enqueue(input, { expectedRevision, by = "resource_queue", queueLimit = DEFAULT_QUEUE_LIMIT } = {}) {
		const loaded = this.load();
		if (loaded.doc === null) return { ok: false, code: "corrupt", errors: [loaded.error] };
		const expected = expectedRevision === undefined || expectedRevision === null ? loaded.doc.revision : expectedRevision;
		if (expected !== loaded.doc.revision) {
			return { ok: false, code: "conflict", currentRevision: loaded.doc.revision, errors: [`queue revision moved: expected ${expected}, current ${loaded.doc.revision}`] };
		}
		const item = normalizeItem(input, { now: this.now() });
		const itemErrors = [];
		validateQueueItem(item, itemErrors, `item ${item.id}`);
		if (itemErrors.length > 0) return { ok: false, code: "invalid", errors: itemErrors };

		const reject = (reason) => {
			const next = {
				...loaded.doc,
				revision: loaded.doc.revision + 1,
				updatedAt: this.now(),
				lastDecision: this.lastDecision(loaded.doc.revision + 1, "reject", reason, by)
			};
			const check = validateQueueDoc(next);
			if (!check.ok) return { ok: false, code: "invalid", errors: check.errors };
			const written = this._write(next);
			if (!written.ok) return written;
			return { ok: false, code: "rejected", errors: [reason], registryRevision: written.registryRevision };
		};

		if (loaded.doc.queued.length >= queueLimit) {
			return reject(`queue limit reached (${loaded.doc.queued.length}/${queueLimit}); item ${item.id} not enqueued`);
		}
		const runId = item.owner.runId ?? null;
		const duplicate = activeItems(loaded.doc).some((other) =>
			other.projectId === item.projectId
			&& other.taskId === item.taskId
			&& (other.owner?.runId ?? null) === runId
		);
		if (duplicate) {
			return reject(`an active item for ${item.projectId}/${item.taskId}${runId === null ? "" : ` run ${runId}`} already exists`);
		}

		const next = {
			...loaded.doc,
			revision: loaded.doc.revision + 1,
			updatedAt: item.submittedAt,
			queued: [...loaded.doc.queued, item],
			lastDecision: this.lastDecision(loaded.doc.revision + 1, "noop", `item ${item.id} enqueued (${item.projectId}/${item.taskId})`, by)
		};
		const check = validateQueueDoc(next);
		if (!check.ok) return { ok: false, code: "invalid", errors: check.errors };
		const written = this._write(next);
		if (!written.ok) return written;
		return { ok: true, registryRevision: written.registryRevision, item };
	}

	/**
	 * CAS status transition of one item, validated against the state machine.
	 *
	 * `queued → admitted` moves the item into `running[]` and REQUIRES an
	 * `allocation`. All other transitions keep the item where it is (a
	 * queued item reaching a terminal state is recorded in `running[]` with a
	 * zero allocation — it never received resources). lastDecision.action is
	 * derived from the target status; `killed` transitions are recording-only
	 * and always log action "noop" — the scheduler never kills.
	 */
	transition(itemId, toStatus, { expectedRevision, by = "operator", reason = null, allocation = null } = {}) {
		const loaded = this.load();
		if (loaded.doc === null) return { ok: false, code: "corrupt", errors: [loaded.error] };
		const expected = expectedRevision === undefined || expectedRevision === null ? loaded.doc.revision : expectedRevision;
		if (expected !== loaded.doc.revision) {
			return { ok: false, code: "conflict", currentRevision: loaded.doc.revision, errors: [`queue revision moved: expected ${expected}, current ${loaded.doc.revision}`] };
		}
		if (!ITEM_STATUSES.includes(toStatus)) return { ok: false, code: "invalid", errors: [`unknown status ${toStatus}`] };
		const found = locateItem(loaded.doc, itemId);
		if (found === null) return { ok: false, code: "not-found", errors: [`item ${itemId} does not exist`] };
		if (!isAllowedTransition(found.item.status, toStatus)) {
			return { ok: false, code: "invalid-transition", errors: [`item ${itemId} cannot transition ${found.item.status} → ${toStatus}`] };
		}
		const now = this.now();
		const nextItem = {
			...found.item,
			status: toStatus,
			reason: reason !== null ? reason : found.item.reason,
			lastTransitionAt: now
		};

		const next = clone(loaded.doc);
		next.revision = loaded.doc.revision + 1;
		next.updatedAt = now;
		const queued = next.queued.filter((item) => item.id !== itemId);
		const running = next.running.filter((entry) => entry.item.id !== itemId);
		if (toStatus === "admitted") {
			if (allocation === null) return { ok: false, code: "invalid", errors: [`item ${itemId} needs an allocation to transition to admitted`] };
			const allocationErrors = [];
			validateAllocation(allocation, allocationErrors, `item ${itemId}`);
			if (allocationErrors.length > 0) return { ok: false, code: "invalid", errors: allocationErrors };
			running.push({ item: nextItem, allocation });
		} else if (RUNNING_ARR_STATUSES.includes(toStatus)) {
			running.push({
				item: nextItem,
				allocation: found.allocation ?? { cpuCores: 0, memBytes: 0, managerUnit: "" }
			});
		} else {
			queued.push(nextItem);
		}
		next.queued = queued;
		next.running = running;
		const resumed = (found.item.status === "paused" || found.item.status === "throttled") && toStatus === "running";
		const action = toStatus === "admitted" ? "admit"
			: toStatus === "throttled" ? "throttle"
				: toStatus === "paused" ? "pause"
					: resumed ? "resume"
						: "noop";
		const reasonText = reason ?? (toStatus === "killed"
			? `item ${itemId} marked killed by ${by} (recording only — the scheduler never kills)`
			: `item ${itemId} transitioned to ${toStatus} by ${by}`);
		next.lastDecision = this.lastDecision(next.revision, action, reasonText, by, now);
		const check = validateQueueDoc(next);
		if (!check.ok) return { ok: false, code: "invalid", errors: check.errors };
		const written = this._write(next);
		if (!written.ok) return written;
		return { ok: true, registryRevision: written.registryRevision, item: nextItem, location: toStatus === "admitted" || found.location === "running" ? "running" : "queued" };
	}

	/**
	 * CAS mutation with a bounded retry loop: `mutator(doc)` returns
	 * `{ write: nextDoc }` (replace the document), `{ skip: true }` (no-op
	 * success) or null/undefined (no change needed). mutate() adds the
	 * revision bump and updatedAt, validates, writes atomically and verifies
	 * the revision won the race; a lost race re-runs the mutator.
	 *
	 * The mutator is responsible for setting `capacity` and `lastDecision`
	 * (the planner builds both); mutate() only bumps revision/updatedAt.
	 */
	mutate(mutator, { attempts = 3 } = {}) {
		for (let attempt = 0; attempt < attempts; attempt++) {
			const loaded = this.load();
			if (loaded.doc === null) return { ok: false, code: "corrupt", errors: [loaded.error] };
			const decision = mutator(loaded.doc);
			if (decision === null || decision === undefined) return { ok: true, unchanged: true };
			if (decision.skip === true) return { ok: true, skipped: true };
			if (decision.write !== undefined) {
				const writeAt = this.now();
				const next = { ...clone(decision.write), revision: loaded.doc.revision + 1, updatedAt: writeAt };
				// The mutator builds lastDecision without knowing the final
				// revision; stamp it here so it always records the revision
				// it was written at.
				if (next.lastDecision !== undefined && next.lastDecision !== null) {
					next.lastDecision = { ...next.lastDecision, revision: next.revision, at: writeAt };
				}
				const check = validateQueueDoc(next);
				if (!check.ok) return { ok: false, code: "invalid", errors: check.errors };
				try {
					writeFileDurable(this.path, JSON.stringify(next, null, 2));
				} catch (error) {
					return { ok: false, code: "io", errors: [String(error?.message ?? error)] };
				}
				const verify = this.load();
				if (verify.doc !== null && verify.doc.revision === next.revision) {
					return { ok: true, registryRevision: next.revision };
				}
				continue; // lost the race → re-read and retry
			}
			return { ok: false, code: "invalid", errors: ["mutator must return { write }, { skip } or null"] };
		}
		return { ok: false, code: "conflict", errors: ["queue registry too busy: CAS retries exhausted"] };
	}
}
