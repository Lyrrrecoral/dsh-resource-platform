/**
 * Live resource-pressure sampling and classification with hysteresis.
 *
 * Sampling is deliberately cheap (a few /proc reads plus — v0.4.0 — a few
 * synchronous statfs reads) and cached per TTL so the pre-execute admission
 * gate and the per-execution DSH_HW_* environment resolvers can call it on
 * every tool call without measurable overhead.
 *
 * The classifier is a small state machine with hysteresis:
 *  - UPGRADES (ok→warn, ok→critical, warn→critical) fire immediately on the
 *    entry thresholds (protective),
 *  - DOWNGRADES additionally require BOTH exit thresholds to be met
 *    (load below warnExitLoad/critExitLoad AND free above the exit memory
 *    fractions) and the state to have persisted at least `minStateMs`
 *    (minimum dwell) — this is what stops the load1≈threshold flip-flopping
 *    between ok and warn every tick.
 *
 * v0.4.0 — third axis: DISK. `vitals.disks` carries one entry per monitored
 * path with its own thresholds stamped in (see lib/disk.js). Any path whose
 * available bytes drop below warn/critAvailBytes or whose usage reaches
 * warn/critUsePct counts into the reasons; the disk axis takes the highest
 * state across all paths and merges with the memory/load axes (highest
 * state wins). The disk axis is SYMMETRIC (no exit thresholds): a disk that
 * fills is usually monotonic, and a disk that clears must release the state
 * immediately. With NO disk facts (`vitals.disks` missing/empty) the
 * classifier behaves exactly as before — no disk reasons are produced.
 *
 * @module hardware-guard/pressure
 */
import { readFileSync } from "node:fs";
import { freemem, loadavg, totalmem } from "node:os";
import { parseLoadavg, parseMeminfo } from "./host-profile.js";
import { createDiskSampler, diskEntryLevel, diskReasonsFor } from "./disk.js";
import { shared } from "./state.js";

function tryRead(path) {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

/** Fresh cross-platform vitals read. Synchronous on Linux (/proc), os-based elsewhere. */
export function sampleVitals() {
	const at = Date.now();
	let memTotalBytes = 0;
	let memAvailableBytes = 0;
	let load = null;
	try {
		if (process.platform === "linux") {
			const meminfo = parseMeminfo(tryRead("/proc/meminfo"));
			memTotalBytes = meminfo.MemTotal ?? 0;
			memAvailableBytes = meminfo.MemAvailable ?? 0;
			load = parseLoadavg(tryRead("/proc/loadavg"));
		} else {
			memTotalBytes = totalmem();
			memAvailableBytes = freemem();
			const values = loadavg();
			load = { load1: values[0], load5: values[1], load15: values[2] };
		}
	} catch {
		/* keep zeros; classification treats unknowns as OK */
	}
	return {
		at,
		memTotalBytes,
		memAvailableBytes,
		load1: load?.load1 ?? 0,
		load5: load?.load5 ?? 0,
		load15: load?.load15 ?? 0
	};
}

/** "warn" | "critical" entry conditions for one vitals sample. */
function entryConditions(vitals, profile) {
	const freeBytes = Math.max(0, vitals.memAvailableBytes ?? 0);
	const load1 = vitals.load1 ?? 0;
	return {
		freeBytes,
		load1,
		memCritical: freeBytes < profile.critMemBytes,
		memWarn: freeBytes < profile.warnMemBytes,
		loadCritical: load1 >= profile.critLoad,
		loadWarn: load1 >= profile.warnLoad
	};
}

/**
 * Classify one vitals sample against the derived profile, honoring
 * hysteresis when the current state is provided.
 *
 * @param {object} vitals - `{memAvailableBytes, load1, disks?}` sample
 *   (`disks` = v0.4.0 sampled disk entries; absent/empty → no disk axis)
 * @param {object} profile - derived profile (must carry `hysteresis` for
 *   hysteresis to apply; profiles without it degrade to symmetric behavior)
 * @param {object} [stateInfo] - `{state, stateChangedAt, now}`; omitted
 *   (legacy callers) classifies from a fresh "ok" baseline
 * @returns {{state: "ok"|"warn"|"critical", reasons: string[], details: object}}
 */
export function classifyPressure(vitals, profile, stateInfo) {
	const info = stateInfo ?? {};
	const current = info.state === "warn" || info.state === "critical" ? info.state : "ok";
	const now = Number.isFinite(info.now) ? info.now : Date.now();
	const entry = entryConditions(vitals, profile);
	const hyst = profile.hysteresis ?? null;

	// v0.4.0 disk axis: per-path thresholds ride the sampled entries. Any
	// path crossing avail OR use% counts; the disk axis takes the highest
	// state across paths. No facts → axis silent.
	const disks = Array.isArray(vitals.disks) ? vitals.disks : [];
	let diskCritical = false;
	let diskWarn = false;
	for (const disk of disks) {
		const level = diskEntryLevel(disk);
		if (level === "critical") diskCritical = true;
		else if (level === "warn") diskWarn = true;
	}

	const criticalReasons = [];
	if (entry.memCritical) criticalReasons.push(`free memory ${entry.freeBytes} < critical ${profile.critMemBytes}`);
	if (entry.loadCritical) criticalReasons.push(`load1 ${entry.load1.toFixed(2)} >= critical ${profile.critLoad}`);
	if (diskCritical) criticalReasons.push(...diskReasonsFor(disks, "critical"));
	const warnReasons = [];
	if (entry.memWarn) warnReasons.push(`free memory ${entry.freeBytes} < warn ${profile.warnMemBytes}`);
	if (entry.loadWarn) warnReasons.push(`load1 ${entry.load1.toFixed(2)} >= warn ${profile.warnLoad}`);
	if (diskWarn) warnReasons.push(...diskReasonsFor(disks, "warn"));

	// Exit conditions: all three axes must clear. Without hysteresis data
	// each axis falls back to "no longer at entry level" (symmetric
	// behavior). The disk axis is always symmetric (no exit thresholds).
	const warnExitOk = hyst === null
		? !(entry.memWarn || entry.loadWarn || diskWarn)
		: (hyst.warnExitLoad === undefined || entry.load1 < hyst.warnExitLoad)
			&& (hyst.warnExitMemBytes === undefined || entry.freeBytes >= hyst.warnExitMemBytes)
			&& !diskWarn;
	const critExitOk = hyst === null
		? !(entry.memCritical || entry.loadCritical || diskCritical)
		: (hyst.critExitLoad === undefined || entry.load1 < hyst.critExitLoad)
			&& (hyst.critExitMemBytes === undefined || entry.freeBytes >= hyst.critExitMemBytes)
			&& !diskCritical;

	let next = current;
	if (current === "critical") {
		if (critExitOk) next = (entry.memWarn || entry.loadWarn || diskWarn) ? "warn" : "ok";
	} else if (current === "warn") {
		if (entry.memCritical || entry.loadCritical || diskCritical) next = "critical";
		else if (warnExitOk) next = "ok";
	} else {
		if (entry.memCritical || entry.loadCritical || diskCritical) next = "critical";
		else if (entry.memWarn || entry.loadWarn || diskWarn) next = "warn";
	}

	// Minimum dwell applies to downgrades only; upgrades stay immediate.
	let dwell = false;
	if (next !== current) {
		const isDowngrade = (current === "critical" && (next === "warn" || next === "ok"))
			|| (current === "warn" && next === "ok");
		const minStateMs = Number(hyst?.minStateMs ?? 0);
		if (isDowngrade && minStateMs > 0 && now - (info.stateChangedAt ?? 0) < minStateMs) {
			dwell = true;
			next = current;
		}
	}

	const reasons = next === "critical" ? criticalReasons : next === "warn" ? warnReasons : [];
	return {
		state: next,
		reasons,
		details: {
			freeBytes: entry.freeBytes,
			load1: entry.load1,
			dwell,
			/** v0.4.0 per-axis entry flags (watchdog uses them to skip auto-kill on disk-only critical). */
			entry: {
				memCritical: entry.memCritical,
				loadCritical: entry.loadCritical,
				diskCritical,
				memWarn: entry.memWarn,
				loadWarn: entry.loadWarn,
				diskWarn
			}
		}
	};
}

/**
 * Process-wide default disk sampler (5s TTL). The main row passes a
 * config-TTL sampler; standalone rows (sandbox wrapper, executor) use this
 * one. Both read `shared.diskPaths`, so a path list resolved at boot is
 * honored everywhere.
 */
const defaultDiskSampler = createDiskSampler({});

/**
 * TTL-cached sampler with transition tracking. `tick()` updates `shared`
 * and returns the current hysteresis-stabilized classification plus whether
 * the state changed.
 *
 * v0.4.0: every tick also samples the monitored disks (its own TTL) and
 * writes them into `shared.vitals.disks`, so the gate, the tool report and
 * `/resources/hardware.json` all see the same fresh disk facts.
 */
export function createPressureMonitor({ cacheTtlMs = 1000, diskSampler = null } = {}) {
	let cached = null;
	// Resolve the sampler lazily so tests (and the sandbox/executor rows that
	// never pass one) pick up `shared.diskSampler` after apply() wires it.
	const resolveSampler = () => diskSampler ?? shared.diskSampler ?? defaultDiskSampler;
	return {
		/**
		 * Sample (with TTL cache) and classify.
		 * @param {object|null} host - `shared.host` (host profile with derived `profile`)
		 */
		tick(host) {
			const now = Date.now();
			if (cached === null || now - cached.at >= cacheTtlMs) {
				cached = { ...sampleVitals(), at: now };
			}
			cached.disks = resolveSampler().sample(shared.diskEntries ?? []);
			if (host === null || host === undefined || host.profile === undefined) {
				return { vitals: cached, state: "ok", reasons: [], changed: false, previous: shared.pressureState };
			}
			const classification = classifyPressure(cached, host.profile, {
				state: shared.pressureState,
				stateChangedAt: shared.pressureChangedAt,
				now
			});
			const previous = shared.pressureState;
			const changed = classification.state !== previous;
			shared.vitals = cached;
			shared.pressureState = classification.state;
			if (changed) shared.pressureChangedAt = now;
			return { ...classification, vitals: cached, changed, previous };
		}
	};
}
