/**
 * Canonical storage layout and one-way legacy migration.
 *
 * v1.0 renamed the product from dsh-ops to resource-allocation. Runtime facts
 * now live under `$DSH_HOME/storages/resource-allocation`; the old
 * `$DSH_HOME/storages/ops` directory is only a migration source. Migration is
 * deliberately conservative:
 *
 *  - a file is copied only when its canonical destination does not exist;
 *  - canonical files always win, including when both copies exist;
 *  - the legacy file is opened read-only and is never renamed or deleted;
 *  - writes are atomic + durable (temp file, fsync, rename).
 *
 * Callers must migrate BEFORE constructing a registry/load, because load()
 * creates an empty canonical file when a file is absent.
 *
 * @module resource-allocation/storage
 */
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";

/** Canonical storage directory name below `$DSH_HOME/storages`. */
export const STORAGE_DIR_NAME = "resource-allocation";
/** Legacy storage directory name below `$DSH_HOME/storages`. */
export const LEGACY_STORAGE_DIR_NAME = "ops";
/** Every fact file the merge owns. Other legacy files are left untouched. */
export const STORAGE_FACT_FILES = Object.freeze(["projects.json", "runs.json", "queue.json", "policy.json"]);

/** Canonical storage directory: `$DSH_HOME/storages/resource-allocation`. */
export function defaultStorageDir() {
return dshHomePath("storages", STORAGE_DIR_NAME);
}

/** Read-only migration source: `$DSH_HOME/storages/ops`. */
export function legacyStorageDir() {
return dshHomePath("storages", LEGACY_STORAGE_DIR_NAME);
}

/**
 * Atomic durable write used by migration. This intentionally mirrors the
 * registry writer but keeps `storage.js` dependency-free so it can run before
 * any registry instance exists.
 */
export function writeStorageFileDurable(path, content) {
const data = Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf8");
const tmp = `${path}.${process.pid}.${Date.now()}.migration.tmp`;
mkdirSync(dirname(path), { recursive: true });
let fd = -1;
try {
fd = openSync(tmp, "w");
writeFileSync(fd, data);
try {
fsyncSync(fd);
} catch {
/* fsync is best effort on filesystems that do not support it */
}
} finally {
if (fd >= 0) {
try {
closeSync(fd);
} catch {
/* best effort */
}
}
}
renameSync(tmp, path);
const verified = readFileSync(path);
if (!verified.equals(data)) throw new Error(`durable write verification failed for ${path}: content mismatch after rename`);
}

/**
 * Install a fully written temp file at `path` without ever replacing an
 * existing path. Hard-linking the temp inode is an atomic create-if-absent on
 * POSIX filesystems, closing the check-then-rename race between concurrent
 * migrations/writers.
 */
function installStorageFileNoClobber(path, content) {
const data = Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf8");
const tmp = `${path}.${process.pid}.${Date.now()}.migration.tmp`;
mkdirSync(dirname(path), { recursive: true });
let fd = -1;
try {
fd = openSync(tmp, "wx");
writeFileSync(fd, data);
try {
fsyncSync(fd);
} catch {
/* best effort */
}
} finally {
if (fd >= 0) {
try {
closeSync(fd);
} catch {
/* best effort */
}
}
}
try {
linkSync(tmp, path);
} catch (error) {
try { unlinkSync(tmp); } catch { /* best effort */ }
throw error;
}
try {
const verified = readFileSync(path);
if (!verified.equals(data)) {
try { unlinkSync(path); } catch { /* best effort */ }
throw new Error(`durable install verification failed for ${path}: content mismatch`);
}
} finally {
try { unlinkSync(tmp); } catch { /* best effort */ }
}
}

function isFile(path) {
try {
return statSync(path).isFile();
} catch {
return false;
}
}

/**
 * Copy missing fact files from the legacy storage directory into the
 * canonical directory. Idempotent, canonical-first, and non-destructive for
 * the legacy directory.
 *
 * @param {object} [options]
 * @param {string} [options.targetDir] canonical directory
 * @param {string} [options.legacyDir] legacy migration source
 * @param {readonly string[]} [options.files] fact file names (tests may narrow)
 * @param {(path: string) => string} [options.read] injectable reader
 * @returns {{dir: string, legacyDir: string, migrated: string[], existing: string[], absent: string[], errors: Array<{file: string, error: string}>}}
 */
export function migrateLegacyStorage({
targetDir = defaultStorageDir(),
legacyDir = legacyStorageDir(),
files = STORAGE_FACT_FILES,
read = (path) => readFileSync(path)
} = {}) {
const migrated = [];
const existing = [];
const absent = [];
const errors = [];
mkdirSync(targetDir, { recursive: true });
for (const file of files) {
if (typeof file !== "string" || file.length === 0 || basename(file) !== file || file === "." || file === "..") {
errors.push({ file: String(file), error: "invalid fact file name (basename required)" });
continue;
}
const source = join(legacyDir, file);
const target = join(targetDir, file);
if (isFile(target)) {
existing.push(file);
continue;
}
if (!isFile(source)) {
absent.push(file);
continue;
}
try {
installStorageFileNoClobber(target, read(source));
migrated.push(file);
} catch (error) {
if (error?.code === "EEXIST" && isFile(target)) existing.push(file);
else errors.push({ file, error: String(error?.message ?? error) });
}
}
return { dir: targetDir, legacyDir, migrated, existing, absent, errors };
}

/**
 * Resolve and prepare the storage directory for an apply() call. `dir` is an
 * explicit test/operator override; otherwise the canonical default is used.
 * The legacy directory is always a read-only merge source.
 */
export function prepareStorage({ dir = null, legacyDir = null, migrate = true } = {}) {
const targetDir = typeof dir === "string" && dir.length > 0 ? dir : defaultStorageDir();
const sourceDir = typeof legacyDir === "string" && legacyDir.length > 0 ? legacyDir : legacyStorageDir();
const migration = migrate ? migrateLegacyStorage({ targetDir, legacyDir: sourceDir }) : {
dir: targetDir,
legacyDir: sourceDir,
migrated: [],
existing: [],
absent: [],
errors: []
};
return { dir: targetDir, legacyDir: sourceDir, migration };
}
