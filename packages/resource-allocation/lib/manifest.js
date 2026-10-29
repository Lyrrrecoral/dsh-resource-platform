/**
 * Project manifest handling: structural validation against
 * schemas/project-manifest.schema.json and the interest-token projection
 * used by orphan discovery.
 *
 * The manifest is the per-project fact source (ops-generalization §1): it
 * declares the project, the desired tasks, and the external owners adopted
 * in observe mode. Validation here mirrors the JSON-Schema constraints
 * without a runtime JSON-Schema dependency; the schema file stays the
 * portable contract.
 *
 * @module resource-allocation/manifest
 */
import { basename } from "node:path";

/** Project id shape: schemas/project-manifest.schema.json project.id. */
export const PROJECT_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Task id shape: schemas/project-manifest.schema.json definitions.task.id. */
export const TASK_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export const ADOPT_KINDS = Object.freeze(["systemd-unit", "cgroup", "pidfile"]);
export const ADOPT_MODES = Object.freeze(["observe", "managed", "retired"]);
export const TASK_KINDS = Object.freeze(["service", "compute-batch", "agent", "manual"]);
export const RUN_SOURCES = Object.freeze(["systemd", "script", "manual"]);

/** Error-free number check that also rejects NaN/Infinity. */
function isFiniteNumber(value) {
	return typeof value === "number" && Number.isFinite(value);
}

function isNonEmptyString(value) {
	return typeof value === "string" && value.length > 0;
}

/** Validate one adopt entry (name + mode required, kind/adoptedAt optional). */
function validateAdopt(entry, errors) {
	if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
		errors.push("adopt entry must be an object");
		return;
	}
	for (const key of Object.keys(entry)) {
		if (!["name", "kind", "mode", "adoptedAt"].includes(key)) {
			errors.push(`adopt entry has unknown key ${key}`);
		}
	}
	if (!isNonEmptyString(entry.name)) errors.push("adopt entry name must be a non-empty string");
	if (entry.kind !== undefined && !ADOPT_KINDS.includes(entry.kind)) errors.push(`adopt entry kind invalid: ${entry.kind}`);
	if (!ADOPT_MODES.includes(entry.mode)) errors.push(`adopt entry mode invalid: ${entry.mode}`);
	if (entry.adoptedAt !== undefined && (!Number.isInteger(entry.adoptedAt) || entry.adoptedAt < 0)) errors.push(`adopt entry adoptedAt invalid: ${entry.adoptedAt}`);
}

/** Validate a run section (source required). */
function validateRun(run, errors) {
	if (typeof run !== "object" || run === null || Array.isArray(run)) {
		errors.push("task run must be an object");
		return;
	}
	for (const key of Object.keys(run)) {
		if (!["source", "systemdUnit", "workingDirectory", "command", "env", "checkpointPath", "logPath", "restart", "maxRestartsPerHour", "graceSeconds"].includes(key)) {
			errors.push(`task run has unknown key ${key}`);
		}
	}
	if (!RUN_SOURCES.includes(run.source)) errors.push(`task run.source invalid: ${run.source}`);
	if (run.systemdUnit !== undefined && !isNonEmptyString(run.systemdUnit)) errors.push("task run.systemdUnit must be a non-empty string");
	if (run.workingDirectory !== undefined && !isNonEmptyString(run.workingDirectory)) errors.push("task run.workingDirectory must be a non-empty string");
	if (run.command !== undefined) {
		if (!Array.isArray(run.command) || run.command.some((part) => typeof part !== "string")) {
			errors.push("task run.command must be an array of strings");
		}
	}
	if (run.restart !== undefined && !["checkpoint", "restart", "once", "manual"].includes(run.restart)) errors.push(`task run.restart invalid: ${run.restart}`);
	if (run.maxRestartsPerHour !== undefined && (!Number.isInteger(run.maxRestartsPerHour) || run.maxRestartsPerHour < 0)) errors.push(`task run.maxRestartsPerHour invalid: ${run.maxRestartsPerHour}`);
	if (run.graceSeconds !== undefined && (!Number.isInteger(run.graceSeconds) || run.graceSeconds < 0)) errors.push(`task run.graceSeconds invalid: ${run.graceSeconds}`);
}

/** Validate a resource request (cpuCores + memBytes required). */
function validateRequest(request, errors, where) {
	if (typeof request !== "object" || request === null || Array.isArray(request)) {
		errors.push(`${where} must be an object`);
		return;
	}
	if (!isFiniteNumber(request.cpuCores) || request.cpuCores <= 0) errors.push(`${where}.cpuCores must be a positive number`);
	if (!Number.isInteger(request.memBytes) || request.memBytes < 1) errors.push(`${where}.memBytes must be a positive integer`);
}

/** Validate one task. */
function validateTask(task, errors) {
	if (typeof task !== "object" || task === null || Array.isArray(task)) {
		errors.push("task must be an object");
		return;
	}
	for (const key of Object.keys(task)) {
		if (!["id", "kind", "enabled", "priority", "preemptible", "checkpoint", "deadlineMs", "request", "limits", "run"].includes(key)) {
			errors.push(`task ${task.id ?? "?"} has unknown key ${key}`);
		}
	}
	if (typeof task.id !== "string" || !TASK_ID_RE.test(task.id)) errors.push(`task id invalid: ${task.id}`);
	if (!TASK_KINDS.includes(task.kind)) errors.push(`task ${task.id ?? "?"} kind invalid: ${task.kind}`);
	if (typeof task.enabled !== "boolean") errors.push(`task ${task.id ?? "?"} enabled must be a boolean`);
	if (!Number.isInteger(task.priority) || task.priority < 0 || task.priority > 100) errors.push(`task ${task.id ?? "?"} priority invalid: ${task.priority}`);
	if (task.preemptible !== undefined && typeof task.preemptible !== "boolean") errors.push(`task ${task.id ?? "?"} preemptible must be a boolean`);
	if (task.checkpoint !== undefined && typeof task.checkpoint !== "boolean") errors.push(`task ${task.id ?? "?"} checkpoint must be a boolean`);
	if (task.deadlineMs !== undefined && task.deadlineMs !== null && (!Number.isInteger(task.deadlineMs) || task.deadlineMs < 0)) errors.push(`task ${task.id ?? "?"} deadlineMs invalid: ${task.deadlineMs}`);
	if (task.request !== undefined) validateRequest(task.request, errors, `task ${task.id ?? "?"} request`);
	if (task.limits !== undefined) {
		const limits = task.limits;
		if (typeof limits !== "object" || limits === null || Array.isArray(limits)) errors.push(`task ${task.id ?? "?"} limits must be an object`);
		else {
			for (const key of ["cpuMaxCores", "memoryMaxBytes", "tasksMax"]) {
				if (!isFiniteNumber(limits[key]) || limits[key] <= 0) errors.push(`task ${task.id ?? "?"} limits.${key} invalid: ${limits[key]}`);
			}
			if (limits.cpuMinCores !== undefined && (!isFiniteNumber(limits.cpuMinCores) || limits.cpuMinCores < 0)) errors.push(`task ${task.id ?? "?"} limits.cpuMinCores invalid: ${limits.cpuMinCores}`);
			if (limits.memoryHighBytes !== undefined && (!Number.isInteger(limits.memoryHighBytes) || limits.memoryHighBytes < 1)) errors.push(`task ${task.id ?? "?"} limits.memoryHighBytes invalid: ${limits.memoryHighBytes}`);
		}
	}
	if (task.run === undefined) {
		errors.push(`task ${task.id ?? "?"} run section missing`);
	} else {
		validateRun(task.run, errors);
	}
}

/**
 * Structural validation of a project manifest document against the
 * constraints of schemas/project-manifest.schema.json (no runtime
 * JSON-Schema dependency).
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateManifest(doc) {
	const errors = [];
	if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
		return { ok: false, errors: ["manifest document is not an object"] };
	}
	for (const key of Object.keys(doc)) {
		if (!["schemaVersion", "project", "adopt", "tasks", "metadata"].includes(key)) {
			errors.push(`manifest has unknown top-level key ${key}`);
		}
	}
	if (doc.schemaVersion !== 1) errors.push(`schemaVersion must be 1 (got ${doc.schemaVersion})`);
	const project = doc.project;
	if (typeof project !== "object" || project === null || Array.isArray(project)) errors.push("project section missing");
	else {
		if (typeof project.id !== "string" || !PROJECT_ID_RE.test(project.id)) errors.push(`project.id invalid: ${project.id}`);
		if (!isNonEmptyString(project.name)) errors.push("project.name must be a non-empty string");
		if (project.description !== undefined && typeof project.description !== "string") errors.push("project.description must be a string");
	}
	if (doc.adopt !== undefined) {
		if (!Array.isArray(doc.adopt)) errors.push("adopt must be an array");
		else doc.adopt.forEach((entry) => validateAdopt(entry, errors));
	}
	if (!Array.isArray(doc.tasks)) errors.push("tasks must be an array");
	else {
		const seen = new Set();
		for (const task of doc.tasks) {
			validateTask(task, errors);
			if (task !== null && typeof task === "object" && typeof task.id === "string") {
				if (seen.has(task.id)) errors.push(`duplicate task id: ${task.id}`);
				seen.add(task.id);
			}
		}
	}
	if (doc.metadata !== undefined && (typeof doc.metadata !== "object" || doc.metadata === null || Array.isArray(doc.metadata))) {
		errors.push("metadata must be an object");
	}
	return { ok: errors.length === 0, errors };
}

/**
 * Interest tokens used by orphan discovery: the basename of every task's
 * run.command[0] plus any manifest.metadata.orphanInterest strings.
 *
 * Matching is argv-element-basename equality, never substring search: a
 * shell script whose TEXT merely mentions a token does not match, which
 * keeps observer tooling (grep loops etc.) out of the orphan list.
 *
 * @returns {string[]} lowercased, deduplicated tokens
 */
export function taskInterestTokens(manifest) {
	const tokens = new Set();
	for (const task of manifest?.tasks ?? []) {
		const command = task?.run?.command;
		if (Array.isArray(command) && command.length > 0 && typeof command[0] === "string") {
			const base = basename(command[0]).toLowerCase();
			if (base.length > 0) tokens.add(base);
		}
	}
	const extra = manifest?.metadata?.orphanInterest;
	if (Array.isArray(extra)) {
		for (const token of extra) {
			if (typeof token === "string" && token.length > 0) tokens.add(token.toLowerCase());
		}
	}
	return [...tokens];
}

/** Every systemd unit the manifest references (tasks' run.systemdUnit). */
export function manifestUnitNames(manifest) {
	const names = new Set();
	for (const task of manifest?.tasks ?? []) {
		if (typeof task?.run?.systemdUnit === "string" && task.run.systemdUnit.length > 0) {
			names.add(task.run.systemdUnit);
		}
	}
	return [...names];
}
