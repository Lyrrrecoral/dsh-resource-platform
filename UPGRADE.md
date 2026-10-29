# Upgrade notes

## From a pre-bundle `resource-allocation-ui`

Earlier profiles mounted the client row manually:

```yaml
- insert:
    - id: resource-allocation-ui
      name: 'resource-allocation-ui'
```

`resource-allocation-ui@1.0.5` now declares its own `dsh.bundle` patch. Remove
that manual insert before installing/restarting, otherwise the composed tree
contains two rows with the same id and the loader refuses the boot.

## From `dsh-ops` / `hw-guard`

The canonical package names are `resource-allocation` and `hardware-guard`.
Storage migration is one-way and leaves the legacy directories untouched:

```text
$DSH_HOME/storages/ops              -> storages/resource-allocation
$DSH_HOME/storages/hw-guard         -> storages/hardware-guard
```

Remove old bundle rows only after the new packages have booted successfully.
Keep the legacy directories until you have verified rollback.

## After installing

Fully restart DSH. Replacing a bundle or a client bundle is not hot-swapped by
`dsh plugin add`.

Verify with:

```sh
dsh --profile web --dump-config
```

and check that the expected rows appear exactly once.
