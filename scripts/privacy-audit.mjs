import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const files = execFileSync("git", ["ls-files"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
const patterns = [
["private key", /BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY/],
["github token", /gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}/],
["npm token", /npm_[A-Za-z0-9]{30,}/],
["openai token", /sk-[A-Za-z0-9]{20,}/],
["aws token", /AKIA[0-9A-Z]{16}/],
["slack token", /xox[baprs]-[A-Za-z0-9-]{10,}/],
["google key", /AIza[0-9A-Za-z_-]{30,}/],
["personal path", /\/root\/|\/home\/[A-Za-z0-9_.-]+|C:\\Users\\/i],
["local session id", /session-[0-9a-f]{6,}/i],
["machine marker", /DESKTOP-[A-Z0-9]+/i]
];
const failures = [];
for (const file of files) {
let text;
try { text = readFileSync(file, "utf8"); } catch { continue; }
for (const [label, rx] of patterns) {
if (rx.test(text)) failures.push(`${file}: ${label}`);
}
}
if (failures.length > 0) {
console.error(failures.join("\n"));
process.exit(1);
}
console.log(`privacy audit OK (${files.length} tracked files)`);
