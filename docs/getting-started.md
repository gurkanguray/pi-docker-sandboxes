# Getting started

::: warning Availability
`0.1.0` is not yet published. Public installation opens when [release issue #8](https://github.com/gurkanguray/pi-docker-sandboxes/issues/8) is complete.
:::

## Requirements

| Component | Requirement |
| --- | --- |
| Host | macOS 14+ on Apple silicon or Ubuntu 24.04+ on amd64/ARM64 |
| Pi | `>=0.84.1 <0.85.0` |
| Node.js | `>=22.19.0 <25` |
| Docker | 29+ validated |
| Docker Sandboxes | 0.38.x |
| Standard image | `ghcr.io/gurkanguray/pi-docker-sandboxes-runtime-standard@sha256:43433061a13ba16ca6e2d327d245844199acd231b9a4087aa26773e5f2d6714b` (`linux/amd64`, `linux/arm64`) |

macOS 26.5.2 on Apple silicon is the validated candidate host, with Pi 0.84.1, Node.js 24.12.0, and Docker Sandboxes 0.38.0. Ubuntu amd64/ARM64 hardware validation remains blocked until the required hosted runners are available. See [Compatibility](https://github.com/gurkanguray/pi-docker-sandboxes/blob/main/COMPATIBILITY.md) for details.

Run from a Git repository. If the repository has no commits:

```bash
git init
git commit --allow-empty --only -m "Initial commit"
```

## Install after release

```bash
pi install npm:pi-docker-sandboxes@0.1.0
npm exec --package=pi-docker-sandboxes@0.1.0 -- pi-dsbx doctor
```

Fix any reported error before continuing.

## Run

```bash
pi --docker-sandbox
```

Eligible host credentials sync by default. Add `--docker-sandbox-no-host-auth` to disable this. Sandbox-local `/login` is unsupported.

Pass normal Pi options as usual:

```bash
pi --docker-sandbox --model PROVIDER/MODEL
```

## Keep your work

Accept the exit prompt to export changed work to `.git/pi-docker-sandbox/patches/`. If you decline, the sandbox is retained so you can export later:

```bash
npm exec --package=pi-docker-sandboxes@0.1.0 -- pi-dsbx export
```

Apply the reviewed patch:

```bash
npm exec --package=pi-docker-sandboxes@0.1.0 -- pi-dsbx apply PATCH --yes
```

Clean sandboxes are removed by default. Changed or uninspectable sandboxes are preserved without explicit discard authority.

## Next steps

- [CLI reference](cli-reference.md)
- [Configuration](configuration.md)
- [Troubleshooting](troubleshooting.md)
- [Uninstall](uninstall.md)
