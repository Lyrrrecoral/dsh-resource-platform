/**
 * First-class session ownership summaries for the projects projection.
 *
 * Every run, scheduler queue item and orphan is attributable to a session
 * whenever the fact source carries one. This module folds those records into
 * a small, deterministic summary so the JSON API and HTML fallback can answer
 * "what does this session still own?" without walking three unrelated lists.
 *
 * Unknown project/task affiliations are NEVER dropped. They are also returned
 * in an explicit `unassigned` bucket, while entries that have a project/task
 * but no session owner are returned under `unassigned.ownerless`.
 *
 * @module resource-allocation/sessions
 */

/** Normalize a possibly-missing owner/session identity. */
export function normalizeSessionId(value) {
return typeof value === "string" && value.length > 0 ? value : null;
}

/** Copy only the owner-chain fields that are present and string-valued. */
export function normalizeOwner(owner, { sessionId = null } = {}) {
const source = owner !== null && typeof owner === "object" ? owner : {};
const out = {};
for (const key of ["kind", "sessionId", "agentId", "goalId", "jobId", "runId"]) {
if (typeof source[key] === "string" && source[key].length > 0) out[key] = source[key];
}
if (out.sessionId === undefined) {
const inferred = normalizeSessionId(sessionId);
if (inferred !== null) out.sessionId = inferred;
}
return Object.keys(out).length > 0 ? out : null;
}

function sessionIdOf(entry) {
return normalizeSessionId(entry?.owner?.sessionId) ?? normalizeSessionId(entry?.sessionId);
}

function numericTime(value) {
return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Most recent fact timestamp available for one entry. */
export function entryLastSeen(entry, { type = null, at = Date.now() } = {}) {
if (type === "orphan") return numericTime(at);
const candidates = type === "run"
? [entry?.updatedAt, entry?.finishedAt, entry?.startedAt, entry?.lastSeen]
: type === "queueItem"
? [entry?.lastTransitionAt, entry?.submittedAt, entry?.updatedAt, entry?.lastSeen]
: [entry?.updatedAt, entry?.finishedAt, entry?.lastTransitionAt, entry?.startedAt, entry?.submittedAt, entry?.lastSeen];
const values = candidates.map(numericTime).filter((value) => value !== null);
return values.length > 0 ? Math.max(...values) : null;
}

/** Project id/name/tasks lookup from either projected projects or registry entries. */
function projectLookup(projects) {
const map = new Map();
for (const wrapper of Array.isArray(projects) ? projects : []) {
const project = wrapper?.project ?? wrapper?.manifest?.project;
const id = project?.id;
if (typeof id !== "string" || id.length === 0) continue;
const tasks = new Set();
const rawTasks = Array.isArray(wrapper?.tasks) ? wrapper.tasks : Array.isArray(wrapper?.manifest?.tasks) ? wrapper.manifest.tasks : [];
for (const task of rawTasks) {
if (typeof task?.id === "string" && task.id.length > 0) tasks.add(task.id);
}
map.set(id, { projectId: id, projectName: project.name ?? id, tasks });
}
return map;
}

/** Resolve whether an entry's project/task lookups are known. */
function affiliation(entry, lookup) {
const projectId = typeof entry?.projectId === "string" && entry.projectId.length > 0 ? entry.projectId : null;
const taskId = typeof entry?.taskId === "string" && entry.taskId.length > 0 ? entry.taskId : null;
const project = projectId === null ? undefined : lookup.get(projectId);
const projectKnown = typeof entry?.projectKnown === "boolean"
? entry.projectKnown
: lookup.size > 0 && projectId !== null
? project !== undefined
: projectId !== null;
const taskKnown = typeof entry?.taskKnown === "boolean"
? entry.taskKnown
: lookup.size > 0 && project !== undefined && taskId !== null
? project.tasks.has(taskId)
: taskId !== null;
return {
projectId,
projectName: project?.projectName ?? entry?.projectName ?? null,
taskId,
projectKnown,
taskKnown,
unassigned: projectKnown !== true || taskKnown !== true
};
}

function safeCopy(entry) {
return entry !== null && typeof entry === "object" ? { ...entry } : entry;
}

/**
 * Build the per-session summary and the explicit unassigned buckets.
 *
 * @param {object} [options]
 * @param {Array} [options.runs] all run records / projections
 * @param {Array} [options.queueItems] scheduler queue projections (optional)
 * @param {object|null} [options.waiting] projectWaiting() result; used when
 *   `queueItems` is omitted. `resource-run` entries are ignored here because
 *   their durable run records are supplied through `runs`.
 * @param {Array} [options.orphans] orphan projections when already collected
 * @param {Array} [options.projects] projected projects; used for affiliation
 * @param {number} [options.at] observation timestamp
 * @returns {{sessions: Array, unassigned: object, counts: object}}
 */
export function buildSessionSummary({ runs = [], queueItems = null, waiting = null, orphans = [], projects = [], at = Date.now() } = {}) {
const lookup = projectLookup(projects);
const runItems = Array.isArray(runs) ? runs.filter((entry) => entry !== null && typeof entry === "object") : [];
const runIds = new Set(runItems.map((run) => run?.id).filter((id) => typeof id === "string"));
const rawQueue = queueItems !== null && queueItems !== undefined
? queueItems
: Array.isArray(waiting?.entries)
? waiting.entries.filter((entry) => entry?.source !== "resource-run" || !runIds.has(entry?.id))
: [];
const queue = Array.isArray(rawQueue) ? rawQueue.filter((entry) => entry !== null && typeof entry === "object") : [];
const orphanItems = Array.isArray(orphans) ? orphans.filter((entry) => entry !== null && typeof entry === "object") : [];

const unassigned = { runs: [], queueItems: [], orphans: [], ownerless: { runs: [], queueItems: [], orphans: [] }, counts: {} };
const entries = [];
const add = (entry, type) => {
if (entry === null || typeof entry !== "object") return;
const owner = normalizeOwner(entry.owner, { sessionId: entry.sessionId });
const sessionId = normalizeSessionId(owner?.sessionId);
const known = affiliation(entry, lookup);
const decorated = { entry, type, owner, sessionId, ...known, lastSeen: entryLastSeen(entry, { type, at }) };
entries.push(decorated);
if (known.unassigned) unassigned[type === "queueItem" ? "queueItems" : type === "run" ? "runs" : "orphans"].push(safeCopy(entry));
if (sessionId === null) {
if (type === "run") unassigned.ownerless.runs.push(safeCopy(entry));
else if (type === "queueItem") unassigned.ownerless.queueItems.push(safeCopy(entry));
else unassigned.ownerless.orphans.push(safeCopy(entry));
}
};
for (const run of runItems) add(run, "run");
for (const item of queue) add(item, "queueItem");
for (const orphan of orphanItems) add(orphan, "orphan");

const bySession = new Map();
for (const item of entries) {
if (item.sessionId === null) continue;
let summary = bySession.get(item.sessionId);
if (summary === undefined) {
summary = {
sessionId: item.sessionId,
runs: 0,
queueItems: 0,
orphans: 0,
lastSeen: null,
projects: [],
runIds: [],
queueItemIds: [],
orphanPids: [],
owners: { agentIds: [], goalIds: [], jobIds: [], runIds: [] }
};
bySession.set(item.sessionId, summary);
}
const projectId = item.projectId ?? "unassigned";
let project = summary.projects.find((entry) => entry.projectId === projectId);
if (project === undefined) {
project = {
projectId,
projectName: item.projectName ?? (projectId === "unassigned" ? "unassigned" : projectId),
runs: 0,
queueItems: 0,
orphans: 0,
lastSeen: null
};
summary.projects.push(project);
}
if (item.type === "run") {
summary.runs += 1;
project.runs += 1;
if (typeof item.entry.id === "string") summary.runIds.push(item.entry.id);
} else if (item.type === "queueItem") {
summary.queueItems += 1;
project.queueItems += 1;
if (typeof item.entry.id === "string") summary.queueItemIds.push(item.entry.id);
} else {
summary.orphans += 1;
project.orphans += 1;
if (Number.isInteger(item.entry.pid)) summary.orphanPids.push(item.entry.pid);
}
if (item.lastSeen !== null && (summary.lastSeen === null || item.lastSeen > summary.lastSeen)) summary.lastSeen = item.lastSeen;
if (item.lastSeen !== null && (project.lastSeen === null || item.lastSeen > project.lastSeen)) project.lastSeen = item.lastSeen;
for (const [field, bucket] of [["agentId", "agentIds"], ["goalId", "goalIds"], ["jobId", "jobIds"], ["runId", "runIds"]]) {
const value = item.owner?.[field];
if (typeof value === "string" && value.length > 0 && !summary.owners[bucket].includes(value)) summary.owners[bucket].push(value);
}
}

const sessions = [...bySession.values()].map((summary) => ({
...summary,
projects: summary.projects.sort((left, right) => left.projectId.localeCompare(right.projectId))
}));
sessions.sort((left, right) => {
const timeDiff = (right.lastSeen ?? 0) - (left.lastSeen ?? 0);
return timeDiff !== 0 ? timeDiff : left.sessionId.localeCompare(right.sessionId);
});

unassigned.counts = {
runs: unassigned.runs.length,
queueItems: unassigned.queueItems.length,
orphans: unassigned.orphans.length,
total: unassigned.runs.length + unassigned.queueItems.length + unassigned.orphans.length
};
unassigned.ownerless.counts = {
runs: unassigned.ownerless.runs.length,
queueItems: unassigned.ownerless.queueItems.length,
orphans: unassigned.ownerless.orphans.length,
total: unassigned.ownerless.runs.length + unassigned.ownerless.queueItems.length + unassigned.ownerless.orphans.length
};
return {
sessions,
unassigned,
counts: {
sessions: sessions.length,
ownerless: unassigned.ownerless.counts.total,
unassigned: unassigned.counts.total
}
};
}
