# Publish to GitHub

The release is prepared as `main` plus `dist/` tarballs and `SHA256SUMS`.
This environment has no valid GitHub token and its SSH key is not accepted by
GitHub, so the actual push/release is the only remaining blocked step.

## 1. Authenticate

Use one of:

```sh
gh auth login
# or
ssh -T git@github.com
```

Then create the repository and push:

```sh
gh repo create Lyrrrecoral/dsh-resource-platform --public --source=. --remote=origin --push
# or, with an existing empty repo:
git remote add origin git@github.com:Lyrrrecoral/dsh-resource-platform.git
git push -u origin main
```

## 2. Discoverability

```sh
gh repo edit Lyrrrecoral/dsh-resource-platform \
  --add-topic dsh-plugin \
  --add-topic deepseek-harness \
  --add-topic resource-monitor
```

## 3. Release assets

```sh
gh release create v1.0.0 \
  dist/hardware-guard-1.0.1.tgz \
  dist/resource-allocation-1.0.4.tgz \
  dist/resource-allocation-ui-1.0.5.tgz \
  dist/SHA256SUMS \
  --title "DSH Resource Platform v1.0.0" \
  --notes-file RELEASE-NOTES.md
```

## 4. Optional marketplace index

The official index format accepts `source: {type:"git", url, commit, path}`.
After the first push, generate an index with the official generator or add a
small `index.json` and publish it from GitHub Pages/raw. The three bundle
directories are:

```text
packages/hardware-guard
packages/resource-allocation
packages/resource-allocation-ui
```

Publishing to npm is optional; tarball and GitHub installs do not require it.
