# Getting started

This guide expands the supported public-alpha path in the [README](../README.md).

## Prepare the repository

Clone mode requires a Git repository with an initial commit. A fresh repository can use an empty commit:

```bash
git init
git commit --allow-empty -m "Initial commit"
```

The host worktree may contain changes: the sandbox starts from the current commit and copies eligible working-tree changes into its private clone. Patch apply later refuses a dirty host worktree or a changed host `HEAD`.

## Install and diagnose

```bash
pi install npm:pi-docker-sandboxes@0.1.0-alpha.1
npm exec --package=pi-docker-sandboxes@0.1.0-alpha.1 -- pi-dsbx doctor
```

Fix failures reported by `doctor` before launch.

## Configure a model provider (optional)

Built-in audited providers are `anthropic`, `google`, `openai`, `openrouter`, and `xai`. Put the key in Docker's host-side store and list the provider in [configuration](configuration.md):

```bash
sbx secret set <provider>
```

Credentials are proxy-only: the generated Kit declares the service and exact injection domains, but never contains the key. Sandbox-local `/login` is unsupported. Launching with no configured model credential is allowed; Pi starts without a usable model and prints setup guidance.

## Launch

```bash
pi --docker-sandbox
```

The default uses clone workspace mode, the `development` security profile, safe settings/models synchronization, and a private Docker Engine. Pass Pi arguments after its normal flags, for example `pi --docker-sandbox --model PROVIDER/MODEL`.

## Image selection and fallback

A configured `sandbox.image` must be digest-pinned. Otherwise the launcher selects the package's digest-pinned published image when one is locked. This alpha currently has no published image locked, so the local image build is the fallback:

```bash
npm exec --package=pi-docker-sandboxes@0.1.0-alpha.1 -- pi-dsbx image build
```

Build it when launch reports that the locked local image is absent or invalid, then retry `pi --docker-sandbox`.

## Export and apply work

The default exit policy prompts to export changed clone work. You can also export and apply explicitly:

```bash
npm exec --package=pi-docker-sandboxes@0.1.0-alpha.1 -- pi-dsbx export
npm exec --package=pi-docker-sandboxes@0.1.0-alpha.1 -- pi-dsbx apply PATCH --yes
```

Review the patch before applying it. Clean sandboxes are removed by default. Changed or uninspectable sandboxes are preserved after a declined or failed export. `--keep` preserves a sandbox; `--discard-changes` explicitly authorizes permanent loss of unexported work. `--no-sync-back` suppresses the export prompt but does not authorize removal.

## Troubleshooting

Run diagnostics again:

```bash
npm exec --package=pi-docker-sandboxes@0.1.0-alpha.1 -- pi-dsbx doctor
```

Use `pi-dsbx status` to inspect state. If image resolution fails, build the local fallback as shown above. Preserve a named sandbox until its work is exported or intentionally discarded. The [compatibility matrix](../COMPATIBILITY.md) records the exact checked environment.

## Uninstall

First export or deliberately discard work in any preserved sandbox. Remove a clean clone sandbox with its reported name:

```bash
npm exec --package=pi-docker-sandboxes@0.1.0-alpha.1 -- pi-dsbx destroy --name NAME --yes
pi remove npm:pi-docker-sandboxes
```

For changed clone work, add `--discard-changes` only when loss is intentional. Direct-mode destruction also requires `--direct` and dedicated discard confirmation or `--discard-changes`.
