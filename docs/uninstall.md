# Uninstall

Export work you want to keep before removing a sandbox.

## 1. Export wanted work

```bash
sbx ls
sbx exec NAME git status --porcelain=v1
npm exec --package=pi-docker-sandboxes@0.1.0 -- pi-dsbx export --name NAME
```

Review the patch in `.git/pi-docker-sandbox/patches/`.

## 2. Remove sandboxes

Remove a clean sandbox:

```bash
npm exec --package=pi-docker-sandboxes@0.1.0 -- pi-dsbx destroy --name NAME --yes
```

Changed or uninspectable work is preserved. To lose that work intentionally:

```bash
npm exec --package=pi-docker-sandboxes@0.1.0 -- pi-dsbx destroy --name NAME --discard-changes
```

## 3. Remove the package

```bash
pi remove npm:pi-docker-sandboxes
```

Add Pi's `--local` option if the package was installed for one project.

## 4. Optional cleanup

List the package image before removing its exact reference:

```bash
docker image ls docker.io/pi-docker-sandboxes/pi
docker image rm docker.io/pi-docker-sandboxes/pi:0.1.0
```

Configuration and state are safe to remove only after every related sandbox is gone: `~/.pi/agent/docker-sandboxes.json`, `.pi/docker-sandboxes.json`, and `.git/pi-docker-sandbox/state/`.

Exported patches live at `.git/pi-docker-sandbox/patches/`; keep patches until their changes are applied and verified.
