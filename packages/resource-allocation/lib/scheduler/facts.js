/**
 * Fact-source readers for resource-allocation.
 *
 * The scheduler makes decisions from the OTHER packages' fact sources —
 * it never writes them:
 *
 *  - pressure state: the most recent `pressure-transition` record in
 *    `$DSH_HOME/storages/hardware-guard/incidents.jsonl` (hysteresis state is
 *    owned by hardware-guard; transitions are only written there). When no
 *    transition exists yet, fall back to a live /proc sample classified
 *    against the host-profile entry thresholds (no hysteresis — documented
 *    limitation).
 *  - hardware budget: `$DSH_HOME/storages/hardware-guard/host-profile.json`
 *    (`budget.cpuBudgetCores`, `budget.memBudgetBytes`).
 *  - projects/tasks/runs: `$DSH_HOME/storages/resource-allocation/projects.json` and
 *    `runs.json`. When resource-allocation provides its in-process `resourceAllocation` service
 *    (ctx.get("resourceAllocation")) the scheduler prefers it — same files, same facts —
 *    and falls back to reading the files directly. Neither package is
 *    modified for this integration.
 *
 * Every reader degrades to `{ok: false, error}` instead of throwing; the
 * planner treats missing/corrupt host facts as "no admissions" (fail-safe).
 *
 * @module resource-allocation/facts
 */
import { join } from "node:path";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import { tryRead } from "./atomic.js";

/** Parse /proc/meminfo into a {key: bytes} map. */
export function parseMeminfo(text) {
	if (typeof text !== "string" || text.length === 0) return {};
	const out = {};
	for (const line of text.split("\n")) {
		const match = /^([A-Za-z0-9_()]+):\s+(\d+)\s+kB$/.exec(line);
		if (match !== null) out[match[1]] = Number(match[2]) * 1024;
	}
	return out;
}

/** Parse /proc/loadavg into {load1, load5, load15}. */
export function parseLoadavg(text) {
	if (typeof text !== "string" || text.length === 0) return { load1: 0, load5: 0, load15: 0 };
	const parts = text.trim().split(/\s+/);
	return {
		load1: Number(parts[0]) || 0,
		load5: Number(parts[1]) || 0,
		load15: Number(parts[2]) || 0
	};
}

/** Live vitals sample (Linux /proc; zeroed elsewhere). */
export function sampleVitals() {
	const at = Date.now();
	let memAvailableBytes = 0;
	let load = { load1: 0, load5: 0, load15: 0 };
	try {
		if (process.platform === "linux") {
			const meminfo = parseMeminfo(tryRead("/proc/meminfo"));
			memAvailableBytes = meminfo.MemAvailable ?? 0;
			load = parseLoadavg(tryRead("/proc/loadavg"));
		}
	} catch {
		/* keep zeros; classification treats unknowns as OK */
	}
	return { at, memAvailableBytes, ...load };
}

/**
 * Read and lightly validate the hardware-guard host profile; extract only the
 * budget/threshold facts the scheduler needs. A missing or malformed file
 * fails the read (never guessed, never repaired).
 */
export function readHostProfile(dir) {
	const path = join(dir, "host-profile.json");
	const text = tryRead(path);
	if (text === null) return { ok: false, error: `host profile not found: ${path}` };
	let doc = null;
	try {
		doc = JSON.parse(text);
	} catch {
		return { ok: false, error: `host profile ${path} is not valid JSON` };
	}
	const errors = [];
	if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return { ok: false, error: `host profile ${path} is not an object` };
	if (doc.schemaVersion !== 1) errors.push(`schemaVersion must be 1 (got ${doc.schemaVersion})`);
	const budget = doc.budget ?? {};
	if (!(typeof budget.cpuBudgetCores === "number" && Number.isFinite(budget.cpuBudgetCores) && budget.cpuBudgetCores > 0)) errors.push("budget.cpuBudgetCores invalid");
	if (!(Number.isInteger(budget.memBudgetBytes) && budget.memBudgetBytes >= 1)) errors.push("budget.memBudgetBytes invalid");
	if (!(Number.isInteger(budget.maxBackgroundJobs) && budget.maxBackgroundJobs >= 1)) errors.push("budget.maxBackgroundJobs invalid");
	const hardware = doc.hardware ?? {};
	const memTotalBytes = Number.isInteger(hardware.memTotalBytes) ? hardware.memTotalBytes : null;
	const cgroupMemMax = Number.isInteger(hardware.cgroup?.memMaxBytes) ? hardware.cgroup.memMaxBytes : null;
	const effectiveMemBytes = memTotalBytes === null && cgroupMemMax === null ? null
		: Math.min(memTotalBytes ?? Number.POSITIVE_INFINITY, cgroupMemMax ?? Number.POSITIVE_INFINITY);
	const pressure = doc.pressure ?? {};
	const warnLoad = typeof pressure.warnLoad === "number" ? pressure.warnLoad : null;
	const critLoad = typeof pressure.critLoad === "number" ? pressure.critLoad : null;
	const warnMemBytes = typeof pressure.warnMemFrac === "number" && effectiveMemBytes !== null
		? Math.round(effectiveMemBytes * pressure.warnMemFrac)
		: null;
	const critMemBytes = typeof pressure.critMemFrac === "number" && effectiveMemBytes !== null
		? Math.round(effectiveMemBytes * pressure.critMemFrac)
		: null;
	if (errors.length > 0) return { ok: false, error: `host profile ${path} invalid: ${errors.join("; ")}` };
	return {
		ok: true,
		path,
		profile: {
			cpuBudgetCores: budget.cpuBudgetCores,
			memBudgetBytes: budget.memBudgetBytes,
			maxBackgroundJobs: budget.maxBackgroundJobs,
			effectiveMemBytes,
			warnLoad,
			critLoad,
			warnMemBytes,
			critMemBytes
		}
	};
}

/** Classify one vitals sample against entry thresholds (fallback only). */
export function classifyByThresholds(vitals, profile) {
	const freeBytes = vitals.memAvailableBytes ?? 0;
	const load1 = vitals.load1 ?? 0;
	const reasons = [];
	if (profile.critLoad !== null && load1 >= profile.critLoad) reasons.push(`load1 ${load1.toFixed(2)} >= critical ${profile.critLoad}`);
	if (profile.critMemBytes !== null && freeBytes < profile.critMemBytes) reasons.push(`free memory ${freeBytes} < critical ${profile.critMemBytes}`);
	if (reasons.length > 0) return { state: "critical", reasons };
	if (profile.warnLoad !== null && load1 >= profile.warnLoad) reasons.push(`load1 ${load1.toFixed(2)} >= warn ${profile.warnLoad}`);
	if (profile.warnMemBytes !== null && freeBytes < profile.warnMemBytes) reasons.push(`free memory ${freeBytes} < warn ${profile.warnMemBytes}`);
	if (reasons.length > 0) return { state: "warn", reasons };
	return { state: "ok", reasons: [] };
}

/**
 * Read the current hysteresis-stabilized pressure state from the hardware-guard
 * incident log: the LAST `pressure-transition` record wins (the file is
 * chronological). Falls back to a live threshold classification when no
 * transition exists or the host profile is unreadable.
 *
 * @returns {{ok: boolean, state: "ok"|"warn"|"critical", at: number|null,
 *   source: "incidents"|"live", reasons: string[], error?: string}}
 */
export function readPressureState(dir, { hostProfile = null, vitals = null } = {}) {
	const path = join(dir, "incidents.jsonl");
	const text = tryRead(path);
	let last = null;
	if (text !== null) {
		for (const line of text.split("\n")) {
			if (line.trim().length === 0) continue;
			try {
				const entry = JSON.parse(line);
				if (entry?.kind === "pressure-transition" && (entry.state === "ok" || entry.state === "warn" || entry.state === "critical")) {
					last = entry;
				}
			} catch {
				/* skip corrupt lines */
			}
		}
	}
	if (last !== null) {
		return {
			ok: true,
			state: last.state,
			at: Number.isInteger(last.atMs) ? last.atMs : Date.parse(last.at) || null,
			source: "incidents",
			reasons: Array.isArray(last.reasons) ? last.reasons : []
		};
	}
	const sample = vitals ?? sampleVitals();
	const profileRead = hostProfile?.ok === true ? hostProfile : readHostProfile(dir);
	const profile = profileRead.ok === true ? profileRead.profile : null;
	const classification = profile === null
		? { state: "ok", reasons: [] }
		: classifyByThresholds(sample, profile);
	return {
		ok: true,
		state: classification.state,
		at: sample.at,
		source: "live",
		reasons: classification.reasons
	};
}

/** Read projects.json entries (or reuse the resource-allocation `resourceAllocation` service). */
export function readProjects(dir, { ops = null, resourceService = null } = {}) {
	const service = resourceService ?? ops;
	if (service !== null && typeof service.registry?.list === "function") {
		try {
			const entries = service.registry.list();
			return { ok: true, source: "service", entries };
		} catch (error) {
			/* fall through to the file */
		}
	}
	const path = join(dir, "projects.json");
	const text = tryRead(path);
	if (text === null) return { ok: false, error: `projects registry not found: ${path}`, entries: [] };
	let doc = null;
	try {
		doc = JSON.parse(text);
	} catch {
		return { ok: false, error: `projects registry ${path} is not valid JSON`, entries: [] };
	}
	if (typeof doc !== "object" || doc === null || !Array.isArray(doc.projects)) {
		return { ok: false, error: `projects registry ${path} has no projects array`, entries: [] };
	}
	return { ok: true, source: "file", entries: doc.projects };
}

/** Read runs.json records (or reuse the resource-allocation `resourceAllocation` service). */
export function readRuns(dir, { ops = null, resourceService = null } = {}) {
	const service = resourceService ?? ops;
	if (service !== null && typeof service.runs?.list === "function") {
		try {
			const runs = service.runs.list();
			return { ok: true, source: "service", runs };
		} catch {
			/* fall through to the file */
		}
	}
	const path = join(dir, "runs.json");
	const text = tryRead(path);
	if (text === null) return { ok: false, error: `runs registry not found: ${path}`, runs: [] };
	let doc = null;
	try {
		doc = JSON.parse(text);
	} catch {
		return { ok: false, error: `runs registry ${path} is not valid JSON`, runs: [] };
	}
	if (typeof doc !== "object" || doc === null || !Array.isArray(doc.runs)) {
		return { ok: false, error: `runs registry ${path} has no runs array`, runs: [] };
	}
	return { ok: true, source: "file", runs: doc.runs };
}

/** Index projects.json entries into a projectId → {project, tasks} map. */
export function indexProjects(entries) {
	const index = new Map();
	for (const entry of entries) {
		const manifest = entry?.manifest;
		if (typeof manifest !== "object" || manifest === null) continue;
		const project = manifest.project;
		if (typeof project?.id !== "string" || project.id.length === 0) continue;
		const tasks = new Map();
		for (const task of Array.isArray(manifest.tasks) ? manifest.tasks : []) {
			if (typeof task?.id === "string" && task.id.length > 0) tasks.set(task.id, task);
		}
		index.set(project.id, { project, tasks, entry });
	}
	return index;
}

/** Index runs.json records into a runId → run map. */
export function indexRuns(runs) {
	const index = new Map();
	for (const run of runs) {
		if (typeof run?.id === "string" && run.id.length > 0) index.set(run.id, run);
	}
	return index;
}

/**
 * Collect every fact the planner needs in one snapshot.
 *
 * @param {object} options
 * @param {string} options.hwGuardDir - storages/hardware-guard directory
 * @param {string} options.opsDir - storages/resource-allocation directory
 * @param {object|null} options.ops - optional resource-allocation `resourceAllocation` service
 * @param {object|null} options.vitals - optional injected vitals (tests)
 */
export function collectFacts({ hwGuardDir = null, hardwareGuardDir = null, opsDir = null, resourceDir = null, ops = null, resourceService = null, vitals = null } = {}) {
	const factsDir = opsDir ?? resourceDir ?? dshHomePath("storages", "resource-allocation");
	const hardwareDir = hardwareGuardDir ?? hwGuardDir ?? dshHomePath("storages", "hardware-guard");
	const host = readHostProfile(hardwareDir);
	const pressure = readPressureState(hardwareDir, { hostProfile: host, vitals });
	const projects = readProjects(factsDir, { ops, resourceService });
	const runs = readRuns(factsDir, { ops, resourceService });
	return {
		hostProfile: host.ok ? host.profile : null,
		hostProfileError: host.ok ? null : host.error,
		pressure,
		projects: projects.entries ?? [],
		projectsError: projects.ok ? null : projects.error,
		runs: runs.runs ?? [],
		runsError: runs.ok ? null : runs.error
	};
}
