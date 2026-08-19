# Compatibility

## Availability

`0.1.0` is not yet published. Public installation begins after [release issue #8](https://github.com/gurkanguray/pi-docker-sandboxes/issues/8) is complete.

## Package requirements

| Component | Requirement |
| --- | --- |
| Host Pi | `>=0.84.1 <0.85.0` |
| Node.js | `>=22.19.0 <25` |
| Host Docker | 29+ validated |
| Docker Sandboxes | 0.38.x |
| Standard image | `ghcr.io/gurkanguray/pi-docker-sandboxes-runtime-standard@sha256:43433061a13ba16ca6e2d327d245844199acd231b9a4087aa26773e5f2d6714b` (`linux/amd64`, `linux/arm64`) |
| Docker Kit schema | v2 |

## Supported hosts

| Host | Package status |
| --- | --- |
| macOS 14+ on Apple Silicon | Supported; see the exact release validation below. |
| Ubuntu 24.04+ on amd64 or ARM64 | Supported; hardware validation remains blocked until the required hosted runners are available. |

Both hosts meet the official [Docker Sandboxes prerequisites](https://docs.docker.com/ai/sandboxes/install/), run Pi, and match a platform published by the standard multiarch image. Bug reports are welcome from either host.

## Release validation

macOS 26.5.2 on Apple Silicon is the validated `0.1.0` candidate host.

| Component | Validated version |
| --- | --- |
| Pi | 0.84.1 |
| Node.js | 24.12.0 |
| Host Docker | 29+ |
| Docker Engine in VM | 29.7.1 |
| Docker Sandboxes | 0.38.0 |

This records evidence; it does not narrow the supported hosts above.

## Known limitations

- Windows 11 x64 is supported by Docker Sandboxes and [Pi with Bash](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/windows.md), but the current package is incompatible because inherited process-group execution rejects Windows.
- Custom images require immutable SHA-256 digests; supplying one does not establish a supported cross-architecture path.
- Docker Sandbox Kits remain experimental.

`pi-dsbx doctor` checks the installed `sbx` line and capabilities, daemon response, configuration, credential services, and Git eligibility.
