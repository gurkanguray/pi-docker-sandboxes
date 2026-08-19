# Security

## Report a vulnerability

Do not open a public issue for an undisclosed vulnerability. Use [GitHub private vulnerability reporting](https://github.com/gurkanguray/pi-docker-sandboxes/security/advisories/new).

Do not include real credentials, private source, or sensitive patches. Reports should identify the affected latest 1.x version and provide the smallest safe reproduction.

## Supported versions

Security fixes target the latest 1.x release. Older 1.x releases may be asked to upgrade before investigation; obsolete versions receive no fixes. See [Compatibility](COMPATIBILITY.md) for the current host and dependency boundary.

## Security boundary

Production defaults use the standard non-privileged runtime, hardened networking, authentication mode `none`, no model metadata, no resource import, and a disabled private Docker Engine. The host source is read-only to the microVM; work happens in a private clone and returns through a reviewed binary Git patch.

The package does not mount host credential directories, the host Docker socket, or shared writable skills. Opted-in data is sanitized and copied. Authentication and network access require explicit configuration. `oauth-copy` exposes copied OAuth material inside the sandbox and requires interactive confirmation.

Changed or uninspectable work is preserved on ambiguity. `--yes` never authorizes data loss; `--discard-changes` does.

Isolation does not make repository instructions, dependencies, allowed destinations, tools, or model output trustworthy. See the [threat model](THREAT_MODEL.md).

The signed release binds the package and immutable public runtime digest to checksums, SBOMs, scans, GitHub OIDC provenance, compatibility evidence, and hardware receipts. `.trivyignore.yaml` is a schema-checked inventory for the unpublished legacy Docker variant only; its `authorization: none` records never suppress or authorize a standard-runtime finding.
