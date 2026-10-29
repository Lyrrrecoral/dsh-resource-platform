/**
 * Cleanup plan scan/confirm actions shared by the model tool and the
 * `/resources/hardware` API surface.
 *
 * The probe NEVER deletes during scan. A plan stores the exact candidate
 * paths; confirm touches only paths that are present in a live plan, are
 * regular files, are not symlinks, and remain inside the plan's roots.
 *
 * v0.6.0 safety upgrade:
 *  - the default action is a SOFT delete: the file is MOVED into
 *    `<storageDir>/trash/<planId>/`, so a wrong click is recoverable by hand
 *    (the response and the incident record both carry the trash path);
 *  - `cleanupProbe.softDelete: false` restores the hard unlink behaviour;
 *  - every confirmation writes one `cleanup-confirm` incident listing the
 *    audit trail (original path, size, trash path, outcome) — capped so a
 *    huge plan cannot flood incidents.jsonl.
 *
 * @module hardware-guard/cleanup-actions
 */
import { randomUUID } from "node:crypto";
import { lstatSync, opendirSync, rmSync } from "node:fs";
import { copyFile, lstat, mkdir, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { recordIncident } from "./incidents.js";
import { scanCleanupCandidates } from "./probe.js";
import { DEFAULTS, shared } from "./state.js";

const MAX_PLANS = 5;
/** Audit cap: incidents.jsonl is a log, not a file listing. */
const MAX_AUDIT_ENTRIES = 50;
/** Hard cap on direct trash entries examined/removed by one bounded sweep. */
export const MAX_TRASH_ENTRIES_PER_SWEEP = 256;
const MAX_RETENTION_DAYS = 3650;
const MAX_EPOCH_MS = 8640000000000000;
const MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;

function validRetentionNow(value) {
	return typeof value === "number"
		&& Number.isSafeInteger(value)
		&& value > 0
		&& value <= MAX_EPOCH_MS
		&& value <= Date.now() + MAX_FUTURE_SKEW_MS;
}

function probeConfig(overrides = {}) {
	return { ...(shared.config?.cleanupProbe ?? {}), ...overrides };
}

function trashRootFor(storageDir) {
	return typeof storageDir === "string" && storageDir.length > 0 ? join(storageDir, "trash") : null;
}

/** Trash root for soft deletes, or null when canonical storage is unavailable. */
export function trashRoot() {
	return trashRootFor(shared.storageDir);
}

/**
 * v1.0 bounded trash retention.
 *
 * Soft-deleted files live under `<storageDir>/trash/<planId>/`. This sweep
 * only examines direct children of that root, only deletes directories whose
 * own mtime is older than `cleanupProbe.trashRetentionDays` (default 7), and
 * never follows symlinks. Each invocation examines at most
 * MAX_TRASH_ENTRIES_PER_SWEEP direct entries, so a hostile or accidentally
 * enormous trash tree cannot turn boot into an unbounded filesystem walk.
 * Plan-directory mtimes are refreshed whenever files move in, so retention is
 * measured from the last soft-delete activity rather than plan creation.
 *
 * `trashRetentionDays <= 0` disables deletion (a safe explicit opt-out).
 * Synchronous by design: boot calls it once and must finish deterministically
 * before recording the boot incident.
 */
export function cleanupTrashRetention({ storageDir = shared.storageDir, now = Date.now(), maxEntries = MAX_TRASH_ENTRIES_PER_SWEEP, record = true } = {}) {
	const root = trashRootFor(storageDir);
	if (root === null) {
		return { ok: true, root: null, retentionDays: null, cutoffMs: null, scanned: 0, removed: 0, removedPaths: [], skipped: 0, scanLimited: false, errors: [], disabled: "no-storage-dir" };
	}
	if (!validRetentionNow(now)) {
		// A null/zero/far-future clock could otherwise make every mtime compare
		// as expired. Treat any implausible clock as a hard no-op.
		const result = { ok: false, root, retentionDays: null, cutoffMs: null, scanned: 0, removed: 0, removedPaths: [], skipped: 0, scanLimited: false, errors: ["now must be a valid epoch-ms timestamp within 24h of the current clock"] };
		if (record) {
			try {
				recordIncident("trash-retention-error", { error: result.errors[0], root });
			} catch {
				/* retention failures never escape the sweep */
			}
		}
		return result;
	}
	const nowMs = now;
	const configured = shared.config?.cleanupProbe?.trashRetentionDays ?? DEFAULTS.cleanupProbe.trashRetentionDays;
	const requestedDays = Number(configured);
	if (!Number.isFinite(requestedDays) || requestedDays <= 0) {
		return { ok: true, root, retentionDays: null, cutoffMs: null, scanned: 0, removed: 0, removedPaths: [], skipped: 0, scanLimited: false, errors: [], disabled: "retention-disabled" };
	}
	const retentionDays = Math.min(requestedDays, MAX_RETENTION_DAYS);
	const cutoffMs = nowMs - Math.floor(retentionDays * 86400000);
	// Callers may lower the bound for tests/emergency use, but never raise it.
	const limit = Number.isInteger(maxEntries) && maxEntries > 0
		? Math.min(maxEntries, MAX_TRASH_ENTRIES_PER_SWEEP)
		: MAX_TRASH_ENTRIES_PER_SWEEP;

	let rootInfo;
	try {
		rootInfo = lstatSync(root);
	} catch (error) {
		if (error?.code === "ENOENT") {
			return { ok: true, root, retentionDays, cutoffMs, scanned: 0, removed: 0, removedPaths: [], skipped: 0, scanLimited: false, errors: [] };
		}
		return { ok: false, root, retentionDays, cutoffMs, scanned: 0, removed: 0, removedPaths: [], skipped: 0, scanLimited: false, errors: [String(error?.message ?? error)] };
	}
	if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
		return { ok: false, root, retentionDays, cutoffMs, scanned: 0, removed: 0, removedPaths: [], skipped: 0, scanLimited: false, errors: ["trash root is not a real directory; refusing to sweep"] };
	}

	const result = { ok: true, root, retentionDays, cutoffMs, scanned: 0, removed: 0, removedPaths: [], skipped: 0, scanLimited: false, errors: [] };
	let directory;
	try {
		directory = opendirSync(root);
		while (result.scanned < limit) {
			const entry = directory.readSync();
			if (entry === null) break;
			result.scanned += 1;
			if (entry.isSymbolicLink()) {
				result.skipped += 1;
				continue;
			}
			const entryPath = join(root, entry.name);
			let info;
			try {
				info = lstatSync(entryPath);
			} catch (error) {
				if (error?.code !== "ENOENT" && result.errors.length < 10) result.errors.push(`${entry.name}: ${String(error?.message ?? error)}`);
				continue;
			}
			// Only real directories created by the soft-delete path are eligible.
			if (!info.isDirectory() || info.isSymbolicLink()) {
				result.skipped += 1;
				continue;
			}
			if (!Number.isFinite(info.mtimeMs) || info.mtimeMs >= cutoffMs) continue;
			try {
				rmSync(entryPath, { recursive: true, force: false, maxRetries: 2 });
				result.removed += 1;
				if (result.removedPaths.length < 20) result.removedPaths.push(entry.name);
			} catch (error) {
				if (result.errors.length < 10) result.errors.push(`${entry.name}: ${String(error?.message ?? error)}`);
			}
		}
		// Probe one extra entry to report whether the bound truncated the sweep.
		if (result.scanned >= limit && directory.readSync() !== null) result.scanLimited = true;
	} catch (error) {
		result.ok = false;
		if (result.errors.length < 10) result.errors.push(String(error?.message ?? error));
	} finally {
		try {
			directory?.closeSync();
		} catch {
			/* already closed */
		}
	}

	if (record && (result.removed > 0 || result.errors.length > 0)) {
		recordIncident("trash-retention", {
			retentionDays: result.retentionDays,
			scanned: result.scanned,
			removed: result.removed,
			removedPaths: result.removedPaths,
			scanLimited: result.scanLimited,
			errors: result.errors
		});
	}
	return result;
}

function rememberPlan(plan) {
	if (!(shared.cleanupPlans instanceof Map)) shared.cleanupPlans = new Map();
	shared.cleanupPlans.set(plan.id, plan);
	while (shared.cleanupPlans.size > MAX_PLANS) {
		const oldest = shared.cleanupPlans.keys().next().value;
		if (oldest === undefined) break;
		shared.cleanupPlans.delete(oldest);
	}
	shared.cleanupLastPlan = plan;
	return plan;
}

/** Scan configured project roots and return a read-only cleanup plan. */
export async function performCleanupScan(overrides = {}) {
	if (typeof shared.storageDir !== "string" || shared.storageDir.length === 0) {
		return { ok: false, code: "no-storage", error: "canonical storage is unavailable; cleanup is disabled until storage migration succeeds" };
	}
	try {
		cleanupTrashRetention();
	} catch {
		/* retention is advisory and must never block scanning */
	}
	const config = probeConfig(overrides);
	if (config.enabled !== true) {
		return { ok: false, code: "disabled", error: "cleanup probe is disabled; set cleanupProbe.enabled=true and cleanupProbe.roots in the profile" };
	}
	if (!Array.isArray(config.roots) || config.roots.length === 0) {
		return { ok: false, code: "no-roots", error: "cleanup probe has no configured roots" };
	}
	const result = await scanCleanupCandidates(config);
	const plan = rememberPlan({
		id: randomUUID(),
		generatedAt: Date.now(),
		roots: result.roots,
		candidates: result.candidates,
		totalBytes: result.totalBytes,
		scannedFiles: result.scannedFiles,
		skippedDirs: result.skippedDirs ?? 0,
		excludedDirs: result.excludedDirs ?? [],
		truncated: result.truncated,
		errors: result.errors,
		softDelete: config.softDelete !== false,
		status: "pending"
	});
	recordIncident("cleanup-scan", {
		planId: plan.id,
		candidates: plan.candidates.length,
		totalBytes: plan.totalBytes,
		roots: plan.roots,
		truncated: plan.truncated,
		skippedDirs: plan.skippedDirs
	});
	return { ok: true, plan };
}

function inside(root, path) {
	const normalizedRoot = root.endsWith(sep) ? root : root + sep;
	return path === root || path.startsWith(normalizedRoot);
}

/**
 * Move one file into the plan's trash directory. `rename` is the fast path;
 * a cross-device root (EXDEV) falls back to copy + unlink so soft delete
 * still works when projects live on another filesystem.
 */
async function trashFile(path, planId, index, sizeBytes) {
	const dir = join(trashRoot(), planId);
	await mkdir(dir, { recursive: true });
	const target = join(dir, `${String(index).padStart(3, "0")}-${basename(path)}`);
	try {
		await rename(path, target);
	} catch (error) {
		if (error?.code !== "EXDEV") throw error;
		await copyFile(path, target);
		await unlink(path);
	}
	return { path, sizeBytes, trashPath: target };
}

/** Delete (or soft-delete) the explicitly selected, plan-listed candidates. */
export async function performCleanupConfirm({ planId, paths = [], mode = null } = {}) {
	if (typeof shared.storageDir !== "string" || shared.storageDir.length === 0) {
		return { ok: false, code: "no-storage", error: "canonical storage is unavailable; cleanup confirmation is disabled" };
	}
	if (typeof planId !== "string" || planId.length === 0) {
		return { ok: false, code: "bad-plan", error: "planId is required" };
	}
	if (!(shared.cleanupPlans instanceof Map)) {
		return { ok: false, code: "no-plan", error: "no cleanup plan is loaded" };
	}
	const plan = shared.cleanupPlans.get(planId);
	if (plan === undefined) return { ok: false, code: "unknown-plan", error: "cleanup plan not found or expired" };
	if (plan.status !== "pending") return { ok: false, code: "already-used", error: `cleanup plan already ${plan.status}` };
	const requested = Array.isArray(paths) ? paths.filter((entry) => typeof entry === "string") : [];
	if (requested.length === 0) return { ok: false, code: "no-files", error: "no files selected" };

	const soft = mode === "trash" ? true : mode === "permanent" ? false : plan.softDelete !== false;
	const byPath = new Map(plan.candidates.map((candidate) => [candidate.path, candidate]));
	const removed = [];
	const failed = [];
	for (const rawPath of requested) {
		const candidate = byPath.get(rawPath);
		if (candidate === undefined) {
			failed.push({ path: rawPath, error: "not in plan" });
			continue;
		}
		try {
			const resolved = resolve(rawPath);
			const rootReal = await realpath(candidate.root);
			const pathReal = await realpath(dirname(resolved));
			if (!inside(rootReal, pathReal) || !inside(rootReal, resolved)) {
				failed.push({ path: rawPath, error: "outside plan root" });
				continue;
			}
			const info = await lstat(resolved);
			if (info.isSymbolicLink()) {
				failed.push({ path: rawPath, error: "symlink refused" });
				continue;
			}
			if (!info.isFile()) {
				failed.push({ path: rawPath, error: "not a regular file" });
				continue;
			}
			if (soft) {
				removed.push(await trashFile(resolved, plan.id, removed.length, candidate.sizeBytes));
			} else {
				await unlink(resolved);
				removed.push({ path: rawPath, sizeBytes: candidate.sizeBytes, trashPath: null });
			}
		} catch (error) {
			failed.push({ path: rawPath, error: String(error?.message ?? error) });
		}
	}
	if (removed.length === 0 && failed.length > 0) {
		plan.status = "pending";
	} else {
		plan.status = failed.length > 0 ? "partial" : "completed";
	}
	plan.confirmedAt = Date.now();
	plan.mode = soft ? "trash" : "unlink";
	plan.deleted = removed;
	plan.failed = failed;
	recordIncident("cleanup-confirm", {
		planId: plan.id,
		mode: plan.mode,
		deleted: removed.length,
		failed: failed.length,
		bytesFreed: removed.reduce((sum, item) => sum + item.sizeBytes, 0),
		trashDir: soft ? join(trashRoot(), plan.id) : null,
		// audit trail (capped): what was selected, what happened, where it went
		audit: removed.slice(0, MAX_AUDIT_ENTRIES).map((item) => ({
			path: item.path,
			sizeBytes: item.sizeBytes,
			trashPath: item.trashPath ?? null
		})),
		auditTruncated: removed.length > MAX_AUDIT_ENTRIES,
		failures: failed.slice(0, MAX_AUDIT_ENTRIES).map((item) => ({ path: item.path, error: item.error }))
	});
	return {
		ok: true,
		mode: plan.mode,
		deleted: removed,
		trashed: soft ? removed : [],
		failed,
		trashDir: soft ? join(trashRoot(), plan.id) : null,
		plan
	};
}

/** Recursively sum regular-file bytes without following symlinks. */
function directoryBytes(path, state) {
let directory;
try {
directory = opendirSync(path);
} catch {
return;
}
try {
while (state.entries < state.limit) {
const entry = directory.readSync();
if (entry === null) break;
state.entries += 1;
if (entry.isSymbolicLink()) continue;
const child = join(path, entry.name);
let info;
try {
info = lstatSync(child);
} catch {
continue;
}
if (info.isSymbolicLink()) continue;
if (info.isDirectory()) directoryBytes(child, state);
else if (info.isFile()) {
state.files += 1;
state.bytes += info.size;
}
}
if (state.entries >= state.limit) state.truncated = true;
} catch {
state.errors += 1;
} finally {
try {
directory?.closeSync();
} catch {
/* already closed */
}
}
}

/**
 * Bounded read-only summary of the soft-delete trash.
 * Only direct child directories are treated as cleanup plans; files and
 * symlinks in the trash root are ignored and never followed.
 */
export function cleanupTrashSummary({ storageDir = shared.storageDir, maxEntries = MAX_TRASH_ENTRIES_PER_SWEEP } = {}) {
const root = trashRootFor(storageDir);
if (root === null) return { ok: true, root: null, plans: 0, files: 0, bytes: 0, entries: 0, truncated: false, errors: 0 };
let rootInfo;
try {
rootInfo = lstatSync(root);
} catch (error) {
if (error?.code === "ENOENT") return { ok: true, root, plans: 0, files: 0, bytes: 0, entries: 0, truncated: false, errors: 0 };
return { ok: false, root, plans: 0, files: 0, bytes: 0, entries: 0, truncated: false, errors: 1, error: String(error?.message ?? error) };
}
if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return { ok: false, root, plans: 0, files: 0, bytes: 0, entries: 0, truncated: false, errors: 1, error: "trash root is not a real directory" };
const limit = Number.isInteger(maxEntries) && maxEntries > 0 ? Math.min(maxEntries, MAX_TRASH_ENTRIES_PER_SWEEP) : MAX_TRASH_ENTRIES_PER_SWEEP;
const state = { entries: 0, files: 0, bytes: 0, truncated: false, errors: 0, limit };
let plans = 0;
let directory;
try {
directory = opendirSync(root);
while (state.entries < limit) {
const entry = directory.readSync();
if (entry === null) break;
state.entries += 1;
if (entry.isSymbolicLink()) continue;
const child = join(root, entry.name);
let info;
try {
info = lstatSync(child);
} catch {
state.errors += 1;
continue;
}
if (!info.isDirectory() || info.isSymbolicLink()) continue;
plans += 1;
directoryBytes(child, state);
}
if (state.entries >= limit) state.truncated = true;
} catch (error) {
return { ok: false, root, plans, files: state.files, bytes: state.bytes, entries: state.entries, truncated: state.truncated, errors: state.errors + 1, error: String(error?.message ?? error) };
} finally {
try {
directory?.closeSync();
} catch {
/* already closed */
}
}
return { ok: true, root, plans, files: state.files, bytes: state.bytes, entries: state.entries, truncated: state.truncated, errors: state.errors };
}

/** Permanently remove all plan directories inside the trash root. */
export function cleanupTrashEmpty({ storageDir = shared.storageDir, maxEntries = MAX_TRASH_ENTRIES_PER_SWEEP } = {}) {
const summary = cleanupTrashSummary({ storageDir, maxEntries });
const root = summary.root;
if (!summary.ok) return { ...summary, removed: 0, bytesFreed: 0 };
if ((summary.plans ?? 0) === 0) return { ...summary, removed: 0, bytesFreed: 0, skipped: 0, errors: [] };
let directory;
let removed = 0;
let skipped = 0;
let processed = 0;
const limit = Number.isInteger(maxEntries) && maxEntries > 0 ? Math.min(maxEntries, MAX_TRASH_ENTRIES_PER_SWEEP) : MAX_TRASH_ENTRIES_PER_SWEEP;
const errors = [];
try {
directory = opendirSync(root);
while (processed < limit) {
const entry = directory.readSync();
if (entry === null) break;
processed += 1;
summary.entries = processed;
if (entry.isSymbolicLink()) { skipped += 1; continue; }
const child = join(root, entry.name);
let info;
try {
info = lstatSync(child);
} catch (error) {
if (errors.length < 10) errors.push(`${entry.name}: ${String(error?.message ?? error)}`);
continue;
}
if (!info.isDirectory() || info.isSymbolicLink()) { skipped += 1; continue; }
try {
rmSync(child, { recursive: true, force: false, maxRetries: 2 });
removed += 1;
} catch (error) {
if (errors.length < 10) errors.push(`${entry.name}: ${String(error?.message ?? error)}`);
}
}
} catch (error) {
if (errors.length < 10) errors.push(String(error?.message ?? error));
} finally {
try {
directory?.closeSync();
} catch {
/* already closed */
}
}
recordIncident("trash-empty", { root, removed, bytesFreed: summary.bytes, skipped, errors });
return { ...summary, ok: errors.length === 0, removed, bytesFreed: summary.bytes, skipped, errors };
}

export { probeConfig };
