# CLI reference

## Pi flags

Launch with `pi --docker-sandbox`. Other Pi flags pass through to sandbox Pi except the managed-session form described below.

| Flag | Value | Effect |
| --- | --- | --- |
| `--docker-sandbox` | boolean | Run Pi inside Docker Sandboxes. |
| `--docker-sandbox-profile` | `hardened` (default), `development` | Override the security profile. |
| `--docker-sandbox-sync` | `custom` (default), `clean`, `mirror` | Override the synchronization profile. |
| `--docker-sandbox-session` | session ID | Restore a retained managed session before launch. |
| `--docker-sandbox-name` | name | Select or reuse a named sandbox. |
| `--docker-sandbox-fresh` | boolean | Create a fresh sandbox; cannot be combined with an explicit or configured name. |
| `--docker-sandbox-keep` | boolean | Preserve the sandbox after Pi exits. |
| `--docker-sandbox-discard-changes` | boolean | Authorize permanent loss of changed or uninspectable sandbox work on exit. |
| `--docker-sandbox-no-host-auth` | boolean | Force authentication mode `none` for this launch. |
| `--yes` | boolean | Accept safe Pi prompts; never approves native compilation or changed-work destruction. |

## Slash commands

| Command | Effect |
| --- | --- |
| `/docker-sandbox` | Show status. |
| `/docker-sandbox status` | Show status. |
| `/docker-sandbox doctor` | Run human-readable diagnostics. |
| `/docker-sandbox config` | Show effective trusted configuration. |

## Companion CLI

`pi-dsbx` with no arguments is the same as `pi-dsbx run`. If it is not on `PATH`, prefix it with `npm exec --package=pi-docker-sandboxes@1.0.0 --`.

```text
pi-dsbx run [options] [-- PI_ARGS...]
pi-dsbx status [--json]
pi-dsbx doctor [--json]
pi-dsbx config
pi-dsbx export [--name NAME]
pi-dsbx apply PATCH [--name NAME] --yes
pi-dsbx destroy [--name NAME] [--yes] [--discard-changes]
pi-dsbx unlock --name NAME --yes
pi-dsbx sessions list [--name NAME]
pi-dsbx sessions restore [BACKUP] [--name NAME]
pi-dsbx sessions delete BACKUP [--name NAME] --yes
```

Top-level help is available as `pi-dsbx --help`, `pi-dsbx -h`, or `pi-dsbx help`.

| Command | Effect |
| --- | --- |
| `pi-dsbx run` | Launch Pi and finalize export/session/cleanup; launcher failure is nonzero even if Pi succeeded. |
| `pi-dsbx status` | Show sandbox presence on the host. `--json` emits a redacted schema-versioned receipt and returns 1 when a check fails. |
| `pi-dsbx doctor` | Check host, tools, KVM, image, lease, lifecycle, upgrade, storage, retention, authentication mode, and Git. `--json` emits a redacted schema-versioned receipt and returns 1 when a check fails. |
| `pi-dsbx config` | Print effective host configuration as JSON. |
| `pi-dsbx export` | Durably export changed sandbox work as a binary Git patch. |
| `pi-dsbx apply` | Apply a patch after repository, worktree, base, and clean-tree checks. |
| `pi-dsbx destroy` | Remove a sandbox under the custody rules below. |
| `pi-dsbx unlock` | Remove an abandoned local lifecycle lease only after recorded-process absence checks and `--yes`. |
| `pi-dsbx sessions list\|restore\|delete` | Inspect or explicitly manage bounded session backups. |

## `run` options

Options precede `--`. Value flags require a separate argument.

| Flag | Value | Effect |
| --- | --- | --- |
| `--profile` | `hardened` (default), `development` | Override the security profile. |
| `--sync` | `custom` (default), `clean`, `mirror` | Override the synchronization profile. |
| `--name` | name | Select or reuse a named sandbox. |
| `--cwd` | path | Use the Git repository containing this path; defaults to the current directory. |
| `--fresh` | none | Create a fresh sandbox; cannot be combined with an explicit or configured name. |
| `--keep` | none | Preserve the sandbox after Pi exits. |
| `--discard-changes` | none | Provide noninteractive authority to permanently remove changed or uninspectable work. |
| `--no-host-auth` | none | Force authentication mode `none`. |
| `--trust-project-config` | none | Allow `.pi/docker-sandboxes.json` for this companion launch. |
| `--yes` | none | Accept safe prompts; does not approve native compilation or changed-work destruction. |
| `-- PI_ARGS...` | Pi arguments | Stop launcher parsing and pass remaining arguments to Pi. |

## Export, apply, and destroy

| Command | Effect |
| --- | --- |
| `pi-dsbx export --name NAME` | Export `NAME`; omit `--name` for the repository-derived sandbox. |
| `pi-dsbx apply PATCH --name NAME --yes` | Apply `PATCH`; omit `--yes` for interactive confirmation. |
| `pi-dsbx destroy --name NAME --yes` | Remove only confirmed clean work. `--yes` never authorizes unknown or changed-work loss. |
| `pi-dsbx destroy --name NAME --discard-changes` | Permanently remove changed or uninspectable work; this is explicit data-loss authority. |

::: danger Destructive authority
Review or export all work before `pi-dsbx destroy --name NAME --discard-changes`. This cannot be undone.
:::

Without discard authority, clean sandboxes are removed by default and changed or uninspectable sandboxes are preserved. Interactive confirmation may authorize changed-work removal. `--keep` preserves the same sandbox.

## Lifecycle leases

Mutating commands take an exclusive repository-and-sandbox lifecycle lease. A live or uncertain lease blocks mutation. After confirming the recorded process is absent and no operation is active:

```sh
pi-dsbx unlock --name NAME --yes
```

Do not delete lease files manually. `status --json` and `doctor --json` inspect lease health without stealing a live lease.

## Managed sessions

```sh
pi-dsbx sessions list [--name NAME]
pi-dsbx sessions restore [BACKUP] [--name NAME]
pi-dsbx sessions delete BACKUP [--name NAME] --yes
```

`list` prints backup metadata. `restore` uses the newest valid backup when `BACKUP` is omitted and requires compatible ready sandbox state and exact image identity. `delete` permanently removes one backup and therefore requires `--yes`. Retention prunes older backups by count, age, and bytes while keeping the newest valid backup.

To restore at launch through Pi:

```sh
pi --docker-sandbox --docker-sandbox-session SESSION_ID
```

The host `--session` form is unsupported because Pi resolves it before the extension loads. Inside the sandbox, use `/resume`. The companion CLI passes Pi's session flag after `--`:

```sh
pi-dsbx run -- --session SESSION_ID
```

See [Configuration](configuration.md) and [Troubleshooting](troubleshooting.md).
