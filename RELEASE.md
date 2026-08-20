# Production release

A release is a signed stable tag on reviewed `main`.
The protected `release` environment requires maintainer approval.
Candidate validation cannot publish or
replace the locked runtime image.

## Prerequisites

- The maintainer signing key at `docs/release-signing.asc` must be committed.
  Private key material never belongs in the repository or Actions.
- Protect `main`, signed `v*` tags, and the `release` environment.
- Restrict npm trusted publishing to this repository, `publish-npm.yml`, and
  the `release` environment.
- Keep `docker/image-lock.json` on a public GHCR SHA-256 digest whose locked
  runtime run supplies its final receipt, both raw SARIF scans, both CycloneDX
  SBOMs, and GitHub OIDC provenance.
- Provision the three required ephemeral hardware lanes: macOS ARM64, Ubuntu
  amd64 KVM, and Ubuntu ARM64 KVM.

Dependency updates always require unit and package checks. Changes to Pi,
`sbx`, a Docker base, an image tool, or a security boundary also require real
macOS E2E plus the Linux hardware lanes.

The standard runtime scans must contain zero HIGH or CRITICAL results before
any policy is applied. `.trivyignore.yaml` records only the separately blocked
Docker variant and cannot authorize the standard release. Every risk record
has exact paths, reachability, controls, remediation owner, upstream reference,
expiry, and next-review date. An incomplete, expired, or overdue record blocks
release checks.

## Candidate and publication

1. On clean reviewed `main`, align `package.json`, `package-lock.json`, the
   dated changelog heading, compatibility record, runtime locks, and risk
   records. Run:

   ```sh
   npm ci --ignore-scripts
   npm run check
   npm run release:check -- --allow-unreleased --tag vX.Y.Z
   npm run pack:dry
   npm audit --audit-level=high
   ```

2. Create and locally verify the signed tag:

   ```sh
   git tag -s vX.Y.Z -m "vX.Y.Z"
   git tag -v vX.Y.Z
   npm run release:check -- --tag vX.Y.Z
   ```

3. Dispatch the tag. The workflow ref and input must be identical:

   ```sh
   gh workflow run release-candidate.yml --ref vX.Y.Z -f tag=vX.Y.Z
   ```

4. The candidate workflow builds exactly one npm tarball. It downloads the
   runtime receipts named in the lock, verifies raw zero scans and provenance,
   pulls the public digest directly on every hardware host, and joins all three
   E2E and cleanup receipts. It never builds, exports, or substitutes an image.

5. After protected approval, `publish-npm.yml` publishes that same verified
   tarball with OIDC:

   ```sh
   npm publish <verified-tarball> --provenance --access public --tag latest
   ```

   Packing in the publication job is forbidden. All three hardware receipts,
   package integrity, runtime digest, source SHA, stable version, and tag must
   match before this command.

6. Publication verification uses a temporary HOME, Pi home, npm config, and
   prefix. It runs the exact command
   `pi install npm:pi-docker-sandboxes@X.Y.Z`, verifies the package record,
   declared extension and host flags, performs one extension launch, removes
   the package, reinstalls it, removes it again, and verifies complete cleanup.
   The environment receives no host Pi settings, npm credentials, provider
   credentials, or cloud credentials. The exact pi.dev install record must be
   visible before release creation.

7. After successful public verification, deprecate the inert bootstrap entry:

   ```sh
   npm deprecate pi-docker-sandboxes@0.0.0 \
     "Bootstrap only; use X.Y.Z"
   ```

8. `publish-release.yml` independently verifies the signed tag and creates the
   GitHub Release. Only its final job receives `contents: write`. Attached
   assets include SHA-256 checksums, the published tarball and verification
   receipts, package and runtime provenance, raw SARIF scans, CycloneDX SBOMs,
   all E2E and cleanup receipts, Pi installation receipt, compatibility record,
   and rollback instructions. A failed GitHub Release publication may be resumed
   only by retrying the publish job in the original workflow run; a new dispatch
   must not reuse its nondeterministic hardware or public-install diagnostics.

## Rollback

Published package versions and runtime digests are immutable. For a defective
release:

```sh
npm deprecate pi-docker-sandboxes@X.Y.Z \
  "Deprecated: <reason>; use <replacement>"
npm dist-tag add pi-docker-sandboxes@<replacement> latest
```

Preserve the GitHub Release and evidence, announce the affected version and
replacement, and never overwrite the package or move an image tag in place of
the locked digest.
