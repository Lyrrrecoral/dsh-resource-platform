/**
 * systemd interaction for resource-allocation, split into two planes:
 *
 * 1. OBSERVE plane (v0.1 contract, unchanged): the ONLY systemctl invocation
 *    adoption ever makes is a read-only property query
 *    `systemctl show --no-pager --property=... <unit>`. There is no code path
 *    in the observe plane that start/stop/restarts/disables/masks/kills
 *    anything (ops-generalization §4: registration and display, no mutation).
 *
 * 2. MANAGED-RUN plane (v0.2): resource_run launches long tasks as systemd
 *    transient units via `systemd-run --collect`, and resource_stop stops them via
 *    `systemctl stop`. These mutations are ONLY ever applied to units the
 *    package itself created (`resource-allocation-<project>-<runId>.service`); adopted
 *    project units stay strictly observe-only. The managed plane reads run
 *    facts (`ExecMainStatus` etc.), collects exit codes from the journal
 *    after `--collect` unloads the unit, and never targets any other unit.
 *
 * @module resource-allocation/systemd
 */
import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * systemd's runtime marker directory. Its absence means the host is not
 * systemd-managed (plain container, macOS, WSL without systemd, ...) — in
 * that case the managed-run plane CANNOT work, and every entry point says so
 * explicitly instead of failing with a cryptic ENOENT/`systemd-run: not
 * found`. Observation degrades the same way (units cannot be queried).
 */
export const SYSTEMD_RUNTIME_DIR = "/run/systemd/system";

/**
 * Whether this host runs systemd. Injectable `exists` keeps the degradation
 * paths testable without a container.
 */
export function systemdAvailable({ exists = existsSync } = {}) {
	return exists(SYSTEMD_RUNTIME_DIR) === true;
}

/** The one honest answer for "this host has no systemd". */
export function systemdUnsupported(operation, unit = null) {
	return {
		ok: false,
		code: "unsupported",
		unit,
		error: `systemd is not available on this host (${SYSTEMD_RUNTIME_DIR} is missing); ${operation} requires systemd transient units. Use a plain shell/background job instead, or run this on a systemd host.`
	};
}

/** Properties queried for every adopted unit (display + ownership facts). */
export const UNIT_PROPERTIES = Object.freeze([
	"Id",
	"LoadState",
	"ActiveState",
	"SubState",
	"MainPID",
	"UnitFileState",
	"ControlGroup"
]);

/** systemd verbs that must never appear in an OBSERVE-plane invocation
 * (adoption and observation stay read-only forever). The managed-run plane
 * below is the only place resource-allocation mutates systemd, and it only ever touches
 * units the package itself created. */
const FORBIDDEN_VERBS = Object.freeze([
	"start",
	"stop",
	"restart",
	"reload",
	"enable",
	"disable",
	"mask",
	"unmask",
	"kill",
	"freeze",
	"thaw",
	"set-property",
	"edit",
	"daemon-reload",
	"isolate"
]);

/**
 * Build the read-only query for one unit. Exposed for tests so the
 * read-only contract is asserted directly on the invocation.
 */
export function buildUnitQuery(unit) {
	return {
		binary: "systemctl",
		args: ["show", "--no-pager", `--property=${UNIT_PROPERTIES.join(",")}`, unit]
	};
}

/** Parse `systemctl show --property=...` output into a facts object. */
export function parseUnitShow(text) {
	if (typeof text !== "string") return {};
	const facts = {};
	for (const line of text.split("\n")) {
		const index = line.indexOf("=");
		if (index < 1) continue;
		const key = line.slice(0, index).trim();
		const value = line.slice(index + 1).trim();
		if (key.length === 0 || value.length === 0) continue;
		facts[key] = value;
	}
	return facts;
}

/** Normalized facts projection used by the observer and renderer. */
export function normalizeUnitFacts(raw) {
	const mainPid = Number(raw.MainPID);
	return {
		id: raw.Id ?? null,
		loadState: raw.LoadState ?? "unknown",
		activeState: raw.ActiveState ?? "unknown",
		subState: raw.SubState ?? "unknown",
		mainPid: Number.isInteger(mainPid) && mainPid > 0 ? mainPid : null,
		unitFileState: raw.UnitFileState ?? "unknown",
		controlGroup: typeof raw.ControlGroup === "string" && raw.ControlGroup.length > 0 ? raw.ControlGroup : null
	};
}

/**
 * Query one unit's facts through an injectable runner.
 * @param {string} unit - unit name, e.g. "demo-runner.service"
 * @param {object} [options] - {runner = execFileSync, timeoutMs = 3000}
 * @returns {{ok: true, unit, facts} | {ok: false, unit, error}}
 */
export function queryUnit(unit, { runner = execFileSync, timeoutMs = 3000, exists } = {}) {
	if (!systemdAvailable(exists === undefined ? {} : { exists })) return systemdUnsupported("querying unit facts", unit);
	const query = buildUnitQuery(unit);
	try {
		const text = runner(query.binary, query.args, { timeout: timeoutMs, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		const facts = normalizeUnitFacts(parseUnitShow(text));
		if (facts.id === null || facts.loadState === "unknown" && facts.activeState === "unknown" && facts.subState === "unknown") {
			return { ok: false, unit, error: `unit ${unit} not found or no properties returned` };
		}
		return { ok: true, unit, facts };
	} catch (error) {
		return { ok: false, unit, error: String(error?.message ?? error) };
	}
}

/**
 * Assert that a query is read-only: no forbidden systemd verb may appear
 * anywhere in the args. Test guard + self-documentation of the v0.1
 * observe-only contract.
 */
export function assertReadOnlyQuery({ args }) {
	const joined = args.join(" ");
	return FORBIDDEN_VERBS.every((verb) => !joined.includes(verb));
}

// ──────────────────────────────────────────────────────────────────────────
// MANAGED-RUN plane (v0.2): facts / launch / stop / journal for transient
// units created by resource_run itself. Nothing here ever targets an adopted unit.
// ──────────────────────────────────────────────────────────────────────────

/** Properties queried for resource_run transient units (lifecycle + exit facts). */
export const RUN_UNIT_PROPERTIES = Object.freeze([
	"LoadState",
	"ActiveState",
	"SubState",
	"MainPID",
	"ExecMainStatus",
	"ExecMainCode",
	"Result",
	"ControlGroup"
]);

/** The cgroup path of the live web service; run processes must never live here. */
export const DSH_WEB_CGROUP = "/system.slice/dsh-web.service";

/** Build the run-facts query for one transient unit (read-only show). */
export function buildRunUnitQuery(unit) {
	return {
		binary: "systemctl",
		args: ["show", "--no-pager", `--property=${RUN_UNIT_PROPERTIES.join(",")}`, unit]
	};
}

/**
 * Normalize run-unit facts. `execMainStatus` is only meaningful while the
 * unit exists (`loadState === "loaded"`): with `--collect` the unit unloads
 * after completion and `systemctl show` keeps returning stale defaults
 * (`ExecMainStatus=0`, `Result=success`) for a never-loaded unit — callers
 * must check `exists` before trusting exit facts.
 */
export function normalizeRunUnitFacts(raw) {
	const mainPid = Number(raw.MainPID);
	const execMainStatus = Number(raw.ExecMainStatus);
	const execMainCode = Number(raw.ExecMainCode);
	return {
		exists: raw.LoadState === "loaded",
		loadState: raw.LoadState ?? "unknown",
		activeState: raw.ActiveState ?? "unknown",
		subState: raw.SubState ?? "unknown",
		mainPid: Number.isInteger(mainPid) && mainPid > 0 ? mainPid : null,
		execMainStatus: Number.isInteger(execMainStatus) ? execMainStatus : null,
		execMainCode: Number.isInteger(execMainCode) ? execMainCode : null,
		result: raw.Result ?? "unknown",
		controlGroup: typeof raw.ControlGroup === "string" && raw.ControlGroup.length > 0 ? raw.ControlGroup : null
	};
}

/**
 * Query one run unit's facts.
 * @returns {{ok: true, unit, facts} | {ok: false, unit, error, vanished?: boolean}}
 */
export function queryRunUnit(unit, { runner = execFileSync, timeoutMs = 3000 } = {}) {
	const query = buildRunUnitQuery(unit);
	try {
		const text = runner(query.binary, query.args, { timeout: timeoutMs, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		const facts = normalizeRunUnitFacts(parseUnitShow(text));
		return { ok: true, unit, facts };
	} catch (error) {
		return { ok: false, unit, error: String(error?.message ?? error) };
	}
}

/**
 * Build the `systemd-run` invocation that starts one long task as a
 * collectable transient unit. The command runs as argv (no shell), under
 * `system.slice` — a `dsh-web.service` restart can never take it down.
 *
 * The caller supplies command parts validated by buildSystemdRunArgs; the
 * invocation is exposed so tests assert the exact unit construction.
 */
export function buildSystemdRun({ projectId, runId, limits, workingDirectory = null, env = {}, nice = 10, command }) {
	const unit = runUnitNameSafe(projectId, runId);
	const args = [
		"--collect",
		`--unit=${unit}`,
		`--property=MemoryMax=${limits.memoryMaxBytes}`,
		`--property=CPUQuota=${Math.round(limits.cpuMaxCores * 100)}%`,
		`--property=TasksMax=${limits.tasksMax}`,
		`--nice=${nice}`
	];
	if (Number.isInteger(limits.memoryHighBytes) && limits.memoryHighBytes >= 1) {
		args.push(`--property=MemoryHigh=${limits.memoryHighBytes}`);
	}
	if (workingDirectory !== null) {
		args.push(`--property=WorkingDirectory=${workingDirectory}`);
	}
	for (const [key, value] of Object.entries(env ?? {})) {
		args.push(`--setenv=${key}=${value}`);
	}
	// systemd-run's first non-option argument IS the executable (no `--`
	// separator in systemd 249); argv is passed through untouched, so no
	// shell ever interprets the command.
	args.push(...command);
	return { binary: "systemd-run", args, unit };
}

/** The canonical transient unit name for a run (launch plane). */
export function runUnitNameSafe(projectId, runId) {
	const unit = `resource-allocation-${projectId}-${runId}.service`;
	if (!/^[a-z0-9][a-z0-9-._]*\.service$/.test(unit) || unit.length > 255) {
		throw new Error(`invalid run unit name: ${unit}`);
	}
	return unit;
}

/**
 * Execute one built systemd-run invocation (async).
 * @returns {Promise<{ok: true, unit, output, stderr} | {ok: false, unit, error}>}
 */
export function launchSystemdRun(invocation, { exec = execFile, timeoutMs = 30000, exists } = {}) {
	if (!systemdAvailable(exists === undefined ? {} : { exists })) {
		return Promise.resolve(systemdUnsupported("launching a long task", invocation.unit));
	}
	return new Promise((resolve) => {
		exec(invocation.binary, invocation.args, { timeout: timeoutMs, encoding: "utf8", maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
			if (error !== null) {
				resolve({ ok: false, unit: invocation.unit, error: String(error?.message ?? error), stderr: String(stderr ?? "") });
				return;
			}
			resolve({ ok: true, unit: invocation.unit, output: String(stdout ?? ""), stderr: String(stderr ?? "") });
		});
	});
}

/**
 * Stop one resource_run transient unit (`systemctl stop`). The managed-run plane's
 * only unit mutation; it is gated by owner permission before it is ever
 * called, and it never targets an adopted project unit.
 * @returns {Promise<{ok: true, unit} | {ok: false, unit, error}>}
 */
export function stopRunUnit(unit, { exec = execFile, timeoutMs = 60000, exists } = {}) {
	if (!systemdAvailable(exists === undefined ? {} : { exists })) {
		return Promise.resolve(systemdUnsupported("stopping a run unit", unit));
	}
	return new Promise((resolve) => {
		exec("systemctl", ["stop", unit], { timeout: timeoutMs, encoding: "utf8", maxBuffer: 1 << 20 }, (error) => {
			if (error !== null) {
				resolve({ ok: false, unit, error: String(error?.message ?? error) });
				return;
			}
			resolve({ ok: true, unit });
		});
	});
}

/** Build the journal query for one run unit (exit evidence after --collect). */
export function buildJournalQuery(unit) {
	return {
		binary: "journalctl",
		args: ["--unit", unit, "--no-pager", "-o", "cat", "-n", "50"]
	};
}

/**
 * Parse journalctl output for the exit evidence of one collected unit:
 *  - "Main process exited, code=exited, status=7/NOTRUNNING" → exitCode 7
 *  - "Main process exited, code=killed, status=15/TERM"        → signal 15
 *  - "Failed with result 'exit-code'."                         → failure marker
 *  - "Succeeded." / "Deactivated successfully."                → clean exit 0
 *  - ": Stopped "                                              → external stop
 */
export function parseRunJournal(text) {
	const result = {
		exited: false,
		exitCode: null,
		signal: null,
		failed: false,
		succeeded: false,
		stopped: false
	};
	if (typeof text !== "string") return result;
	for (const line of text.split("\n")) {
		const exited = line.match(/Main process exited, code=exited, status=(\d+)/);
		if (exited !== null) {
			result.exited = true;
			result.exitCode = Number(exited[1]);
			result.signal = null;
			continue;
		}
		const killed = line.match(/Main process exited, code=killed, status=(\d+)/);
		if (killed !== null) {
			result.exited = true;
			result.exitCode = null;
			result.signal = Number(killed[1]);
			continue;
		}
		if (/Failed with result/.test(line)) result.failed = true;
		if (/Succeeded\./.test(line)) result.succeeded = true;
		if (/Deactivated successfully\./.test(line)) result.succeeded = true;
		if (/: Stopped /.test(line)) result.stopped = true;
	}
	return result;
}

/**
 * Read the exit evidence for one run unit from the journal.
 * @returns {Promise<{ok: true, unit, evidence} | {ok: false, unit, error}>}
 */
export function readRunJournal(unit, { exec = execFile, timeoutMs = 5000 } = {}) {
	const query = buildJournalQuery(unit);
	return new Promise((resolve) => {
		exec(query.binary, query.args, { timeout: timeoutMs, encoding: "utf8", maxBuffer: 1 << 20 }, (error, stdout) => {
			if (error !== null) {
				resolve({ ok: false, unit, error: String(error?.message ?? error) });
				return;
			}
			resolve({ ok: true, unit, evidence: parseRunJournal(String(stdout ?? "")) });
		});
	});
}
