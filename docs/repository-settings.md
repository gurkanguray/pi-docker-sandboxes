# Repository release protections

Verified against `gurkanguray/pi-docker-sandboxes` on 2026-08-13 by `@gurkanguray`.
Do not record tokens or other secrets here.

## Checklist

### `main` branch protection

- [x] **Required setting:** Ruleset `Main Protection` on `refs/heads/main`: no force-push, no deletion, linear history, squash-only PR, 1 approval, code-owner review, stale-review dismiss, conversation resolution. Repository admins may bypass only via pull request.
- **Why:** Prevents history rewriting and keeps review on the default branch without locking a solo maintainer out of their own PRs.
- **Verify:** `gh api repos/gurkanguray/pi-docker-sandboxes/rulesets/20818604`
- **Evidence:** Date: 2026-08-13 Owner: `@gurkanguray` Release issue URL: n/a

Status checks are **not** required yet. Require `CI / test` only after that check has reported on `main`. Do not require macOS E2E or release-candidate jobs until those runners exist; missing contexts deadlock merges.

### Protected release environment

- [x] **Required setting:** Environment `release` requires reviewer `@gurkanguray` and deploys only from `main` or tags `v*`.
- **Why:** Publication jobs stay blocked until a maintainer approves the bound candidate.
- **Verify:** `gh api repos/gurkanguray/pi-docker-sandboxes/environments/release`
- **Evidence:** Date: 2026-08-13 Owner: `@gurkanguray` Release issue URL: n/a

### npm trusted publisher

- [ ] **Required setting:** Trusted publishing only from this repository, `publish-npm.yml` (called by `release-candidate.yml`), and environment `release`.
- **Why:** Restricts npm OIDC publication to the reviewed workflow.
- **Verify:** npm UI → Package → Settings → Trusted Publishers.
- **Evidence:** Date: ____ Owner: ____ Release issue URL: ____

### GHCR tag and retention policy

- [x] **Required setting:** Tag ruleset `Immutable version tags` blocks deletion and force-updates of `v*`. Workflows never publish `latest`.
- **Why:** Version tags stay bound to one digest.
- **Verify:** `gh api repos/gurkanguray/pi-docker-sandboxes/rulesets/20818663`
- **Evidence:** Date: 2026-08-13 Owner: `@gurkanguray` Release issue URL: n/a

Registry package retention still needs a first GHCR version.

### Security features

- [x] **Required setting:** Private vulnerability reporting enabled.
- **Verify:** `gh api repos/gurkanguray/pi-docker-sandboxes/private-vulnerability-reporting`
- **Evidence:** Date: 2026-08-13 Owner: `@gurkanguray` Release issue URL: n/a

- [x] **Required setting:** Dependabot alerts and security updates enabled.
- **Verify:** `gh api repos/gurkanguray/pi-docker-sandboxes --jq '.security_and_analysis'`
- **Evidence:** Date: 2026-08-13 Owner: `@gurkanguray` Release issue URL: n/a

- [x] **Required setting:** Secret scanning and push protection enabled.
- **Verify:** same `security_and_analysis` query.
- **Evidence:** Date: 2026-08-13 Owner: `@gurkanguray` Release issue URL: n/a

### Self-hosted release runner

- [ ] **Required setting:** Scope the macOS ARM64 Docker Sandboxes runner only to this repository with labels `self-hosted`, `macOS`, `ARM64`, `docker-sandboxes`.
- **Why:** E2E runs privileged local hardware.
- **Verify:** `gh api repos/gurkanguray/pi-docker-sandboxes/actions/runners`
- **Evidence:** Date: ____ Owner: ____ Release issue URL: ____

### Other defaults applied 2026-08-13

- Squash-only merges; delete head branch on merge; DCO web commit signoff required.
- Wiki and Projects off; Issues on.
- Actions: selected (GitHub-owned + verified), SHA pinning required, default `GITHUB_TOKEN` read-only, workflows cannot approve PRs.
- Topics: `pi`, `docker`, `sandboxes`, `microvm`, `security`, `macos`.
- Extra labels: `dependencies`, `npm`, `github-actions`, `security`, `macos`, `unsupported-platform`.

## Read-only verification

```sh
repo=gurkanguray/pi-docker-sandboxes
gh api "repos/$repo/rulesets"
gh api "repos/$repo/environments/release"
gh api "repos/$repo/private-vulnerability-reporting"
gh api "repos/$repo" --jq '.security_and_analysis'
gh api "repos/$repo/actions/permissions"
```
