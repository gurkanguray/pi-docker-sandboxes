# Support

## Supported public-alpha boundary

The supported platform is macOS ARM64 (Apple Silicon) and only the latest `0.1.0-alpha.x` package release. The exact tested Pi, Node.js, Docker Sandboxes, Docker Engine, and Kit versions are in the [compatibility matrix](COMPATIBILITY.md). Docker Kit APIs remain experimental.

Support covers the Pi extension, the `pi-dsbx` CLI, `pi --docker-sandbox`, default clone mode, and the documented image, credential-proxy, export, and cleanup paths. A stable programmatic library API is not supported.

Linux and Windows reports are welcome but unsupported until real platform E2E evidence exists. Older alpha releases, unlisted component versions, direct mode, shared writable skills, sandbox-local credentials, and modified images may be useful diagnostic reports but are outside the supported boundary.

## Getting help

Search [existing issues](https://github.com/gurkanguray/pi-docker-sandboxes/issues), then open a public issue for non-security bugs or questions. Include:

- the package version and relevant [compatibility](COMPATIBILITY.md) versions;
- whether the host is macOS ARM64;
- the failed command, lifecycle phase, and sanitized error;
- reviewed `pi-dsbx doctor` output;
- minimal reproduction steps and whether work remains in a retained sandbox.

Follow [Troubleshooting](docs/troubleshooting.md#collect-doctor-output-without-secrets) before sharing diagnostics. Never include credentials, environment dumps, private source, or sensitive patch contents.

Support is best-effort community support with no response-time SLA and no guarantee of a fix. Reports may be closed when they cannot be reproduced on the supported matrix.

## Security reports

Do not file an undisclosed vulnerability as a public support issue. Follow the private process in [SECURITY.md](SECURITY.md).
