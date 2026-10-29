# DSH Resource Platform

Host resource protection, managed long-task allocation and a session-centred
Resources view for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

This repository contains three installable DSH bundles:

| Package | Version | Role |
|---|---|---|
| [`hardware-guard`](packages/hardware-guard/) | 1.0.1 | Host hardware profile, pressure guard, watchdog, sandbox wrapping, disk cleanup |
| [`resource-allocation`](packages/resource-allocation/) | 1.0.4 | Session-owned long-task runs, optional labels, orphan observation, read-only queue/policy |
| [`resource-allocation-ui`](packages/resource-allocation-ui/) | 1.0.5 | Resources tab: current/other session ledger, process lookup and disk cleanup |

**中文简介：** 这是一个 DSH 资源平台组合：硬件守卫负责保护宿主机；资源分配负责任务运行、归属和队列；资源监控 UI 把本会话与其他会话的占位/等待/孤儿进程放在一个页面里，并提供按需进程查询与磁盘清理。

## Why this exists

DSH agents can launch long, memory-hungry work. This platform keeps that work
visible and bounded:

- detect host hardware and derive conservative budgets;
- gate and observe pressure, with dry-run first;
- wrap confined shell execution with `nice`/process limits;
- run long tasks as independent systemd transient units;
- enqueue a task with optional labels — no project registration required;
- keep session ownership explicit;
- show slot holders, waiting work and orphans by session;
- stop only the exact managed run after confirmation;
- never auto-delete project output: cleanup scans first and requires confirmation.

## Prior art and differentiation

A GitHub search found no exact equivalent. Read-only resource dashboards
(`dsh-monitor-pro`, `dsh-resource-monitor`, `dsh-sysmon`, `dsh-vitals`) are
neighbours, but they do not own managed long-task lifecycle or session-scoped
run/queue attribution. Disk cleaners (`dsh-disk-doctor`, `dsh-disk-guard`) cover
overlapping cleanup needs, but not host pressure guarding or managed runs.
`xychendave/dsh-hardware-guard` is a physical-hardware/robotics safety tool, not
a host resource guard. See [PRIOR-ART.md](PRIOR-ART.md) for the full review.

The closest UI neighbours are dashboards; this project is intentionally a
**resource ledger**, not a project registry. Project/task IDs are optional
labels, not a registration prerequisite.

## Requirements

- Node.js 20 or newer.
- DeepSeek Harness 0.2.x (`engines.dsh: >=0.2.0-rc.2 <0.3.0`).
- Linux with systemd for `resource_run` managed units.
- A DSH web profile for the Resources UI.

## Install

### Option A: release tarballs

```sh
dsh plugin --profile web add /absolute/path/hardware-guard-1.0.1.tgz
dsh plugin --profile web add /absolute/path/resource-allocation-1.0.4.tgz
dsh plugin --profile web add /absolute/path/resource-allocation-ui-1.0.5.tgz
```

Restart DSH after installing the three bundles. Replacing a bundle also
requires a full DSH restart. If upgrading from the pre-bundle UI, remove the
old manual `resource-allocation-ui` row first; see [UPGRADE.md](UPGRADE.md).

### Option B: local checkouts

```sh
dsh plugin --profile web add ./packages/hardware-guard
dsh plugin --profile web add ./packages/resource-allocation
dsh plugin --profile web add ./packages/resource-allocation-ui
```

The UI package now declares its own `dsh.bundle` patch, so no manual row insert
is required.

### Option C: GitHub

Once the repository is published:

```sh
dsh plugin --profile web add github:Lyrrrecoral/dsh-resource-platform#<commit>
```

For a monorepo, use the package directory path in the plugin index or install
the packaged tarballs from the GitHub Release.

## First run and safety

`hardware-guard` starts with a machine-private profile in dry-run mode. No caps
or automatic kills apply until the operator confirms the profile through the
`hardware_guard` tool. Review the generated profile and thresholds before
enabling enforcement.

`resource_run` creates only `resource-allocation-<label>-<runId>.service`
transient units. `resource_stop` can stop only a managed run owned by the calling
session; adopted systemd units are observe-only. Queue decisions are read-only:
they never start, stop, throttle or kill a process.

The cleanup card is on the Resources page. It scans configured roots plus
optional browser-local extra roots, lists candidates only, and requires an
explicit choice between **Move to trash** and **Delete permanently**.

## Configuration

Every package exposes a Cordis config schema. Start from its shipped
`cordis.patch.yml`, then override only what your host needs in the profile's own
`cordis.patch.yml`. Do not put machine-specific paths in a shared bundle.

## Testing

```sh
# UI smoke, no host installation required
node packages/resource-allocation-ui/smoke/bundle-smoke.mjs

# release metadata
node scripts/check-release.mjs
```

The internal host test suite is run in the development checkout against matching
`@deepseek-ai/*` peer packages; it is not shipped in the public bundle because
its synthetic fixtures are deliberately excluded from the release surface.

## License

MIT. See [LICENSE](LICENSE).

## GitHub discovery

The public repository is https://github.com/Lyrrrecoral/dsh-resource-platform and the first release is https://github.com/Lyrrrecoral/dsh-resource-platform/releases/tag/v1.0.0. Add the `dsh-plugin` topic on the repository About panel for discoverability. See the official
[packaging and install guide](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md).
