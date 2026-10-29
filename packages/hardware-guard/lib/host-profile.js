/**
 * Host hardware probing and budget derivation.
 *
 * Linux (incl. WSL2) gets exact values from /proc and cgroup v2; other
 * platforms fall back to Node's `os` module so admission control and context
 * injection keep working everywhere, while prlimit/taskset enforcement stays
 * Linux-only.
 *
 * The persisted `host-profile.json` is the MACHINE-PRIVATE fact source and
 * conforms to `schemas/host-profile.schema.json` (see the ops-generalization
 * design): probe facts only → derive budgets by the policy default formula →
 * persist with `confirmationRequired: true` (dry-run) → enforce only after
 * the user confirms via the `hardware_guard confirm` action. It must never be
 * synced across machines.
 *
 * @module hardware-guard/host-profile
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cpus, hostname, loadavg, platform, release, totalmem } from "node:os";
import { DEFAULTS, shared } from "./state.js";

const KIB = 1024;
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

/** Read a file if present, returning null on any failure. */
function tryRead(path) {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

/** Parse /proc/meminfo into byte-valued fields. */
export function parseMeminfo(text) {
	const out = {};
	if (text === null) return out;
	for (const line of text.split("\n")) {
		const match = /^(\w+):\s+(\d+)\s*kB$/.exec(line.trim());
		if (match === null) continue;
		out[match[1]] = Number(match[2]) * KIB;
	}
	return out;
}

/** Parse /proc/loadavg. */
export function parseLoadavg(text) {
	if (text === null) return null;
	const parts = text.trim().split(/\s+/);
	if (parts.length < 3) return null;
	return {
		load1: Number(parts[0]),
		load5: Number(parts[1]),
		load15: Number(parts[2])
	};
}

/** Parse a cgroup v2 memory.max value ("max" means unlimited). */
export function parseCgroupMemoryMax(text) {
	if (text === null) return null;
	const trimmed = text.trim();
	if (trimmed === "" || trimmed === "max") return null;
	const bytes = Number(trimmed);
	return Number.isFinite(bytes) && bytes > 0 ? bytes : null;
}

/** Parse a cgroup v2 cpu.max line ("max 100000" → null; "200000 100000" → 2 cores). */
export function parseCgroupCpuMax(text) {
	if (text === null) return null;
	const parts = text.trim().split(/\s+/);
	if (parts.length < 2 || parts[0] === "max") return null;
	const quota = Number(parts[0]);
	const period = Number(parts[1]);
	if (!Number.isFinite(quota) || quota <= 0 || !Number.isFinite(period) || period <= 0) return null;
	return quota / period;
}

/** Parse a cgroup v2 pids.max value ("max" means unlimited). */
export function parseCgroupPidsMax(text) {
	if (text === null) return null;
	const trimmed = text.trim();
	if (trimmed === "" || trimmed === "max") return null;
	const value = Number(trimmed);
	return Number.isFinite(value) && value > 0 ? value : null;
}

/** Which cgroup layout the host exposes. */
export function detectCgroupVersion() {
	if (tryRead("/sys/fs/cgroup/cgroup.controllers") !== null) return "v2";
	if (tryRead("/sys/fs/cgroup/cpu,cpuacct/cpu.cfs_quota_us") !== null) return "v1";
	return "none";
}

/** Whether the running kernel is a Microsoft WSL2 kernel. */
export function isWslKernel(versionText) {
	return /microsoft|WSL/i.test(versionText ?? "");
}

function safe(fn, fallback) {
	try {
		return fn();
	} catch {
		return fallback;
	}
}

/** Probe raw host facts. Pure reads; never throws. */
export function probeHardware() {
	const isLinux = platform() === "linux";
	const meminfo = isLinux ? parseMeminfo(tryRead("/proc/meminfo")) : {};
	const loadText = isLinux ? parseLoadavg(tryRead("/proc/loadavg")) : null;
	const osLoad = loadText ?? (() => {
		try {
			const values = loadavg();
			return { load1: values[0], load5: values[1], load15: values[2] };
		} catch {
			return null;
		}
	})();
	const memTotal = isLinux ? meminfo.MemTotal ?? 0 : safe(() => totalmem(), 0);
	const cpuList = cpus();
	const cgroupVersion = isLinux ? detectCgroupVersion() : "none";
	const cgroupMemMaxBytes = isLinux && cgroupVersion === "v2"
		? parseCgroupMemoryMax(tryRead("/sys/fs/cgroup/memory.max"))
		: null;
	const cgroup = isLinux ? {
		version: cgroupVersion,
		cpuLimitCores: cgroupVersion === "v2" ? parseCgroupCpuMax(tryRead("/sys/fs/cgroup/cpu.max")) : null,
		memMaxBytes: cgroupMemMaxBytes,
		pidsMax: cgroupVersion === "v2" ? parseCgroupPidsMax(tryRead("/sys/fs/cgroup/pids.max")) : null
	} : {
		version: "none",
		cpuLimitCores: null,
		memMaxBytes: null,
		pidsMax: null
	};
	return {
		platform: platform(),
		arch: process.arch,
		isWsl: isLinux ? isWslKernel(tryRead("/proc/version")) : false,
		nodeVersion: process.version,
		hostname: hostname(),
		kernel: isLinux ? (tryRead("/proc/version") ?? "").split(" ").slice(0, 3).join(" ") : `${platform()} ${release()}`,
		cpuCount: cpuList.length,
		cpuModel: cpuList[0]?.model ?? "unknown",
		memTotalBytes: memTotal,
		swapTotalBytes: isLinux ? meminfo.SwapTotal ?? 0 : 0,
		cgroup,
		/** Legacy alias kept for pre-schema code paths and tests. */
		cgroupMemMaxBytes,
		load: osLoad
	};
}

/** Clamp into a sane numeric range. */
function clamp(value, min, max) {
	if (!Number.isFinite(value)) return min;
	return Math.min(max, Math.max(min, value));
}

/** Effective memory: min(MemTotal, cgroup memory.max) — what matters on WSL2. */
export function effectiveMemBytes(hw) {
	return Math.max(1, Math.min(
		hw.memTotalBytes || Number.MAX_SAFE_INTEGER,
		(hw.cgroup?.memMaxBytes ?? hw.cgroupMemMaxBytes) ?? Number.MAX_SAFE_INTEGER
	));
}

/**
 * v0.3.2 independent runaway threshold: `min(4 GiB, memBudgetBytes × 0.25)`.
 * The auto-kill sweep's memory grading is policy-aware (see watchdog.js):
 * outside the explicit `all` blanket, a process whose RSS crosses THIS
 * threshold is a true memory runaway regardless of its compute identity —
 * the per-command cap (perCommandMemCapBytes × 0.8) no longer doubles as
 * the kill criterion for every descendant, which is what kept the old
 * sweep inconsistent with the v0.3.1 `memoryCapPolicy: none` default.
 */
export function deriveMemoryRunawayBytes(memBudgetBytes) {
	const budget = Number.isFinite(memBudgetBytes) && memBudgetBytes > 0 ? memBudgetBytes : 16 * GIB;
	return Math.max(1, Math.min(4 * GIB, Math.floor(budget * 0.25)));
}

/**
 * Derive the budget section (policy default formula, see ops-generalization):
 * `cpuBudget = max(1, cpuTotal - cpuReserve)`,
 * `memBudget = min(MemTotal, cgroupMemMax) * memSafetyFrac`,
 * `perCommandMemCap = min(1.5 GiB, memBudget / 4)`,
 * `memoryRunawayBytes = min(4 GiB, memBudget × 0.25)` (v0.3.2).
 *
 * Fresh derivations start in dry-run: `confirmationRequired: true` until the
 * user confirms (hardware_guard `confirm` action) or overrides are applied.
 */
export function deriveBudget(hw, config) {
	const cpuCount = Math.max(1, hw.cpuCount);
	const cpuReservedCores = clamp(config.cpuReservedCores ?? DEFAULTS.cpuReservedCores, 0, cpuCount - 1);
	const cpuBudgetCores = Math.max(1, cpuCount - cpuReservedCores);
	const effectiveMem = effectiveMemBytes(hw);
	const memBudgetBytes = Math.floor(effectiveMem * config.memSafetyFrac);
	const derivedCap = Math.min(
		config.perCommandMemCapBytes,
		Math.floor(memBudgetBytes / 4)
	);
	const memoryRunawayBytes = Number.isFinite(config.memoryRunawayBytes)
		? Math.max(1, Math.floor(config.memoryRunawayBytes))
		: deriveMemoryRunawayBytes(memBudgetBytes);
	return {
		cpuBudgetCores,
		cpuReservedCores,
		memBudgetBytes,
		perCommandMemCapBytes: Math.max(64 * MIB, derivedCap),
		memoryRunawayBytes,
		perCommandMaxProcesses: clamp(config.maxProcesses, 64, 65535),
		maxBackgroundJobs: config.maxBackgroundJobs !== undefined
			? config.maxBackgroundJobs
			: Math.max(1, Math.floor(cpuBudgetCores / 2)),
		niceLevel: clamp(config.niceLevel, -20, 19),
		derivedFrom: "auto",
		confirmationRequired: true
	};
}

/** Derive the pressure section incl. hysteresis (exit thresholds + min dwell). */
export function derivePressureSection(hw, config) {
	const cpuCount = Math.max(1, hw.cpuCount);
	return {
		warnLoad: cpuCount * config.warnLoadFactor,
		critLoad: cpuCount * config.critLoadFactor,
		warnMemFrac: config.warnMemFrac,
		critMemFrac: config.critMemFrac,
		hysteresis: {
			warnExitLoad: cpuCount * config.warnExitLoadFactor,
			critExitLoad: cpuCount * config.critExitLoadFactor,
			warnExitMemFrac: config.warnExitMemFrac,
			critExitMemFrac: config.critExitMemFrac,
			minStateMs: config.minStateMs
		},
		samplingIntervalMs: config.samplingIntervalMs,
		contextRefreshMs: config.contextRefreshMs
	};
}

/** Derive the enforcement section from the runtime config. */
export function deriveEnforcementSection(config) {
	return {
		autoKillOnCritical: config.autoKillOnCritical,
		killCooldownMs: config.killCooldownMs,
		killGraceMs: config.killGraceMs,
		prlimitTimeoutMs: config.prlimitTimeoutMs,
		excludeComm: [...(config.excludeComm ?? [])],
		allowOnCritical: [...(config.allowOnCritical ?? DEFAULTS.allowOnCritical)]
	};
}

/**
 * v0.4.0 disk section (config shape, persisted in the machine-private
 * profile): the disk axis thresholds + sampling TTL + any EXPLICIT path
 * list. Auto-resolved paths ($DSH_HOME / cwd / WSL /mnt/c) are LIVE state —
 * `shared.diskPaths` at boot — and are exposed through `hardware_guard disks` and
 * `/resources/hardware.json` rather than persisted here (they can change between
 * boots and are derived from env, not machine facts).
 */
export function deriveDiskSection(config) {
	const disk = config.disk ?? {};
	return {
		enabled: disk.enabled !== false,
		paths: [...(Array.isArray(disk.paths) ? disk.paths : [])],
		warnAvailBytes: disk.warnAvailBytes ?? DEFAULTS.disk.warnAvailBytes,
		critAvailBytes: disk.critAvailBytes ?? DEFAULTS.disk.critAvailBytes,
		warnUsePct: disk.warnUsePct ?? DEFAULTS.disk.warnUsePct,
		critUsePct: disk.critUsePct ?? DEFAULTS.disk.critUsePct,
		sampleTtlMs: disk.sampleTtlMs ?? DEFAULTS.disk.sampleTtlMs
	};
}

/**
 * Build the schema-conformant host profile document (schemas/host-profile.schema.json).
 * New machines start with `confirmationRequired: true` (dry-run); callers that
 * re-derive over an existing confirmed profile must carry the confirmation over.
 */
export function buildHostProfile(hw, config, probedAt = Date.now()) {
	return {
		schemaVersion: 1,
		probedAt,
		host: {
			platform: hw.platform ?? "linux",
			arch: hw.arch ?? "unknown",
			isWsl: hw.isWsl === true,
			hostname: hw.hostname ?? "unknown",
			kernel: hw.kernel ?? "unknown",
			nodeVersion: hw.nodeVersion ?? "unknown"
		},
		hardware: {
			cpuCount: Math.max(1, hw.cpuCount ?? 1),
			cpuModel: hw.cpuModel ?? "unknown",
			memTotalBytes: hw.memTotalBytes ?? 0,
			swapTotalBytes: hw.swapTotalBytes ?? 0,
			cgroup: hw.cgroup ?? { version: "none", cpuLimitCores: null, memMaxBytes: hw.cgroupMemMaxBytes ?? null, pidsMax: null }
		},
		budget: deriveBudget(hw, config),
		pressure: derivePressureSection(hw, config),
		enforcement: deriveEnforcementSection(config),
		disk: deriveDiskSection(config),
		overrides: {}
	};
}

/**
 * Runtime projection derived from a host profile document. Consumers
 * (pressure classifier, watchdog, prologue, env facts) read these fields;
 * the document stays the only persisted shape.
 */
export function deriveRuntimeProfile(doc) {
	const hw = doc?.hardware ?? {};
	const budget = doc?.budget ?? {};
	const pressure = doc?.pressure ?? {};
	const hyst = pressure.hysteresis ?? {};
	const cpuCount = Math.max(1, hw.cpuCount ?? 1);
	const effectiveMem = Math.max(1, Math.min(
		hw.memTotalBytes || Number.MAX_SAFE_INTEGER,
		hw.cgroup?.memMaxBytes ?? Number.MAX_SAFE_INTEGER
	));
	const cpuBudgetCores = budget.cpuBudgetCores ?? cpuCount;
	return {
		cpuCount,
		cpuBudgetCores,
		cpuReservedCores: budget.cpuReservedCores ?? 0,
		cpuMask: `0-${Math.max(0, cpuBudgetCores - 1)}`,
		effectiveMemBytes: effectiveMem,
		memBudgetBytes: budget.memBudgetBytes ?? effectiveMem,
		perCommandMemCapBytes: budget.perCommandMemCapBytes ?? 64 * MIB,
		memoryRunawayBytes: budget.memoryRunawayBytes ?? deriveMemoryRunawayBytes(budget.memBudgetBytes),
		maxBackgroundJobs: budget.maxBackgroundJobs ?? 1,
		niceLevel: budget.niceLevel ?? DEFAULTS.niceLevel,
		maxProcesses: budget.perCommandMaxProcesses ?? DEFAULTS.maxProcesses,
		warnMemBytes: Math.floor(effectiveMem * (pressure.warnMemFrac ?? DEFAULTS.warnMemFrac)),
		critMemBytes: Math.floor(effectiveMem * (pressure.critMemFrac ?? DEFAULTS.critMemFrac)),
		warnLoad: pressure.warnLoad ?? cpuCount,
		critLoad: pressure.critLoad ?? cpuCount * 2,
		warnMemFrac: pressure.warnMemFrac ?? DEFAULTS.warnMemFrac,
		critMemFrac: pressure.critMemFrac ?? DEFAULTS.critMemFrac,
		hysteresis: {
			warnExitLoad: hyst.warnExitLoad,
			critExitLoad: hyst.critExitLoad,
			warnExitMemBytes: hyst.warnExitMemFrac === undefined ? undefined : Math.floor(effectiveMem * hyst.warnExitMemFrac),
			critExitMemBytes: hyst.critExitMemFrac === undefined ? undefined : Math.floor(effectiveMem * hyst.critExitMemFrac),
			minStateMs: hyst.minStateMs ?? 0
		},
		derivedFrom: budget.derivedFrom ?? "auto",
		confirmationRequired: budget.confirmationRequired !== false,
		enforcementActive: budget.confirmationRequired === false,
		/** v0.4.0 disk axis config (thresholds + explicit paths; live path set in shared.diskPaths). */
		disk: {
			enabled: doc.disk?.enabled !== false,
			paths: Array.isArray(doc.disk?.paths) ? [...doc.disk.paths] : [],
			warnAvailBytes: doc.disk?.warnAvailBytes ?? DEFAULTS.disk.warnAvailBytes,
			critAvailBytes: doc.disk?.critAvailBytes ?? DEFAULTS.disk.critAvailBytes,
			warnUsePct: doc.disk?.warnUsePct ?? DEFAULTS.disk.warnUsePct,
			critUsePct: doc.disk?.critUsePct ?? DEFAULTS.disk.critUsePct,
			sampleTtlMs: doc.disk?.sampleTtlMs ?? DEFAULTS.disk.sampleTtlMs
		}
	};
}

/**
 * Derive the runtime projection straight from raw host facts (no persistence).
 * Kept for tests and the standalone executor/sandbox mount paths.
 */
export function deriveProfile(hw, config) {
	return deriveRuntimeProfile(buildHostProfile(hw, config));
}

/** Probe and build a fresh in-memory host (used when the main row is absent). */
export function probeFreshHost(config) {
	const doc = buildHostProfile(probeHardware(), config);
	return { path: null, doc, profile: deriveRuntimeProfile(doc) };
}

/**
 * Convert a pre-schema persisted profile ({hw, profile}) into the
 * schema-conformant document. The legacy file was already enforcing, so the
 * migration marks it confirmed instead of re-requiring user confirmation.
 */
export function migrateLegacyProfile(legacy, config = DEFAULTS) {
	const hw = legacy.hw ?? {};
	const p = legacy.profile ?? {};
	const cpuCount = Math.max(1, p.cpuCount ?? hw.cpuCount ?? 1);
	const doc = buildHostProfile(hw, config, legacy.probedAt ?? Date.now());
	doc.budget.memBudgetBytes = p.memBudgetBytes ?? doc.budget.memBudgetBytes;
	doc.budget.perCommandMemCapBytes = p.perCommandMemCapBytes ?? doc.budget.perCommandMemCapBytes;
	doc.budget.perCommandMaxProcesses = p.maxProcesses ?? doc.budget.perCommandMaxProcesses;
	doc.budget.maxBackgroundJobs = p.maxBackgroundJobs ?? doc.budget.maxBackgroundJobs;
	doc.budget.niceLevel = p.niceLevel ?? doc.budget.niceLevel;
	doc.budget.derivedFrom = "auto";
	doc.budget.confirmationRequired = false;
	doc.pressure.warnLoad = p.warnLoad ?? doc.pressure.warnLoad;
	doc.pressure.critLoad = p.critLoad ?? doc.pressure.critLoad;
	doc.pressure.warnMemFrac = p.warnMemFrac ?? doc.pressure.warnMemFrac;
	doc.pressure.critMemFrac = p.critMemFrac ?? doc.pressure.critMemFrac;
	return doc;
}

/**
 * Structural validation of a host profile document against the constraints
 * of schemas/host-profile.schema.json (no runtime JSON-Schema dependency).
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateHostProfile(doc) {
	const errors = [];
	if (typeof doc !== "object" || doc === null) return { ok: false, errors: ["profile document is not an object"] };
	if (doc.schemaVersion !== 1) errors.push(`schemaVersion must be 1 (got ${doc.schemaVersion})`);
	if (!Number.isInteger(doc.probedAt) || doc.probedAt < 0) errors.push("probedAt must be a non-negative integer");
	const host = doc.host;
	if (typeof host !== "object" || host === null) errors.push("host section missing");
	else {
		if (!["linux", "darwin", "win32"].includes(host.platform)) errors.push(`host.platform invalid: ${host.platform}`);
		for (const key of ["arch", "hostname", "kernel"]) {
			if (typeof host[key] !== "string" || host[key].length === 0) errors.push(`host.${key} must be a non-empty string`);
		}
		if (typeof host.isWsl !== "boolean") errors.push("host.isWsl must be a boolean");
	}
	const hardware = doc.hardware;
	if (typeof hardware !== "object" || hardware === null) errors.push("hardware section missing");
	else {
		if (!Number.isInteger(hardware.cpuCount) || hardware.cpuCount < 1) errors.push(`hardware.cpuCount invalid: ${hardware.cpuCount}`);
		if (typeof hardware.cpuModel !== "string" || hardware.cpuModel.length === 0) errors.push("hardware.cpuModel must be a non-empty string");
		if (!Number.isFinite(hardware.memTotalBytes) || hardware.memTotalBytes < 0) errors.push(`hardware.memTotalBytes invalid: ${hardware.memTotalBytes}`);
		const cgroup = hardware.cgroup;
		if (typeof cgroup !== "object" || cgroup === null) errors.push("hardware.cgroup missing");
		else if (!["none", "v1", "v2"].includes(cgroup.version)) errors.push(`hardware.cgroup.version invalid: ${cgroup.version}`);
	}
	const budget = doc.budget;
	if (typeof budget !== "object" || budget === null) errors.push("budget section missing");
	else {
		for (const key of ["cpuBudgetCores", "cpuReservedCores"]) {
			if (!Number.isFinite(budget[key]) || budget[key] < 0) errors.push(`budget.${key} invalid: ${budget[key]}`);
		}
		for (const key of ["memBudgetBytes", "perCommandMemCapBytes", "perCommandMaxProcesses", "maxBackgroundJobs"]) {
			if (!Number.isInteger(budget[key]) || budget[key] < 1) errors.push(`budget.${key} invalid: ${budget[key]}`);
		}
		// v0.3.2 optional knob (pre-0.3.2 persisted profiles lack it and stay valid)
		if (budget.memoryRunawayBytes !== undefined && (!Number.isInteger(budget.memoryRunawayBytes) || budget.memoryRunawayBytes < 1)) {
			errors.push(`budget.memoryRunawayBytes invalid: ${budget.memoryRunawayBytes}`);
		}
		if (!Number.isInteger(budget.niceLevel) || budget.niceLevel < -20 || budget.niceLevel > 19) errors.push(`budget.niceLevel invalid: ${budget.niceLevel}`);
		if (!["auto", "user-confirmed", "override"].includes(budget.derivedFrom)) errors.push(`budget.derivedFrom invalid: ${budget.derivedFrom}`);
		if (typeof budget.confirmationRequired !== "boolean") errors.push("budget.confirmationRequired must be a boolean");
	}
	const pressure = doc.pressure;
	if (typeof pressure !== "object" || pressure === null) errors.push("pressure section missing");
	else {
		for (const key of ["warnLoad", "critLoad"]) {
			if (!Number.isFinite(pressure[key]) || pressure[key] < 0) errors.push(`pressure.${key} invalid: ${pressure[key]}`);
		}
		for (const key of ["warnMemFrac", "critMemFrac"]) {
			if (!Number.isFinite(pressure[key]) || pressure[key] < 0 || pressure[key] > 1) errors.push(`pressure.${key} invalid: ${pressure[key]}`);
		}
		const hyst = pressure.hysteresis;
		if (typeof hyst !== "object" || hyst === null) errors.push("pressure.hysteresis missing");
		else {
			for (const key of ["warnExitLoad", "critExitLoad"]) {
				if (!Number.isFinite(hyst[key]) || hyst[key] < 0) errors.push(`pressure.hysteresis.${key} invalid: ${hyst[key]}`);
			}
			for (const key of ["warnExitMemFrac", "critExitMemFrac"]) {
				if (hyst[key] !== undefined && (!Number.isFinite(hyst[key]) || hyst[key] < 0 || hyst[key] > 1)) errors.push(`pressure.hysteresis.${key} invalid: ${hyst[key]}`);
			}
			if (!Number.isInteger(hyst.minStateMs) || hyst.minStateMs < 0) errors.push(`pressure.hysteresis.minStateMs invalid: ${hyst.minStateMs}`);
		}
	}
	const enforcement = doc.enforcement;
	if (typeof enforcement !== "object" || enforcement === null) errors.push("enforcement section missing");
	else if (typeof enforcement.autoKillOnCritical !== "boolean") errors.push("enforcement.autoKillOnCritical must be a boolean");
	// v0.4.0 optional disk section (pre-0.4.0 persisted profiles lack it and stay valid)
	if (doc.disk !== undefined) {
		const disk = doc.disk;
		if (typeof disk !== "object" || disk === null) errors.push("disk section must be an object");
		else {
			if (typeof disk.enabled !== "boolean") errors.push("disk.enabled must be a boolean");
			if (!Array.isArray(disk.paths) || disk.paths.some((p) => typeof p !== "string")) errors.push("disk.paths must be an array of strings");
			for (const key of ["warnAvailBytes", "critAvailBytes"]) {
				if (!Number.isInteger(disk[key]) || disk[key] < 1) errors.push(`disk.${key} invalid: ${disk[key]}`);
			}
			for (const key of ["warnUsePct", "critUsePct"]) {
				if (!Number.isFinite(disk[key]) || disk[key] < 0 || disk[key] > 1) errors.push(`disk.${key} invalid: ${disk[key]}`);
			}
			if (!Number.isInteger(disk.sampleTtlMs) || disk.sampleTtlMs < 1000) errors.push(`disk.sampleTtlMs invalid: ${disk.sampleTtlMs}`);
		}
	}
	return { ok: errors.length === 0, errors };
}

/** Create (if needed) and return a storage directory (harness-side fs, unsandboxed). */
export function storageDir(dir) {
	try {
		mkdirSync(dir, { recursive: true });
	} catch {
		/* read-only fallthrough: callers degrade to in-memory only */
	}
	return dir;
}

/** Atomic durable write: temp file + fsync + rename (incident lesson: unflushed writes die with hard power-off). */
export function writeFileDurable(path, text) {
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
	mkdirSync(dirname(path), { recursive: true });
	let fd = -1;
	try {
		fd = openSync(tmp, "w");
		writeFileSync(fd, text, { encoding: "utf8" });
		try { fsyncSync(fd); } catch { /* best effort */ }
	} finally {
		if (fd >= 0) {
			try { closeSync(fd); } catch { /* best effort */ }
		}
	}
	renameSync(tmp, path);
}

/**
 * Load a persisted host profile: schema-conformant documents pass through
 * (after structural validation), pre-schema `{hw, profile}` files are
 * migrated in memory. Returns `{ doc, migratedFromLegacy }` or null.
 */
export function loadHostProfileRaw(path) {
	const text = tryRead(path);
	if (text === null) return null;
	let parsed = null;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	if (parsed.schemaVersion === 1 && parsed.budget !== undefined && parsed.hardware !== undefined) {
		const check = validateHostProfile(parsed);
		return check.ok ? { doc: parsed, migratedFromLegacy: false } : null;
	}
	if (parsed.hw !== undefined && parsed.profile !== undefined) {
		return { doc: migrateLegacyProfile(parsed), migratedFromLegacy: true };
	}
	return null;
}

/** Load and return the schema-conformant document, or null. */
export function loadHostProfile(path) {
	const raw = loadHostProfileRaw(path);
	return raw === null ? null : raw.doc;
}

/**
 * Probe (or reload a fresh persisted profile) and publish into `shared`.
 * Re-probes when hardware changed (MemTotal / cpu count / cgroup limit) or the
 * profile is stale past `config.profileResampleMs` — this is how the plugin
 * follows hardware changes (e.g. .wslconfig edits) across its lifetime.
 * `force: true` (the v0.3.0 enable action) always re-probes, re-derives and
 * re-persists, so a re-enabled guard starts from a fresh budget.
 *
 * A confirmed profile stays confirmed across re-derivation; a fresh machine
 * starts in dry-run (confirmationRequired: true) until the user confirms.
 */
export function refreshHostProfile({ dir, config, force = false }) {
	// `dir === null` is the deliberate memory-only fallback when storage
	// migration fails. Keep probing and enforcing in memory, but do not create
	// an empty canonical directory that would strand the legacy facts.
	const path = typeof dir === "string" && dir.length > 0 ? join(dir, config.profileFileName) : null;
	const existing = path === null ? null : loadHostProfileRaw(path);
	const now = Date.now();
	const stale = force
		|| existing === null
		|| (now - (existing.doc.probedAt ?? 0)) > config.profileResampleMs;
	if (existing !== null && !stale) {
		shared.host = {
			path,
			doc: existing.doc,
			profile: deriveRuntimeProfile(existing.doc),
			migratedFromLegacy: existing.migratedFromLegacy
		};
		return shared.host;
	}
	const hw = probeHardware();
	const previousDoc = existing?.doc ?? null;
	const changed = previousDoc !== null && (
		previousDoc.hardware.memTotalBytes !== hw.memTotalBytes
		|| previousDoc.hardware.cpuCount !== hw.cpuCount
		|| (previousDoc.hardware.cgroup?.memMaxBytes ?? null) !== (hw.cgroup?.memMaxBytes ?? null)
	);
	let doc = buildHostProfile(hw, config, now);
	if (previousDoc !== null) {
		// carry confirmation state and user overrides across re-derivation
		doc.budget.derivedFrom = previousDoc.budget.derivedFrom;
		doc.budget.confirmationRequired = previousDoc.budget.confirmationRequired;
		const overrides = previousDoc.overrides ?? {};
		if (typeof overrides === "object" && overrides !== null && Object.keys(overrides).length > 0) {
			doc = applyOverrides(doc, overrides).doc;
		}
	}
	if (path !== null) {
		try {
			writeFileDurable(path, JSON.stringify(doc, null, 2));
		} catch {
			/* persistence is best-effort; the in-memory profile still applies */
		}
	}
	shared.host = {
		path,
		doc,
		profile: deriveRuntimeProfile(doc),
		changedFrom: changed ? previousDoc : null,
		migratedFromLegacy: existing?.migratedFromLegacy === true
	};
	return shared.host;
}

/** Overridable leaf fields: section → field → {validate}. */
const OVERRIDABLE_FIELDS = {
	budget: {
		cpuBudgetCores: (v) => Number.isFinite(v) && v > 0,
		cpuReservedCores: (v) => Number.isFinite(v) && v >= 0,
		memBudgetBytes: (v) => Number.isInteger(v) && v > 0,
		perCommandMemCapBytes: (v) => Number.isInteger(v) && v > 0,
		memoryRunawayBytes: (v) => Number.isInteger(v) && v > 0,
		perCommandMaxProcesses: (v) => Number.isInteger(v) && v >= 1,
		maxBackgroundJobs: (v) => Number.isInteger(v) && v >= 1,
		niceLevel: (v) => Number.isInteger(v) && v >= -20 && v <= 19
	},
	pressure: {
		warnLoad: (v) => Number.isFinite(v) && v >= 0,
		critLoad: (v) => Number.isFinite(v) && v >= 0,
		warnMemFrac: (v) => Number.isFinite(v) && v >= 0 && v <= 1,
		critMemFrac: (v) => Number.isFinite(v) && v >= 0 && v <= 1,
		hysteresis: {
			warnExitLoad: (v) => Number.isFinite(v) && v >= 0,
			critExitLoad: (v) => Number.isFinite(v) && v >= 0,
			warnExitMemFrac: (v) => Number.isFinite(v) && v >= 0 && v <= 1,
			critExitMemFrac: (v) => Number.isFinite(v) && v >= 0 && v <= 1,
			minStateMs: (v) => Number.isInteger(v) && v >= 0
		}
	}
};

/**
 * Apply user overrides onto a document. Unknown/invalid keys are rejected
 * without touching the document; only the applied subset is stored.
 * @returns {{doc, applied: object, rejected: string[]}}
 */
export function applyOverrides(doc, overrides) {
	const next = structuredClone(doc);
	const applied = {};
	const rejected = [];
	for (const [sectionName, section] of Object.entries(overrides ?? {})) {
		const fields = OVERRIDABLE_FIELDS[sectionName];
		if (fields === undefined) {
			rejected.push(`unknown section ${sectionName}`);
			continue;
		}
		if (typeof section !== "object" || section === null) {
			rejected.push(`section ${sectionName} must be an object`);
			continue;
		}
		for (const [field, value] of Object.entries(section)) {
			const fieldSpec = fields[field];
			if (fieldSpec === undefined) {
				rejected.push(`unknown field ${sectionName}.${field}`);
				continue;
			}
			if (typeof fieldSpec === "function") {
				if (!fieldSpec(value)) {
					rejected.push(`invalid value for ${sectionName}.${field}`);
					continue;
				}
				next[sectionName][field] = value;
			} else {
				if (typeof value !== "object" || value === null) {
					rejected.push(`field ${sectionName}.${field} must be an object`);
					continue;
				}
				for (const [sub, subValue] of Object.entries(value)) {
					const spec = fieldSpec[sub];
					if (spec === undefined) {
						rejected.push(`unknown field ${sectionName}.${field}.${sub}`);
						continue;
					}
					if (!spec(subValue)) {
						rejected.push(`invalid value for ${sectionName}.${field}.${sub}`);
						continue;
					}
					next[sectionName][field][sub] = subValue;
				}
			}
			if (applied[sectionName] === undefined) applied[sectionName] = {};
			applied[sectionName][field] = value;
		}
	}
	if (Object.keys(applied).length > 0) next.overrides = applied;
	return { doc: next, applied, rejected };
}

/**
 * Confirm the machine-private profile (hardware_guard `confirm` action): apply any
 * overrides, clear confirmationRequired, persist durably and republish.
 */
export function confirmHostProfile({ dir, overrides = {} } = {}) {
	const host = shared.host;
	if (host === null || host === undefined || host.doc === undefined) {
		return { ok: false, error: "no host profile loaded" };
	}
	const applied = applyOverrides(host.doc, overrides ?? {});
	const doc = applied.doc;
	doc.budget.confirmationRequired = false;
	doc.budget.derivedFrom = Object.keys(applied.applied).length > 0 ? "override" : "user-confirmed";
	const check = validateHostProfile(doc);
	if (!check.ok) return { ok: false, error: check.errors.join("; ") };
	const path = host.path ?? (dir === undefined || dir === null ? null : join(dir, shared.config.profileFileName));
	if (path !== null) {
		try {
			writeFileDurable(path, JSON.stringify(doc, null, 2));
		} catch (error) {
			return { ok: false, error: String(error?.message ?? error) };
		}
	}
	shared.host = { ...host, path, doc, profile: deriveRuntimeProfile(doc) };
	return { ok: true, doc, applied: applied.applied, rejected: applied.rejected };
}

/** Multi-line summary for tool output and context injections. */
export function summarizeProfile(host) {
	if (host === null || host === undefined || host.doc === undefined) return "hardware-guard: host profile not loaded yet";
	const doc = host.doc;
	const p = host.profile;
	const hw = doc.hardware ?? {};
	const hostInfo = doc.host ?? {};
	const hyst = p.hysteresis ?? {};
	const lines = [
		`platform: ${hostInfo.platform}/${hostInfo.arch}${hostInfo.isWsl ? " (WSL2 — dynamic memory VM)" : ""}`,
		`cpu: ${hw.cpuCount} cores (${hw.cpuModel})${p.cpuReservedCores > 0 ? `, ${p.cpuBudgetCores} budgeted (${p.cpuReservedCores} reserved for host)` : ""}`,
		`memory: total ${fmtBytes(hw.memTotalBytes)}, effective ${fmtBytes(p.effectiveMemBytes)}, budget ${fmtBytes(p.memBudgetBytes)}`,
		hw.cgroup?.memMaxBytes != null ? `cgroup memory.max: ${fmtBytes(hw.cgroup.memMaxBytes)}` : `cgroup memory.max: unlimited`,
		`swap: ${fmtBytes(hw.swapTotalBytes)}`,
		`limits: per-command address space ${fmtBytes(p.perCommandMemCapBytes)}, memory runaway threshold ${fmtBytes(p.memoryRunawayBytes)}, cpu mask ${p.cpuMask}, nice ${p.niceLevel}, max background jobs ${p.maxBackgroundJobs}`,
		`pressure thresholds: warn at free<${fmtBytes(p.warnMemBytes)} or load1>=${p.warnLoad}; critical at free<${fmtBytes(p.critMemBytes)} or load1>=${p.critLoad}`,
		`hysteresis: exit warn at free>=${fmtBytes(hyst.warnExitMemBytes)} or load1<${hyst.warnExitLoad}; exit critical at free>=${fmtBytes(hyst.critExitMemBytes)} or load1<${hyst.critExitLoad}; min dwell ${hyst.minStateMs}ms`,
		p.disk?.enabled === false
			? "disk monitoring: disabled (disk axis off)"
			: p.disk === undefined || p.disk === null
				? "disk monitoring: not configured (no disk section)"
				: `disk monitoring: enabled — warn <${fmtBytes(p.disk.warnAvailBytes)} avail or >=${Math.round(p.disk.warnUsePct * 100)}% used; crit <${fmtBytes(p.disk.critAvailBytes)} avail or >=${Math.round(p.disk.critUsePct * 100)}% used${(p.disk.paths ?? []).length > 0 ? `; explicit paths: ${p.disk.paths.join(", ")}` : " (paths auto-resolved: $DSH_HOME, cwd, WSL /mnt/c)"}`,
		p.enforcementActive
			? `enforcement: active (derivedFrom ${p.derivedFrom})`
			: `enforcement: DRY-RUN — profile pending user confirmation (hardware_guard confirm); caps, admission and kill are NOT applied yet`
	];
	return lines.join("\n");
}

export function fmtBytes(bytes) {
	if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "unknown";
	if (bytes === 0) return "0 B";
	const units = ["B", "KiB", "MiB", "GiB", "TiB"];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/** Existence helper kept for tests/diagnostics. */
export function fileExists(path) {
	return existsSync(path);
}
