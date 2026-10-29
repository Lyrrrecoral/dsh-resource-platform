# Release checklist

- [x] GitHub prior-art search and differentiation review
- [x] Three packages are independently installable bundles
- [x] `dsh.bundle.patch` + `cordis.patch.yml` present
- [x] `engines.dsh` declared
- [x] MIT LICENSE at repository and package roots
- [x] `locale/en.json` + `locale/zh.json` display metadata
- [x] README, install instructions, safety boundaries
- [x] UI smoke and release metadata check
- [x] Package tarballs and SHA-256 checksums generated
- [x] Tarballs installed into a clean profile; one UI row and all three canonical routes verified
- [x] Session-only queue enqueue verified from installed tarball
- [x] Privacy audit of tracked files and tarballs: PASS
- [x] Host tests run in the private development checkout (223 hardware / 236 resource)
- [ ] GitHub repository created and pushed (blocked: no valid GitHub credential)
- [ ] `dsh-plugin` topic added (requires repository)
- [ ] GitHub Release with tarballs created (requires repository)
- [ ] Repository URL added to package metadata (requires repository)

The last four items require GitHub credentials/repository ownership.
