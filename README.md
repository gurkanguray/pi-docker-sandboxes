# pi-docker-sandboxes

> Early Access

Run Pi in an isolated Docker Sandboxes workspace. Review changes before they reach your project.

## Install

Run from a Git repository. If the repository has no commits, create an empty one first:

```bash
git init
git commit --allow-empty --only -m "Initial commit"
```

Install, check the host, build the locked image, and run Pi:

```bash
pi install npm:pi-docker-sandboxes@0.1.0
npm exec --package=pi-docker-sandboxes@0.1.0 -- pi-dsbx doctor
npm exec --package=pi-docker-sandboxes@0.1.0 -- pi-dsbx image build
pi --docker-sandbox
```

## How it works

- **Isolated:** Pi runs inside a Docker Sandboxes microVM with a private Git clone and private Docker Engine.
- **Familiar:** Eligible Pi settings, models, and credentials sync from the host. Use `--docker-sandbox-no-host-auth` to skip credentials.
- **Reviewable:** Sandbox work returns as a patch that you review before applying.

## Documentation

- [Get started](https://gurkanguray.github.io/pi-docker-sandboxes/getting-started)
- [CLI reference](https://gurkanguray.github.io/pi-docker-sandboxes/cli-reference)
- [Configuration](https://gurkanguray.github.io/pi-docker-sandboxes/configuration)
- [Troubleshooting](https://gurkanguray.github.io/pi-docker-sandboxes/troubleshooting)
- [Compatibility](COMPATIBILITY.md)
- [Support](SUPPORT.md)
- [Security](SECURITY.md)
- [Contributing](CONTRIBUTING.md)

## License

[MIT](LICENSE)
