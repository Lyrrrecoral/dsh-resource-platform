/**
 * Canonical storage location and safe one-way migration from the legacy
 * `hw-guard` directory.
 *
 * v1.0 renames the plugin to `hardware-guard`. Existing installations may
 * still have facts under `$DSH_HOME/storages/hw-guard`; when and only when
 * the canonical directory does not yet exist, its whole contents are copied
 * into a sibling staging directory and atomically renamed into place. The
 * legacy directory is never modified or deleted, so a downgrade or manual
 * recovery remains possible.
 *
 * Safety properties:
 *  - canonical always wins when both directories exist;
 *  - migration is idempotent (the canonical directory short-circuits every
 *    later call);
 *  - symlinks and special files are skipped, never followed;
 *  - a failed copy leaves the canonical directory ABSENT rather than exposing
 *    a partial fact set or masking a retry on the next boot;
 *  - every write stays below the canonical storage directory's parent.
 *
 * @module hardware-guard/storage
 */
import {
	chmodSync,
	closeSync,
	copyFileSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	utimesSync
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";

export const CANONICAL_STORAGE_NAME = "hardware-guard";
/** Historical directory name; kept only for the one-way migration above. */
export const LEGACY_STORAGE_NAME = "hw-guard";

const MAX_MIGRATION_WARNINGS = 20;

/** Resolve canonical and legacy directories below a DSH home. */
export function storagePaths(dshHome) {
	if (typeof dshHome !== "string" || dshHome.length === 0) {
		throw new TypeError("storagePaths requires a non-empty DSH home path");
	}
	const storages = join(dshHome, "storages");
	return {
		canonicalDir: join(storages, CANONICAL_STORAGE_NAME),
		legacyDir: join(storages, LEGACY_STORAGE_NAME)
	};
}

function lstatOrNull(path) {
	try {
		return lstatSync(path);
	} catch (error) {
		if (error?.code === "ENOENT") return null;
		throw error;
	}
}

/** Describe whether a path exists and resolves to a directory (symlinks allowed). */
function directoryStatus(path) {
	const info = lstatOrNull(path);
	if (info === null) return { exists: false, directory: false, symlink: false };
	let directory = info.isDirectory();
	if (info.isSymbolicLink()) {
		try {
			directory = statSync(path).isDirectory();
		} catch {
			directory = false;
		}
	}
	return { exists: true, directory, symlink: info.isSymbolicLink() };
}

function copyFileDurably(source, target) {
	const info = lstatSync(source);
	if (!info.isFile()) throw new Error(`refusing non-regular file ${source}`);
	copyFileSync(source, target);
	try {
		chmodSync(target, info.mode & 0o777);
	} catch {
		/* best effort: the fact content matters more than exact mode bits */
	}
	const fd = openSync(target, "r");
	try {
		fsyncSync(fd);
	} catch {
		/* best effort: rename still gives readers a complete file */
	} finally {
		closeSync(fd);
	}
	try {
		utimesSync(target, info.atime, info.mtime);
	} catch {
		/* retention falls back to migration time when timestamps are unsupported */
	}
	return info.size;
}

function copyTree(source, target, state, isRoot = false) {
	const info = lstatSync(source);
	if (info.isSymbolicLink()) {
		if (isRoot) throw new Error(`legacy storage changed into a symlink: ${source}`);
		if (state.warnings.length < MAX_MIGRATION_WARNINGS) state.warnings.push(`skipped symlink ${source}`);
		return state;
	}
	if (info.isDirectory()) {
		mkdirSync(target, { recursive: true });
		for (const entry of readdirSync(source, { withFileTypes: true })) {
			const childSource = join(source, entry.name);
			const childTarget = join(target, entry.name);
			if (entry.isSymbolicLink()) {
				if (state.warnings.length < MAX_MIGRATION_WARNINGS) state.warnings.push(`skipped symlink ${childSource}`);
				continue;
			}
			// Re-lstat each child to close the readdir→copy race; symlinks are
			// checked again by copyTree before any data is read.
			copyTree(childSource, childTarget, state, false);
		}
		try {
			utimesSync(target, info.atime, info.mtime);
		} catch {
			/* optional metadata only */
		}
		return state;
	}
	if (info.isFile()) {
		state.copiedFiles += 1;
		state.copiedBytes += copyFileDurably(source, target);
		return state;
	}
	if (state.warnings.length < MAX_MIGRATION_WARNINGS) {
		state.warnings.push(`skipped unsupported file type ${source}`);
	}
	return state;
}

function baseResult(canonicalDir, legacyDir) {
	return {
		dir: canonicalDir,
		canonicalDir,
		legacyDir,
		migrated: false,
		initialized: false,
		legacyPresent: false,
		copiedFiles: 0,
		copiedBytes: 0,
		warnings: [],
		error: null
	};
}

/**
 * Ensure the canonical storage directory exists, copying legacy facts first
 * when the canonical directory is absent. This function never throws: plugin
 * boot must continue even when storage is read-only or a legacy tree is
 * unreadable. The caller can surface `error` as an incident.
 *
 * @param {{canonicalDir: string, legacyDir: string}} input
 * @returns {{
 *   dir: string, canonicalDir: string, legacyDir: string,
 *   migrated: boolean, initialized: boolean, legacyPresent: boolean,
 *   copiedFiles: number, copiedBytes: number, warnings: string[],
 *   error: string|null
 * }}
 */
export function migrateLegacyStorage({ canonicalDir, legacyDir } = {}) {
	if (typeof canonicalDir !== "string" || canonicalDir.length === 0) {
		return {
			...baseResult(String(canonicalDir ?? ""), String(legacyDir ?? "")),
			error: "canonical storage directory is not configured"
		};
	}
	const result = baseResult(canonicalDir, typeof legacyDir === "string" ? legacyDir : "");
	try {
		const canonical = directoryStatus(canonicalDir);
		if (canonical.exists) {
			// A user-managed canonical symlink is accepted only when it resolves
			// to a real directory. A dangling/file target fails closed below.
			if (!canonical.directory) {
				return { ...result, error: "canonical storage path exists but is not a directory" };
			}
			if (canonical.symlink) result.warnings.push("canonical storage path is a symlink to a directory");
			if (typeof legacyDir === "string" && legacyDir.length > 0) {
				result.legacyPresent = existsSync(legacyDir);
			}
			return result;
		}

		const legacyInfo = typeof legacyDir === "string" && legacyDir.length > 0 ? lstatOrNull(legacyDir) : null;
		if (legacyInfo === null) {
			try {
				mkdirSync(canonicalDir, { recursive: true });
				return { ...result, initialized: true };
			} catch (error) {
				return { ...result, error: `could not create canonical storage: ${String(error?.message ?? error)}` };
			}
		}
		result.legacyPresent = true;
		if (!legacyInfo.isDirectory() || legacyInfo.isSymbolicLink()) {
			// Leave canonical absent: this is a retryable configuration error, not
			// evidence that migration has already completed.
			return { ...result, error: "legacy storage path exists but is not a directory" };
		}

		mkdirSync(dirname(canonicalDir), { recursive: true });
		const staging = join(dirname(canonicalDir), `.${basename(canonicalDir)}.migrating-${process.pid}-${randomUUID()}`);
		try {
			mkdirSync(staging, { recursive: true });
			const copied = copyTree(legacyDir, staging, result, true);
			try {
				renameSync(staging, canonicalDir);
			} catch (error) {
				// A concurrent process may have won the race. Canonical wins and
				// the staging copy is discarded; never merge or overwrite it.
				const appeared = directoryStatus(canonicalDir);
				if (appeared.exists && appeared.directory) {
					rmSync(staging, { recursive: true, force: true });
					return {
						...result,
						migrated: false,
						copiedFiles: 0,
						copiedBytes: 0,
						error: null,
						warnings: [...result.warnings, "canonical directory appeared during migration; kept canonical"]
					};
				}
				throw error;
			}
			return { ...result, ...copied, migrated: true };
		} catch (error) {
			try {
				rmSync(staging, { recursive: true, force: true });
			} catch {
				/* best effort */
			}
			// Do NOT create an empty canonical directory on failure: it would make
			// the next boot short-circuit and permanently strand the legacy facts.
			return { ...result, error: `legacy storage migration failed: ${String(error?.message ?? error)}` };
		}
	} catch (error) {
		return { ...result, error: String(error?.message ?? error) };
	}
}
