/**
 * The model-facing `hardware_guard` tool: the agent's self-service channel to the
 * host profile, live pressure, incident history, the v0.3.0 control switch
 * and the adaptation engine. `report`, `profile`, `incidents` and
 * `pending-adaptations` are pure reads — they stay callable even while the
 * admission gate denies bash during CRITICAL pressure, so the model can
 * always diagnose and steer recovery. Writes: `confirm` (activate the
 * machine-private profile), `enable`/`disable` (the control switch),
 * `confirm-adapt` (human-confirm pending adaptations).
 *
 * v0.3.1 approval gate: `disable` and `confirm` are guarded by the host's
 * approval service (`ctx.approval.request`). With no approval channel
 * composed, no agent turn, a rejection, a cancellation or an unavailable
 * answerer the action FAILS CLOSED — nothing changes. `enable` restores the
 * safe state and executes directly; `confirm-adapt` keeps its human-confirm
 * semantics (it only applies proposals already marked NEEDS_HUMAN).
 *
 * v0.3.2: the write CORES (`enable`/`disable`/`confirm-adapt`) live in
 * guard-actions.js — the same functions the web control endpoint
 * (`POST /resources/hardware`) runs. Approval stays a tool-surface concern layered
 * on top of the shared core.
 *
 * @module hardware-guard/tool
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { renderPendingAdaptations } from "./adaptation.js";
import { disksPressure, renderDisks } from "./disk.js";
import { performConfirmAdapt, performDisableGuard, performEnableGuard } from "./guard-actions.js";
import { performCleanupScan } from "./cleanup-actions.js";
import { confirmHostProfile, fmtBytes, summarizeProfile } from "./host-profile.js";
import { recordIncident, renderIncidents } from "./incidents.js";
import { classifyPressure } from "./pressure.js";
import { shared } from "./state.js";

/** Fresh snapshot rendering shared by `report` and the pre-step injections. */
export function renderReport() {
	const host = shared.host;
	if (host === null || host === undefined || host.doc === undefined) return "hardware-guard: host profile not loaded yet";
	const vitals = shared.vitals ?? { memAvailableBytes: null, load1: null };
	const classification = classifyPressure(vitals, host.profile, {
		state: shared.pressureState,
		stateChangedAt: shared.pressureChangedAt,
		now: Date.now()
	});
	const free = vitals.memAvailableBytes;
	const control = shared.control ?? { enabled: true, revision: 0, reason: "", updatedBy: "" };
	const pending = shared.adaptations?.pending ?? [];
	const needsHuman = pending.filter((entry) => entry.needsHuman === true).length;
	const watchlist = (shared.adaptations?.watchlist ?? []).map((entry) => entry.comm);
	const lines = [
		`[hardware-guard report ${new Date().toISOString()}]`,
		`pressure state: ${shared.pressureState}${classification.reasons.length > 0 ? ` (${classification.reasons.join("; ")})` : ""}${classification.details.dwell === true ? " [dwell: minimum state time not elapsed]" : ""}`,
		`free memory: ${fmtBytes(free)} / effective ${fmtBytes(host.profile.effectiveMemBytes)}`,
		`load1: ${vitals.load1 ?? 0}`,
		...disksPressureLine(shared.vitals),
		...cleanupReminderLine(shared.vitals),
		`admission: background job cap ${host.profile.maxBackgroundJobs}; critical state ${shared.pressureState === "critical" ? "denies new bash/pwsh work" : "allows work"}`,
		`auto-kill on critical: ${shared.config.autoKillOnCritical ? "enabled" : "disabled"}`,
		`enforcement: ${host.profile.enforcementActive === false ? "DRY-RUN — profile pending confirmation (hardware_guard confirm)" : "active"}`,
		control.enabled === false
			? `control switch: DISABLED (revision ${control.revision}${control.reason ? `, reason: ${control.reason}` : ""}${control.updatedBy ? `, by: ${control.updatedBy}` : ""}) — gate/watchdog/prologue/sandbox pass through; hardware_guard enable to re-enable`
			: `control switch: enabled (revision ${control.revision}${control.error ? ` — WARNING: ${control.error}` : ""})`,
		`adaptations: ${pending.length} pending${needsHuman > 0 ? ` (${needsHuman} NEEDS_HUMAN)` : ""}${watchlist.length > 0 ? `; watchlist: ${watchlist.join(", ")}` : ""}`,
		"",
		summarizeProfile(host)
	];
	return lines.join("\n");
}

/** v0.4.0: one report line for the disk axis (empty when no disk facts). */
function disksPressureLine(vitals) {
	const disks = Array.isArray(vitals?.disks) ? vitals.disks : [];
	if (disks.length === 0) return [];
	const state = disksPressure(disks);
	const worst = disks
		.filter((disk) => disk.availBytes !== null && disk.availBytes !== undefined)
		.sort((left, right) => (left.availBytes ?? 0) - (right.availBytes ?? 0))[0];
	const detail = disks.map((disk) => `${disk.path} ${fmtBytes(disk.availBytes)} available`).join("; ");
	return [`disk pressure: ${state}${worst !== undefined ? ` (most dangerous ${worst.path}: ${fmtBytes(worst.availBytes)} available)` : ""} [${detail}]`];
}

export function renderProfile() {
	const host = shared.host;
	if (host === null || host === undefined || host.doc === undefined) return "hardware-guard: host profile not loaded yet";
	const lines = [
		`[hardware-guard host profile; probed ${new Date(host.doc.probedAt).toISOString()}; file: ${host.path ?? "(memory only)"}]`,
		summarizeProfile(host)
	];
	if (host.changedFrom !== null && host.changedFrom !== undefined) {
		lines.push(`note: hardware changed since the previous profile (memory ${fmtBytes(host.changedFrom.hardware.memTotalBytes)} → ${fmtBytes(host.doc.hardware.memTotalBytes)}); budgets were re-derived.`);
	}
	return lines.join("\n");
}

/** Handle the `confirm` action: apply overrides, activate enforcement, persist. */
async function confirmAction(args, exec, approval) {
	const overrides = args.overrides ?? {};
	const overrideSummary = Object.entries(overrides).length > 0
		? `; overrides: ${Object.entries(overrides).map(([section, fields]) => `${section}:${Object.keys(fields ?? {}).join(",")}`).join(" ")}`
		: "";
	const gate = await requireApproval({
		approval,
		exec,
		action: "confirm",
		summary: `hardware_guard confirm: activate this machine's enforcement profile (caps, admission, watchdog)${overrideSummary}`
	});
	if (!gate.ok) return { text: gate.text };
	const result = confirmHostProfile({ dir: shared.storageDir, overrides });
	if (!result.ok) return { text: `[hardware-guard] confirm failed: ${result.error}` };
	const applied = result.applied ?? {};
	const rejected = result.rejected ?? [];
	const lines = [
		`[hardware-guard] Profile confirmed (${new Date().toISOString()}). Enforcement is now ACTIVE.`,
		`derivedFrom: ${result.doc.budget.derivedFrom}`,
		Object.keys(applied).length > 0
			? `overrides applied: ${Object.entries(applied).map(([section, fields]) => `${section}: ${Object.keys(fields).join(", ")}`).join("; ")}`
			: "overrides: none",
		rejected.length > 0 ? `rejected: ${rejected.join("; ")}` : "rejected: none",
		"",
		summarizeProfile(shared.host)
	];
	recordIncident("profile-confirmed", {
		derivedFrom: result.doc.budget.derivedFrom,
		applied,
		rejected
	});
	return { text: lines.join("\n") };
}

/** Handle the `disable` action: control switch off, full pass-through. */
async function disableAction(args, exec, approval) {
	const reason = args.reason ?? "";
	const gate = await requireApproval({
		approval,
		exec,
		action: "disable",
		summary: `hardware_guard disable: turn the guard off for NEW shells/processes (admission gate, watchdog caps/kills, shell prologue and sandbox wrapper all pass through). reason: ${reason === "" ? "(none)" : reason}`
	});
	if (!gate.ok) return { text: gate.text };
	const updatedBy = args.updatedBy ?? "hardware-guard-tool";
	const result = performDisableGuard({ reason, updatedBy });
	if (!result.ok) return { text: `[hardware-guard] disable failed: ${result.error ?? "CAS conflict"}` };
	return { text: result.text };
}

/** Handle the `enable` action: control switch on + forced re-probe + retro-caps. */
function enableAction(args) {
	const reason = args.reason ?? "";
	const updatedBy = args.updatedBy ?? "hardware-guard-tool";
	const result = performEnableGuard({ reason, updatedBy });
	if (!result.ok) return { text: `[hardware-guard] enable failed: ${result.error ?? "CAS conflict"}` };
	return { text: result.text };
}

/** Handle the `pending-adaptations` action: list what awaits human review. */
function pendingAdaptationsAction() {
	return { text: `[hardware-guard pending adaptations]\n${renderPendingAdaptations()}` };
}

/** Handle the v0.4.0 `disks` action: per-path capacity/usage/thresholds. */
function disksAction() {
	return { text: renderDisks(shared.vitals?.disks ?? []) };
}

/** Handle the `confirm-adapt` action: a human confirms pending adaptations. */
function confirmAdaptAction(args) {
	const result = performConfirmAdapt({ id: args.id ?? null, option: args.option ?? "primary" });
	if (!result.ok) return { text: `[hardware-guard] confirm-adapt failed: ${result.error ?? "unknown error"}` };
	return { text: result.text };
}

/**
 * v0.3.1 approval gate for the write actions that WEAKEN protection
 * (`disable`, `confirm`). Resolves through the host approval service with a
 * human-readable reason; every non-grant fails closed and nothing changes.
 * The approval request borrows the live agent, tool identity, call id and
 * abort signal from the executing tool call.
 *
 * @param {object} input
 * @param {object|null} input.approval - `ctx.approval` or null when none is composed
 * @param {object} [input.exec] - ToolRunContext (agent/callId/signal)
 * @param {string} input.action - action name for messages
 * @param {string} input.summary - the audit reason shown to the user
 * @returns {Promise<{ok: true} | {ok: false, text: string}>}
 */
async function requireApproval({ approval, exec, action, summary }) {
	if (approval === null || approval === undefined || typeof approval.request !== "function") {
		return { ok: false, text: `[hardware-guard] ${action} refused: no approval channel is composed on this host (fail-closed — nothing was changed).` };
	}
	if (exec?.agent === undefined || exec?.agent === null) {
		return { ok: false, text: `[hardware-guard] ${action} refused: this action is not attached to an agent turn, so it cannot be shown for approval (fail-closed — nothing was changed).` };
	}
	let outcome;
	try {
		outcome = await approval.request({
			agent: exec.agent,
			toolName: "hardware_guard",
			callId: exec.callId,
			reason: summary,
			signal: exec.signal
		});
	} catch (error) {
		return { ok: false, text: `[hardware-guard] ${action} refused: the approval request failed (${String(error?.message ?? error)}). Nothing was changed.` };
	}
	if (outcome !== "allowed-once") {
		const label = outcome === "rejected"
			? "rejected by the user"
			: outcome === "cancelled"
				? "cancelled"
				: "approval channel unavailable";
		return { ok: false, text: `[hardware-guard] ${action} refused: ${label} (fail-closed — nothing was changed).` };
	}
	return { ok: true };
}

/** v0.5.0: one report line prompting cleanup when disk pressure is elevated. */
function cleanupReminderLine(vitals) {
	const disks = Array.isArray(vitals?.disks) ? vitals.disks : [];
	const level = disksPressure(disks);
	if (level === "ok") return [];
	const probe = shared.config?.cleanupProbe;
	if (probe?.enabled !== true) {
		return [`disk cleanup probe: disabled (disk pressure ${level}) — configure cleanupProbe.enabled + roots to list redundant project files`];
	}
	const plan = shared.cleanupLastPlan;
	const summary = plan === null || plan === undefined
		? "no scan yet"
		: `${plan.candidates.length} candidate(s), ${fmtBytes(plan.totalBytes)} total`;
	return [`disk cleanup probe: disk pressure ${level}; last scan: ${summary} — run hardware_guard cleanup-scan; deletion requires user approval in Resources > Guard`];
}

export function defineHardwareGuardTool({ approval = null } = {}) {
	return defineTool({
		name: "hardware_guard",
		description: "Query and steer the host-hardware guard: current resource pressure, hardware budget profile, past guard incidents, the master enable/disable switch and the incident-driven adaptation engine. report/profile/incidents/pending-adaptations/disks are pure reads — usable even when the guard has denied shell access. Writes (confirm, enable, disable, confirm-adapt) are the guard's only state changes; disable and confirm additionally require user approval and fail closed without it, while enable (restoring safety) executes directly.",
		parameters: {
			action: {
				type: "string",
				required: true,
				enum: ["report", "profile", "incidents", "disks", "confirm", "enable", "disable", "pending-adaptations", "confirm-adapt", "cleanup-scan"],
				description: "report = live pressure + budgets + control state; profile = persisted hardware profile; incidents = recent guard events (kills, transitions, adaptations); disks = per-path disk capacity/usage/thresholds (v0.4.0); confirm = activate enforcement after user confirmation (optionally with overrides); enable = turn the control switch back on (re-probe + retro-caps); disable = turn the control switch off (everything passes through); pending-adaptations = list adaptation proposals awaiting human review; confirm-adapt = apply/acknowledge pending adaptations."
			},
			overrides: {
				type: "object",
				additionalProperties: true,
				description: "Optional explicit overrides applied together with confirm. Nested keys follow the host profile sections: { budget: {maxBackgroundJobs: 2, niceLevel: 10}, pressure: {warnLoad: 6, hysteresis: {minStateMs: 30000}} }. Invalid or unknown keys are rejected without effect."
			},
			reason: {
				type: "string",
				description: "Optional human-readable reason recorded with enable/disable."
			},
			updatedBy: {
				type: "string",
				description: "Optional actor name recorded with enable/disable (defaults to hardware-guard-tool)."
			},
			id: {
				type: "string",
				description: "Optional adaptation id for confirm-adapt; omit to confirm all pending entries."
			},
			option: {
				type: "string",
				enum: ["primary", "alternative", "defer"],
				description: "For confirm-adapt on a proposal with alternatives: primary (default), alternative, or defer = keep current config (acknowledge and let the rule re-propose after cooldown)."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					text: {
						type: "string",
						required: true
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: value.text
			}]
		},
		execute(args, exec) {
			switch (args.action) {
				case "profile": return Promise.resolve({ text: renderProfile() });
				case "incidents": return Promise.resolve({ text: `[hardware-guard incidents]\n${renderIncidents(10)}` });
				case "disks": return Promise.resolve(disksAction());
				case "confirm": return confirmAction(args, exec, approval);
				case "enable": return Promise.resolve(enableAction(args));
				case "disable": return disableAction(args, exec, approval);
				case "pending-adaptations": return Promise.resolve(pendingAdaptationsAction());
				case "confirm-adapt": return Promise.resolve(confirmAdaptAction(args));
				case "cleanup-scan": return performCleanupScan().then((result) => ({
					text: result.ok
						? [`[hardware-guard cleanup-scan] ${result.plan.candidates.length} candidate(s), ${fmtBytes(result.plan.totalBytes)} total.`, ...result.plan.candidates.slice(0, 20).map((item) => `  - ${item.path} (${fmtBytes(item.sizeBytes)}, age ${Math.floor(item.ageMs / 3600000)}h)`)].join("\n")
						: `[hardware-guard cleanup-scan] failed: ${result.error}`
				}));
				default: return Promise.resolve({ text: renderReport() });
			}
		}
	});
}
