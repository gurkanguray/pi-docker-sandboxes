# Task 10 production compatibility evidence

## Implemented matrix

- Node.js support is `>=22.19.0 <25`; CI runs exact `22.19.0` and `24.12.0`.
- Pi support is `>=0.84.1 <0.85.0`; CI runs exact `0.84.1` and `0.84.2` and binds the tightly coupled Pi peer ranges.
- Hosted CI requires Ubuntu amd64 and native Ubuntu arm64 package/runtime smoke plus Windows packaging and platform-independent units.
- Release E2E requires macOS arm64, Ubuntu amd64 KVM, and Ubuntu arm64 KVM ephemeral self-hosted runners. All three consume the same source-bound tarball and multi-platform OCI digest, use an empty HOME and synthetic credential, run standalone Pi slash diagnostics, and emit cleanup evidence.
- Release tags must resolve to the current fetched `main` commit.

## Fault and lifecycle coverage

`test/upgrade.test.ts` covers v1-to-v2 upgrade, future-state downgrade refusal, runtime mismatch, interrupted state preservation, injected `ENOSPC` atomic publication, rollback preservation, and backup pruning. `test/concurrency.test.ts` covers simultaneous lifecycle ownership, deterministic busy results, daemon timeout, and cancellation. Existing crash-point and restore tests remain part of the required full suite.

## Coverage ratchet

The pre-change Node 24.12.0 native production coverage baseline was 90.13% lines, 79.88% branches, and 84.54% functions. The gate is set below that evidence at 90% lines, 79% branches, and 84% functions. The final local gate reported 90.28% lines, 80.99% branches, and 85.18% functions.

## Local validation

- `env -u NODE_OPTIONS npm run check`: passed, 498 tests total, 491 passed and 7 skipped hardware/E2E tests.
- `env -u NODE_OPTIONS npm run test:coverage`: passed at 90.28/80.99/85.18.
- Node 22.19.0 full test run: passed, 498 total, 491 passed and 7 skipped.
- Pi 0.84.1 and 0.84.2 extension/runtime/personalization/workflow checks: 53/53 passed for each exact version.
- `go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.7`: passed.
- `env -u NODE_OPTIONS npm audit --audit-level=high`: passed with zero vulnerabilities.
- Locked runtime index inspection proved one exact digest with linux/amd64 and linux/arm64 manifests; local linux/arm64 pull/runtime smoke passed.

## Unavailable required gates

No hardware receipt was fabricated locally. The following remain mandatory non-green release gates and were unavailable in this worktree session:

- hosted Ubuntu 24.04 amd64 package/runtime smoke;
- hosted Ubuntu 24.04 arm64 package/runtime smoke;
- hosted Windows 2025 packaging/unit execution;
- real macOS arm64 Docker Sandboxes E2E against the release artifact digest;
- real Ubuntu amd64 KVM Docker Sandboxes E2E against that same digest;
- real Ubuntu arm64 KVM Docker Sandboxes E2E against that same digest.

A missing self-hosted runner leaves its required matrix job queued or failed; no workflow uses a green fallback or `continue-on-error` for hardware E2E.

## Post-Task10 formatter inspection

The pending diffs in `src/sessions.ts`, `test/concurrency.test.ts`, `test/sessions.test.ts`, `test/signals.test.ts`, `test/upgrade.test.ts`, and `test/workflows.test.ts` were formatting-only: parsed TypeScript ASTs were identical to `HEAD`, so no behavior changes required reversion.

- Focused formatter-affected tests: passed, 55 total, 54 passed and 1 Windows-only test skipped.
- `env -u NODE_OPTIONS npm run check`: passed, including typecheck and 498 tests (491 passed, 7 hardware/E2E tests skipped).
- `env -u NODE_OPTIONS npm run test:coverage`: passed at 90.29% lines, 81.00% branches, and 85.18% functions.
- `go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.7`: passed with no findings.
