export declare const STORAGE_DIR_NAME: "resource-allocation";
export declare const LEGACY_STORAGE_DIR_NAME: "ops";
export declare const STORAGE_FACT_FILES: readonly string[];
export declare function defaultStorageDir(): string;
export declare function legacyStorageDir(): string;
export declare function writeStorageFileDurable(path: string, content: string | Uint8Array): void;
export declare function migrateLegacyStorage(options?: {
targetDir?: string;
legacyDir?: string;
files?: readonly string[];
read?: (path: string) => string | Uint8Array;
}): {
dir: string;
legacyDir: string;
migrated: string[];
existing: string[];
absent: string[];
errors: Array<{ file: string; error: string }>;
};
export declare function prepareStorage(options?: {
dir?: string | null;
legacyDir?: string | null;
migrate?: boolean;
}): {
dir: string;
legacyDir: string;
migration: ReturnType<typeof migrateLegacyStorage>;
};
