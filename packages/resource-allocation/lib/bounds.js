/**
 * Bounded observation projection.
 *
 * The API/HTML fallback must never render an unbounded fact file: a corrupt or
 * adversarial command line, a queue with tens of thousands of items, or a
 * large /proc table must not turn one request into unbounded work or a
 * multi-megabyte response. Limits are applied only to the DISPLAY projection;
 * the registries/queue/policy fact sources remain untouched.
 *
 * Every truncation is explicit in the response (`truncated`, per-list
 * `total`/`returned`, and the `bounds.report` map). Active runs and scheduled
 * items are retained ahead of old terminal rows when a run/queue list must be
 * shortened.
 *
 * @module resource-allocation/bounds
 */

export const DEFAULT_PAGE_LIMITS = Object.freeze({
projects: 50,
runsTotal: 200,
runsPerProject: 50,
orphansPerProject: 32,
waitingEntries: 200,
discoveredItems: 50,
sessions: 50,
unassignedPerKind: 50,
adoptsPerProject: 32,
tasksPerProject: 128,
fleetRows: 32,
commandArgs: 32,
argumentChars: 512,
textChars: 4096,
unitFacts: 128,
maxJsonBytes: 2 * 1024 * 1024,
maxHtmlBytes: 4 * 1024 * 1024
});

/** Active run statuses are ordered before terminal history when truncating. */
const ACTIVE_RUN_STATUSES = new Set(["queued", "launching", "running"]);

function positiveInteger(value, fallback) {
return Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * Merge operator/test overrides with defaults. Existing `max*` aliases are
 * accepted so profile config can use obvious names without a second shape.
 */
export function normalizePageLimits(overrides = {}) {
const raw = overrides !== null && typeof overrides === "object" ? overrides : {};
const alias = (primary, ...names) => {
for (const name of [primary, ...names]) {
if (raw[name] !== undefined) return raw[name];
}
return undefined;
};
const pick = (primary, fallback, ...aliases) => positiveInteger(alias(primary, ...aliases), fallback);
return {
projects: pick("projects", DEFAULT_PAGE_LIMITS.projects, "maxProjects"),
runsTotal: pick("runsTotal", DEFAULT_PAGE_LIMITS.runsTotal, "maxRuns", "maxRunsTotal"),
runsPerProject: pick("runsPerProject", DEFAULT_PAGE_LIMITS.runsPerProject, "maxRunsPerProject"),
orphansPerProject: pick("orphansPerProject", DEFAULT_PAGE_LIMITS.orphansPerProject, "maxOrphans", "maxOrphansPerProject"),
waitingEntries: pick("waitingEntries", DEFAULT_PAGE_LIMITS.waitingEntries, "queueEntries", "maxQueueEntries", "maxWaitingEntries"),
discoveredItems: pick("discoveredItems", DEFAULT_PAGE_LIMITS.discoveredItems, "maxDiscovered", "maxDiscoveredItems"),
sessions: pick("sessions", DEFAULT_PAGE_LIMITS.sessions, "maxSessions"),
unassignedPerKind: pick("unassignedPerKind", DEFAULT_PAGE_LIMITS.unassignedPerKind, "maxUnassigned", "maxUnassignedPerKind"),
adoptsPerProject: pick("adoptsPerProject", DEFAULT_PAGE_LIMITS.adoptsPerProject, "maxAdopts", "maxAdoptsPerProject"),
tasksPerProject: pick("tasksPerProject", DEFAULT_PAGE_LIMITS.tasksPerProject, "maxTasksPerProject"),
fleetRows: pick("fleetRows", DEFAULT_PAGE_LIMITS.fleetRows, "maxFleetRows"),
commandArgs: pick("commandArgs", DEFAULT_PAGE_LIMITS.commandArgs, "maxCommandArgs"),
argumentChars: pick("argumentChars", DEFAULT_PAGE_LIMITS.argumentChars, "maxArgumentChars"),
textChars: pick("textChars", DEFAULT_PAGE_LIMITS.textChars, "maxTextChars"),
unitFacts: pick("unitFacts", DEFAULT_PAGE_LIMITS.unitFacts, "maxUnitFacts"),
maxJsonBytes: pick("maxJsonBytes", DEFAULT_PAGE_LIMITS.maxJsonBytes, "maxResponseBytes"),
maxHtmlBytes: pick("maxHtmlBytes", DEFAULT_PAGE_LIMITS.maxHtmlBytes, "maxHtmlResponseBytes")
};
}

function truncateText(value, max) {
if (typeof value !== "string") return value;
return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value;
}

function truncateArgv(value, limits) {
if (!Array.isArray(value)) return value;
const args = value.slice(0, limits.commandArgs).map((part) => truncateText(String(part), limits.argumentChars));
return args;
}

function truncateOwner(owner, limits) {
if (owner === null || typeof owner !== "object" || Array.isArray(owner)) return owner;
const out = {};
for (const [key, value] of Object.entries(owner)) {
out[key] = typeof value === "string" ? truncateText(value, limits.argumentChars) : value;
}
return out;
}

function truncateRun(run, limits) {
if (run === null || typeof run !== "object" || Array.isArray(run)) return run;
const command = truncateArgv(run.command, limits);
const argv = truncateArgv(run.argv, limits);
return {
...run,
...(Array.isArray(run.command) ? { command, commandTruncated: command.length < run.command.length || run.command.some((part) => typeof part === "string" && part.length > limits.argumentChars) } : {}),
...(Array.isArray(run.argv) ? { argv, argvTruncated: argv.length < run.argv.length || run.argv.some((part) => typeof part === "string" && part.length > limits.argumentChars) } : {}),
owner: truncateOwner(run.owner, limits),
reason: truncateText(run.reason, limits.textChars)
};
}

function activeFirstRuns(items, limit) {
if (items.length <= limit) return items;
const active = [];
const terminal = [];
for (const run of items) {
(ACTIVE_RUN_STATUSES.has(run?.status) ? active : terminal).push(run);
}
terminal.sort((left, right) => {
const leftAt = left?.updatedAt ?? left?.finishedAt ?? left?.startedAt ?? 0;
const rightAt = right?.updatedAt ?? right?.finishedAt ?? right?.startedAt ?? 0;
return rightAt - leftAt || String(left?.id ?? "").localeCompare(String(right?.id ?? ""));
});
return [...active, ...terminal].slice(0, limit);
}

function boundList(items, limit, { select = (values, max) => values.slice(0, max), map = (value) => value } = {}) {
const source = Array.isArray(items) ? items : [];
const selected = select(source, limit);
return {
items: selected.map(map),
meta: { limit, total: source.length, returned: selected.length, truncated: selected.length < source.length }
};
}

function boundFleet(fleet, limits) {
if (fleet === null || typeof fleet !== "object" || Array.isArray(fleet)) return { fleet, truncated: false };
let truncated = false;
const next = {
...fleet,
path: truncateText(fleet.path, limits.textChars),
status: truncateText(fleet.status, limits.argumentChars),
manager: truncateText(fleet.manager, limits.argumentChars),
error: truncateText(fleet.error, limits.textChars)
};
for (const key of ["desired", "actual", "missing", "extra", "duplicates"]) {
if (!Array.isArray(fleet[key])) continue;
const bounded = fleet[key].slice(0, limits.fleetRows).map((item) => {
if (item === null || typeof item !== "object") return truncateText(String(item), limits.textChars);
if (key !== "actual") return truncateText(JSON.stringify(item), limits.textChars);
return {
seed: truncateText(item.seed, limits.argumentChars),
pid: item.pid,
cgroup: truncateText(item.cgroup, limits.textChars),
comm: truncateText(item.comm, limits.argumentChars),
cpuPct: item.cpuPct,
rssMiB: item.rssMiB
};
});
next[key] = bounded;
if (bounded.length < fleet[key].length) truncated = true;
}
next.truncated = truncated;
next.lastDecision = fleet.lastDecision === null || typeof fleet.lastDecision !== "object" ? fleet.lastDecision : {
...fleet.lastDecision,
detail: truncateText(fleet.lastDecision.detail, limits.textChars),
action: truncateText(fleet.lastDecision.action, limits.argumentChars)
};
return { fleet: next, truncated };
}

function boundSessionSummary(session, limits) {
if (session === null || typeof session !== "object" || Array.isArray(session)) return session;
return {
...session,
sessionId: truncateText(session.sessionId, limits.argumentChars),
projects: Array.isArray(session.projects) ? session.projects.slice(0, limits.projects).map((project) => ({
...project,
projectId: truncateText(project?.projectId, limits.argumentChars),
projectName: truncateText(project?.projectName, limits.textChars)
})) : session.projects,
runIds: Array.isArray(session.runIds) ? session.runIds.slice(0, limits.unassignedPerKind).map((id) => truncateText(id, limits.argumentChars)) : session.runIds,
queueItemIds: Array.isArray(session.queueItemIds) ? session.queueItemIds.slice(0, limits.unassignedPerKind).map((id) => truncateText(id, limits.argumentChars)) : session.queueItemIds,
orphanPids: Array.isArray(session.orphanPids) ? session.orphanPids.slice(0, limits.unassignedPerKind) : session.orphanPids
};
}

function boundUnassignedBucket(bucket, limits) {
if (bucket === null || typeof bucket !== "object" || Array.isArray(bucket)) return bucket;
const next = { ...bucket };
for (const key of ["runs", "queueItems", "orphans"]) {
if (!Array.isArray(bucket[key])) continue;
next[key] = bucket[key].slice(0, limits.unassignedPerKind).map((entry) => truncateRun(entry, limits));
}
if (bucket.ownerless !== null && typeof bucket.ownerless === "object" && !Array.isArray(bucket.ownerless)) {
next.ownerless = boundUnassignedBucket(bucket.ownerless, limits);
}
const runsReturned = Array.isArray(next.runs) ? next.runs.length : 0;
const queueReturned = Array.isArray(next.queueItems) ? next.queueItems.length : 0;
const orphansReturned = Array.isArray(next.orphans) ? next.orphans.length : 0;
next.returnedCounts = {
runs: runsReturned,
queueItems: queueReturned,
orphans: orphansReturned,
total: runsReturned + queueReturned + orphansReturned
};
return next;
}

function boundSchedulerProjection(scheduler, limits) {
if (scheduler === null || typeof scheduler !== "object" || Array.isArray(scheduler)) return scheduler;
return {
revision: scheduler.revision,
updatedAt: scheduler.updatedAt,
capacity: scheduler.capacity !== null && typeof scheduler.capacity === "object" && !Array.isArray(scheduler.capacity)
? {
pressure: truncateText(scheduler.capacity.pressure, limits.argumentChars),
headroomCpuCores: scheduler.capacity.headroomCpuCores,
headroomMemBytes: scheduler.capacity.headroomMemBytes,
sampledAt: scheduler.capacity.sampledAt
}
: scheduler.capacity,
lastDecision: scheduler.lastDecision !== null && typeof scheduler.lastDecision === "object" && !Array.isArray(scheduler.lastDecision)
? {
revision: scheduler.lastDecision.revision,
action: truncateText(scheduler.lastDecision.action, limits.argumentChars),
reason: truncateText(scheduler.lastDecision.reason, limits.textChars),
by: truncateText(scheduler.lastDecision.by, limits.argumentChars),
at: scheduler.lastDecision.at
}
: scheduler.lastDecision
};
}

function unassignedSizes(bucket) {
if (bucket === null || typeof bucket !== "object" || Array.isArray(bucket)) return { total: 0, returned: 0, truncated: false };
const keys = ["runs", "queueItems", "orphans"];
const total = keys.reduce((sum, key) => sum + (Array.isArray(bucket[key]) ? bucket[key].length : 0), 0);
return { total, returned: total, truncated: false };
}

function boundProject(project, limits) {
if (project === null || typeof project !== "object" || Array.isArray(project)) return { project, meta: { truncated: false } };
const runs = boundList(project.runs, limits.runsPerProject, {
select: activeFirstRuns,
map: (run) => truncateRun(run, limits)
});
const orphans = boundList(project.orphans, limits.orphansPerProject, {
map: (orphan) => truncateRun(orphan, limits)
});
const adopts = boundList(project.adopts, limits.adoptsPerProject);
const tasks = boundList(project.tasks, limits.tasksPerProject, {
map: (task) => task === null || typeof task !== "object" ? task : {
...task,
id: truncateText(task.id, limits.argumentChars),
systemdUnit: truncateText(task.systemdUnit, limits.argumentChars)
}
});
const fleet = boundFleet(project.fleet, limits);
const sessions = boundList(project.sessions, limits.sessions, { map: (session) => boundSessionSummary(session, limits) });
const unassignedSizesBefore = unassignedSizes(project.unassigned);
const projectUnassigned = boundUnassignedBucket(project.unassigned, limits);
const unassignedAfter = unassignedSizes(projectUnassigned);
const unassignedTruncated = unassignedAfter.total < unassignedSizesBefore.total;
const next = {
...project,
project: project.project === null || typeof project.project !== "object" ? project.project : {
...project.project,
id: truncateText(project.project.id, limits.argumentChars),
name: truncateText(project.project.name, limits.textChars),
description: truncateText(project.project.description, limits.textChars)
},
tasks: tasks.items,
adopts: adopts.items,
orphans: orphans.items,
runs: runs.items,
fleet: fleet.fleet,
sessions: sessions.items,
sessionsTotal: sessions.meta.total,
unassigned: projectUnassigned,
sessionsTruncated: sessions.meta.truncated,
unassignedTruncated,
tasksTruncated: tasks.meta.truncated,
adoptsTruncated: adopts.meta.truncated,
orphansTruncated: orphans.meta.truncated,
runsTruncated: runs.meta.truncated
};
return {
project: next,
meta: {
runs: runs.meta,
orphans: orphans.meta,
adopts: adopts.meta,
tasks: tasks.meta,
sessions: sessions.meta,
unassigned: { limit: limits.unassignedPerKind, total: unassignedSizesBefore.total, returned: unassignedAfter.total, truncated: unassignedTruncated },
fleetTruncated: fleet.truncated
}
};
}

/**
 * Apply every display bound without mutating the observation or any fact
 * source. The returned object always carries `truncated`, `limitConfig`, and
 * a machine-readable `bounds.report`.
 *
 * @param {object} observation
 * @param {object} [overrides] see normalizePageLimits()
 * @returns {object}
 */
export function boundObservation(observation, overrides = {}, { enforceByteBudget = true } = {}) {
const limits = normalizePageLimits(overrides);
const source = observation !== null && typeof observation === "object" ? observation : {};
const report = {};
const projectSource = Array.isArray(source.projects) ? source.projects : [];
const selectedProjects = projectSource.slice(0, limits.projects);
const projectResults = selectedProjects.map((project) => boundProject(project, limits));
const reportLimit = (limit, total, returned, truncated = returned < total) => ({ limit, total, returned, truncated });
report.projects = reportLimit(limits.projects, projectSource.length, projectResults.length);
const arrayLength = (value) => Array.isArray(value) ? value.length : 0;
const projectArrayTotal = (project, key) => arrayLength(project?.[key]);
const unassignedTotalForProject = (project) => {
const bucket = project?.unassigned;
if (bucket === null || typeof bucket !== "object" || Array.isArray(bucket)) return 0;
return arrayLength(bucket.runs) + arrayLength(bucket.queueItems) + arrayLength(bucket.orphans);
};
report.projectRuns = {
limit: limits.runsPerProject,
total: projectSource.reduce((sum, project) => sum + projectArrayTotal(project, "runs"), 0),
truncatedProjects: projectResults.filter((result) => result.meta.runs?.truncated === true).length
};
report.projectOrphans = {
limit: limits.orphansPerProject,
total: projectSource.reduce((sum, project) => sum + projectArrayTotal(project, "orphans"), 0),
truncatedProjects: projectResults.filter((result) => result.meta.orphans?.truncated === true).length
};
report.projectAdopts = {
limit: limits.adoptsPerProject,
total: projectSource.reduce((sum, project) => sum + projectArrayTotal(project, "adopts"), 0),
truncatedProjects: projectResults.filter((result) => result.meta.adopts?.truncated === true).length
};
report.projectTasks = {
limit: limits.tasksPerProject,
total: projectSource.reduce((sum, project) => sum + projectArrayTotal(project, "tasks"), 0),
truncatedProjects: projectResults.filter((result) => result.meta.tasks?.truncated === true).length
};
report.projectSessions = {
limit: limits.sessions,
total: projectSource.reduce((sum, project) => sum + projectArrayTotal(project, "sessions"), 0),
truncatedProjects: projectResults.filter((result) => result.meta.sessions?.truncated === true).length
};
report.projectUnassigned = {
limit: limits.unassignedPerKind,
total: projectSource.reduce((sum, project) => sum + unassignedTotalForProject(project), 0),
truncatedProjects: projectResults.filter((result) => result.meta.unassigned?.truncated === true).length
};
report.projectFleet = {
limit: limits.fleetRows,
truncatedProjects: projectResults.filter((result) => result.meta.fleetTruncated === true).length
};

const next = { ...source, projects: projectResults.map((result) => result.project) };

if (source.runs !== null && typeof source.runs === "object" && !Array.isArray(source.runs)) {
const runBound = boundList(source.runs.items, limits.runsTotal, {
select: activeFirstRuns,
map: (run) => truncateRun(run, limits)
});
report.runs = runBound.meta;
next.runs = {
...source.runs,
items: runBound.items,
totalCount: runBound.meta.total,
returnedCount: runBound.meta.returned,
truncated: runBound.meta.truncated
};
}

if (source.waiting !== null && typeof source.waiting === "object" && !Array.isArray(source.waiting)) {
const entryBound = boundList(source.waiting.entries, limits.waitingEntries, {
select: (items, limit) => items.slice(0, limit),
map: (entry) => truncateRun(entry, limits)
});
const unassignedBound = boundList(source.waiting.unassigned, limits.unassignedPerKind, {
select: (items, limit) => items.slice(0, limit),
map: (entry) => truncateRun(entry, limits)
});
report.waiting = entryBound.meta;
report.waitingUnassigned = unassignedBound.meta;
const returnedEntries = entryBound.items;
next.waiting = {
...source.waiting,
path: truncateText(source.waiting.path, limits.textChars),
error: truncateText(source.waiting.error, limits.textChars),
scheduler: boundSchedulerProjection(source.waiting.scheduler, limits),
entries: returnedEntries,
unassigned: unassignedBound.items,
totalEntries: entryBound.meta.total,
returnedEntries: entryBound.meta.returned,
returnedCounts: {
occupied: returnedEntries.filter((entry) => entry?.state === "occupied").length,
waiting: returnedEntries.filter((entry) => entry?.state === "waiting").length,
unassigned: unassignedBound.items.length,
total: returnedEntries.length
},
truncated: entryBound.meta.truncated,
unassignedTruncated: unassignedBound.meta.truncated
};
}

const discovered = source.discovered;
if (discovered !== null && typeof discovered === "object" && !Array.isArray(discovered)) {
const itemBound = boundList(discovered.items, limits.discoveredItems, {
select: (items, limit) => items.slice(0, limit),
map: (item) => item === null || typeof item !== "object" ? item : {
...item,
path: truncateText(item.path, limits.textChars),
name: truncateText(item.name, limits.textChars),
description: truncateText(item.description, limits.textChars),
error: truncateText(item.error, limits.textChars)
}
});
const errors = Array.isArray(discovered.errors) ? discovered.errors.slice(0, 50).map((error) => truncateText(error, limits.textChars)) : discovered.errors;
report.discovered = itemBound.meta;
next.discovered = {
...discovered,
roots: Array.isArray(discovered.roots) ? discovered.roots.slice(0, 64).map((root) => truncateText(root, limits.textChars)) : discovered.roots,
items: itemBound.items,
errors,
truncated: itemBound.meta.truncated || (Array.isArray(discovered.errors) && discovered.errors.length > 50)
};
}

const sessionBound = boundList(source.sessions, limits.sessions, {
select: (items, limit) => items.slice(0, limit),
map: (session) => boundSessionSummary(session, limits)
});
report.sessions = sessionBound.meta;
next.sessions = sessionBound.items;
next.sessionsTotal = sessionBound.meta.total;
next.sessionsTruncated = sessionBound.meta.truncated;

if (source.unassigned !== null && typeof source.unassigned === "object" && !Array.isArray(source.unassigned)) {
const bounded = {};
for (const key of ["runs", "queueItems", "orphans"]) {
const list = boundList(source.unassigned[key], limits.unassignedPerKind, {
select: (items, limit) => items.slice(0, limit),
map: (entry) => truncateRun(entry, limits)
});
bounded[key] = list.items;
report[`unassigned_${key}`] = list.meta;
}
const ownerlessSource = source.unassigned.ownerless;
if (ownerlessSource !== null && typeof ownerlessSource === "object") {
const ownerless = { ...ownerlessSource };
for (const key of ["runs", "queueItems", "orphans"]) {
const list = boundList(ownerlessSource[key], limits.unassignedPerKind, {
select: (items, limit) => items.slice(0, limit),
map: (entry) => truncateRun(entry, limits)
});
ownerless[key] = list.items;
report[`ownerless_${key}`] = list.meta;
}
bounded.ownerless = ownerless;
}
bounded.counts = source.unassigned.counts;
bounded.truncated = Object.entries(report).some(([name, meta]) => name.startsWith("unassigned_") && meta.truncated);
next.unassigned = boundUnassignedBucket(bounded, limits);
}

if (source.unitFacts !== null && typeof source.unitFacts === "object" && !Array.isArray(source.unitFacts)) {
const entries = Object.entries(source.unitFacts);
const kept = entries.slice(0, limits.unitFacts);
report.unitFacts = { limit: limits.unitFacts, total: entries.length, returned: kept.length, truncated: kept.length < entries.length };
next.unitFacts = Object.fromEntries(kept);
}

if (source.registry !== null && typeof source.registry === "object" && !Array.isArray(source.registry)) {
next.registry = {
path: truncateText(source.registry.path, limits.textChars),
revision: source.registry.revision,
updatedAt: source.registry.updatedAt,
...(source.registry.error === undefined || source.registry.error === null
? {}
: { error: truncateText(source.registry.error, limits.textChars) })
};
}

const truncated = Object.values(report).some((meta) => meta?.truncated === true || (meta?.truncatedProjects ?? 0) > 0);
next.truncated = truncated;
next.limitConfig = limits;
next.bounds = {
truncated,
report
};

if (!enforceByteBudget) return next;
const initialBytes = Buffer.byteLength(JSON.stringify(next), "utf8");
if (initialBytes <= limits.maxJsonBytes) {
report.responseBytes = { limit: limits.maxJsonBytes, total: initialBytes, returned: initialBytes, truncated: false };
const finalBytes = Buffer.byteLength(JSON.stringify(next), "utf8");
report.responseBytes.returned = finalBytes;
if (finalBytes <= limits.maxJsonBytes) return next;
}

// Hard response budget. Repeatedly tighten every list/string cap until the
// encoded projection fits. The fact sources are untouched; this only shrinks
// the display copy.
const keys = [
"projects", "runsTotal", "runsPerProject", "orphansPerProject",
"waitingEntries", "discoveredItems", "sessions", "unassignedPerKind",
"adoptsPerProject", "tasksPerProject", "fleetRows", "commandArgs",
"argumentChars", "textChars", "unitFacts"
];
let tighter = { ...limits };
for (let attempt = 0; attempt < 12; attempt += 1) {
for (const key of keys) {
const floor = key === "argumentChars" || key === "textChars" ? 64 : 1;
tighter[key] = Math.max(floor, Math.floor(tighter[key] / 2));
}
const retry = boundObservation(source, tighter, { enforceByteBudget: false });
retry.truncated = true;
retry.bounds.truncated = true;
retry.bounds.report.byteBudget = {
limit: limits.maxJsonBytes,
total: initialBytes,
returned: Buffer.byteLength(JSON.stringify(retry), "utf8"),
truncated: true
};
retry.bounds.report.responseBytes = retry.bounds.report.byteBudget;
retry.limitConfig = tighter;
if (retry.bounds.report.byteBudget.returned <= limits.maxJsonBytes) return retry;
}

// Defensive last resort: even pathological field values must not make the
// HTTP response unbounded. Preserve metadata/counts and say what happened.
const smallestOverrides = { ...tighter };
for (const key of keys) {
smallestOverrides[key] = key === "argumentChars" || key === "textChars" ? 64 : 1;
}
smallestOverrides.maxJsonBytes = limits.maxJsonBytes;
smallestOverrides.maxHtmlBytes = limits.maxHtmlBytes;
const smallest = boundObservation(source, smallestOverrides, { enforceByteBudget: false });
const minimal = {
at: smallest.at,
registry: smallest.registry,
projects: [],
unitFacts: {},
runs: smallest.runs === null || smallest.runs === undefined
? smallest.runs
: { path: smallest.runs.path, revision: smallest.runs.revision, updatedAt: smallest.runs.updatedAt, error: smallest.runs.error, items: [], truncated: true },
waiting: smallest.waiting === null || smallest.waiting === undefined
? smallest.waiting
: {
path: smallest.waiting.path,
error: smallest.waiting.error,
scheduler: smallest.waiting.scheduler,
counts: smallest.waiting.counts,
entries: [],
unassigned: [],
truncated: true,
unassignedTruncated: true
},
discovered: smallest.discovered === null || smallest.discovered === undefined
? smallest.discovered
: { at: smallest.discovered.at, enabled: smallest.discovered.enabled, roots: [], items: [], errors: [], counts: smallest.discovered.counts, truncated: true },
sessions: [],
unassigned: smallest.unassigned === null || smallest.unassigned === undefined
? smallest.unassigned
: {
runs: [],
queueItems: [],
orphans: [],
counts: smallest.unassigned.counts,
ownerless: smallest.unassigned.ownerless === null || smallest.unassigned.ownerless === undefined
? smallest.unassigned.ownerless
: { runs: [], queueItems: [], orphans: [], counts: smallest.unassigned.ownerless.counts },
truncated: true
},
ownership: smallest.ownership,
truncated: true
};
minimal.limitConfig = smallest.limitConfig;
minimal.bounds = {
...smallest.bounds,
truncated: true,
report: {
...smallest.bounds.report,
byteBudget: { limit: limits.maxJsonBytes, total: initialBytes, returned: 0, truncated: true }
}
};
const minimalBytes = Buffer.byteLength(JSON.stringify(minimal), "utf8");
minimal.bounds.report.byteBudget.returned = minimalBytes;
minimal.bounds.report.responseBytes = minimal.bounds.report.byteBudget;
return minimal;
}
