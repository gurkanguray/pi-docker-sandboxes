# Getting started

## Requirements

| Component | Version |
| --- | --- |
| Host | macOS 26.5.2 on Apple silicon |
| Pi | 0.84.1 |
| Node.js | 24.12.0 |
| Docker | 29+ |
| Docker Sandboxes | 0.38.0 |

Other macOS releases, Linux, and Windows are unsupported. See [Compatibility](https://github.com/gurkanguray/pi-docker-sandboxes/blob/main/COMPATIBILITY.md).

Run from a Git repository. If the repository has no commits, create an empty one first:

```bash
git init
git commit --allow-empty --only -m "Initial commit"
```

## Install

```bash
pi install npm:pi-docker-sandboxes@0.1.0
npm exec --package=pi-docker-sandboxes@0.1.0 -- pi-dsbx doctor
```

Fix any error reported by `doctor` before continuing.

## Build the image

```bash
npm exec --package=pi-docker-sandboxes@0.1.0 -- pi-dsbx image build
```

This builds and verifies the locked local image.

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

Clean sandboxes are removed by default. Changed or uninspectable sandboxes are preserved unless you explicitly discard their work.

## Next steps

- [CLI reference](cli-reference.md)
- [Configuration](configuration.md)
- [Troubleshooting](troubleshooting.md)
- [Uninstall](uninstall.md)
