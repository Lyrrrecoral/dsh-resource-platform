# resource-allocation-ui

**Resources tab for the DSH web GUI.**

The view is a **session-centred resource ledger**, not a project registry.
Project/task IDs are optional labels on runs.

## Tabs

1. Hardware
2. Resource monitor (default)

## Resource monitor

- Current session entries at the top;
- other monitored sessions grouped below and collapsible;
- slot holders, waiting queue items and orphan processes;
- stop a managed run or cancel a queued item after confirmation;
- hidden rows can be restored;
- on-demand read-only process lookup via `/resources/processes.json`;
- disk cleanup card: scan profile roots plus browser-local extra folders,
  choose Move to trash or Delete permanently, and inspect/empty bounded trash.

## Install

```sh
dsh plugin --profile web add /absolute/path/resource-allocation-ui-1.0.5.tgz
dsh plugin --profile web add ./packages/resource-allocation-ui
```

The package declares both `dsh.bundle` and `dsh.client`; no manual row insert is
required.

## Tests

```sh
node smoke/bundle-smoke.mjs
```

## License

MIT.
