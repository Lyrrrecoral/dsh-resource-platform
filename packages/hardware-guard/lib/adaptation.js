/**
 * Incident-driven bounded adaptation: `$DSH_HOME/storages/hardware-guard/adaptations.json`.
 *
 * The guard reacts to its OWN incident history with a small fixed rule table
 * — no free-form code changes, ever:
 *
 * | evidence                          | adjustment                    | cap / constraint                     |
 * |-----------------------------------|-------------------------------|--------------------------------------|
 * | >=3 critical transitions / 1h     | maxBackgroundJobs -1          | floor 1                              |
 * | an auto-kill sweep happened       | killCooldownMs × 1.5          | max 30 min                           |
 * | >=5 watchdog errors / 15min       | autoKillOnCritical = false    | NEEDS_HUMAN; never silently keep killing |
 * | critical shortly before a restart | cpuReserve +1 OR memSafetyFrac −0.05 | PENDING ONLY (confirm-adapt)   |
 * | same comm auto-killed >=2×        | enter human-reviewed watchlist | observation only; never auto permanent exclusion |
 *
 * Principles:
 *  - small & reversible adjustments auto-apply,
 *  - large adjustments are written as PENDING entries and need
 *    `hardware_guard confirm-adapt`,
 *  - every adjustment records an incident with before/after/reason/cap,
 *  - the engine NEVER becomes more aggressive on its own,
 *  - per-rule cooldowns: the same rule is not re-applied while cooling down.
 *
 * The persisted document:
 * ```json
 * { "schemaVersion": 1,
 *   "applied":   [ {id, rule, at, reason, cap, changes, needsHuman} ],
 *   "pending":   [ {id, rule, createdAt, reason, cap, needsHuman, options} ],
 *   "cooldowns": { "<rule>": <epochMs of last proposal> },
 *   "watchlist": [ {comm, firstSeenAt, killCount} ] }
 * ```
 *
 * @module hardware-guard/adaptation
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deriveRuntimeProfile, validateHostProfile, writeFileDurable } from "./host-profile.js";
import { recordIncident } from "./incidents.js";
import { shared } from "./state.js";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const MIB = 1024 * 1024;

/** The fixed rule table. Cooldowns keep one rule from re-firing in a burst. */
export const ADAPTATION_RULES = Object.freeze({
	"critical-transition-load": {
		cooldownMs: 30 * MINUTE,
		windowMs: HOUR,
		threshold: 3,
		cap: "maxBackgroundJobs floor 1"
	},
	"auto-kill-cooldown": {
		cooldownMs: 10 * MINUTE,
		cap: "killCooldownMs max 30min"
	},
	"watchdog-error-limit": {
		cooldownMs: 30 * MINUTE,
		windowMs: 15 * MINUTE,
		threshold: 5,
		needsHuman: true,
		cap: "autoKillOnCritical=false; human review before re-enable"
	},
	"critical-restart-reserve": {
		cooldownMs: 24 * HOUR,
		windowMs: 15 * MINUTE,
		needsHuman: true,
		cap: "pending only — hardware_guard confirm-adapt required"
	},
	"unclean-boot-reserve": {
		cooldownMs: 24 * HOUR,
		needsHuman: true,
		cap: "pending only — hardware_guard confirm-adapt required"
	},
	"repeat-kill-watchlist": {
		cooldownMs: 30 * MINUTE,
		threshold: 2,
		needsHuman: true,
		cap: "observation watchlist only — never auto permanent exclusion"
	}
});

/** Fresh in-memory adaptation document. */
export function emptyAdaptations() {
	return {
		schemaVersion: 1,
		applied: [],
		pending: [],
		cooldowns: {},
		watchlist: []
	};
}

/**
 * Load adaptations.json. Missing → empty document; corrupt → empty document
 * plus an error string (surfaced via incidents/status, never thrown).
 */
export function loadAdaptations(path) {
	if (typeof path !== "string" || path.length === 0) {
		return { doc: emptyAdaptations(), error: null };
	}
	let text = null;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return { doc: emptyAdaptations(), error: null };
	}
	try {
		const parsed = JSON.parse(text);
		if (typeof parsed !== "object" || parsed === null || parsed.schemaVersion !== 1) {
			return { doc: emptyAdaptations(), error: "adaptations.json is corrupt (invalid structure); engine restarts from an empty document" };
		}
		return {
			doc: {
				schemaVersion: 1,
				applied: Array.isArray(parsed.applied) ? parsed.applied : [],
				pending: Array.isArray(parsed.pending) ? parsed.pending : [],
				cooldowns: (typeof parsed.cooldowns === "object" && parsed.cooldowns !== null) ? parsed.cooldowns : {},
				watchlist: Array.isArray(parsed.watchlist) ? parsed.watchlist : []
			},
			error: null
		};
	} catch (error) {
		return {
			doc: emptyAdaptations(),
			error: `adaptations.json is corrupt (${String(error?.message ?? error)}); engine restarts from an empty document`
		};
	}
}

/** Persist the in-memory adaptation document (durable write, best effort). */
export function saveAdaptations() {
	if (shared.storageDir === null) return;
	const path = join(shared.storageDir, shared.config.adaptationsFileName);
	try {
		writeFileDurable(path, JSON.stringify(shared.adaptations, null, 2));
	} catch {
		/* persistence is best-effort; the in-memory engine still runs */
	}
}

/** Effective memory of the host, same formula as the runtime projection. */
function effectiveMemBytes(doc) {
	const hw = doc?.hardware ?? {};
	return Math.max(1, Math.min(
		hw.memTotalBytes || Number.MAX_SAFE_INTEGER,
		hw.cgroup?.memMaxBytes ?? Number.MAX_SAFE_INTEGER
	));
}

/**
 * Clamp a numeric delta: after = clamp(before + delta, min, max); the floor
 * is honored for integers (ceil), the cap for products (floor).
 */
function clampedValue(before, op) {
	// "set" assigns the literal (booleans included); arithmetic ops need numbers
	if (op.op === "set") {
		return { after: op.value, clamped: false };
	}
	if (!Number.isFinite(before)) return { after: before, clamped: true };
	if (op.op === "multiply") {
		const raw = before * op.factor;
		const after = Math.min(op.max ?? Number.MAX_SAFE_INTEGER, Math.floor(raw));
		return { after, clamped: after < raw };
	}
	if (op.op === "delta") {
		const after = Math.max(op.min ?? -Number.MAX_SAFE_INTEGER, Math.min(op.max ?? Number.MAX_SAFE_INTEGER, before + op.delta));
		return { after, clamped: after !== before + op.delta };
	}
	return { after: before, clamped: false };
}

/**
 * Apply one change descriptor to the host profile document and mirror the
 * runtime config where the watchdog reads from it. Returns the before/after
 * pair (or null when the change is a no-op).
 */
function applyChangeToDoc(doc, change, adaptations) {
	const target = change.target;
	if (target === "budget") {
		const before = doc.budget?.[change.field];
		const { after, clamped } = clampedValue(before, change);
		if (after === before) return null;
		doc.budget[change.field] = Math.floor(after);
		if (change.field === "cpuReservedCores") {
			doc.budget.cpuBudgetCores = Math.max(1, doc.hardware.cpuCount - Math.floor(after));
		}
		return { field: `budget.${change.field}`, before, after: doc.budget[change.field], clamped };
	}
	if (target === "enforcement") {
		const before = doc.enforcement?.[change.field];
		const { after, clamped } = clampedValue(before, change);
		if (after === before) return null;
		// numeric knobs floor to integers; boolean knobs (autoKillOnCritical)
		// keep their literal value
		const value = typeof after === "number" ? Math.floor(after) : after;
		doc.enforcement[change.field] = value;
		// the watchdog reads the runtime config, not the doc — mirror it
		shared.config[change.field] = value;
		return { field: `enforcement.${change.field}`, before, after: value, clamped };
	}
	if (target === "config") {
		// memSafetyFrac: recompute the derived memory budget + per-command cap
		const before = shared.config[change.field];
		const { after, clamped } = clampedValue(before, change);
		if (after === before) return null;
		shared.config[change.field] = after;
		const effectiveMem = effectiveMemBytes(doc);
		const oldBudget = doc.budget.memBudgetBytes;
		const oldCap = doc.budget.perCommandMemCapBytes;
		doc.budget.memBudgetBytes = Math.floor(effectiveMem * after);
		doc.budget.perCommandMemCapBytes = Math.max(64 * MIB, Math.min(
			shared.config.perCommandMemCapBytes,
			Math.floor(doc.budget.memBudgetBytes / 4)
		));
		return {
			field: `config.${change.field} (re-derived memBudget + perCommandMemCap)`,
			before: { memSafetyFrac: before, memBudgetBytes: oldBudget, perCommandMemCapBytes: oldCap },
			after: { memSafetyFrac: after, memBudgetBytes: doc.budget.memBudgetBytes, perCommandMemCapBytes: doc.budget.perCommandMemCapBytes },
			clamped
		};
	}
	if (target === "watchlist") {
		const comm = change.comm;
		if (typeof comm !== "string" || comm.length === 0) return null;
		const watchlist = adaptations.watchlist ?? [];
		if (watchlist.some((entry) => entry.comm === comm)) return null;
		watchlist.push({ comm, firstSeenAt: Date.now(), killCount: change.count ?? 1 });
		return { field: `watchlist.add ${comm}`, before: null, after: comm, clamped: false };
	}
	return null;
}

/**
 * Apply a list of changes to the host document, then persist and re-derive
 * the runtime projection. Validates the result and refuses to persist an
 * invalid document (the incident records the refusal instead).
 */
export function applyChanges(changes) {
	const host = shared.host;
	if (host === null || host === undefined || host.doc === undefined) {
		return { ok: false, error: "no host profile loaded" };
	}
	const results = [];
	for (const change of changes ?? []) {
		const applied = applyChangeToDoc(host.doc, change, shared.adaptations);
		if (applied !== null) results.push(applied);
	}
	if (results.length === 0) return { ok: true, changes: [], note: "no effective change" };
	const check = validateHostProfile(host.doc);
	if (!check.ok) {
		return { ok: false, error: check.errors.join("; "), changes: results };
	}
	try {
		writeFileDurable(host.path, JSON.stringify(host.doc, null, 2));
	} catch (error) {
		return { ok: false, error: String(error?.message ?? error), changes: results };
	}
	host.profile = deriveRuntimeProfile(host.doc);
	return { ok: true, changes: results };
}

/**
 * Pure rule evaluation over an incident list. Returns proposals in rule-table
 * order; each proposal carries its change descriptors (or `options` when a
 * human must choose between alternatives).
 */
export function proposeAdaptations({ incidents, doc, config, adaptations, now }) {
	const proposals = [];
	const list = Array.isArray(incidents) ? incidents : [];
	const cooldowns = (typeof adaptations?.cooldowns === "object" && adaptations.cooldowns !== null) ? adaptations.cooldowns : {};
	const pending = Array.isArray(adaptations?.pending) ? adaptations.pending : [];
	const inCooldown = (rule) => now - (cooldowns[rule] ?? 0) < ADAPTATION_RULES[rule].cooldownMs;
	const hasPending = (rule) => pending.some((entry) => entry.rule === rule);

	// 1. >=3 critical transitions within 1h → maxBackgroundJobs -1 (floor 1)
	{
		const spec = ADAPTATION_RULES["critical-transition-load"];
		const crits = list.filter((i) => i.kind === "pressure-transition" && i.state === "critical" && now - i.atMs <= spec.windowMs);
		if (crits.length >= spec.threshold && !inCooldown("critical-transition-load")) {
			const before = doc.budget?.maxBackgroundJobs;
			if (Number.isFinite(before) && before > 1) {
				proposals.push({
					rule: "critical-transition-load",
					kind: "apply",
					needsHuman: false,
					cap: spec.cap,
					reason: `${crits.length} critical pressure transitions within 1h; reduce background parallelism`,
					evidence: crits.length,
					changes: [{ target: "budget", field: "maxBackgroundJobs", op: "delta", delta: -1, min: 1 }]
				});
			}
		}
	}

	// 2. an auto-kill sweep happened → killCooldownMs × 1.5 (max 30min)
	{
		const spec = ADAPTATION_RULES["auto-kill-cooldown"];
		const lastApplied = cooldowns["auto-kill-cooldown"] ?? 0;
		const kills = list.filter((i) => i.kind === "auto-kill" && i.atMs > lastApplied);
		if (kills.length > 0 && !inCooldown("auto-kill-cooldown")) {
			const before = doc.enforcement?.killCooldownMs ?? config.killCooldownMs;
			const after = Math.min(30 * MINUTE, Math.floor(before * 1.5));
			if (Number.isFinite(before) && after > before) {
				proposals.push({
					rule: "auto-kill-cooldown",
					kind: "apply",
					needsHuman: false,
					cap: spec.cap,
					reason: `${kills.length} auto-kill sweep(s) since the last adaptation; lengthen the kill cooldown`,
					evidence: kills.length,
					changes: [{ target: "enforcement", field: "killCooldownMs", op: "multiply", factor: 1.5, max: 30 * MINUTE }]
				});
			}
		}
	}

	// 3. >=5 watchdog errors within 15min → autoKillOnCritical=false + NEEDS_HUMAN
	{
		const spec = ADAPTATION_RULES["watchdog-error-limit"];
		const errors = list.filter((i) => i.kind === "watchdog-error" && now - i.atMs <= spec.windowMs);
		const killing = doc.enforcement?.autoKillOnCritical ?? config.autoKillOnCritical;
		if (errors.length >= spec.threshold && killing === true && !inCooldown("watchdog-error-limit") && !hasPending("watchdog-error-limit")) {
			proposals.push({
				rule: "watchdog-error-limit",
				kind: "apply",
				needsHuman: true,
				reviewEntry: true,
				cap: spec.cap,
				reason: `${errors.length} watchdog errors within 15min; stop auto-killing instead of silently continuing`,
				evidence: errors.length,
				changes: [{ target: "enforcement", field: "autoKillOnCritical", op: "set", value: false }]
			});
		}
	}

	// 4. critical shortly before a host restart → pending reserve tightening
	{
		const spec = ADAPTATION_RULES["critical-restart-reserve"];
		const boots = list.filter((i) => i.kind === "boot").sort((left, right) => right.atMs - left.atMs);
		const boot = boots[0];
		if (boot !== undefined && !inCooldown("critical-restart-reserve") && !hasPending("critical-restart-reserve")) {
			const critsBeforeBoot = list.filter((i) => i.kind === "pressure-transition" && i.state === "critical" && i.atMs < boot.atMs && boot.atMs - i.atMs <= spec.windowMs);
			if (critsBeforeBoot.length > 0) {
				proposals.push({
					rule: "critical-restart-reserve",
					kind: "pending",
					needsHuman: true,
					cap: spec.cap,
					reason: `host was under CRITICAL pressure within 15min before this restart; propose reserving more headroom`,
					evidence: critsBeforeBoot.length,
					options: [
						{
							label: "primary",
							description: "keep one more core for the host (cpuReservedCores +1)",
							changes: [{ target: "budget", field: "cpuReservedCores", op: "delta", delta: 1, min: 0, max: Math.max(0, doc.hardware.cpuCount - 1) }]
						},
						{
							label: "alternative",
							description: "shrink the memory budget (memSafetyFrac −0.05)",
							changes: [{ target: "config", field: "memSafetyFrac", op: "delta", delta: -0.05, min: 0.5 }]
						}
					]
				});
			}
		}
	}

	// 5. same comm auto-killed >=2× → human-reviewed observation watchlist
	{
		const spec = ADAPTATION_RULES["repeat-kill-watchlist"];
		const killCount = new Map();
		for (const incident of list) {
			if (incident.kind !== "auto-kill") continue;
			for (const killed of incident.killed ?? []) {
				const comm = String(killed).split(":")[1]?.split("(")[0];
				if (comm !== undefined && comm.length > 0) killCount.set(comm, (killCount.get(comm) ?? 0) + 1);
			}
		}
		const watchlist = new Set((adaptations.watchlist ?? []).map((entry) => entry.comm));
		for (const [comm, count] of killCount) {
			if (count >= spec.threshold && !watchlist.has(comm) && !inCooldown("repeat-kill-watchlist")) {
				proposals.push({
					rule: "repeat-kill-watchlist",
					kind: "apply",
					needsHuman: true,
					reviewEntry: true,
					cap: spec.cap,
					reason: `${comm} was auto-killed ${count} times; observe it — never auto-exclude permanently`,
					evidence: count,
					changes: [{ target: "watchlist", field: "add", comm, count }]
				});
			}
		}
	}

	return proposals;
}

/**
 * One bounded engine cycle: propose from the incident ring, auto-apply the
 * small/reversible proposals, park the large ones as pending, honor cooldowns
 * and record one incident per adjustment (before/after/reason/cap).
 * @returns {{applied: object[], pending: object[]}}
 */
export function runAdaptationCycle({ now = Date.now() } = {}) {
	const result = { applied: [], pending: [] };
	if (shared.config.adaptationEnabled === false) return result;
	const host = shared.host;
	if (host === null || host === undefined || host.doc === undefined) return result;
	const proposals = proposeAdaptations({
		incidents: shared.incidents,
		doc: host.doc,
		config: shared.config,
		adaptations: shared.adaptations,
		now
	});
	for (const proposal of proposals) {
		shared.adaptations.cooldowns[proposal.rule] = now;
		if (proposal.kind === "pending") {
			const entry = {
				id: randomUUID(),
				rule: proposal.rule,
				createdAt: now,
				reason: proposal.reason,
				cap: proposal.cap,
				needsHuman: proposal.needsHuman === true,
				options: proposal.options ?? [{ label: "primary", description: null, changes: proposal.changes ?? [] }]
			};
			shared.adaptations.pending.unshift(entry);
			result.pending.push(entry);
			recordIncident("adaptation-pending", {
				rule: proposal.rule,
				reason: proposal.reason,
				cap: proposal.cap
			});
			saveAdaptations();
			continue;
		}
		const applied = applyChanges(proposal.changes);
		if (!applied.ok) {
			recordIncident("adaptation-error", {
				rule: proposal.rule,
				reason: proposal.reason,
				error: applied.error ?? "no effective change"
			});
			saveAdaptations();
			continue;
		}
		const entry = {
			id: randomUUID(),
			rule: proposal.rule,
			at: now,
			reason: proposal.reason,
			cap: proposal.cap,
			needsHuman: proposal.needsHuman === true,
			changes: applied.changes.map(({ field, before, after, clamped }) => ({ field, before, after, clamped }))
		};
		shared.adaptations.applied.unshift(entry);
		result.applied.push(entry);
		recordIncident("adaptation-applied", {
			rule: proposal.rule,
			reason: proposal.reason,
			cap: proposal.cap,
			before: Object.fromEntries(applied.changes.map((c) => [c.field, c.before])),
			after: Object.fromEntries(applied.changes.map((c) => [c.field, c.after]))
		});
		if (proposal.needsHuman === true && proposal.reviewEntry === true) {
			// a review-only checkpoint so NEEDS_HUMAN items stay visible until a
			// human acknowledges them via `hardware_guard confirm-adapt`
			const review = {
				id: randomUUID(),
				rule: `${proposal.rule}-review`,
				createdAt: now,
				reason: `REVIEW: ${proposal.reason}`,
				cap: proposal.cap,
				needsHuman: true,
				options: [{ label: "primary", description: "acknowledge; no further change", changes: [] }]
			};
			shared.adaptations.pending.unshift(review);
			result.pending.push(review);
		}
		saveAdaptations();
	}
	return result;
}

/**
 * `hardware_guard confirm-adapt`: a human confirms pending entries. `id` selects
 * one entry (default: all); `option` picks between a proposal's labeled
 * alternatives (default: "primary"), or `"defer"` (option C, 暂不改动) which
 * acknowledges and drops the entry without changing any configuration — the
 * proposing rule keeps its cooldown and may re-propose later. Review-only
 * entries (empty changes) are acknowledged. Every confirmation is recorded
 * as an incident (adaptation-applied / -confirmed / -deferred).
 */
export function confirmAdaptations({ id = null, option = "primary" } = {}) {
	const host = shared.host;
	const pending = shared.adaptations.pending;
	const selected = id === null ? [...pending] : pending.filter((entry) => entry.id === id);
	if (selected.length === 0) {
		return { ok: true, applied: [], remainingPending: pending.length, note: "no pending adaptations to confirm" };
	}
	const now = Date.now();
	const results = [];
	for (const entry of selected) {
		const defer = option === "defer";
		const chosen = defer
			? { label: "defer", changes: [] }
			: (entry.options ?? []).find((o) => o.label === option)
				?? (entry.options ?? [])[0]
				?? { label: "primary", changes: entry.changes ?? [] };
		const changes = chosen.changes ?? [];
		let appliedChanges = [];
		if (changes.length > 0) {
			const applied = applyChanges(changes);
			if (!applied.ok) {
				recordIncident("adaptation-error", {
					rule: entry.rule,
					source: "confirm-adapt",
					error: applied.error ?? "no effective change"
				});
				continue;
			}
			appliedChanges = applied.changes.map(({ field, before, after, clamped }) => ({ field, before, after, clamped }));
		}
		const applied = {
			id: entry.id,
			rule: entry.rule,
			at: now,
			confirmedAt: now,
			option: chosen.label ?? null,
			reason: entry.reason,
			cap: entry.cap,
			needsHuman: entry.needsHuman === true,
			changes: appliedChanges
		};
		shared.adaptations.applied.unshift(applied);
		results.push(applied);
		const incidentKind = defer
			? "adaptation-deferred"
			: appliedChanges.length > 0 ? "adaptation-applied" : "adaptation-confirmed";
		recordIncident(incidentKind, {
			rule: entry.rule,
			source: "confirm-adapt",
			option: chosen.label ?? null,
			reason: entry.reason,
			before: Object.fromEntries(appliedChanges.map((c) => [c.field, c.before])),
			after: Object.fromEntries(appliedChanges.map((c) => [c.field, c.after]))
		});
	}
	shared.adaptations.pending = pending.filter((entry) => !selected.some((picked) => picked.id === entry.id));
	saveAdaptations();
	return { ok: true, applied: results, remainingPending: shared.adaptations.pending.length };
}

/**
 * v0.3.1 host-unclean-boot proposal: the previous run exited WITHOUT a clean
 * marker while historical critical/auto-kill evidence exists — the host
 * likely went down the hard way. Park ONE pending, human-gated reserve
 * proposal (cpuReservedCores +1 OR memSafetyFrac −0.05) — never auto-applied.
 * Honored cooldown + existing-pending check stop re-firing in a burst.
 * @returns pending entry, or null when gated (cooldown / duplicate / no doc)
 */
export function proposeUncleanBootPending({ now = Date.now() } = {}) {
	const rule = "unclean-boot-reserve";
	const spec = ADAPTATION_RULES[rule];
	const host = shared.host;
	if (host === null || host === undefined || host.doc === undefined) return null;
	if (now - (shared.adaptations.cooldowns?.[rule] ?? 0) < spec.cooldownMs) return null;
	if ((shared.adaptations.pending ?? []).some((entry) => entry.rule === rule)) return null;
	const cpuCount = Math.max(1, host.doc.hardware?.cpuCount ?? 1);
	const entry = {
		id: randomUUID(),
		rule,
		createdAt: now,
		reason: "the previous hardware-guard run exited without a clean marker while critical-pressure/auto-kill history exists; propose reserving more headroom",
		cap: spec.cap,
		needsHuman: true,
		options: [
			{
				label: "primary",
				description: "keep one more core for the host (cpuReservedCores +1)",
				changes: [{ target: "budget", field: "cpuReservedCores", op: "delta", delta: 1, min: 0, max: Math.max(0, cpuCount - 1) }]
			},
			{
				label: "alternative",
				description: "shrink the memory budget (memSafetyFrac −0.05)",
				changes: [{ target: "config", field: "memSafetyFrac", op: "delta", delta: -0.05, min: 0.5 }]
			}
		]
	};
	shared.adaptations.cooldowns[rule] = now;
	shared.adaptations.pending.unshift(entry);
	recordIncident("adaptation-pending", {
		rule,
		reason: entry.reason,
		cap: spec.cap,
		source: "host-unclean-boot"
	});
	saveAdaptations();
	return entry;
}

/** Render pending entries for the `pending-adaptations` tool action. */
export function renderPendingAdaptations() {
	const pending = shared.adaptations.pending;
	if (pending.length === 0) return "no pending adaptations";
	return pending.map((entry) => {
		const options = (entry.options ?? []).map((option, index) => {
			const changes = (option.changes ?? []).map((c) => c.target === "watchlist"
				? `watchlist.add ${c.comm}`
				: `${c.target}.${c.field} ${c.op ?? "set"} ${c.op === "delta" ? `${c.delta >= 0 ? "+" : ""}${c.delta}` : c.op === "multiply" ? `×${c.factor}` : JSON.stringify(c.value)}`
			).join("; ") || "acknowledge only";
			return `    option ${index === 0 ? "primary" : "alternative"}: ${changes}`;
		});
		return [
			`- ${entry.id} [${entry.rule}]${entry.needsHuman ? " NEEDS_HUMAN" : ""}`,
			`  reason: ${entry.reason}`,
			`  cap: ${entry.cap}`,
			...options,
			"    option defer: 暂不改动 (acknowledge now, keep the current configuration)",
			`  confirm with: hardware_guard confirm-adapt (option primary|alternative|defer)${entry.id !== undefined ? ` id ${entry.id}` : ""}`
		].join("\n");
	}).join("\n");
}
