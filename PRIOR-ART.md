# Prior art review

Date: 2026-10-29. Sources: GitHub repository search, GitHub topics
`dsh-plugin` / `deepseek-harness`, npm registry, and the official DSH
packaging guide.

## Search terms

`dsh plugin deepseek harness`, `dsh-plugin`, `dsh resource monitor`,
`dsh hardware guard`, `dsh process monitoring`, `dsh cleanup disk`,
`dsh memory guard`, `dsh-ops`, `resource allocation dsh`, `dsh systemd run`.

## Nearest projects

| Project | Scope | Relationship |
|---|---|---|
| [`nexmoe/dsh-monitor-pro`](https://github.com/nexmoe/dsh-monitor-pro) | Read-only host CPU/memory/disk/GPU dashboard + snapshot tool | Strong UI/metrics overlap; no managed task ownership or stop/queue lifecycle |
| [`Qingysource/dsh-resource-monitor`](https://github.com/Qingysource/dsh-resource-monitor) | Floating resource charts, token/cost view | Read-only dashboard; no systemd run lifecycle |
| [`AKS1st/dsh-sysmon`](https://github.com/AKS1st/dsh-sysmon), `dsh-vitals`, `dsh-top`, `dsh-system-monitor` | System status widgets | Read-only monitoring; no enforcement/admission |
| [`xychendave/dsh-hardware-guard`](https://github.com/xychendave/dsh-hardware-guard) | Safety/audit guard for physical hardware and robotics tools | Same repository name family, **different domain**; not a host resource guard |
| [`Yeqij/dsh-disk-doctor`](https://github.com/Yeqij/dsh-disk-doctor) | DSH disk accounting + reversible quarantine | Strong cleanup overlap; not host pressure/run management |
| [`kaka-crypto/dsh-disk-guard`](https://github.com/kaka-crypto/dsh-disk-guard) | Disk redirect/status/cleanup | Overlaps the cleanup card; no managed runs or queue |
| [`3450892121/dsh-task-monitor`](https://github.com/3450892121/dsh-task-monitor) | Session/task overlay, git/background/artifact panel | UI/task-visibility overlap; no systemd transient run owner |
| [`zhang-guo-wen/dsh-service-manager`](https://github.com/zhang-guo-wen/dsh-service-manager) | Service discovery and process/container management | Process-management overlap; not session-owned run allocation |
| [`T-Auto/dsh-ops`](https://github.com/T-Auto/dsh-ops) | Token-efficient file/PTC tools | Different product despite the historical `dsh-ops` name |

## Verdict

### hardware-guard

No exact equivalent found. Its differentiators are the persisted host profile,
admission/pressure/watchdog lifecycle, guarded sandbox wrapper, incident-driven
adaptation, and a cleanup path integrated with the same hardware surface.

Risk to manage before publishing: the repository `xychendave/dsh-hardware-guard`
already exists for physical-hardware safety. Public copy must say **host
resource guard**, not physical device guard. A repository name like
`dsh-host-guard` would reduce ambiguity, but package/runtime renames are not
required for this release.

### resource-allocation

No exact equivalent found. Read-only monitors show metrics; task overlays show
sessions; service managers manage processes. None combine session-owned managed
systemd runs, optional labels, orphan observation, a read-only queue, and
explicit stop actions in one resource ledger.

Risk to manage before publishing: `resource-allocation` is a generic npm name
and the repository is no longer project-tree centric. Public copy must lead with
**session-owned managed runs**, not project registration.

### Cleanup overlap

The disk-cleanup card has real neighbours and should not be marketed as a
unique product. It is a small, explicit maintenance utility inside the
resource platform: scan first, trash or permanent delete, bounded trash
management. If a user only needs disk accounting, `dsh-disk-doctor` is a better
fit.

## Product recommendation

Ship all three packages as separate bundles in one repository. Keep the names
for this release to avoid breaking existing DSH profiles; document the domain
clearly. If the project gains adoption, consider a scoped or `dsh-` prefixed
namespace in a major release.

## Complementary infrastructure: LayerFS × DSH

[`Ephemeral-AI-Lab/dsh-layerfs`](https://github.com/Ephemeral-AI-Lab/dsh-layerfs)
(and its LayerFS substrate) is a workspace/history layer, not a host resource
manager. It gives each agent a writable FUSE Workspace over a content-addressed
Store, with Branches, Commits, recursive checkpoints, Sandboxes, merge/publish
and a Work/History UI.

It does **not** cover this project's core:

- host hardware profiles, budgets, pressure/watchdog and runaway handling;
- guarded shell limits (`nice`/`prlimit`/process caps);
- systemd transient long-task lifecycle, exact stop and queue ownership;
- host process lookup, orphan attribution and disk cleanup/trash management.

The overlap is at the edges: LayerFS Sandboxes isolate workspace execution,
while hardware-guard limits host resources; LayerFS deduplication reduces
storage, while this project's cleanup card reclaims legacy output files. They
are complementary. If both are installed, do not point cleanup roots at the
LayerFS content store, and use `resource_run` for long LayerFS build/export
jobs so they remain visible and exactly stoppable.
