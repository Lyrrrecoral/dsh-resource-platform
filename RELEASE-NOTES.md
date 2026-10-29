# DSH Resource Platform v1.0.0

First public release candidate.

## hardware-guard 1.0.1

Host hardware detection, pressure guardrails, guarded sandbox execution,
bounded incidents, cleanup probe and disk cleanup UI.

## resource-allocation 1.0.4

Session-owned managed long-task runs, optional project/task labels, orphan
observation, stop actions and read-only queue/policy tools. Queue enqueue no
longer requires a registered project/task; session-local labels use the
host-derived fallback quota.

## resource-allocation-ui 1.0.5

Resources tab with current/other session ledger, process lookup and the disk
cleanup card.

## Install

```sh
dsh plugin --profile web add hardware-guard-1.0.1.tgz
dsh plugin --profile web add resource-allocation-1.0.4.tgz
dsh plugin --profile web add resource-allocation-ui-1.0.5.tgz
```

Restart DSH after installing. If you previously inserted the
`resource-allocation-ui` row manually, remove it first; the UI package now
ships its own bundle patch. See `UPGRADE.md`.

## License

MIT.
