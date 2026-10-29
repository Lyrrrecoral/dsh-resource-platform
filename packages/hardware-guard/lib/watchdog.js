/**
 * Watchdog: per-tick descendant accounting, memory observation with graded
 * caps (v0.3.1), pressure alerts and the optional auto-kill sweep.
 *
 * Linux-only enforcement (prlimit/taskset/renice); on other platforms the
 * watchdog only classifies pressure and alerts, never kills.
 *
 * v0.3.1 memory protection: the watchdog NO LONGER retroactively applies
 * `prlimit --as` to every descendant (that blanket was the 2026-08-17
 * killer — Node/V8 SIGILL, Python/bash SIGSEGV). Memory protection is now
 * observe-then-grade:
 *   1. OBSERVE — descendants whose VmSize/RSS approaches the per-command
 *      cap are recorded (once per pid) as a `mem-observation` incident;
 *      observation alone never caps.
 *   2. GRADE — a process is capped only when it is CONFIRMED as a compute
 *      task (spawned with the explicit DSH_HW_COMPUTE marker, read from its
 *      /proc environ) AND the memoryCapPolicy allows it
 *      (`compute-only`; `none` caps nobody; `all` restores the pre-0.3.1
 *      blanket for testing). Unconfirmed processes are never capped.
 * Project-level hard memory ceilings stay the business of systemd unit
 * MemoryHigh/MemoryMax — not duplicated here.
 *
 * The auto-kill sweep ONLY targets genuine runaways among the harness's own
 * descendants: a process must be demonstrably burning CPU (> half a core of
 * tick-to-tick CPU time) or be a policy-aware memory runaway (v0.3.2: under
 * `none`/`compute-only` that means RSS >= the independent
 * `memoryRunawayBytes` threshold; only the `all` blanket and confirmed
 * compute processes keep the per-command-cap × 0.8 grading). Idle-but-
 * resident services (MCP bridges, databases, …) are never killed — the
 * original RSS-only selection massacred the `hermes` MCP bridge every
 * cooldown while the real load (a systemd-managed compute fleet outside the
 * harness tree) went untouched.
 *
 * @module hardware-guard/watchdog
 */
import { execFileSync } from "node:child_process";
import { deriveMemoryRunawayBytes, fmtBytes } from "./host-profile.js";
import { recordIncident } from "./incidents.js";
import { listDescendants, readProcessTable, readProcEnviron, sumRss } from "./proc-tree.js";
import { capAllowedForProcess, computeMarked, guardEnabled, shared } from "./state.js";

/** User-Hz ticks per second for /proc stat cpu fields (standard on x86_64). */
const CLK_TCK = 100;

/** Fraction of the per-command cap that counts as "approaching" (observation). */
const MEM_APPROACH_FRACTION = 0.8;

/** Run a binary with a hard timeout, returning {ok, stdout, error}. */
function run(argv, timeoutMs) {
	try {
		const stdout = execFileSync(argv[0], argv.slice(1), {
			timeout: timeoutMs,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"]
		});
		return { ok: true, stdout };
	} catch (error) {
		return { ok: false, error: String(error.message ?? error) };
	}
}

/** Apply `prlimit --as` retroactively to one pid; best-effort, cached. */
function capProcess(pid, profile, timeoutMs) {
	if (shared.cappedPids.has(pid)) return { applied: false };
	const capBytes = profile.perCommandMemCapBytes;
	const result = run(["prlimit", "--pid", String(pid), "--as", String(capBytes)], timeoutMs);
	if (result.ok) shared.cappedPids.set(pid, Date.now());
	return { applied: result.ok, error: result.ok ? undefined : result.error };
}

/** Attempt a graceful SIGTERM; the caller escalates after the grace period. */
function terminate(pid) {
	try {
		process.kill(pid, "SIGTERM");
		return true;
	} catch {
		return false;
	}
}

function killNow(pid) {
	try {
		process.kill(pid, "SIGKILL");
		return true;
	} catch {
		return false;
	}
}

/** Fraction of one core consumed between two ticks (0..N). */
function cpuFraction(entry, previousCpu, elapsedMs) {
	if (previousCpu === undefined || elapsedMs <= 0) return 0;
	const delta = Math.max(0, entry.cpuTicks - previousCpu);
	return (delta / CLK_TCK) / (elapsedMs / 1000);
}

/**
 * Select genuine runaways among guardable descendants (v0.3.2 policy-aware).
 *
 * CPU grading is policy-independent: burning more than half a core
 * tick-to-tick is always a true runaway. Memory grading follows
 * `memoryCapPolicy` so the kill criterion and the v0.3.1 cap semantics
 * stay consistent:
 *  - `none`: RSS >= the independent `memoryRunawayBytes` threshold
 *    (default `min(4 GiB, memBudgetBytes × 0.25)`) — the per-command cap
 *    no longer doubles as the kill criterion;
 *  - `compute-only`: confirmed-compute processes grade against
 *    `perCommandMemCapBytes × 0.8` (their cap), everyone else against
 *    `memoryRunawayBytes`;
 *  - `all`: the pre-0.3.2 blanket — `perCommandMemCapBytes × 0.8` for
 *    every guardable descendant.
 *
 * Processes killed recently are skipped so a restarted service is not
 * murdered again on the next tick.
 */
function selectVictims(guardable, profile, cpuTicks, now, config) {
	const elapsedMs = Math.max(1, now - (shared.lastCpuSampleAt ?? now));
	const killedRecently = new Set(shared.killHistory ?? []);
	const policy = config?.memoryCapPolicy ?? "none";
	const capBytes = Math.max(1, profile.perCommandMemCapBytes ?? 0);
	const runawayBytes = Math.max(1, profile.memoryRunawayBytes ?? deriveMemoryRunawayBytes(profile.memBudgetBytes));
	const candidates = [];
	for (const entry of guardable) {
		if (killedRecently.has(entry.pid)) continue;
		const cpu = cpuFraction(entry, cpuTicks.get(entry.pid), elapsedMs);
		const confirmedCompute = shared.computeConfirmedPids.get(entry.pid) === true;
		const perCommandGraded = policy === "all" || (policy === "compute-only" && confirmedCompute);
		const overMem = perCommandGraded
			? entry.rssBytes >= capBytes * MEM_APPROACH_FRACTION
			: entry.rssBytes >= runawayBytes;
		if (cpu > 0.5 || overMem) {
			candidates.push({ entry, cpu, overMem, score: cpu * 10 + entry.rssBytes / capBytes });
		}
	}
	candidates.sort((left, right) => right.score - left.score);
	return candidates.slice(0, 4).map(({ entry }) => entry);
}

export { selectVictims };

/**
 * One memory-guard pass over guardable descendants (pure, injectable for
 * tests): OBSERVE processes approaching the per-command cap (first crossing
 * per pid only) and GRADE which pids get a retroactive `--as` cap.
 *
 * Grade rule (v0.3.1): cap only when the policy allows AND — outside the
 * explicit `all` blanket — the process identity is CONFIRMED compute via
 * the DSH_HW_COMPUTE marker in its environ. Unconfirmed processes are never
 * capped under `none`/`compute-only`.
 *
 * @param {object} input
 * @param {Array} input.guardable - descendant process entries
 * @param {object} input.profile - runtime profile (perCommandMemCapBytes)
 * @param {string} input.policy - memoryCapPolicy: none | compute-only | all
 * @param {function} input.environOf - (pid) => env object (parsed /proc environ)
 * @param {Map} input.observed - shared.memObservedPids (pid -> first stamp)
 * @param {Map} input.confirmedCache - shared.computeConfirmedPids (pid -> boolean)
 * @param {number} input.now - epoch ms
 * @returns {{observations: Array, toCap: Array}}
 */
export function memoryGuardPass({ guardable, profile, policy, environOf, observed, confirmedCache, now }) {
	const observations = [];
	const toCap = [];
	const capBytes = Math.max(1, profile.perCommandMemCapBytes ?? 0);
	for (const entry of guardable) {
		const approaching = entry.vsizeBytes >= capBytes * MEM_APPROACH_FRACTION
			|| entry.rssBytes >= capBytes * MEM_APPROACH_FRACTION;
		if (approaching && !observed.has(entry.pid)) {
			observed.set(entry.pid, now);
			observations.push(entry);
		}
		let confirmed = confirmedCache.get(entry.pid);
		if (confirmed === undefined) {
			confirmed = computeMarked(environOf(entry.pid));
			confirmedCache.set(entry.pid, confirmed);
		}
		if (capAllowedForProcess(policy, confirmed)) toCap.push(entry);
	}
	return { observations, toCap };
}

/**
 * One watchdog tick.
 * @param {object} input
 * @param {object} input.host - shared.host
 * @param {object} input.pressure - pressure monitor tick result
 * @param {function} input.onTransition - ({state, previous, summary}) => void, called on state changes
 * @param {function} [input.environOf] - (pid) => env object; defaults to /proc reading (tests inject fakes)
 * @returns tick report for logging/diagnostics
 */
export function watchdogTick({ host, pressure, onTransition, environOf = readProcEnviron }) {
	const config = shared.config;
	const report = {
		state: pressure.state,
		descendants: [],
		observed: 0,
		capped: 0,
		killed: [],
		skipped: false,
		enforcement: "active"
	};
	if (pressure.changed && typeof onTransition === "function") {
		onTransition({ state: pressure.state, previous: pressure.previous, reasons: pressure.reasons, details: pressure.details });
	}
	if (process.platform !== "linux") {
		report.skipped = true;
		return report;
	}
	const table = readProcessTable();
	const descendants = listDescendants(table, process.pid);
	report.descendants = descendants.map((entry) => ({ pid: entry.pid, comm: entry.comm, rssBytes: entry.rssBytes }));
	const exclude = new Set(config.excludeComm ?? []);
	const guardable = descendants.filter((entry) => !exclude.has(entry.comm));
	const now = Date.now();
	// Enforcement (graded caps + auto-kill) stays off while the
	// machine-private profile awaits user confirmation (dry-run) or while the
	// v0.3.0 control switch is disabled; pressure alerts and bookkeeping keep
	// running either way.
	const enforcing = guardEnabled() && host.profile?.enforcementActive !== false;
	report.enforcement = guardEnabled() ? (enforcing ? "active" : "dry-run") : "disabled";
	// Previous tick's snapshot; the FIRST tick has none — default to an empty
	// map instead of undefined, or `selectVictims` would crash and (because
	// the bookkeeping below was skipped by that throw) crash EVERY tick.
	const previousCpuTicks = shared.cpuTicks ?? new Map();

	try {
		// 1. v0.3.1 memory protection: observe approaching processes, then
		// cap ONLY policy-approved, identity-confirmed compute tasks.
		if (enforcing) {
			const pass = memoryGuardPass({
				guardable,
				profile: host.profile,
				policy: config.memoryCapPolicy ?? "none",
				environOf,
				observed: shared.memObservedPids,
				confirmedCache: shared.computeConfirmedPids,
				now
			});
			for (const entry of pass.observations) {
				recordIncident("mem-observation", {
					pid: entry.pid,
					comm: entry.comm,
					vsizeBytes: entry.vsizeBytes,
					rssBytes: entry.rssBytes,
					capBytes: host.profile.perCommandMemCapBytes
				});
			}
			report.observed = pass.observations.length;
			for (const entry of pass.toCap) {
				const applied = capProcess(entry.pid, host.profile, config.prlimitTimeoutMs);
				if (applied.applied) report.capped += 1;
			}
		}

		// 2. Auto-kill sweep on CRITICAL (opt-in), with cooldown — victims only.
		// v0.4.0: a DISK-ONLY critical never sweeps — the process tree is not
		// necessarily the cause of a full disk (and hardware-guard never deletes
		// files), so killing harness descendants would shed the wrong load.
		// The transition incident is still recorded by the watchdog caller.
		// Synthetic pressure inputs without `details.entry` keep legacy
		// behavior (sweep allowed) — only real ticks carry the axis flags.
		const entry = pressure.details?.entry;
		const diskOnlyCritical = entry !== undefined
			&& entry.diskCritical === true
			&& entry.memCritical !== true
			&& entry.loadCritical !== true;
		if (enforcing && pressure.state === "critical" && !diskOnlyCritical && config.autoKillOnCritical === true && now - shared.lastKillAt >= config.killCooldownMs) {
			const victims = selectVictims(guardable, host.profile, previousCpuTicks, now, config);
			if (victims.length > 0) {
				const victimPids = victims.map((entry) => entry.pid);
				for (const pid of victimPids) terminate(pid);
				if (config.killGraceMs > 0) {
					setTimeout(() => {
						for (const pid of victimPids) {
							if (table.get(pid) !== undefined) killNow(pid);
						}
					}, config.killGraceMs).unref?.();
				}
				shared.lastKillAt = now;
				shared.killHistory = [...victimPids, ...(shared.killHistory ?? [])].slice(0, 64);
				report.killed = victims.map((entry) => `${entry.pid}:${entry.comm}(${fmtBytes(entry.rssBytes)})`);
				recordIncident("auto-kill", {
					state: pressure.state,
					reasons: pressure.reasons,
					freeBytes: pressure.details.freeBytes,
					load1: pressure.details.load1,
					totalDescendantRssBytes: sumRss(descendants),
					killed: report.killed
				});
			}
		}
	} finally {
		// 3. Bookkeeping for the next tick's CPU accounting. Runs even when a
		// step above throws — the throw-then-skip pattern was the cause of the
		// "Cannot read properties of undefined (reading 'get')" watchdog loop.
		const cpuTicks = new Map();
		for (const entry of descendants) cpuTicks.set(entry.pid, entry.cpuTicks);
		shared.cpuTicks = cpuTicks;
		shared.lastCpuSampleAt = now;
	}
	return report;
}

/**
 * Retroactive prlimit scan over the harness's existing descendants. Used by
 * the v0.3.0 enable action: after the caches are cleared, eligible
 * descendants get the address-space cap re-applied where the kernel permits.
 * Skipped while the control switch is off or the machine-private profile is
 * still in dry-run (enforcement inactive) — re-capping is enforcement.
 *
 * v0.3.1: the scan is GRADED by memoryCapPolicy exactly like the tick —
 * `none` caps nobody, `compute-only` caps only DSH_HW_COMPUTE-confirmed
 * compute descendants, `all` restores the pre-0.3.1 blanket. Under `none`
 * (the default) an enable NEVER re-imposes `--as` on existing processes.
 * NOTE: limits inherited at spawn that were relaxed while the guard was
 * disabled cannot always be restored — this is best effort, and the enable
 * action's reply text says so.
 * @returns {{capped: number, total: number, eligible: number, skipped: boolean}}
 */
export function retroCapDescendants(host, config = shared.config) {
	if (host === null || host === undefined || host.profile === undefined || host.profile === null) {
		return { capped: 0, total: 0, eligible: 0, skipped: true };
	}
	if (!guardEnabled() || host.profile.enforcementActive === false) {
		return { capped: 0, total: 0, eligible: 0, skipped: true };
	}
	if (process.platform !== "linux") return { capped: 0, total: 0, eligible: 0, skipped: true };
	const table = readProcessTable();
	const descendants = listDescendants(table, process.pid);
	const exclude = new Set(config.excludeComm ?? []);
	const guardable = descendants.filter((entry) => !exclude.has(entry.comm));
	const pass = memoryGuardPass({
		guardable,
		profile: host.profile,
		policy: config.memoryCapPolicy ?? "none",
		environOf: readProcEnviron,
		observed: shared.memObservedPids,
		confirmedCache: shared.computeConfirmedPids,
		now: Date.now()
	});
	let capped = 0;
	for (const entry of pass.toCap) {
		const applied = capProcess(entry.pid, host.profile, config.prlimitTimeoutMs);
		if (applied.applied) capped += 1;
	}
	return { capped, total: guardable.length, eligible: pass.toCap.length, skipped: false };
}
