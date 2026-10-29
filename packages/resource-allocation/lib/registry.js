/**
 * The resource-allocation project registry: the persisted fact source at
 * `$DSH_HOME/storages/resource-allocation/projects.json`.
 *
 * Registry document shape:
 *
 * ```json
 * {
 *   "schemaVersion": 1,
 *   "revision": 4,
 *   "updatedAt": 1786895015321,
 *   "projects": [
 *     {
 *       "id": "math",
 *       "revision": 2,
 *       "updatedAt": 1786895015321,
 *       "manifest": { ...project-manifest.schema.json... }
 *     }
 *   ]
 * }
 * ```
 *
 * Concurrency rules (ops-generalization §2): every write goes through an
 * atomic durable replace (temp file + fsync + rename) and a compare-and-swap
 * on the per-project `revision`. A writer passes the revision it read; if the
 * file has moved on, the write fails with `code: "conflict"` and the caller
 * re-reads and retries. The top-level `revision` is monotonic across every
 * write, including removals.
 *
 * The registry holds manifests only — live process facts are never
 * persisted here (they are transient and belong to the observation
 * projection, ops-generalization §2).
 *
 * @module resource-allocation/registry
 */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { validateManifest } from "./manifest.js";

export const REGISTRY_SCHEMA_VERSION = 1;
export const REGISTRY_FILE_NAME = "projects.json";

/** Read a file if present, returning null on any failure. */
function tryRead(path) {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

/**
 * Atomic durable write: temp file + fsync + rename, then no leftover temp
 * files. The incident lesson (unflushed writes die with hard power-off)
 * applies to the project registry exactly as it does to every other fact
 * source.
 */
export function writeFileDurable(path, text) {
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
	mkdirSync(dirname(path), { recursive: true });
	let fd = -1;
	try {
		fd = openSync(tmp, "w");
		writeFileSync(fd, text, { encoding: "utf8" });
		try {
			fsyncSync(fd);
		} catch {
			/* best effort */
		}
	} finally {
		if (fd >= 0) {
			try {
				closeSync(fd);
			} catch {
				/* best effort */
			}
		}
	}
	renameSync(tmp, path);
}

/** Build an empty registry document (used when the file does not exist yet). */
export function emptyRegistryDoc(now = Date.now()) {
	return {
		schemaVersion: REGISTRY_SCHEMA_VERSION,
		revision: 0,
		updatedAt: now,
		projects: []
	};
}

/**
 * Structural validation of a registry document. A fact source is never
 * silently repaired: a corrupt file surfaces as an error and every write is
 * refused until the operator fixes or removes it.
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateRegistryDoc(doc) {
	const errors = [];
	if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return { ok: false, errors: ["registry document is not an object"] };
	if (doc.schemaVersion !== REGISTRY_SCHEMA_VERSION) errors.push(`registry schemaVersion must be ${REGISTRY_SCHEMA_VERSION} (got ${doc.schemaVersion})`);
	if (!Number.isInteger(doc.revision) || doc.revision < 0) errors.push(`registry revision invalid: ${doc.revision}`);
	if (!Number.isInteger(doc.updatedAt) || doc.updatedAt < 0) errors.push(`registry updatedAt invalid: ${doc.updatedAt}`);
	if (!Array.isArray(doc.projects)) errors.push("registry projects must be an array");
	else {
		const seen = new Set();
		for (const entry of doc.projects) {
			if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
				errors.push("registry project entry must be an object");
				continue;
			}
			if (typeof entry.id !== "string" || entry.id.length === 0) errors.push("registry project entry id must be a non-empty string");
			else if (seen.has(entry.id)) errors.push(`duplicate registry project id: ${entry.id}`);
			else seen.add(entry.id);
			if (!Number.isInteger(entry.revision) || entry.revision < 1) errors.push(`project ${entry.id ?? "?"} revision invalid: ${entry.revision}`);
			if (!Number.isInteger(entry.updatedAt) || entry.updatedAt < 0) errors.push(`project ${entry.id ?? "?"} updatedAt invalid: ${entry.updatedAt}`);
			if (entry.monitored !== undefined && typeof entry.monitored !== "boolean") errors.push(`project ${entry.id ?? "?"} monitored must be a boolean when present`);
			if (entry.taskMonitors !== undefined) {
				if (typeof entry.taskMonitors !== "object" || entry.taskMonitors === null || Array.isArray(entry.taskMonitors)) errors.push(`project ${entry.id ?? "?"} taskMonitors must be an object when present`);
				else for (const [taskId, value] of Object.entries(entry.taskMonitors)) if (typeof value !== "boolean") errors.push(`project ${entry.id ?? "?"} taskMonitors.${taskId} must be a boolean`);
			}
			const check = validateManifest(entry.manifest);
			for (const error of check.errors) errors.push(`project ${entry.id ?? "?"}: ${error}`);
		}
	}
	return { ok: errors.length === 0, errors };
}

/**
 * The persisted project registry. One instance per storage directory;
 * reads always hit the file so concurrent instances in the same process
 * observe each other's CAS writes.
 */
export class ProjectRegistry {
	constructor({ dir, now = () => Date.now() } = {}) {
		this.dir = dir;
		this.path = join(dir, REGISTRY_FILE_NAME);
		this.now = now;
	}

	/**
	 * Load the registry document from disk. A missing file is initialized as
	 * an empty registry (durably persisted); a corrupt file is returned as
	 * `error` and never overwritten.
	 * @returns {{doc: object, path: string, error?: string}}
	 */
	load() {
		const text = tryRead(this.path);
		if (text === null) {
			const doc = emptyRegistryDoc(this.now());
			try {
				writeFileDurable(this.path, JSON.stringify(doc, null, 2));
			} catch (error) {
				return { doc, path: this.path, error: `cannot create registry: ${String(error?.message ?? error)}` };
			}
			return { doc, path: this.path };
		}
		let parsed = null;
		try {
			parsed = JSON.parse(text);
		} catch {
			return { doc: null, path: this.path, error: `registry ${this.path} is not valid JSON` };
		}
		const check = validateRegistryDoc(parsed);
		if (!check.ok) return { doc: null, path: this.path, error: `registry ${this.path} is corrupt: ${check.errors.join("; ")}` };
		return { doc: parsed, path: this.path };
	}

	/** List project entries ({id, revision, updatedAt, manifest}). */
	list() {
		const loaded = this.load();
		if (loaded.doc === null) return [];
		return loaded.doc.projects;
	}

	/** Get one project entry, or null. */
	get(projectId) {
		return this.list().find((entry) => entry.id === projectId) ?? null;
	}

	/**
	 * Compare-and-swap upsert of a project manifest.
	 *
	 * `expectedRevision` semantics: omitted / null / 0 means "the project
	 * must not exist yet" (create); a positive integer must equal the
	 * project's current revision (update), otherwise the write fails with
	 * `code: "conflict"` and the current revision is reported.
	 *
	 * @returns {{ok: true, projectRevision, registryRevision, entry} | {ok: false, code, currentRevision?, errors?}}
	 */
	upsert(manifest, { expectedRevision } = {}) {
		const loaded = this.load();
		if (loaded.doc === null) return { ok: false, code: "corrupt", errors: [loaded.error] };
		const check = validateManifest(manifest);
		if (!check.ok) return { ok: false, code: "invalid", errors: check.errors };
		const projectId = manifest.project.id;
		const existing = loaded.doc.projects.find((entry) => entry.id === projectId) ?? null;
		const expected = expectedRevision === undefined || expectedRevision === null ? 0 : expectedRevision;
		if (existing === null) {
			if (expected !== 0) {
				return { ok: false, code: "conflict", currentRevision: 0, errors: [`project ${projectId} does not exist; expectedRevision must be 0 to create`] };
			}
		} else if (expected !== existing.revision) {
			return { ok: false, code: "conflict", currentRevision: existing.revision, errors: [`project ${projectId} revision moved: expected ${expected}, current ${existing.revision}`] };
		}
		const now = this.now();
		const entry = {
			id: projectId,
			revision: (existing?.revision ?? 0) + 1,
			updatedAt: now,
			manifest,
			monitored: existing?.monitored !== false,
			taskMonitors: existing?.taskMonitors ?? {}
		};
		const next = {
			schemaVersion: REGISTRY_SCHEMA_VERSION,
			revision: loaded.doc.revision + 1,
			updatedAt: now,
			projects: [
				...loaded.doc.projects.filter((item) => item.id !== projectId),
				entry
			].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
		};
		const docCheck = validateRegistryDoc(next);
		if (!docCheck.ok) return { ok: false, code: "invalid", errors: docCheck.errors };
		try {
			writeFileDurable(this.path, JSON.stringify(next, null, 2));
		} catch (error) {
			return { ok: false, code: "io", errors: [String(error?.message ?? error)] };
		}
		return { ok: true, projectRevision: entry.revision, registryRevision: next.revision, entry };
	}

	/**
	 * Persist project/task monitoring visibility. This is deliberately separate
	 * from `enabled`: a paused-monitor task is still part of the desired state
	 * and can still be started explicitly; it is only omitted from the default
	 * monitoring tree. A project-level false hides the project until restored.
	 */
	setMonitoring(projectId, { taskId = null, monitored, expectedRevision } = {}) {
		if (typeof monitored !== "boolean") return { ok: false, code: "invalid", errors: ["monitored must be a boolean"] };
		const loaded = this.load();
		if (loaded.doc === null) return { ok: false, code: "corrupt", errors: [loaded.error] };
		const existing = loaded.doc.projects.find((entry) => entry.id === projectId) ?? null;
		if (existing === null) return { ok: false, code: "not-found", errors: [`project ${projectId} does not exist`] };
		if (expectedRevision !== undefined && expectedRevision !== null && expectedRevision !== existing.revision) {
			return { ok: false, code: "conflict", currentRevision: existing.revision, errors: [`project ${projectId} revision moved: expected ${expectedRevision}, current ${existing.revision}`] };
		}
		const now = this.now();
		const nextEntry = taskId === null || taskId === undefined
			? { ...existing, monitored, revision: existing.revision + 1, updatedAt: now }
			: {
				...existing,
				taskMonitors: { ...(existing.taskMonitors ?? {}), [String(taskId)]: monitored },
				revision: existing.revision + 1,
				updatedAt: now
			};
		if (taskId !== null && taskId !== undefined) {
			const tasks = Array.isArray(existing.manifest?.tasks) ? existing.manifest.tasks : [];
			if (!tasks.some((task) => task.id === taskId)) return { ok: false, code: "not-found", errors: [`task ${taskId} does not exist in project ${projectId}`] };
		}
		const next = {
			schemaVersion: REGISTRY_SCHEMA_VERSION,
			revision: loaded.doc.revision + 1,
			updatedAt: now,
			projects: loaded.doc.projects.map((entry) => entry.id === projectId ? nextEntry : entry)
		};
		const check = validateRegistryDoc(next);
		if (!check.ok) return { ok: false, code: "invalid", errors: check.errors };
		try {
			writeFileDurable(this.path, JSON.stringify(next, null, 2));
		} catch (error) {
			return { ok: false, code: "io", errors: [String(error?.message ?? error)] };
		}
		return { ok: true, projectRevision: nextEntry.revision, registryRevision: next.revision, entry: nextEntry };
	}

	/**
	 * CAS removal of a project. The expected revision must match the current
	 * project revision; removal bumps the top-level revision.
	 */
	remove(projectId, { expectedRevision } = {}) {
		const loaded = this.load();
		if (loaded.doc === null) return { ok: false, code: "corrupt", errors: [loaded.error] };
		const existing = loaded.doc.projects.find((entry) => entry.id === projectId) ?? null;
		if (existing === null) return { ok: false, code: "conflict", errors: [`project ${projectId} does not exist`] };
		if (expectedRevision !== undefined && expectedRevision !== null && expectedRevision !== existing.revision) {
			return { ok: false, code: "conflict", currentRevision: existing.revision, errors: [`project ${projectId} revision moved: expected ${expectedRevision}, current ${existing.revision}`] };
		}
		const next = {
			schemaVersion: REGISTRY_SCHEMA_VERSION,
			revision: loaded.doc.revision + 1,
			updatedAt: this.now(),
			projects: loaded.doc.projects.filter((item) => item.id !== projectId)
		};
		try {
			writeFileDurable(this.path, JSON.stringify(next, null, 2));
		} catch (error) {
			return { ok: false, code: "io", errors: [String(error?.message ?? error)] };
		}
		return { ok: true, registryRevision: next.revision };
	}
}
