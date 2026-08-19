# Architecture

Pi Docker Sandboxes is a host controller. Its invariants are host-source custody, explicit privilege, immutable runtime identity, and preservation on ambiguity.

```text
host Pi extension / pi-dsbx
  -> certified host adapter + strict merged configuration
  -> exclusive repository-and-sandbox lifecycle lease
  -> durable state transition and daemon reconciliation
  -> sanitized, immutable Kit files + standard runtime digest
  -> sbx argv adapter (no shell)
    -> Docker Sandboxes microVM
      -> sandbox-only runtime extension + Pi
      -> private Git clone; host source remains read-only
  -> durable session backup and binary Git patch export
  -> identity/base/clean checks + explicit host apply
```

## Controller and runtime

The npm controller contains the host extension, CLI, configuration, lifecycle, diagnostics, and a small sandbox-only runtime extension. The public standard OCI image contains Pi and required tools, not the controller package. Kit generation injects the runtime extension and starts it explicitly.

The locked standard image is a non-privileged multiarch OCI index. The host adapter maps macOS arm64 and Ubuntu arm64 to `linux/arm64`, and Ubuntu amd64 to `linux/amd64`. The private Docker Engine path is disabled in 1.0.0; configuration cannot silently select a privileged image.

Package version, configuration schema, lifecycle-state schema, runtime schema, Kit schema, and image digest are separate compatibility dimensions. A package resumes only combinations declared compatible in code.

## Lifecycle and custody

Every mutating operation acquires an exclusive lease scoped to canonical repository identity and sandbox name. The lease records the operation, process, host, and start time. A live or uncertain lease fails closed; `unlock` removes only a demonstrably abandoned local lease with explicit authority.

Durable state records repository and worktree identity, base commit, image, runtime schema, package version, phase, timestamps, and last operation error. State is written before external create, export, or remove effects. Startup, `status`, and `doctor` reconcile interrupted state with daemon and image truth. Ambiguous state preserves the sandbox.

Each launch uses a private clone. The microVM cannot write the host checkout. Export creates a durable binary Git patch; apply verifies repository identity, worktree identity, base commit, and a clean host tree. Changed or uninspectable work is never removed without interactive confirmation or `--discard-changes`.

Managed sessions are copied through controlled staging, stored outside the sandbox, and pruned by count, age, and byte ceilings while retaining the newest valid backup. Restore and delete are explicit leased operations.

## Security boundary

Production defaults are hardened networking, authentication mode `none`, no model metadata, no resource import, managed sessions, the standard non-privileged image, and no private Docker Engine. Opted-in settings and resources pass allowlists, path/link/race controls, and immutable dependency checks. The launcher strips credential and SSH-agent variables before invoking `sbx`.

The host controller never falls back to executing Pi on the host. Unsupported platforms, malformed configuration, image mismatch, upgrade mismatch, unknown future state, or missing safety capabilities fail before mutation.

## Operations

`status --json` and `doctor --json` produce redacted schema-versioned receipts with deterministic exit codes. Diagnostics cover platform, Docker/SBX, KVM, Git/worktree identity, image selection, lease and lifecycle health, upgrade compatibility, disk space, backup retention, and credential mode without secret values.

The stable release consumes a previously published immutable GHCR digest. Release verification binds that digest and the exact npm tarball to SBOMs, vulnerability scans, GitHub OIDC provenance, hardware E2E, cleanup, and installation receipts.
