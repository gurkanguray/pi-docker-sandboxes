# Migration

This Early Access release keeps current version 1 configuration and clone sandbox state readable. Removed legacy fields and values are rejected rather than silently reinterpreted. Review the effective configuration:

```bash
npm exec --package=pi-docker-sandboxes@0.1.0 -- pi-dsbx config
```

Project configuration is read by standalone `pi-dsbx run` only with `--trust-project-config`; Pi uses its normal project-trust decision.

## Changed defaults

- **Verified image:** `pi-dsbx image build` creates and verifies the local image. A configured registry image is accepted only by immutable digest.
- **No runtime installation:** Pi, this package, Git, `fd`, and `rg` are built into the image. The default launch does not download runtime tools.
- **Remove clean sandboxes:** clean or successfully exported clone sandboxes are removed after exit by default. Changed or uninspectable sandboxes remain preserved. Set `sandbox.keep: true` or use `--keep` for deliberate persistence.
- **Safe personalization:** the default `custom` policy copies sanitized settings and model metadata only. Packages, skills, prompts, themes, and extensions require explicit opt-in.
- **Dynamic proxy support:** configured providers are intersected with built-in audited mappings and proxy capabilities discovered from the installed `sbx`. Unsupported or unconfigured services produce warnings. API keys stay in Docker's proxy store; consented OAuth entries are copied after image attestation.
- **Dedicated discard:** generic `--yes` cannot authorize loss of changed or unknown work. Use `--discard-changes` only after deciding that sandbox-only work may be permanently lost.

## Configuration compatibility

There is no silent configuration migration. Removed legacy modes, profiles, and fields fail validation. `sandbox.keep` is preserved exactly. To copy additional resources, opt into individual `sync` fields or the explicit `mirror` profile.

Global configuration is `~/.pi/agent/docker-sandboxes.json`; trusted project configuration is `.pi/docker-sandboxes.json`. Back up a file before editing it:

```bash
cp ~/.pi/agent/docker-sandboxes.json ~/.pi/agent/docker-sandboxes.json.backup
cp .pi/docker-sandboxes.json .pi/docker-sandboxes.json.backup
```

Skip a command when that file does not exist. Unknown fields and unsupported versions are rejected rather than discarded.

## Transactional state validation

State validation completes before use. State writes use a temporary owner-only file, sync it, and atomically rename it. The original remains intact if parsing, validation, launch preparation, or the write fails; a partial write is never treated as authoritative.

Sandbox state lives at `.git/pi-docker-sandbox/state/NAME.json`. The launcher verifies that repository identity and base commit still match before reattachment. Do not edit state while a launch is active.

## Warnings and rollback

Treat migration warnings as a request to verify behavior, not as an instruction to delete state. To roll back configuration:

1. stop launching from the affected repository;
2. keep every retained sandbox and patch;
3. copy the current config aside for diagnosis;
4. restore the backup with `cp`, then rerun `pi-dsbx config` using the package version you intend to run.

For missing, truncated, corrupt, incompatible, or mismatched sandbox state, preserve the file and inspect the named sandbox before recovery:

```bash
cp .git/pi-docker-sandbox/state/NAME.json .git/pi-docker-sandbox/state/NAME.json.preserved
sbx exec NAME git status --porcelain=v1
```

Follow the exact recovery commands in the error. If state is missing, skip the copy. Do not delete state or force-remove the sandbox until its changes are exported, recovered manually, or deliberately discarded. See [Troubleshooting](troubleshooting.md#state-is-missing-or-corrupt).
