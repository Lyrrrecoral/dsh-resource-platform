/**
 * HTML and JSON rendering of the resource-allocation observation projection.
 *
 * The page shows, per project, the chain
 *   project → task/unit → pid/cgroup/owner
 * plus desired/actual reconciliation from fleet snapshots and the
 * unmanaged/orphan list. Orphans are rendered with an explicit
 * observe-only badge: nothing on this page can ever be killed.
 *
 * @module resource-allocation/render
 */

/** Escape a value for HTML text context. */
export function htmlEscape(value) {
	return String(value)
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

/** Truncate a joined argv for display; the projection keeps the full array. */
export function formatArgv(argv, max = 160) {
	const text = (argv ?? []).join(" ");
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Render an epoch-ms fact without throwing on an out-of-range/corrupt value. */
export function formatTimestamp(value) {
if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "?";
const date = new Date(value);
return Number.isFinite(date.getTime()) ? date.toISOString() : "?";
}

/** Human duration (h/m/s) for the runs table. */
export function formatDuration(ms) {
	if (!Number.isFinite(ms) || ms < 0) return "?";
	const total = Math.floor(ms / 1000);
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	return `${h}h${String(m).padStart(2, "0")}m${String(s).padStart(2, "0")}s`;
}

/** The owner chain in text form for the runs table. */
export function formatOwner(owner) {
	if (typeof owner !== "object" || owner === null) return "unassigned";
	const agent = owner.agentId ? ` / agent ${owner.agentId}` : "";
	if (owner.kind === "goal") return `goal ${owner.goalId ?? "?"} / session ${owner.sessionId ?? "?"}${agent}`;
	if (owner.kind === "job") return `job ${owner.jobId ?? "?"} / session ${owner.sessionId ?? "?"}${agent}`;
	return `session ${owner.sessionId ?? "?"}${agent}`;
}

/** Build the JSON projection: the observation as-is, JSON-serializable. */
export function renderJson(observation) {
	return observation;
}

function badge(label, kind) {
	return `<span class="badge ${kind}">${htmlEscape(label)}</span>`;
}

function fleetStatusClass(fleet) {
	if (fleet === null) return "muted";
	if (fleet.error) return "bad";
	return fleet.status === "ok" ? "ok" : "warn";
}

function renderFleet(fleet) {
	if (fleet === null) return '<p class="muted">no fleet status file configured for this project</p>';
	if (fleet.error) {
		return `<p class="error">${htmlEscape(fleet.error)}</p><p class="muted">${htmlEscape(fleet.path)}</p>`;
	}
	const actualRows = (fleet.actual ?? [])
		.map((item) => {
			if (typeof item !== "object" || item === null) return `<tr><td colspan="4">${htmlEscape(String(item))}</td></tr>`;
			return `<tr><td>${htmlEscape(item.seed ?? "?")}</td><td>${htmlEscape(item.pid ?? "?")}</td><td>${htmlEscape(item.cgroup ?? "?")}</td><td>${htmlEscape(item.cpuPct ?? 0)}% / ${htmlEscape(item.rssMiB ?? 0)} MiB</td></tr>`;
		})
		.join("");
	const decision = fleet.lastDecision ?? {};
	return `<dl class="facts">
<dt>status</dt><dd>${htmlEscape(fleet.status)}</dd>
<dt>manager</dt><dd>${htmlEscape(fleet.manager ?? "?")}</dd>
<dt>updated</dt><dd>${htmlEscape(fleet.updatedAt === null ? "?" : formatTimestamp(fleet.updatedAt))}</dd>
<dt>desired</dt><dd>${htmlEscape((fleet.desired ?? []).join(", ") || "none")}</dd>
<dt>missing</dt><dd>${htmlEscape((fleet.missing ?? []).join(", ") || "none")}</dd>
<dt>extra</dt><dd>${htmlEscape((fleet.extra ?? []).join(", ") || "none")}</dd>
<dt>last decision</dt><dd>${htmlEscape(decision.action ?? "?")}: ${htmlEscape(decision.detail ?? "")}</dd>
</dl>
<table>
<thead><tr><th>seed</th><th>pid</th><th>cgroup</th><th>cpu / rss</th></tr></thead>
<tbody>${actualRows || '<tr><td colspan="4" class="muted">no actual workers</td></tr>'}</tbody>
</table>`;
}

function renderChain(chain) {
	if (chain.length === 0) return '<p class="muted">no live processes under this unit</p>';
	const rows = chain
		.map((p) => `<tr><td>${htmlEscape(p.pid)}</td><td>${htmlEscape(p.ppid)}</td><td>${htmlEscape(p.comm)}</td><td>${htmlEscape(p.cgroup ?? "?")}</td><td class="cmd">${htmlEscape(formatArgv(p.argv))}</td></tr>`)
		.join("");
	return `<table>
<thead><tr><th>pid</th><th>ppid</th><th>comm</th><th>cgroup</th><th>command</th></tr></thead>
<tbody>${rows}</tbody>
</table>`;
}

function renderAdopts(adopts) {
	if (adopts.length === 0) return '<p class="muted">no adopted units</p>';
	return adopts
		.map((adopt) => {
			const facts = adopt.facts;
			const state = adopt.ok && facts !== null ? `${facts.activeState}/${facts.subState}` : "unreachable";
			const stateClass = adopt.ok && facts !== null && facts.activeState === "active" ? "ok" : adopt.ok ? "warn" : "bad";
			return `<section class="unit">
<h3>${htmlEscape(adopt.name)} ${badge(adopt.mode, "muted")} ${badge(state, stateClass)}</h3>
<dl class="facts">
<dt>load</dt><dd>${htmlEscape(facts?.loadState ?? "?")}</dd>
<dt>main pid</dt><dd>${htmlEscape(facts?.mainPid ?? "—")}</dd>
<dt>cgroup</dt><dd>${htmlEscape(facts?.controlGroup ?? "—")}</dd>
<dt>unit file</dt><dd>${htmlEscape(facts?.unitFileState ?? "?")}</dd>
<dt>adopted at</dt><dd>${htmlEscape(adopt.adoptedAt === null ? "?" : formatTimestamp(adopt.adoptedAt))}</dd>
</dl>
${adopt.error ? `<p class="error">${htmlEscape(adopt.error)}</p>` : ""}
${adopt.ok && facts !== null ? renderChain(adopt.chain) : ""}
</section>`;
		})
		.join("");
}

function runStatusClass(status) {
	if (status === "running" || status === "completed") return "ok";
	if (status === "failed" || status === "stopped") return "bad";
	return "warn"; // queued / launching
}

function renderRuns(runs) {
	if (runs.length === 0) return '<p class="muted">no resource_run records for this project</p>';
	const rows = runs
		.map((run) => `<tr>
<td>${htmlEscape(run.id)}</td>
<td>${htmlEscape(run.taskId)}</td>
<td>${htmlEscape(formatOwner(run.owner))}</td>
<td>${htmlEscape(run.unit)}</td>
<td>${run.pid !== null ? htmlEscape(run.pid) : "—"}</td>
<td>${badge(run.status, runStatusClass(run.status))}</td>
<td>${run.exitCode !== null ? htmlEscape(run.exitCode) : "—"}</td>
<td>${htmlEscape(formatDuration(run.durationMs))}</td>
<td class="cmd">${htmlEscape(formatArgv(run.command))}</td>
</tr>`)
		.join("");
	return `<table>
<thead><tr><th>run</th><th>task</th><th>owner</th><th>systemd unit</th><th>pid</th><th>status</th><th>exit</th><th>duration</th><th>command</th></tr></thead>
<tbody>${rows}</tbody>
</table>`;
}

function renderSessions(sessions, unassigned = null, { title = "session ownership summary" } = {}) {
const list = Array.isArray(sessions) ? sessions : [];
const rows = list.map((session) => {
const projects = (session.projects ?? [])
.map((project) => `${project.projectName ?? project.projectId ?? "?"} (${project.projectId ?? "?"})`)
.join(", ");
return `<tr>
<td>${htmlEscape(session.sessionId ?? "?")}</td>
<td>${htmlEscape(projects || "—")}</td>
<td>${htmlEscape(session.runs ?? 0)}</td>
<td>${htmlEscape(session.queueItems ?? 0)}</td>
<td>${htmlEscape(session.orphans ?? 0)}</td>
<td>${session.lastSeen === null || session.lastSeen === undefined ? "—" : htmlEscape(formatTimestamp(session.lastSeen))}</td>
</tr>`;
}).join("");
const counts = unassigned?.counts ?? { runs: 0, queueItems: 0, orphans: 0, total: 0 };
return `<section class="sessions">
<h3>${htmlEscape(title)} ${badge(`${list.length} session(s) · ${counts.total ?? 0} unassigned`, counts.total > 0 ? "warn" : "muted")}</h3>
<p>Runs, queue items and orphans are grouped by the session that owns them. Entries whose project or task is no longer known stay visible in the explicit <code>unassigned</code> bucket rather than being dropped.</p>
<table>
<thead><tr><th>session</th><th>projects</th><th>runs</th><th>queue items</th><th>orphans</th><th>last seen</th></tr></thead>
<tbody>${rows || '<tr><td colspan="6" class="muted">no session-owned work</td></tr>'}</tbody>
</table>
${counts.total > 0 ? `<p class="warn">unassigned: ${htmlEscape(counts.runs ?? 0)} run(s), ${htmlEscape(counts.queueItems ?? 0)} queue item(s), ${htmlEscape(counts.orphans ?? 0)} orphan(s).</p>` : ""}
</section>`;
}

function renderUnassigned(unassigned) {
if (unassigned === null || unassigned === undefined) return "";
const entries = [];
for (const [kind, key] of [["run", "runs"], ["queue item", "queueItems"], ["orphan", "orphans"]]) {
for (const entry of Array.isArray(unassigned[key]) ? unassigned[key] : []) {
entries.push({ kind, entry });
}
}
if (entries.length === 0) return "";
const rows = entries.slice(0, 200).map(({ kind, entry }) => `<tr class="danger">
<td>${htmlEscape(kind)}</td>
<td>${htmlEscape(entry.id ?? entry.pid ?? "?")}</td>
<td>${htmlEscape(entry.projectId ?? "?")}</td>
<td>${htmlEscape(entry.taskId ?? "?")}</td>
<td>${htmlEscape(formatOwner(entry.owner ?? (entry.sessionId ? { sessionId: entry.sessionId } : null)))}</td>
</tr>`).join("");
return `<section class="unassigned">
<h3>unassigned ${badge("unknown project/task — kept visible", "warn")}</h3>
<table>
<thead><tr><th>kind</th><th>id / pid</th><th>project</th><th>task</th><th>owner</th></tr></thead>
<tbody>${rows}</tbody>
</table>
${unassigned.truncated === true ? '<p class="warn">unassigned lists were truncated; see bounds.report in the JSON projection.</p>' : ""}
</section>`;
}

function renderWaiting(waiting) {
	if (waiting === null || waiting === undefined) return "";
	const entries = Array.isArray(waiting.entries) ? waiting.entries : [];
	const scheduler = waiting.scheduler ?? null;
	const capacity = scheduler?.capacity ?? null;
	const decision = scheduler?.lastDecision ?? null;
	const facts = [
		`<dt>slot holders</dt><dd>${htmlEscape(waiting.counts?.occupied ?? 0)}</dd>`,
		`<dt>waiting</dt><dd>${htmlEscape(waiting.counts?.waiting ?? 0)}</dd>`,
		`<dt>unassigned</dt><dd>${htmlEscape(waiting.counts?.unassigned ?? waiting.counts?.unaffiliated ?? 0)}</dd>`,
		waiting.truncated === true ? `<dt>display bound</dt><dd>showing ${htmlEscape(waiting.returnedEntries ?? entries.length)} of ${htmlEscape(waiting.totalEntries ?? entries.length)} entries</dd>` : "",
		`<dt>scheduler queue</dt><dd>${waiting.path === null || waiting.path === undefined ? "not configured" : htmlEscape(waiting.path)}${scheduler === null ? " (no queue document)" : ` · revision ${htmlEscape(scheduler.revision ?? "?")}`}</dd>`,
		capacity === null ? "" : `<dt>capacity</dt><dd>pressure ${htmlEscape(capacity.pressure ?? "?")} · headroom ${htmlEscape(capacity.headroomCpuCores ?? "?")} cores / ${htmlEscape(capacity.headroomMemBytes ?? "?")} B</dd>`,
		decision === null ? "" : `<dt>last decision</dt><dd>${htmlEscape(decision.action ?? "?")}: ${htmlEscape(decision.reason ?? "")} (${htmlEscape(decision.by ?? "?")})</dd>`
	].join("");
	const rows = entries
		.map((entry) => {
			const affiliation = entry.projectKnown === false
				? `<span class="error">unregistered project ${htmlEscape(entry.projectId ?? "?")}</span>`
				: entry.taskKnown === false
					? `<span class="error">unregistered task ${htmlEscape(entry.taskId ?? "?")}</span>`
					: `${htmlEscape(entry.projectName ?? entry.projectId ?? "?")} / ${htmlEscape(entry.taskId ?? "?")}`;
			const owner = formatOwner(entry.owner);
			const detail = entry.source === "scheduler"
				? `prio ${htmlEscape(entry.priority ?? "?")}`
				: htmlEscape(formatArgv(entry.command));
			const unassignedRow = entry.projectKnown !== true || entry.taskKnown !== true;
			return `<tr class="${unassignedRow ? "danger" : ""}">
<td>${badge(entry.state === "occupied" ? "占位中" : "等待中", entry.state === "occupied" ? "ok" : "warn")}</td>
<td>${htmlEscape(entry.status ?? "?")}</td>
<td>${affiliation}</td>
<td>${htmlEscape(owner)}</td>
<td>${htmlEscape(entry.source)}</td>
<td>${detail}</td>
<td>${entry.waitingMs === null || entry.waitingMs === undefined ? "—" : htmlEscape(formatDuration(entry.waitingMs))}</td>
</tr>`;
		})
		.join("");
	return `<section class="waiting">
<h3>占位 / 等待（只读预测，不会自动执行） ${badge(`${waiting.counts?.occupied ?? 0} occupied · ${waiting.counts?.waiting ?? 0} waiting`, "muted")}</h3>
<p>One row per process that currently holds a slot or is still waiting, annotated with its project/task and session/goal/job/run owner. Sources: the resource-allocation queue document plus the resource-run registry. This is a read-only projection; nothing here starts, stops, throttles or kills work.</p>
${waiting.error ? `<p class="error">${htmlEscape(waiting.error)}</p>` : ""}
<dl class="facts">${facts}</dl>
<table>
<thead><tr><th>state</th><th>status</th><th>project / task</th><th>owner</th><th>source</th><th>detail</th><th>waiting</th></tr></thead>
<tbody>${rows || '<tr><td colspan="7" class="muted">nothing occupied or waiting</td></tr>'}</tbody>
</table>
</section>`;
}

function renderOrphans(orphans) {
	if (orphans.length === 0) return "";
	const rows = orphans
		.map((p) => {
			const danger = p.inDshWeb === true;
			return `<tr class="${danger ? "danger" : ""}"><td>${htmlEscape(p.pid)}</td><td>${htmlEscape(p.ppid)}</td><td>${htmlEscape(p.comm)}</td><td>${htmlEscape(p.cgroup ?? "?")}</td><td>${htmlEscape(formatOwner(p.owner ?? (p.sessionId ? { sessionId: p.sessionId } : null)))}</td><td>${danger ? badge("dsh-web cgroup — 会被重启杀掉", "bad") : "—"}</td><td class="cmd">${htmlEscape(formatArgv(p.argv))}</td></tr>`;
		})
		.join("");
	return `<section class="orphans">
<h3>unmanaged / orphan ${badge("observe only", "orphan")}</h3>
<p>Not owned by any project unit: displayed, never killed. Processes under the <code>dsh-web.service</code> cgroup are marked red — a dsh-web restart (including crash auto-restarts) kills its whole cgroup, which is exactly how solve49-cadical / solve-n-cadical died. Adopt them into a project unit, or relaunch them via resource_run, to give them a real owner.</p>
<table>
<thead><tr><th>pid</th><th>ppid</th><th>comm</th><th>cgroup</th><th>owner</th><th>restart risk</th><th>command</th></tr></thead>
<tbody>${rows}</tbody>
</table>
</section>`;
}

function renderProject(project) {
	const fleetClass = fleetStatusClass(project.fleet);
	const taskRows = project.tasks
		.map((task) => `<tr><td>${htmlEscape(task.id)}</td><td>${htmlEscape(task.kind)}</td><td>${task.enabled ? "yes" : "no"}</td><td>${htmlEscape(task.priority)}</td><td>${htmlEscape(task.systemdUnit ?? "—")}</td></tr>`)
		.join("");
	return `<section class="project">
<h2>${htmlEscape(project.project.name)} <span class="muted">(${htmlEscape(project.project.id)} · revision ${htmlEscape(project.revision)})</span> ${badge(project.fleet === null ? "no fleet" : project.fleet.error ? "fleet error" : project.fleet.status, fleetClass)}</h2>
${project.project.description ? `<p class="muted">${htmlEscape(project.project.description)}</p>` : ""}
<h3>tasks</h3>
<table>
<thead><tr><th>task</th><th>kind</th><th>enabled</th><th>priority</th><th>systemd unit</th></tr></thead>
<tbody>${taskRows || '<tr><td colspan="5" class="muted">no tasks declared</td></tr>'}</tbody>
</table>
<h3>session ownership</h3>
${renderSessions(project.sessions ?? [], project.unassigned ?? null, { title: "sessions in this project" })}
<h3>long-task runs (resource_run)</h3>
${renderRuns(project.runs)}
<h3>fleet projection (desired / actual)</h3>
${renderFleet(project.fleet)}
<h3>adopted units (observe)</h3>
${renderAdopts(project.adopts)}
${renderOrphans(project.orphans)}
</section>`;
}

/** Build the full HTML fallback page (self-refreshing, no client bundle). */
export function renderHtml(observation, { refreshSeconds = 15 } = {}) {
const projects = (observation.projects ?? []).map(renderProject).join("\n");
const waiting = renderWaiting(observation.waiting);
const sessions = renderSessions(observation.sessions, observation.unassigned);
const unassigned = renderUnassigned(observation.unassigned);
const registryError = observation.registry?.error;
const heading = registryError
? `<p class="error">${htmlEscape(registryError)}</p>`
: projects || '<p class="muted">no projects registered</p>';
const refresh = Number.isFinite(Number(refreshSeconds)) ? Math.max(1, Math.min(3600, Math.floor(Number(refreshSeconds)))) : 15;
const truncated = observation.truncated === true
? '<p class="warn">One or more lists were truncated for a bounded response; see <code>bounds.report</code> in the JSON projection.</p>'
: "";
return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="${refresh}">
<title>Resource allocation / projects</title>
<style>
:root { color-scheme: light dark; }
body { font: 13px/1.5 system-ui, sans-serif; margin: 0; padding: 16px; max-width: 1200px; }
h1 { font-size: 16px; margin: 0 0 12px; }
h2 { font-size: 14px; margin: 12px 0 8px; }
h3 { font-size: 13px; margin: 10px 0 6px; opacity: .85; }
.project { border: 1px solid #8884; border-radius: 8px; padding: 12px; margin: 12px 0; }
.unit { border-left: 3px solid #8885; padding-left: 10px; margin: 8px 0; }
.orphans, .unassigned { border-left: 3px solid #cf222e; background: #cf222e12; padding: 8px 10px; margin: 8px 0; border-radius: 0 8px 8px 0; }
.waiting { border-left: 3px solid #bf8700; background: #bf870012; padding: 8px 10px; margin: 8px 0; border-radius: 0 8px 8px 0; }
.sessions { border-left: 3px solid #0969da; background: #0969da0d; padding: 8px 10px; margin: 8px 0; border-radius: 0 8px 8px 0; }
.facts { display: grid; grid-template-columns: max-content 1fr; gap: 2px 10px; margin: 0 0 10px; }
.facts dt { opacity: .6; }
.facts dd { margin: 0; word-break: break-all; }
table { border-collapse: collapse; width: 100%; }
th, td { border-bottom: 1px solid #8883; padding: 3px 6px; text-align: left; vertical-align: top; }
td.cmd { word-break: break-all; opacity: .85; }
.badge { padding: 1px 7px; border-radius: 999px; font-size: 12px; }
.badge.ok { background: #2da44e33; color: #2da44e; }
.badge.warn { background: #bf870033; color: #bf8700; }
.badge.bad { background: #cf222e33; color: #cf222e; }
.badge.muted { background: #8883; }
.badge.orphan { background: #cf222e33; color: #cf222e; }
.error { color: #cf222e; }
.warn { color: #bf8700; }
.muted { opacity: .6; }
tr.danger td { background: #cf222e14; color: #cf222e; }
</style>
</head>
<body>
<h1>Resource allocation / projects</h1>
<p class="muted">Registry: ${htmlEscape(observation.registry?.path ?? "?")} · revision ${htmlEscape(observation.registry?.revision ?? "?")} · observed at ${htmlEscape(formatTimestamp(observation.at))}</p>
${truncated}${sessions}${unassigned}${waiting}
${heading}
<p class="muted">Adoption is observe-mode only (no start/stop/restart/disable of project units) and orphans are never killed. Managed lifecycle (resource_run / resource_stop) applies exclusively to resource-allocation's own transient units. Registry writes are CAS-guarded; queue data is a read-only forecast and never auto-executed.</p>
</body>
</html>`;
}
