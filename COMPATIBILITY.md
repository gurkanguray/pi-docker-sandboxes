# Compatibility

## Supported matrix

| Component | Supported |
| --- | --- |
| Host | macOS 26.5.2 on Apple Silicon |
| Pi | 0.84.1 |
| Node.js | 24.12.0 |
| Docker | 29+ |
| Docker Engine in VM | 29.7.1 |
| Docker Sandboxes | 0.38.x; 0.38.0 tested |
| Docker Kit schema | v2 |

Docker Sandbox Kits are experimental.

## Not supported

- Other macOS releases are unsupported during Early Access.
- Linux is unsupported.
- Windows is unsupported.
- Mutable image tags are unsupported; custom images must use an immutable digest.

Run `pi-dsbx doctor` before launch. It reports missing tools, unsupported versions, and required Docker Sandboxes capabilities.
