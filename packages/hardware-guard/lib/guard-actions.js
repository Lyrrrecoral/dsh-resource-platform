/**
 * v0.3.2 guard write actions shared by the model-facing `hardware_guard` tool and
 * the web control endpoint (`POST /resources/hardware`) — ONE code path for the
 * control switch and the adaptation engine, so both surfaces can never drift
 * apart.
 *
 * The actions below are the UNGATED core:
 *  - `performDisableGuard` / `performEnableGuard`: compare-and-swap the
 *    v0.3.0 control switch (control.json) with atomic durable writes and
 *    guard-disabled/guard-enabled incident records. Enable additionally
 *    forces a hardware re-probe + budget re-derivation, clears every runtime
 *    cache and re-runs the graded retro-cap scan.
 *  - `performConfirmAdapt`: apply/acknowledge pending adaptations
 *    (adaptations.json) exactly like `hardware_guard confirm-adapt`.
 *
 * Approval is a SURFACE concern, not a core concern: the tool wraps
 * `performDisableGuard` with the host approval service (fail-closed); the
 * web endpoint runs it directly because the user already clicked the
 * confirm dialog — that click IS the human operation.
 *
 * @module hardware-guard/guard-actions
 */
import { confirmAdaptations } from "./adaptation.js";
import { controlPath, loadControl, updateControlEnabled } from "./control.js";
import { refreshHostProfile, summarizeProfile } from "./host-profile.js";
import { recordIncident } from "./incidents.js";
import { resetRuntimeCaches, shared } from "./state.js";
import { retroCapDescendants } from "./watchdog.js";

/**
 * Compare-and-swap the control switch, retrying once if a concurrent writer
 * moved the revision between our read and write.
 */
export function casControl(enabled, reason, updatedBy) {
	if (shared.storageDir === null) return { ok: false, error: "hardware-guard storage directory not ready" };
	const current = loadControl(controlPath(shared.storageDir));
	let result = updateControlEnabled({
		dir: shared.storageDir,
		enabled,
		reason,
		updatedBy,
		expectedRevision: current.error === null ? current.revision : 0
	});
	if (!result.ok && result.conflict === true) {
		// one retry, newest decision wins
		result = updateControlEnabled({ dir: shared.storageDir, enabled, reason, updatedBy });
	}
	return result;
}

/** Control switch off: every enforcement path passes through. */
export function performDisableGuard({ reason = "", updatedBy = "hardware-guard-tool" } = {}) {
	const result = casControl(false, reason, updatedBy);
	if (!result.ok) return result;
	shared.control = result.state;
	recordIncident("guard-disabled", {
		reason,
		updatedBy,
		at: new Date().toISOString(),
		revision: result.state.revision
	});
	const lines = [
		`[hardware-guard] Guard DISABLED (${new Date().toISOString()}) — control switch off, revision ${result.state.revision}.`,
		`reason: ${reason === "" ? "(none)" : reason}`,
		`updatedBy: ${updatedBy}`,
		"Admission gate, watchdog enforcement, shell prologue and sandbox wrapper now pass everything through.",
		"The hardware_guard tool, status pages, incidents log and DSH_HW_* env vars keep working — they are the only way back in.",
		"NOTE: existing persistent shell processes KEEP the ulimits they inherited at spawn — inherited limits cannot be removed. Disabling affects only NEW shells and NEW processes.",
		"Re-enable with: hardware_guard enable."
	];
	return { ok: true, text: lines.join("\n") };
}

/** Control switch on + forced re-probe + runtime-cache reset + retro-cap scan. */
export function performEnableGuard({ reason = "", updatedBy = "hardware-guard-tool" } = {}) {
	const result = casControl(true, reason, updatedBy);
	if (!result.ok) return result;
	shared.control = result.state;
	// Force re-probe hardware + re-derive budgets, then clear every runtime
	// cache so the re-enabled guard re-caps instead of trusting stale state.
	refreshHostProfile({ dir: shared.storageDir, config: shared.config, force: true });
	resetRuntimeCaches();
	const scan = retroCapDescendants(shared.host);
	recordIncident("guard-enabled", {
		reason,
		updatedBy,
		at: new Date().toISOString(),
		revision: result.state.revision,
		retroCapped: scan.capped,
		retroTotal: scan.total
	});
	const lines = [
		`[hardware-guard] Guard ENABLED (${new Date().toISOString()}) — control switch on, revision ${result.state.revision}.`,
		`reason: ${reason === "" ? "(none)" : reason}`,
		`updatedBy: ${updatedBy}`,
		"Forced hardware re-probe and budget re-derivation.",
		"Cleared runtime caches: cappedPids, computeConfirmedPids, killHistory, cpuTicks, lastInjectedAt.",
		scan.skipped
			? "Retroactive prlimit scan skipped (enforcement not active: dry-run profile, control switch off, or no prlimit on this platform)."
			: `Retroactive prlimit scan: ${scan.capped}/${scan.eligible} eligible of ${scan.total} descendants re-capped where the kernel permits (memoryCapPolicy ${shared.config.memoryCapPolicy ?? "none"} — unconfirmed processes are never capped).`,
		"NOTE: persistent bash processes that spawned while the guard was disabled inherited relaxed ulimits; the retroactive prlimit restores the address-space cap where possible, but some inherited limits cannot be fully restored. Disable/enable affects only NEW shells and NEW processes.",
		"",
		summarizeProfile(shared.host)
	];
	return { ok: true, text: lines.join("\n") };
}

/**
 * `hardware_guard confirm-adapt` semantics for both surfaces: a human confirms
 * pending adaptation entries; `id` selects one entry (default: all),
 * `option` picks between a proposal's labeled alternatives (default:
 * "primary"), or `"defer"` (option C, 暂不改动) to drop the entry without
 * changing any configuration. Review-only entries (empty changes) are
 * acknowledged.
 */
export function performConfirmAdapt({ id = null, option = "primary" } = {}) {
	const result = confirmAdaptations({ id, option });
	if (!result.ok) return result;
	const deferred = option === "defer";
	const lines = [
		deferred
			? `[hardware-guard] confirm-adapt: ${result.applied.length} pending adaptation(s) deferred — no configuration changed (${new Date().toISOString()}).`
			: `[hardware-guard] confirm-adapt: ${result.applied.length} pending adaptation(s) confirmed (${new Date().toISOString()}).`,
		...result.applied.map((entry) => entry.changes.length > 0
			? `  - ${entry.rule} (option ${entry.option ?? "primary"}): ${entry.changes.map((change) => `${change.field}: ${JSON.stringify(change.before)} → ${JSON.stringify(change.after)}`).join("; ")}`
			: deferred
				? `  - ${entry.rule}: deferred, configuration unchanged`
				: `  - ${entry.rule}: review acknowledged`),
		`remaining pending: ${result.remainingPending}`
	];
	if (deferred) lines.push("the proposing rule keeps its cooldown and may re-propose later; nothing was written.");
	if (result.note !== undefined) lines.push(result.note);
	return { ok: true, text: lines.join("\n"), applied: result.applied, remainingPending: result.remainingPending };
}
