# Troubleshooting

Run commands from the affected repository unless stated otherwise. Replace `NAME`, `PATCH`, and `<provider>` with values from the error output. The CLI reports the failed lifecycle phase and recovery commands; do not destroy a retained sandbox until its work is exported or deliberately discarded.

## sbx is missing or unsupported

Check the installed Docker Sandboxes CLI and run its diagnostics:

```bash
sbx version
sbx diagnose
npm exec --package=pi-docker-sandboxes@0.1.0-alpha.1 -- pi-dsbx doctor
```

Install or update [Docker Sandboxes](https://docs.docker.com/ai/sandboxes/) if `sbx` is missing. This alpha is tested with `sbx` 0.38.x. If `doctor` reports a required capability such as clone mode, `--no-share-skills`, Kit validation, inspect JSON, or network policy checking as unavailable, do not launch; use a tested version and rerun `doctor`.

## Git repository has no initial commit

Clone mode needs a stable base commit. Create one, then retry:

```bash
git commit --allow-empty --only -m "Initial commit"
pi --docker-sandbox
```

If Git rejects the commit, configure your Git identity and rerun the commit. The launcher never falls back to direct mode automatically.

## No models or credentials

Launching without a usable model is allowed. Exit the sandbox, configure an audited provider in `docker-sandboxes.json`, set its secret on the host, and relaunch:

```bash
sbx secret set <provider>
pi --docker-sandbox
```

The provider must appear in the proxy services discovered by `doctor`. Sandbox-local `/login` is unsupported; credentials remain in Docker's host-side secret store.

## Image pull or build fails

Retry diagnostics first. A registry image must be digest-pinned; do not substitute a mutable tag. If pulling the locked image fails, check Docker connectivity and retry. Build the verified local fallback when no published image is locked or the error recommends it:

```bash
npm exec --package=pi-docker-sandboxes@0.1.0-alpha.1 -- pi-dsbx doctor
npm exec --package=pi-docker-sandboxes@0.1.0-alpha.1 -- pi-dsbx image build
pi --docker-sandbox
```

The build requires a working Docker daemon and network access for build inputs. Keep the printed build artifact directory when reporting a failure.

## Sandbox is retained with unexported changes

List sandboxes, inspect the named worktree, and export before removal:

```bash
sbx ls
sbx exec NAME git status --porcelain=v1
npm exec --package=pi-docker-sandboxes@0.1.0-alpha.1 -- pi-dsbx export --name NAME
```

Review the resulting patch under `.git/pi-docker-sandbox/patches/`. If export fails, leave `NAME` intact and follow the printed manual export command. Use `pi-dsbx destroy --name NAME --discard-changes` only when permanent loss is intentional.

## Patch export or apply fails

For export failure, preserve the sandbox and inspect its staged work:

```bash
sbx exec NAME git status --porcelain=v1
npm exec --package=pi-docker-sandboxes@0.1.0-alpha.1 -- pi-dsbx export --name NAME
```

For apply failure, first verify that the host is still at the recorded base commit and has no local changes:

```bash
git status --porcelain=v1
git apply --check --binary PATCH
npm exec --package=pi-docker-sandboxes@0.1.0-alpha.1 -- pi-dsbx apply PATCH --name NAME --yes
```

Do not use `git reset --hard` as recovery. Commit, stash, or otherwise preserve host changes and retry only when the worktree is clean. Keep the patch and sandbox until the result is verified.

## State is missing or corrupt

State files are under `.git/pi-docker-sandbox/state/`. Do not recreate or delete one blindly: it binds a sandbox to its repository and base commit. Preserve an existing file, inspect sandbox work, and only then choose recovery:

```bash
cp .git/pi-docker-sandbox/state/NAME.json .git/pi-docker-sandbox/state/NAME.json.preserved
sbx exec NAME git status --porcelain=v1
```

If the state file is missing, skip `cp` and inspect the sandbox. Without valid state, `pi-dsbx export` cannot safely establish the patch base. Manually recover the work using the exact `sbx exec ... git diff --binary` command printed by the error. Remove the sandbox with `sbx rm --force NAME` only after recovery or an explicit decision to lose its work.

## Host cleanup leaves residue

A failed staging cleanup reports an exact path under the system temporary directory, normally named `pi-docker-sandboxes-*`. Confirm that no active launch uses it, inspect it for wanted artifacts, then remove only that reported path:

```bash
ls -ld -- /exact/path/from/error/pi-docker-sandboxes-ABC123
rm -rf -- /exact/path/from/error/pi-docker-sandboxes-ABC123
```

Stale state after a sandbox was removed is different: inspect the reported `.git/pi-docker-sandbox/state/NAME.json` and its parent before deleting that one file.

## Collect doctor output without secrets

Capture versions and diagnostics for a support report:

```bash
{
  uname -m
  sw_vers
  sbx version
  npm exec --package=pi-docker-sandboxes@0.1.0-alpha.1 -- pi-dsbx doctor
} > pi-dsbx-doctor.txt 2>&1
```

`doctor` reports service names and whether they are configured; it does not print secret values. Still review the file before sharing it. Do not include environment dumps, configuration containing custom sensitive domains, private repository paths, patches, credentials, or `sbx secret` values. See [Support](../SUPPORT.md) for the supported boundary.
