# Security

## Report a vulnerability

Do not open a public issue for an undisclosed vulnerability. Use [GitHub private vulnerability reporting](https://github.com/gurkanguray/pi-docker-sandboxes/security/advisories/new).

Do not include real credentials, private source, or sensitive patches.

## Security boundary

The package:

- runs Pi from a private Git clone inside a Docker Sandboxes microVM;
- does not mount host credential directories, the host Docker socket, or shared writable skills;
- sanitizes host settings and credentials before copying eligible data;
- fails instead of falling back to the host;
- preserves changed or uninspectable sandbox work unless export succeeds or discard is explicit.

`--yes` never authorizes data loss. `--discard-changes` is explicit authority to lose sandbox work.

Isolation limits host access. It does not make repository instructions, dependencies, allowed network destinations, tools, or model output trustworthy. See the [threat model](THREAT_MODEL.md).

The project owns its package and image assembly, not inherited Docker-owned binaries.

## Supported versions

No public release exists yet. After `0.1.0` is published, security fixes target the latest `0.1.x` release under the current [compatibility policy](COMPATIBILITY.md).
