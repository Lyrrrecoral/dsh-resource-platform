export declare const Config: unknown;
export declare function storageDir(home?: string): string;
export declare function schedulerStorageDir(home?: string): string;
export declare function createSchedulerManager(options: {
policyStore: unknown;
queue: unknown;
facts?: Record<string, unknown> | (() => Record<string, unknown>);
actor?: string;
}): {
plan: (options?: Record<string, unknown>) => Record<string, unknown>;
enqueue: (input: Record<string, unknown>) => Record<string, unknown>;
listQueue: () => { doc: Record<string, unknown> | null; policy: Record<string, unknown> | null };
};
export { collectFacts } from "./facts.js";
export { PolicyStore, buildDefaultPolicy, validatePolicyDoc } from "./policy.js";
export { QueueRegistry, validateQueueDoc } from "./queue.js";
export { defineResourcePlanTool, defineResourceQueueTool, renderQueueText } from "./tool.js";
