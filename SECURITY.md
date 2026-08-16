# Security

## Reporting

Do not open a public issue for an undisclosed vulnerability. Use [GitHub private vulnerability reporting](https://github.com/gurkanguray/pi-docker-sandboxes/security/advisories/new) for this repository. Do not include real credentials or private source in a report.

## Supported versions

Only the latest `0.1.x` release receives security fixes during Early Access. The tested platform/version matrix is in [COMPATIBILITY.md](COMPATIBILITY.md); unlisted platforms are not claimed supported.

## Current status

Whole-Pi clone isolation, credential proxy behavior, network denial, no shared-skills mount, private Docker separation, and safe patch round-trip have real microVM tests. This remains Early Access because Docker Kit APIs are experimental and Linux/Windows coverage is pending.

## Invariants

The package must always use a private clone, disable shared writable skills, sanitize the host environment, avoid host credential-directory and host Docker-socket mounts, fail instead of continuing on the host, and preserve changed/unknown sandbox work without a successful requested export or dedicated discard authority.

`--yes` is generic confirmation only and cannot authorize data loss. Set `export.onExit` to `never` to disable export prompting; changed work remains preserved. Failed exports and failed/unknown change inspection preserve the named sandbox and report recovery commands. Use `--discard-changes` (or Pi's outer `--docker-sandbox-discard-changes`) only when losing sandbox work is intentional.

Docker Sandboxes limits host access; it does not make an allowed network destination, repository instruction, dependency, or tool trustworthy. See [THREAT_MODEL.md](THREAT_MODEL.md).
