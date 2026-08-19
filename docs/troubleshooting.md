# Troubleshooting

Start in the affected Git repository with redacted JSON diagnostics:

```sh
npm exec --package=pi-docker-sandboxes@1.0.0 -- pi-dsbx doctor --json
npm exec --package=pi-docker-sandboxes@1.0.0 -- pi-dsbx status --json
```

Both receipts have a schema version and deterministic exit status: 0 means no failed check; 1 means at least one failed check. They omit secret values, but review paths and project metadata before sharing.

## Common fixes

### Host certification fails

Only macOS 14+ on Apple Silicon and Ubuntu 24.04+ on amd64 or arm64 with KVM are certified. On Ubuntu, confirm `/dev/kvm` exists and your user can access it. Windows reports that package host support is not certified; see [Compatibility](https://github.com/gurkanguray/pi-docker-sandboxes/blob/main/COMPATIBILITY.md).

### Docker Sandboxes is unavailable

```sh
sbx version
sbx diagnose
```

Install or update [Docker Sandboxes](https://docs.docker.com/ai/sandboxes/), start Docker, then rerun `doctor --json`.

### The repository has no commit

```sh
git commit --allow-empty --only -m "Initial commit"
pi --docker-sandbox
```

Configure Git identity first if the commit fails.

### No model is available

Authentication defaults to `none` and model metadata defaults to disabled. Configure an explicit `proxy` provider and store its value with Docker's secret command:

```sh
sbx secret set <provider>
pi --docker-sandbox
```

Do not place a credential in configuration or a diagnostic attachment. `oauth-copy` is a higher-risk compatibility mode that requires interactive confirmation.

### Runtime image check fails

Do not substitute a tag or custom image. Confirm Docker can pull the exact public digest shown in [Configuration](configuration.md), remove conflicting private-registry credentials if applicable, and rerun `doctor --json`. The supported path consumes the immutable public runtime; installation-time image creation is not a recovery step.

## Recover your work

### A sandbox was retained

Inspect, export, and keep it until the patch is applied and verified:

```sh
sbx exec NAME git status --porcelain=v1
npm exec --package=pi-docker-sandboxes@1.0.0 -- pi-dsbx export --name NAME
```

### A patch will not apply

The host checkout must be clean and match the recorded repository, worktree, and base commit:

```sh
git status --porcelain=v1
git apply --check --binary PATCH
npm exec --package=pi-docker-sandboxes@1.0.0 -- pi-dsbx apply PATCH --name NAME --yes
```

Preserve both patch and sandbox. Do not use `git reset --hard` as recovery.

### State or upgrade compatibility fails

Do not edit state. `doctor --json` reconciles daemon, image, runtime schema, package version, and interrupted phases without authorizing deletion. Version 1 state is backed up before migration; unknown future state and incompatible runtime state remain unchanged.

Use the exact package version that created the sandbox to export work when possible, then install the newer exact version and recreate. Never resume against an image mismatch.

### A lifecycle lease blocks work

First verify no launch, export, apply, destroy, or session operation is active. `status --json` and `doctor --json` identify lease health. Only when the recorded local process is demonstrably absent:

```sh
npm exec --package=pi-docker-sandboxes@1.0.0 -- pi-dsbx unlock --name NAME --yes
```

Do not remove the lease manually; uncertain ownership must remain blocked.

### Recover a managed session

```sh
npm exec --package=pi-docker-sandboxes@1.0.0 -- pi-dsbx sessions list --name NAME
npm exec --package=pi-docker-sandboxes@1.0.0 -- pi-dsbx sessions restore BACKUP --name NAME
```

Restore requires a ready compatible sandbox with exact image identity. If no ID is given, the newest valid backup is used. Keep backups until the recovered session opens successfully.

## Get support

Save only reviewed diagnostics:

```sh
npm exec --package=pi-docker-sandboxes@1.0.0 -- pi-dsbx doctor --json > pi-dsbx-doctor.json
```

Review and redact the file before sharing it. Never include credentials, raw environment dumps, private source, session contents, or patches. See [Support](https://github.com/gurkanguray/pi-docker-sandboxes/blob/main/SUPPORT.md).
