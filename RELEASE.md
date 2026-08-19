# Release

Releases require explicit maintainer approval in the protected `release` GitHub environment. Candidate checks prepare and verify artifacts; they do not publish anything.

Repository readiness is tracked in [release issue #8](https://github.com/gurkanguray/pi-docker-sandboxes/issues/8). Publication is blocked until the issue records a current date, owner, and evidence URL for every prerequisite below.

## Repository prerequisites

- Main Protection requires pull requests, CODEOWNER review, resolved conversations, squash-only linear history, and the exact observed CI and security checks.
- The protected `release` environment requires maintainer approval and permits only `main` and `v*` release refs.
- `docs/release-signing.asc` is currently missing and must be committed with the maintainer public signing key before the first release; no private key belongs in the repository.
- A repository-scoped macOS ARM64 self-hosted runner carries the required `docker-sandboxes` label.
- npm trusted publishing is restricted to this repository, `publish-npm.yml`, and the `release` environment.
- The signed tag and package, image, scan, SBOM, provenance, and hardware-E2E receipts all resolve to the same reviewed commit.

## Protected release graph

```text
signed tag → metadata check → package artifact + fresh-install smoke → local image candidate/scan → macOS E2E → protected approval → npm publish → clean-prefix verification
```

Every receipt is bound to the signed tag's derived source SHA, package integrity,
and tested local image digest. No npm publication job may run unless macOS E2E
succeeded for that same SHA, tarball integrity, and digest. Missing or unavailable
E2E runners fail closed; protected-environment approval cannot substitute for E2E
evidence. The Early Access release does not publish a registry image; users build the
verified local image or configure their own digest-pinned image.

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
3. Review the tarball allowlist and verify the candidate npm and local OCI test artifacts correspond to the same commit, package/Pi versions, and immutable image digest.
4. Create the final version tag with `git tag -s vX.Y.Z -m "vX.Y.Z"`, verify it with `git tag -v vX.Y.Z`, and run `npm run release:check -- --tag vX.Y.Z`. Release mode requires the signed tag at `HEAD` and a clean tracked worktree.

## Real macOS E2E

The reusable `.github/workflows/e2e.yml` gate consumes the exact package and
OCI candidate artifacts. A calling workflow downloads both current-run
artifacts. For manual `workflow_dispatch`, provide all five required inputs:

- `source_sha`: the exact commit tested by the completed CI run;
- `run_id`: that completed CI run;
- `package_artifact`: normally `npm-package-<source_sha>`;
- `image_artifact`: normally `oci-candidate-<source_sha>`; and
- `image_digest`: the image artifact's `image-verification.json` `ociDigest` value.

The workflow uses its read-only GitHub token and fails closed if either artifact
or its bound digest is absent. It verifies the OCI index digest, imports that
archive into the local Docker daemon, and loads the resulting content-addressed
image into Docker Sandboxes. This gate does not pull or publish the candidate.

The uploaded receipt records required and selected image identities, test
status/count, and a `passedAt` timestamp only for successful E2E. Logs and the
receipt upload even after failure. A failed receipt is diagnostic evidence, not
release approval.

## Candidate OCI image

CI reads the exact published standard multiarch reference from
`docker/image-lock.json`. Digest-pinned Skopeo exports all locked platforms to
one OCI archive, and CI verifies its manifest digest before uploading the
archive with the JSON verification receipt.
The
security workflow scans the repository and a deterministically rebuilt image
for HIGH/CRITICAL findings, uploads SARIF, and emits a CycloneDX SBOM.
Project-controlled findings remain blocking. An inherited upstream finding may
be excepted only when release evidence identifies the exact immutable base
digest, CVE IDs, affected components, rationale, and review date. The
JSON-compatible [`.trivyignore.yaml`](.trivyignore.yaml) scopes every exception
to exact image paths, and the release check binds the approved policy bytes,
locked base digest, and review date. Do not lower the severity threshold or use a
blanket `ignore-unfixed` policy. No workflow logs in to an OCI registry or
publishes an image.

## Publication

### One-time npm bootstrap

npm requires a package to exist before trusted publishing can be configured. For
the first release only, a maintainer must interactively publish a reviewed,
inert `0.0.0` package under the `bootstrap` dist-tag with 2FA. It must not carry
the `pi-package` keyword or a Pi manifest. Then configure the trusted publisher
for `gurkanguray/pi-docker-sandboxes`, workflow `publish-npm.yml`, and
environment `release`. After `0.1.0` is published through OIDC, deprecate
`0.0.0` as bootstrap-only. This bootstrap is a separate, explicit maintainer
publication action; never store its credentials in the repository or workflow.

1. Create the signed release tag from the reviewed release commit and require
   its tag commit to be an ancestor of `origin/main`. Dispatch it with:

   ```sh
   gh workflow run release-candidate.yml --ref "$TAG" -f tag="$TAG"
   ```

   The workflow ref and tag input must be identical. The workflow derives the
   SHA and version from the verified tag; never type or accept a separate SHA.
2. The workflow builds one npm tarball and one OCI archive, scans the exact OCI
   archive, and runs real macOS E2E against both artifacts. It joins their
   receipts before the npm publication job can reach the protected `release`
   environment. An unavailable E2E runner leaves publication blocked.
3. A maintainer checks the joined candidate receipt and grants protected
   approval. The npm job downloads and publishes the same verified tarball with
   `npm publish <tarball> --provenance --access public --tag latest`; it never
   packs again. The workflow rejects prerelease versions. Before approval,
   confirm the npm package access is
   public (or that the first publish will create it as public) and its trusted
   publisher is restricted to this repository, workflow, and environment.
4. The verified OCI archive remains a retained release-evidence artifact only. Do not push it to a registry. Registry publication is deferred until a digest-lock design can avoid a self-reference between the image contents and the package that selects that image.

## Post-publication verification

Before publication, run `npm run smoke:fresh-install -- <packed-tarball>`; it installs with scripts disabled into a temporary npm prefix, uses a synthetic Pi home, runs `pi-dsbx --help`, `config`, and `doctor`, verifies the declared Pi extension, uninstalls, and emits a JSON receipt. The smoke environment is allowlisted and never copies host Pi settings or credentials. A missing `npm view pi-docker-sandboxes version --json` or public pi.dev listing is expected before the first publication and must be recorded as absence, not as successful public verification.

The workflow resolves the unversioned npm package through the `latest` tag,
installs it into a clean temporary prefix, verifies its exact version, runs
`pi-dsbx --help`, and waits up to ten minutes for
<https://pi.dev/packages/pi-docker-sandboxes> to expose the gallery install
command. Add the successful workflow URLs, package receipt, local-image receipt,
scan/SBOM evidence, E2E receipt, and command output to the release issue.

Because pi.dev indexing is external and asynchronous, npm publication cannot be
rolled back when gallery verification fails. Do not announce or close the
release until the page is available and a maintainer has confirmed its version
and install metadata, recording the page URL, timestamp, and reviewer.

## Rollback and deprecation

Published npm versions are immutable; do not overwrite them. If a release is defective:

```sh
npm deprecate pi-docker-sandboxes@X.Y.Z "Deprecated: <reason>; use <replacement>"
npm dist-tag add pi-docker-sandboxes@<replacement> latest
```

Announce the deprecated npm version, replacement, and recovery steps in the GitHub release.

Never publish automatically on merge. Never use a mutable image tag. Candidate validation is not publication approval.
