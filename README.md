# pi-docker-sandboxes

Run Pi in an isolated Docker Sandboxes microVM while the host checkout remains under your control. Sandbox work returns as a patch for review.

## Requirements

Supported hosts are macOS 14+ on Apple Silicon and Ubuntu 24.04+ on amd64 or arm64 with KVM. Install Pi `>=0.84.1 <0.85.0`, Node.js `>=22.19.0 <25`, Docker 29+, and Docker Sandboxes 0.38.x. See [Compatibility](COMPATIBILITY.md) for the exact contract and Windows status.

## Install 1.0.0

Verify that the exact release is available from your configured npm registry. Continue only if the first command prints `1.0.0`; a registry without that release returns nonzero.

```sh
npm view pi-docker-sandboxes@1.0.0 version
pi install npm:pi-docker-sandboxes@1.0.0
npm exec --package=pi-docker-sandboxes@1.0.0 -- pi-dsbx doctor --json
```

Install only when the registry reports `1.0.0`. A signed release also records the matching npm integrity and provenance; do not substitute an archive or floating version.

Run from a Git repository with at least one commit. For a new repository:

```sh
git init
git commit --allow-empty --only -m "Initial commit"
```

## Run

```sh
pi --docker-sandbox
```

Production defaults are hardened networking, the standard non-privileged runtime, no host authentication, no model metadata, no imported resources, and a disabled private Docker Engine. Managed session backups use bounded retention. Changed or uninspectable work is preserved unless you explicitly authorize discard.

Use redacted JSON diagnostics for automation:

```sh
npm exec --package=pi-docker-sandboxes@1.0.0 -- pi-dsbx status --json
npm exec --package=pi-docker-sandboxes@1.0.0 -- pi-dsbx doctor --json
```

## Documentation

- [Get started](https://gurkanguray.github.io/pi-docker-sandboxes/getting-started)
- [CLI reference](https://gurkanguray.github.io/pi-docker-sandboxes/cli-reference)
- [Configuration](https://gurkanguray.github.io/pi-docker-sandboxes/configuration)
- [Troubleshooting](https://gurkanguray.github.io/pi-docker-sandboxes/troubleshooting)
- [Compatibility](COMPATIBILITY.md)
- [Support](SUPPORT.md)
- [Security](SECURITY.md)
- [Contributing](CONTRIBUTING.md)

## License

[MIT](LICENSE)
