# Uninstall

Uninstall is intentionally data-preserving. There is no automatic all-in-one cleanup or dry run. Treat the listing commands below as the dry run, inspect every result, and back up wanted work before each removal command. Run repository-specific commands from each affected repository.

## 1. List and export changed sandboxes

List Docker sandboxes and inspect each `pi-` sandbox before removal:

```bash
sbx ls
sbx exec NAME git status --porcelain=v1
```

Export changed clone work while the package, repository state, and sandbox still exist:

```bash
npm exec --package=pi-docker-sandboxes@0.1.0 -- pi-dsbx export --name NAME
```

Review and back up the patch under `.git/pi-docker-sandbox/patches/`. If removing legacy direct-mode state, inspect and commit or back up its host worktree because that mode did not create clone patches.

## 2. Remove confirmed sandboxes

For a clean clone sandbox, use the lifecycle-aware command from its repository:

```bash
npm exec --package=pi-docker-sandboxes@0.1.0 -- pi-dsbx destroy --name NAME --yes
```

If the sandbox has changes or cannot be inspected, the command preserves it. Add `--discard-changes` only after export or when losing its work is intentional:

```bash
npm exec --package=pi-docker-sandboxes@0.1.0 -- pi-dsbx destroy --name NAME --discard-changes
```

Use raw `sbx rm --force NAME` only for a sandbox whose package state is missing or corrupt, and only after manual recovery described in [Troubleshooting](troubleshooting.md#state-is-missing-or-corrupt).

## 3. Remove the package

Remove the same npm source form used at installation:

```bash
pi remove npm:pi-docker-sandboxes
```

If it was installed in project settings, run the command with Pi's `--local` option from that project.

## 4. Optionally remove images

Images are harmless to retain and may be shared by remaining sandboxes. First list matching local records:

```bash
docker image ls docker.io/pi-docker-sandboxes/pi
```

After confirming they are unused, remove exact references returned by those listings, for example:

```bash
docker image rm docker.io/pi-docker-sandboxes/pi:0.1.0
```

Do not remove unrelated Docker Sandboxes base or template images as part of this package uninstall.

## 5. Optionally archive or remove configuration and state

Global configuration is `~/.pi/agent/docker-sandboxes.json`; project configuration is `.pi/docker-sandboxes.json`. Archive files you may want to reuse before removing them:

```bash
cp ~/.pi/agent/docker-sandboxes.json ~/.pi/agent/docker-sandboxes.json.backup
cp .pi/docker-sandboxes.json .pi/docker-sandboxes.json.backup
```

Skip missing paths. Only after every named sandbox has been exported or deliberately removed, inspect repository state under `.git/pi-docker-sandbox/state/`. Archive that directory if any record may still be needed for recovery. Remove individual config/state files only after checking their backups; this guide intentionally does not provide a recursive deletion command.

## 6. Retain or archive patches

Do not delete `.git/pi-docker-sandbox/patches/` merely because the package is gone. Patches are the durable copy of exported sandbox work and can be reviewed or applied with Git:

```bash
git apply --check --binary .git/pi-docker-sandbox/patches/PATCH
git apply --binary .git/pi-docker-sandbox/patches/PATCH
```

Keep patches in place or copy them to backup storage until their changes are applied and verified. Package removal, image cleanup, and config cleanup do not require patch deletion.
