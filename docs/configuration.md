# Configuration

## Locations

| Scope | Path | Rule |
| --- | --- | --- |
| Global | `~/.pi/agent/docker-sandboxes.json` | Always read. |
| Project | `.pi/docker-sandboxes.json` | Read after Pi trusts the project. `pi-dsbx run` also requires `--trust-project-config`. |

Unknown fields are rejected. Store API keys with `sbx secret set <provider>`, not in configuration.

## Defaults

```json
{
  "version": 2,
  "enabled": true,
  "profile": "hardened",
  "syncProfile": "custom",
  "sync": {
    "settings": false,
    "models": false,
    "packages": false,
    "skills": false,
    "prompts": false,
    "themes": false,
    "extensions": false,
    "sessions": "managed"
  },
  "auth": {
    "mode": "none",
    "providers": []
  },
  "retention": {
    "maxCount": 10,
    "maxAgeDays": 30,
    "maxBytes": 1073741824
  },
  "sandbox": {
    "keep": false,
    "dockerEngine": false
  },
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

## Fields

| Field | Values | Purpose |
| --- | --- | --- |
| `version` | `2` | Configuration schema. |
| `enabled` | boolean | Enable sandbox re-execution. |
| `profile` | `development`, `hardened` | Network and security policy. |
| `syncProfile` | `custom`, `clean`, `mirror` | Select a built-in or custom sync policy. |
| `sync.settings`, `sync.models` | boolean | Copy sanitized settings or model metadata. |
| `sync.packages`, `sync.skills`, `sync.prompts`, `sync.themes`, `sync.extensions` | boolean | Copy each opted-in Pi resource. |
| `sync.sessions` | `managed`, `sandbox` | Select session storage behavior. |
| `auth.mode` | `none`, `proxy`, `oauth-copy` | Select the explicit credential policy. |
| `auth.providers` | provider IDs | Request explicit providers when auth is enabled. |
| `retention.maxCount` | non-negative integer | Maximum retained managed-session backups; the latest valid backup is always preserved. |
| `retention.maxAgeDays` | non-negative integer | Maximum age for non-latest managed-session backups. |
| `retention.maxBytes` | non-negative integer | Maximum aggregate bytes for non-latest managed-session backups. |
| `sandbox.name` | name | Reuse a named sandbox. |
| `sandbox.keep` | boolean | Keep the sandbox after exit. |
| `sandbox.dockerEngine` | boolean | Request the private Docker Engine variant. Production 1.0 rejects it until a verified image is published. |
| `network.allow`, `network.deny` | domains | Extend the profile's network rules. |
| `export.onExit` | `prompt`, `always`, `never` | Handle changed work on exit. |
| `export.directory` | path | Store exported patches. Parent traversal is rejected. |

## Profiles

| Option | Behavior |
| --- | --- |
| `development` | Allows network access to common package, GitHub, and model-provider destinations. |
| `hardened` | Allows no additional network destinations. |
| `clean` | Copies nothing from the host; sessions stay in the sandbox. |
| `custom` | Copies sanitized settings and models by default; each resource is configurable. |
| `mirror` | Copies eligible settings, models, packages, skills, prompts, themes, and extensions. |

Audited provider IDs: `anthropic`, `google`, `openai`, `openrouter`, `xai`.

## Common choices

Use command-line overrides for one launch:

```bash
pi --docker-sandbox --docker-sandbox-sync clean
pi --docker-sandbox --docker-sandbox-sync mirror
pi --docker-sandbox --docker-sandbox-profile hardened
pi --docker-sandbox --docker-sandbox-keep
```

To disable the exit prompt, set `export.onExit` to `never`. Changed work remains preserved.

## Images

The standard verified image is `ghcr.io/gurkanguray/pi-docker-sandboxes-runtime-standard@sha256:43433061a13ba16ca6e2d327d245844199acd231b9a4087aa26773e5f2d6714b` for `linux/amd64` and `linux/arm64`. Custom images must use an immutable SHA-256 digest, but supplying one does not establish a supported cross-architecture path.

See the [CLI reference](cli-reference.md) for all overrides.
