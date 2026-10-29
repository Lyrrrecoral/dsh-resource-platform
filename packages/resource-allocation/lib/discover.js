/**
 * Project auto-discovery (v0.3): find project manifests that were never
 * written into the registry, so the project tree can answer "why is my
 * project missing" with a real list instead of silence.
 *
 * Discovery is READ-ONLY and never adopts anything on its own:
 *  - each configured root is scanned for the configured manifest file name
 *    (one level deep by default; `skipDirs` prunes container directories such
 *    as a nested `projects/`);
 *  - a valid manifest that is not in the registry is reported as
 *    `unregistered`;
 *  - a directory without a manifest is reported as `missing` (this is the
 *    actual reason a competition directory does not appear in the tree);
 *  - a manifest that fails schema validation is reported as `invalid` with
 *    the validator's errors.
 *
 * Registering a discovered manifest into the registry is a separate,
 * human-triggered action (`POST /resources/projects {action:"register-discovered"}`)
 * that re-reads and re-validates the file at that moment: discovery output is
 * never trusted as input, and nothing is started, stopped or adopted.
 *
 * @module resource-allocation/discover
 */
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { validateManifest } from "./manifest.js";

const DEFAULT_FILE = "project.json";
const DEFAULT_DEPTH = 1;
const DEFAULT_MAX_ENTRIES = 64;

/** Coerce the row config into a bounded discovery spec. */
export function normalizeDiscovery(config) {
	const raw = config !== null && typeof config === "object" ? config : {};
	const rootsRaw = Array.isArray(raw.roots) ? raw.roots : [];
	const roots = rootsRaw
		.filter((entry) => entry !== null && typeof entry === "object" && typeof entry.dir === "string" && entry.dir.length > 0)
		.map((entry) => ({
			dir: entry.dir,
			file: typeof entry.file === "string" && entry.file.length > 0 ? entry.file : DEFAULT_FILE,
			depth: Number.isInteger(entry.depth) && entry.depth >= 0 && entry.depth <= 3 ? entry.depth : DEFAULT_DEPTH
		}));
	const skipDirs = (Array.isArray(raw.skipDirs) ? raw.skipDirs : [])
		.filter((entry) => typeof entry === "string")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0 && entry !== "." && entry !== ".." && !entry.includes("/"));
	return {
		enabled: raw.enabled === true && roots.length > 0,
		roots,
		skipDirs,
		maxEntries: Number.isInteger(raw.maxEntries) && raw.maxEntries > 0 && raw.maxEntries <= 512 ? raw.maxEntries : DEFAULT_MAX_ENTRIES
	};
}

const defaultIo = Object.freeze({
	readdir: (dir) => readdirSync(dir, { withFileTypes: true }),
	readFile: (path) => readFileSync(path, "utf8"),
	realpath: (path) => realpathSync(path),
	isDirectory: (path) => {
		try {
			return statSync(path).isDirectory();
		} catch {
			return false;
		}
	}
});

function summarize(manifest, filePath, registered) {
	return {
		path: filePath,
		projectId: typeof manifest?.project?.id === "string" ? manifest.project.id : null,
		name: typeof manifest?.project?.name === "string" ? manifest.project.name : null,
		description: typeof manifest?.project?.description === "string" ? manifest.project.description : null,
		taskCount: Array.isArray(manifest?.tasks) ? manifest.tasks.length : 0,
		adoptCount: Array.isArray(manifest?.adopt) ? manifest.adopt.length : 0,
		status: registered === null ? "unregistered" : "registered",
		registeredRevision: registered === null ? null : registered.revision
	};
}

/**
 * One scan pass. Never throws: unreadable roots and files become `error`
 * fields on the affected item.
 *
 * @param {object} options - {discovery, registryDoc, io, now}
 * @returns {object} { at, enabled, roots, items, errors } — JSON-serializable
 */
export function discoverProjects({ discovery, registryDoc = null, io = {}, now = () => Date.now() } = {}) {
	const spec = discovery !== null && discovery !== undefined && discovery.roots !== undefined ? discovery : normalizeDiscovery(discovery);
	const adapter = { ...defaultIo, ...io };
	const at = now();
	if (spec.enabled !== true) {
		return { at, enabled: false, roots: spec.roots.map((root) => root.dir), items: [], errors: [] };
	}
	const registered = new Map();
	for (const entry of registryDoc?.projects ?? []) {
		if (entry !== null && typeof entry === "object" && typeof entry.id === "string") registered.set(entry.id, entry);
	}
	const items = [];
	const errors = [];
	for (const root of spec.roots) {
		let children;
		const skip = new Set(spec.skipDirs ?? []);
		try {
			// Hidden directories are configuration/state, never project roots
			// (a hidden manifest FILE such as .dsh-project.json is unaffected).
			children = adapter.readdir(root.dir).filter((entry) => entry.isDirectory?.() === true
				&& !skip.has(entry.name)
				&& !entry.name.startsWith("."));
		} catch (error) {
			errors.push(`${root.dir}: ${error?.code === "ENOENT" ? "root not found" : String(error?.message ?? error)}`);
			continue;
		}
		const dirs = [root.dir, ...children.map((child) => join(root.dir, child.name))];
		for (const dir of dirs) {
			if (items.length >= spec.maxEntries) break;
			const filePath = join(dir, root.file);
			let text;
			try {
				text = adapter.readFile(filePath);
			} catch (error) {
				if (error?.code === "ENOENT") {
					// reported only for child directories: a directory that looks
					// like a project but has no manifest is exactly the case this
					// feature exists to explain.
					if (dir !== root.dir) items.push({ path: filePath, dir, projectId: null, name: null, description: null, taskCount: 0, adoptCount: 0, status: "missing", registeredRevision: null });
					continue;
				}
				items.push({ path: filePath, dir, projectId: null, name: null, description: null, taskCount: 0, adoptCount: 0, status: "invalid", registeredRevision: null, error: String(error?.message ?? error) });
				continue;
			}
			let parsed;
			try {
				parsed = JSON.parse(text);
			} catch (error) {
				items.push({ path: filePath, dir, projectId: null, name: null, description: null, taskCount: 0, adoptCount: 0, status: "invalid", registeredRevision: null, error: `not valid JSON: ${String(error?.message ?? error)}` });
				continue;
			}
			const check = validateManifest(parsed);
			if (!check.ok) {
				items.push({ path: filePath, dir, projectId: parsed?.project?.id ?? null, name: parsed?.project?.name ?? null, description: null, taskCount: 0, adoptCount: 0, status: "invalid", registeredRevision: null, error: check.errors.join("; ") });
				continue;
			}
			items.push(summarize(parsed, filePath, registered.get(parsed.project.id) ?? null));
		}
	}
	items.sort((left, right) => {
		const order = { unregistered: 0, invalid: 1, missing: 2, registered: 3 };
		if (order[left.status] !== order[right.status]) return order[left.status] - order[right.status];
		return String(left.path).localeCompare(String(right.path));
	});
	return {
		at,
		enabled: true,
		roots: spec.roots.map((root) => root.dir),
		items,
		errors,
		counts: {
			unregistered: items.filter((item) => item.status === "unregistered").length,
			registered: items.filter((item) => item.status === "registered").length,
			invalid: items.filter((item) => item.status === "invalid").length,
			missing: items.filter((item) => item.status === "missing").length
		}
	};
}

/**
 * Resolve a registration request against the CURRENT discovery result: the
 * path must be a regular file that discovery itself just listed as
 * `unregistered`, inside a configured root. This is what keeps the write
 * action from becoming an arbitrary-path file reader.
 *
 * @returns {{ok: true, path: string, entry: object}|{ok: false, error: string}}
 */
export function resolveRegisterTarget({ path, discovery, registryDoc = null, io = {} }) {
	if (typeof path !== "string" || path.length === 0) return { ok: false, error: "path is required" };
	const adapter = { ...defaultIo, ...io };
	const scan = discovery !== null && discovery !== undefined && discovery.items !== undefined ? discovery : discoverProjects({ discovery, registryDoc, io: adapter });
	const wanted = resolve(path);
	const entry = (scan.items ?? []).find((item) => resolve(item.path) === wanted);
	if (entry === undefined) return { ok: false, error: "path is not a discovered manifest (rescan first)" };
	if (entry.status !== "unregistered") return { ok: false, error: `discovered manifest is ${entry.status}, not registerable` };
	let real;
	try {
		real = adapter.realpath(entry.path);
	} catch (error) {
		return { ok: false, error: `manifest unreadable: ${String(error?.message ?? error)}` };
	}
	const inside = (scan.roots ?? []).some((root) => {
		let realRoot;
		try {
			realRoot = adapter.realpath(root);
		} catch {
			return false;
		}
		return real === realRoot || real.startsWith(`${realRoot}${sep}`);
	});
	if (!inside) return { ok: false, error: "manifest resolves outside the configured discovery roots" };
	return { ok: true, path: real, entry };
}

/**
 * Read + validate the manifest at an already-resolved path (the caller
 * re-reads, never trusting the scan's cached summary).
 *
 * @returns {{ok: true, manifest: object}|{ok: false, error: string}}
 */
export function readManifestForRegistration(path, io = {}) {
	const adapter = { ...defaultIo, ...io };
	let text;
	try {
		text = adapter.readFile(path);
	} catch (error) {
		return { ok: false, error: `manifest unreadable: ${error?.code === "ENOENT" ? "file not found" : String(error?.message ?? error)}` };
	}
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		return { ok: false, error: `not valid JSON: ${String(error?.message ?? error)}` };
	}
	const check = validateManifest(parsed);
	if (!check.ok) return { ok: false, error: check.errors.join("; ") };
	return { ok: true, manifest: parsed };
}
