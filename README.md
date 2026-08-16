# pi-docker-sandboxes

**Early Access — tested on macOS 26.5.2 Apple Silicon only.** Run the entire Pi process inside a Docker Sandboxes microVM, using a private Git clone and explicit patch export instead of giving the agent direct write access to the host checkout.

## Supported platform and versions

The checked Early Access path is macOS 26.5.2 on Apple Silicon with Pi 0.84.1, Node.js 24.12.0, Docker Engine 29.7.1, and Docker Sandboxes (`sbx`) 0.38.0. Other macOS releases are not yet validated or supported for this release. Docker Sandbox Kits are experimental. Linux and Windows are unsupported; see the [compatibility matrix](COMPATIBILITY.md).

## Prerequisites

Install Pi, Node.js `>=24.12.0 <25`, Docker 29 or newer, and [Docker Sandboxes](https://docs.docker.com/ai/sandboxes/). Run this from a Git repository with at least one commit. For a fresh repository:

```bash
git init
git commit --allow-empty -m "Initial commit"
```

## Install

```bash
pi install npm:pi-docker-sandboxes@0.1.0
```

## Quick start

Run diagnostics, optionally store a model-provider key in Docker's host-side secret store, then launch:

```bash
npm exec --package=pi-docker-sandboxes@0.1.0 -- pi-dsbx doctor
npm exec --package=pi-docker-sandboxes@0.1.0 -- pi-dsbx image build
pi --docker-sandbox
```

The Early Access release intentionally publishes no registry image; build the verified local image once as shown above, or configure your own digest-pinned image. Missing host Pi API keys are copied into `sbx secret` under the same provider ID. OAuth entries are copied into the attested sandbox after Kit validation. Use `--docker-sandbox-no-host-auth` to skip both. Do not use sandbox-local `/login`. See [Getting started](docs/getting-started.md) for provider configuration and image setup.

## Resume a managed session

Resume a backed-up managed session by its Pi session ID:

```bash
pi --docker-sandbox --docker-sandbox-session SESSION_ID
```

The standard host `--session` flag is unsupported because Pi resolves it before this extension loads. Inside a running sandbox, `/resume` is the interactive alternative. `--keep` preserves the same sandbox, so its sessions remain available there. The companion CLI can pass Pi's flag after its launcher separator:

```bash
pi-dsbx run -- --session SESSION_ID
```

## Isolation boundary

By default the sandbox gets a private clone, a private Docker Engine, restricted network destinations, and sanitized settings/models. It does not mount host credential directories, the host Docker socket, or shared writable skills. This limits host access; it does not make repository instructions, dependencies, allowed destinations, or model output trustworthy. There is no fallback to running on the host.

## Export, apply, and cleanup

On exit, changed work can be exported to `.git/pi-docker-sandbox/patches`. Review it, then apply it explicitly:

```bash
npm exec --package=pi-docker-sandboxes@0.1.0 -- pi-dsbx export
npm exec --package=pi-docker-sandboxes@0.1.0 -- pi-dsbx apply PATCH --yes
```

Clean sandboxes are removed by default. Changed or uninspectable sandboxes are preserved unless export succeeds; `--discard-changes` is the explicit authority to permanently discard that work. `--keep` preserves the sandbox.

## Public package verification

Release candidates are smoke-tested from their packed tarball in an isolated home and npm prefix:

```bash
npm run smoke:fresh-install -- ./pi-docker-sandboxes-X.Y.Z.tgz
```

Before the first public release, an absent npm package or pi.dev listing is expected; neither is release evidence. The [source repository](https://github.com/gurkanguray/pi-docker-sandboxes) and [npm package](https://www.npmjs.com/package/pi-docker-sandboxes) become the public verification surfaces after publication.

## More information

- [Documentation source](https://github.com/gurkanguray/pi-docker-sandboxes/tree/main/docs)
- [Configuration](docs/configuration.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Migration](docs/migration.md)
- [Uninstall](docs/uninstall.md)
- [Support](SUPPORT.md)
- [Security](SECURITY.md) and [threat model](THREAT_MODEL.md)
- [Contributing](CONTRIBUTING.md)

## License

[MIT](LICENSE)
