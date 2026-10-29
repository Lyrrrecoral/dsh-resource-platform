/**
 * The model-facing resource-allocation run tools: resource_run / resource_status / resource_stop.
 *
 *  - resource_run    launches a long task as its own systemd transient unit
 *               (`systemd-run --collect`, never a bare `nohup &`); returns
 *               the runId (the pid is a registry fact, read via resource_status).
 *  - resource_status read-only run list + live reconciliation (all runs visible).
 *  - resource_stop   minimal control: stops ONLY runs whose owner session matches
 *               the calling agent's session. Killing another session's or
 *               another project's process is refused before any systemctl
 *               invocation happens.
 *
 * Every definition goes through the real `defineTool` compiler at plugin
 * apply time; the schema shapes are covered by test/tool.test.js and the
 * 3081 boot smoke so a compile regression fails before boot (the hardware-guard
 * v0.2.0 lesson).
 *
 * @module resource-allocation/tool
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { launchRun, reconcileRuns, stopRun } from "./launch.js";

/** Resolve the calling session id from a ToolRunContext; null outside an agent. */
export function callerSessionId(exec) {
	const id = exec?.agent?.id;
	return typeof id === "string" && id.length > 0 ? id : null;
}

/** Render a run list into the text output shared by resource_status (and reusable). */
export function renderRunsText(runs, { header = "[resource-allocation runs]", limit = 500 } = {}) {
	if (runs.length === 0) return `${header}\nno runs recorded`;
	const lines = [header];
	const shown = runs.slice(0, limit);
	for (const run of shown) {
		const duration = runDurationText(run);
		const owner = ownerText(run);
		lines.push([
			`- ${run.id}`,
			`${run.projectId}/${run.taskId}`,
			`owner=${owner}`,
			`unit=${run.unit}`,
			`status=${run.status}`,
			run.pid !== null ? `pid=${run.pid}` : null,
			run.exitCode !== null ? `exitCode=${run.exitCode}` : null,
			`startedAt=${formatIsoTimestamp(run.startedAt)}`,
			run.finishedAt !== null ? `finishedAt=${formatIsoTimestamp(run.finishedAt)}` : null,
			duration !== null ? `duration=${duration}` : null,
			run.reason !== null ? `reason=${run.reason}` : null
		].filter((part) => part !== null).join(" "));
	}
	if (shown.length < runs.length) lines.push(`… ${runs.length - shown.length} more run(s) omitted (display limit ${limit})`);
	return lines.join("\n");
}

function formatIsoTimestamp(value) {
if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "?";
const date = new Date(value);
return Number.isFinite(date.getTime()) ? date.toISOString() : "?";
}

/** Human duration for a run (elapsed while active, total when finished). */
export function runDurationText(run) {
	const end = run.finishedAt ?? Date.now();
	const ms = end - run.startedAt;
	if (!Number.isFinite(ms) || ms < 0) return null;
	const total = Math.floor(ms / 1000);
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	return `${h}h${String(m).padStart(2, "0")}m${String(s).padStart(2, "0")}s`;
}

/** The owner chain in text form: session / goal / job identity. */
export function ownerText(run) {
	const owner = run.owner ?? {};
	const suffix = owner.agentId ? ` agent:${owner.agentId}` : "";
	if (owner.kind === "goal") return `goal:${owner.goalId ?? "?"} (session:${owner.sessionId ?? "?"})${suffix}`;
	if (owner.kind === "job") return `job:${owner.jobId ?? "?"} (session:${owner.sessionId ?? "?"})${suffix}`;
	return `session:${owner.sessionId ?? "?"}${suffix}`;
}

const TEXT_OUTPUT = {
	type: "object",
	additionalProperties: false,
	properties: {
		text: { type: "string", required: true }
	}
};

const renderText = (_args, value) => [{ type: "text", text: value.text }];

/**
 * resource_run: start one long task as a systemd transient unit. The caller must
 * be an agent (its session becomes the run owner); optional goalId/jobId
 * annotate the owner chain for attribution.
 */
export function defineResourceRunTool({ manager }) {
	return defineTool({
		name: "resource_run",
		description: "Launch a long-running task as its own systemd transient unit (systemd-run --collect, resource-limited, immune to dsh-web.service restarts). Never use this for short commands. Returns the runId; the pid is a registry fact — query it with resource_status.",
		timeoutMs: 30000,
		parameters: {
			projectId: {
				type: "string",
				description: "Optional free-form project/run label. A registered manifest is used when it matches; otherwise the label becomes the run namespace."
			},
			taskId: {
				type: "string",
				description: "Optional task label. A registered task manifest supplies limits when it matches; otherwise defaults/overrides are used."
			},
			command: {
				type: "array",
				required: true,
				items: { type: "string" },
				description: "Command argv executed directly (no shell) by systemd-run, e.g. [\"sleep\", \"120\"]."
			},
			limits: {
				type: "object",
				additionalProperties: true,
				properties: {
					cpuMaxCores: { type: "number", description: "CPUQuota in cores (e.g. 2 = 200%)." },
					memoryMaxBytes: { type: "integer", description: "MemoryMax in bytes." },
					tasksMax: { type: "integer", description: "TasksMax process/thread cap." }
				},
				description: "Optional per-call limits overriding task.limits. Defaults derive from the task manifest."
			},
			workingDirectory: { type: "string", description: "Optional WorkingDirectory property for the unit." },
			env: { type: "object", additionalProperties: true, description: "Optional extra environment variables (--setenv)." },
			goalId: { type: "string", description: "Optional owning goal id for the owner chain (from the goal tool)." },
			jobId: { type: "string", description: "Optional owning background job id for the owner chain." }
		},
		output: {
			schema: TEXT_OUTPUT,
			render: renderText
		},
		async execute(args, exec) {
			const sessionId = callerSessionId(exec);
			if (sessionId === null) {
				return { text: "[resource_run] refused: no agent/session context — long tasks need a session owner" };
			}
			const owner = {
				kind: args.goalId ? "goal" : args.jobId ? "job" : "session",
				sessionId,
				goalId: typeof args.goalId === "string" && args.goalId.length > 0 ? args.goalId : null,
				jobId: typeof args.jobId === "string" && args.jobId.length > 0 ? args.jobId : null
			};
			const result = await manager.launch({
				projectId: typeof args.projectId === "string" && args.projectId.length > 0 ? args.projectId : null,
				taskId: typeof args.taskId === "string" && args.taskId.length > 0 ? args.taskId : null,
				allowUnregistered: true,
				command: args.command,
				owner,
				limitsOverrides: args.limits ?? {},
				workingDirectory: typeof args.workingDirectory === "string" && args.workingDirectory.length > 0 ? args.workingDirectory : null,
				env: args.env ?? null
			});
			if (!result.ok) {
				return { text: `[resource_run] failed (${result.code}): ${result.error}${result.runId ? ` — runId ${result.runId}` : ""}` };
			}
			return {
				text: [
					`[resource_run] launched ${result.runId} for ${args.projectId ?? "session"}/${args.taskId ?? "task"}`,
					`unit: ${result.unit} (independent systemd transient unit — a dsh-web.service restart cannot kill it)`,
					`status: ${result.status}`,
					`The pid is a registry fact: query it with resource_status (runId ${result.runId}); stop the run with resource_stop.`
				].join("\n")
			};
		}
	});
}

/**
 * resource_status: read-only. Reconciles active runs against systemd first (so
 * transitions are persisted), then lists runs with an optional filter.
 */
export function defineResourceStatusTool({ manager }) {
	return defineTool({
		name: "resource_status",
		description: "Read-only long-task run list and current state (reconciles against systemd first). Use it to check the pid, status, duration and exit code of resource_run runs.",
		timeoutMs: 30000,
		parameters: {
			runId: { type: "string", description: "Optional filter: one run id." },
			projectId: { type: "string", description: "Optional filter: all runs of one project." },
			ownOnly: { type: "boolean", description: "Optional: show only runs owned by the calling session." }
		},
		output: {
			schema: TEXT_OUTPUT,
			render: renderText
		},
		async execute(args, exec) {
			await manager.reconcile();
			let runs = manager.listRuns();
			if (typeof args.runId === "string" && args.runId.length > 0) runs = runs.filter((run) => run.id === args.runId);
			if (typeof args.projectId === "string" && args.projectId.length > 0) runs = runs.filter((run) => run.projectId === args.projectId);
			if (args.ownOnly === true) {
				const sessionId = callerSessionId(exec);
				runs = runs.filter((run) => run.owner?.sessionId === sessionId);
			}
			return { text: renderRunsText(runs) };
		}
	});
}

/**
 * resource_stop: minimal control. Stops the run's own transient unit via
 * `systemctl stop` — after the owner check. A caller may ONLY stop runs
 * whose owner.sessionId equals its own session; every other attempt is
 * refused before any systemctl invocation. Adopted project units and other
 * processes are unreachable by construction.
 */
export function defineResourceStopTool({ manager }) {
	return defineTool({
		name: "resource_stop",
		description: "Stop one resource_run run owned by the calling session (systemctl stop on its transient unit). Runs owned by other sessions are refused — this tool can never kill another session's or project's processes.",
		timeoutMs: 60000,
		parameters: {
			runId: {
				type: "string",
				required: true,
				description: "The run id returned by resource_run (or listed by resource_status)."
			}
		},
		output: {
			schema: TEXT_OUTPUT,
			render: renderText
		},
		async execute(args, exec) {
			const sessionId = callerSessionId(exec);
			if (sessionId === null) {
				return { text: "[resource_stop] refused: no agent/session context — cannot prove ownership" };
			}
			const result = await manager.stop({ runId: args.runId, callerSessionId: sessionId });
			if (!result.ok) {
				if (result.code === "forbidden") return { text: `[resource_stop] FORBIDDEN: ${result.error}` };
				return { text: `[resource_stop] failed (${result.code}): ${result.error}` };
			}
			if (result.code === "already-terminal") {
				return { text: `[resource_stop] run ${result.runId} is already ${result.status}${result.exitCode !== null ? ` (exitCode ${result.exitCode})` : ""}; nothing to stop` };
			}
			return { text: `[resource_stop] stopped ${result.runId}: status=stopped, exitCode=${result.exitCode}` };
		}
	});
}

