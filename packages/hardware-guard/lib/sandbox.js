/**
 * Hardware-guarded sandbox provider.
 *
 * A drop-in subclass of the local sandbox provider that wraps every confined
 * argv with trusted DSH_HW_* facts + `prlimit` + `nice` BEFORE the
 * Landlock/bwrap/Seatbelt runner wraps it. This reaches execution paths that
 * bypass the guarded bash executor and ctx.shellEnv, most importantly the web
 * profile's persistent terminal bash (`dsh-tool-bash-persistent` /
 * `dsh-terminal-bash`).
 *
 * v0.3.1 — selective memory caps (the 2026-08-17 incident fix): the default
 * wrapper keeps DSH_HW_* facts, nice and `--nproc` but NO LONGER appends
 * `prlimit --as` to every confined argv. The blanket 1.5 GiB address-space
 * cap was the direct killer (Node/V8 fatal trap → SIGILL, Python/bash
 * SIGSEGV on allocation). `--as` is now opt-in per execution path through
 * `memoryCapPolicy`:
 *   - "none" (default):  never add `--as`;
 *   - "compute-only":   add `--as` only for paths explicitly marked compute
 *                       (`wrapArgv(argv, { computeMarked: true })` — the
 *                       spawn-time marker env cannot be seen from
 *                       `confine()`, so this provider never self-marks);
 *   - "all":            the pre-0.3.1 blanket (testing/rollback only).
 *
 * Mount as a whole-row replacement of the profile's `sandbox` entry.
 *
 * @module hardware-guard/sandbox
 */
import { LocalSandboxProvider } from "@deepseek-ai/dsh-sandbox-local";
import { disksPressure, mostDangerousDisk } from "./disk.js";
import { probeFreshHost } from "./host-profile.js";
import { createPressureMonitor } from "./pressure.js";
import { capAllowedForProcess, guardEnabled, shared } from "./state.js";

export const name = "hardware-guard-sandbox";

const pressureMonitor = createPressureMonitor({ cacheTtlMs: 1000 });

export class GuardSandboxProvider extends LocalSandboxProvider {
static Config = LocalSandboxProvider.Config;

/**
 * Guard caps, lazily derived from the persisted host profile. Enforcement
 * stays off while the machine-private profile awaits user confirmation
 * (dry-run) or while the v0.3.0 control switch is disabled (the wrapper
 * passes the argv through untouched).
 */
get guardCaps() {
if (shared.host === null || shared.host === undefined) {
try {
shared.host = probeFreshHost(shared.config);
} catch {
return null;
}
}
const profile = shared.host?.profile;
if (profile === undefined || profile === null) return null;
return {
enabled: shared.config.executorEnabled && profile.enforcementActive !== false && guardEnabled(),
perCommandMemCapBytes: profile.perCommandMemCapBytes,
maxProcesses: profile.maxProcesses,
niceLevel: profile.niceLevel,
memoryCapPolicy: shared.config.memoryCapPolicy ?? "none"
};
}

/** Trusted DSH_HW_* facts for execution paths that bypass ctx.shellEnv. */
guardEnv() {
const host = shared.host;
if (host === null || host === undefined || host.doc === undefined) return [];
const pressure = pressureMonitor.tick(host);
const doc = host.doc;
const h = doc.host ?? {};
const profile = host.profile ?? {};
const disks = Array.isArray(pressure.vitals.disks) ? pressure.vitals.disks : [];
const worstDisk = mostDangerousDisk(disks);
const values = {
DSH_HW_PLATFORM: `${h.platform ?? "unknown"}/${h.arch ?? "unknown"}${h.isWsl ? "/wsl2" : ""}`,
DSH_HW_CPU_MAX: String(profile.cpuCount ?? 0),
DSH_HW_MEM_BUDGET_BYTES: String(profile.memBudgetBytes ?? 0),
DSH_HW_MEM_CAP_BYTES: String(profile.perCommandMemCapBytes ?? 0),
DSH_HW_MAX_BG_JOBS: String(profile.maxBackgroundJobs ?? 0),
DSH_HW_PRESSURE: pressure.state,
DSH_HW_AVAIL_MEM_BYTES: String(pressure.vitals.memAvailableBytes ?? 0),
DSH_HW_PROFILE_PATH: host.path ?? "",
DSH_HW_ENFORCEMENT: guardEnabled() ? (profile.enforcementActive === false ? "dry-run" : "active") : "disabled",
DSH_HW_DISK_PATHS: (shared.diskPaths ?? []).join(","),
DSH_HW_DISK_AVAIL_BYTES: worstDisk !== null && worstDisk.availBytes !== null ? String(worstDisk.availBytes) : "",
DSH_HW_DISK_PRESSURE: disksPressure(disks),
DSH_HW_DISK_CRIT_PATH: worstDisk !== null ? worstDisk.path : ""
};
return Object.entries(values).sort(([left], [right]) => left.localeCompare(right));
}

/**
 * Best-effort resource wrapper for one confined argv.
 *
 * v0.3.1: `--as` is OPT-IN. The wrapper always keeps DSH_HW_* facts,
 * `--nproc` and `nice`; the address-space cap is added only when
 * `capAllowedForProcess(caps.memoryCapPolicy, opts.computeMarked)` is true.
 *
 * @param {string[]} argv - the exact argv to wrap
 * @param {object} [opts] - `{ computeMarked?: boolean }`; the sandbox
 *   provider cannot see spawn-time env vars, so only trusted in-process
 *   callers can mark a path as compute.
 */
wrapArgv(argv, opts = {}) {
if (process.platform !== "linux" || !Array.isArray(argv) || argv.length === 0) return argv;
if (argv[0] === "prlimit" || argv[0]?.endsWith("/prlimit")) return argv;
const caps = this.guardCaps;
if (caps === null || caps?.enabled === false) return argv;
const envArgs = this.guardEnv().flatMap(([key, value]) => [`${key}=${value}`]);
const memCap = capAllowedForProcess(caps.memoryCapPolicy, opts?.computeMarked === true);
return [
...envArgs.length > 0 ? ["/usr/bin/env", ...envArgs] : [],
"prlimit",
...(memCap ? [`--as=${caps.perCommandMemCapBytes}`] : []),
`--nproc=${caps.maxProcesses}`,
"--",
"nice",
"-n",
String(caps.niceLevel),
"--",
...argv
];
}

/**
 * Wrap the argv, then delegate. v0.2.0-rc.2 compatibility: the parent
 * `confine()` gained a third `signal` parameter (and became async) — forward
 * it so cancellation of confinement preparation still reaches the provider.
 * Passing an extra argument is harmless on the 0.1.x line.
 */
confine(argv, policy, signal) {
return super.confine(this.wrapArgv(argv), policy, signal);
}
}

export default GuardSandboxProvider;
