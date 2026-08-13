# Security

## Reporting

Do not open a public issue for an undisclosed vulnerability. Use [GitHub private vulnerability reporting](https://github.com/gurkanguray/pi-docker-sandboxes/security/advisories/new) for this repository. Do not include real credentials or private source in a report.

## Supported versions

Only the latest `0.1.0-alpha.x` receives security fixes during public alpha. The tested platform/version matrix is in [COMPATIBILITY.md](COMPATIBILITY.md); unlisted platforms are not claimed supported.

## Current status

Whole-Pi clone isolation, credential proxy behavior, network denial, no shared-skills mount, private Docker separation, and safe patch round-trip have real microVM tests. This remains a public alpha because Docker Kit APIs are experimental and Linux/Windows coverage is pending.

## Invariants

The package must never silently change clone to direct mode, enable shared writable skills, forward the raw host environment, mount host credential directories or the host Docker socket, continue on the host after sandbox launch fails, or remove changed/unknown sandbox work without a successful requested export or dedicated discard authority.

`--yes` is generic confirmation only and cannot authorize data loss. `--no-sync-back` disables export prompting but preserves changed work. Failed exports and failed/unknown change inspection preserve the named sandbox and report recovery commands. Direct recovery uses `pi-dsbx destroy --name NAME --direct --discard-changes`; direct destroy requires that dedicated flag or its specific interactive confirmation, never generic `--yes`. Use `--discard-changes` (or Pi's outer `--docker-sandbox-discard-changes`) only when losing sandbox work is intentional.

Docker Sandboxes limits host access; it does not make an allowed network destination, repository instruction, dependency, or tool trustworthy. See [THREAT_MODEL.md](THREAT_MODEL.md).
