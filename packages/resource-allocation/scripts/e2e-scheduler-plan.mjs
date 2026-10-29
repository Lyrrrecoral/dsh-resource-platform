// resource-allocation v1.0 scheduler acceptance driver: a REAL end-to-end plan over
// fixture data in a TEMP directory — it never touches the live DSH_HOME
// storages, systemd, processes or hardware-guard.
//
// Scenario (the acceptance contract):
//   1. ok pressure: 3 projects (alpha 90 / beta 50 / gamma 20) enqueue —
//      ample resources, the highest priority is admitted first, all fit.
//   2. warn pressure: the owners start the admitted tasks (admitted→running);
//      a NEW low-priority submission stays queued while running work is
//      marked throttled.
//   3. critical pressure: preemptible tasks are marked PAUSED — never killed.
//   4. ok pressure: scheduler-paused tasks resume; the queued item is admitted.
//
// Usage: node scripts/e2e-plan.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectFacts } from "../lib/scheduler/facts.js";
import { enqueueTask } from "../lib/scheduler/enqueue.js";
import { runPlan } from "../lib/scheduler/plan.js";
import { PolicyStore, buildDefaultPolicy } from "../lib/scheduler/policy.js";
import { QueueRegistry } from "../lib/scheduler/queue.js";
import {
	BASE_TIME,
	fixtureHostProfileDoc,
	makeProjectEntry,
	makeTask,
	pressureTransition,
	threeProjectQuotas,
	writeIncidents,
	writeProjects
} from "../test/scheduler/fixtures.js";

const root = mkdtempSync(join(tmpdir(), "resource-allocation-plan-"));
process.once("exit", () => {
	try {
		rmSync(root, { recursive: true, force: true });
	} catch {
		/* best-effort smoke cleanup */
	}
});
const hardwareGuardDir = join(root, "hardware-guard");
const resourceDir = join(root, "resource-allocation");
mkdirSync(hardwareGuardDir, { recursive: true });
mkdirSync(resourceDir, { recursive: true });
console.log(`temp home: ${root} (live $DSH_HOME untouched)`);

const step = (label) => console.log(`\n== ${label}`);

// ── fixture fact sources ─────────────────────────────────────────────────
step("0. seed fixture fact sources (temp home)");
writeFileSync(join(hardwareGuardDir, "host-profile.json"), JSON.stringify(fixtureHostProfileDoc(), null, 2));
writeIncidents(hardwareGuardDir, [pressureTransition("ok", "ok", BASE_TIME)]);
writeProjects(resourceDir, [
	makeProjectEntry("alpha", [
		makeTask({ id: "alpha-heavy", priority: 90, preemptible: false, cpuCores: 2, memBytes: 3 * (1 << 30), unit: "dsh-alpha.service" }),
		makeTask({ id: "alpha-light", priority: 80, preemptible: true, cpuCores: 1, memBytes: 1 * (1 << 30) })
	]),
	makeProjectEntry("beta", [
		makeTask({ id: "beta-batch", priority: 50, preemptible: true, cpuCores: 1, memBytes: 1 * (1 << 30) })
	]),
	makeProjectEntry("gamma", [
		makeTask({ id: "gamma-small", priority: 20, preemptible: true, cpuCores: 1, memBytes: 1 * (1 << 30) })
	])
]);
const policyDoc = buildDefaultPolicy({
	policyId: "e2e-policy",
	overrides: {
		quotas: threeProjectQuotas(),
		admission: { ...buildDefaultPolicy().admission, maxConcurrentAdmitted: 4 }
	}
});
writeFileSync(join(resourceDir, "policy.json"), JSON.stringify(policyDoc, null, 2));
const policyStore = new PolicyStore({ dir: resourceDir, now: () => BASE_TIME });
policyStore.load();
const queue = new QueueRegistry({ dir: resourceDir, now: () => BASE_TIME });
queue.load();
console.log("host-profile.json + incidents.jsonl + projects.json + policy.json seeded; queue.json initialized (revision 1)");

const factsFor = (pressure) => {
	writeIncidents(hardwareGuardDir, [pressureTransition(pressure, pressure === "ok" ? "warn" : "ok", BASE_TIME)]);
	return collectFacts({ hardwareGuardDir, resourceDir });
};

// ── 1. ok pressure: high priority admitted first ─────────────────────────
step("1. ok pressure — enqueue 3 projects with different priorities");
for (const [projectId, taskId, priority] of [
	["gamma", "gamma-small", 20],
	["beta", "beta-batch", 50],
	["alpha", "alpha-light", 80]
]) {
	const enqueued = enqueueTask({
		policyStore,
		queue,
		facts: collectFacts({ hardwareGuardDir, resourceDir }),
		input: { projectId, taskId, priority, owner: { sessionId: "session-e2e" } },
		by: "resource_plan"
	});
	assert.equal(enqueued.ok, true, enqueued.text);
	console.log(`enqueued ${enqueued.item.id} (${projectId}/${taskId}, priority ${priority}) → revision ${enqueued.registryRevision}`);
}
const plan1 = runPlan({ policyStore, queue, facts: factsFor("ok"), by: "resource_plan", now: BASE_TIME });
assert.equal(plan1.ok, true, plan1.errors?.join("; "));
const admittedOrder = plan1.plan.decisions.admits.map((id) => queue.get(id).projectId);
assert.deepEqual(admittedOrder, ["alpha", "beta", "gamma"], "ample resources: high priority admitted first");
assert.equal(queue.list().queued.length, 0);
assert.equal(queue.list().running.length, 3);
console.log(`plan → admitted ${admittedOrder.join(", ")} (priority order); lastDecision: ${queue.list().lastDecision.action}`);

// ── 2. warn pressure: low-priority queued, running throttled ─────────────
step("2. warn pressure — owners start the tasks, then a low-priority item arrives");
for (const entry of queue.list().running) {
	queue.transition(entry.item.id, "running", { by: "resource_plan" });
}
const lowEnqueued = enqueueTask({
	policyStore,
	queue,
	facts: collectFacts({ hardwareGuardDir, resourceDir }),
	input: { projectId: "alpha", taskId: "alpha-light", priority: 20, owner: { sessionId: "session-e2e", runId: "r2" } },
	by: "resource_plan"
});
assert.equal(lowEnqueued.ok, true, lowEnqueued.text);
const plan2 = runPlan({ policyStore, queue, facts: factsFor("warn"), by: "resource_plan", now: BASE_TIME });
assert.equal(plan2.ok, true, plan2.errors?.join("; "));
const doc2 = queue.list();
assert.equal(plan2.plan.decisions.admits.length, 0, "warn denies new background work");
assert.equal(doc2.queued.length, 1, "the low-priority item stays queued at warn");
assert.ok(doc2.running.every((entry) => entry.item.status === "throttled"), "running work is throttled at warn");
console.log(`plan → no admits; ${doc2.queued[0].id} stays queued; ${doc2.running.length} running items throttled; lastDecision: ${doc2.lastDecision.action}`);

// ── 3. critical pressure: preemptible paused — never killed ──────────────
step("3. critical pressure — preemptible tasks paused, not killed");
const plan3 = runPlan({ policyStore, queue, facts: factsFor("critical"), by: "resource_plan", now: BASE_TIME });
assert.equal(plan3.ok, true, plan3.errors?.join("; "));
const doc3 = queue.list();
assert.equal(doc3.lastDecision.action, "pause");
for (const entry of doc3.running) {
	assert.notEqual(entry.item.status, "killed", "the scheduler must never mark an item killed");
	assert.equal(entry.item.status, "paused", "all three fixture tasks are preemptible → paused");
}
console.log(`plan → ${doc3.running.length} preemptible items paused (0 killed); queued stays ${doc3.queued.length}; lastDecision: ${doc3.lastDecision.action}`);

// ── 4. ok pressure: resume + admit the queued item ───────────────────────
step("4. ok pressure — resume paused work, admit the queued item");
const plan4 = runPlan({ policyStore, queue, facts: factsFor("ok"), by: "resource_plan", now: BASE_TIME });
assert.equal(plan4.ok, true, plan4.errors?.join("; "));
const doc4 = queue.list();
assert.equal(doc4.queued.length, 0);
assert.equal(doc4.lastDecision.action, "admit");
const statuses = {};
for (const entry of doc4.running) statuses[entry.item.status] = (statuses[entry.item.status] ?? 0) + 1;
assert.equal(statuses.running, 3, "paused items resume");
assert.equal(statuses.admitted, 1, "the queued item is admitted");
console.log(`plan → ${statuses.running} running, ${statuses.admitted} admitted, 0 queued; lastDecision: ${doc4.lastDecision.action}`);

// ── 5. the fact source on disk agrees with the in-memory reads ───────────
step("5. queue.json fact source verification");
const onDisk = JSON.parse(readFileSync(join(resourceDir, "queue.json"), "utf8"));
assert.equal(onDisk.revision, queue.list().revision);
assert.equal(onDisk.queued.length, 0);
assert.equal(onDisk.running.length, 4);
assert.equal(onDisk.lastDecision.revision, onDisk.revision, "lastDecision.revision matches the document revision");
assert.ok(["admit", "deny", "throttle", "pause", "resume", "reject", "noop"].includes(onDisk.lastDecision.action));
console.log(`queue.json: revision ${onDisk.revision}, capacity ${onDisk.capacity.pressure}, headroom ${onDisk.capacity.headroomCpuCores} cores`);
console.log("lastDecision chain actions:", JSON.stringify(onDisk.lastDecision));

step("E2E PLAN PASSED");
console.log("3 projects: high priority admitted first (ok), low priority queued (warn), preemptible paused (critical, 0 killed), resumed + admitted (ok). Decisions live in queue.json only.");
