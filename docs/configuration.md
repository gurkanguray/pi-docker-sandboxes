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
  "workspaceMode": "clone",
  "shareSkills": false,
  "sandbox": {
    "keep": false,
    "dockerEngine": true
  },
  "providers": [],
  "services": [],
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
- `profile`: network/security profile: `hardened`, `development`, `research`, or `browser`.
- `syncProfile`: `clean`, `balanced`, `mirror`, or `custom`. Built-in profiles use fixed policies; only `custom` uses the `sync` object.
- `sync.settings`, `sync.models`, `sync.packages`, `sync.skills`, `sync.prompts`, `sync.themes`, `sync.extensions`: whether each sanitized personalization category is copied.
- `sync.sessions`: `managed`, `sandbox`, or `ephemeral` session behavior.
- `workspaceMode`: safe default `clone`, or weaker `direct` host-workspace access.
- `shareSkills`: mounts Docker's shared writable skills store when `true`; this weakens isolation and requires explicit approval.
- `sandbox.name`: optional sandbox name using letters, numbers, `.`, `+`, or `-`.
- `sandbox.keep`: preserves the sandbox after exit when `true`. Clean sandboxes are removed by default when `false`.
- `sandbox.dockerEngine`: enables the VM's private Docker Engine. If `false`, `sandbox.image` is required.
- `sandbox.image`: optional digest-pinned image reference; tags are rejected.
- `providers`: IDs of audited proxy services to request. Built-ins are `anthropic`, `google`, `openai`, `openrouter`, and `xai`; the service must also be available from `sbx`.
- `services`: custom audited proxy mappings. Each entry accepts only `id`, `envVar`, `domains`, `headerName`, and `valueFormat`. Domains must be exact, `envVar` must be uppercase, and `valueFormat` must contain exactly one `%s`.
- `network.allow`, `network.deny`: additional domain lists. Wildcards such as `*.example.com` are accepted here; schemes, paths, credentials, whitespace, and invalid ports are rejected.
- `export.onExit`: `prompt`, `always`, or `never` for changed clone work.
- `export.directory`: patch output directory. Parent traversal (`..`) is rejected.

The safe personalization default imports sanitized settings and model metadata only. Packages, skills, prompts, themes, and extensions remain off. Explicit resource copies reject links, special files, credential-like names, and detected secrets, and require approval. `mirror`, direct mode, and shared skills are broad opt-ins and weaken the default boundary.

## CLI overrides

The primary launch is `pi --docker-sandbox`. Pi also accepts:

```text
--docker-sandbox-profile NAME
--docker-sandbox-sync NAME
--docker-sandbox-name NAME
--docker-sandbox-fresh
--docker-sandbox-direct
--docker-sandbox-keep
--docker-sandbox-no-sync-back
--docker-sandbox-discard-changes
```

The companion path is:

```text
pi-dsbx run [--profile NAME] [--sync NAME] [--name NAME] [--image REF]
             [--direct] [--share-skills] [--fresh] [--keep]
             [--no-sync-back] [--discard-changes]
             [--trust-project-config] [--yes] [--cwd PATH] [-- PI_ARGS...]
```

`--no-sync-back` suppresses export prompting but preserves changed or uninspectable sandboxes. `--discard-changes` is the dedicated authority for permanent loss; generic `--yes` is not.

## Image behavior

A configured image and a locked published image must be digest-pinned. With no configured image, the published digest is preferred. If none is locked, a verified local image is required; the local image build is the fallback:

```bash
npm exec --package=pi-docker-sandboxes@0.1.0-alpha.1 -- pi-dsbx image build
```

The `hardened` profile cannot install Pi at runtime, so it requires this built image or an explicit pinned image.

## Migration notes

Legacy `syncProfile: "balanced"` is migrated to `custom` safe personalization (settings and models only), with packages and resources disabled unless explicitly enabled. Legacy `sandbox.keep: true` is migrated to `false`, restoring removal of clean sandboxes by default. Both migrations emit warnings. Review the effective merged configuration with `pi-dsbx config` before launch.
