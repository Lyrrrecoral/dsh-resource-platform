/**
 * The v0.3.0 one-shot master switch: `$DSH_HOME/storages/hardware-guard/control.json`.
 *
 * One persistent knob turns EVERY enforcement path off or on (shell prologue,
 * sandbox wrapper, admission gate, watchdog, env facts) without touching the
 * composition, the profile or the systemd unit:
 *
 * ```json
 * {
 *   "schemaVersion": 1,
 *   "enabled": true,
 *   "revision": 1,
 *   "reason": "",
 *   "updatedBy": "",
 *   "updatedAt": 0
 * }
 * ```
 *
 * Semantics (fail-safe by design):
 *  - MISSING file  → ENABLED (safe default; revision 0).
 *  - CORRUPT file  → stays ENABLED and exposes the error through
 *    incidents/status; never throws into any call path.
 *  - Updates are compare-and-swap on `revision` (read → verify → write) so
 *    a stale writer can never clobber a newer decision; a corrupt file is
 *    replaced (treated as revision 0) because otherwise the switch could
 *    never recover.
 *
 * NOTE: disabling only affects NEW shells and NEW processes. Persistent bash
 * sessions that already inherited ulimits at spawn keep them — inherited
 * limits cannot be un-applied, and the guard deliberately does not know how
 * to make a process MORE dangerous.
 *
 * @module hardware-guard/control
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileDurable } from "./host-profile.js";

export const CONTROL_SCHEMA_VERSION = 1;

/** The enabled default state a missing file projects to. */
export const CONTROL_DEFAULT_STATE = Object.freeze({
	schemaVersion: CONTROL_SCHEMA_VERSION,
	enabled: true,
	revision: 0,
	reason: "",
	updatedBy: "",
	updatedAt: 0,
	error: null
});

/**
 * Load and validate the control file. Never throws.
 * @param {string} path - control.json path
 * @returns {{schemaVersion, enabled, revision, reason, updatedBy, updatedAt, error: string|null}}
 */
export function loadControl(path) {
	let text = null;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		// missing file → enabled safe default
		return { ...CONTROL_DEFAULT_STATE };
	}
	let parsed = null;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		return {
			...CONTROL_DEFAULT_STATE,
			error: `control.json is corrupt (${String(error?.message ?? error)}); guard stays ENABLED (safe default)`
		};
	}
	if (
		typeof parsed !== "object" || parsed === null
		|| parsed.schemaVersion !== CONTROL_SCHEMA_VERSION
		|| typeof parsed.enabled !== "boolean"
		|| !Number.isInteger(parsed.revision) || parsed.revision < 1
	) {
		return {
			...CONTROL_DEFAULT_STATE,
			error: "control.json is corrupt (invalid structure); guard stays ENABLED (safe default)"
		};
	}
	return {
		schemaVersion: CONTROL_SCHEMA_VERSION,
		enabled: parsed.enabled,
		revision: parsed.revision,
		reason: typeof parsed.reason === "string" ? parsed.reason : "",
		updatedBy: typeof parsed.updatedBy === "string" ? parsed.updatedBy : "",
		updatedAt: Number.isFinite(parsed.updatedAt) ? parsed.updatedAt : 0,
		error: null
	};
}

/**
 * Compare-and-swap update of the control switch.
 *
 * @param {object} input
 * @param {string} input.dir - storage directory holding control.json
 * @param {boolean} input.enabled - target state
 * @param {string} [input.reason] - human-readable reason
 * @param {string} [input.updatedBy] - who flipped the switch
 * @param {number|null} [input.expectedRevision] - CAS guard: only write when
 *   the file's current revision matches (a missing file counts as 0; a
 *   corrupt file also counts as 0 so it can be replaced). Omit to bypass CAS.
 * @returns {{ok: true, state} | {ok: false, conflict?: boolean, current?: number, error?: string}}
 */
export function updateControlEnabled({ dir, enabled, reason = "", updatedBy = "", expectedRevision = null }) {
	const path = join(dir, "control.json");
	const current = loadControl(path);
	const currentRevision = current.error === null ? current.revision : 0;
	if (expectedRevision !== null && expectedRevision !== currentRevision) {
		return { ok: false, conflict: true, current: currentRevision };
	}
	const next = {
		schemaVersion: CONTROL_SCHEMA_VERSION,
		enabled: enabled === true,
		revision: currentRevision + 1,
		reason: typeof reason === "string" ? reason : "",
		updatedBy: typeof updatedBy === "string" ? updatedBy : "",
		updatedAt: Date.now()
	};
	try {
		writeFileDurable(path, JSON.stringify(next, null, 2));
	} catch (error) {
		return { ok: false, error: String(error?.message ?? error) };
	}
	return { ok: true, state: next };
}

/** The canonical control.json path inside the hardware-guard storage directory. */
export function controlPath(dir) {
	return join(dir, "control.json");
}
