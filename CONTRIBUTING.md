# Contributing

Thank you for contributing to pi-docker-sandboxes.

## Development setup

The checked public-alpha environment uses Node.js 24.12.0+, Pi 0.84.1, Docker 29+, and Docker Sandboxes (`sbx`) 0.38.x on macOS Apple Silicon.

```bash
npm ci --ignore-scripts
npm run check
```

Run the focused test while developing, then the full check before opening a pull request. Changes that affect the real sandbox lifecycle must also pass the targeted hypervisor test:

```bash
node --experimental-strip-types --test test/name.test.ts
npm run test:e2e
npm pack --dry-run
```

The E2E test creates and removes disposable sandboxes and Git repositories. It requires the supported host environment.

## Change workflow

Use test-driven development (TDD): add a test that fails for the missing behavior, make the smallest implementation change, and confirm the test and `npm run check` pass. Keep pull requests focused and document user-visible changes.

Treat isolation, credentials, network policy, patch export/apply, sandbox cleanup, and host fallback behavior as security boundaries. Changes touching a boundary require explicit review against [SECURITY.md](SECURITY.md) and [THREAT_MODEL.md](THREAT_MODEL.md), including failure-path tests. Do not weaken an invariant merely to make a test pass.

Report suspected vulnerabilities through [GitHub private vulnerability reporting](https://github.com/gurkanguray/pi-docker-sandboxes/security/advisories/new), not a public issue. Follow [SECURITY.md](SECURITY.md) and do not include real credentials or private source.

## Dependency updates

Every dependency update must pass the unit and package checks (`npm run check` and `npm run pack:dry`). Updates to Pi, `sbx`, a Docker base, an image tool, or a security boundary must also pass real macOS E2E (`npm run test:e2e`). Pi peer compatibility ranges must not be widened without explicit compatibility review.

GitHub Action updates must preserve full-length SHA pins and update the human-readable version comments alongside those pins.

## Sign your commits

This project uses the [Developer Certificate of Origin](https://developercertificate.org/) (DCO), not a CLA. Sign off every commit to certify that you have the right to submit it:

```bash
git commit --signoff -m "Describe the change"
```

Each commit must contain a `Signed-off-by: Name <email>` trailer. Contributions do not require a Contributor License Agreement (no CLA).

By participating, you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). Project decision and release authority is described in [GOVERNANCE.md](GOVERNANCE.md).
