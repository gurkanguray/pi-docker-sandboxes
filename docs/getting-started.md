# Getting started

## Requirements

| Component | Requirement |
| --- | --- |
| Host | macOS 14+ on Apple Silicon; Ubuntu 24.04+ on amd64 or arm64 with KVM |
| Pi | `>=0.84.1 <0.85.0` |
| Node.js | `^22.19.0 \|\| ^24.12.0` |
| Docker | 29+ |
| Docker Sandboxes | 0.38.x |

The standard non-privileged runtime is the public multiarch index `ghcr.io/gurkanguray/pi-docker-sandboxes-runtime-standard@sha256:43433061a13ba16ca6e2d327d245844199acd231b9a4087aa26773e5f2d6714b` for `linux/amd64` and `linux/arm64`. See [Compatibility](https://github.com/gurkanguray/pi-docker-sandboxes/blob/main/COMPATIBILITY.md) before using another host.

Run from a Git repository with at least one commit. For a new repository:

```sh
git init
git commit --allow-empty --only -m "Initial commit"
```

## Install

Verify the exact version from your configured registry. Continue only when this check prints `1.0.0`; a registry without that release returns nonzero.

```sh
npm view pi-docker-sandboxes@1.0.0 version
pi install npm:pi-docker-sandboxes@1.0.0
npm exec --package=pi-docker-sandboxes@1.0.0 -- pi-dsbx doctor --json
```

Review the redacted JSON and fix every failed check before launch. The signed release evidence records the package integrity, immutable runtime digest, scans, SBOMs, GitHub OIDC provenance, and hardware receipts.

## Run

```sh
pi --docker-sandbox
```

The default is hardened networking, authentication mode `none`, no model metadata, no packages or other host resources, managed session backups, and a disabled private Docker Engine. Configure authentication or resource import explicitly; `--docker-sandbox-no-host-auth` forces no host authentication for one launch.

Pass Pi arguments normally:

```sh
pi --docker-sandbox --model PROVIDER/MODEL
```

## Keep your work

On exit, accept export to create a binary patch under `.git/pi-docker-sandbox/patches/`. Declining preserves changed or uninspectable work in the sandbox.

```sh
npm exec --package=pi-docker-sandboxes@1.0.0 -- pi-dsbx export --name NAME
npm exec --package=pi-docker-sandboxes@1.0.0 -- pi-dsbx apply PATCH --name NAME --yes
```

Review the patch before `apply`. The host checkout must still match the recorded repository, worktree, base commit, and clean-tree checks. Never destroy the sandbox until the patch is applied and verified.

## Upgrade

Install a newer exact 1.x version, then run `pi-dsbx doctor --json` before resuming a sandbox. Compatible state is backed up and migrated after daemon/image reconciliation. An unknown state version, runtime mismatch, or image drift fails closed: export work with the old compatible package when possible, then recreate.

## Next steps

- [CLI reference](cli-reference.md)
- [Configuration](configuration.md)
- [Troubleshooting](troubleshooting.md)
- [Uninstall](uninstall.md)
