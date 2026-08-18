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

## Fields

| Field | Values | Purpose |
| --- | --- | --- |
| `version` | `1` | Configuration schema. |
| `enabled` | boolean | Enable sandbox re-execution. |
| `profile` | `development`, `hardened` | Network and security policy. |
| `syncProfile` | `custom`, `clean`, `mirror` | Select a built-in or custom sync policy. |
| `sync.settings`, `sync.models` | boolean | Copy sanitized settings or model metadata. |
| `sync.packages`, `sync.skills`, `sync.prompts`, `sync.themes`, `sync.extensions` | boolean | Copy each opted-in Pi resource. |
| `sync.sessions` | `managed`, `sandbox` | Select session storage behavior. |
| `sandbox.name` | name | Reuse a named sandbox. |
| `sandbox.keep` | boolean | Keep the sandbox after exit. |
| `sandbox.dockerEngine` | boolean | Enable the sandbox's private Docker Engine. |
| `sandbox.image` | digest reference | Use an immutable custom image. |
| `providers` | provider IDs | Request audited credential proxy services. |
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

Custom images must use an immutable SHA-256 digest. Without one, build the verified local image:

```bash
npm exec --package=pi-docker-sandboxes@0.1.0 -- pi-dsbx image build
```

See the [CLI reference](cli-reference.md) for all overrides.
