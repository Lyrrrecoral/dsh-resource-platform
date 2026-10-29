export declare const QUEUE_SCHEMA_VERSION: number;
export declare const QUEUE_FILE_NAME: string;
export declare const DEFAULT_QUEUE_LIMIT: number;
export declare const ITEM_STATUSES: readonly string[];
export declare const TERMINAL_STATUSES: readonly string[];
export declare const ALLOCATED_STATUSES: readonly string[];
export declare const ACTIVE_STATUSES: readonly string[];
export declare function isAllowedTransition(from: string, to: string): boolean;
export declare function validateOwner(owner: unknown, errors: string[], where: string): void;
export declare function validateRequest(request: unknown, errors: string[], where: string): void;
export declare function validateQueueItem(item: unknown, errors: string[], where?: string): void;
export declare function validateAllocation(allocation: unknown, errors: string[], where: string): void;
export declare function validateRunningEntry(entry: unknown, errors: string[], where?: string): void;
export declare function validateQueueDoc(doc: unknown): { ok: boolean; errors: string[] };
export declare function emptyQueueDoc(now?: number): Record<string, unknown>;
export declare function makeItemId(now?: number): string;
export declare function normalizeItem(input: Record<string, unknown>, options?: { now?: number }): Record<string, unknown>;
export declare function activeItems(doc: Record<string, unknown>): Array<Record<string, unknown>>;
export declare class QueueRegistry {
constructor(options?: { dir: string; now?: () => number });
readonly dir: string;
readonly path: string;
load(): { doc: Record<string, unknown> | null; path: string; error?: string };
list(): Record<string, unknown> | null;
get(itemId: string): Record<string, unknown> | null;
enqueue(input: Record<string, unknown>, options?: Record<string, unknown>): Record<string, unknown>;
transition(itemId: string, toStatus: string, options?: Record<string, unknown>): Record<string, unknown>;
mutate(mutator: (doc: Record<string, unknown>) => unknown, options?: Record<string, unknown>): Record<string, unknown>;
}
