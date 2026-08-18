# CLI reference

## Pi flags

Launch with `pi --docker-sandbox`. Other Pi flags pass through unchanged, except for the managed-session form below.

| Flag | Value | Effect |
| --- | --- | --- |
| `--docker-sandbox` | boolean | Run Pi inside Docker Sandboxes. |
| `--docker-sandbox-profile` | `development` (default) or `hardened` | Select the security profile. |
| `--docker-sandbox-sync` | `custom` (default), `clean`, or `mirror` | Select the synchronization profile. |
| `--docker-sandbox-session` | session ID | Restore a backed-up managed session. |
| `--docker-sandbox-name` | name | Select or reuse a named sandbox. |
| `--docker-sandbox-fresh` | boolean | Create a fresh sandbox. Cannot be combined with a configured or explicit name. |
| `--docker-sandbox-keep` | boolean | Preserve the sandbox after Pi exits. |
| `--docker-sandbox-discard-changes` | boolean | Allow permanent removal of unexported work. |
| `--docker-sandbox-no-host-auth` | boolean | Skip host API-key and OAuth synchronization. |
| `--yes` | boolean | Accept safe prompts. Never approves native compilation or changed-work destruction. |

## Slash commands

| Command | Effect |
| --- | --- |
| `/docker-sandbox` | Show status. |
| `/docker-sandbox status` | Show status. |
| `/docker-sandbox doctor` | Run diagnostics. |
| `/docker-sandbox config` | Show the effective configuration. |

## Companion commands

`pi-dsbx` with no arguments is the same as `pi-dsbx run`.

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

| Command | Effect |
| --- | --- |
| `pi-dsbx run` | Launch Pi in a sandbox. |
| `pi-dsbx status` | Show process status; on the host, also list sandboxes. |
| `pi-dsbx doctor` | Check the platform, tools, image, repository, and configuration. |
| `pi-dsbx config` | Print the effective host configuration as JSON. |
| `pi-dsbx export` | Export changed sandbox work as a patch. |
| `pi-dsbx apply` | Apply a patch to the host checkout. |
| `pi-dsbx destroy` | Remove a sandbox under the safety rules below. |
| `pi-dsbx image build` | Build, verify, and load the locked local image. |

Top-level help: `pi-dsbx --help`, `pi-dsbx -h`, or `pi-dsbx help`.

If `pi-dsbx` is not on `PATH`, prefix commands with `npm exec --package=pi-docker-sandboxes@0.1.0 --`.

## `run` options

Options follow `run`. Value flags use a separate argument.

| Flag | Value | Effect |
| --- | --- | --- |
| `--profile` | `development` (default) or `hardened` | Select the security profile. |
| `--sync` | `custom` (default), `clean`, or `mirror` | Select the synchronization profile. |
| `--name` | name | Select or reuse a named sandbox. |
| `--image` | image reference | Use an immutable SHA-256 digest reference. |
| `--cwd` | path | Use the Git repository containing this path. Defaults to the current directory. |
| `--fresh` | none | Create a fresh sandbox; cannot be combined with `--name` or a configured name. |
| `--keep` | none | Preserve the sandbox after Pi exits. |
| `--discard-changes` | none | Provide noninteractive authority to permanently remove unexported work. |
| `--no-host-auth` | none | Skip host API-key and OAuth synchronization. |
| `--trust-project-config` | none | Allow `.pi/docker-sandboxes.json`. |
| `--yes` | none | Accept safe prompts. Does not approve native compilation or changed-work destruction. |
| `-- PI_ARGS...` | Pi arguments | Stop launcher parsing and pass the rest to Pi. |

## Export, apply, and destroy

| Command | Effect |
| --- | --- |
| `pi-dsbx export --name NAME` | Export from `NAME`. Omit `--name` for the repository sandbox. |
| `pi-dsbx apply PATCH --name NAME --yes` | Apply `PATCH`. Omit `--yes` to confirm interactively. |
| `pi-dsbx destroy --name NAME --yes` | Remove a confirmed clean sandbox. `--yes` never authorizes changed or uninspectable work loss. |
| `pi-dsbx destroy --name NAME --discard-changes` | Noninteractively remove changed or uninspectable work. This is explicit data-loss authority. |

An interactive confirmation can remove changed or uninspectable work when `--discard-changes` is omitted. Clean sandboxes are removed by default; changed or uninspectable sandboxes are preserved without explicit authority. `--keep` preserves the same sandbox.

## Resume a session

Restore a backed-up managed session:

```bash
pi --docker-sandbox --docker-sandbox-session SESSION_ID
```

The host `--session` form is unsupported because Pi resolves it before the extension loads. Inside a sandbox, use `/resume`. The companion CLI can pass the Pi flag after `--`:

```bash
pi-dsbx run -- --session SESSION_ID
```

See [Configuration](configuration.md) and [Troubleshooting](troubleshooting.md).
