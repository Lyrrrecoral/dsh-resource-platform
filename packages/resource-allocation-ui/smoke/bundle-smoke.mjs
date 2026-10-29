/**
 * Browser-bundle smoke for resource-allocation-ui WITHOUT a browser:
 *
 *  1. loads lib/client.js exactly like the shell kernel does
 *     (window.__ModuleLoader__.load captures the spec, the factory runs
 *     against stubbed react/jsx-runtime/primitives require calls), so a
 *     syntax error or a top-level require miss fails here;
 *  2. applies the plugin against a stub ctx (locale + slots) and asserts the
 *     `conversation.view` registration shape (id "resources", order 20, bilingual
 *     dictionaries, label factory) — the contract the real web UI tab ring
 *     consumes;
 *  3. runs the ResourcesView/GuardView/ProjectsView render paths with a stubbed
 *     fetch over fake /resources/hardware.json and /resources/projects.json payloads (a
 *     fake-react hook holder) so a runtime error in the render tree fails
 *     here instead of a white tab in the browser.
 *
 * Usage: node smoke/bundle-smoke.mjs [path-to-client.js]
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const clientPath = process.argv[2] ?? join(here, "..", "lib", "client.js");
const packagePath = join(here, "..", "package.json");
const source = readFileSync(clientPath, "utf8");
const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));

let ok = true;
const check = (label, condition) => {
	console.log(`${condition ? "ok" : "FAIL"}   ${label}`);
	if (!condition) ok = false;
};

// ── 1. bundle loads like the shell kernel ──────────────────────────────────
let captured = null;
const fakeWindow = {
	__ModuleLoader__: {
		load: (spec) => {
			captured = spec;
		}
	}
};
// eslint-disable-next-line no-new-func
new Function("window", source)(fakeWindow);
check("window.__ModuleLoader__.load captured the bundle spec", captured !== null && captured.id === "resource-allocation-ui");
check("package identity is resource-allocation-ui@1.0.x", packageJson.name === "resource-allocation-ui" && /^1\.0\.\d+$/.test(packageJson.version));

// stub react/jsx-runtime: jsx(type, props, key) — children live in props
const jsx = (type, props, key) => ({ type, props, key });
const jsxs = (type, props, key) => ({ type, props, key });
const Fragment = "Fragment";

// fake-react: index-based hook holder (setState supports functional updates)
const hookState = [];
let hookIndex = 0;
const resetHooks = () => {
	hookIndex = 0;
};
const useState = (initial) => {
	const index = hookIndex++;
	if (!(index in hookState)) hookState[index] = initial;
	return [hookState[index], (next) => {
		hookState[index] = typeof next === "function" ? next(hookState[index]) : next;
	}];
};
const useCallback = (fn) => fn;
const useRef = (initial) => {
	const index = hookIndex++;
	if (!(index in hookState)) hookState[index] = { current: initial };
	return hookState[index];
};
const useEffect = (fn) => {
	try {
		fn();
	} catch {
		/* render smoke only */
	}
};

const react = { useState, useCallback, useRef, useEffect };
// the auto-refresh hook registers an interval; stub timers so the smoke
// process exits (the fetch effects themselves run synchronously below)
globalThis.setInterval = () => 0;
globalThis.clearInterval = () => {};
// primitives: every named export is a dummy component that ECHOES its props,
// so the smoke can walk into Pill/Button/Icon children the way React would
// (a null-returning stub would hide the rendered labels from the checks).
const primitives = new Proxy({}, {
	get: (_target, key) => {
		if (typeof key !== "string") return undefined;
		return (props) => ({ type: `stub:${key}`, props: props ?? {} });
	}
});

const requireStub = (id) => {
	if (id === "react/jsx-runtime") return { jsx, jsxs, Fragment };
	if (id === "react") return react;
	if (id === "@deepseek-ai/dsh-client-ui-primitives") return primitives;
	throw new Error(`unexpected require: ${id}`);
};

const bundle = captured.factory(requireStub);
check("bundle exports.inject = [slots, locale]", JSON.stringify(bundle.inject) === JSON.stringify(["slots", "locale"]));
check("bundle exports.apply is a function", typeof bundle.apply === "function");

// ── 2. apply against a stub ctx: locale dicts + slot registration ──────────
const registrations = [];
const dictRegs = [];
const injectedStyles = [];
const storage = new Map([["dsh-ops-notes", "1"]]);
globalThis.localStorage = {
getItem: (key) => storage.has(key) ? storage.get(key) : null,
setItem: (key, value) => { storage.set(key, String(value)); },
removeItem: (key) => { storage.delete(key); }
};
const fakeDocument = {
body: { dataset: {} },
head: { appendChild: (element) => { injectedStyles.push(element); } },
getElementById: () => null,
createElement: (tagName) => ({ tagName, id: "", textContent: "" })
};
let activeDicts = {};
const fakeCtx = {
	effect: (fn, label) => {
		fn();
		return () => {};
	},
	locale: {
		register: (ns, dicts) => {
			dictRegs.push({ ns, dicts });
			activeDicts = dicts;
			return () => {};
		},
		bind: () => (key) => (activeDicts?.zh?.[key] ?? key)
	},
	slots: {
		inject: (name, callback) => {
			callback();
			return () => {};
		},
		register: (opts, component) => {
			registrations.push({ opts, component });
			return () => {};
		}
	}
};
globalThis.document = fakeDocument;
bundle.apply(fakeCtx);

check("apply probe: document.body.dataset.resourceAllocation === applied", fakeDocument.body.dataset.resourceAllocation === "applied");
check("width-handle hiding style is installed under the new root selector", injectedStyles.length === 1 && injectedStyles[0].id === "resource-allocation-hide-width-handle" && String(injectedStyles[0].textContent).includes("[data-resource-allocation-root]") && String(injectedStyles[0].textContent).includes("_widthHandle"));
check("one locale namespace registered as 'resources'", dictRegs.length === 1 && dictRegs[0].ns === "resources");
const zhKeys = Object.keys(dictRegs[0].dicts.zh).sort();
const enKeys = Object.keys(dictRegs[0].dicts.en).sort();
check("bilingual balance: identical zh/en key sets", JSON.stringify(zhKeys) === JSON.stringify(enKeys));
check("zh view label is '资源'", dictRegs[0].dicts.zh["view.resources"] === "资源");
check("en view label is 'Resources'", dictRegs[0].dicts.en["view.resources"] === "Resources");
check("zh tabs are 硬件 / 资源监控", dictRegs[0].dicts.zh["tab.guard"] === "硬件" && dictRegs[0].dicts.zh["tab.monitor"] === "资源监控");
check("en tabs are Hardware / Resource monitor", dictRegs[0].dicts.en["tab.guard"] === "Hardware" && dictRegs[0].dicts.en["tab.monitor"] === "Resource monitor");
check("read-only forecast copy exists in both languages", dictRegs[0].dicts.zh["projects.readOnlyForecast"].includes("只读预测") && dictRegs[0].dicts.en["projects.readOnlyForecast"].includes("read-only forecast"));
check("session summary keys exist in both languages", dictRegs[0].dicts.zh["projects.sessions"] === "会话摘要" && dictRegs[0].dicts.en["projects.sessions"] === "Session summary");
check("no Queue tab key exists", !Object.keys(dictRegs[0].dicts.zh).some((key) => /queue.*tab|tab.*queue/i.test(key)) && !Object.keys(dictRegs[0].dicts.en).some((key) => /queue.*tab|tab.*queue/i.test(key)));
check("one conversation.view registration", registrations.length === 1);
const { opts, component } = registrations[0];
check("registration: name conversation.view", opts.name === "conversation.view");
check("registration: id resources", opts.id === "resources");
check("registration: order 20 (after chat 0 and trajectory 10)", opts.order === 20);
check("registration: locale namespace", opts.locale === "resources");
check("registration: label factory resolves to '资源'", typeof opts.label === "function" && opts.label() === "资源");
check("registered component is a function", typeof component === "function");
const tabButtonCalls = [...source.matchAll(/tabButton\("([^"]+)"/g)].map((match) => match[1]);
check("exactly two tabs are declared (hardware + resource monitor)", JSON.stringify(tabButtonCalls) === JSON.stringify(["guard", "monitor"]));

// ── 3. render paths with stubbed fetch (fake /resources payloads) ──────────
const GiB = 1024 ** 3;
const guardFixture = {
	at: Date.now(),
	control: { schemaVersion: 1, enabled: true, revision: 2, reason: "", updatedBy: "", updatedAt: Date.now(), error: null },
	enforcement: "active",
	enforcementActive: true,
	budget: {
		cpuCount: 4, cpuBudgetCores: 4, cpuReservedCores: 0,
		memBudgetBytes: 16 * GiB, perCommandMemCapBytes: 1610612736,
		memoryRunawayBytes: 4 * GiB, maxBackgroundJobs: 2, niceLevel: 10
	},
	pressure: {
		state: "ok", freeBytes: 12 * GiB, load1: 1.2,
		warnLoad: 4, critLoad: 8, warnMemBytes: 4 * GiB, critMemBytes: 2 * GiB,
		hysteresis: { warnExitLoad: 4.8, critExitLoad: 6, warnExitMemBytes: 5 * GiB, critExitMemBytes: 3 * GiB, minStateMs: 30000 }
	},
	memoryCapPolicy: "none",
	adaptations: {
		applied: [],
		pending: [{
			id: "p1",
			rule: "critical-restart-reserve",
			createdAt: Date.now(),
			reason: "reserve more headroom",
			cap: "pending only",
			needsHuman: true,
			options: [
				{ label: "primary", description: "reserve a core", changes: [{ target: "budget", field: "cpuReservedCores", op: "delta", delta: 1 }] },
				{ label: "alternative", description: "shrink budget", changes: [{ target: "config", field: "memSafetyFrac", op: "delta", delta: -0.05 }] }
			]
		}],
		watchlist: []
	},
	incidents: [{ at: "2026-08-17T12:00:00.000Z", atMs: 1, kind: "boot" }],
	cleanup: {
		enabled: true,
		roots: ["/tmp/project-root"],
		minSizeBytes: 67108864,
		softDelete: true,
		excludeDirs: [".git", "node_modules"],
		trashDir: "$DSH_HOME/storages/hardware-guard/trash",
		lastPlan: {
			id: "plan-1",
			generatedAt: Date.now(),
			roots: ["/tmp/project-root"],
			candidates: [{ path: "/tmp/project-root/junk.bin", root: "/tmp/project-root", sizeBytes: 73400320, mtimeMs: 1, ageMs: 3600000 }],
			totalBytes: 73400320,
			scannedFiles: 10,
			skippedDirs: 3,
			truncated: false,
			softDelete: true,
			status: "pending",
			errors: []
		}
	}
};
const projectsFixture = {
	at: Date.now(),
	registry: { path: "/x/registry.json", revision: 1, updatedAt: Date.now() },
	unitFacts: {},
	runs: null,
	waiting: {
		at: Date.now(),
		path: "$DSH_HOME/storages/resource-allocation/queue.json",
		error: null,
		scheduler: {
			revision: 9,
			updatedAt: Date.now(),
			capacity: { pressure: "warn", headroomCpuCores: 0, headroomMemBytes: 0, sampledAt: Date.now() },
			lastDecision: { revision: 9, action: "throttle", reason: "pressure warn", by: "resource-allocation", at: Date.now() }
		},
		counts: { occupied: 1, waiting: 3, scheduler: 2, runs: 1, unassigned: 1 },
		entries: [
			{
				id: "occ-1", source: "scheduler", state: "occupied", status: "running",
				priority: 80, owner: { sessionId: "s1", goalId: "g1", jobId: "j1", runId: "r1" }, request: { cpuCores: 2, memBytes: 2 * GiB },
				deadlineAt: null, reason: null, submittedAt: Date.now() - 60000, waitingMs: 60000,
				unit: null, pid: null, command: null,
				projectId: "math", projectName: "math", taskId: "solve", projectKnown: true, taskKnown: true, taskKind: "compute-batch", taskSystemdUnit: null
			},
			{
				id: "wait-1", source: "scheduler", state: "waiting", status: "queued",
				priority: 60, owner: { sessionId: "s2" }, request: { cpuCores: 1, memBytes: GiB },
				deadlineAt: null, reason: null, submittedAt: Date.now() - 5000, waitingMs: 5000,
				unit: null, pid: null, command: null,
				projectId: "math", projectName: "math", taskId: "solve", projectKnown: true, taskKnown: true, taskKind: "compute-batch", taskSystemdUnit: null
			},
			{
				id: "run-1", source: "resource-run", state: "waiting", status: "queued",
				priority: null, owner: { sessionId: "s3" }, request: null,
				deadlineAt: null, reason: null, submittedAt: Date.now() - 1000, waitingMs: 1000,
				unit: "resource-x.service", pid: 4242, command: ["sleep", "60"],
				projectId: "ghost", projectName: null, taskId: "nope", projectKnown: false, taskKnown: false, taskKind: null, taskSystemdUnit: null
			}
		],
		unassigned: [{
			id: "unassigned-1", source: "scheduler", state: "waiting", status: "queued",
			priority: null, owner: null, request: null,
			deadlineAt: null, reason: null, submittedAt: Date.now() - 2000, waitingMs: 2000,
			unit: null, pid: null, command: null,
			projectId: null, projectName: null, taskId: null, projectKnown: false, taskKnown: false,
			taskKind: null, taskSystemdUnit: null, unassigned: true
		}]
	},
	projects: [{
		project: { id: "math", name: "math", description: null },
		revision: 3,
		updatedAt: Date.now(),
		tasks: [{ id: "repair", kind: "supervisor", enabled: true, priority: 50, systemdUnit: "demo-supervisor.service" }],
		fleet: { status: "ok", desired: [], actual: [], missing: [], extra: [] },
		sessions: [
			{ sessionId: "s1", runs: 1, queueItems: 1, orphans: 0, lastSeen: Date.now() - 30000 },
			{ sessionId: "s2", runs: 0, queueItems: 1, orphans: 0, lastSeen: Date.now() - 5000 },
			{ sessionId: null, runs: 0, queueItems: 0, orphans: 1, lastSeen: null }
		],
		adopts: [{
			name: "demo-supervisor.service",
			kind: "systemd-unit",
			mode: "observe",
			adoptedAt: null,
			ok: true,
			error: null,
			facts: { activeState: "active", subState: "running", mainPid: 1, controlGroup: "/system.slice/x" },
			chain: [{ pid: 1, ppid: 0, comm: "systemd", cgroup: "/system.slice/x", argv: ["systemd"] }]
		}],
		orphans: [
			{ pid: 62880, ppid: 62879, comm: "solver", cgroup: "/system.slice/dsh-web.service", sessionId: "session-x", argv: ["solver", "cnf"], inDshWeb: true },
			{ pid: 90001, ppid: 1, comm: "cadical", cgroup: "/system.slice/other.service", sessionId: null, argv: ["cadical"], inDshWeb: false }
		],
		runs: [{
			id: "run-1", taskId: "solve", owner: { kind: "goal", goalId: "g", sessionId: "s" },
			command: ["sleep", "60"], limits: {}, unit: "x.service", pid: 42, cgroup: null,
			status: "running", startedAt: Date.now(), finishedAt: null, exitCode: null, reason: null, revision: 1, durationMs: 1000
		}]
	}],
	discovered: {
		at: Date.now(),
		enabled: true,
		roots: ["/workspace/projects"],
		errors: [],
		counts: { unregistered: 1, registered: 1, invalid: 0, missing: 1 },
		items: [
			{ path: "/workspace/projects/sample/project.json", dir: "/workspace/projects/sample", projectId: "sample", name: "Sample project", description: "Sample project description", taskCount: 4, adoptCount: 0, status: "unregistered", registeredRevision: null },
			{ path: "/workspace/projects/demo-project/project.json", dir: "/workspace/projects/demo-project", projectId: "demo-project", name: "Demo project", description: null, taskCount: 9, adoptCount: 1, status: "registered", registeredRevision: 2 },
			{ path: "/workspace/projects/empty/project.json", dir: "/workspace/projects/empty", projectId: null, name: null, description: null, taskCount: 0, adoptCount: 0, status: "missing", registeredRevision: null }
		]
	}
};


const processUsageFixture = {
	ok: true, at: Date.now(), scope: "system", sessionId: null, sort: "rss", limit: 20, sampleMs: 120,
	processes: [
		{ pid: 4242, ppid: 1, comm: "solver", state: "R", rssBytes: 3 * GiB, cpuPct: 87.5, sessionId: "s1", cgroup: "/system.slice/resource.service", inDshWeb: false, command: "/opt/solver input.cnf" },
		{ pid: 4343, ppid: 1, comm: "node", state: "S", rssBytes: 512 * 1024 ** 2, cpuPct: 3.2, sessionId: "s2", cgroup: "/system.slice/dsh-web.service", inDshWeb: true, command: "node app.js" }
	]
};

const fetchLog = [];
globalThis.fetch = (url, options) => {
	fetchLog.push({ url: String(url), options: options ?? null });
	if (String(url).startsWith("/resources/processes.json")) {
		return Promise.resolve({ ok: true, status: 200, text: async () => JSON.stringify(processUsageFixture) });
	}
	if (url === "/resources/hardware") {
		return Promise.resolve({
			ok: true,
			status: 200,
			text: async () => JSON.stringify({ ok: true, text: "done", control: guardFixture.control, adaptations: guardFixture.adaptations })
		});
	}
	const payload = url === "/resources/hardware.json" ? guardFixture : projectsFixture;
	return Promise.resolve({ ok: true, status: 200, text: async () => JSON.stringify(payload) });
};

const t = (key) => dictRegs[0].dicts.zh[key] ?? key;

// shallow element-tree mounter: jsx stub returns lazy {type, props} nodes, so
// component functions never ran — mount() instantiates function types
// recursively AND walks children arrays (React's element reconciliation,
// minus effects/memo) so the real view code paths execute.
function mount(node) {
	if (node === null || node === undefined || typeof node !== "object") return node;
	const { type, props } = node;
	if (typeof type === "function") return mount(type(props ?? {}));
	if (props !== null && props !== undefined && Object.prototype.hasOwnProperty.call(props, "children")) {
		const { children } = props;
		if (Array.isArray(children)) {
			for (const child of children) mount(child);
		} else {
			mount(children);
		}
	}
	return node;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function nodeContains(value, needle) {
	if (value === null || value === undefined) return false;
	if (typeof value === "string") return value.includes(needle);
	if (typeof value === "number") return String(value).includes(needle);
	if (Array.isArray(value)) return value.some((child) => nodeContains(child, needle));
	if (typeof value === "object") return nodeContains(value.props?.children, needle);
	return false;
}


/**
 * Instantiate function components in tree order (same hook order as mount)
 * while keeping every resolved node, so tests can find and click real
 * rendered elements (pills, buttons). `mount` alone cannot do this because it
 * discards the resolved output of nested components.
 */
function expand(node, out) {
	if (node === null || node === undefined || typeof node !== "object") return;
	if (Array.isArray(node)) {
		for (const child of node) expand(child, out);
		return;
	}
	const { type, props } = node;
	if (typeof type === "function") {
		expand(type(props ?? {}), out);
		return;
	}
	out.push(node);
	if (props !== null && props !== undefined && Object.prototype.hasOwnProperty.call(props, "children")) {
		const { children } = props;
		if (Array.isArray(children)) {
			for (const child of children) expand(child, out);
		} else {
			expand(children, out);
		}
	}
}

/** Render one tab and return every resolved node (for interaction checks). */
function renderNodes(tabName, extra = {}) {
	resetHooks();
	if (tabName !== null) hookState[0] = tabName;
	const out = [];
	try {
		expand(component({ t, ...extra }), out);
		return { nodes: out, error: null };
	} catch (error) {
		return { nodes: out, error: String(error?.stack ?? error) };
	}
}

function renderTab(tabName) {
	resetHooks();
	if (tabName !== null) hookState[0] = tabName; // ResourcesView's tab useState slot
	try {
		return { tree: mount(component({ t })), error: null };
	} catch (error) {
		return { tree: null, error: String(error?.stack ?? error) };
	}
}

// first pass: loading state; effects fire the fetches synchronously
const first = renderTab("guard");
if (first.error) console.error("DEBUG first.error", first.error);
check("guard tab mounts the tree (loading state, no crash)", first.error === null && first.tree !== null);
await sleep(10);
// second pass: fixture payloads are in the hook holders → full data render
const loaded = renderTab("guard");
if (loaded.error) console.error("DEBUG loaded.error", loaded.error);
check("guard tab mounts the tree (data state, no crash)", loaded.error === null && loaded.tree !== null);
check("render fetched /resources/hardware.json", fetchLog.some((entry) => entry.url === "/resources/hardware.json"));

// ── Option C (方案 C：暂不改动) is offered and posts option "defer" ─────────
const deferLabel = dictRegs[0].dicts.zh["adapt.option.defer"];
const guardNodes = renderNodes("guard");
check("guard tab expands without error (node walk)", guardNodes.error === null);
// ── cleanup probe card: soft delete wording + skipped structural dirs ──────
const guardTexts = guardNodes.nodes.map((node) => node.props?.children).filter((children) => typeof children === "string");

const deferPill = guardNodes.nodes.find((node) => node.props?.children === deferLabel && typeof node.props?.onClick === "function");
check("pending adaptation offers the 方案 C：暂不改动 pill", deferPill !== undefined);
if (deferPill !== undefined) {
	deferPill.props.onClick(); // select option C — only local state changes
	const selected = renderNodes("guard");
	const hasText = (node, text) => {
		if (node === null || node === undefined) return false;
		if (typeof node === "string") return node === text;
		if (Array.isArray(node)) return node.some((child) => hasText(child, text));
		if (typeof node === "object") return hasText(node.props?.children, text);
		return false;
	};
	const deferButton = selected.nodes.find((node) => node.type === "button"
		&& typeof node.props?.onClick === "function"
		&& hasText(node.props?.children, deferLabel));
	check("selecting option C switches the confirm button to 暂不改动", deferButton !== undefined);
	if (deferButton !== undefined) {
		deferButton.props.onClick();
		await sleep(10);
		const post = fetchLog.find((entry) => entry.url === "/resources/hardware" && entry.options?.method === "POST");
		const body = post === undefined ? null : JSON.parse(post.options.body);
		check("confirming option C POSTs confirm-adapt with option=defer", body?.action === "confirm-adapt" && body?.option === "defer" && body?.adaptationId === "p1");
		check("hardware POST sends x-resource-action: 1", post?.options?.headers?.["x-resource-action"] === "1");
	}
}

// ── Resources v2: session-centred resource ledger (no project tree) ───────
const projectsFirst = renderTab("projects");
check("resource view mounts (loading state, no crash)", projectsFirst.error === null);
await sleep(10);
const projectsLoaded = renderTab("projects");
check("resource view mounts (data state, no crash)", projectsLoaded.error === null);
check("render fetched /resources/projects.json", fetchLog.some((entry) => entry.url === "/resources/projects.json"));

const projectNodes = renderNodes("projects", { currentSessionId: "s1" });
check("resource view expands without error (node walk)", projectNodes.error === null);
const texts = projectNodes.nodes.map((node) => node.props?.children).filter((children) => typeof children === "string");
const rootNodes = renderNodes("projects", { currentSessionId: "s1" });
check("resources view mounts without error", rootNodes.error === null);
const rootTexts = rootNodes.nodes.map((node) => node.props?.children).filter((children) => typeof children === "string");
check("view renders exactly two tab pills", rootNodes.nodes.filter((node) => node.type === "stub:Pill").length === 2);
check("both canvas tabs are visible: 资源监控 + 硬件", rootNodes.nodes.some((node) => nodeContains(node.props?.children, dictRegs[0].dicts.zh["tab.monitor"])) && rootNodes.nodes.some((node) => nodeContains(node.props?.children, "硬件")));
check("no project-tree or discovery surface remains", !texts.some((text) => text.includes("项目发现") || text.includes("会话摘要") || text.includes("纳入项目")));
check("resource-ledger title is visible", texts.includes(dictRegs[0].dicts.zh["monitor.title"]));
check("current-session section is rendered", texts.some((text) => text.startsWith(dictRegs[0].dicts.zh["monitor.currentSection"])));
check("other-session section is rendered", texts.some((text) => text.startsWith(dictRegs[0].dicts.zh["monitor.otherSection"])));
check("current-session occupied task is shown", projectNodes.nodes.some((node) => nodeContains(node.props?.children, "占位中")) && projectNodes.nodes.some((node) => nodeContains(node.props?.children, "math / solve")));
check("other session s2 is grouped", projectNodes.nodes.some((node) => nodeContains(node.props?.children, "s2 · 1")));

// ── on-demand process lookup (read-only) ───────────────────────────────────
const lookupButton = projectNodes.nodes.find((node) => node.type === "button" && node.props?.children === dictRegs[0].dicts.zh["projects.processLookup"]);
const lookupOpen = projectNodes.nodes.some((node) => nodeContains(node.props?.children, dictRegs[0].dicts.zh["projects.processLookupTitle"]));
check("process lookup entry/control is present", lookupOpen || (lookupButton !== undefined && typeof lookupButton.props?.onClick === "function"));
if (lookupOpen || lookupButton !== undefined) {
if (lookupButton !== undefined) lookupButton.props.onClick();
const lookupNodes = lookupButton !== undefined ? renderNodes("projects", { currentSessionId: "s1" }) : projectNodes;
const lookupTexts = lookupNodes.nodes.map((node) => node.props?.children).filter((children) => typeof children === "string");
check("process lookup opens with both scopes", lookupTexts.includes(dictRegs[0].dicts.zh["projects.processLookupTitle"]) && lookupTexts.includes(dictRegs[0].dicts.zh["projects.scopeSession"]) && lookupTexts.includes(dictRegs[0].dicts.zh["projects.scopeSystem"]));
const systemButton = lookupNodes.nodes.find((node) => node.type === "button" && node.props?.children === dictRegs[0].dicts.zh["projects.scopeSystem"]);
if (systemButton !== undefined) systemButton.props.onClick();
const afterScope = renderNodes("projects", { currentSessionId: "s1" });
const searchButton = afterScope.nodes.find((node) => node.type === "button" && (node.props?.children === dictRegs[0].dicts.zh["projects.processSearch"] || node.props?.children === dictRegs[0].dicts.zh["projects.processSearching"]));
check("system process search button is available", searchButton !== undefined && typeof searchButton.props?.onClick === "function");
if (searchButton !== undefined) {
searchButton.props.onClick();
await sleep(10);
const resultNodes = renderNodes("projects", { currentSessionId: "s1" });
check("process lookup fetches canonical endpoint", fetchLog.some((entry) => String(entry.url).startsWith("/resources/processes.json")));
check("process lookup renders ranked rows", resultNodes.nodes.some((node) => nodeContains(node.props?.children, "4242")) && resultNodes.nodes.some((node) => nodeContains(node.props?.children, "87.5")));
check("process lookup carries session identity", resultNodes.nodes.some((node) => nodeContains(node.props?.children, "s1")));
}
}

// ── stop managed task + local hide/restore ─────────────────────────────────
const beforeStop = renderNodes("projects", { currentSessionId: "s3" });
const stopButton = beforeStop.nodes.find((node) => node.type === "button" && node.props?.children === dictRegs[0].dicts.zh["projects.stopTask"]);
check("current-session managed task offers a stop-task button", stopButton !== undefined && typeof stopButton.props?.onClick === "function");
if (stopButton !== undefined) {
stopButton.props.onClick();
await sleep(10);
const post = fetchLog.filter((entry) => entry.url === "/resources/projects" && entry.options?.method === "POST").at(-1);
const body = post === undefined ? null : JSON.parse(post.options.body);
check("stop-task posts STOP to the canonical action route", body?.action === "stop-run" && body?.confirm === "STOP");
const afterStop = renderNodes("projects", { currentSessionId: "s3" });
check("stopped task is hidden locally", afterStop.nodes.some((node) => nodeContains(node.props?.children, `${dictRegs[0].dicts.zh["monitor.restore"]} (1)`)));
const restore = afterStop.nodes.find((node) => node.type === "button" && nodeContains(node.props?.children, dictRegs[0].dicts.zh["monitor.restore"]));
check("stopped task can be shown again", restore !== undefined && typeof restore.props?.onClick === "function");
if (restore !== undefined) restore.props.onClick();
}

// ── cleanup probe: extra roots, permanent delete, trash management ────────
hookState.length = 0;
renderTab("projects");
await sleep(10);
const cleanupNodes = renderNodes("projects", { currentSessionId: "s1" });
check("disk cleanup card is on the resource monitor page", cleanupNodes.nodes.some((node) => nodeContains(node.props?.children, dictRegs[0].dicts.zh["guard.cleanup"])));
const rootsInput = cleanupNodes.nodes.find((node) => node.type === "textarea");
check("cleanup extra-roots input is available", rootsInput !== undefined && typeof rootsInput.props?.onChange === "function");
const permanentButton = cleanupNodes.nodes.find((node) => node.type === "button" && nodeContains(node.props?.children, dictRegs[0].dicts.zh["guard.cleanupConfirmDelete"]));
check("cleanup offers explicit permanent delete", permanentButton !== undefined && typeof permanentButton.props?.onClick === "function");
const trashViewButton = cleanupNodes.nodes.find((node) => node.type === "button" && node.props?.children === dictRegs[0].dicts.zh["guard.cleanupTrashView"]);
check("trash management control is available", trashViewButton !== undefined && typeof trashViewButton.props?.onClick === "function");
const selectAllButton = cleanupNodes.nodes.find((node) => node.type === "button" && node.props?.children === dictRegs[0].dicts.zh["guard.cleanupSelectAll"]);
if (selectAllButton !== undefined) {
selectAllButton.props.onClick();
const selectedNodes = renderNodes("projects", { currentSessionId: "s1" });
const deleteButton = selectedNodes.nodes.find((node) => node.type === "button" && nodeContains(node.props?.children, dictRegs[0].dicts.zh["guard.cleanupConfirmDelete"]));
if (deleteButton !== undefined) deleteButton.props.onClick();
await sleep(10);
const deletePost = fetchLog.filter((entry) => entry.url === "/resources/hardware" && entry.options?.method === "POST").at(-1);
const deleteBody = deletePost === undefined ? null : JSON.parse(deletePost.options.body);
check("permanent delete posts explicit mode", deleteBody?.action === "cleanup-confirm" && deleteBody?.mode === "permanent");
}

if (rootsInput !== undefined) {
rootsInput.props.onChange({ target: { value: "/tmp/extra-output" } });
const scanNodes = renderNodes("projects", { currentSessionId: "s1" });
const scanButton = scanNodes.nodes.find((node) => node.type === "button" && node.props?.children === dictRegs[0].dicts.zh["guard.cleanupScan"]);
if (scanButton !== undefined) scanButton.props.onClick();
await sleep(10);
const rootPost = fetchLog.filter((entry) => entry.url === "/resources/hardware" && entry.options?.method === "POST").at(-1);
const rootBody = rootPost === undefined ? null : JSON.parse(rootPost.options.body);
check("cleanup scan includes configured and extra roots", rootBody?.action === "cleanup-scan" && Array.isArray(rootBody?.roots) && rootBody.roots.includes("/tmp/project-root") && rootBody.roots.includes("/tmp/extra-output"));
}
if (trashViewButton !== undefined) {
trashViewButton.props.onClick();
await sleep(10);
const trashPost = fetchLog.filter((entry) => entry.url === "/resources/hardware" && entry.options?.method === "POST").at(-1);
const trashBody = trashPost === undefined ? null : JSON.parse(trashPost.options.body);
check("trash management posts summary action", trashBody?.action === "cleanup-trash" && trashBody?.mode === "summary");
}

// ── preference migration + no legacy runtime fetches ──────────────────────
const notesNodes = renderNodes("guard");
const notesSwitch = notesNodes.nodes.find((node) => node.props?.role === "switch");
check("notes slider toggle is preserved and migrated from the legacy preference", notesSwitch !== undefined && notesSwitch.props["aria-checked"] === "true");
if (notesSwitch !== undefined) {
	notesSwitch.props.onClick();
	check("notes toggle writes the resource-allocation key", storage.get("resource-allocation-notes") === "0");
	check("notes toggle removes the legacy notes key", !storage.has("dsh-ops-notes"));
}
check("no runtime fetch targets /ops", !fetchLog.some((entry) => /^\/ops(?:\/|$)/.test(entry.url)));

// ── 4. static discipline checks on the source ──────────────────────────────
check("no emoji glyphs in the bundle", !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(source));
check("no ESM import/export statements in the client bundle", !/(^|\n)\s*import\s|\bexport\s+(const|function|default)/.test(source));
check("no JSX angle-bracket components (<Foo />)", !/<[A-Z][A-Za-z0-9]*\s*\/?>/.test(source));
check("no legacy /ops endpoint literals in runtime code", !/["'`]\/ops(?:\/|["'`])/.test(source));
check("canonical locale + data identity is used", source.includes('const NS = "resources"') && source.includes('"data-resource-allocation-root"') && source.includes("dataset.resourceAllocation"));

console.log(ok ? "CLIENT_BUNDLE_SMOKE: PASS" : "CLIENT_BUNDLE_SMOKE: FAIL");
process.exit(ok ? 0 : 1);
