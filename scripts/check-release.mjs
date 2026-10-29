import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const packages = ["hardware-guard", "resource-allocation", "resource-allocation-ui"];
const failures = [];
for (const name of packages) {
  const dir = join(root, "packages", name);
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const need = (ok, message) => { if (!ok) failures.push(`${name}: ${message}`); };
  need(pkg.name === name, `package name is ${pkg.name}`);
  need(typeof pkg.version === "string" && /^\d+\.\d+\.\d+$/.test(pkg.version), "version is not stable semver");
  need(pkg.license === "MIT", "license must be MIT");
  need(pkg.engines?.dsh === ">=0.2.0-rc.2 <0.3.0", "engines.dsh missing/incorrect");
  need(pkg.dsh?.bundle?.patch === "./cordis.patch.yml", "dsh.bundle.patch missing");
  need(existsSync(join(dir, "cordis.patch.yml")), "cordis.patch.yml missing");
  need(existsSync(join(dir, "LICENSE")), "LICENSE missing");
  need(existsSync(join(dir, "README.md")), "README.md missing");
  need(Array.isArray(pkg.files) && pkg.files.includes("LICENSE"), "files[] must include LICENSE");
  need(Array.isArray(pkg.files) && pkg.files.includes("locale/*.json"), "files[] must include locale/*.json");
}
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("release metadata OK");
