# Support

## Covered surfaces

Community support covers the latest 1.x release on the [supported hosts](COMPATIBILITY.md), including:

- `pi --docker-sandbox` and the `pi-dsbx` CLI;
- immutable standard runtime selection;
- lifecycle leases, durable state, export, apply, and cleanup;
- redacted JSON diagnostics and managed-session recovery.

There is no stable programmatic library API and no response-time SLA.

## Get help

Search [existing issues](https://github.com/gurkanguray/pi-docker-sandboxes/issues), then use:

- [Bug report](https://github.com/gurkanguray/pi-docker-sandboxes/issues/new?template=bug.yml)
- [Usage question](https://github.com/gurkanguray/pi-docker-sandboxes/issues/new?template=question.yml)
- [Platform report](https://github.com/gurkanguray/pi-docker-sandboxes/issues/new?template=platform.yml)

Run `pi-dsbx doctor --json`, review and redact its output, then include the package and tool versions, failed command, minimal reproduction, and whether work remains in a retained sandbox. Never post credentials, raw environment dumps, private source, session contents, or exported patches.

## Security reports

Do not report undisclosed vulnerabilities in a public issue. Use the private process in [SECURITY.md](SECURITY.md).
