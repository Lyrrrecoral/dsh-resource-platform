/**
 * Model-facing tools: resource_plan (plan + apply decisions to queue.json) and
 * resource_queue (view / enqueue). Every definition goes through the real
 * `defineTool` compiler at plugin apply time — the schemas are compiled
 * against the enforced dsh-tools JSON-Schema subset and covered by
 * test/tool-schema.test.js so a compile regression fails before boot (the
 * hardware-guard v0.2.0 lesson).
 *
 * Boundary: these tools can ONLY write queue.json (enqueue + plan
 * decisions). There is no kill action, no systemd/cgroup/proc write path.
 *
 * @module resource-allocation/tool
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { computeUsage, orderQueue, quotaFor } from "./plan.js";

/** Resolve the calling session id from a ToolRunContext; null outside an agent. */
export function callerSessionId(exec) {
	const id = exec?.agent?.id;
	return typeof id === "string" && id.length > 0 ? id : null;
}

const TEXT_OUTPUT = {
	type: "object",
	additionalProperties: false,
	properties: {
		text: { type: "string", required: true }
	}
};

const renderText = (_args, value) => [{ type: "text", text: value.text }];

/** Safe ISO formatter for untrusted epoch-ms queue facts. */
function formatIsoTimestamp(value) {
if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "?";
const date = new Date(value);
return Number.isFinite(date.getTime()) ? date.toISOString() : "?";
}

/**
 * Render the queue view for resource_queue(action=list): policy summary, capacity,
 * ordered queued items (effective priority), running items and the last
 * decision.
 */
export function renderQueueText({ doc, policy, now = Date.now() }) {
	if (doc === null) return "[resource-allocation queue]\nqueue registry unavailable (missing or corrupt — writes are refused)";
	const lines = [];
	lines.push("[resource-allocation queue]");
	lines.push(`revision: ${doc.revision} (updated ${formatIsoTimestamp(doc.updatedAt)})`);
	lines.push(`capacity: pressure ${doc.capacity.pressure}, headroom ${doc.capacity.headroomCpuCores.toFixed(2)} cores / ${Math.floor(doc.capacity.headroomMemBytes / 1048576)} MiB (sampled ${formatIsoTimestamp(doc.capacity.sampledAt)})`);
	lines.push(`lastDecision (r${doc.lastDecision.revision}): ${doc.lastDecision.action} — ${doc.lastDecision.reason} (by ${doc.lastDecision.by}, ${formatIsoTimestamp(doc.lastDecision.at)})`);
	const policyNote = policy === null
		? "policy: unavailable"
		: `policy: ${policy.policyId} (queueLimit ${policy.admission.queueLimit}, maxConcurrentAdmitted ${policy.admission.maxConcurrentAdmitted}, denyBackgroundAt ${policy.admission.denyBackgroundAt})`;
	lines.push(policyNote);
	const usage = computeUsage(doc);
	const ordered = orderQueue(doc.queued, policy ?? undefined, { now, allocations: usage.perProject });
	lines.push(`queued (${doc.queued.length}):${doc.queued.length === 0 ? " none" : ""}`);
	for (const { item, effectivePriority: effective, waitMs } of ordered) {
		lines.push(`  - ${item.id} ${item.projectId}/${item.taskId} priority ${item.priority} (effective ${effective}, waited ${Math.floor(waitMs / 1000)}s) cpu ${item.request.cpuCores} mem ${Math.floor(item.request.memBytes / 1048576)} MiB${item.deadlineAt !== undefined && item.deadlineAt !== null ? ` deadline ${formatIsoTimestamp(item.deadlineAt)}` : ""}`);
	}
	lines.push(`running (${doc.running.length}):${doc.running.length === 0 ? " none" : ""}`);
	for (const entry of doc.running) {
		const item = entry.item;
		const quota = policy === null ? null : quotaFor(policy, item.projectId);
		lines.push(`  - ${item.id} ${item.projectId}/${item.taskId} status ${item.status} priority ${item.priority} alloc cpu ${entry.allocation.cpuCores} mem ${Math.floor(entry.allocation.memBytes / 1048576)} MiB unit ${entry.allocation.managerUnit}${quota === null ? " (no quota!)" : ""}${item.reason !== undefined && item.reason !== null ? ` — ${item.reason}` : ""}`);
	}
	lines.push("resource_plan decides admission/throttle/pause; resource_queue(action=enqueue) submits new work. This package never kills.");
	return lines.join("\n");
}

/**
 * resource_plan: compute the scheduler plan from the fact sources (hardware-guard
 * pressure + host budget, resource-allocation projects/runs) and apply the decisions to
 * queue.json — admit / throttle / pause / resume / deny. Decisions are
 * signals only: nothing is executed or killed here.
 */
export function defineResourcePlanTool({ manager }) {
	return defineTool({
		name: "resource_plan",
		description: "Compute and apply the resource-allocation plan: samples host pressure (hardware-guard facts), orders the queue by policy (priority + aging), admits/queues/throttles/pauses tasks and writes every decision to queue.json. Decisions only — this tool never kills, never touches processes, cgroups or systemd units. Use dryRun=true to preview without writing.",
		timeoutMs: 30000,
		parameters: {
			dryRun: {
				type: "boolean",
				description: "Show the plan without writing queue.json. Default false: decisions are applied to queue.json (the only file this tool writes)."
			}
		},
		output: {
			schema: TEXT_OUTPUT,
			render: renderText
		},
		async execute(args) {
			const result = await manager.plan({ dryRun: args.dryRun === true, by: "resource_plan" });
			if (!result.ok) {
				return { text: `[resource_plan] failed: ${(result.errors ?? []).join("; ") || "unknown error"}` };
			}
			return { text: result.text };
		}
	});
}

/**
 * resource_queue: view the queue (read-only) or enqueue one task. Enqueueing only
 * records the submission in queue.json — admission is decided by resource_plan.
 */
export function defineResourceQueueTool({ manager }) {
	return defineTool({
		name: "resource_queue",
		description: "View the scheduler queue (read-only) or enqueue one task with optional labels. No project registration is required; enqueue records the submission only — admission, throttling and pausing are decided by resource_plan. This tool never kills, never starts or stops processes and never touches systemd.",
		timeoutMs: 30000,
		parameters: {
			action: {
				type: "string",
				required: true,
				enum: ["list", "enqueue"],
				description: "list: show the queue (queued order, running items, capacity, last decision). enqueue: submit one task to the queue."
			},
			projectId: {
				type: "string",
				description: "enqueue only: optional project/run label. A registered manifest supplies legacy defaults; an unregistered label is allowed."
			},
			taskId: {
				type: "string",
				description: "enqueue only: optional task label. Defaults to queue; no manifest is required."
			},
			priority: {
				type: "integer",
				description: "enqueue only: explicit priority 0..100; defaults to the task's manifest priority, then the project quota priority, then 50."
			},
			request: {
				type: "object",
				additionalProperties: false,
				properties: {
					cpuCores: { type: "number", description: "Requested CPU cores (> 0). Defaults to the task's manifest request." },
					memBytes: { type: "integer", description: "Requested memory bytes (>= 1). Defaults to the task's manifest request." }
				},
				description: "enqueue only: per-call resource request override."
			},
			deadlineAt: {
				type: "integer",
				description: "enqueue only: optional epoch-ms deadline (earliest-deadline scheduling)."
			},
			runId: {
				type: "string",
				description: "enqueue only: optional resource-allocation run id linking this queue item to a resource_run record."
			}
		},
		output: {
			schema: TEXT_OUTPUT,
			render: renderText
		},
		async execute(args, exec) {
			if (args.action === "list") {
				const view = await manager.listQueue();
				return { text: renderQueueText(view) };
			}
			const sessionId = callerSessionId(exec);
			if (sessionId === null) {
				return { text: "[resource_queue] enqueue refused: no agent/session context — queue items need a session owner" };
			}
			const sessionSlug = sessionId.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "unknown";
			const projectId = typeof args.projectId === "string" && args.projectId.trim().length > 0 ? args.projectId.trim() : `session-${sessionSlug}`;
			const taskId = typeof args.taskId === "string" && args.taskId.trim().length > 0 ? args.taskId.trim() : "queue";
			const result = await manager.enqueue({
				projectId,
				taskId,
				priority: args.priority,
				request: args.request ?? null,
				deadlineAt: args.deadlineAt,
				owner: { sessionId, runId: typeof args.runId === "string" && args.runId.length > 0 ? args.runId : undefined }
			});
			if (!result.ok) {
				return { text: `[resource_queue] enqueue failed (${result.code ?? "error"}): ${(result.errors ?? []).join("; ") || "unknown error"}` };
			}
			return { text: result.text };
		}
	});
}
