/**
 * Seed the project registry from an example manifest.
 *
 * Usage:
 *   node scripts/seed-project.mjs <manifest.json> [projectId]
 *
 * Reads a project-manifest.schema.json-conformant file, validates it, and
 * CAS-upserts it into $DSH_HOME/storages/resource-allocation/projects.json
 * after a one-way merge of missing legacy storages/ops files (the legacy
 * directory is never modified). The command creates the
 * project when it does not exist). Conflict with an existing revision fails
 * loudly instead of overwriting.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ProjectRegistry } from "../lib/registry.js";
import { prepareStorage } from "../lib/storage.js";
import { validateManifest } from "../lib/manifest.js";

const [manifestPath, projectIdArg] = process.argv.slice(2);
if (!manifestPath) {
	console.error("usage: node scripts/seed-project.mjs <manifest.json> [projectId]");
	process.exit(2);
}
const raw = readFileSync(resolve(manifestPath), "utf8");
let manifest;
try {
	manifest = JSON.parse(raw);
} catch (error) {
	console.error(`seed: ${manifestPath} is not valid JSON: ${error.message}`);
	process.exit(1);
}
if (projectIdArg && projectIdArg !== manifest.project?.id) {
	manifest = structuredClone(manifest);
	manifest.project = { ...manifest.project, id: projectIdArg };
}
const check = validateManifest(manifest);
if (!check.ok) {
	console.error(`seed: manifest invalid:\n  ${check.errors.join("\n  ")}`);
	process.exit(1);
}
const prepared = prepareStorage();
for (const failure of prepared.migration.errors) console.error(`seed: migration warning: ${failure.file}: ${failure.error}`);
const registry = new ProjectRegistry({ dir: prepared.dir });
const result = registry.upsert(manifest, { expectedRevision: 0 });
if (!result.ok) {
	console.error(`seed: ${result.code}: ${(result.errors ?? []).join("; ")}`);
	process.exit(1);
}
console.log(`seeded ${result.entry.id} into ${registry.path}`);
console.log(`  project revision: ${result.projectRevision}`);
console.log(`  registry revision: ${result.registryRevision}`);
