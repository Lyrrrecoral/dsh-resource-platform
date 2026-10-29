/**
 * hardware-guard main plugin: host-hardware detection, resource guardrails and
 * lifecycle adaptation.
 *
 * Mounted on the host plane as a bundle row. Owns:
 *  - the machine-private persisted host profile (probe → derive budgets →
 *    durable JSON conforming to schemas/host-profile.schema.json),
 *  - the v0.3.0 control switch (control.json: one-shot disable/enable that
 *    every enforcement path reads),
 *  - the v0.3.0 incident-driven bounded adaptation engine (adaptations.json),
 *  - the policy section, per-command DSH_HW_* environment facts,
 *  - the `tools/pre-execute` admission gate,
 *  - per-session context injection (v0.3.0 quiet mode: ALL channels default
 *    off; each channel is an explicit opt-in via `config.injection`),
 *  - the watchdog interval (hysteresis-stabilized pressure, v0.3.1 memory
 *    observation with graded caps, optional auto-kill sweep), the durable
 *    incident log and the v0.3.1 process-lifecycle heartbeat/clean marker,
 *  - the model-facing `hardware_guard` tool (report/profile/incidents/confirm/
 *    enable/disable/pending-adaptations/confirm-adapt).
 *
 * v1.0 boundary (ops-generalization README §6): probe / budget / hard caps /
 * admission / true-runaway kill only. No business task types — math and
 * systemd specifics live in project manifests (dsh-ops), never here.
 *
 * @module hardware-guard
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import z from "@deepseek-ai/schemastery";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import { loadAdaptations, proposeUncleanBootPending, runAdaptationCycle } from "./adaptation.js";
import { CONTROL_DEFAULT_STATE, controlPath, loadControl } from "./control.js";
import { cleanupTrashRetention } from "./cleanup-actions.js";
import { createDiskSampler, DISK_ENV, buildDiskEntries, disksPressure, mostDangerousDisk, resolveDiskPaths } from "./disk.js";
import { loadIncidents, recordIncident } from "./incidents.js";
import { refreshHostProfile, summarizeProfile } from "./host-profile.js";
import { checkUncleanBoot, markLifecycleClean, markLifecycleDirty } from "./lifecycle.js";
import { createPressureMonitor } from "./pressure.js";
import { listDescendants, readProcessTable } from "./proc-tree.js";
import { DEFAULTS, guardEnabled, mergeConfig, shared } from "./state.js";
import { CANONICAL_STORAGE_NAME, LEGACY_STORAGE_NAME, migrateLegacyStorage } from "./storage.js";
import { defineHardwareGuardTool, renderReport } from "./tool.js";
import { watchdogTick } from "./watchdog.js";

export const name = "hardware-guard";
export const inject = ["tools", "agents", "systemPrompt", "shellEnv", "timer", "jobs"];

/** Composition config schema; every knob is optional and derives from the host profile. */
export const Config = z.object({
	enabled: z.boolean().default(true),
	memSafetyFrac: z.number(),
	cpuReservedCores: z.number(),
	perCommandMemCapBytes: z.number(),
	memoryRunawayBytes: z.number(),
	niceLevel: z.number(),
	maxProcesses: z.number(),
	warnMemFrac: z.number(),
	critMemFrac: z.number(),
	warnLoadFactor: z.number(),
	critLoadFactor: z.number(),
	warnExitLoadFactor: z.number(),
	critExitLoadFactor: z.number(),
	warnExitMemFrac: z.number(),
	critExitMemFrac: z.number(),
	minStateMs: z.number(),
	samplingIntervalMs: z.number(),
	maxBackgroundJobs: z.number(),
	watchdogIntervalMs: z.number(),
	killGraceMs: z.number(),
	autoKillOnCritical: z.boolean(),
	killCooldownMs: z.number(),
	excludeComm: z.array(z.string()),
	allowOnCritical: z.array(z.string()),
	prlimitTimeoutMs: z.number(),
	contextRefreshMs: z.number(),
	profileResampleMs: z.number(),
	incidentsMaxEntries: z.number(),
	incidentsMaxBytes: z.number(),
	executorEnabled: z.boolean(),
	memoryCapPolicy: z.union([z.const("none"), z.const("compute-only"), z.const("all")]).default(DEFAULTS.memoryCapPolicy),
	adaptationEnabled: z.boolean().default(true),
	injection: z.object({
		turnOneProfile: z.boolean().default(false),
		periodicReport: z.boolean().default(false),
		transitionReports: z.boolean().default(false),
		criticalNotice: z.boolean().default(false)
	}).default({
		turnOneProfile: false,
		periodicReport: false,
		transitionReports: false,
		criticalNotice: false
	}),
	// v0.4.0 disk axis config (thresholds + explicit path list; empty paths =
	// auto-resolve $DSH_HOME / cwd / WSL /mnt/c at boot).
	disk: z.object({
		enabled: z.boolean().default(true),
		paths: z.array(z.string()).default([]),
		warnAvailBytes: z.number().default(DEFAULTS.disk.warnAvailBytes),
		critAvailBytes: z.number().default(DEFAULTS.disk.critAvailBytes),
		warnUsePct: z.number().default(DEFAULTS.disk.warnUsePct),
		critUsePct: z.number().default(DEFAULTS.disk.critUsePct),
		sampleTtlMs: z.number().default(DEFAULTS.disk.sampleTtlMs)
	}).default({
		enabled: true,
		paths: [],
		warnAvailBytes: DEFAULTS.disk.warnAvailBytes,
		critAvailBytes: DEFAULTS.disk.critAvailBytes,
		warnUsePct: DEFAULTS.disk.warnUsePct,
		critUsePct: DEFAULTS.disk.critUsePct,
		sampleTtlMs: DEFAULTS.disk.sampleTtlMs
	}),
	// v0.5.0 project output-file probe (scan/list only; deletion requires an
	// explicit user confirmation through the ops surface).
	cleanupProbe: z.object({
		enabled: z.boolean().default(false),
		roots: z.array(z.string()).default([]),
		maxDepth: z.number().default(DEFAULTS.cleanupProbe.maxDepth),
		maxFiles: z.number().default(DEFAULTS.cleanupProbe.maxFiles),
		minSizeBytes: z.number().default(DEFAULTS.cleanupProbe.minSizeBytes),
		minAgeMs: z.number().default(DEFAULTS.cleanupProbe.minAgeMs),
		topN: z.number().default(DEFAULTS.cleanupProbe.topN),
		excludeDirs: z.array(z.string()).default([...DEFAULTS.cleanupProbe.excludeDirs]),
		softDelete: z.boolean().default(true),
		trashRetentionDays: z.number().default(DEFAULTS.cleanupProbe.trashRetentionDays)
	}).default({
		enabled: false,
		roots: [],
		maxDepth: DEFAULTS.cleanupProbe.maxDepth,
		maxFiles: DEFAULTS.cleanupProbe.maxFiles,
		minSizeBytes: DEFAULTS.cleanupProbe.minSizeBytes,
		minAgeMs: DEFAULTS.cleanupProbe.minAgeMs,
		topN: DEFAULTS.cleanupProbe.topN,
		excludeDirs: [...DEFAULTS.cleanupProbe.excludeDirs],
		softDelete: true,
		trashRetentionDays: DEFAULTS.cleanupProbe.trashRetentionDays
	})
});

/** One durable plugin-sourced user message (mirrors the time-context shape). */
function pluginMessage(text) {
	return {
		id: randomUUID(),
		role: "user",
		content: [{ type: "text", text }],
		source: {
			kind: "plugin",
			plugin: name,
			form: "snapshot",
			sections: [{ name, text }]
		}
	};
}

/**
 * Static standing policy injected into every session's system prompt.
 * Kept by quiet mode: this is a system-prompt section, not an agent
 * injection, and it never wakes anyone.
 */
function policyText(profile, control) {
	const memoryCapLine = shared.config.memoryCapPolicy === "all"
		? `per-command address-space cap ${Math.floor(profile.perCommandMemCapBytes / 1048576)} MiB`
		: shared.config.memoryCapPolicy === "compute-only"
			? `per-command address-space cap ${Math.floor(profile.perCommandMemCapBytes / 1048576)} MiB for explicitly marked compute work only`
			: "no per-command address-space cap (memoryCapPolicy none)";
	const lines = [
		"[hardware-guard] This host runs hardware-guard: hardware detection + resource guardrails. The harness survives only if work stays inside the host budget.",
		`- Hardware budget (derived at boot, persisted): ${profile.cpuCount} cores, ${memoryCapLine}, max ${profile.maxBackgroundJobs} concurrent background jobs, nice level ${profile.niceLevel}.`,
		"- Every shell command already runs inside per-process process/cpu-affinity limits — do not try to strip them; size workloads to fit instead.",
		"- Before launching heavy compute (SAT solvers, builds, training, parallel fleets): read the DSH_HW_* variables, start with ONE small batch, checkpoint results durably, then scale up — never launch a full parallel fleet at once.",
		"- When a command is denied by the guard: shed load first (job_kill running jobs, hardware_guard for status) — do not blindly retry or work around the limit.",
		"- Write important files durably: write to a temp file, fsync, rename into place, then verify the file content/size after writing; hard power-offs lose unflushed writes (see hardware_guard incidents).",
		"- hardware_guard reports live pressure and past incidents; consult it before long-running work.",
		`- Disk availability is a monitored pressure axis: ${profile.disk?.enabled === false ? "disabled by config" : `warn below ${Math.floor((profile.disk?.warnAvailBytes ?? 0) / 1073741824)} GiB available or >=${Math.round((profile.disk?.warnUsePct ?? 0) * 100)}% used; critical below ${Math.floor((profile.disk?.critAvailBytes ?? 0) / 1073741824)} GiB available or >=${Math.round((profile.disk?.critUsePct ?? 0) * 100)}% used (see DSH_HW_DISK_*)`}. Write logs/checkpoints inside the monitored filesystems and clean up outputs when they approach the warn level.`
	];
	if (control?.enabled === false) {
		lines.push("- hardware-guard is DISABLED by the control switch (control.json): caps, admission and kill enforcement are OFF for new shells and new processes. Existing persistent shell processes keep the limits they inherited at spawn. Re-enable via the hardware_guard tool (action enable).");
	} else if (profile.enforcementActive === false) {
		lines.push("- hardware-guard is in DRY-RUN: the machine-private host profile awaits user confirmation. Enforcement (caps, admission, kill) stays off until confirmed via the hardware_guard tool (action confirm).");
	}
	if ((shared.adaptations?.pending?.length ?? 0) > 0) {
		lines.push(`- hardware-guard has ${shared.adaptations.pending.length} pending adaptation(s) awaiting human confirmation (hardware_guard pending-adaptations / confirm-adapt).`);
	}
	return lines.join("\n");
}

/** Shell environment facts available to every bash/pwsh execution. */
const SHELL_ENV_VARIABLES = Object.freeze({
	DSH_HW_PLATFORM: { description: "Host platform and WSL detection for hardware-guard" },
	DSH_HW_CPU_MAX: { description: "CPU core count for parallelism decisions" },
	DSH_HW_MEM_BUDGET_BYTES: { description: "Total memory budget the harness may occupy (bytes)" },
	DSH_HW_MEM_CAP_BYTES: { description: "Per-command address-space cap in bytes (already enforced)" },
	DSH_HW_MAX_BG_JOBS: { description: "Maximum concurrent background jobs" },
	DSH_HW_PRESSURE: { description: "Live pressure state: ok | warn | critical" },
	DSH_HW_AVAIL_MEM_BYTES: { description: "Live available memory in bytes" },
	DSH_HW_PROFILE_PATH: { description: "Persisted host profile JSON path" },
	DSH_HW_ENFORCEMENT: { description: "Enforcement state: active | dry-run (confirmation pending) | disabled (control switch)" },
	...Object.fromEntries(Object.entries(DISK_ENV).map(([key, description]) => [key, { description }]))
});

export function apply(ctx, config = {}) {
	mergeConfig(config);
	if (shared.config.enabled === false) return;

	// v1.0 canonical storage. When the canonical directory does not exist yet,
	// copy every legacy fact (profile/control/adaptations/incidents/state/trash)
	// from `$DSH_HOME/storages/hw-guard`; never delete or write the legacy
	// directory. Canonical always wins when both exist.
	const storageMigration = migrateLegacyStorage({
		canonicalDir: dshHomePath("storages", CANONICAL_STORAGE_NAME),
		legacyDir: dshHomePath("storages", LEGACY_STORAGE_NAME)
	});
	// On a failed migration keep storageDir null so no boot write creates an
	// empty canonical directory and masks the retry on the next process start.
	shared.storageDir = storageMigration.error === null ? storageMigration.dir : null;
	shared.storageMigration = storageMigration;
	refreshHostProfile({ dir: shared.storageDir, config: shared.config });
	loadIncidents();
	if (storageMigration.error !== null) {
		recordIncident("storage-migration-error", {
			from: storageMigration.legacyDir,
			to: storageMigration.canonicalDir,
			error: storageMigration.error
		});
	} else if (storageMigration.migrated) {
		recordIncident("storage-migrated", {
			from: storageMigration.legacyDir,
			to: storageMigration.canonicalDir,
			copiedFiles: storageMigration.copiedFiles,
			copiedBytes: storageMigration.copiedBytes,
			warnings: storageMigration.warnings
		});
	}

	// v1.0 bounded trash retention: old soft-delete plan directories are
	// removed at boot (and on cleanup scans). Only direct, non-symlink
	// directories under the canonical trash root are eligible, and each sweep
	// examines a hard-capped number of entries. Errors never fail boot.
	try {
		cleanupTrashRetention();
	} catch (error) {
		recordIncident("trash-retention-error", { error: String(error?.message ?? error) });
	}

	// ── v0.3.0 control switch (control.json) ───────────────────────────────
	// Missing → enabled (safe default); corrupt → stays enabled and the error
	// is recorded as an incident + surfaced by the hardware_guard tool. Never throws.
	shared.control = shared.storageDir === null
		? { ...CONTROL_DEFAULT_STATE }
		: loadControl(controlPath(shared.storageDir));
	if (shared.control.error !== null) {
		recordIncident("control-corrupt", { error: shared.control.error });
	}

	// ── v0.3.0 adaptation engine state (adaptations.json) ──────────────────
	const adaptationsPath = shared.storageDir === null ? null : join(shared.storageDir, shared.config.adaptationsFileName);
	const adaptations = loadAdaptations(adaptationsPath);
	shared.adaptations = adaptations.doc;
	shared.adaptationsError = adaptations.error;
	if (adaptations.error !== null) {
		recordIncident("adaptations-corrupt", { error: adaptations.error });
	}

	// ── v0.3.1 process-lifecycle memory (state.json) ────────────────────────
	// Runs BEFORE the boot record: if the previous run left no clean marker
	// and the incident history shows critical pressure / auto-kills, the host
	// probably went down the hard way → host-unclean-boot incident + one
	// pending, human-gated reserve adaptation. Then this run stamps the dirty
	// marker so a crash from here on is detected by the next boot.
	const unclean = checkUncleanBoot({ dir: shared.storageDir, incidents: shared.incidents });
	if (unclean.unclean) {
		recordIncident("host-unclean-boot", { reason: unclean.reason });
		proposeUncleanBootPending();
	}
	markLifecycleDirty(shared.storageDir);

	// ── v0.4.0 disk axis: resolve monitored paths + the TTL-cached statfs
	// sampler. Path resolution is pure reads (statSync existence probes);
	// /mnt/c and any missing path are skipped — never failing plugin boot.
	// The resolved list lives in shared.diskPaths (live state, not persisted)
	// and is stamped into the boot record below. shared.diskEntries carries
	// the per-path sampling templates (path + thresholds) the sampler reads.
	const diskConfig = shared.config.disk ?? DEFAULTS.disk;
	shared.diskPaths = resolveDiskPaths(diskConfig, { isWsl: shared.host.doc.host.isWsl === true });
	shared.diskEntries = buildDiskEntries(shared.diskPaths, diskConfig);
	shared.diskSampler = createDiskSampler({ ttlMs: diskConfig.sampleTtlMs });

	recordIncident("boot", {
		profilePath: shared.host.path ?? null,
		summary: summarizeProfile(shared.host),
		control: shared.control.enabled === false ? "disabled" : "enabled",
		controlRevision: shared.control.revision,
		diskPaths: [...shared.diskPaths]
	});
	if (shared.host.migratedFromLegacy === true) {
		recordIncident("profile-migrated", {
			from: "pre-schema {hw, profile}",
			confirmationRequired: shared.host.profile.confirmationRequired
		});
	}
	if (shared.host.profile.enforcementActive === false) {
		recordIncident("profile-dry-run", {
			message: "machine-private profile awaiting user confirmation; enforcement inactive"
		});
	}

	const pressure = createPressureMonitor({ cacheTtlMs: shared.config.samplingIntervalMs });

	// v0.4.0: prime the FIRST sample at boot so disk facts (+ vitals) are
	// visible in /resources/hardware.json and the first gate/env call immediately,
	// with no empty-disks window before the first watchdog tick. The
	// pressure-state bookkeeping is left at the fresh "ok" baseline — the
	// first watchdog tick still decides and records transitions as before.
	try {
		pressure.tick(shared.host);
		shared.pressureState = "ok";
		shared.pressureChangedAt = 0;
	} catch {
		/* boot sampling is best-effort; the watchdog tick retries */
	}

	// One bounded adaptation cycle at boot: the critical-restart-reserve rule
	// reads the fresh boot record, and the loaded history may carry evidence
	// for the other rules. Never throws into the boot path.
	try {
		runAdaptationCycle();
	} catch (error) {
		recordIncident("adaptation-error", { error: String(error?.message ?? error) });
	}

	// ── standing policy ─────────────────────────────────────────────────────
	ctx.systemPrompt.section({
		name,
		order: 104,
		text: policyText(shared.host.profile, shared.control)
	});

	// ── per-command environment facts ───────────────────────────────────────
	// Kept available even while the control switch is disabled: the vars are
	// read-only facts, and DSH_HW_ENFORCEMENT reports the switch state.
	ctx.shellEnv.register({
		name,
		variables: SHELL_ENV_VARIABLES,
		resolve: () => {
			const host = shared.host;
			if (host === null || host.doc === undefined) return {};
			const tick = pressure.tick(host);
			const disks = Array.isArray(tick.vitals.disks) ? tick.vitals.disks : [];
			const diskPressure = disksPressure(disks);
			const worstDisk = mostDangerousDisk(disks);
			return {
				DSH_HW_PLATFORM: `${host.doc.host.platform}/${host.doc.host.arch}${host.doc.host.isWsl ? "/wsl2" : ""}`,
				DSH_HW_CPU_MAX: String(host.profile.cpuCount),
				DSH_HW_MEM_BUDGET_BYTES: String(host.profile.memBudgetBytes),
				DSH_HW_MEM_CAP_BYTES: String(host.profile.perCommandMemCapBytes),
				DSH_HW_MAX_BG_JOBS: String(host.profile.maxBackgroundJobs),
				DSH_HW_PRESSURE: tick.state,
				DSH_HW_AVAIL_MEM_BYTES: String(tick.vitals.memAvailableBytes ?? 0),
				DSH_HW_PROFILE_PATH: host.path ?? "",
				DSH_HW_ENFORCEMENT: guardEnabled()
					? (host.profile.enforcementActive === false ? "dry-run" : "active")
					: "disabled",
				DSH_HW_DISK_PATHS: (shared.diskPaths ?? []).join(","),
				DSH_HW_DISK_AVAIL_BYTES: worstDisk !== null && worstDisk.availBytes !== null ? String(worstDisk.availBytes) : "",
				DSH_HW_DISK_PRESSURE: diskPressure,
				DSH_HW_DISK_CRIT_PATH: worstDisk !== null ? worstDisk.path : ""
			};
		}
	});

	// ── admission gate ──────────────────────────────────────────────────────
	const gated = new Set(shared.config.gatedTools ?? DEFAULTS.gatedTools);
	const allowOnCritical = shared.config.allowOnCritical ?? DEFAULTS.allowOnCritical;

	const activeBackgroundCount = (exec) => {
		const jobs = ctx.get("jobs");
		if (jobs !== undefined && exec.agent !== undefined) {
			try {
				return jobs.activeTaskCount(exec.agent);
			} catch {
				/* fall through to process-tree accounting */
			}
		}
		const exclude = new Set(shared.config.excludeComm ?? []);
		return listDescendants(readProcessTable(), process.pid).filter((entry) => !exclude.has(entry.comm) && entry.state === "R").length;
	};

	ctx.on("tools/pre-execute", async (exec, next) => {
		const decision = await next();
		if (decision.kind !== "allow") return decision;
		if (!gated.has(exec.name)) return decision;
		// v0.3.0 control switch off → the gate passes everything through.
		if (!guardEnabled()) return decision;
		// Dry-run (profile awaiting user confirmation): display only, no denials.
		if (shared.host === null || shared.host.profile.enforcementActive === false) return decision;
		const args = exec.arguments ?? {};
		const command = typeof args.command === "string" ? args.command : "";
		const tick = pressure.tick(shared.host);
		if (tick.state === "critical") {
			const permitted = allowOnCritical.some((prefix) => command.startsWith(prefix));
			if (!permitted) {
				return {
					kind: "deny",
					reason: `hardware-guard: host is under CRITICAL pressure (${tick.reasons.join("; ")}). New shell work is denied to protect the host from thrash/freeze. Recover by stopping background jobs (job_kill), checking hardware_guard, and retrying once pressure clears. Introspection commands (ps/free/uptime/hardware_guard) remain allowed.`
				};
			}
		}
		if (args.run_in_background === true) {
			if (tick.state === "warn") {
				return {
					kind: "deny",
					reason: `hardware-guard: host is under WARN pressure (${tick.reasons.join("; ")}). Starting new background work is denied; finish or stop existing jobs first (job_kill), then retry.`
				};
			}
			const count = activeBackgroundCount(exec);
			if (count >= shared.host.profile.maxBackgroundJobs) {
				return {
					kind: "deny",
					reason: `hardware-guard: background job cap reached (${count}/${shared.host.profile.maxBackgroundJobs}). The host derives this cap from its ${shared.host.profile.cpuCount} cores — stop an unneeded job (job_kill) before starting another.`
				};
			}
		}
		return decision;
	});

	// ── per-session context injection (v0.3.0 quiet mode) ───────────────────
	// Every injection channel is opt-in via config.injection and defaults OFF:
	// the guard never injects into or wakes an agent unless an operator asks
	// for a specific channel. Protection rides the gate + watchdog, not model
	// goodwill.
	ctx.on("agent/pre-step", async ({ agent, turn, step, signal }, next) => {
		const decision = await next();
		if (decision.kind === "reject" || signal.aborted) return decision;
		const injection = shared.config.injection ?? DEFAULTS.injection;
		if (injection.turnOneProfile !== true && injection.periodicReport !== true) return decision;
		const now = Date.now();
		const last = shared.lastInjectedAt.get(agent.id) ?? 0;
		let text = null;
		if (turn === 1 && step === 1 && injection.turnOneProfile === true) {
			const lines = [
				"[hardware-guard] Host hardware profile (persisted; re-probed when hardware changes):",
				summarizeProfile(shared.host)
			];
			if (shared.host.profile.enforcementActive === false) {
				lines.push("Enforcement is pending user confirmation: call the hardware_guard tool with action confirm to activate caps, admission and kill enforcement.");
			} else {
				lines.push("Budget rules: keep parallelism <= max background jobs; each command already runs under a per-process memory cap; heavy work must checkpoint durably. Call hardware_guard for live status. Past incidents:");
				lines.push(shared.incidents.length > 0 ? shared.incidents.slice(0, 3).map((i) => `  - ${i.at} [${i.kind}]`).join("\n") : "  - none");
			}
			text = lines.join("\n");
		} else if (injection.periodicReport === true && now - last >= shared.config.contextRefreshMs) {
			text = renderReport();
		}
		if (text === null) return decision;
		shared.lastInjectedAt.set(agent.id, now);
		return {
			kind: "enter",
			messages: [...decision.messages, pluginMessage(text)]
		};
	}, { prepend: true });

	// ── v0.3.1 lifecycle: clean-exit marker + heartbeat ──────────────────────
	// Normal SIGTERM/SIGINT shutdown and plugin-fiber dispose write the clean
	// marker; the watchdog heartbeat keeps the dirty marker fresh while we
	// run. Both are best-effort durable writes that never break shutdown.
	const markClean = () => {
		try {
			markLifecycleClean(shared.storageDir);
		} catch {
			/* best effort */
		}
	};
	ctx.on("dispose", markClean);
	ctx.effect(() => {
		const onSignal = () => markClean();
		process.on("SIGTERM", onSignal);
		process.on("SIGINT", onSignal);
		return () => {
			process.off("SIGTERM", onSignal);
			process.off("SIGINT", onSignal);
		};
	});

	// ── watchdog + adaptation cycle ─────────────────────────────────────────
	// Pressure transitions write ONLY to incidents.jsonl unless the operator
	// opted a notification channel back in (config.injection). CRITICAL never
	// wakes an agent by default.
	const notifyAgents = ({ state, reasons }) => {
		const injection = shared.config.injection ?? DEFAULTS.injection;
		if (state === "critical") {
			if (injection.criticalNotice !== true) return;
		} else if (injection.transitionReports !== true) {
			return;
		}
		const heading = state === "critical"
			? `[hardware-guard] HOST UNDER CRITICAL PRESSURE (${reasons.join("; ")})`
			: state === "warn"
				? `[hardware-guard] Host pressure elevated to WARN (${reasons.join("; ")})`
				: `[hardware-guard] Host pressure back to OK`;
		const body = `${heading}\n${renderReport()}\n${state === "critical"
			? "Stop heavy background work now (job_kill). New background shell work is denied until pressure clears."
			: state === "warn"
				? "Avoid starting new background work; prefer to finish or stop existing jobs."
				: "Normal operation resumed."}`;
		for (const agent of ctx.agents.list()) {
			try {
				if (state === "critical") agent.followup(pluginMessage(body));
				else agent.inject(pluginMessage(body));
			} catch {
				/* an agent mid-teardown must not break the watchdog */
			}
		}
	};

	const onTransition = ({ state, previous, reasons, details }) => {
		recordIncident("pressure-transition", { state, previous, reasons, details });
		notifyAgents({ state, reasons });
	};

	ctx.setInterval(() => {
		try {
			markLifecycleDirty(shared.storageDir);
		} catch {
			/* heartbeat persistence is best-effort */
		}
		try {
			const tick = pressure.tick(shared.host);
			watchdogTick({ host: shared.host, pressure: tick, onTransition });
		} catch (error) {
			recordIncident("watchdog-error", { error: String(error?.message ?? error) });
		}
		try {
			runAdaptationCycle();
		} catch (error) {
			recordIncident("adaptation-error", { error: String(error?.message ?? error) });
		}
	}, shared.config.watchdogIntervalMs);

	// ── model-facing tool ───────────────────────────────────────────────────
	// Always registered — it is the only way back in after a disable. The
	// v0.3.1 approval gate for disable/confirm rides ctx.approval when the
	// host composes one; without it those writes fail closed.
	const approval = ctx.get("approval");
	ctx.tools.register(defineHardwareGuardTool({ approval: approval ?? null }));
}
