# Configuration

Configuration is JSON. Global configuration is read from `~/.pi/agent/docker-sandboxes.json`. Project configuration is read from `.pi/docker-sandboxes.json` only after Pi trusts the project. The companion `pi-dsbx` CLI ignores project configuration unless `run` receives `--trust-project-config`.

Unknown fields at any level are rejected. Secrets are not configuration values; store them with `sbx secret set <provider>`.

## Fields and defaults

```json
{
  "version": 1,
  "enabled": true,
  "profile": "development",
  "syncProfile": "custom",
  "sync": {
    "settings": true,
    "models": true,
    "packages": false,
    "skills": false,
    "prompts": false,
    "themes": false,
    "extensions": false,
    "sessions": "managed"
  },
  "sandbox": {
    "keep": false,
    "dockerEngine": true
  },
  "providers": [],
  "network": {
    "allow": [],
    "deny": []
  },
  "export": {
    "onExit": "prompt",
    "directory": ".git/pi-docker-sandbox/patches"
  }
}
```

Every accepted field is described below:

- `version`: configuration schema version; only `1` is accepted.
- `enabled`: enables whole-process sandbox re-execution.
- `profile`: network/security profile: `hardened` or `development`.
- `syncProfile`: `clean`, `mirror`, or `custom`. Built-in profiles use fixed policies; only `custom` uses the `sync` object.
- `sync.settings`, `sync.models`, `sync.packages`, `sync.skills`, `sync.prompts`, `sync.themes`, `sync.extensions`: whether each sanitized personalization category is copied.
- `sync.sessions`: `managed` or `sandbox` session behavior.
- `sandbox.name`: optional sandbox name using letters, numbers, `.`, `+`, or `-`.
- `sandbox.keep`: preserves the sandbox after exit when `true`. Clean sandboxes are removed by default when `false`.
- `sandbox.dockerEngine`: enables the VM's private Docker Engine. If `false`, `sandbox.image` is required.
- `sandbox.image`: optional digest-pinned image reference; tags are rejected.
- `providers`: IDs of audited proxy services to request. Built-ins are `anthropic`, `google`, `openai`, `openrouter`, and `xai`; the service must also be available from `sbx`.
- `network.allow`, `network.deny`: additional domain lists. Wildcards such as `*.example.com` are accepted here; schemes, paths, credentials, whitespace, and invalid ports are rejected.
- `export.onExit`: `prompt`, `always`, or `never` for changed clone work.
- `export.directory`: patch output directory. Parent traversal (`..`) is rejected.

The safe personalization default imports sanitized settings and model metadata only. Packages, skills, prompts, themes, and extensions remain off. `--docker-sandbox-sync mirror` copies `npm:`/`git:` package specs so sandbox Pi can install them, plus local skills and Pi-auto-discoverable extensions that are not credential stores. Extension runtime-state directories without a Pi entrypoint, including config/log storage, stay on the host. Host paths and detected secrets stay out. Every sandbox uses a private clone and disables Docker's shared writable skills store.

## CLI overrides

The primary launch is `pi --docker-sandbox`. Pi also accepts:

```text
--docker-sandbox-profile NAME
--docker-sandbox-sync NAME
--docker-sandbox-session SESSION_ID
--docker-sandbox-name NAME
--docker-sandbox-fresh
--docker-sandbox-keep
--docker-sandbox-discard-changes
--docker-sandbox-no-host-auth
```

The companion path is:

```text
pi-dsbx run [--profile NAME] [--sync NAME] [--name NAME] [--image REF]
             [--fresh] [--keep] [--discard-changes] [--no-host-auth]
             [--trust-project-config] [--yes] [--cwd PATH] [-- PI_ARGS...]
```

`--docker-sandbox-session SESSION_ID` resumes a backed-up managed session. Do not use the standard host `--session` form: Pi resolves it before the extension loads. Use `/resume` inside an attached sandbox, or `pi-dsbx run -- --session SESSION_ID`, as alternatives. `--keep` preserves the same sandbox and does not overwrite its sessions from a backup.

Set `export.onExit` to `never` to suppress export prompting. `--discard-changes` is the dedicated authority for permanent loss; generic `--yes` is not.

## Image behavior

A configured image must be digest-pinned. With no configured image, a verified local image is required:

```bash
npm exec --package=pi-docker-sandboxes@0.1.0 -- pi-dsbx image build
```

The `hardened` profile cannot install Pi at runtime, so it requires this built image or an explicit pinned image.

## Compatibility notes

Removed legacy fields and values are rejected instead of guessed or silently migrated. Explicit `sandbox.keep` values are preserved. Review the effective merged configuration with `pi-dsbx config` before launch.
