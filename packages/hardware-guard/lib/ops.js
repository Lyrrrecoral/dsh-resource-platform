/**
 * Canonical hardware-guard API row for the DSH web UI.
 *
 * Mount as its own row (`hardware-guard/api`) in a web profile:
 *  - `GET  /resources/hardware.json` — read-only snapshot (control,
 *    enforcement, budget/pressure, adaptations, recent incidents,
 *    memoryCapPolicy, memoryRunawayBytes, disks and cleanup probe state).
 *    Works even while the guard is DISABLED — it is the way back in.
 *  - `POST /resources/hardware` — `{ action: "enable"|"disable"|
 *    "confirm-adapt"|"cleanup-scan"|"cleanup-confirm", reason?,
 *    adaptationId?, option?, planId?, paths?, overrides? }`. Runs the SAME
 *    un-gated core as the `hardware_guard` tool (guard-actions.js): atomic
 *    durable writes, incident records, CAS conflicts → 409. The user already
 *    clicked the confirm dialog, so no approval service is consulted;
 *    updatedBy is "web-ui".
 *
 * Write hardening: every POST requires the explicit `x-resource-action: 1`
 * header sent by the UI; when a browser supplies `Origin`, it must match the
 * request `Host`. Missing proof fails closed with 403 before the body is read.
 * This blocks classic cross-site form POSTs while keeping first-party fetch
 * clients straightforward.
 *
 * Legacy aliases remain for one release: `GET /ops/guard.json` and
 * `POST /ops/guard` return the same payload/handlers with a `Deprecation`
 * header and a `Link` to the canonical resource. They will be removed in v2.
 *
 * @module hardware-guard/api
 */
import { performConfirmAdapt, performDisableGuard, performEnableGuard } from "./guard-actions.js";
import { cleanupTrashEmpty, cleanupTrashSummary, performCleanupConfirm, performCleanupScan, trashRoot } from "./cleanup-actions.js";
import { DEFAULT_EXCLUDE_DIRS } from "./probe.js";
import { DEFAULTS, shared } from "./state.js";

export const name = "hardware-guard-api";
export const inject = ["webServer"];

export const CANONICAL_SNAPSHOT_PATH = "/resources/hardware.json";
export const CANONICAL_ACTION_PATH = "/resources/hardware";
export const LEGACY_SNAPSHOT_PATH = "/ops/guard.json";
export const LEGACY_ACTION_PATH = "/ops/guard";
export const WRITE_ACTION_HEADER = "x-resource-action";
export const WRITE_ACTION_HEADER_VALUE = "1";

function requestHeader(req, name) {
	const headers = req?.headers;
	if (headers === null || headers === undefined) return "";
	if (typeof headers.get === "function") {
		const value = headers.get(name);
		return typeof value === "string" ? value : "";
	}
	const lowerName = name.toLowerCase();
	let value = headers[lowerName] ?? headers[name];
	if (value === undefined) {
		for (const [key, candidate] of Object.entries(headers)) {
			if (key.toLowerCase() === lowerName) {
				value = candidate;
				break;
			}
		}
	}
	if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : "";
	return typeof value === "string" ? value : "";
}

/**
 * Whether a write request proves first-party intent. Both accepted forms are
 * explicit: the UI's custom action header, or an Origin that matches Host.
 * The check is deliberately fail-closed (missing/malformed headers → false).
 */
export function isTrustedWriteRequest(req) {
	// The custom header is mandatory for every write. It is not a secret; it
	// forces a CORS preflight for cross-origin JavaScript and cannot be sent by
	// a classic HTML form. When a browser supplies Origin, it must also match
	// the request Host; absent Origin is acceptable for non-browser first-party
	// clients that already sent the mandatory action header.
	if (requestHeader(req, WRITE_ACTION_HEADER) !== WRITE_ACTION_HEADER_VALUE) return false;
	const origin = requestHeader(req, "origin");
	if (origin.length === 0) return true;
	const host = requestHeader(req, "host");
	if (host.length === 0) return false;
	try {
		const parsed = new URL(origin);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
		return parsed.host.toLowerCase() === host.toLowerCase();
	} catch {
		return false;
	}
}

function markLegacyRoute(res, canonicalPath) {
	res.setHeader("Deprecation", "true");
	res.setHeader("Link", `<${canonicalPath}>; rel="successor-version"`);
	res.setHeader("Warning", `299 - "Deprecated route; use ${canonicalPath}"`);
}

function send(res, status, body, type = "text/plain; charset=utf-8") {
res.statusCode = status;
res.setHeader("Content-Type", type);
res.setHeader("Cache-Control", "no-store");
res.end(body);
}

function sendJson(res, status, payload) {
return send(res, status, JSON.stringify(payload, null, 2), "application/json; charset=utf-8");
}

// ── v0.3.2 guard control surface ──────────────────────────────────────────

/** The control switch as seen by the tool/UI (missing file = enabled default). */
function controlSnapshot() {
	return shared.control ?? {
		schemaVersion: 1,
		enabled: true,
		revision: 0,
		reason: "",
		updatedBy: "",
		updatedAt: 0,
		error: null
	};
}

/** The adaptation document's pending/applied halves (JSON-safe arrays). */
function adaptationsSnapshot() {
	return {
		applied: shared.adaptations?.applied ?? [],
		pending: shared.adaptations?.pending ?? [],
		watchlist: shared.adaptations?.watchlist ?? []
	};
}

/**
 * Read-only guard snapshot for `GET /resources/hardware.json`. Pure reads over
 * `shared` — callable even while the control switch is DISABLED and even
 * when the main guard row never mounted (fields degrade to null/unknown).
 */
export function buildGuardSnapshot() {
	const host = shared.host;
	const profile = host?.profile ?? null;
	const control = controlSnapshot();
	const enforcementActive = profile?.enforcementActive === true;
	const enforcement = control.enabled === false
		? "disabled"
		: profile === null
			? "unknown"
			: enforcementActive
				? "active"
				: "dry-run";
	const vitals = shared.vitals ?? { memAvailableBytes: null, load1: null };
	return {
		at: Date.now(),
		control,
		enforcement,
		enforcementActive: profile === null ? null : enforcementActive,
		budget: profile === null ? null : {
			cpuCount: profile.cpuCount ?? null,
			cpuBudgetCores: profile.cpuBudgetCores ?? null,
			cpuReservedCores: profile.cpuReservedCores ?? null,
			memBudgetBytes: profile.memBudgetBytes ?? null,
			perCommandMemCapBytes: profile.perCommandMemCapBytes ?? null,
			memoryRunawayBytes: profile.memoryRunawayBytes ?? null,
			maxBackgroundJobs: profile.maxBackgroundJobs ?? null,
			niceLevel: profile.niceLevel ?? null
		},
		pressure: {
			state: shared.pressureState ?? "ok",
			freeBytes: vitals.memAvailableBytes,
			load1: vitals.load1,
			warnLoad: profile?.warnLoad ?? null,
			critLoad: profile?.critLoad ?? null,
			warnMemBytes: profile?.warnMemBytes ?? null,
			critMemBytes: profile?.critMemBytes ?? null,
			hysteresis: profile?.hysteresis ?? null
		},
		/**
		 * v0.4.0 disk axis: one entry per sampled path with raw bytes +
		 * per-path thresholds. Empty array when no disk facts (or the main
		 * row never mounted) — the client renders it as "no data".
		 */
		disks: (vitals.disks ?? []).map((disk) => ({
			path: disk.path,
			filesystem: disk.filesystem ?? null,
			totalBytes: disk.totalBytes ?? null,
			availBytes: disk.availBytes ?? null,
			usePct: disk.usePct ?? null,
			warnAvailBytes: disk.warnAvailBytes ?? null,
			critAvailBytes: disk.critAvailBytes ?? null,
			warnUsePct: disk.warnUsePct ?? null,
			critUsePct: disk.critUsePct ?? null,
			at: disk.at ?? null
		})),
		cleanup: {
			enabled: shared.config?.cleanupProbe?.enabled === true,
			roots: Array.isArray(shared.config?.cleanupProbe?.roots) ? shared.config.cleanupProbe.roots : [],
			minSizeBytes: shared.config?.cleanupProbe?.minSizeBytes ?? null,
			softDelete: shared.config?.cleanupProbe?.softDelete !== false,
			trashRetentionDays: shared.config?.cleanupProbe?.trashRetentionDays ?? DEFAULTS.cleanupProbe.trashRetentionDays,
			excludeDirs: Array.isArray(shared.config?.cleanupProbe?.excludeDirs)
				? shared.config.cleanupProbe.excludeDirs
				: DEFAULT_EXCLUDE_DIRS,
			trashDir: shared.storageDir === null || shared.storageDir === undefined ? null : trashRoot(),
			lastPlan: shared.cleanupLastPlan === null || shared.cleanupLastPlan === undefined
				? null
				: {
					id: shared.cleanupLastPlan.id,
					generatedAt: shared.cleanupLastPlan.generatedAt,
					roots: shared.cleanupLastPlan.roots,
					candidates: shared.cleanupLastPlan.candidates,
					totalBytes: shared.cleanupLastPlan.totalBytes,
					scannedFiles: shared.cleanupLastPlan.scannedFiles,
					skippedDirs: shared.cleanupLastPlan.skippedDirs ?? 0,
					truncated: shared.cleanupLastPlan.truncated,
					softDelete: shared.cleanupLastPlan.softDelete !== false,
					mode: shared.cleanupLastPlan.mode ?? null,
					deleted: shared.cleanupLastPlan.deleted ?? null,
					status: shared.cleanupLastPlan.status,
					errors: shared.cleanupLastPlan.errors
				}
		},
		memoryCapPolicy: shared.config?.memoryCapPolicy ?? "none",
		adaptations: adaptationsSnapshot(),
		incidents: (shared.incidents ?? []).slice(0, 10)
	};
}

/** Read a JSON request body with a hard size cap; rejects on any failure. */
function readJsonBody(req, maxBytes = 65536) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
			size += piece.length;
			if (size > maxBytes) {
				reject(new Error("request body too large"));
				req.destroy();
				return;
			}
			chunks.push(piece);
		});
		req.on("end", () => {
			const text = Buffer.concat(chunks).toString("utf8");
			try {
				resolve(text.trim() === "" ? {} : JSON.parse(text));
			} catch (error) {
				reject(new Error(`invalid JSON body (${String(error?.message ?? error)})`));
			}
		});
		req.on("error", reject);
	});
}

/**
 * Handle the canonical/legacy guard POST. The user already clicked the confirm dialog in
 * the web UI — that click IS the human operation, so the approval service is
 * deliberately not consulted. updatedBy is fixed to "web-ui".
 */
async function handleGuardPost(req, res, actions) {
	let parsed;
	try {
		parsed = await readJsonBody(req);
	} catch (error) {
		return sendJson(res, 400, { ok: false, error: String(error?.message ?? error), control: controlSnapshot(), adaptations: adaptationsSnapshot() });
	}
	const action = parsed?.action;
	if (action === "enable" || action === "disable") {
		const reason = typeof parsed.reason === "string" ? parsed.reason : "";
		const result = action === "enable"
			? actions.enable({ reason, updatedBy: "web-ui" })
			: actions.disable({ reason, updatedBy: "web-ui" });
		if (!result.ok) {
			const status = result.conflict === true ? 409 : 500;
			return sendJson(res, status, { ok: false, error: result.error ?? "guard action failed", control: controlSnapshot(), adaptations: adaptationsSnapshot() });
		}
		return sendJson(res, 200, { ok: true, text: result.text, control: controlSnapshot(), adaptations: adaptationsSnapshot() });
	}
	if (action === "cleanup-scan") {
		try {
			const overrides = {};
			if (Array.isArray(parsed.roots) && parsed.roots.length > 0) overrides.roots = parsed.roots;
			const result = await actions.cleanupScan(overrides);
			const status = result.ok ? 200 : 400;
			return sendJson(res, status, result);
		} catch (error) {
			return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
		}
	}
	if (action === "cleanup-confirm") {
		try {
			const mode = parsed.mode === "trash" || parsed.mode === "permanent" ? parsed.mode : null;
			const result = await actions.cleanupConfirm({
				planId: typeof parsed.planId === "string" ? parsed.planId : "",
				paths: Array.isArray(parsed.paths) ? parsed.paths : [],
				mode
			});
			const status = result.ok ? 200 : 400;
			return sendJson(res, status, result);
		} catch (error) {
			return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
		}
	}
	if (action === "cleanup-trash") {
		try {
			const mode = parsed.mode === "empty" ? "empty" : "summary";
			const result = mode === "empty" ? actions.cleanupTrashEmpty() : actions.cleanupTrashSummary();
			return sendJson(res, result.ok ? 200 : 400, result);
		} catch (error) {
			return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
		}
	}
	if (action === "confirm-adapt") {
		const adaptationId = typeof parsed.adaptationId === "string" && parsed.adaptationId.length > 0 ? parsed.adaptationId : null;
		// Option C ("defer") = 暂不改动: acknowledge the pending proposal and
		// remove it WITHOUT touching the configuration. The proposing rule
		// keeps its normal cooldown, so it can re-propose later on its own.
		const option = parsed.option === "alternative" || parsed.option === "defer" ? parsed.option : "primary";
		const result = actions.confirmAdapt({ id: adaptationId, option });
		if (!result.ok) {
			return sendJson(res, 500, { ok: false, error: result.error ?? "confirm-adapt failed", control: controlSnapshot(), adaptations: adaptationsSnapshot() });
		}
		return sendJson(res, 200, { ok: true, text: result.text, control: controlSnapshot(), adaptations: adaptationsSnapshot() });
	}
	return sendJson(res, 400, { ok: false, error: `unknown action ${JSON.stringify(action)}; expected enable | disable | confirm-adapt | cleanup-scan | cleanup-confirm | cleanup-trash`, control: controlSnapshot(), adaptations: adaptationsSnapshot() });
}

const REAL_GUARD_ACTIONS = Object.freeze({
	enable: (input) => performEnableGuard(input),
	disable: (input) => performDisableGuard(input),
	confirmAdapt: (input) => performConfirmAdapt(input),
	cleanupScan: (input) => performCleanupScan(input),
	cleanupConfirm: (input) => performCleanupConfirm(input),
	cleanupTrashSummary: (input) => cleanupTrashSummary(input),
	cleanupTrashEmpty: (input) => cleanupTrashEmpty(input)
});

/**
 * The exact request handler the row registers. Kept as a free function so
 * tests exercise the boot-registered code path without a live web server.
 * `guardActions` is injectable (CAS-conflict tests stub it).
 */
export function createOpsHandler({ guardActions = REAL_GUARD_ACTIONS } = {}) {
	return async function handler(req, res) {
		try {
			const url = new URL(req.url ?? "/", "http://dsh.internal");
			const method = (req.method ?? "GET").toUpperCase();
			if (url.pathname === CANONICAL_SNAPSHOT_PATH) {
				if (method !== "GET") return sendJson(res, 405, { ok: false, error: "GET only" });
				return sendJson(res, 200, buildGuardSnapshot());
			}
			if (url.pathname === CANONICAL_ACTION_PATH) {
				if (method !== "POST") return sendJson(res, 405, { ok: false, error: "POST only" });
				if (!isTrustedWriteRequest(req)) {
					return sendJson(res, 403, { ok: false, error: "write action requires x-resource-action: 1 and same-origin Origin when supplied" });
				}
				return handleGuardPost(req, res, guardActions);
			}
			if (url.pathname === LEGACY_SNAPSHOT_PATH) {
				markLegacyRoute(res, CANONICAL_SNAPSHOT_PATH);
				if (method !== "GET") return sendJson(res, 405, { ok: false, error: "GET only" });
				return sendJson(res, 200, buildGuardSnapshot());
			}
			if (url.pathname === LEGACY_ACTION_PATH) {
				markLegacyRoute(res, CANONICAL_ACTION_PATH);
				if (method !== "POST") return sendJson(res, 405, { ok: false, error: "POST only" });
				if (!isTrustedWriteRequest(req)) {
					return sendJson(res, 403, { ok: false, error: "write action requires x-resource-action: 1 and same-origin Origin when supplied" });
				}
				return handleGuardPost(req, res, guardActions);
			}
			// /ops/processes* deliberately unclaimed since v0.5.2: dsh-ops/ops
			// serves the project registry projection (and /ops/processes as a
			// compatibility alias). Claiming it here again would duplicate the
			// page and shadow the registry view.
			return send(res, 404, "not found");
		} catch (error) {
			return send(res, 500, String(error?.message ?? error));
		}
	};
}

/**
 * Mount the four exact routes: two canonical resources plus the two legacy
 * aliases. `/ops/processes*` stays unclaimed — dsh-ops/ops owns the process
 * and project projection, and shadowing it would duplicate the registry view.
 * Config keys are accepted but ignored.
 */
export function apply(ctx, config = {}) {
	const handler = createOpsHandler();

	ctx.effect(() => {
		const disposers = [
			ctx.webServer.register({ kind: "exact", path: CANONICAL_SNAPSHOT_PATH, handler }),
			ctx.webServer.register({ kind: "exact", path: CANONICAL_ACTION_PATH, handler }),
			ctx.webServer.register({ kind: "exact", path: LEGACY_SNAPSHOT_PATH, handler }),
			ctx.webServer.register({ kind: "exact", path: LEGACY_ACTION_PATH, handler })
		];
		return () => {
			for (const dispose of disposers) dispose();
		};
	}, "hardware-guard-api: routes");
}
