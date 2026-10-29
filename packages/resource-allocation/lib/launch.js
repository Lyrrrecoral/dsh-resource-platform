/**
 * resource-allocation run lifecycle orchestration: launch, reconcile and stop for the
 * long tasks created by the `resource_run` tool.
 *
 * Every task runs as its own systemd transient unit
 * (`resource-allocation-<project>-<runId>.service`, `systemd-run --collect`), so a
 * `dsh-web.service` restart can never take it down — the root cause of the
 * "dsh 长程任务经常卡死" incidents (solve49-cadical / solve-n-cadical).
 *
 * The run record in `storages/resource-allocation/runs.json` is the durable identity; systemd
 * facts are read from it (`systemctl show`), pids are facts read from the
 * registry — never returned as launch output. `--collect` unloads the unit on
 * completion, so exit codes are recovered from the journal after the unit
 * vanishes.
 *
 * v0.1 boundary preserved: launch/stop mutations apply ONLY to units this
 * package created; adopted project units stay observe-only forever.
 *
 * @module resource-allocation/launch
 */
import { deriveLimits, isValidRunUnitName, makeRunId, RUN_TERMINAL_STATUSES, runUnitName } from "./runs.js";
import { buildSystemdRun, launchSystemdRun, queryRunUnit, readRunJournal, runUnitNameSafe, stopRunUnit, systemdAvailable } from "./systemd.js";

/** Default systemd adapters (tests inject fakes). */
export const defaultRunSystemd = Object.freeze({
	launch: (invocation) => launchSystemdRun(invocation),
	queryUnit: (unit) => queryRunUnit(unit),
	stop: (unit) => stopRunUnit(unit),
	available: () => systemdAvailability(),
	journal: (unit) => readRunJournal(unit)
});

/** Merge a partial adapter over the defaults so callers (the page row) may
 * inject only the methods they can fake. */
export function mergeRunSystemd(systemd = {}) {
	return { ...defaultRunSystemd, ...systemd };
}

/** Default availability probe used by launchRun (overridable in tests). */
export function systemdAvailability() {
	return systemdAvailable();
}

/** The exit code recorded for a SIGTERM-killed run when the journal has no evidence. */
export const STOP_EXIT_CODE_FALLBACK = 143; // 128 + SIGTERM

function validateCommand(command) {
	if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== "string" || part.length === 0)) {
		return { ok: false, error: "command must be a non-empty array of non-empty strings" };
	}
	// systemd-run parses options until the executable token. Reject an argv
	// whose first token starts with "-": otherwise `--unit=…` or
	// `--property=…` could make systemd-run act on a unit/property other than
	// the record this package owns and later reconciles/stops.
	if (command[0].startsWith("-")) {
		return { ok: false, error: "command[0] must be an executable name/path, not a systemd-run option" };
	}
	return { ok: true };
}

/** Turn a free-form project/label into a unit-safe lowercase slug. */
export function normalizeRunLabel(value, fallback = "session") {
	const text = typeof value === "string" ? value.trim().toLowerCase() : "";
	const slug = text.replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
	return slug.length > 0 ? slug : fallback;
}

/**
 * Launch one long task:
 *  1. resolve project + task from the registry, derive limits;
 *  2. persist the run record (status queued, CAS);
 *  3. create the transient unit via systemd-run;
 *  4. walk queued → launching → running, reading pid back from systemd into
 *     the registry (pid is a registry fact, not a return value).
 *
 * @param {object} options
 *  - projects: ProjectRegistry instance
 *  - runs: RunRegistry instance
 *  - projectId, taskId, command, owner
 *  - limitsOverrides: {cpuMaxCores?, memoryMaxBytes?, tasksMax?}
 *  - workingDirectory: string|null
 *  - env: object|null
 *  - systemd: adapter (defaultRunSystemd)
 *  - now: () => number
 * @returns {Promise<{ok: true, runId, unit, status} | {ok: false, code, runId?, error}>}
 */
export async function launchRun({ projects = null, runs, projectId = null, taskId = null, command, owner, limitsOverrides = {}, workingDirectory = null, env = null, allowUnregistered = false, systemd = defaultRunSystemd, now = () => Date.now() }) {
	const commandCheck = validateCommand(command);
	if (!commandCheck.ok) return { ok: false, code: "invalid-command", error: commandCheck.error };
	// Fail BEFORE creating a run record on a host without systemd: an
	// "unsupported" run is not a queued task, and leaving a phantom record
	// behind would make the registry lie.
	if (typeof systemd.available === "function" && systemd.available() !== true) {
		return { ok: false, code: "unsupported", error: `resource_run needs systemd transient units, but systemd is not available on this host (${"/run/systemd/system"} is missing). Run the command as a normal (background) job instead.` };
	}
	const recordProjectId = normalizeRunLabel(projectId);
	const recordTaskId = typeof taskId === "string" && taskId.trim().length > 0 ? taskId.trim() : "task";
	let entry = null;
	if (projects !== null && projects !== undefined) {
		const loaded = projects.load();
		if (loaded.doc === null) return { ok: false, code: "corrupt", error: loaded.error };
		entry = loaded.doc.projects.find((item) => item.id === recordProjectId) ?? null;
	}
	if (entry === null && allowUnregistered !== true) return { ok: false, code: "no-project", error: `project ${recordProjectId} is not registered` };
	const task = entry === null ? null : (entry.manifest.tasks ?? []).find((item) => item.id === recordTaskId) ?? null;
	if (task === null && entry !== null && allowUnregistered !== true) return { ok: false, code: "no-task", error: `project ${recordProjectId} has no task ${recordTaskId}` };
	if (task?.enabled === false) return { ok: false, code: "task-disabled", error: `task ${recordProjectId}/${recordTaskId} is disabled` };

	const limits = deriveLimits(task, limitsOverrides);
	// workingDirectory / env default from the task manifest's run section;
	// explicit launch options win over the manifest.
	const manifestRun = task?.run ?? {};
	const effectiveWorkingDirectory = workingDirectory ?? (typeof manifestRun.workingDirectory === "string" && manifestRun.workingDirectory.length > 0 ? manifestRun.workingDirectory : null);
	const effectiveEnv = env ?? (typeof manifestRun.env === "object" && manifestRun.env !== null && !Array.isArray(manifestRun.env) ? manifestRun.env : {});
	const runId = makeRunId(now());
	const unit = runUnitNameSafe(recordProjectId, runId);
	const record = {
		id: runId,
		projectId: recordProjectId,
		taskId: recordTaskId,
		owner,
		command: [...command],
		limits,
		unit,
		pid: null,
		status: "queued",
		startedAt: now(),
		finishedAt: null,
		exitCode: null,
		reason: null
	};

	// CAS create with retry: another launch may have moved the revision.
	let created = runs.create(record, { expectedRevision: runs.load().doc?.revision ?? 0 });
	for (let attempt = 0; created.ok === false && created.code === "conflict" && attempt < 3; attempt++) {
		created = runs.create(record, { expectedRevision: runs.load().doc?.revision ?? 0 });
	}
	if (!created.ok) return { ok: false, code: created.code, runId, error: created.errors?.[0] ?? created.code };

	const invocation = buildSystemdRun({ projectId: recordProjectId, runId, limits, workingDirectory: effectiveWorkingDirectory, env: effectiveEnv, command });
	const launched = await systemd.launch(invocation);
	if (!launched.ok) {
		runs.update(runId, { status: "failed", finishedAt: now(), reason: `systemd-run failed: ${launched.error}${launched.stderr ? ` (${launched.stderr.trim()})` : ""}` });
		return { ok: false, code: "launch-failed", runId, error: `systemd-run failed: ${launched.error}` };
	}

	runs.update(runId, { status: "launching" });

	// Read the pid back from systemd into the registry immediately.
	const factsResult = systemd.queryUnit(unit);
	if (factsResult.ok && factsResult.facts.exists === true && factsResult.facts.mainPid !== null) {
		runs.update(runId, { status: "running", pid: factsResult.facts.mainPid });
		return { ok: true, runId, unit, status: "running" };
	}
	// The unit may already be gone (an instantly-finishing command): let the
	// reconciler settle the terminal state from the journal.
	await reconcileRun({ runs, runId, systemd, now });
	const after = runs.get(runId);
	return { ok: true, runId, unit, status: after?.status ?? "launching" };
}

/**
 * Reconcile one run against live systemd facts:
 *  - launching/running + live pid → persist pid, promote to running;
 *  - unit vanished (--collect) → recover exit evidence from the journal and
 *    settle completed | failed.
 * Terminal runs are skipped; unknown states are left alone.
 *
 * @returns {Promise<{runId, skipped?: boolean, from?, to?, exitCode?} | {runId, error}>}
 */
export async function reconcileRun({ runs, runId, systemd = {}, now = () => Date.now() }) {
	const sd = mergeRunSystemd(systemd);
	const run = runs.get(runId);
	if (run === null) return { runId, error: "run not found" };
	if (RUN_TERMINAL_STATUSES.includes(run.status)) return { runId, skipped: true };
	if (run.status === "queued") return { runId, skipped: true };

	const factsResult = sd.queryUnit(run.unit);
	const exists = factsResult.ok === true && factsResult.facts.exists === true;
	const alive = exists && factsResult.facts.mainPid !== null;
	if (alive) {
		const pid = factsResult.facts.mainPid;
		if (run.status === "launching" || run.pid !== pid) {
			runs.update(runId, { status: "running", pid });
			return { runId, from: run.status, to: "running", exitCode: null };
		}
		return { runId, skipped: true };
	}
	// The unit exists but has no main pid yet (activating between start and
	// exec): leave it alone — the next sweep settles it. Only a truly
	// vanished unit (--collect unloaded it) goes to the journal path.
	if (exists) return { runId, skipped: true };

	// The unit is gone: `--collect` unloaded it (or it never reached running).
	const journal = await sd.journal(run.unit);
	const evidence = journal.ok ? journal.evidence : null;
	let exitCode = null;
	let status = "failed";
	let reason = null;
	if (evidence !== null) {
		if (evidence.exited === true && evidence.exitCode !== null) {
			exitCode = evidence.exitCode;
		} else if (evidence.exited === true && evidence.signal !== null) {
			exitCode = 128 + evidence.signal;
		} else if (evidence.succeeded === true) {
			exitCode = 0;
		}
		if (exitCode !== null) status = exitCode === 0 ? "completed" : "failed";
		else reason = evidence.failed ? `unit failed: ${evidence.result ?? "unknown"}` : "unit vanished without exit evidence";
	} else {
		reason = `unit vanished and journal is unavailable: ${journal.error}`;
	}
	const updated = runs.update(runId, { status, exitCode, finishedAt: now(), reason });
	if (!updated.ok) return { runId, error: updated.errors?.[0] ?? updated.code };
	return { runId, from: run.status, to: status, exitCode };
}

/**
 * Reconcile every active run. The periodic sweep (and the resource_status /
 * /resources/projects handlers) call this so transitions are persisted while they
 * happen, not just on demand.
 * @returns {Promise<{reconciled: number, transitions: Array, errors: string[]}>}
 */
export async function reconcileRuns({ runs, systemd = {}, now = () => Date.now() } = {}) {
	const summary = { reconciled: 0, transitions: [], errors: [] };
	for (const run of runs.list()) {
		if (RUN_TERMINAL_STATUSES.includes(run.status) || run.status === "queued") continue;
		summary.reconciled += 1;
		try {
			const result = await reconcileRun({ runs, runId: run.id, systemd, now });
			if (result.error !== undefined) summary.errors.push(result.error);
			else if (result.skipped !== true) summary.transitions.push(result);
		} catch (error) {
			summary.errors.push(`run ${run.id}: ${String(error?.message ?? error)}`);
		}
	}
	return summary;
}

/**
 * Stop one run owned by the caller. Permission is owner-session equality:
 * a caller may only stop runs whose owner.sessionId matches its own session —
 * never another session's or another project's process. The stop targets the
 * run's own transient unit via `systemctl stop`; nothing else is touched.
 *
 * @param {object} options - {runs, runId, callerSessionId, systemd, now}
 * @returns {Promise<{ok: true, runId, status, exitCode} | {ok: false, code, runId?, status?, error}>}
 */
export async function stopRun({ runs, runId, callerSessionId, allowOperator = false, systemd = defaultRunSystemd, now = () => Date.now() }) {
	const run = runs.get(runId);
	if (run === null) return { ok: false, code: "not-found", runId, error: `run ${runId} does not exist` };
	if (RUN_TERMINAL_STATUSES.includes(run.status)) {
		return { ok: true, code: "already-terminal", runId, status: run.status, exitCode: run.exitCode };
	}
	// Fail closed on missing identity. In particular, never let
	// `undefined === undefined` satisfy the owner check for a malformed record.
	const ownerSessionId = run.owner?.sessionId;
	if (allowOperator !== true && (typeof callerSessionId !== "string" || callerSessionId.length === 0
		|| typeof ownerSessionId !== "string" || ownerSessionId.length === 0
		|| ownerSessionId !== callerSessionId)) {
		return {
			ok: false,
			code: "forbidden",
			runId,
			status: run.status,
			error: `run ${runId} is owned by session ${ownerSessionId ?? "unknown"}; caller session ${callerSessionId ?? "unknown"} may not stop it`
		};
	}
	if (run.status === "queued") {
		return { ok: false, code: "not-started", runId, status: run.status, error: `run ${runId} is queued and has no unit to stop yet` };
	}
	// The registry is a fact source, but a corrupted/hand-edited unit name must
	// never turn this owner-gated stop into arbitrary `systemctl stop`. Require
	// the exact canonical unit for this run, or the exact pre-v1.0 legacy unit;
	// a shared prefix alone is not enough.
	const expectedUnits = [
		runUnitName(run.projectId, run.id),
		`dsh-ops-${run.projectId}-${run.id}.service`
	];
	if (!isValidRunUnitName(run.unit) || !expectedUnits.includes(run.unit)) {
		return {
			ok: false,
			code: "invalid-unit",
			runId,
			status: run.status,
			error: `run ${runId} has a unit outside the exact managed namespace for this run: ${run.unit}`
		};
	}
	const stopped = await systemd.stop(run.unit);
	if (!stopped.ok) {
		return { ok: false, code: "stop-failed", runId, status: run.status, error: `systemctl stop ${run.unit} failed: ${stopped.error}` };
	}
	// Recover the exit evidence; a SIGTERM kill is the expected outcome.
	const journal = await systemd.journal(run.unit);
	const evidence = journal.ok ? journal.evidence : null;
	let exitCode = STOP_EXIT_CODE_FALLBACK;
	if (evidence?.exited === true && evidence.exitCode !== null) exitCode = evidence.exitCode;
	else if (evidence?.exited === true && evidence.signal !== null) exitCode = 128 + evidence.signal;
	const updated = runs.update(runId, {
		status: "stopped",
		exitCode,
		finishedAt: now(),
		reason: allowOperator === true
			? `stopped by Resources operator (owner session ${ownerSessionId ?? "unknown"})`
			: `stopped by resource_stop (caller session ${callerSessionId ?? "unknown"})`
	});
	if (!updated.ok) return { ok: false, code: updated.code, runId, error: updated.errors?.[0] ?? updated.code };
	return { ok: true, runId, status: "stopped", exitCode };
}
