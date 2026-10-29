/**
 * Hardware-guarded bash executor.
 *
 * A drop-in subclass of the sandbox bash executor that prepends the
 * resource-limit prologue to every command BEFORE the sandbox wraps it, so
 * `ulimit`/`taskset`/`renice` run inside the confined inner shell and every
 * child process inherits the limits. One `resolve()` override covers the
 * foreground, background and danger-full-access execution paths.
 *
 * Mounted by the bundle patch as a whole-row replacement of the profile's
 * `bash-sandbox` entry (same id, same sandbox semantics).
 *
 * v0.3.1: the `ulimit -v` line is OPT-IN per execution path. With
 * `memoryCapPolicy: "none"` (default) every shell gets process/affinity/
 * niceness limits only; with `"compute-only"` the memory line appears only
 * when the request's env carries the explicit `DSH_HW_COMPUTE` marker;
 * `"all"` restores the pre-0.3.1 blanket for testing.
 *
 * @module hardware-guard/shell
 */
import z from "@deepseek-ai/schemastery";
import { SandboxBashExecutor } from "@deepseek-ai/dsh-bash-sandbox";
import { probeFreshHost } from "./host-profile.js";
import { buildPrologue } from "./prologue.js";
import { capAllowedForProcess, computeMarked, DEFAULTS, guardEnabled, shared } from "./state.js";

export const name = "hardware-guard-shell";

/** Parent schema plus guard knobs; composition config is validated against this. */
export const Config = z.object({
	// `.volatile()` 是必须的：dsh 0.2.0-rc.2 起，父类 LocalBashExecutor
	// （dsh-bash-local/lib/index.js:90）以**访问器**形式读这些字段：
	//     this.config.timeoutMs.get()
	// 而本行用 static Config **整体覆盖**了父类 schema——若不标 .volatile()，
	// 这里就是纯数字，父类调 .get() 直接抛
	//     TypeError: config.timeoutMs.get is not a function
	// 后果是 shell 服务对**所有人**失效（agent 的 bash 工具、插件里的 ctx.shell）。
	// 对照：dsh-bash-local 的 Config 对这 6 个字段逐个标了 .volatile()。
	// 其余字段（enabled / perCommandMemCapBytes / …）是 hardware-guard 自己按纯值读的，
	// 不能标 .volatile()，否则 `config.enabled ?? X` 拿到的是访问器对象。
	cwd: z.string().volatile(),
	timeoutMs: z.number().default(12e4).volatile(),
	maxTimeoutMs: z.number().default(6e5).volatile(),
	maxOutputBytes: z.number().default(64e3).volatile(),
	maxSpillBytes: z.number().default(64 * 1024 * 1024).volatile(),
	graceMs: z.number().default(3e3).volatile(),
	enabled: z.boolean().default(DEFAULTS.executorEnabled),
	perCommandMemCapBytes: z.number(),
	cpuCapCores: z.number(),
	maxProcesses: z.number().default(DEFAULTS.maxProcesses),
	niceLevel: z.number().default(DEFAULTS.niceLevel),
	memoryCapPolicy: z.union([z.const("none"), z.const("compute-only"), z.const("all")]).default(DEFAULTS.memoryCapPolicy)
});

export class GuardBashExecutor extends SandboxBashExecutor {
	static inject = ["subprocess", "sandbox", "sandboxPolicy"];
	static Config = Config;

	constructor(ctx, config = {}) {
		super(ctx, config);
		// Keep the executor's own knobs locally: the main plugin row re-merges
		// the shared config at apply time and must not wipe these.
		this.ownConfig = {
			enabled: config.enabled ?? DEFAULTS.executorEnabled,
			perCommandMemCapBytes: config.perCommandMemCapBytes,
			maxProcesses: config.maxProcesses,
			niceLevel: config.niceLevel,
			memoryCapPolicy: config.memoryCapPolicy ?? DEFAULTS.memoryCapPolicy
		};
		Object.assign(shared.config, {
			executorEnabled: this.ownConfig.enabled,
			memoryCapPolicy: this.ownConfig.memoryCapPolicy,
			...this.ownConfig.perCommandMemCapBytes !== undefined ? { perCommandMemCapBytes: this.ownConfig.perCommandMemCapBytes } : {},
			...this.ownConfig.maxProcesses !== undefined ? { maxProcesses: this.ownConfig.maxProcesses } : {},
			...this.ownConfig.niceLevel !== undefined ? { niceLevel: this.ownConfig.niceLevel } : {}
		});
	}

	/**
	 * The derived caps for this process: the executor row's own config wins,
	 * the profile derives the rest. When the main plugin row is absent
	 * (standalone mount), probe lazily and cache so the executor still
	 * enforces limits. Enforcement also stays off while the machine-private
	 * profile awaits user confirmation (dry-run) or while the v0.3.0 control
	 * switch is disabled (full pass-through).
	 */
	get caps() {
		if (shared.host === null || shared.host === undefined) {
			try {
				shared.host = probeFreshHost(shared.config);
			} catch {
				return null;
			}
		}
		const host = shared.host;
		const own = this.ownConfig;
		const profile = host.profile;
		if (profile === undefined || profile === null) return null;
		return {
			...profile,
			executorEnabled: own.enabled && profile.enforcementActive !== false && guardEnabled(),
			perCommandMemCapBytes: own.perCommandMemCapBytes ?? profile.perCommandMemCapBytes,
			maxProcesses: own.maxProcesses ?? profile.maxProcesses,
			niceLevel: own.niceLevel ?? profile.niceLevel,
			memoryCapPolicy: own.memoryCapPolicy ?? DEFAULTS.memoryCapPolicy
		};
	}

	/**
	 * Prepend the prologue before the parent resolves the spec. Fails open:
	 * any surprise leaves the original command untouched.
	 *
	 * v0.3.1: the `ulimit -v` line is included only when the memory cap
	 * policy allows it for THIS execution path — `"all"`, or
	 * `"compute-only"` with the request's env carrying DSH_HW_COMPUTE.
	 */
	resolve(request) {
		if (typeof request !== "object" || request === null || typeof request.command !== "string") return super.resolve(request);
		try {
			const caps = this.caps;
			if (caps === null) return super.resolve(request);
			const memCap = capAllowedForProcess(caps.memoryCapPolicy, computeMarked(request.env));
			const prologue = buildPrologue(caps, { memCap });
			if (prologue.length === 0) return super.resolve(request);
			return super.resolve({ ...request, command: prologue + request.command });
		} catch {
			return super.resolve(request);
		}
	}
}

export default GuardBashExecutor;
