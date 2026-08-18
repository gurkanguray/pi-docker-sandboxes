# Support

## Supported

Support covers the latest `0.1.x` release on the tested [Compatibility](COMPATIBILITY.md) matrix.

Supported surfaces:

- `pi --docker-sandbox`
- the `pi-dsbx` CLI
- private clone workspaces
- the documented image, credential, export, and cleanup flows

There is no stable programmatic library API.

## Get help

Search [existing issues](https://github.com/gurkanguray/pi-docker-sandboxes/issues), then use:

- [Bug report](https://github.com/gurkanguray/pi-docker-sandboxes/issues/new?template=bug.yml)
- [Usage question](https://github.com/gurkanguray/pi-docker-sandboxes/issues/new?template=question.yml)
- [Unsupported platform report](https://github.com/gurkanguray/pi-docker-sandboxes/issues/new?template=unsupported-platform.yml)

Include:

- package version;
- failed command;
- sanitized error;
- reviewed `pi-dsbx doctor` output;
- minimal reproduction steps;
- whether work remains in a retained sandbox.

Never post credentials, environment dumps, private source, or patch contents. Community support has no response-time SLA.

## Security reports

Do not report undisclosed vulnerabilities in a public issue. Use the private process in [SECURITY.md](SECURITY.md).
