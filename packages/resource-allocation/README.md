# resource-allocation

**Session-owned long-task runs and read-only queue observation for DeepSeek
Harness.**

## What it does

- registers `resource_run`, `resource_status`, `resource_stop`,
  `resource_plan`, and `resource_queue`;
- launches a long task as its own systemd transient unit;
- keeps the session/goal/job owner chain explicit;
- shows orphans and waiting/occupied entries;
- stops only an exact managed run owned by the calling session;
- records queue/policy decisions without starting, killing or throttling work.

`projectId` and `taskId` are optional labels. When a registered legacy manifest
matches, its limits/workdir/env are used; otherwise safe defaults and explicit
per-run overrides apply. A project registration is not required to launch a managed run or enqueue a
queue item. Unregistered session labels use the host-derived fallback quota
(global headroom + maxConcurrentAdmitted); explicit project quotas win when
present.

## Install

```sh
dsh plugin --profile web add /absolute/path/resource-allocation-1.0.4.tgz
dsh plugin --profile web add ./packages/resource-allocation
```

Requires Linux with systemd for managed transient units. Other platforms can
still use the observation and queue tools.

## Storage

```text
$DSH_HOME/storages/resource-allocation/
  projects.json   # optional legacy labels/adoption facts
  runs.json
  queue.json
  policy.json
```

Legacy `storages/ops` is read-only compatibility data and is never modified.

## Safety

`resource_stop` validates the exact managed unit and owner. Adopted units are
observe-only. Queue decisions never start or kill a process.

## Known limitations

- The HTML/API path still uses `/resources/projects*` for one release for
  compatibility; the UI is resource-ledger oriented.

## Tests

The internal host test suite is run in the development checkout before release;
it is not shipped in the public bundle. The public package contains runtime code
and documentation only.

## License

MIT.
