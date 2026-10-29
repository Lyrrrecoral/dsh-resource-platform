export declare function callerSessionId(exec: unknown): string | null;
export declare function renderQueueText(view: Record<string, unknown>): string;
export declare function defineResourcePlanTool(options: { manager: Record<string, unknown> }): { name: string; execute: (args: Record<string, unknown>, exec?: unknown) => Promise<unknown> };
export declare function defineResourceQueueTool(options: { manager: Record<string, unknown> }): { name: string; execute: (args: Record<string, unknown>, exec?: unknown) => Promise<unknown> };
