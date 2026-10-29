/**
 * resource_queue enqueue path: records a submission with optional labels and
 * defaults. A registered project/task supplies legacy request/priority/quota
 * defaults; an unregistered label is allowed when the caller passes
 * `allowUnregistered: true`. Admission is NOT decided here — resource_plan
 * applies host headroom and the optional quota (or a host-derived fallback
 * quota for session-local labels). Nothing else is written.
 *
 * @module resource-allocation/enqueue
 */
import { indexProjects } from "./facts.js";
import { EPSILON, quotaFor } from "./plan.js";

function clampPriority(value) {
	if (!Number.isInteger(value)) return 50;
	return Math.max(0, Math.min(100, value));
}

/**
 * Enqueue one task into the queue registry.
 *
 * @param {object} options
 * @param {PolicyStore} options.policyStore
 * @param {QueueRegistry} options.queue
 * @param {object} options.facts - collectFacts() snapshot
 * @param {object} options.input - {projectId, taskId, priority?, request?, deadlineAt?, owner}
 * @param {string} options.by
 * @returns {{ok, code?, errors?, item?, registryRevision?, text?}}
 */
export function enqueueTask({ policyStore, queue, facts, input, by = "resource_queue", allowUnregistered = false }) {
	const fail = (code, errors) => ({ ok: false, code, errors, text: `[resource_queue] enqueue failed (${code}): ${errors.join("; ")}` });
	const policyLoaded = policyStore.load();
	if (policyLoaded.doc === null) return fail("policy-corrupt", [policyLoaded.error]);
	const policy = policyLoaded.doc;

	const sessionId = typeof input.owner?.sessionId === "string" ? input.owner.sessionId : "";
	const slugSession = sessionId.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "unknown";
	const projectId = typeof input.projectId === "string" && input.projectId.trim().length > 0
		? input.projectId.trim()
		: `session-${slugSession}`;
	const taskId = typeof input.taskId === "string" && input.taskId.trim().length > 0 ? input.taskId.trim() : "queue";
	const projectIndex = indexProjects(facts.projects ?? []);
	const project = projectIndex.get(projectId) ?? null;
	const task = project?.tasks.get(taskId) ?? null;
	if (project === null && allowUnregistered !== true) {
		return fail("reject", [`unknown project ${projectId} (registered projects: ${[...projectIndex.keys()].join(", ") || "none"})`]);
	}
	if (project !== null && task === null && allowUnregistered !== true) {
		return fail("reject", [`unknown task ${projectId}/${taskId} (task ids: ${[...project.tasks.keys()].join(", ") || "none"})`]);
	}

	const quota = quotaFor(policy, projectId);
	const request = {
		cpuCores: input.request?.cpuCores ?? task?.request?.cpuCores ?? policy.admission.defaultRequest.cpuCores,
		memBytes: input.request?.memBytes ?? task?.request?.memBytes ?? policy.admission.defaultRequest.memBytes
	};
	if (!(typeof request.cpuCores === "number" && Number.isFinite(request.cpuCores) && request.cpuCores > 0)) {
		return fail("invalid", [`request.cpuCores must be a number > 0 (got ${request.cpuCores})`]);
	}
	if (!(Number.isInteger(request.memBytes) && request.memBytes >= 1)) {
		return fail("invalid", [`request.memBytes must be an integer >= 1 (got ${request.memBytes})`]);
	}
	const priority = clampPriority(input.priority ?? task?.priority ?? quota?.priority ?? 50);

	// Enqueue-time sanity: the request must fit the quota at all — the
	// current-usage part of the quota check happens at admission (resource_plan).
	if (quota !== null && (request.cpuCores > quota.cpuMaxCores + EPSILON || request.memBytes > quota.memBudgetBytes)) {
		const cpuNote = request.cpuCores > quota.cpuMaxCores + EPSILON ? `cpu ${request.cpuCores} > max ${quota.cpuMaxCores}` : "";
		const memNote = request.memBytes > quota.memBudgetBytes ? `mem ${request.memBytes} > budget ${quota.memBudgetBytes}` : "";
		return fail("reject", [`request exceeds project quota for ${projectId}: ${[cpuNote, memNote].filter((note) => note.length > 0).join(", ")}`]);
	}
	if (quota === null) {
		// allowed to queue (quota-less projects may only queue — admission is
		// where the missing quota blocks them).
	}

	const result = queue.enqueue(
		{
			projectId,
			taskId,
			owner: input.owner ?? {},
			priority,
			request,
			deadlineAt: input.deadlineAt,
			reason: null
		},
		{ by, queueLimit: policy.admission.queueLimit }
	);
	if (!result.ok) return fail(result.code ?? "error", result.errors ?? [String(result)]);
	return {
		ok: true,
		item: result.item,
		registryRevision: result.registryRevision,
		text: [
			`[resource_queue] enqueued ${result.item.id} for ${projectId}/${taskId}`,
			`status: queued (queue revision ${result.registryRevision}); priority ${priority}, cpu ${request.cpuCores} mem ${Math.floor(request.memBytes / 1048576)} MiB`,
			quota === null ? "note: no explicit quota for this label; admission may use host headroom/concurrency fallback" : "",
			"admission (admit/queue/throttle/pause) is decided by resource_plan — this tool never starts or kills anything."
		].filter((line) => line.length > 0).join("\n")
	};
}
