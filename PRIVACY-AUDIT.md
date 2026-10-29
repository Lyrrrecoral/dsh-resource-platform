# Privacy and content audit

Audit date: 2026-10-29. Scope: every tracked file in this repository and every
file inside the three release tarballs, including the queue-decoupling build.

## Removed from the public upload

The public repository intentionally excludes the host package test fixtures.
They contained synthetic-but-local-looking process/session examples and
host-shaped fixture numbers. Runtime code, schemas, locale data and
documentation remain; host tests are run in the private development checkout
before release.

## Checks performed

- GitHub/npm/API tokens and private-key markers;
- AWS/GitHub/npm/Slack/Google/OpenAI-style key formats;
- JWTs, bearer tokens and common personal email/phone formats;
- absolute personal paths (`/root`, `/home/<user>`, `C:\Users`);
- local session ID shapes (`session-<hex>`) and machine-name markers;
- local project/process names and path fixtures;
- actual hostname/kernel/CPU-model strings from the build machine;
- accidental host profile, incident, run, queue or session-data files.

## Result

```text
tracked repository: PASS
tarball extraction: PASS
private keys/tokens: 0
personal paths: 0
local session IDs: 0
machine-name markers: 0
host profile/incident/queue/run data files: 0
```

`PUBLISHING.md` intentionally mentions GitHub commands and `<owner>` placeholders;
these are documentation, not credentials.

The repository's `.gitignore` excludes `node_modules/`, `dist/`, smoke homes and
temporary files. Release tarballs are published as GitHub Release assets, not
committed to the source tree.
