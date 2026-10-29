# hardware-guard

**Host hardware detection and resource guardrails for DeepSeek Harness.**

This is the host resource guard. It is not a physical-hardware/robotics safety
plugin and it does not manage systemd services owned by other projects.

## What it does

- probes CPU, memory, disks and WSL/VM facts into a persisted host profile;
- derives conservative budgets and a background-job limit;
- classifies host pressure with hysteresis;
- gates tool execution and can terminate true runaway harness processes;
- wraps confined shell argv with `nice` and process limits;
- records bounded incidents and proposes incident-driven adaptations;
- provides an on-demand large-file cleanup scanner (scan, trash, permanent
  delete, bounded trash management).

The first profile is created in **dry-run** mode. Enforcement and automatic
kills remain off until the operator confirms the profile with the
`hardware_guard` tool.

## Install

```sh
dsh plugin --profile web add /absolute/path/hardware-guard-1.0.1.tgz
dsh plugin --profile web add ./packages/hardware-guard
```

Restart DSH after installing or replacing a bundle.

## Requirements

- Node.js >= 20
- DeepSeek Harness `>=0.2.0-rc.2 <0.3.0`
- Linux for `prlimit`/proc/sandbox features; other platforms degrade safely

## Configuration

Use the shipped `cordis.patch.yml` as the default layer and override only
machine-specific values in your profile. Important fields:

- `autoKillOnCritical` — default behavior should be reviewed before enabling;
- `memoryCapPolicy` — `none` (default), `compute-only`, or `all`;
- `watchdogIntervalMs`, `killGraceMs`, `killCooldownMs`;
- `cleanupProbe.enabled`, `cleanupProbe.roots`, `cleanupProbe.minSizeBytes`,
  `cleanupProbe.softDelete`, `cleanupProbe.trashRetentionDays`.

## Safety

Adopted units are observe-only. The cleanup scanner never deletes during scan;
it touches only files listed in a live plan, refuses symlinks/out-of-root/non-
regular files, and uses one-shot plan IDs. Permanent delete is explicit and
irreversible; trash retention is bounded.

## Tests

The internal host test suite is run in the development checkout before release;
it is intentionally not shipped in the public bundle because its fixtures contain
synthetic process/session examples. The public package contains runtime code and
documentation only.

## License

MIT.
