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

The Early Access release intentionally publishes no registry image; build the verified local image once as shown above, or configure your own digest-pinned image. Detected host Pi API keys with matching Docker Sandboxes credential services are copied through stdin under the same provider ID only when no `sbx` secret is configured; existing `sbx` secrets are preserved. OAuth entries are copied into the attested sandbox after Kit validation. Use `--docker-sandbox-no-host-auth` to skip both. Do not use sandbox-local `/login`. See [Getting started](docs/getting-started.md) for provider configuration and image setup.

## Complete command reference

### Pi extension flags

Launch with `pi --docker-sandbox`. Ordinary Pi flags, such as `--model`, pass through unchanged except for the managed-session form documented below.

| Flag | Value | Effect |
| --- | --- | --- |
| `--docker-sandbox` | boolean | Launch Pi inside Docker Sandboxes. |
| `--docker-sandbox-profile` | `development` (default) or `hardened` | Override the network security profile. |
| `--docker-sandbox-sync` | `custom` (default), `clean`, or `mirror` | Override the Pi synchronization profile. |
| `--docker-sandbox-session` | session ID | Restore a backed-up managed Pi session. Do not use host `--session`. |
| `--docker-sandbox-name` | name | Select or reuse a named sandbox. |
| `--docker-sandbox-fresh` | boolean | Generate a fresh sandbox; it cannot be combined with `--docker-sandbox-name` or a configured sandbox name. |
| `--docker-sandbox-keep` | boolean | Preserve the sandbox after Pi exits. |
| `--docker-sandbox-discard-changes` | boolean | Provide noninteractive authority to permanently remove unexported work. |
| `--docker-sandbox-no-host-auth` | boolean | Skip API-key and OAuth synchronization from the host. |
| `--yes` | boolean | Accept safe noninteractive prompts. It never approves native package compilation or dirty/unknown destruction. |

Inside Pi, use `/docker-sandbox status`, `/docker-sandbox doctor`, or `/docker-sandbox config`. `/docker-sandbox` without an argument is the same as `status`.

### Companion commands

The syntax below uses `pi-dsbx`. If it is not on `PATH`, prefix a command with `npm exec --package=pi-docker-sandboxes@0.1.0 --`. Top-level help is available through `pi-dsbx --help`, `pi-dsbx -h`, or `pi-dsbx help`. `pi-dsbx` with no arguments is the same as `pi-dsbx run`.

```text
pi-dsbx run [options] [-- PI_ARGS...]
pi-dsbx status
pi-dsbx doctor
pi-dsbx config
pi-dsbx export [--name NAME]
pi-dsbx apply PATCH [--name NAME] --yes
pi-dsbx destroy [--name NAME] [--yes] [--discard-changes]
pi-dsbx image build
```

| Command | Purpose |
| --- | --- |
| `pi-dsbx run` | Launch Pi through the companion CLI. Its flags are listed below. |
| `pi-dsbx status` | Show whether the current process is sandboxed; on the host, also list sandboxes. |
| `pi-dsbx doctor` | Check the supported platform, tools, capabilities, image, repository, and configuration. |
| `pi-dsbx config` | Print the effective host configuration as JSON. |
| `pi-dsbx export` | Export changed sandbox work as a patch without applying it. |
| `pi-dsbx apply` | Apply `PATCH` to the host checkout after confirmation; `--yes` makes this noninteractive. |
| `pi-dsbx destroy` | Remove a sandbox under the safety rules described below. |
| `pi-dsbx image build` | Build, verify, and load the locked local image. |

### `pi-dsbx run` flags

Options must follow `run`; value flags use a separate argument.

| Flag | Value | Effect |
| --- | --- | --- |
| `--profile` | `development` (default) or `hardened` | Override the network security profile. |
| `--sync` | `custom` (default), `clean`, or `mirror` | Override the synchronization profile. |
| `--name` | name | Select or reuse a named sandbox. |
| `--image` | image reference | Use an immutable SHA-256 digest reference. |
| `--cwd` | path | Launch for the Git repository containing this path; the default is the current directory. |
| `--fresh` | none | Generate a fresh sandbox name; it cannot be combined with `--name` or a configured sandbox name. |
| `--keep` | none | Preserve the sandbox after Pi exits. |
| `--discard-changes` | none | Provide noninteractive authority to permanently remove unexported work. |
| `--no-host-auth` | none | Skip API-key and OAuth synchronization from the host. |
| `--trust-project-config` | none | Allow `.pi/docker-sandboxes.json`; otherwise the companion ignores project configuration. |
| `--yes` | none | Accept safe noninteractive prompts; it does not approve native compilation or dirty/unknown destruction. |
| `-- PI_ARGS...` | Pi arguments | Stop launcher parsing and pass the remaining arguments to Pi, for example `-- --session SESSION_ID`. |

### Export, apply, and destroy flags

| Command or flag | Effect |
| --- | --- |
| `pi-dsbx export --name NAME` | Export from `NAME`; omit `--name` to use the deterministic repository sandbox name. |
| `pi-dsbx apply PATCH --name NAME --yes` | Apply `PATCH` from `NAME`; omit `--name` for the repository sandbox and omit `--yes` only when an interactive confirmation is available. |
| `pi-dsbx destroy --name NAME --yes` | Remove a confirmed clean sandbox. `--yes` alone never authorizes changed or uninspectable work loss. |
| `pi-dsbx destroy --name NAME --discard-changes` | Noninteractively remove changed or uninspectable work. This is explicit data-loss authority. |

An interactive confirmation can also authorize changed or uninspectable work destruction when `--discard-changes` is omitted.

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

Clean sandboxes are removed by default. Changed or uninspectable sandboxes are preserved unless export succeeds or the user explicitly confirms their destruction. `--discard-changes` provides the noninteractive authority to permanently discard that work. `--keep` preserves the sandbox.

## Verify the public package

A release is ready to announce only when npm's `latest` tag reports the exact version and the Pi package gallery exposes its install command:

```bash
npm view pi-docker-sandboxes@latest version --json
```

The command must print `"0.1.0"`. Verify the [npm package](https://www.npmjs.com/package/pi-docker-sandboxes), [Pi package listing](https://pi.dev/packages/pi-docker-sandboxes), and [source repository](https://github.com/gurkanguray/pi-docker-sandboxes). Candidate and publication verification details are in [RELEASE.md](RELEASE.md).

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
