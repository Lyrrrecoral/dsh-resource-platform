/**
 * The resource-allocation policy store: the persisted fact source at
 * `$DSH_HOME/storages/resource-allocation/policy.json` (conforms to
 * schemas/policy.schema.json).
 *
 * The policy is a portable rules document (ops-generalization §1): it can be
 * reused across projects and machines. It has NO revision field — the schema
 * forbids extra keys — so it is not CAS-guarded like queue.json; it is
 * replaced atomically when written. v0.1 writes it exactly once: creating
 * the default policy when the file does not exist. Policy updates are
 * operator edits (or a later resource_policy tool).
 *
 * Default policy (the v0.1 contract):
 *   ok:       allow new background work; no throttle, no pause.
 *   warn:     deny new background admissions, throttle running (elastic)
 *             work to targetCpuFraction 0.5.
 *   critical: pause preemptible tasks, deny new foreground heavy work,
 *             throttle the rest — but NEVER kill (killRunaways forced
 *             false; kill belongs to hardware-guard's true-runaway judgment).
 *
 * Projects without a `quotas[]` entry can only queue — they are never
 * admitted without a quota (ops-generalization §3.4).
 *
 * @module resource-allocation/policy
 */
import { join } from "node:path";
import { tryRead, writeFileDurable } from "./atomic.js";

export const POLICY_SCHEMA_VERSION = 1;
export const POLICY_FILE_NAME = "policy.json";
export const DEFAULT_POLICY_ID = "default";

export const POLICY_ALGORITHMS = Object.freeze(["static-priority", "weighted-fair-share", "earliest-deadline"]);
export const TIE_BREAKERS = Object.freeze(["fifo", "priority-then-fifo"]);
export const DENY_BACKGROUND_AT = Object.freeze(["ok", "warn", "critical"]);
export const INJECT_POLICY_MODES = Object.freeze(["transition-only", "periodic"]);
export const NOTIFY_TRANSITIONS = Object.freeze([
	"pressure",
	"queue-admitted",
	"queue-denied",
	"task-throttled",
	"task-paused",
	"task-resumed",
	"task-killed"
]);

const POLICY_KEYS = Object.freeze(["schemaVersion", "policyId", "scheduling", "admission", "quotas", "pressureActions", "communication"]);
const SCHEDULING_KEYS = Object.freeze(["algorithm", "tieBreaker", "preemption", "aging"]);
const PREEMPTION_KEYS = Object.freeze(["enabled", "graceMs", "checkpointBeforeKill"]);
const AGING_KEYS = Object.freeze(["enabled", "boostPerMinute", "maxWaitMs"]);
const ADMISSION_KEYS = Object.freeze(["queueLimit", "maxConcurrentAdmitted", "defaultRequest", "headroomReserve", "denyBackgroundAt"]);
const QUOTA_KEYS = Object.freeze(["projectId", "priority", "cpuMinCores", "cpuMaxCores", "memBudgetBytes", "tasksMax"]);
const PRESSURE_ACTION_KEYS = Object.freeze(["allowNewBackground", "allowNewForeground", "throttleElastic", "targetCpuFraction", "pausePreemptible", "killRunaways"]);
const COMMUNICATION_KEYS = Object.freeze(["notifyOnTransitions", "injectPolicy", "periodicRefreshMs"]);

function isFiniteNumber(value) {
	return typeof value === "number" && Number.isFinite(value);
}

function collectUnknownKeys(object, allowed, errors, where) {
	if (typeof object !== "object" || object === null || Array.isArray(object)) return;
	for (const key of Object.keys(object)) {
		if (!allowed.includes(key)) errors.push(`${where} has unknown key ${key}`);
	}
}

function validateRequest(request, errors, where) {
	if (typeof request !== "object" || request === null || Array.isArray(request)) {
		errors.push(`${where} must be an object`);
		return;
	}
	collectUnknownKeys(request, ["cpuCores", "memBytes"], errors, where);
	if (!isFiniteNumber(request.cpuCores) || request.cpuCores <= 0) errors.push(`${where}.cpuCores must be a number > 0`);
	if (!Number.isInteger(request.memBytes) || request.memBytes < 1) errors.push(`${where}.memBytes must be an integer >= 1`);
}

function validatePressureAction(action, errors, where) {
	if (typeof action !== "object" || action === null || Array.isArray(action)) {
		errors.push(`${where} must be an object`);
		return;
	}
	collectUnknownKeys(action, PRESSURE_ACTION_KEYS, errors, where);
	if (typeof action.allowNewBackground !== "boolean") errors.push(`${where}.allowNewBackground must be a boolean`);
	if (action.allowNewForeground !== undefined && typeof action.allowNewForeground !== "boolean") errors.push(`${where}.allowNewForeground must be a boolean`);
	if (typeof action.throttleElastic !== "boolean") errors.push(`${where}.throttleElastic must be a boolean`);
	if (action.targetCpuFraction !== undefined && (!isFiniteNumber(action.targetCpuFraction) || action.targetCpuFraction < 0 || action.targetCpuFraction > 1)) {
		errors.push(`${where}.targetCpuFraction must be a number 0..1`);
	}
	if (typeof action.pausePreemptible !== "boolean") errors.push(`${where}.pausePreemptible must be a boolean`);
	// Hard boundary: the scheduler never kills. A policy that asks for kills
	// contradicts the package's reason to exist — reject it loudly.
	if (action.killRunaways !== undefined && action.killRunaways !== false) {
		errors.push(`${where}.killRunaways must be false — kill belongs to hardware-guard, never to resource-allocation`);
	}
}

/**
 * Structural + semantic validation of a policy document, mirroring
 * schemas/policy.schema.json. A corrupt policy is surfaced, never silently
 * repaired: the planner refuses to make decisions without a valid policy.
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validatePolicyDoc(doc) {
	const errors = [];
	if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return { ok: false, errors: ["policy document is not an object"] };
	collectUnknownKeys(doc, POLICY_KEYS, errors, "policy document");
	if (doc.schemaVersion !== POLICY_SCHEMA_VERSION) errors.push(`policy schemaVersion must be ${POLICY_SCHEMA_VERSION} (got ${doc.schemaVersion})`);
	if (typeof doc.policyId !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(doc.policyId)) errors.push(`policyId invalid: ${doc.policyId}`);

	const scheduling = doc.scheduling;
	if (typeof scheduling !== "object" || scheduling === null || Array.isArray(scheduling)) {
		errors.push("policy scheduling must be an object");
	} else {
		collectUnknownKeys(scheduling, SCHEDULING_KEYS, errors, "scheduling");
		if (!POLICY_ALGORITHMS.includes(scheduling.algorithm)) errors.push(`scheduling.algorithm invalid: ${scheduling.algorithm}`);
		if (!TIE_BREAKERS.includes(scheduling.tieBreaker)) errors.push(`scheduling.tieBreaker invalid: ${scheduling.tieBreaker}`);
		const preemption = scheduling.preemption;
		if (typeof preemption !== "object" || preemption === null || Array.isArray(preemption)) errors.push("scheduling.preemption must be an object");
		else {
			collectUnknownKeys(preemption, PREEMPTION_KEYS, errors, "scheduling.preemption");
			if (typeof preemption.enabled !== "boolean") errors.push("scheduling.preemption.enabled must be a boolean");
			if (!Number.isInteger(preemption.graceMs) || preemption.graceMs < 0) errors.push(`scheduling.preemption.graceMs invalid: ${preemption.graceMs}`);
			if (typeof preemption.checkpointBeforeKill !== "boolean") errors.push("scheduling.preemption.checkpointBeforeKill must be a boolean");
		}
		const aging = scheduling.aging;
		if (typeof aging !== "object" || aging === null || Array.isArray(aging)) errors.push("scheduling.aging must be an object");
		else {
			collectUnknownKeys(aging, AGING_KEYS, errors, "scheduling.aging");
			if (typeof aging.enabled !== "boolean") errors.push("scheduling.aging.enabled must be a boolean");
			if (!Number.isInteger(aging.boostPerMinute) || aging.boostPerMinute < 0 || aging.boostPerMinute > 100) errors.push(`scheduling.aging.boostPerMinute invalid: ${aging.boostPerMinute}`);
			if (aging.maxWaitMs !== undefined && aging.maxWaitMs !== null && (!Number.isInteger(aging.maxWaitMs) || aging.maxWaitMs < 0)) {
				errors.push(`scheduling.aging.maxWaitMs must be an integer >= 0 or null`);
			}
		}
	}

	const admission = doc.admission;
	if (typeof admission !== "object" || admission === null || Array.isArray(admission)) {
		errors.push("policy admission must be an object");
	} else {
		collectUnknownKeys(admission, ADMISSION_KEYS, errors, "admission");
		if (!Number.isInteger(admission.queueLimit) || admission.queueLimit < 1) errors.push(`admission.queueLimit invalid: ${admission.queueLimit}`);
		if (!Number.isInteger(admission.maxConcurrentAdmitted) || admission.maxConcurrentAdmitted < 1) errors.push(`admission.maxConcurrentAdmitted invalid: ${admission.maxConcurrentAdmitted}`);
		validateRequest(admission.defaultRequest, errors, "admission.defaultRequest");
		validateRequest(admission.headroomReserve, errors, "admission.headroomReserve");
		if (!DENY_BACKGROUND_AT.includes(admission.denyBackgroundAt)) errors.push(`admission.denyBackgroundAt invalid: ${admission.denyBackgroundAt}`);
	}

	if (!Array.isArray(doc.quotas)) errors.push("policy quotas must be an array");
	else {
		const seen = new Set();
		for (const quota of doc.quotas) {
			if (typeof quota !== "object" || quota === null || Array.isArray(quota)) {
				errors.push("policy quota entry must be an object");
				continue;
			}
			collectUnknownKeys(quota, QUOTA_KEYS, errors, `quota ${quota.projectId ?? "?"}`);
			if (typeof quota.projectId !== "string" || quota.projectId.length === 0) errors.push("quota projectId must be a non-empty string");
			else if (seen.has(quota.projectId)) errors.push(`duplicate quota projectId: ${quota.projectId}`);
			else seen.add(quota.projectId);
			if (!Number.isInteger(quota.priority) || quota.priority < 0 || quota.priority > 100) errors.push(`quota ${quota.projectId ?? "?"} priority invalid: ${quota.priority}`);
			if (!isFiniteNumber(quota.cpuMinCores) || quota.cpuMinCores < 0) errors.push(`quota ${quota.projectId ?? "?"} cpuMinCores invalid: ${quota.cpuMinCores}`);
			if (!isFiniteNumber(quota.cpuMaxCores) || quota.cpuMaxCores <= 0) errors.push(`quota ${quota.projectId ?? "?"} cpuMaxCores invalid: ${quota.cpuMaxCores}`);
			if (!Number.isInteger(quota.memBudgetBytes) || quota.memBudgetBytes < 1) errors.push(`quota ${quota.projectId ?? "?"} memBudgetBytes invalid: ${quota.memBudgetBytes}`);
			if (!Number.isInteger(quota.tasksMax) || quota.tasksMax < 1) errors.push(`quota ${quota.projectId ?? "?"} tasksMax invalid: ${quota.tasksMax}`);
			if (isFiniteNumber(quota.cpuMinCores) && isFiniteNumber(quota.cpuMaxCores) && quota.cpuMinCores > quota.cpuMaxCores + 1e-9) {
				errors.push(`quota ${quota.projectId ?? "?"} cpuMinCores (${quota.cpuMinCores}) exceeds cpuMaxCores (${quota.cpuMaxCores})`);
			}
		}
	}

	const pressureActions = doc.pressureActions;
	if (typeof pressureActions !== "object" || pressureActions === null || Array.isArray(pressureActions)) {
		errors.push("policy pressureActions must be an object");
	} else {
		collectUnknownKeys(pressureActions, ["ok", "warn", "critical"], errors, "pressureActions");
		for (const state of ["ok", "warn", "critical"]) {
			validatePressureAction(pressureActions[state], errors, `pressureActions.${state}`);
		}
	}

	const communication = doc.communication;
	if (typeof communication !== "object" || communication === null || Array.isArray(communication)) {
		errors.push("policy communication must be an object");
	} else {
		collectUnknownKeys(communication, COMMUNICATION_KEYS, errors, "communication");
		if (!Array.isArray(communication.notifyOnTransitions)) errors.push("communication.notifyOnTransitions must be an array");
		else {
			const seen = new Set();
			for (const entry of communication.notifyOnTransitions) {
				if (!NOTIFY_TRANSITIONS.includes(entry)) errors.push(`communication.notifyOnTransitions has invalid entry: ${entry}`);
				if (seen.has(entry)) errors.push(`communication.notifyOnTransitions has duplicate entry: ${entry}`);
				seen.add(entry);
			}
		}
		if (!INJECT_POLICY_MODES.includes(communication.injectPolicy)) errors.push(`communication.injectPolicy invalid: ${communication.injectPolicy}`);
		if (communication.periodicRefreshMs !== undefined && (!Number.isInteger(communication.periodicRefreshMs) || communication.periodicRefreshMs < 1000)) {
			errors.push(`communication.periodicRefreshMs must be an integer >= 1000`);
		}
	}
	return { ok: errors.length === 0, errors };
}

const GIB = 1 << 30;

/**
 * The default v0.1 policy. Merge `overrides` (top-level keys; `quotas` is
 * replaced wholesale) for fixtures and machine-specific policies.
 */
export function buildDefaultPolicy({ policyId = DEFAULT_POLICY_ID, overrides = null } = {}) {
	const base = {
		schemaVersion: POLICY_SCHEMA_VERSION,
		policyId,
		scheduling: {
			algorithm: "static-priority",
			tieBreaker: "priority-then-fifo",
			preemption: { enabled: true, graceMs: 10000, checkpointBeforeKill: true },
			aging: { enabled: true, boostPerMinute: 2, maxWaitMs: null }
		},
		admission: {
			queueLimit: 32,
			maxConcurrentAdmitted: 3,
			defaultRequest: { cpuCores: 1, memBytes: GIB },
			headroomReserve: { cpuCores: 1, memBytes: 2 * GIB },
			denyBackgroundAt: "warn"
		},
		quotas: [],
		pressureActions: {
			ok: { allowNewBackground: true, allowNewForeground: true, throttleElastic: false, pausePreemptible: false, targetCpuFraction: 1 },
			warn: { allowNewBackground: false, allowNewForeground: true, throttleElastic: true, pausePreemptible: false, targetCpuFraction: 0.5 },
			critical: { allowNewBackground: false, allowNewForeground: false, throttleElastic: true, pausePreemptible: true, targetCpuFraction: 0.25, killRunaways: false }
		},
		communication: {
			notifyOnTransitions: ["pressure", "queue-admitted", "queue-denied", "task-throttled", "task-paused", "task-resumed"],
			injectPolicy: "transition-only"
		}
	};
	if (overrides !== null && typeof overrides === "object") {
		return { ...base, ...overrides };
	}
	return base;
}

/**
 * The persisted policy store. `load()` creates the default policy durably
 * when the file is missing; a corrupt file is surfaced as an error and the
 * planner refuses to make decisions (never silently repaired).
 */
export class PolicyStore {
	constructor({ dir, now = () => Date.now(), defaults = null } = {}) {
		this.dir = dir;
		this.path = join(dir, POLICY_FILE_NAME);
		this.now = now;
		this.defaults = defaults ?? buildDefaultPolicy();
	}

	/** Load (creating the default when missing); corrupt files stay corrupt. */
	load() {
		const text = tryRead(this.path);
		if (text === null) {
			const doc = JSON.parse(JSON.stringify(this.defaults));
			try {
				writeFileDurable(this.path, JSON.stringify(doc, null, 2));
			} catch (error) {
				return { doc, path: this.path, error: `cannot create policy: ${String(error?.message ?? error)}` };
			}
			return { doc, path: this.path };
		}
		let parsed = null;
		try {
			parsed = JSON.parse(text);
		} catch {
			return { doc: null, path: this.path, error: `policy ${this.path} is not valid JSON` };
		}
		const check = validatePolicyDoc(parsed);
		if (!check.ok) return { doc: null, path: this.path, error: `policy ${this.path} is corrupt: ${check.errors.join("; ")}` };
		return { doc: parsed, path: this.path };
	}

	/** The current policy document, or null when missing/corrupt. */
	get() {
		const loaded = this.load();
		return loaded.doc === null ? null : JSON.parse(JSON.stringify(loaded.doc));
	}

	/**
	 * Atomically replace the policy document (no CAS — the schema has no
	 * revision field; policy updates are operator edits in v0.1). Validate
	 * before writing.
	 */
	save(doc) {
		const check = validatePolicyDoc(doc);
		if (!check.ok) return { ok: false, code: "invalid", errors: check.errors };
		try {
			writeFileDurable(this.path, JSON.stringify(doc, null, 2));
		} catch (error) {
			return { ok: false, code: "io", errors: [String(error?.message ?? error)] };
		}
		return { ok: true };
	}
}
