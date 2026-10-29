/**
 * Bash resource-limit prologue builder.
 *
 * The prologue is prepended to the model's command inside the same
 * `bash -c` invocation (the shell executor injects it via its `resolve()`
 * override, so it travels into both the local and sandboxed execution paths
 * and every child process inherits the limits). It is a fixed template that
 * never interpolates user input, so it cannot be escaped, and every line is
 * independently guarded so a missing tool degrades silently instead of
 * breaking the command.
 *
 * v0.3.1: the address-space cap (`ulimit -v`) is OPT-IN. The v0.3.0 blanket
 * 1.5 GiB cap is what sent Node/V8 down the fatal path (ud2 → SIGILL) and
 * made Python/bash die with SIGSEGV on allocation failures (the 2026-08-17
 * incident). By default the prologue enforces ONLY processes, affinity and
 * niceness; callers opt the memory line in per execution path via
 * `buildPrologue(profile, { memCap: true })`, which the executor derives
 * from `memoryCapPolicy` + the DSH_HW_COMPUTE marker.
 *
 * @module hardware-guard/prologue
 */

/**
 * Build the prologue, or "" when disabled or nothing to enforce.
 * @param {object} profile - derived profile (see `deriveProfile`)
 * @param {object} [opts] - `{ memCap?: boolean }`: include `ulimit -v` only
 *   when explicitly true (v0.3.1 default: no address-space cap).
 * @returns {string} multi-line bash prologue
 */
export function buildPrologue(profile, opts = {}) {
	if (profile === null || profile === undefined || profile.executorEnabled === false) return "";
	const lines = [
		"# [hardware-guard] resource limits applied by hardware-guard",
		...(opts?.memCap === true
			? [`ulimit -v ${Math.floor(profile.perCommandMemCapBytes / 1024)} 2>/dev/null || true`]
			: []),
		`ulimit -u ${Math.max(1, Math.floor(profile.maxProcesses))} 2>/dev/null || true`,
		`command -v taskset >/dev/null 2>&1 && taskset -pc ${profile.cpuMask} $$ >/dev/null 2>&1 || true`,
		`command -v renice >/dev/null 2>&1 && renice -n ${Math.floor(profile.niceLevel)} $$ >/dev/null 2>&1 || true`
	];
	return `${lines.join("\n")}\n`;
}

/** The KiB value `ulimit -v` is asked to enforce (exposed for tests and diagnostics). */
export function ulimitKib(profile) {
	return Math.floor(profile.perCommandMemCapBytes / 1024);
}
