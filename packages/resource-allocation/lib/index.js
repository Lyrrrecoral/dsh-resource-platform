/**
 * resource-allocation main plugin.
 *
 * v1.0 folds the former dsh-ops project/run observer and
 * dsh-resource-scheduler queue/policy decision core into one canonical
 * package. It owns:
 *  - `$DSH_HOME/storages/resource-allocation/projects.json` (observe-only
 *    project registry, atomic durable writes, per-project CAS revisions),
 *  - `runs.json` (managed long-task runs created only by resource_run),
 *  - `queue.json` / `policy.json` (queue, priority and quota decisions; the
 *    tools only write these facts and never execute or kill anything),
 *  - `resource_run` / `resource_status` / `resource_stop` and
 *    `resource_plan` / `resource_queue` model-facing tools,
 *  - the `resourceAllocation` service (with the legacy `ops` service name as
 *    a one-release compatibility alias) consumed by the API/page row.
 *
 * Legacy storage at `$DSH_HOME/storages/ops` is merged file-by-file into the
 * canonical directory on boot when a canonical file is missing. The legacy
 * directory is never deleted or modified.
 *
 * Safety invariants are unchanged: adoption is observe-only, resource_run
 * creates only `resource-allocation-<project>-<runId>.service` transient
 * units, resource_stop is owner-session gated, and queue decisions never
 * start/stop/kill a process.
 *
 * @module resource-allocation
 */
import z from "@deepseek-ai/schemastery";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import { ensureTaskUnitsAdopted } from "./adopt.js";
import { launchRun, reconcileRuns, stopRun } from "./launch.js";
import { ProjectRegistry } from "./registry.js";
import { DEFAULT_RUNS_RETENTION_DAYS, normalizeRetentionDays, RunRegistry } from "./runs.js";
import { defineResourceRunTool, defineResourceStatusTool, defineResourceStopTool } from "./tool.js";
import { defaultStorageDir, legacyStorageDir as defaultLegacyStorageDir, prepareStorage } from "./storage.js";
import { createSchedulerManager } from "./scheduler/index.js";
import { collectFacts } from "./scheduler/facts.js";
import { PolicyStore } from "./scheduler/policy.js";
import { QueueRegistry } from "./scheduler/queue.js";
import { defineResourcePlanTool, defineResourceQueueTool } from "./scheduler/tool.js";

export const name = "resource-allocation";
export const inject = ["tools", "timer"];

/** Composition config schema; every knob is optional. */
export const Config = z.object({
enabled: z.boolean().default(true),
reconcileIntervalMs: z.number().default(5000),
planIntervalMs: z.number().default(0),
runsRetentionDays: z.number().default(DEFAULT_RUNS_RETENTION_DAYS),
storageDir: z.string(),
legacyStorageDir: z.string(),
hwGuardDir: z.string()
});

/** Canonical storage directory for every resource-allocation fact source. */
export function storageDir(home = defaultStorageDir()) {
return home;
}

/** Read-only legacy storage source (`$DSH_HOME/storages/ops`). */
export function legacyStorageDir(home = defaultLegacyStorageDir()) {
return home;
}

/** Choose the canonical hardware-guard fact directory, with one-release fallback. */
export function resolveHardwareGuardDir(explicit = null) {
if (typeof explicit === "string" && explicit.length > 0) return explicit;
const canonical = dshHomePath("storages", "hardware-guard");
const legacy = dshHomePath("storages", "hw-guard");
const hasFacts = (dir) => existsSync(join(dir, "host-profile.json")) || existsSync(join(dir, "incidents.jsonl"));
if (hasFacts(canonical) || !hasFacts(legacy)) return canonical;
return legacy;
}

function resolveStorage(config) {
return prepareStorage({
dir: typeof config?.storageDir === "string" && config.storageDir.length > 0 ? config.storageDir : null,
legacyDir: typeof config?.legacyStorageDir === "string" && config.legacyStorageDir.length > 0 ? config.legacyStorageDir : null
});
}

function normalizeReconcileInterval(value) {
return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function normalizePlanInterval(value) {
return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export function apply(ctx, config = {}) {
if (config?.enabled === false) return;

const prepared = resolveStorage(config);
const dir = prepared.dir;
const retentionDays = normalizeRetentionDays(config.runsRetentionDays, DEFAULT_RUNS_RETENTION_DAYS) ?? DEFAULT_RUNS_RETENTION_DAYS;

const registry = new ProjectRegistry({ dir });
registry.load();
const runs = new RunRegistry({ dir });
runs.load();
runs.pruneTerminalRuns({ retentionDays });

const policyStore = new PolicyStore({ dir });
policyStore.load();
const queue = new QueueRegistry({ dir });
queue.load();

// Boot-time adoption registration is idempotent and observe-only.
try {
ensureTaskUnitsAdopted(registry);
} catch {
/* the page keeps observing regardless */
}

const hwGuardDir = resolveHardwareGuardDir(config.hwGuardDir);
const prune = () => {
try {
runs.pruneTerminalRuns({ retentionDays });
} catch {
/* retention is best effort; observation must still work */
}
};

/** The manager handed to the run tools. */
const manager = {
launch: (options) => launchRun({ projects: registry, runs, ...options }),
listRuns: () => {
prune();
return runs.list();
},
reconcile: async () => {
const summary = await reconcileRuns({ runs });
prune();
return summary;
},
stop: (options) => stopRun({ runs, ...options })
};

const service = {
dir,
storageDir: dir,
legacyStorageDir: prepared.legacyDir,
migration: prepared.migration,
runsRetentionDays: retentionDays,
registry,
runs,
queue,
policyStore,
manager,
ensureAdopted: () => ensureTaskUnitsAdopted(registry)
};

const facts = () => collectFacts({ hwGuardDir, opsDir: dir, ops: service });
const schedulerManager = createSchedulerManager({
policyStore,
queue,
facts,
actor: "resource_plan"
});
service.schedulerManager = schedulerManager;

// Canonical service plus one-release compatibility service for old page
// rows. Neither exposes live process handles.
ctx.provide("resourceAllocation", service);
if (typeof ctx.get !== "function" || ctx.get("ops") === undefined || ctx.get("ops") === null) {
ctx.provide("ops", service);
}
if (typeof ctx.get !== "function" || ctx.get("scheduler") === undefined || ctx.get("scheduler") === null) {
	ctx.provide("scheduler", { queue, policyStore, manager: schedulerManager });
}

// ── model-facing tools (reversible registration) ──────────────────────
ctx.effect(() => {
const disposers = [
ctx.tools.register(defineResourceRunTool({ manager })),
ctx.tools.register(defineResourceStatusTool({ manager })),
ctx.tools.register(defineResourceStopTool({ manager })),
ctx.tools.register(defineResourcePlanTool({ manager: schedulerManager })),
ctx.tools.register(defineResourceQueueTool({ manager: schedulerManager }))
];
return () => {
for (const dispose of disposers) dispose();
};
}, "resource-allocation: tools");

// ── periodic reconciliation and retention ─────────────────────────────
const reconcileIntervalMs = normalizeReconcileInterval(config.reconcileIntervalMs);
if (reconcileIntervalMs > 0) {
ctx.effect(() => ctx.setInterval(() => {
reconcileRuns({ runs }).then(() => prune()).catch(() => {
/* a transient systemd/journal error must not kill the sweep */
});
}, reconcileIntervalMs), "resource-allocation: run-reconciler");
}

// ── optional periodic planner (off by default; decisions only) ────────
const planIntervalMs = normalizePlanInterval(config.planIntervalMs);
if (planIntervalMs > 0) {
ctx.effect(() => ctx.setInterval(() => {
try {
schedulerManager.plan({ by: "resource-allocation" });
} catch {
/* a transient fact-source error must not kill the sweep */
}
}, planIntervalMs), "resource-allocation: planner");
}
}
