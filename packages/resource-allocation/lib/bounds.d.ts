export declare const DEFAULT_PAGE_LIMITS: Readonly<Record<string, number>>;
export declare function normalizePageLimits(overrides?: Record<string, unknown>): Record<string, number>;
export declare function boundObservation(observation: Record<string, unknown>, overrides?: Record<string, unknown>, options?: { enforceByteBudget?: boolean }): Record<string, unknown>;
