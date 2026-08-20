# Configuration

## Locations and trust

| Scope | Path | Rule |
| --- | --- | --- |
| Global | `~/.pi/agent/docker-sandboxes.json` | Always read. |
| Project | `.pi/docker-sandboxes.json` | Pi must trust the project; `pi-dsbx run` also requires `--trust-project-config`. |

Unknown fields and invalid values fail closed. Do not put credentials in either file.

## Production defaults

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
  "auth": { "mode": "none", "providers": [] },
  "retention": {
    "maxCount": 10,
    "maxAgeDays": 30,
    "maxBytes": 1073741824
  },
  "sandbox": { "keep": false, "dockerEngine": false },
  "network": { "allow": [], "deny": [] },
  "export": {
    "onExit": "prompt",
    "directory": ".git/pi-docker-sandbox/patches"
  }
}
```

Authentication mode `none` is the default. Model metadata and every package/resource category default to `false`. The standard image is non-privileged, and the private Docker Engine is disabled; setting `sandbox.dockerEngine` to `true` is rejected in production 1.0.

## Fields

| Field | Values | Effect |
| --- | --- | --- |
| `version` | `2` | Configuration schema. |
| `enabled` | boolean | Enable Pi host re-execution. |
| `profile` | `hardened`, `development` | Select network policy; `hardened` is the default. |
| `syncProfile` | `custom`, `clean`, `mirror` | Select resource/session policy. |
| `sync.settings`, `sync.models` | boolean | Copy allowlisted, sanitized metadata when opted in. |
| `sync.packages`, `sync.skills`, `sync.prompts`, `sync.themes`, `sync.extensions` | boolean | Copy each opted-in resource under path, content, and immutability checks. |
| `sync.sessions` | `managed`, `sandbox` | Back sessions up on the host or leave them in the sandbox. |
| `auth.mode` | `none`, `proxy`, `oauth-copy` | Select explicit credential handling. |
| `auth.providers` | provider IDs | Required explicit provider allowlist for `proxy` or `oauth-copy`. |
| `retention.maxCount` | non-negative integer | Maximum managed backups; newest valid backup is retained. |
| `retention.maxAgeDays` | non-negative integer | Age ceiling for backups other than the newest. |
| `retention.maxBytes` | non-negative integer | Byte ceiling for backups other than the newest. |
| `sandbox.name` | name | Reuse a named sandbox. |
| `sandbox.keep` | boolean | Preserve the sandbox after exit. |
| `sandbox.dockerEngine` | `false` | Private Docker request; `true` is unavailable in 1.0.0. |
| `network.allow`, `network.deny` | domains | Extend the selected profile with validated domains. |
| `export.onExit` | `prompt`, `always`, `never` | Select export behavior. `never` preserves changed work. |
| `export.directory` | relative path | Patch directory; parent traversal is rejected. |

## Profiles

- `hardened` adds no network destinations. `development` adds common package, GitHub, and model-provider destinations.
- `clean` copies no resources and leaves sessions in the sandbox.
- `custom` uses each explicit `sync` value; the defaults copy no resources and manage sessions.
- `mirror` opts into eligible settings, model metadata, packages, skills, prompts, themes, and extensions. It does not bypass sanitization, immutable package locks, native-package confirmation, or trust checks.

## Authentication

`proxy` requests only the named providers through Docker's secret mechanism. `oauth-copy` copies allowlisted OAuth material into the sandbox.

::: danger OAuth custody
`oauth-copy` exposes copied OAuth material to code inside the sandbox. It requires interactive confirmation; use `proxy` when available and never commit credentials.
:::

Audited provider IDs are `anthropic`, `google`, `openai`, `openrouter`, and `xai`. Provider access and resource import do not silently grant package, GitHub, or Docker network access.

## Runtime image

The standard image is `ghcr.io/gurkanguray/pi-docker-sandboxes-runtime-standard@sha256:43433061a13ba16ca6e2d327d245844199acd231b9a4087aa26773e5f2d6714b` for `linux/amd64` and `linux/arm64`. Configuration does not replace this locked runtime.

See the [CLI reference](cli-reference.md) for one-launch overrides.
