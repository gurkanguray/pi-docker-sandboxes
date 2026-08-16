# Compatibility

Only environments tested in reality are marked supported.

| Component | Tested | Status |
| --- | --- | --- |
| Pi | 0.84.1 | extension load, flags, companion launch, whole-process re-exec |
| Node.js | 24.12.0 | unit and E2E runtime |
| Docker Sandboxes | 0.38.0 (`c022b146…`) | version/list/inspect/Kit/policy/clone/exec/cp/remove |
| Docker Kit schema | v2 | generated Kit accepted by real `sbx kit validate` |
| macOS 26.5.2 / Apple Silicon | exact locally tested host | artifact-bound real microVM E2E |
| Docker Engine in VM | 29.7.1 | distinct daemon identity and host-invisible container proved |
| Linux amd64 / KVM | not tested | no support claim |
| Windows 11 | not tested | no support claim |

The reusable macOS workflow binds a checked-out source SHA, verified npm
artifact integrity/version, and selected local/content image digest. Manual
dispatch requires the completed CI `run_id` containing the named package
artifact; missing artifacts fail the gate. Every run uploads logs and an
`e2e-receipt.json` with:

```text
{ sourceSha, packageIntegrity, imageDigest, selectedImage, platform,
  macosVersion, architecture, sbxVersion, piVersion, packageVersion,
  tests, testsCount, status, passedAt }
```

Only `status: "passed"` has a `passedAt` timestamp. The receipt is release
evidence only when every value matches the workflow inputs and runtime image. Linux and Windows remain unsupported because this real E2E gate runs
only on the labeled macOS Apple Silicon Docker Sandboxes runner. This evidence
does not imply support for other macOS releases.

Pinned development base image:

```text
docker/sandbox-templates@sha256:d86a6cdc105a1b299667a20c40bcf8d0584e56f21d44490a0737bb1baeb44299
```

Kit APIs remain experimental. `/docker-sandbox doctor` warns outside `sbx` 0.38.x and fails when required security capabilities are absent.
