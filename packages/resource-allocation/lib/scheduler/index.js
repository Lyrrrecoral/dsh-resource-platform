/**
 * Scheduler capability set folded into resource-allocation v1.0.
 *
 * This is intentionally a library module, not a second profile row: the
 * resource-allocation main plugin owns the PolicyStore and QueueRegistry and
 * registers `resource_plan` / `resource_queue` alongside the run tools. The
 * `ctx.provide("scheduler", ...)` compatibility service and the persisted
 * fact sources remain available to sibling rows.
 *
 * Boundary: these tools write queue.json (and initialize policy.json) only.
 * They never start, stop, signal, throttle or kill a process. Kill remains
 * hardware-guard's judgment; execution of queue decisions is out of scope.
 *
 * @module resource-allocation/scheduler
 */
import z from "@deepseek-ai/schemastery";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import { enqueueTask } from "./enqueue.js";
import { runPlan } from "./plan.js";

export { collectFacts } from "./facts.js";
export { PolicyStore, buildDefaultPolicy, validatePolicyDoc } from "./policy.js";
export { QueueRegistry, validateQueueDoc } from "./queue.js";
export { defineResourcePlanTool, defineResourceQueueTool, renderQueueText } from "./tool.js";

/** Config fragment retained for callers that compose the scheduler pieces. */
export const Config = z.object({
enabled: z.boolean().default(true),
planIntervalMs: z.number().default(0)
});

/** Canonical scheduler fact directory (`queue.json` + `policy.json`). */
export function storageDir(home = dshHomePath("storages", "resource-allocation")) {
return home;
}

/** Alias with an explicit scheduler-era name. */
export function schedulerStorageDir(home) {
return storageDir(home);
}

/**
 * Build the scheduler manager consumed by the two model-facing tools. `facts`
 * may be a snapshot or a zero-argument function producing a fresh snapshot.
 * The returned methods never mutate the registry, policy or fact files
 * directly: runPlan/enqueueTask perform their own validated CAS writes.
 */
export function createSchedulerManager({ policyStore, queue, facts, actor = "resource_plan" } = {}) {
const factSnapshot = () => typeof facts === "function" ? facts() : facts ?? {};
return {
plan(options = {}) {
return runPlan({
policyStore,
queue,
facts: factSnapshot(),
by: options.by ?? actor,
dryRun: options.dryRun === true
});
},
enqueue(input) {
return enqueueTask({
policyStore,
queue,
facts: factSnapshot(),
input,
by: "resource_queue",
allowUnregistered: true
});
},
listQueue() {
return { doc: queue.list(), policy: policyStore.get() };
}
};
}
