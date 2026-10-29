/**
 * Project output-file probe. Scans configured project roots for large/old
 * files that are candidates for cleanup. This module NEVER deletes: it only
 * returns a sorted candidate list; `cleanup-actions.js` performs deletion
 * after an explicit user confirmation.
 *
 * Safety:
 *  - does not follow symlinks;
 *  - never crosses out of the configured roots;
 *  - caps traversal by maxDepth/maxFiles so a huge tree cannot stall the host;
 *  - skips structural directories that are never "redundant project output"
 *    (`excludeDirs`: .git, node_modules, virtualenvs, caches, the trash dir).
 *    `results/` and `build/` are NOT excluded by default: they are exactly
 *    what cleanup usually targets. Pass `excludeDirs: []` to scan everything.
 *
 * @module hardware-guard/probe
 */
import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

/** Directory names never descended into (matched by basename, any depth). */
export const DEFAULT_EXCLUDE_DIRS = Object.freeze([
	".git",
	".hg",
	".svn",
	"node_modules",
	".pnpm-store",
	".venv",
	"venv",
	"env",
	"__pycache__",
	".pytest_cache",
	".mypy_cache",
	".ruff_cache",
	".cache",
	"site-packages",
	".dsh-trash"
]);

export const PROBE_DEFAULTS = Object.freeze({
	enabled: false,
	roots: [],
	maxDepth: 4,
	maxFiles: 20000,
	minSizeBytes: 64 * 1024 * 1024,
	minAgeMs: 0,
	topN: 50,
	excludeDirs: DEFAULT_EXCLUDE_DIRS,
	softDelete: true
});

function toPositiveInt(value, fallback) {
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Resolve the exclusion set. An explicitly provided array wins (an empty
 * array means "scan everything"); `undefined`/non-array falls back to the
 * defaults.
 */
export function resolveExcludeDirs(config = {}) {
	const raw = Array.isArray(config.excludeDirs) ? config.excludeDirs : DEFAULT_EXCLUDE_DIRS;
	return new Set(raw
		.filter((entry) => typeof entry === "string")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0 && entry !== "." && entry !== ".." && !entry.includes("/")));
}

/**
 * Scan one root recursively and return the largest candidate files.
 *
 * @param {object} config - probe config: roots, maxDepth, maxFiles, minSizeBytes, minAgeMs, topN
 * @param {number} [now] - clock for tests
 * @returns {Promise<{candidates: object[], scannedFiles: number, truncated: boolean, roots: string[], errors: string[]}>}
 */
export async function scanCleanupCandidates(config = {}, now = Date.now()) {
const roots = (Array.isArray(config.roots) ? config.roots : [])
.filter((root) => typeof root === "string" && root.trim() !== "")
.map((root) => resolve(root));
const maxDepth = toPositiveInt(config.maxDepth, PROBE_DEFAULTS.maxDepth);
const maxFiles = toPositiveInt(config.maxFiles, PROBE_DEFAULTS.maxFiles);
const topN = toPositiveInt(config.topN, PROBE_DEFAULTS.topN);
const minSizeBytes = Math.max(0, Number(config.minSizeBytes) || 0);
const minAgeMs = Math.max(0, Number(config.minAgeMs) || 0);
const excludeDirs = resolveExcludeDirs(config);
const candidates = [];
const errors = [];
let scannedFiles = 0;
let skippedDirs = 0;
let truncated = false;

for (const root of roots) {
try {
const rootStat = await stat(root);
if (!rootStat.isDirectory()) {
errors.push(`${root}: not a directory`);
continue;
}
} catch (error) {
errors.push(`${root}: ${error?.code === "ENOENT" ? "not found" : String(error?.message ?? error)}`);
continue;
}

const queue = [{ dir: root, depth: 0 }];
while (queue.length > 0) {
const { dir, depth } = queue.shift();
let entries;
try {
entries = await readdir(dir, { withFileTypes: true });
} catch (error) {
errors.push(`${dir}: ${String(error?.message ?? error)}`);
continue;
}
for (const entry of entries) {
const full = join(dir, entry.name);
if (entry.isSymbolicLink()) continue;
if (entry.isDirectory()) {
if (excludeDirs.has(entry.name)) {
skippedDirs += 1;
continue;
}
if (depth < maxDepth) queue.push({ dir: full, depth: depth + 1 });
continue;
}
if (!entry.isFile()) continue;
scannedFiles += 1;
if (scannedFiles > maxFiles) {
truncated = true;
break;
}
let info;
try {
info = await stat(full);
} catch {
continue;
}
const ageMs = Math.max(0, now - info.mtimeMs);
if (info.size < minSizeBytes) continue;
if (minAgeMs > 0 && ageMs < minAgeMs) continue;
candidates.push({
path: full,
root,
sizeBytes: info.size,
mtimeMs: Math.floor(info.mtimeMs),
ageMs: Math.floor(ageMs)
});
}
if (truncated) break;
}
if (truncated) break;
}

candidates.sort((left, right) => right.sizeBytes - left.sizeBytes || right.ageMs - left.ageMs);
const selected = candidates.slice(0, topN);
return {
candidates: selected,
scannedFiles,
skippedDirs,
excludedDirs: [...excludeDirs],
truncated,
roots,
errors,
totalBytes: selected.reduce((sum, item) => sum + item.sizeBytes, 0)
};
}
