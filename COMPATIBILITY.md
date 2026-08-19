# Compatibility

## Package requirements

| Component | Requirement |
| --- | --- |
| Host Pi (latest tested) | 0.84.2 |
| Host Pi requirement | `>=0.84.1 <0.85.0` |
| Standard runtime Pi (independent image lock) | `0.84.1` |
| Node.js | `^22.19.0 || ^24.12.0` |
| Docker | 29+ |
| Docker Sandboxes | 0.38.x |
| Runtime schema | 1 |
| Kit schema | 2 |

## Supported hosts

| Host | Architecture | Status |
| --- | --- | --- |
| macOS 14+ | Apple Silicon | Supported |
| Ubuntu 24.04+ | amd64, arm64 | Supported; KVM required |

These are the only production-supported host combinations. Each release is gated by real hardware execution on macOS arm64, Ubuntu amd64 with KVM, and Ubuntu arm64 with KVM.

Windows 11 x64 is the next package milestone. Docker Sandboxes and Pi have upstream Windows paths, but this package's native supervision, filesystem, installation, and recovery lifecycle is not certified on Windows. The package fails before sandbox mutation until that adapter and its hardware gate pass.

## Runtime image

The production standard runtime is public and immutable:

`ghcr.io/gurkanguray/pi-docker-sandboxes-runtime-standard@sha256:43433061a13ba16ca6e2d327d245844199acd231b9a4087aa26773e5f2d6714b`

The OCI index contains `linux/amd64` and `linux/arm64`. It is non-privileged and release verification binds this exact digest to its scans, SBOMs, GitHub OIDC provenance, runtime receipt, and hardware receipts. The private Docker Engine variant is disabled in 1.0.0.

## Upgrade policy

A compatible package resumes only state and runtime schemas it explicitly recognizes. Version 1 state is backed up, reconciled with daemon and image identity, then migrated to version 2. Unknown future state, package/runtime mismatch, or image drift fails without modifying the sandbox; export work and recreate with the current package.

## Known limitations

- Docker Sandbox Kits remain experimental upstream.
- There is no stable programmatic library API.
