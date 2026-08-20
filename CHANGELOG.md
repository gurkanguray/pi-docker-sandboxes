# Changelog

## 1.0.0 — 2026-08-19

- Support macOS 14+ on Apple Silicon and Ubuntu 24.04+ on amd64 or arm64 with KVM through explicit host adapters and release-gated hardware validation.
- Run the standard non-privileged runtime from an immutable public multiarch GHCR digest with SBOM, vulnerability-scan, and GitHub OIDC provenance evidence.
- Make hardened networking, no host authentication, no model or resource import, and no private Docker Engine the production defaults.
- Add exclusive lifecycle leases, durable crash-recoverable state transitions, operation deadlines, safe export/apply/destroy behavior, and worktree-aware identity.
- Add schema-versioned redacted `status --json` and `doctor --json` diagnostics, upgrade checks, bounded managed-session backups, and explicit restore/delete commands.
- Publish stable npm packaging and signed-release verification for the exact `1.0.0` package.
