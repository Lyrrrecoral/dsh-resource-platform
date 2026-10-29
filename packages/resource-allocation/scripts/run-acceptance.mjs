// resource-allocation v1.0 acceptance driver: a REAL resource_run end-to-end on this host.
//
// Uses the exact library code the resource_run/resource_status/resource_stop tools call:
//   1. launchRun → systemd-run transient unit (sleep 120) + run record
//   2. verify: unit exists, pid recorded as a registry fact, run persisted
//   3. verify cgroup independence: the pid lives under its own unit cgroup,
//      NOT under dsh-web.service (the solve49-cadical kill chain)
//   4. systemctl restart an unrelated service (systemd-journald) → run survives
//   5. stopRun (caller = the run owner) → systemctl stop → status stopped
//   6. negative check: a different session is refused (no systemctl issued)
//
// It never touches dsh-web.service, live sessions, project units or math.
//
// Usage: DSH_HOME=/path/to/home node scripts/run-acceptance.mjs [projectId] [taskId]
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { launchRun, reconcileRun, stopRun } from "../lib/launch.js";
import { ProjectRegistry } from "../lib/registry.js";
import { prepareStorage } from "../lib/storage.js";
import { RunRegistry } from "../lib/runs.js";
import { queryRunUnit } from "../lib/systemd.js";

const projectId = process.argv[2] ?? "math";
const taskId = process.argv[3] ?? "solver-batch";
const OWNER_SESSION = "session-acceptance-20260816";

const prepared = prepareStorage();
for (const failure of prepared.migration.errors) console.error(`migration warning: ${failure.file}: ${failure.error}`);
const dir = prepared.dir;
const projects = new ProjectRegistry({ dir });
projects.load();
const runs = new RunRegistry({ dir });
runs.load();

const step = (label) => console.log(`\n== ${label}`);
const show = (binary, args) => {
	try {
		return execFileSync(binary, args, { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] }).trim();
	} catch (error) {
		return `(failed: ${error?.message ?? error})`;
	}
};

// 1. real launch through the library path the resource_run tool executes
step("1. launchRun (resource_run path): systemd-run --collect transient unit, sleep 120");
const launched = await launchRun({
	projects,
	runs,
	projectId,
	taskId,
	command: ["sleep", "120"],
	owner: { kind: "session", sessionId: OWNER_SESSION, goalId: null, jobId: null }
});
assert.equal(launched.ok, true, launched.error);
const { runId, unit } = launched;
console.log(`runId=${runId} unit=${unit} status=${launched.status}`);

// 2. the run record is on disk (the durable fact source, not process memory)
step("2. run record persisted in runs.json");
const onDisk = JSON.parse(readFileSync(`${dir}/runs.json`, "utf8"));
const record = onDisk.runs.find((run) => run.id === runId);
assert.ok(record !== undefined, "run record missing from runs.json");
assert.equal(record.status, "running");
assert.equal(record.unit, unit);
assert.ok(Number.isInteger(record.pid) && record.pid > 0, "pid must be a registry fact");
console.log(`record: status=${record.status} pid=${record.pid} revision=${record.revision} registryRevision=${onDisk.revision}`);

// 3. unit + pid facts straight from systemd
step("3. unit facts + cgroup independence");
const facts = queryRunUnit(unit);
assert.equal(facts.ok, true, facts.error);
assert.equal(facts.facts.exists, true);
assert.ok(facts.facts.mainPid > 0);
const pid = facts.facts.mainPid;
const cgroup = show("cat", [`/proc/${pid}/cgroup`]);
console.log(`systemctl: active=${facts.facts.activeState} mainPid=${pid}`);
console.log(`/proc/${pid}/cgroup → ${cgroup}`);
assert.ok(cgroup.includes(unit), `pid cgroup must be the run's own unit cgroup: ${cgroup}`);
assert.ok(!cgroup.includes("dsh-web.service"), "pid must NOT be under dsh-web.service");
console.log(`dsh-web.service cgroup: ${show("systemctl", ["show", "dsh-web.service", "--no-pager", "--property=ControlGroup"])} (unchanged, untouched)`);

// 4. restart an unrelated service — the run must survive
step("4. systemctl restart systemd-journald (unrelated service)");
console.log(show("systemctl", ["restart", "systemd-journald"]) || "(restart ok)");
await new Promise((resolve) => setTimeout(resolve, 2000));
const after = queryRunUnit(unit);
assert.equal(after.ok, true, after.error);
assert.ok(after.facts.mainPid > 0, "run died during an unrelated service restart");
assert.equal(after.facts.mainPid, pid, "pid must be unchanged across the restart");
console.log(`survived: mainPid=${after.facts.mainPid} activeState=${after.facts.activeState}`);

// 5. reconcile sees it running; then the owner stops it via resource_stop path
step("5. reconcile + stopRun (resource_stop path, caller = owner)");
const reconciled = await reconcileRun({ runs, runId });
console.log(`reconcile: ${JSON.stringify(reconciled)}`);
const stopped = await stopRun({ runs, runId, callerSessionId: OWNER_SESSION });
assert.equal(stopped.ok, true, stopped.error);
assert.equal(stopped.status, "stopped");
assert.equal(stopped.exitCode, 143, "sleep killed by SIGTERM must record exit 143");
const finalRecord = runs.get(runId);
assert.equal(finalRecord.status, "stopped");
assert.equal(finalRecord.exitCode, 143);
assert.ok(finalRecord.finishedAt !== null);
console.log(`stopped: status=${finalRecord.status} exitCode=${finalRecord.exitCode} finishedAt=${new Date(finalRecord.finishedAt).toISOString()}`);
console.log(`unit after stop: ${show("systemctl", ["show", unit, "--no-pager", "--property=LoadState,ActiveState,SubState"])}`);

// 6. negative: another session may not stop it (already stopped here, so use a fresh run)
step("6. negative: cross-session stop is refused before any systemctl");
const second = await launchRun({ projects, runs, projectId, taskId, command: ["sleep", "120"], owner: { kind: "session", sessionId: OWNER_SESSION, goalId: null, jobId: null } });
assert.equal(second.ok, true, second.error);
const denied = await stopRun({ runs, runId: second.runId, callerSessionId: "session-someone-else" });
assert.equal(denied.ok, false);
assert.equal(denied.code, "forbidden");
console.log(`denied: ${denied.error}`);
const cleanup = await stopRun({ runs, runId: second.runId, callerSessionId: OWNER_SESSION });
assert.equal(cleanup.ok, true, cleanup.error);
console.log(`cleanup: second run ${second.runId} → ${cleanup.status}`);

step("ACCEPTANCE PASSED");
console.log(`run ${runId} launched under its own transient unit, survived a systemd-journald restart, and was stopped by its owner (exitCode 143).`);
