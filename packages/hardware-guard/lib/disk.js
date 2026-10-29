/**
 * Disk-availability monitoring for hardware-guard (v0.4.0) — the third
 * pressure axis.
 *
 * Motivation: the user environment once ran a process whose output/logs
 * filled the Windows C: drive until WSL2 crashed. hardware-guard therefore watches
 * disk availability the same way it watches memory and load: a cheap,
 * TTL-cached, synchronous statfs sample per monitored path, folded into the
 * same pressure state machine (warn/critical), with its own thresholds and
 * human-readable reasons.
 *
 * Guardrails (v0.4.0 scope):
 *  - SYNC `fs.statfsSync` only (no per-command `df` exec), cached per TTL
 *    (default 5s) so the admission gate and env resolvers stay cheap;
 *  - on non-Linux / non-WSL and on any path that cannot be stat'd the
 *    monitor degrades gracefully: paths are skipped, and with no disk facts
 *    `classifyPressure` keeps its existing behavior (no disk reasons);
 *  - raw byte counts are preserved; reports render them human-readable;
 *  - NO per-process disk quotas, NO resident `du` directory scans, and a
 *    disk-critical incident never deletes files — processes are not
 *    necessarily the cause of a full disk, so the watchdog's auto-kill sweep
 *    never runs on a disk-only critical state.
 *
 * Default monitored paths (override via `config.disk.paths`):
 *  - the filesystem holding `$DSH_HOME`,
 *  - the filesystem holding `process.cwd()` at boot,
 *  - on WSL2: `/mnt/c` when it exists and can be stat'd (read-only probe
 *    failures skip it — they must never fail plugin boot).
 *
 * Default thresholds:
 *  - warnAvailBytes: 20 GiB, critAvailBytes: 10 GiB,
 *  - warnUsePct: 0.90, critUsePct: 0.95;
 *  - ANY path crossing avail OR use% counts into the pressure reasons, and
 *    the disk axis takes the highest state across all monitored paths.
 *
 * @module hardware-guard/disk
 */
import { readFileSync, statSync, statfsSync } from "node:fs";
import { fmtBytes, isWslKernel } from "./host-profile.js";

const GIB = 1024 ** 3;

/** v0.4.0 disk config defaults (mirrored in DEFAULTS.disk). */
export const DISK_DEFAULTS = Object.freeze({
	enabled: true,
	/** Explicit monitor-path list; empty = auto-resolve ($DSH_HOME, cwd, WSL /mnt/c). */
	paths: [],
	/** Enter WARN when any path's available bytes drop below this. */
	warnAvailBytes: 20 * GIB,
	/** Enter CRITICAL when any path's available bytes drop below this. */
	critAvailBytes: 10 * GIB,
	/** Enter WARN when any path's usage (1 − avail/total) reaches this. */
	warnUsePct: 0.9,
	/** Enter CRITICAL when any path's usage (1 − avail/total) reaches this. */
	critUsePct: 0.95,
	/** statfs sampling TTL (ms): the sampler re-reads the filesystem at most this often. */
	sampleTtlMs: 5000
});

/** Common Linux filesystem magic numbers (linux/magic.h) → label. */
const FS_MAGIC = Object.freeze({
	0xef53: "ext4", 0x58465342: "xfs", 0x9123683e: "btrfs", 0x01021994: "tmpfs",
	0x794c7630: "overlayfs", 0x6969: "nfs", 0x65735546: "fuse", 0x2fc12fc1: "zfs",
	0x5346544e: "ntfs", 0x517b: "smb", 0xff534d42: "cifs", 0x01021997: "9p",
	0x2afcb43d: "drvfs", 0x0000696e: "inodefs", 0x62646576: "bdev"
});

function tryRead(path) {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

/** Whether this kernel is a Microsoft WSL2 kernel (defensive re-probe). */
export function detectWsl() {
	return isWslKernel(tryRead("/proc/version"));
}

/** statSync that returns false instead of throwing (existence probe). */
export function statOk(path, statFn = statSync) {
	try {
		statFn(path);
		return true;
	} catch {
		return false;
	}
}

/** Deduplicate paths, preserving first-seen order. */
function dedupe(paths) {
	const seen = new Set();
	const out = [];
	for (const path of paths) {
		if (typeof path !== "string" || path.length === 0) continue;
		if (seen.has(path)) continue;
		seen.add(path);
		out.push(path);
	}
	return out;
}

/**
 * Resolve the monitored disk paths.
 *
 * Explicit `config.disk.paths` (or the legacy flat `config.diskPaths`) wins
 * when non-empty; otherwise the auto set: `$DSH_HOME`, `process.cwd()`, and
 * — when `isWsl` and the path exists — `/mnt/c`. Every resolved path is
 * existence-probed and missing paths are skipped, so a vanished /mnt/c (or
 * an unset DSH_HOME) never breaks the plugin.
 *
 * @param {object} [config] - `{disk?: {paths, ...}}` or flat `{diskPaths}`
 * @param {object} [options] - `{isWsl?: boolean, statFn?: Function}` (tests inject)
 * @returns {string[]} deduped, existing paths
 */
export function resolveDiskPaths(config = {}, options = {}) {
	const diskCfg = config?.disk ?? {};
	const explicit = Array.isArray(diskCfg.paths)
		? diskCfg.paths
		: Array.isArray(config?.diskPaths)
			? config.diskPaths
			: [];
	const candidates = explicit.length > 0
		? explicit
		: [
			...(typeof process.env.DSH_HOME === "string" && process.env.DSH_HOME.length > 0 ? [process.env.DSH_HOME] : []),
			process.cwd(),
			...((options.isWsl ?? detectWsl()) && statOk("/mnt/c", options.statFn) ? ["/mnt/c"] : [])
		];
	return dedupe(candidates).filter((path) => statOk(path, options.statFn));
}

/** Raw statfs facts for one path, or null when the path cannot be stat'd. */
export function statFs(path, statFn = statfsSync) {
	try {
		const s = statFn(path);
		const bsize = s.bsize ?? s.frsize ?? 4096;
		const totalBytes = (s.blocks ?? 0) * bsize;
		const availBytes = (s.bavail ?? 0) * bsize;
		return {
			path,
			totalBytes,
			availBytes,
			usePct: totalBytes > 0 ? 1 - availBytes / totalBytes : 0,
			type: s.type ?? null
		};
	} catch {
		return null;
	}
}

/** Parse /proc/mounts into `{mount, fsType}` entries (Linux only; [] elsewhere). */
export function readMounts() {
	if (process.platform !== "linux") return [];
	const text = tryRead("/proc/mounts");
	if (text === null) return [];
	const out = [];
	for (const line of text.split("\n")) {
		const parts = line.split(" ");
		if (parts.length < 3) continue;
		const mount = parts[1];
		const fsType = parts[2];
		if (mount.length > 0 && fsType.length > 0) out.push({ mount, fsType });
	}
	return out;
}

/** The mount entry whose mount point is the longest prefix of `path` (or null). */
export function mountFor(path, mounts) {
	let best = null;
	let bestLen = -1;
	for (const entry of mounts) {
		if (path === entry.mount || path.startsWith(entry.mount.endsWith("/") ? entry.mount : `${entry.mount}/`) || entry.mount === "/") {
			if (entry.mount.length > bestLen) {
				best = entry;
				bestLen = entry.mount.length;
			}
		}
	}
	return best;
}

/** Human-readable filesystem label: `ext4@/`, `9p@/mnt/c`, … fallback `unknown`. */
export function filesystemLabel(entry, mounts) {
	const fsType = entry?.type !== null && entry?.type !== undefined
		? (FS_MAGIC[entry.type] ?? `0x${entry.type.toString(16)}`)
		: null;
	const mount = mounts !== null ? mountFor(entry?.path, mounts ?? []) : null;
	if (mount !== null && mount.fsType !== undefined) return `${mount.fsType}@${mount.mount}`;
	if (fsType !== null) return fsType;
	return "unknown";
}

/**
 * Build the sampling templates for a resolved path list: thresholds are
 * stamped per path so classification stays self-describing (the sampled
 * entry carries everything `classifyPressure` needs).
 *
 * @param {string[]} paths - resolved, existing paths
 * @param {object} [config] - `{disk?: {...}}` thresholds
 * @returns {Array<{path, filesystem, totalBytes, availBytes, warnAvailBytes, critAvailBytes, warnUsePct, critUsePct}>}
 */
export function buildDiskEntries(paths, config = {}) {
	const diskCfg = { ...DISK_DEFAULTS, ...(config?.disk ?? {}) };
	return (paths ?? []).map((path) => ({
		path,
		filesystem: null,
		totalBytes: null,
		availBytes: null,
		usePct: null,
		warnAvailBytes: diskCfg.warnAvailBytes,
		critAvailBytes: diskCfg.critAvailBytes,
		warnUsePct: diskCfg.warnUsePct,
		critUsePct: diskCfg.critUsePct
	}));
}

/**
 * Sample every entry with statfs. Entries whose path cannot be stat'd are
 * dropped (graceful degradation — never throws). `statFn`/`mounts` are
 * injectable for tests.
 *
 * @param {Array} entries - buildDiskEntries() templates
 * @param {object} [options] - `{statFn?, mounts?}`
 * @returns {Array} sampled entries (only stat-able paths, plain JSON-safe objects)
 */
export function sampleDisks(entries = [], options = {}) {
	const mounts = options.mounts ?? (options.mounts === null ? null : readMounts());
	const out = [];
	for (const entry of entries) {
		if (typeof entry !== "object" || entry === null || typeof entry.path !== "string") continue;
		const facts = statFs(entry.path, options.statFn ?? statfsSync);
		if (facts === null) continue;
		out.push({
			...entry,
			totalBytes: facts.totalBytes,
			availBytes: facts.availBytes,
			usePct: facts.usePct,
			filesystem: filesystemLabel(facts, mounts),
			at: Date.now()
		});
	}
	return out;
}

/**
 * One disk entry's pressure level. No facts (availBytes null) → "ok"
 * (classification then stays silent about the disk axis).
 */
export function diskEntryLevel(entry) {
	if (entry === null || entry === undefined || typeof entry !== "object") return "ok";
	if (entry.availBytes === null || entry.availBytes === undefined) return "ok";
	if (entry.availBytes < entry.critAvailBytes) return "critical";
	if (entry.usePct >= entry.critUsePct) return "critical";
	if (entry.availBytes < entry.warnAvailBytes) return "warn";
	if (entry.usePct >= entry.warnUsePct) return "warn";
	return "ok";
}

/**
 * Human-readable reasons for one level across all disks. Examples:
 *   `disk /mnt/c available 8.2 GiB < critical 10 GiB`
 *   `disk /mnt/c usage 96.0% >= warn 90%`
 */
export function diskReasonsFor(disks, level) {
	const out = [];
	for (const entry of disks ?? []) {
		if (entry === null || entry === undefined || typeof entry !== "object") continue;
		if (entry.availBytes === null || entry.availBytes === undefined) continue;
		const levelOf = diskEntryLevel(entry);
		if (levelOf !== level) continue;
		if (level === "critical") {
			if (entry.availBytes < entry.critAvailBytes) {
				out.push(`disk ${entry.path} available ${fmtBytes(entry.availBytes)} < critical ${fmtBytes(entry.critAvailBytes)}`);
			} else if (entry.usePct >= entry.critUsePct) {
				out.push(`disk ${entry.path} usage ${(entry.usePct * 100).toFixed(1)}% >= critical ${Math.round(entry.critUsePct * 100)}%`);
			}
		} else if (level === "warn") {
			if (entry.availBytes < entry.warnAvailBytes) {
				out.push(`disk ${entry.path} available ${fmtBytes(entry.availBytes)} < warn ${fmtBytes(entry.warnAvailBytes)}`);
			} else if (entry.usePct >= entry.warnUsePct) {
				out.push(`disk ${entry.path} usage ${(entry.usePct * 100).toFixed(1)}% >= warn ${Math.round(entry.warnUsePct * 100)}%`);
			}
		}
	}
	return out;
}

/**
 * Highest pressure level across all disks: any critical path wins, else any
 * warn path, else "ok". No facts → "ok" (the disk axis stays silent).
 */
export function disksPressure(disks) {
	let state = "ok";
	for (const entry of disks ?? []) {
		const level = diskEntryLevel(entry);
		if (level === "critical") return "critical";
		if (level === "warn") state = "warn";
	}
	return state;
}

/**
 * The most dangerous disk: the one with the lowest avail/critAvail ratio
 * (falling back to the lowest absolute availBytes). Null when no disk has
 * facts. Used by DSH_HW_DISK_AVAIL_BYTES / DSH_HW_DISK_CRIT_PATH.
 */
export function mostDangerousDisk(disks) {
	let worst = null;
	let worstScore = Infinity;
	for (const entry of disks ?? []) {
		if (entry === null || entry === undefined || typeof entry !== "object") continue;
		if (entry.availBytes === null || entry.availBytes === undefined) continue;
		const score = entry.critAvailBytes > 0 ? entry.availBytes / entry.critAvailBytes : entry.availBytes;
		if (score < worstScore) {
			worstScore = score;
			worst = entry;
		}
	}
	return worst;
}

/**
 * TTL-cached disk sampler. `sample(entries)` re-reads the filesystems at
 * most once per `ttlMs` (default 5s) and returns the plain sampled array;
 * callers (the pressure monitor) may call it on every tick with no I/O cost
 * in between. Never throws — un-stat-able paths are simply dropped.
 */
export function createDiskSampler({ ttlMs = DISK_DEFAULTS.sampleTtlMs } = {}) {
	let cached = { at: 0, disks: [], entries: null };
	return {
		/**
		 * @param {Array} entries - buildDiskEntries() templates (stable reference)
		 * @returns {Array} sampled disks (cached between TTL windows)
		 */
		sample(entries) {
			const list = entries ?? [];
			const now = Date.now();
			if (cached.entries !== list || now - cached.at >= ttlMs) {
				cached = { at: now, disks: sampleDisks(list), entries: list };
			}
			return cached.disks;
		}
	};
}

/** Read-only facts for the hardware_guard `disks` action. */
export function renderDisks(disks) {
	const list = Array.isArray(disks) ? disks : [];
	if (list.length === 0) return "[hardware-guard disks] no disk facts available (no monitored path could be sampled)";
	const lines = ["[hardware-guard disks]"];
	for (const entry of list) {
		const level = diskEntryLevel(entry);
		const flags = [
			`warn < ${fmtBytes(entry.warnAvailBytes)} avail / >= ${Math.round(entry.warnUsePct * 100)}% used`,
			`crit < ${fmtBytes(entry.critAvailBytes)} avail / >= ${Math.round(entry.critUsePct * 100)}% used`
		];
		lines.push(`- ${entry.path} [${level}] ${fmtBytes(entry.totalBytes)} total, ${fmtBytes(entry.availBytes)} available (${(entry.usePct * 100).toFixed(1)}% used); ${flags.join("; ")}${entry.filesystem ? `; fs ${entry.filesystem}` : ""}`);
	}
	const worst = mostDangerousDisk(list);
	if (worst !== null) lines.push(`most dangerous path: ${worst.path} (${fmtBytes(worst.availBytes)} available)`);
	return lines.join("\n");
}

/** Disk-axis env facts (DSH_HW_DISK_*) with descriptions for the shellEnv registry. */
export const DISK_ENV = Object.freeze({
	DSH_HW_DISK_PATHS: "Comma-separated monitored disk paths",
	DSH_HW_DISK_AVAIL_BYTES: "Available bytes on the most dangerous monitored path",
	DSH_HW_DISK_PRESSURE: "Disk pressure axis: ok | warn | critical",
	DSH_HW_DISK_CRIT_PATH: "Current most dangerous monitored path"
});
