# pi-docker-sandboxes

**Public alpha — macOS Apple Silicon only.** Run the entire Pi process inside a Docker Sandboxes microVM, using a private Git clone and explicit patch export instead of giving the agent direct write access to the host checkout.

## Supported platform and versions

The checked public-alpha path is macOS Apple Silicon with Pi 0.84.1, Node.js 24.12.0, and Docker Sandboxes (`sbx`) 0.38.x. Docker Sandbox Kits are experimental. No support is claimed for Linux or Windows; see the [compatibility matrix](COMPATIBILITY.md).

## Prerequisites

Install Pi, Node.js 24.12.0 or newer, Docker 29 or newer, and [Docker Sandboxes](https://docs.docker.com/ai/sandboxes/). Run this from a Git repository with at least one commit. For a fresh repository:

```bash
git init
git commit --allow-empty -m "Initial commit"
```

## Install

```bash
pi install npm:pi-docker-sandboxes@0.1.0-alpha.1
```

## Quick start

Run diagnostics, optionally store a model-provider key in Docker's host-side secret store, then launch:

```bash
npm exec --package=pi-docker-sandboxes@0.1.0-alpha.1 -- pi-dsbx doctor
sbx secret set <provider> # optional; configure the same provider before launch
pi --docker-sandbox
```

Omit the secret command to launch with no model credential. Do not use sandbox-local `/login`; credentials are proxy-only. See [Getting started](docs/getting-started.md) for provider configuration and image setup.

## Isolation boundary

By default the sandbox gets a private clone, a private Docker Engine, restricted network destinations, and sanitized settings/models. It does not mount host credential directories, the host Docker socket, or shared writable skills. This limits host access; it does not make repository instructions, dependencies, allowed destinations, or model output trustworthy. There is no fallback to running on the host.

## Export, apply, and cleanup

On exit, changed work can be exported to `.git/pi-docker-sandbox/patches`. Review it, then apply it explicitly:

```bash
npm exec --package=pi-docker-sandboxes@0.1.0-alpha.1 -- pi-dsbx export
npm exec --package=pi-docker-sandboxes@0.1.0-alpha.1 -- pi-dsbx apply PATCH --yes
```

Clean sandboxes are removed by default. Changed or uninspectable sandboxes are preserved unless export succeeds; `--discard-changes` is the explicit authority to permanently discard that work. `--keep` preserves the sandbox.

## Public package verification

Release candidates are smoke-tested from their packed tarball in an isolated home and npm prefix:

```bash
npm run smoke:fresh-install -- ./pi-docker-sandboxes-X.Y.Z.tgz
```

Before the first public release, an absent npm package or pi.dev listing is expected; neither is release evidence. The [source repository](https://github.com/gurkanguray/pi-docker-sandboxes) and [npm package](https://www.npmjs.com/package/pi-docker-sandboxes) become the public verification surfaces after publication.

## More information

- [Configuration](docs/configuration.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Migration](docs/migration.md)
- [Uninstall](docs/uninstall.md)
- [Support](SUPPORT.md)
- [Security](SECURITY.md) and [threat model](THREAT_MODEL.md)
- [Contributing](CONTRIBUTING.md)

## License

[MIT](LICENSE)
