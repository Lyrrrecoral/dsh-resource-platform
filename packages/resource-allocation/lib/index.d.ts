export declare const name: "resource-allocation";
export declare const inject: readonly ["tools", "timer"];
export declare const Config: unknown;
export declare function storageDir(home?: string): string;
export declare function legacyStorageDir(home?: string): string;
export declare function resolveHardwareGuardDir(explicit?: string | null): string;
export declare function apply(ctx: unknown, config?: Record<string, unknown>): void;
