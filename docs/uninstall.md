# Uninstall

Export and verify wanted work before removing any sandbox or backup.

## 1. Export wanted work

```sh
sbx ls
sbx exec NAME git status --porcelain=v1
npm exec --package=pi-docker-sandboxes@1.0.0 -- pi-dsbx export --name NAME
npm exec --package=pi-docker-sandboxes@1.0.0 -- pi-dsbx sessions list --name NAME
```

Review patches under `.git/pi-docker-sandbox/patches/` and restore any managed session you still need.

## 2. Remove sandboxes

For a confirmed clean sandbox:

```sh
npm exec --package=pi-docker-sandboxes@1.0.0 -- pi-dsbx destroy --name NAME --yes
```

Changed or uninspectable work is preserved. The next command can permanently lose unexported work and is explicit data-loss authority:

```sh
npm exec --package=pi-docker-sandboxes@1.0.0 -- pi-dsbx destroy --name NAME --discard-changes
```

Do not run it until exports are applied and verified. Repeat for every sandbox.

A session backup is independent of sandbox removal. After successful restore and verification, delete one backup permanently with:

```sh
npm exec --package=pi-docker-sandboxes@1.0.0 -- pi-dsbx sessions delete BACKUP --name NAME --yes
```

## 3. Remove the package

```sh
pi remove npm:pi-docker-sandboxes
```

Add Pi's `--local` option if the package was installed for one project.

## 4. Optional cleanup

After every related sandbox is gone, remove the exact cached runtime only if no other project uses it:

```sh
docker image rm ghcr.io/gurkanguray/pi-docker-sandboxes-runtime-standard@sha256:43433061a13ba16ca6e2d327d245844199acd231b9a4087aa26773e5f2d6714b
```

Configuration lives at `~/.pi/agent/docker-sandboxes.json` and `.pi/docker-sandboxes.json`. Lifecycle state and leases live under `.git/pi-docker-sandbox/`; managed backups live under `~/.pi/agent/docker-sandboxes/sessions/`. Remove these only after confirming their patches, sandboxes, and sessions are no longer needed.

Keep exported patches until their changes are applied and verified.
