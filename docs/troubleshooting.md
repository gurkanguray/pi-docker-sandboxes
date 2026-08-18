# Troubleshooting

Start in the affected repository:

```bash
npm exec --package=pi-docker-sandboxes@0.1.0 -- pi-dsbx doctor
```

Fix the first reported error, then rerun `doctor`.

## Common fixes

### `sbx` is unavailable

```bash
sbx version
sbx diagnose
```

Install or update [Docker Sandboxes](https://docs.docker.com/ai/sandboxes/), then rerun `doctor`.

### The repository has no commit

```bash
git commit --allow-empty --only -m "Initial commit"
pi --docker-sandbox
```

Configure your Git identity first if Git rejects the commit.

### No model is available

Set an eligible API key in Docker's secret store, or authenticate with host Pi for a supported OAuth provider:

```bash
sbx secret set <provider>
pi --docker-sandbox
```

Sandbox-local `/login` is unsupported.

### The image is missing

```bash
npm exec --package=pi-docker-sandboxes@0.1.0 -- pi-dsbx image build
pi --docker-sandbox
```

A custom image must use an immutable digest.

## Recover your work

### A sandbox was retained

Inspect and export it before removal:

```bash
sbx exec NAME git status --porcelain=v1
npm exec --package=pi-docker-sandboxes@0.1.0 -- pi-dsbx export --name NAME
```

Keep the sandbox until the patch is reviewed or the work is deliberately discarded.

### A patch will not apply

The host must be clean and still use the recorded base commit:

```bash
git status --porcelain=v1
git apply --check --binary PATCH
npm exec --package=pi-docker-sandboxes@0.1.0 -- pi-dsbx apply PATCH --name NAME --yes
```

Preserve both the patch and sandbox. Do not use `git reset --hard` as recovery.

### State is missing or corrupt

Preserve the state file when it exists, then inspect the sandbox:

```bash
cp .git/pi-docker-sandbox/state/NAME.json .git/pi-docker-sandbox/state/NAME.json.preserved
sbx exec NAME git status --porcelain=v1
```

If state is missing, skip `cp`. Use the manual `git diff --binary` recovery command printed by the error. Run `sbx rm --force NAME` only after recovery or an explicit decision to lose the work.

### Cleanup left a temporary directory

Remove only the exact reported `pi-docker-sandboxes-*` path after confirming no launch uses it.

## Get support

Capture the minimum diagnostic bundle:

```bash
{
  sw_vers
  uname -m
  sbx version
  npm exec --package=pi-docker-sandboxes@0.1.0 -- pi-dsbx doctor
} > pi-dsbx-doctor.txt 2>&1
```

`doctor` does not print secret values. Review the file before sharing it; remove private paths and project details. See [Support](https://github.com/gurkanguray/pi-docker-sandboxes/blob/main/SUPPORT.md).
