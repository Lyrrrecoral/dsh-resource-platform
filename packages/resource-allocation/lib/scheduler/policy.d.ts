export declare const POLICY_SCHEMA_VERSION: number;
export declare const POLICY_FILE_NAME: string;
export declare const DEFAULT_POLICY_ID: string;
export declare function validatePolicyDoc(doc: unknown): { ok: boolean; errors: string[] };
export declare function buildDefaultPolicy(options?: Record<string, unknown>): Record<string, unknown>;
export declare class PolicyStore {
constructor(options?: { dir: string; now?: () => number; defaults?: Record<string, unknown> | null });
readonly dir: string;
readonly path: string;
load(): { doc: Record<string, unknown> | null; path: string; error?: string };
get(): Record<string, unknown> | null;
save(doc: Record<string, unknown>): Record<string, unknown>;
}
