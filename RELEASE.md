# Release

Releases require explicit maintainer approval in the protected `release` GitHub environment. Candidate checks prepare and verify artifacts; they do not publish anything.

Repository-admin prerequisites are tracked in the auditable [repository release protections checklist](docs/repository-settings.md). Publication is blocked until every checklist item is verified and its date, owner, and evidence URL are recorded in the release issue.

## Protected release graph

```text
signed tag → metadata check → package artifact → image candidate/scan → macOS E2E → protected approval → npm publish + OCI finalization → fresh-install verification
```

Every receipt is bound to the signed tag's derived source SHA, package integrity,
and image digest. No publication job may run unless macOS E2E succeeded for that
same SHA, tarball integrity, and digest. Missing or unavailable E2E runners fail
closed; protected-environment approval cannot substitute for E2E evidence.

## Release signing key

Protected releases trust only the armored maintainer public key committed as
`docs/release-signing.asc`. The metadata job imports that file into an empty job
keyring before `git verify-tag`; a missing, empty, or invalid key fails closed.
No private key belongs in the repository. This checkout contains
`docs/release-signing.asc.example` because no maintainer secret key was available
to export: replace it by committing the real public export at the required path
before the first release. Rotate the key in a reviewed commit, announce the old
and new fingerprints in the release issue, and use only tags created after that
commit with the new key.

## Candidate checks

Every dependency update requires the unit and package checks (`npm run check` and `npm run pack:dry`). Updates to Pi, `sbx`, a Docker base, an image tool, or a security boundary also require real macOS E2E (`npm run test:e2e`). Pi peer compatibility ranges must not be widened without explicit compatibility review. GitHub Action updates must preserve full-length SHA pins and update the human-readable version comments alongside those pins.

1. Start from clean, reviewed `main` and align `package.json`, the package-lock root, the dated `CHANGELOG.md` heading, `COMPATIBILITY.md`, and `docker/image-lock.json`.
2. Run `npm ci --ignore-scripts`, `npm run check`, `npm run release:check -- --allow-unreleased --tag vX.Y.Z`, `npm run test:e2e`, `npm run pack:dry`, and `npm audit --audit-level=high`.
3. Review the tarball allowlist and verify the candidate npm and OCI artifacts correspond to the same commit, package/Pi versions, and immutable image digest.
4. Do not create the final version tag yet. The immutable published image must
   be locked before `vX.Y.Z` is created.
5. After the image bootstrap and lock commit below, create the final version tag
   with `git tag -s vX.Y.Z -m "vX.Y.Z"`, verify it with `git tag -v vX.Y.Z`,
   and run `npm run release:check -- --tag vX.Y.Z`. Release mode requires the
   signed tag at `HEAD`, a clean tracked worktree, and a digest-pinned
   `publishedImage`.

## Real macOS E2E

The reusable `.github/workflows/e2e.yml` gate consumes the exact package and
OCI candidate artifacts. A calling workflow downloads both current-run
artifacts. For manual `workflow_dispatch`, provide the completed CI `run_id`,
package artifact `npm-package-<source_sha>`, and OCI artifact
`oci-candidate-<source_sha>`; the workflow uses its read-only GitHub token and
fails closed if either artifact or its bound digest is absent. It verifies the
OCI index digest, imports that archive into the local Docker daemon, and loads
the resulting content-addressed image into Docker Sandboxes. This gate does not
pull or publish the candidate.

The uploaded receipt records required and selected image identities, test
status/count, and a `passedAt` timestamp only for successful E2E. Logs and the
receipt upload even after failure. A failed receipt is diagnostic evidence, not
release approval.

## Candidate OCI image

CI copies the verified npm tarball into the Docker build context and performs
one `linux/arm64` Buildx solve tagged with its source SHA. QEMU verifies that
loaded image, then digest-pinned Skopeo exports the same Docker daemon image to
an OCI archive, so there is no second unverified build digest. The same
`npm run image:verify` smoke test used by maintainers fails if the arm64 image
cannot execute. CI uploads the OCI archive with the JSON verification receipt.
The
security workflow scans the repository and a deterministically rebuilt image
for unignored HIGH/CRITICAL findings, uploads SARIF, and emits a CycloneDX SBOM.
No pull-request workflow logs in to GHCR or publishes an image.

The image gate was also proved red locally with a disposable `/tmp` Dockerfile
that removed `fd`; `npm run image:verify` rejected it with `fd: not found`. The
broken Dockerfile was never committed.

## Publication

1. Create the signed prerelease tag from the reviewed release commit and
   dispatch `release-candidate.yml` with only that tag. The workflow derives the
   SHA and version from the verified tag; never type or accept a separate SHA.
2. The workflow builds one npm tarball and one OCI archive, scans the exact OCI
   archive, and runs real macOS E2E against both artifacts. It joins their
   receipts before either publication job can reach the protected `release`
   environment. An unavailable E2E runner leaves publication blocked.
3. A maintainer checks the joined candidate receipt and grants protected
   approval. The npm job downloads and publishes the same verified tarball with
   `npm publish <tarball> --provenance --access public --tag alpha`; it never
   packs again. `alpha` is permitted only because this workflow rejects a
   non-prerelease version. Before approval, confirm the npm package access is
   public (or that the first publish will create it as public) and its trusted
   publisher is restricted to this repository, workflow, and environment.
4. In parallel after the same receipt and approval, OCI finalization pushes the
   exact archive by source SHA, checks the registry digest, and attaches SBOM
   and build-provenance attestations. The joined receipt artifact flattens the
   SBOM to `candidate-image.cdx.json`; OCI finalization requires that exact
   downloaded path before attesting. It does not rebuild, publish `latest`, or
   overwrite a version or digest. A retry accepts an existing source-SHA or
   version tag only when it already resolves to the expected candidate digest.
   Record the immutable
   `ghcr.io/...@sha256:<digest>` in the next reviewed image-lock release change.

## Post-publication verification

Before publication, run `npm run smoke:fresh-install -- <packed-tarball>`; it installs with scripts disabled into a temporary npm prefix, uses a synthetic Pi home, runs `pi-dsbx --help`, `config`, and `doctor`, verifies the declared Pi extension, uninstalls, and emits a JSON receipt. The smoke environment is allowlisted and never copies host Pi settings or credentials. A missing `npm view pi-docker-sandboxes version --json` or public pi.dev listing is expected before the first publication and must be recorded as absence, not as successful public verification.

The workflow installs the exact npm version into a clean temporary prefix and
runs its installed `pi-dsbx --help`. It also inspects the exact GHCR digest and
verifies both its provenance and CycloneDX SBOM attestations. Add the successful
workflow URLs and command output to the release issue.

pi.dev has no stable verification API. After publication, a maintainer must
open the package page, confirm the exact version and install metadata are
indexed, and add the page URL, timestamp, and reviewer to the release issue.
This manual receipt is required to close the release, but it is non-blocking for
immutable npm/OCI publication because indexing is external and asynchronous.

## Rollback and deprecation

Published npm versions and OCI digests are immutable; do not overwrite them. If a release is defective:

```sh
npm deprecate pi-docker-sandboxes@X.Y.Z "Deprecated: <reason>; use <replacement>"
npm dist-tag add pi-docker-sandboxes@<replacement> alpha

gh api --method DELETE /user/packages/container/pi-docker-sandboxes/versions/<version-id>
gh api /user/packages/container/pi-docker-sandboxes/versions
```

Before deleting a GHCR version, identify and record the exact digest users must avoid, confirm the package scope (`/user` or `/orgs/<org>`), and prefer retaining the immutable image when provenance or incident analysis requires it. Announce the deprecated npm version, affected GHCR digest, replacement, and recovery steps in the GitHub release.

Never publish automatically on merge. Never use `latest` as the selected image. Candidate validation is not publication approval.
