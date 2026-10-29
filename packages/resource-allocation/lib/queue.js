/**
 * Scheduler queue projection for the project tree (v0.3): the "who is
 * occupying a slot / who is still waiting" column, merged with resource-allocation's own
 * long-task runs.
 *
 * Fact sources (read-only, never written here):
 *  - `$DSH_HOME/storages/resource-allocation/queue.json` — the resource-allocation queue
 *    document (`queued[]`, `running[]`, `capacity`, `lastDecision`). The v0.1
 *    scheduler has no HTTP surface, so the project page reads the same file
 *    the scheduler writes; a missing file is NOT an error (no scheduler
 *    installed, or nothing enqueued yet).
 *  - the run registry — resource-allocation's own `resource_run` records, so the column stays
 *    useful on a machine that queues through resource-allocation instead of the scheduler.
 *
 * Every entry carries its task affiliation: `projectId` + `taskId` resolved
 * against the project registry, so a queue item can never float free of the
 * session/goal/job/run owner chain that produced it.
 *
 * @module resource-allocation/queue
 */
import { readFileSync } from "node:fs";

/** Scheduler statuses that appear in running[] and hold an active allocation. */
const OCCUPIED_STATUSES = Object.freeze(["running", "admitted", "throttled", "paused"]);
/** Terminal scheduler statuses are history, not current queue occupancy. */
const TERMINAL_STATUSES = Object.freeze(["completed", "failed", "killed"]);
/** Run statuses that mean "holds a slot right now" / "still waiting". */
const RUN_OCCUPIED_STATUSES = Object.freeze(["running", "launching"]);
const RUN_WAITING_STATUSES = Object.freeze(["queued"]);

/**
 * Read the scheduler queue document. A missing file is a valid "no queue"
 * state (doc null, error null); unreadable/corrupt files surface the error
 * instead of throwing.
 *
 * @param {string} path - absolute path to queue.json
 * @param {object} [io] - {read} injectable reader (tests)
 * @returns {{path: string, doc: object|null, error: string|null}}
 */
export function readQueueDoc(path, { read = (p) => readFileSync(p, "utf8") } = {}) {
	if (typeof path !== "string" || path.length === 0) return { path: null, doc: null, error: null };
	let text;
	try {
		text = read(path);
	} catch (error) {
		if (error?.code === "ENOENT") return { path, doc: null, error: null };
		return { path, doc: null, error: String(error?.message ?? error) };
	}
	try {
		const parsed = JSON.parse(text);
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
			return { path, doc: null, error: "queue.json is not an object" };
		}
		return { path, doc: parsed, error: null };
	} catch (error) {
		return { path, doc: null, error: `queue.json is not valid JSON: ${String(error?.message ?? error)}` };
	}
}

/** Task/name lookup over the already-projected projects. */
function buildLookup(projects) {
	const byProject = new Map();
	for (const entry of Array.isArray(projects) ? projects : []) {
		const id = entry?.project?.id;
		if (typeof id !== "string" || id.length === 0) continue;
		const tasks = new Map();
		for (const task of entry.tasks ?? []) {
			if (task !== null && typeof task === "object" && typeof task.id === "string") tasks.set(task.id, task);
		}
		byProject.set(id, { name: entry.project.name ?? id, tasks });
	}
	return byProject;
}

/** Resolve the task affiliation of one item; unknown ids stay visible. */
function affiliation(lookup, projectId, taskId) {
	const project = typeof projectId === "string" ? lookup.get(projectId) : undefined;
	const task = project !== undefined && typeof taskId === "string" ? project.tasks.get(taskId) : undefined;
	return {
		projectId: typeof projectId === "string" && projectId.length > 0 ? projectId : null,
		projectName: project?.name ?? null,
		taskId: typeof taskId === "string" && taskId.length > 0 ? taskId : null,
		projectKnown: project !== undefined,
		taskKnown: task !== undefined,
		taskKind: task?.kind ?? null,
		taskSystemdUnit: task?.systemdUnit ?? null
	};
}

function normalizeOwner(owner) {
	if (owner === null || typeof owner !== "object") return null;
	const fields = {};
	for (const key of ["kind", "sessionId", "agentId", "goalId", "jobId", "runId"]) {
		if (typeof owner[key] === "string" && owner[key].length > 0) fields[key] = owner[key];
	}
	return Object.keys(fields).length > 0 ? fields : null;
}

/** Resource request in the scheduler's own units (cores / bytes). */
function normalizeRequest(request) {
	if (request === null || typeof request !== "object") return null;
	const out = {};
	if (Number.isFinite(request.cpuCores)) out.cpuCores = request.cpuCores;
	if (Number.isFinite(request.memBytes)) out.memBytes = request.memBytes;
	return Object.keys(out).length > 0 ? out : null;
}

function queueEntry(item, { state, at, lookup }) {
	const status = typeof item?.status === "string" ? item.status : state === "occupied" ? "running" : "queued";
	const submittedAt = Number.isFinite(item?.submittedAt) ? item.submittedAt : null;
	return {
		id: typeof item?.id === "string" && item.id.length > 0 ? item.id : null,
		source: "scheduler",
		state,
		status,
		priority: Number.isFinite(item?.priority) ? item.priority : null,
		owner: normalizeOwner(item?.owner),
		request: normalizeRequest(item?.request),
		deadlineAt: Number.isFinite(item?.deadlineAt) ? item.deadlineAt : null,
		reason: typeof item?.reason === "string" ? item.reason : null,
		submittedAt,
		waitingMs: submittedAt === null ? null : Math.max(0, at - submittedAt),
		unit: null,
		pid: null,
		command: null,
		lastTransitionAt: Number.isFinite(item?.lastTransitionAt) ? item.lastTransitionAt : submittedAt,
		updatedAt: Number.isFinite(item?.lastTransitionAt) ? item.lastTransitionAt : submittedAt,
		...affiliation(lookup, item?.projectId, item?.taskId)
	};
}

function runEntry(run, { state, at, lookup }) {
	const startedAt = Number.isFinite(run?.startedAt) ? run.startedAt : null;
	return {
		id: typeof run?.id === "string" && run.id.length > 0 ? run.id : null,
		source: "resource-run",
		state,
		status: typeof run?.status === "string" ? run.status : state === "occupied" ? "running" : "queued",
		priority: null,
		request: null,
		deadlineAt: null,
		reason: typeof run?.reason === "string" ? run.reason : null,
		submittedAt: startedAt,
		waitingMs: startedAt === null ? null : Math.max(0, at - startedAt),
		unit: typeof run?.unit === "string" ? run.unit : null,
		pid: Number.isFinite(run?.pid) ? run.pid : null,
		command: Array.isArray(run?.command) ? run.command.map(String) : null,
		lastTransitionAt: Number.isFinite(run?.updatedAt) ? run.updatedAt : startedAt,
		updatedAt: Number.isFinite(run?.updatedAt) ? run.updatedAt : startedAt,
		owner: normalizeOwner(run?.owner),
		...affiliation(lookup, run?.projectId, run?.taskId)
	};
}

/**
 * Merge the scheduler queue and the resource-run registry into the single ordered
 * "slot holders / waiting" list the projects projection renders.
 *
 * Occupied entries come first, then waiting ones; inside each group FIFO by
 * submission time (which is also the scheduler's aging order). A run that the
 * scheduler already tracks (owner.runId) is not listed twice.
 *
 * @param {object} options - {queueDoc, queuePath?, queueError?, projects, runs, now}
 * @returns {object} projection (JSON-serializable)
 */
export function projectWaiting({ queueDoc = null, queuePath = null, queueError = null, projects = [], runs = [], now = () => Date.now() } = {}) {
	const at = now();
	const lookup = buildLookup(projects);
	const entries = [];
	const scheduledRunIds = new Set();
	const doc = queueDoc !== null && typeof queueDoc === "object" ? queueDoc : null;

	for (const wrapper of Array.isArray(doc?.running) ? doc.running : []) {
		// running[] entries are {item, allocation}; terminal history in that
		// array is deliberately excluded from the live slot-holder view.
		const item = wrapper !== null && typeof wrapper === "object" && wrapper.item !== undefined ? wrapper.item : wrapper;
		if (item === null || typeof item !== "object") continue;
		if (TERMINAL_STATUSES.includes(item.status) || !OCCUPIED_STATUSES.includes(item.status)) continue;
		if (typeof item.owner?.runId === "string") scheduledRunIds.add(item.owner.runId);
		const entry = queueEntry(item, { state: "occupied", at, lookup });
		const allocation = wrapper?.allocation;
		if (allocation !== null && typeof allocation === "object") {
			entry.allocation = {
				cpuCores: Number.isFinite(allocation.cpuCores) ? allocation.cpuCores : null,
				memBytes: Number.isFinite(allocation.memBytes) ? allocation.memBytes : null,
				managerUnit: typeof allocation.managerUnit === "string" ? allocation.managerUnit : null,
				pid: Number.isInteger(allocation.pid) && allocation.pid > 0 ? allocation.pid : null,
				cgroupPath: typeof allocation.cgroupPath === "string" ? allocation.cgroupPath : null
			};
		}
		entries.push(entry);
	}
	for (const item of Array.isArray(doc?.queued) ? doc.queued : []) {
		if (item === null || typeof item !== "object") continue;
		if (TERMINAL_STATUSES.includes(item.status)) continue;
		if (typeof item.owner?.runId === "string") scheduledRunIds.add(item.owner.runId);
		entries.push(queueEntry(item, { state: "waiting", at, lookup }));
	}
	for (const run of Array.isArray(runs) ? runs : []) {
		if (run === null || typeof run !== "object") continue;
		if (typeof run.id === "string" && scheduledRunIds.has(run.id)) continue;
		if (RUN_OCCUPIED_STATUSES.includes(run.status)) entries.push(runEntry(run, { state: "occupied", at, lookup }));
		else if (RUN_WAITING_STATUSES.includes(run.status)) entries.push(runEntry(run, { state: "waiting", at, lookup }));
	}

	entries.sort((left, right) => {
		if (left.state !== right.state) return left.state === "occupied" ? -1 : 1;
		const leftAt = Number.isFinite(left.submittedAt) ? left.submittedAt : Number.MAX_SAFE_INTEGER;
		const rightAt = Number.isFinite(right.submittedAt) ? right.submittedAt : Number.MAX_SAFE_INTEGER;
		if (leftAt !== rightAt) return leftAt - rightAt;
		return String(left.id ?? "").localeCompare(String(right.id ?? ""));
	});

	const unassigned = entries.filter((entry) => entry.projectKnown !== true || entry.taskKnown !== true);
	return {
		at,
		path: queuePath,
		error: queueError,
		scheduler: doc === null ? null : {
			revision: Number.isFinite(doc.revision) ? doc.revision : null,
			updatedAt: Number.isFinite(doc.updatedAt) ? doc.updatedAt : null,
			capacity: doc.capacity ?? null,
			lastDecision: doc.lastDecision ?? null
		},
		counts: {
			occupied: entries.filter((entry) => entry.state === "occupied").length,
			waiting: entries.filter((entry) => entry.state === "waiting").length,
			scheduler: entries.filter((entry) => entry.source === "scheduler").length,
			runs: entries.filter((entry) => entry.source === "resource-run").length,
			unaffiliated: unassigned.length,
			unassigned: unassigned.length
		},
		entries,
		unassigned
	};
}
