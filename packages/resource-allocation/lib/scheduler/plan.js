/**
 * The resource-allocation planner: the pure decision core.
 *
 * buildPlan() is a pure function over (policy, queue doc, facts): it computes
 * project/global usage and headroom, orders the queue by the policy's
 * scheduling algorithm (priority + aging), and derives the decisions for the
 * current pressure state. runPlan() applies those decisions to queue.json
 * through ONE CAS write (revision bump + lastDecision) — and to nowhere
 * else. v0.1 never touches processes, cgroups or systemd units: decisions
 * are signals for the owners/future versions.
 *
 * Decision semantics (v0.1):
 *   ok:       resume scheduler-paused/throttled items; admit the best-fitting
 *             queued items (quota + headroom + maxConcurrentAdmitted).
 *   warn:     no new admissions; running items are marked throttled
 *             (advisory elastic throttle to targetCpuFraction).
 *   critical: preemptible running/throttled items are marked PAUSED — never
 *             killed; non-preemptible running items get the advisory
 *             throttle. No admissions at all (all queue items are
 *             background work in v0.1; a foreground marker needs a later
 *             schema version).
 *
 * Fail-safe: a missing/corrupt host profile or policy denies every admission.
 * An unregistered queue label is admitted only through a host-derived fallback
 * quota (global headroom + maxConcurrentAdmitted); it never bypasses host
 * pressure or concurrency limits.
 *
 * @module resource-allocation/plan
 */
import { indexProjects } from "./facts.js";
import { ALLOCATED_STATUSES, clone, validateQueueDoc } from "./queue.js";

export const EPSILON = 1e-9;

/** Reason prefixes the scheduler stamps so it can recognize its own pauses. */
export const PAUSE_REASON_PREFIX = "scheduler: paused (pressure ";
export const THROTTLE_REASON_PREFIX = "scheduler: throttled (pressure ";
export const RESUME_REASON_PREFIX = "scheduler: resumed (pressure ";

/** Allocated CPU counts as 0 for paused items (released), memory still held. */
const CPU_COUNTED_STATUSES = Object.freeze(["admitted", "running", "throttled"]);

export function roundCpu(value) {
	return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Per-project and global resource usage over the post-admission (unfinished)
 * items of a queue document.
 */
export function computeUsage(doc) {
	const perProject = new Map();
	let totalCpu = 0;
	let totalMem = 0;
	let totalActive = 0;
	for (const entry of doc.running) {
		const item = entry.item;
		if (!ALLOCATED_STATUSES.includes(item.status)) continue;
		const allocation = entry.allocation ?? { cpuCores: 0, memBytes: 0 };
		const cpu = CPU_COUNTED_STATUSES.includes(item.status) ? allocation.cpuCores : 0;
		const mem = allocation.memBytes;
		const project = perProject.get(item.projectId) ?? { cpu: 0, mem: 0, active: 0 };
		project.cpu += cpu;
		project.mem += mem;
		project.active += 1;
		perProject.set(item.projectId, project);
		totalCpu += cpu;
		totalMem += mem;
		totalActive += 1;
	}
	return { perProject, totalCpu, totalMem, totalActive };
}

/** The project quota entry for a project id, or null (quota-less). */
export function quotaFor(policy, projectId) {
	return policy.quotas.find((quota) => quota.projectId === projectId) ?? null;
}

/**
 * Host-derived fallback quota for a queue label with no explicit policy quota.
 * The global headroom check still applies, so this does not grant unlimited
 * resources; it only lets session-local labels pass the quota gate.
 */
export function fallbackQuotaFor(host, maxConcurrentAdmitted = 1) {
	if (host === null || host === undefined) return null;
	const cpu = typeof host.cpuBudgetCores === "number" && host.cpuBudgetCores > 0 ? host.cpuBudgetCores : null;
	const mem = Number.isInteger(host.memBudgetBytes) && host.memBudgetBytes > 0 ? host.memBudgetBytes : null;
	if (cpu === null || mem === null) return null;
	return { projectId: "__fallback__", priority: 50, cpuMinCores: 0, cpuMaxCores: cpu, memBudgetBytes: mem, tasksMax: Math.max(1, Math.trunc(maxConcurrentAdmitted) || 1) };
}

/**
 * Whether one more request fits the project quota. cpuMinCores is a
 * guarantee, not a limit, so only cpuMaxCores / memBudgetBytes / tasksMax
 * gate admission.
 */
export function checkQuota({ quota, usage, request }) {
	const reasons = [];
	if (usage.cpu + request.cpuCores > quota.cpuMaxCores + EPSILON) {
		reasons.push(`project quota cpu exceeded: used ${roundCpu(usage.cpu)} + request ${request.cpuCores} > max ${quota.cpuMaxCores}`);
	}
	if (usage.mem + request.memBytes > quota.memBudgetBytes) {
		reasons.push(`project quota mem exceeded: used ${usage.mem} + request ${request.memBytes} > budget ${quota.memBudgetBytes}`);
	}
	if (usage.active + 1 > quota.tasksMax) {
		reasons.push(`project tasksMax reached: ${usage.active}/${quota.tasksMax} active tasks`);
	}
	return { ok: reasons.length === 0, reasons };
}

/**
 * Global headroom: host budget minus current usage minus the policy's
 * headroom reserve, floored at zero.
 */
export function computeHeadroom({ host, policy, usage }) {
	const reserve = policy.admission.headroomReserve;
	return {
		cpuCores: Math.max(0, host.cpuBudgetCores - usage.totalCpu - reserve.cpuCores),
		memBytes: Math.max(0, host.memBudgetBytes - usage.totalMem - reserve.memBytes),
		reserveCpuCores: reserve.cpuCores,
		reserveMemBytes: reserve.memBytes
	};
}

/**
 * The effective priority of a queued item under the policy's aging rule:
 * base priority + floor(waitMinutes) × boostPerMinute, capped at 100;
 * maxWaitMs (when set) promotes a starved item straight to 100.
 */
export function effectivePriority(item, policy, now = Date.now()) {
	const aging = policy?.scheduling?.aging;
	if (aging === undefined || aging.enabled !== true) return item.priority;
	const waitedMs = Math.max(0, now - item.submittedAt);
	if (Number.isInteger(aging.maxWaitMs) && waitedMs >= aging.maxWaitMs) return 100;
	const boost = Math.floor(waitedMs / 60000) * aging.boostPerMinute;
	return Math.min(100, item.priority + boost);
}

/**
 * Order queued items per the policy's scheduling algorithm.
 * `allocations` (computeUsage().perProject) feeds weighted-fair-share.
 * Returns decorated entries [{item, effectivePriority, waitMs}].
 */
export function orderQueue(items, policy, { now = Date.now(), allocations = null } = {}) {
	const algorithm = policy?.scheduling?.algorithm ?? "static-priority";
	const tieBreaker = policy?.scheduling?.tieBreaker ?? "priority-then-fifo";
	const decorated = items.map((item) => ({
		item,
		effectivePriority: effectivePriority(item, policy, now),
		waitMs: Math.max(0, now - item.submittedAt)
	}));
	const projectShare = (item) => {
		const quota = quotaFor(policy, item.projectId);
		const used = allocations?.get(item.projectId)?.cpu ?? 0;
		return used / Math.max(quota?.cpuMaxCores ?? 1, EPSILON);
	};
	const bySubmitted = (a, b) => (a.item.submittedAt - b.item.submittedAt) || (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0);
	const byPriority = (a, b) => b.item.priority - a.item.priority;
	const byEffective = (a, b) => b.effectivePriority - a.effectivePriority;
	let compare;
	if (algorithm === "earliest-deadline") {
		const deadline = (item) => (item.deadlineAt === null || item.deadlineAt === undefined ? Number.POSITIVE_INFINITY : item.deadlineAt);
		compare = (a, b) => (deadline(a.item) - deadline(b.item)) || byEffective(a, b) || bySubmitted(a, b);
	} else if (algorithm === "weighted-fair-share") {
		compare = (a, b) => (projectShare(a.item) - projectShare(b.item)) || byEffective(a, b) || bySubmitted(a, b);
	} else {
		compare = tieBreaker === "fifo"
			? (a, b) => byEffective(a, b) || bySubmitted(a, b)
			: (a, b) => byEffective(a, b) || byPriority(a, b) || bySubmitted(a, b);
	}
	decorated.sort(compare);
	return decorated;
}

function capacityEquals(a, b) {
	return a.pressure === b.pressure && a.headroomCpuCores === b.headroomCpuCores && a.headroomMemBytes === b.headroomMemBytes;
}

/** The task manifest for an item, or null when project/task is unknown. */
function taskFor(projectIndex, item) {
	return projectIndex.get(item.projectId)?.tasks.get(item.taskId) ?? null;
}

/** The admission gate reason for the current pressure (background work). */
function gateReason(pressure, policy) {
	if (pressure === "critical") {
		return "pressure critical denies all new work (background and foreground-heavy); recover pressure first";
	}
	return `pressure ${pressure} denies new background admissions (policy denyBackgroundAt=${policy.admission.denyBackgroundAt})`;
}

/**
 * Pure plan computation over one (policy, doc, facts) snapshot.
 *
 * @param {object} options
 * @param {object} options.policy - validated policy document
 * @param {object} options.doc - validated queue document
 * @param {object} options.facts - collectFacts() result
 * @param {string} options.by - actor recorded in lastDecision
 * @param {number} [options.now]
 * @returns {object} - {ok, errors, pressure, headroom, usage, order, running,
 *   decisions, capacity, write (next doc or null), lastDecision}
 */
export function buildPlan({ policy, doc, facts, by = "resource_plan", now = Date.now() }) {
	const errors = [];
	if (policy === null || policy === undefined) return { ok: false, errors: ["no policy loaded — refusing to plan"] };
	if (doc === null || doc === undefined) return { ok: false, errors: ["no queue document loaded — refusing to plan"] };

	const projectIndex = indexProjects(facts.projects ?? []);
	const pressure = facts.pressure?.state === "warn" || facts.pressure?.state === "critical" ? facts.pressure.state : "ok";
	const host = facts.hostProfile ?? null;
	const fallbackQuota = fallbackQuotaFor(host, policy.admission.maxConcurrentAdmitted);
	const actions = policy.pressureActions[pressure] ?? policy.pressureActions.ok;

	const usage = computeUsage(doc);
	const headroom = host === null ? null : computeHeadroom({ host, policy, usage });
	const capacity = {
		pressure,
		headroomCpuCores: roundCpu(headroom?.cpuCores ?? 0),
		headroomMemBytes: headroom?.memBytes ?? 0,
		sampledAt: now
	};
	const pauses = [];
	const throttles = [];
	const resumes = [];
	const admits = [];
	const denied = [];

	// ── degradation decisions per pressure state ───────────────────────────
	for (const entry of doc.running) {
		const item = entry.item;
		if (pressure === "critical") {
			const preemptible = taskFor(projectIndex, item)?.preemptible === true;
			if ((item.status === "running" || item.status === "throttled") && preemptible && actions.pausePreemptible === true) {
				pauses.push({ item, from: item.status });
			} else if (item.status === "running" && actions.throttleElastic === true) {
				throttles.push({ item, from: item.status });
			}
		} else if (pressure === "warn") {
			if (item.status === "running" && actions.throttleElastic === true) throttles.push({ item, from: item.status });
		} else if (item.status === "paused" && actions.pausePreemptible !== true && String(item.reason ?? "").startsWith(PAUSE_REASON_PREFIX)) {
			resumes.push({ item, from: item.status });
		} else if (item.status === "throttled" && actions.throttleElastic !== true && String(item.reason ?? "").startsWith(THROTTLE_REASON_PREFIX)) {
			resumes.push({ item, from: item.status });
		}
	}

	// ── admission decisions ────────────────────────────────────────────────
	const pressureRank = { ok: 0, warn: 1, critical: 2 }[pressure];
	const denyRank = { ok: 0, warn: 1, critical: 2 }[policy.admission.denyBackgroundAt] ?? 1;
	const backgroundAllowed = actions.allowNewBackground === true && pressureRank < denyRank;
	const order = orderQueue(doc.queued, policy, { now, allocations: usage.perProject });

	if (backgroundAllowed && host !== null) {
		let concurrent = usage.totalActive;
		let cpuHead = headroom.cpuCores;
		let memHead = headroom.memBytes;
		for (const { item } of order) {
			const quota = quotaFor(policy, item.projectId) ?? fallbackQuota;
			let denyReason = null;
			const projectUsage = usage.perProject.get(item.projectId) ?? { cpu: 0, mem: 0, active: 0 };
			if (quota === null) {
				denyReason = `project ${item.projectId} has no quota (policy.quotas[]); quota-less projects may only queue`;
			} else {
				const quotaCheck = checkQuota({ quota, usage: projectUsage, request: item.request });
				if (!quotaCheck.ok) denyReason = quotaCheck.reasons.join("; ");
				else if (concurrent >= policy.admission.maxConcurrentAdmitted) denyReason = `maxConcurrentAdmitted reached (${concurrent}/${policy.admission.maxConcurrentAdmitted})`;
				else if (item.request.cpuCores > cpuHead + EPSILON) denyReason = `cpu headroom insufficient (need ${item.request.cpuCores}, have ${roundCpu(cpuHead)})`;
				else if (item.request.memBytes > memHead) denyReason = `mem headroom insufficient (need ${item.request.memBytes}, have ${memHead})`;
			}
			if (denyReason === null) {
				const task = taskFor(projectIndex, item);
				admits.push({
					item,
					allocation: {
						cpuCores: item.request.cpuCores,
						memBytes: item.request.memBytes,
						managerUnit: typeof task?.run?.systemdUnit === "string" && task.run.systemdUnit.length > 0
							? task.run.systemdUnit
							: "resource-allocation"
					}
				});
				concurrent += 1;
				cpuHead -= item.request.cpuCores;
				memHead -= item.request.memBytes;
				projectUsage.cpu += item.request.cpuCores;
				projectUsage.mem += item.request.memBytes;
				projectUsage.active += 1;
			} else {
				denied.push({ item, reason: denyReason });
			}
		}
	} else if (doc.queued.length > 0) {
		const reason = host === null
			? "host profile unavailable — refusing admissions (fail-safe)"
			: gateReason(pressure, policy);
		for (const item of doc.queued) denied.push({ item, reason });
	}

	// ── the plan write (single CAS write, single lastDecision) ─────────────
	const hasDecisions = pauses.length + throttles.length + resumes.length + admits.length > 0;
	let write = null;
	let dominantAction = "noop";
	let summary = "";
	let finalCapacity = capacity;

	if (hasDecisions || !capacityEquals(doc.capacity, capacity)) {
		const next = clone(doc);
		const applyTransition = (decision, status, reason) => {
			const item = next.queued.find((candidate) => candidate.id === decision.item.id)
				?? next.running.find((entry) => entry.item.id === decision.item.id)?.item
				?? null;
			if (item === null) return;
			item.status = status;
			item.reason = reason;
			item.lastTransitionAt = now;
		};
		for (const decision of pauses) applyTransition(decision, "paused", `${PAUSE_REASON_PREFIX}critical; preemptible task paused, never killed)`);
		for (const decision of throttles) applyTransition(decision, "throttled", `${THROTTLE_REASON_PREFIX}${pressure}; elastic advisory)`);
		for (const decision of resumes) applyTransition(decision, "running", `${RESUME_REASON_PREFIX}${pressure})`);
		for (const decision of admits) {
			next.queued = next.queued.filter((candidate) => candidate.id !== decision.item.id);
			next.running.push({
				item: { ...clone(decision.item), status: "admitted", lastTransitionAt: now },
				allocation: decision.allocation
			});
		}
		// capacity reflects the document AS WRITTEN (after decisions land)
		const nextUsage = computeUsage(next);
		const nextHeadroom = host === null ? null : computeHeadroom({ host, policy, usage: nextUsage });
		finalCapacity = {
			pressure,
			headroomCpuCores: roundCpu(nextHeadroom?.cpuCores ?? 0),
			headroomMemBytes: nextHeadroom?.memBytes ?? 0,
			sampledAt: now
		};
		next.capacity = finalCapacity;
		const capacityChanged = !capacityEquals(doc.capacity, finalCapacity);
		if (hasDecisions || capacityChanged) {
			const deniedNote = denied.length > 0 ? `; ${denied.length} item(s) remain queued (first: ${denied[0].item.id} — ${denied[0].reason})` : "";
			if (pauses.length > 0) {
				dominantAction = "pause";
				summary = `critical pressure: paused ${pauses.length} preemptible item(s) (${pauses.map((d) => d.item.id).join(", ")}) — never killed${deniedNote}`;
			} else if (throttles.length > 0) {
				dominantAction = "throttle";
				summary = `${pressure} pressure: throttled ${throttles.length} running item(s) (${throttles.map((d) => d.item.id).join(", ")})${deniedNote}`;
			} else if (admits.length > 0) {
				dominantAction = "admit";
				summary = `admitted ${admits.length} item(s) (${admits.map((d) => d.item.id).join(", ")})${deniedNote}`;
			} else if (resumes.length > 0) {
				dominantAction = "resume";
				summary = `${pressure} pressure: resumed ${resumes.length} item(s) (${resumes.map((d) => d.item.id).join(", ")})`;
			} else if (doc.queued.length > 0) {
				dominantAction = "deny";
				summary = `${denied[0]?.reason ?? gateReason(pressure, policy)}; ${doc.queued.length} item(s) remain queued`;
			} else {
				dominantAction = "noop";
				summary = `capacity sampled (pressure ${pressure})`;
			}
			next.lastDecision = { revision: next.revision, action: dominantAction, reason: summary, by, at: now };

			const check = validateQueueDoc(next);
			if (!check.ok) {
				errors.push(`plan produced an invalid queue document: ${check.errors.join("; ")}`);
				write = null;
			} else {
				write = next;
			}
		}
	}

	return {
		ok: errors.length === 0,
		errors,
		pressure,
		pressureSource: facts.pressure?.source ?? "unknown",
		pressureAt: facts.pressure?.at ?? null,
		pressureReasons: facts.pressure?.reasons ?? [],
		host,
		hostError: facts.hostProfileError ?? null,
		policy,
		usage,
		headroom,
		capacity: finalCapacity,
		order: order.map(({ item, effectivePriority: effective, waitMs }) => ({
			id: item.id,
			projectId: item.projectId,
			taskId: item.taskId,
			priority: item.priority,
			effectivePriority: effective,
			waitMs,
			submittedAt: item.submittedAt,
			deadlineAt: item.deadlineAt ?? null,
			request: item.request
		})),
		running: doc.running.map((entry) => ({
			id: entry.item.id,
			projectId: entry.item.projectId,
			taskId: entry.item.taskId,
			status: entry.item.status,
			priority: entry.item.priority,
			preemptible: taskFor(projectIndex, entry.item)?.preemptible === true,
			allocation: entry.allocation
		})),
		decisions: {
			admits: admits.map((d) => d.item.id),
			pauses: pauses.map((d) => d.item.id),
			throttles: throttles.map((d) => d.item.id),
			resumes: resumes.map((d) => d.item.id),
			denied: denied.map((d) => ({ itemId: d.item.id, reason: d.reason }))
		},
		write,
		lastDecision: write === null ? null : { action: dominantAction, reason: summary }
	};
}

/** Render a plan result into the resource_plan text output. */
/** Safe ISO formatter for untrusted epoch-ms pressure/queue facts. */
function formatIsoTimestamp(value) {
if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "?";
const date = new Date(value);
return Number.isFinite(date.getTime()) ? date.toISOString() : "?";
}

export function renderPlanText(plan, { applied = null, dryRun = false } = {}) {
	const lines = [];
	lines.push("[resource-allocation plan]");
	lines.push(`pressure: ${plan.pressure}${plan.pressureSource ? ` (source: ${plan.pressureSource}${plan.pressureAt !== null ? `, at ${formatIsoTimestamp(plan.pressureAt)}` : ""})` : ""}${plan.pressureReasons.length > 0 ? ` — ${plan.pressureReasons.join("; ")}` : ""}`);
	if (plan.host === null) {
		lines.push(`host budget: UNAVAILABLE (${plan.hostError ?? "no host profile"}) — admissions fail closed`);
	} else {
		lines.push(`host budget: ${plan.host.cpuBudgetCores} cores, ${Math.floor(plan.host.memBudgetBytes / 1048576)} MiB mem, max ${plan.host.maxBackgroundJobs} background jobs`);
	}
	lines.push(`policy: ${plan.policy.policyId} — algorithm ${plan.policy.scheduling.algorithm}, tie ${plan.policy.scheduling.tieBreaker}, aging ${plan.policy.scheduling.aging.enabled ? `+${plan.policy.scheduling.aging.boostPerMinute}/min${plan.policy.scheduling.aging.maxWaitMs !== null ? ` (cap ${plan.policy.scheduling.aging.maxWaitMs}ms)` : ""}` : "off"}, denyBackgroundAt ${plan.policy.admission.denyBackgroundAt}, queueLimit ${plan.policy.admission.queueLimit}, maxConcurrentAdmitted ${plan.policy.admission.maxConcurrentAdmitted}`);
	lines.push(`headroom: ${plan.headroom === null ? "n/a" : `${plan.headroom.cpuCores.toFixed(2)} cores, ${Math.floor(plan.headroom.memBytes / 1048576)} MiB (after reserve ${plan.headroom.reserveCpuCores} cores / ${Math.floor(plan.headroom.reserveMemBytes / 1048576)} MiB)`}`);
	if (plan.usage.totalActive > 0) {
		lines.push(`in use: ${plan.usage.totalCpu.toFixed(2)} cores, ${Math.floor(plan.usage.totalMem / 1048576)} MiB across ${plan.usage.totalActive} active item(s)`);
	}
	const quotaLines = plan.policy.quotas.map((quota) => {
		const used = plan.usage.perProject.get(quota.projectId) ?? { cpu: 0, mem: 0, active: 0 };
		return `  - ${quota.projectId}: priority ${quota.priority}, cpu ${used.cpu.toFixed(2)}/${quota.cpuMinCores}..${quota.cpuMaxCores} cores, mem ${Math.floor(used.mem / 1048576)}/${Math.floor(quota.memBudgetBytes / 1048576)} MiB, tasks ${used.active}/${quota.tasksMax}`;
	});
	lines.push(`quotas:${quotaLines.length > 0 ? `\n${quotaLines.join("\n")}` : " none (quota-less projects may only queue)"}`);
	lines.push(`queue order:${plan.order.length === 0 ? " empty" : ""}`);
	for (const entry of plan.order) {
		lines.push(`  - ${entry.id} ${entry.projectId}/${entry.taskId} priority ${entry.priority} (effective ${entry.effectivePriority}, waited ${Math.floor(entry.waitMs / 1000)}s) cpu ${entry.request.cpuCores} mem ${Math.floor(entry.request.memBytes / 1048576)} MiB${entry.deadlineAt !== null ? ` deadline ${formatIsoTimestamp(entry.deadlineAt)}` : ""}`);
	}
	lines.push(`running:${plan.running.length === 0 ? " none" : ""}`);
	for (const entry of plan.running) {
		lines.push(`  - ${entry.id} ${entry.projectId}/${entry.taskId} status ${entry.status} priority ${entry.priority} preemptible=${entry.preemptible} alloc cpu ${entry.allocation.cpuCores} mem ${Math.floor(entry.allocation.memBytes / 1048576)} MiB unit ${entry.allocation.managerUnit}`);
	}
	const d = plan.decisions;
	const decisionParts = [];
	if (d.pauses.length > 0) decisionParts.push(`pause ${d.pauses.join(", ")} (critical — never killed)`);
	if (d.throttles.length > 0) decisionParts.push(`throttle ${d.throttles.join(", ")}`);
	if (d.admits.length > 0) decisionParts.push(`admit ${d.admits.join(", ")}`);
	if (d.resumes.length > 0) decisionParts.push(`resume ${d.resumes.join(", ")}`);
	if (d.denied.length > 0) decisionParts.push(`${d.denied.length} denied/queued`);
	if (decisionParts.length === 0) decisionParts.push("none");
	lines.push(`decisions: ${decisionParts.join("; ")}`);
	for (const denied of d.denied) {
		lines.push(`  - ${denied.itemId}: ${denied.reason}`);
	}
	if (applied === null) {
		lines.push(`next steps: ${plan.lastDecision === null ? "nothing to write (queue already matches the plan)" : `${plan.lastDecision.action}: ${plan.lastDecision.reason}`}`);
		lines.push(dryRun ? "dry run — decisions shown, NOT written to queue.json" : "apply with resource_plan (dryRun=false) to record decisions in queue.json");
	} else if (applied.unchanged === true) {
		lines.push("result: no changes needed — queue.json already matches the plan");
	} else if (applied.dryRun === true) {
		lines.push("result: dry run — decisions shown, NOT written to queue.json");
	} else {
		lines.push(`result: applied at revision ${applied.revision} — lastDecision ${plan.lastDecision.action}: ${plan.lastDecision.reason}`);
	}
	lines.push("scheduler boundary: decisions land in queue.json only; this package never kills or touches processes/units — execution belongs to the owners or a later version.");
	return lines.join("\n");
}

/**
 * Plan + apply against the live stores. One CAS write per run (or none when
 * the queue already matches the plan).
 */
export function runPlan({ policyStore, queue, facts, by = "resource_plan", dryRun = false, now = Date.now() }) {
	const policyLoaded = policyStore.load();
	if (policyLoaded.doc === null) return { ok: false, errors: [policyLoaded.error] };
	const queueLoaded = queue.load();
	if (queueLoaded.doc === null) return { ok: false, errors: [queueLoaded.error] };
	const plan = buildPlan({ policy: policyLoaded.doc, doc: queueLoaded.doc, facts, by, now });
	if (!plan.ok) return { ok: false, errors: plan.errors, plan };
	let applied = null;
	if (plan.write !== null) {
		if (dryRun) {
			applied = { dryRun: true };
		} else {
			const result = queue.mutate(() => ({ write: plan.write }));
			if (!result.ok) return { ok: false, errors: result.errors, plan };
			applied = { revision: result.registryRevision, dryRun: false };
		}
	} else {
		applied = { unchanged: true };
	}
	return { ok: true, plan, applied, text: renderPlanText(plan, { applied, dryRun }) };
}
