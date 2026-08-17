# Getting started

This guide expands the supported Early Access path in the [README](https://github.com/gurkanguray/pi-docker-sandboxes#readme).

## Prepare the repository

Clone mode requires a Git repository with an initial commit. A fresh repository can use an empty commit:

```bash
git init
git commit --allow-empty -m "Initial commit"
```

The host worktree may contain changes: the sandbox starts from the current commit and copies eligible working-tree changes into its private clone. Patch apply later refuses a dirty host worktree or a changed host `HEAD`.

## Install and diagnose

```bash
pi install npm:pi-docker-sandboxes@0.1.0
npm exec --package=pi-docker-sandboxes@0.1.0 -- pi-dsbx doctor
```

Fix failures reported by `doctor` before launch.

## Configure a model provider (optional)

On launch, host Pi API-key IDs with matching `sbx` credential services are copied through stdin into `sbx secret set <same-id>` only when no secret is configured; existing `sbx` secrets are preserved. OAuth providers (`openai-codex`, `xai`, `openrouter`) keep their host tokens in the sandbox `auth.json`. Host catalogs come from `models-store.json`. `qwen-token-plan` has no `sbx` service and stays unmatched. `--docker-sandbox-sync mirror` also copies `npm:`/`git:` package specs and local skills; host-path packages stay on the host. Disable secret sync with `--docker-sandbox-no-host-auth`.

Sandbox-local `/login` is unsupported. Launching with no configured model credential is allowed; Pi starts without a usable model and prints setup guidance.

## Launch

```bash
pi --docker-sandbox
```

The default uses clone workspace mode, the `development` security profile, safe settings/models synchronization, and a private Docker Engine. Pass Pi arguments after its normal flags, for example `pi --docker-sandbox --model PROVIDER/MODEL`.

With mirror sync, native npm packages such as `better-sqlite3` require explicit consent for each new sandbox:

```text
pi-dsbx: checking Docker Sandboxes
pi-dsbx: syncing host credentials
2 packages need a compiler in this sandbox (npm:context-mode, npm:pi-hermes-memory).
Install toolchain here? ~1–2 min, not saved. [y/N] y
pi-dsbx: copying host profile
pi-dsbx: creating sandbox
pi-dsbx: installing compiler (12s)
pi-dsbx: installing npm:context-mode (18s)
pi-dsbx: starting Pi
```

The launcher installs all mirrored remote packages with Pi's package manager before Pi starts, then attaches. Compiler consent applies only to native packages: if accepted, the launcher installs the compiler and consented native packages; declining copies their skills only. Installation failures do not prevent attach. `--yes` and non-TTY launches may install non-native mirrored packages, but never install a compiler or native packages; reattaching performs no package installs.

## Image selection and fallback

A configured `sandbox.image` must be digest-pinned. Otherwise this release requires its verified local image build:

```bash
npm exec --package=pi-docker-sandboxes@0.1.0 -- pi-dsbx image build
```

Build it when launch reports that the locked local image is absent or invalid, then retry `pi --docker-sandbox`.

## Export and apply work

The default exit policy prompts to export changed clone work. You can also export and apply explicitly:

```bash
npm exec --package=pi-docker-sandboxes@0.1.0 -- pi-dsbx export
npm exec --package=pi-docker-sandboxes@0.1.0 -- pi-dsbx apply PATCH --yes
```

Review the patch before applying it. Clean sandboxes are removed by default. Changed or uninspectable sandboxes are preserved after a declined or failed export. `--keep` preserves a sandbox; `--discard-changes` explicitly authorizes permanent loss of unexported work. Set `export.onExit` to `never` to suppress the export prompt.

## Troubleshooting

Run diagnostics again:

```bash
npm exec --package=pi-docker-sandboxes@0.1.0 -- pi-dsbx doctor
```

Use `pi-dsbx status` to inspect state. If image resolution fails, build the local fallback as shown above. Preserve a named sandbox until its work is exported or intentionally discarded. The [compatibility matrix](https://github.com/gurkanguray/pi-docker-sandboxes/blob/main/COMPATIBILITY.md) records the exact checked environment.

## Uninstall

First export or deliberately discard work in any preserved sandbox. Remove a clean clone sandbox with its reported name:

```bash
npm exec --package=pi-docker-sandboxes@0.1.0 -- pi-dsbx destroy --name NAME --yes
pi remove npm:pi-docker-sandboxes
```

For changed clone work, add `--discard-changes` only when loss is intentional.
