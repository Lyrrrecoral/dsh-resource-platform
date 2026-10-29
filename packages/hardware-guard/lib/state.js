/**
 * Process-wide shared state for hardware-guard.
 *
 * Both entry points of this bundle — the host-guard plugin (`lib/index.js`)
 * and the shell executor (`lib/shell.js`) — are mounted as separate Cordis
 * rows inside the same process. A plain module-level singleton is the shared
 * memory between them: it survives realm/isolation boundaries that Cordis
 * services do not, and it is re-derived from the persisted host profile
 * whenever the process restarts.
 *
 * v1.0 boundary: this package owns probing, budgets, hard caps, admission
 * and true-runaway killing only. No business task types (no math/systemd
 * specifics) live here — those belong to project manifests (dsh-ops).
 *
 * @module hardware-guard/state
 */

import { DEFAULT_EXCLUDE_DIRS } from "./probe.js";

/** Defaults derived from the R(4,6) incident postmortem (session 62d9db45). */
export const DEFAULTS = Object.freeze({
	// ---- probing / budgets ----
	/** Budget = effective memory × this fraction (the policy default formula). */
	memSafetyFrac: 0.75,
	/** Cores kept for the host itself; cpuBudget = max(1, cores − reserve). */
	cpuReservedCores: 0,
	/** Per-command address-space cap: the incident's proven `ulimit -v 1.5GB`. */
	perCommandMemCapBytes: 1610612736,
	/**
	 * v0.3.2 independent runaway threshold for the auto-kill sweep's memory
	 * grading: `min(4 GiB, memBudgetBytes × 0.25)` when omitted. Outside the
	 * `all` policy, RSS crossing THIS threshold (not the per-command cap ×
	 * 0.8) marks a process a true memory runaway — the cap stays a cap, the
	 * runaway threshold stays a runaway threshold.
	 */
	memoryRunawayBytes: undefined,
	niceLevel: 10,
	maxProcesses: 512,
	// ---- pressure thresholds (entry) ----
	warnMemFrac: 0.2,
	critMemFrac: 0.1,
	warnLoadFactor: 1.0,
	critLoadFactor: 2.0,
	// ---- pressure hysteresis (exit thresholds + minimum dwell) ----
	/** Leave WARN once load1 < cores × this (0.8 → 4.8 on a 6-core host). */
	warnExitLoadFactor: 0.8,
	/** Leave CRITICAL once load1 < cores × this (1.0 → warn-entry level). */
	critExitLoadFactor: 1.0,
	/** Leave WARN once free ≥ this fraction of effective memory. */
	warnExitMemFrac: 0.25,
	/** Leave CRITICAL once free ≥ this fraction of effective memory. */
	critExitMemFrac: 0.15,
	/** Minimum dwell time in a state before a downgrade is honored (ms). */
	minStateMs: 30000,
	/** Pressure sampling TTL: vitals re-read at most this often (ms). */
	samplingIntervalMs: 1000,
	// ---- admission control ----
	maxBackgroundJobs: undefined,
	/** Bash tool names gated by the pressure admission control. */
	gatedTools: ["bash", "pwsh"],
	/** Command prefixes still allowed while the host is in CRITICAL pressure. */
	allowOnCritical: ["ps ", "free ", "uptime", "top ", "cat /proc/", "prlimit ", "ulimit ", "df ", "du ", "hardware_guard"],
	// ---- watchdog ----
	watchdogIntervalMs: 15000,
	killGraceMs: 10000,
	autoKillOnCritical: false,
	killCooldownMs: 120000,
	/** Never prlimit/kill processes whose comm matches (harness runtime). */
	excludeComm: ["node", "pnpm"],
	prlimitTimeoutMs: 500,
	// ---- context injection (quiet mode: everything off by default) ----
	contextRefreshMs: 600000,
	/**
	 * Per-channel opt-in gates for every agent.inject / agent.followup call.
	 * v0.3.0 quiet mode: ALL default false — the guard never wakes or
	 * injects into agents unless an operator explicitly opts a channel in.
	 */
	injection: Object.freeze({
		turnOneProfile: false,
		periodicReport: false,
		transitionReports: false,
		criticalNotice: false
	}),
	// ---- persistence ----
	profileFileName: "host-profile.json",
	incidentsFileName: "incidents.jsonl",
	incidentsMaxEntries: 200,
	/** Rotate incidents.jsonl to one .1 archive before an append would exceed this. */
	incidentsMaxBytes: 2 * 1024 * 1024,
	controlFileName: "control.json",
	adaptationsFileName: "adaptations.json",
	/** Re-probe and persist at most this often (ms). */
	profileResampleMs: 3600000,
	profileTtlMs: 86400000,
	// ---- executor ----
	executorEnabled: true,
	// ---- v0.3.1 selective memory caps ----
	/**
	 * Which execution paths get a per-command address-space cap (`prlimit
	 * --as` / `ulimit -v`). The v0.3.0 blanket 1.5 GiB cap killed Node/V8
	 * (SIGILL via the fatal trap), Python and bash (SIGSEGV on allocation)
	 * — the 2026-08-17 incident — so the DEFAULT is `none`: every shell
	 * keeps DSH_HW_* facts, nice and --nproc, but NO --as.
	 *  - "none":         nice/nproc only (default);
	 *  - "compute-only": --as only for execution paths carrying the
	 *                    explicit DSH_HW_COMPUTE marker;
	 *  - "all":          the pre-0.3.1 blanket (testing/rollback only).
	 */
	memoryCapPolicy: "none",
	// ---- adaptation ----
	/** Master switch for the incident-driven bounded adaptation engine. */
	adaptationEnabled: true,
	// ---- v0.4.0 disk axis (third pressure axis) ----
	/**
	 * Disk-availability monitoring config. The monitored PATH set is resolved
	 * live at boot (see lib/disk.js `resolveDiskPaths`): the filesystem
	 * holding `$DSH_HOME`, the one holding `process.cwd()`, and on WSL2
	 * `/mnt/c` when present — every path stat-probed, failures skipped, never
	 * failing plugin boot. Thresholds are per path and stamped onto every
	 * sampled entry, so the classifier stays self-describing.
	 */
	disk: Object.freeze({
		enabled: true,
		/** Explicit monitor-path list; empty = auto-resolve. */
		paths: [],
		warnAvailBytes: 20 * 1024 ** 3,
		critAvailBytes: 10 * 1024 ** 3,
		warnUsePct: 0.9,
		critUsePct: 0.95,
		/** Synchronous statfs sampling TTL (ms). */
		sampleTtlMs: 5000
	}),
	/**
	 * v0.5.0 project output-file probe: scan configured project roots for
	 * cleanup candidates and expose them for user-approved deletion only.
	 * Disabled by default; roots must be set explicitly in the profile.
	 */
	cleanupProbe: Object.freeze({
		enabled: false,
		roots: [],
		maxDepth: 4,
		maxFiles: 20000,
		minSizeBytes: 64 * 1024 * 1024,
		minAgeMs: 0,
		topN: 50,
		excludeDirs: DEFAULT_EXCLUDE_DIRS,
		softDelete: true,
		/** Soft-delete trash older than this is removed by bounded sweeps; 0 disables. */
		trashRetentionDays: 7
	})
});

/** v0.3.1 compute-marker environment variable (explicit opt-in to the --as cap). */
export const COMPUTE_ENV_MARKER = "DSH_HW_COMPUTE";

/**
 * Whether an environment carries the explicit compute marker. Accepts a
 * plain env object (`ShellExecRequest.env`, a parsed /proc/<pid>/environ) —
 * any value other than "", "0" or "false" counts as marked. The model-facing
 * bash tool cannot set this; only trusted in-process plugins can.
 */
export function computeMarked(env) {
	if (env === null || env === undefined || typeof env !== "object") return false;
	const value = env[COMPUTE_ENV_MARKER];
	if (value === undefined || value === null) return false;
	if (typeof value === "string") return value !== "" && value !== "0" && value.toLowerCase() !== "false";
	if (typeof value === "number") return value !== 0;
	if (typeof value === "boolean") return value === true;
	return false;
}

/**
 * Whether the memory cap applies to a process/execution path under the
 * given policy. `confirmedCompute` is true when the process's identity as a
 * compute task was CONFIRMED (compute marker at spawn, visible in its
 * environ). `all` restores the pre-0.3.1 blanket (operator override for
 * testing/rollback); `compute-only` caps only confirmed compute; `none`
 * caps nobody — unconfirmed processes are NEVER capped outside `all`.
 */
export function capAllowedForProcess(policy, confirmedCompute) {
	if (policy === "all") return true;
	if (policy === "compute-only") return confirmedCompute === true;
	return false;
}

/** Live shared state. Replaced wholesale on process restart and re-derived from disk. */
export const shared = {
	/** Merged runtime config (DEFAULTS + composition config). */
	config: { ...DEFAULTS },
	/**
	 * Machine-private host profile:
	 * `{ path, doc, profile, changedFrom?, migratedFromLegacy? }` where `doc`
	 * conforms to schemas/host-profile.schema.json (the durable fact source)
	 * and `profile` is the runtime projection derived from it.
	 */
	host: null,
	/** Latest sampled vitals: { memTotalBytes, memAvailableBytes, load1, load5, load15, at }. */
	vitals: null,
	/** v0.4.0: monitored disk paths (resolved at boot; live, not persisted). */
	diskPaths: [],
	/** v0.4.0: sampling templates for the monitored paths (path + thresholds), built at boot. */
	diskEntries: [],
	/** v0.5.0: scan plans keyed by plan id (in-memory; never persisted). */
	cleanupPlans: new Map(),
	/** v0.5.0: most recent cleanup scan plan for the ops surface. */
	cleanupLastPlan: null,
	/** Latest hysteresis-stabilized pressure classification: "ok" | "warn" | "critical". */
	pressureState: "ok",
	/** Epoch ms of the last pressure-state transition. */
	pressureChangedAt: 0,
	/** Epoch ms of the last auto-kill sweep (cooldown bookkeeping). */
	lastKillAt: 0,
	/** PIDs killed recently (auto-kill history, newest first). */
	killHistory: [],
	/** pid -> cpuTicks snapshot from the previous watchdog tick (CPU accounting). */
	cpuTicks: null,
	/** Epoch ms of the last CPU snapshot. */
	lastCpuSampleAt: 0,
	/** PIDs already retroactively capped by the watchdog (pid -> cap stamp ms). */
	cappedPids: new Map(),
	/**
	 * v0.3.1 memory observation: pid -> first-crossing stamp ms for
	 * processes whose VmSize/RSS approached the per-command cap (diagnostic
	 * only — observation NEVER caps on its own).
	 */
	memObservedPids: new Map(),
	/**
	 * v0.3.1 compute identity cache: pid -> boolean (DSH_HW_COMPUTE marker
	 * found in /proc/<pid>/environ). Refreshed per watchdog tick for new
	 * pids; cleared by resetRuntimeCaches().
	 */
	computeConfirmedPids: new Map(),
	/** Last context-injection timestamps per agent id. */
	lastInjectedAt: new Map(),
	/** Recent incidents, newest first, capped at incidentsMaxEntries. */
	incidents: [],
	/** Directory holding the persisted profile + incident log. */
	storageDir: null,
	/** Result of the v1.0 canonical/legacy storage resolution at boot. */
	storageMigration: null,
	/**
	 * Control switch (control.json projection): `{enabled, revision, reason,
	 * updatedBy, updatedAt, error}`. Null until the main plugin loads the
	 * file; `guardEnabled()` treats null (and any corrupt state) as ENABLED
	 * — the safe default.
	 */
	control: null,
	/**
	 * Adaptation engine state (adaptations.json projection):
	 * `{schemaVersion, applied, pending, cooldowns, watchlist}`.
	 */
	adaptations: {
		schemaVersion: 1,
		applied: [],
		pending: [],
		cooldowns: {},
		watchlist: []
	},
	/** adaptations.json load error, surfaced via incidents/status. */
	adaptationsError: null
};

/** Merge a (possibly partial) composition config over the defaults. */
export function mergeConfig(overrides) {
	const next = { ...DEFAULTS, ...(overrides ?? {}) };
	shared.config = next;
	return next;
}

/**
 * Whether enforcement is active for the given host profile projection.
 * False while the machine-private profile awaits user confirmation (dry-run):
 * caps, admission denials and the auto-kill sweep stay off; probing, alerts
 * and the hardware_guard tool keep working.
 */
export function enforcementActive(host) {
	const profile = host?.profile;
	if (profile === undefined || profile === null) return false;
	return profile.enforcementActive === true;
}

/**
 * The v0.3.0 master control switch (control.json), read by EVERY enforcement
 * path (shell prologue, sandbox wrapper, admission gate, watchdog, env
 * facts). Missing, unloaded or corrupt control state is ENABLED — the safe
 * default — and the corrupt case is surfaced as an error, never thrown.
 * Disabling only affects NEW shells and NEW processes: persistent shell
 * processes that already inherited ulimits at spawn keep them.
 */
export function guardEnabled() {
	return shared.control?.enabled !== false;
}

/**
 * Clear every piece of runtime enforcement memory. Called by the enable
 * action so a re-enabled guard starts from a clean slate and re-caps all
 * existing descendants instead of trusting stale cache entries.
 */
export function resetRuntimeCaches() {
	shared.cappedPids.clear();
	shared.computeConfirmedPids.clear();
	shared.killHistory = [];
	shared.cpuTicks = null;
	shared.lastCpuSampleAt = 0;
	shared.lastKillAt = 0;
	shared.lastInjectedAt.clear();
}
