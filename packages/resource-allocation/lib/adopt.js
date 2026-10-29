/**
 * Observe-mode adoption: classify external owners into a per-project
 * observation projection without ever mutating them.
 *
 * v0.1 contract (ops-generalization §4.2):
 *  - systemd units referenced by project tasks are REGISTERED in the
 *    manifest's adopt[] with mode "observe" (a registry write — the
 *    registry is resource-allocation's own fact source);
 *  - unit state is READ via `systemctl show` only; no start/stop/restart/
 *    disable happens anywhere in this package;
 *  - processes are classified from /proc by cgroup ownership; anything
 *    matching the project's interest tokens outside an owned cgroup is an
 *    UNMANAGED/ORPHAN, displayed and never killed.
 *
 * @module resource-allocation/adopt
 */
import { readFileSync } from "node:fs";
import { discoverProjects } from "./discover.js";
import { listDescendants, readProcessTable, readProcFacts, argvMatchesTokens } from "./proc.js";
import { projectWaiting as projectWaitingBase } from "./queue.js";
import { buildSessionSummary } from "./sessions.js";
import { DSH_WEB_CGROUP, queryUnit } from "./systemd.js";
import { taskInterestTokens, manifestUnitNames } from "./manifest.js";

/** Default /proc adapter (tests inject fixtures). */
export const defaultProc = Object.freeze({
	table: () => readProcessTable(),
	readProcFacts: (pid) => readProcFacts(pid)
});

/** Default systemd adapter (tests inject a fake queryUnit). */
export const defaultSystemd = Object.freeze({
	queryUnit
});

/**
 * Merge one adopt entry into a manifest (pure). Existing entries keep their
 * mode — observe is never auto-promoted to managed in v0.1 — and keep their
 * adoptedAt; missing entries are appended with mode observe.
 * @returns {{manifest: object, added: string[], kept: string[]}}
 */
export function mergeAdoptEntry(manifest, { name, mode = "observe", adoptedAt }) {
	const next = structuredClone(manifest);
	const adopts = Array.isArray(next.adopt) ? next.adopt : [];
	next.adopt = adopts;
	const existing = adopts.find((entry) => entry.name === name);
	if (existing !== undefined) {
		if (Number.isInteger(existing.adoptedAt) === false && Number.isInteger(adoptedAt) === true) {
			existing.adoptedAt = adoptedAt;
		}
		return { manifest: next, added: [], kept: [name] };
	}
	adopts.push({ name, kind: "systemd-unit", mode, adoptedAt });
	return { manifest: next, added: [name], kept: [] };
}

/**
 * Register every systemd unit referenced by a project's tasks (and not yet
 * in adopt[]) as an observe entry. Read-only towards systemd; CAS towards
 * the registry; idempotent — a no-op run performs no writes.
 *
 * @param {ProjectRegistry} registry
 * @param {object} [options] - {systemd = defaultSystemd, now = () => Date.now()}
 * @returns {{projects: number, adopted: string[], conflicts: string[], errors: string[]}}
 */
export function ensureTaskUnitsAdopted(registry, { systemd = defaultSystemd, now = () => Date.now() } = {}) {
	const summary = { projects: 0, adopted: [], conflicts: [], errors: [] };
	const entries = registry.list();
	for (const entry of entries) {
		summary.projects += 1;
		const manifest = entry.manifest;
		const adoptNames = new Set((manifest.adopt ?? []).map((item) => item.name));
		const candidates = manifestUnitNames(manifest).filter((name) => !adoptNames.has(name));
		if (candidates.length === 0) continue;
		let merged = null;
		for (const unit of candidates) {
			const result = systemd.queryUnit(unit);
			if (!result.ok) {
				summary.errors.push(`project ${entry.id}: cannot observe ${unit}: ${result.error}`);
				continue;
			}
			const step = mergeAdoptEntry(merged?.manifest ?? manifest, { name: unit, mode: "observe", adoptedAt: now() });
			merged = step;
			if (step.added.length > 0) summary.adopted.push(unit);
		}
		if (merged === null || merged.added.length === 0) continue;
		const upsert = registry.upsert(merged.manifest, { expectedRevision: entry.revision });
		if (upsert.ok) {
			// The registry has moved: the caller re-lists and observes fresh.
		} else if (upsert.code === "conflict") {
			summary.conflicts.push(`project ${entry.id}: ${upsert.errors?.[0] ?? "revision conflict"}`);
		} else {
			summary.errors.push(`project ${entry.id}: ${upsert.errors?.[0] ?? upsert.code}`);
		}
	}
	return summary;
}

/** Whether a cgroup path is owned by (equal to, or nested under) an owned path. */
export function isOwnedCgroup(cgroup, owned) {
	if (cgroup === null || owned.length === 0) return false;
	return owned.some((path) => cgroup === path || cgroup.startsWith(`${path}/`));
}

/** Systemd-slice scope guard: orphan candidates must live in a systemd-managed slice. */
export function inSystemdScope(cgroup) {
	return typeof cgroup === "string" && (cgroup.startsWith("/system.slice/") || cgroup.startsWith("/user.slice/"));
}

/**
 * Build the owner chain of one adopted unit: the main pid plus every live
 * descendant, each annotated with cgroup and argv. Bounded, read-only.
 *
 * @param {{mainPid, controlGroup}|null} facts - normalized unit facts
 * @param {object} proc - {table, readProcFacts}
 * @returns {Array} [{pid, ppid, comm, cgroup, argv, sessionId}]
 */
export function buildOwnerChain(facts, proc = defaultProc, { limit = 64 } = {}) {
	if (facts === null || facts.mainPid === null) return [];
	const main = proc.readProcFacts(facts.mainPid);
	if (main === null) return [];
	const table = proc.table();
	const descendants = listDescendants(table, facts.mainPid);
	const chain = [];
	for (const entry of [main, ...descendants]) {
		if (chain.length >= limit) break;
		const factsEntry = entry === main ? main : proc.readProcFacts(entry.pid);
		if (factsEntry !== null) chain.push(factsEntry);
	}
	return chain;
}

/**
 * Discover unmanaged processes: live pids in a systemd slice whose argv
 * matches the project's interest tokens while their cgroup is not owned by
 * ANY registry project's adopt units. Display-only — the returned entries
 * carry no mutation and the caller must never signal them.
 *
 * @param {object} options - {tokens: string[], ownedCgroups: string[], proc}
 * @returns {Array} [{pid, ppid, comm, cgroup, argv, sessionId}]
 */
export function discoverOrphans({ tokens, ownedCgroups, proc = defaultProc, limit = 128 } = {}) {
	const tokenSet = new Set((tokens ?? []).map((token) => token.toLowerCase()));
	if (tokenSet.size === 0) return [];
	const table = proc.table();
	const orphans = [];
	for (const entry of table.values()) {
		if (orphans.length >= limit) break;
		const facts = proc.readProcFacts(entry.pid);
		if (facts === null || facts.cgroup === null) continue;
		if (isOwnedCgroup(facts.cgroup, ownedCgroups)) continue;
		if (!inSystemdScope(facts.cgroup)) continue;
		if (!argvMatchesTokens(facts.argv, tokenSet)) continue;
		orphans.push(facts);
	}
	return orphans;
}

/**
 * Read one status file (per-project fleet projection, e.g.
 * $PROJECT_ROOT/fleet-status.json) into a normalized fleet snapshot. This is
 * the temporary desired/actual source for adopted supervisors; the
 * generalized replacement is the queue.json projection (ops-generalization
 * §5).
 */
export function readFleetSnapshot(path, { read = (p) => { try { return readFileSync(p, "utf8"); } catch { return null; } } } = {}) {
	const text = read(path);
	if (text === null) return { path, error: "status file not found or unreadable" };
	let data = null;
	try {
		data = JSON.parse(text);
	} catch {
		return { path, error: "status file is not valid JSON" };
	}
	if (typeof data !== "object" || data === null) return { path, error: "status file is not an object" };
	const asList = (value) => (Array.isArray(value) ? value : []);
	return {
		path,
		status: typeof data.status === "string" ? data.status : "unknown",
		manager: typeof data.manager === "string" ? data.manager : null,
		updatedAt: Number.isFinite(data.updatedAt) ? data.updatedAt : null,
		desired: asList(data.desired),
		actual: asList(data.actual),
		missing: asList(data.missing),
		extra: asList(data.extra),
		duplicates: asList(data.duplicates),
		lastDecision: typeof data.lastDecision === "object" && data.lastDecision !== null ? data.lastDecision : null
	};
}

/** Enrich fleet actual entries with live cgroup facts (best effort). */
function enrichFleetActual(fleet, proc) {
	const actual = (fleet?.actual ?? []).map((item) => {
		if (typeof item !== "object" || item === null) return item;
		const pid = Number(item.pid);
		const facts = Number.isInteger(pid) && pid > 0 ? proc.readProcFacts(pid) : null;
		return { ...item, cgroup: facts?.cgroup ?? null, comm: facts?.comm ?? null };
	});
	return { ...fleet, actual };
}

/**
 * Whether a cgroup path lives under the live dsh-web.service cgroup — the
 * "a dsh-web restart kills me" red-warning condition for orphans and
 * session-spawned processes.
 */
export function inDshWebCgroup(cgroup) {
	return typeof cgroup === "string" && (cgroup === DSH_WEB_CGROUP || cgroup.startsWith(`${DSH_WEB_CGROUP}/`));
}

/**
 * The full per-request observation: registry projection + adopt unit chains
 * + fleet snapshots + orphan discovery + run/queue/session ownership.
 *
 * Everything here is read-only towards systemd and /proc; the only writes are
 * the idempotent ensureTaskUnitsAdopted registry registrations. The caller is
 * responsible for run retention and display-size bounding.
 *
 * Orphans gain an `owner` ({sessionId}) when /proc exposes DSH_SESSION_ID.
 * Unknown project/task affiliations are never dropped: they are marked with
 * projectKnown/taskKnown=false and also collected in explicit `unassigned`
 * buckets (top-level and queue-level).
 *
 * @param {object} options - {registry, runs?, statusFiles, systemd, proc, queue, discovery, now}
 * @returns {object} observation projection (JSON-serializable)
 */
export function observeRegistry({ registry, runs = null, statusFiles = [], systemd = defaultSystemd, proc = defaultProc, queue = null, discovery = null, now = () => Date.now() }) {
const loaded = registry.load();
const at = typeof now === "function" ? now() : now;
const runsLoaded = runs !== null && runs !== undefined ? runs.load() : null;
const runRecords = runsLoaded?.doc !== null && runsLoaded?.doc !== undefined && Array.isArray(runsLoaded.doc.runs) ? runsLoaded.doc.runs : [];
const entries = loaded.doc === null ? [] : loaded.doc.projects;
const projectTasks = new Map();
const projectNames = new Map();
for (const entry of entries) {
const tasks = new Map();
for (const task of entry.manifest?.tasks ?? []) {
if (task !== null && typeof task === "object" && typeof task.id === "string") tasks.set(task.id, task);
}
projectTasks.set(entry.id, tasks);
projectNames.set(entry.id, entry.manifest?.project?.name ?? entry.id);
}
const projectWaiting = (projects, runList) => {
const projection = projectWaitingBase({
queueDoc: queue === null || queue === undefined ? null : queue.doc ?? null,
queuePath: queue === null || queue === undefined ? null : queue.path ?? null,
queueError: queue === null || queue === undefined ? null : queue.error ?? null,
projects,
runs: runList,
now: () => at
});
return projection;
};

// Build an all-runs ownership projection once. The same records feed the
// project-local run tables and the top-level session summary.
const allRuns = runRecords.map((run) => {
const tasks = projectTasks.get(run.projectId);
const task = tasks?.get(run.taskId);
return {
...run,
projectName: projectNames.get(run.projectId) ?? null,
projectKnown: tasks !== undefined,
taskKnown: task !== undefined,
unassigned: tasks === undefined || task === undefined,
taskKind: task?.kind ?? null,
taskSystemdUnit: typeof task?.run?.systemdUnit === "string" ? task.run.systemdUnit : null,
durationMs: run.finishedAt !== null ? run.finishedAt - run.startedAt : at - run.startedAt
};
});

const discovered = discovery === null || discovery === undefined
? null
: discoverProjects({ discovery, registryDoc: loaded.doc, now: () => at });

if (loaded.doc === null) {
const waiting = projectWaiting([], []);
const ownership = buildSessionSummary({ runs: allRuns, waiting, projects: [], at });
return {
at,
registry: { path: loaded.path, error: loaded.error },
projects: [],
unitFacts: {},
runs: runsLoaded === null
? null
: runsLoaded.doc === null
? { path: runsLoaded.path, error: runsLoaded.error, items: [] }
: { path: runsLoaded.path, revision: runsLoaded.doc.revision, updatedAt: runsLoaded.doc.updatedAt, items: allRuns },
waiting,
discovered,
sessions: ownership.sessions,
unassigned: ownership.unassigned,
ownership: ownership.counts
};
}

// Query every adopted unit once (per-request cache); collect owned cgroups
// across ALL projects so orphans are attributed against the whole registry.
const unitCache = new Map();
const ownedCgroups = [];
const unitFactsFor = (unit) => {
if (!unitCache.has(unit)) {
const result = systemd.queryUnit(unit);
const value = result.ok ? result.facts : null;
unitCache.set(unit, { ok: result.ok, error: result.ok ? null : result.error, facts: value });
if (value?.controlGroup !== null && value?.controlGroup !== undefined) ownedCgroups.push(value.controlGroup);
}
return unitCache.get(unit);
};
for (const entry of entries) {
for (const adopt of entry.manifest.adopt ?? []) {
if (adopt.kind === "systemd-unit") unitFactsFor(adopt.name);
}
}

// Active resource runs' transient units are owned too, so their processes
// are never mislabelled as orphans.
for (const run of runRecords) {
if (run.status === "launching" || run.status === "running") unitFactsFor(run.unit);
}
const runUnitFactsFor = (unit) => unitCache.get(unit) ?? null;

let projects = entries.map((entry) => {
const manifest = entry.manifest;
const tokens = taskInterestTokens(manifest);
const tasks = projectTasks.get(entry.id) ?? new Map();
const projectName = manifest.project?.name ?? entry.id;

// Fleet snapshot(s) configured for this project id.
const matchedStatusFiles = (statusFiles ?? [])
.filter((file) => file !== null && typeof file === "object" && file.project === entry.id)
.map((file) => readFleetSnapshot(file.path));
const fleet = matchedStatusFiles.length > 0
? enrichFleetActual(matchedStatusFiles[0], proc)
: null;

// Adopted units with owner chains.
const adopts = (manifest.adopt ?? []).map((adopt) => {
const queried = adopt.kind === "systemd-unit" ? unitFactsFor(adopt.name) : { ok: false, error: "unsupported adopt kind in v1.0", facts: null };
const chain = queried.ok && queried.facts !== null ? buildOwnerChain(queried.facts, proc) : [];
return {
name: adopt.name,
kind: adopt.kind ?? "systemd-unit",
mode: adopt.mode,
adoptedAt: adopt.adoptedAt ?? null,
ok: queried.ok,
error: queried.error,
facts: queried.facts,
chain
};
});

// Orphans are project-scoped by their interest tokens. They have a
// real project context but no task identity; the explicit taskKnown
// false flag is what feeds the unassigned bucket.
const orphans = discoverOrphans({ tokens, ownedCgroups, proc }).map((orphan) => ({
...orphan,
owner: orphan.sessionId === null || orphan.sessionId === undefined ? null : { kind: "session", sessionId: orphan.sessionId },
projectId: entry.id,
projectName,
taskId: null,
projectKnown: true,
taskKnown: false,
unassigned: true,
inDshWeb: inDshWebCgroup(orphan.cgroup)
}));

// This project's runs, enriched with live unit facts (pid/cgroup).
const projectRuns = allRuns
.filter((run) => run.projectId === entry.id)
.map((run) => {
const queried = (run.status === "launching" || run.status === "running") ? runUnitFactsFor(run.unit) : null;
const live = queried?.ok === true && queried.facts !== null ? queried.facts : null;
return {
...run,
pid: live?.mainPid !== undefined && live?.mainPid !== null ? live.mainPid : run.pid,
cgroup: live?.controlGroup ?? null
};
});

return {
project: {
id: entry.id,
name: projectName,
description: manifest.project.description ?? null
},
monitored: entry.monitored !== false,
taskMonitors: entry.taskMonitors ?? {},
revision: entry.revision,
updatedAt: entry.updatedAt,
tasks: (manifest.tasks ?? []).map((task) => ({
id: task.id,
kind: task.kind,
enabled: task.enabled,
priority: task.priority,
systemdUnit: typeof task.run?.systemdUnit === "string" ? task.run.systemdUnit : null
})),
fleet,
adopts,
orphans,
runs: projectRuns
};
});

const waiting = projectWaiting(projects, runRecords);

// Per-project session summaries make the project tree directly usable;
// the top-level summary additionally folds in unregistered run/queue facts.
projects = projects.map((project) => {
const queueItems = waiting.entries.filter((entry) => entry.source === "scheduler" && entry.projectId === project.project.id);
const summary = buildSessionSummary({ runs: project.runs, queueItems, orphans: project.orphans, projects: [project], at });
return { ...project, sessions: summary.sessions, unassigned: summary.unassigned };
});

// Orphans can match more than one project's interest tokens. Deduplicate
// them for the global session total, while the project tree keeps its
// project-local orphan sections.
const orphanByPid = new Map();
for (const project of projects) {
for (const orphan of project.orphans) {
if (!orphanByPid.has(orphan.pid)) orphanByPid.set(orphan.pid, orphan);
}
}
const ownership = buildSessionSummary({ runs: allRuns, waiting, orphans: [...orphanByPid.values()], projects, at });

return {
at,
registry: { path: loaded.path, revision: loaded.doc.revision, updatedAt: loaded.doc.updatedAt },
unitFacts: Object.fromEntries([...unitCache.entries()].map(([unit, value]) => [unit, value.facts])),
runs: runsLoaded === null
? null
: runsLoaded.doc === null
? { path: runsLoaded.path, error: runsLoaded.error, items: [] }
: { path: runsLoaded.path, revision: runsLoaded.doc.revision, updatedAt: runsLoaded.doc.updatedAt, items: allRuns },
waiting,
discovered,
sessions: ownership.sessions,
unassigned: ownership.unassigned,
ownership: ownership.counts,
projects
};
}
