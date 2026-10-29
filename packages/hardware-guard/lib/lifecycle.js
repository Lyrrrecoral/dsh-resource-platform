/**
 * v0.3.1 process-lifecycle memory: the lightweight heartbeat / clean marker
 * file `$DSH_HOME/storages/hardware-guard/state.json`.
 *
 * Every boot flips the file to `clean: false` (durable, atomic) and every
 * watchdog heartbeat keeps it fresh; a normal SIGTERM/SIGINT shutdown (or
 * plugin fiber dispose) flips it back to `clean: true`. The next boot reads
 * the file BEFORE writing anything: a missing/unclean marker plus historical
 * critical-pressure/auto-kill evidence means the host went down the hard way
 * — the `host-unclean-boot` incident + a NEEDS_HUMAN adaptation proposal.
 *
 * The file is tiny and written with the standing durable-write discipline
 * (temp → fsync → rename), so a hard power-off leaves either the previous
 * content or the dirty marker, never a torn write.
 *
 * @module hardware-guard/lifecycle
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileDurable } from "./host-profile.js";

export const LIFECYCLE_SCHEMA_VERSION = 1;
export const LIFECYCLE_FILE_NAME = "state.json";

/**
 * Load state.json. Missing file → `{ doc: null, error: null }`; corrupt →
 * `{ doc: null, error }` (treated as NO clean marker — detection fails
 * toward flagging, never toward silence). Never throws.
 */
export function loadLifecycleState(dir) {
	if (typeof dir !== "string" || dir.length === 0) {
		return { doc: null, error: null };
	}
	const path = join(dir, LIFECYCLE_FILE_NAME);
	let text = null;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return { doc: null, error: null };
	}
	try {
		const parsed = JSON.parse(text);
		if (typeof parsed !== "object" || parsed === null || parsed.schemaVersion !== LIFECYCLE_SCHEMA_VERSION) {
			return { doc: null, error: "state.json is corrupt (invalid structure)" };
		}
		return {
			doc: {
				schemaVersion: LIFECYCLE_SCHEMA_VERSION,
				clean: parsed.clean === true,
				bootedAt: Number.isFinite(parsed.bootedAt) ? parsed.bootedAt : 0,
				exitedAt: Number.isFinite(parsed.exitedAt) ? parsed.exitedAt : 0,
				heartbeatAt: Number.isFinite(parsed.heartbeatAt) ? parsed.heartbeatAt : 0,
				pid: Number.isInteger(parsed.pid) ? parsed.pid : 0,
				reason: typeof parsed.reason === "string" ? parsed.reason : ""
			},
			error: null
		};
	} catch (error) {
		return { doc: null, error: `state.json is corrupt (${String(error?.message ?? error)})` };
	}
}

/**
 * Durable atomic write of the lifecycle marker. Best effort: failures are
 * swallowed (the marker is advisory — a crash right after a failed clean
 * write just re-flags on the next boot, which is the SAFE direction).
 * @param {string} dir - hardware-guard storage directory
 * @param {object} fields - {clean, reason?} plus stamping done here
 */
export function writeLifecycleState(dir, fields = {}) {
	if (typeof dir !== "string" || dir.length === 0) return false;
	const now = Date.now();
	const doc = {
		schemaVersion: LIFECYCLE_SCHEMA_VERSION,
		clean: fields.clean === true,
		bootedAt: Number.isFinite(fields.bootedAt) ? fields.bootedAt : 0,
		exitedAt: fields.clean === true ? now : 0,
		heartbeatAt: fields.clean === true ? 0 : now,
		pid: process.pid,
		reason: typeof fields.reason === "string" ? fields.reason : ""
	};
	try {
		writeFileDurable(join(dir, LIFECYCLE_FILE_NAME), JSON.stringify(doc, null, 2));
		return true;
	} catch {
		return false;
	}
}

/** Clean-exit marker (SIGTERM/SIGINT/fiber dispose). */
export function markLifecycleClean(dir, reason = "shutdown") {
	return writeLifecycleState(dir, { clean: true, reason });
}

/** Dirty marker: written at boot and refreshed by every heartbeat. */
export function markLifecycleDirty(dir, fields = {}) {
	return writeLifecycleState(dir, { clean: false, ...fields });
}

/** Historical evidence that the last exit may have been a hard kill. */
export function hadHistoricalKillOrCritical(incidents) {
	return (incidents ?? []).some((entry) =>
		entry?.kind === "auto-kill"
		|| (entry?.kind === "pressure-transition" && entry.state === "critical")
	);
}

/**
 * The unclean-boot check, run BEFORE the boot marker write: did the previous
 * process exit cleanly? No clean marker (missing/corrupt/unclean file) PLUS
 * historical critical/auto-kill evidence → unclean. A truly fresh machine
 * (no state file AND no incident history) is not flagged.
 *
 * @param {object} input
 * @param {string} input.dir - hardware-guard storage directory
 * @param {Array} input.incidents - loaded incident ring (pre-boot)
 * @returns {{unclean: boolean, reason: string|null}}
 */
export function checkUncleanBoot({ dir, incidents }) {
	const { doc, error } = loadLifecycleState(dir);
	if (doc === null) {
		if (!hadHistoricalKillOrCritical(incidents)) {
			return { unclean: false, reason: null };
		}
		return {
			unclean: true,
			reason: error ?? "no lifecycle state file from the previous run"
		};
	}
	if (doc.clean === true) return { unclean: false, reason: null };
	if (!hadHistoricalKillOrCritical(incidents)) return { unclean: false, reason: null };
	return { unclean: true, reason: "previous run did not write a clean-exit marker" };
}
