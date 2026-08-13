# Repository release protections

**Current status: Unverified / repository not readable.** The read-only repository API returned `404` from the current environment. Nothing below is claimed to be enabled. Publication is blocked until a maintainer verifies every item and records the evidence in the release issue. Do not record tokens or other secrets.

## Checklist

### `main` branch protection

- [ ] **Required setting:** Protect `main`: disallow force pushes and deletion; require a pull request, resolved conversations, and signed commits where feasible. Require the exact observed check contexts for CI, security, macOS E2E, and release checking (currently intended to correspond to `CI / test`, the `Security` jobs, `Docker Sandboxes E2E / macos-arm64`, and `Protected release candidate / metadata`). Confirm each context actually reports on the protected commit before making it required, so an absent event trigger cannot deadlock merges.
- **Why:** Prevents history rewriting or bypassing review and makes the release gates fail closed.
- **Verify:** `gh api repos/gurkanguray/pi-docker-sandboxes/branches/main/protection`; confirm required status-check contexts against successful check runs. UI: **Settings → Branches → Branch protection rules → main** (or **Settings → Rules → Rulesets**).
- **Evidence:** Date: ____ Owner: ____ Release issue URL: ____

### Protected release environment

- [ ] **Required setting:** Create a `release` environment whose deployment protection rules require approval by a maintainer; prevent self-review where available and restrict deployment to release refs appropriate to the signed-tag workflow.
- **Why:** Keeps publication jobs blocked after automated gates until an authorized human approves the bound candidate.
- **Verify:** `gh api repos/gurkanguray/pi-docker-sandboxes/environments/release`; inspect `protection_rules`, reviewers, self-review prevention, and deployment branch/tag policy. UI: **Settings → Environments → release**.
- **Evidence:** Date: ____ Owner: ____ Release issue URL: ____

### npm trusted publisher

- [ ] **Required setting:** For `pi-docker-sandboxes`, allow trusted publishing only from GitHub repository `gurkanguray/pi-docker-sandboxes`, workflow `publish-npm.yml` (called by `release-candidate.yml`), and environment `release`.
- **Why:** Restricts npm OIDC publication to the reviewed protected workflow without a stored npm token.
- **Verify:** npm UI: **Package → Settings → Trusted Publishers**; compare the owner, repository, workflow filename, and environment exactly. Also review `.github/workflows/release-candidate.yml` and `.github/workflows/publish-npm.yml` at the release commit.
- **Evidence:** Date: ____ Owner: ____ Release issue URL: ____

### GHCR tag and retention policy

- [ ] **Required setting:** Treat version tags as immutable: never overwrite/delete a released version tag, never publish `latest`, and retain released versions and digests. Limit package write/delete authority to the protected release workflow and define retention so release evidence is not garbage-collected.
- **Why:** Keeps every documented version and provenance reference bound to its original digest.
- **Verify:** List versions with `gh api /users/gurkanguray/packages/container/pi-docker-sandboxes/versions`; inspect tag-to-digest mappings and absence of `latest`. UI: **Package → Package settings → Manage Actions access / retention**, and compare `.github/workflows/release-candidate.yml` plus `.github/workflows/publish-image.yml` at the release commit.
- **Evidence:** Date: ____ Owner: ____ Release issue URL: ____

### Security features

- [ ] **Required setting:** Enable private vulnerability reporting.
- **Why:** Gives reporters a private path for coordinated disclosure.
- **Verify:** `gh api repos/gurkanguray/pi-docker-sandboxes/private-vulnerability-reporting` (enabled returns a successful response). UI: **Settings → Security → Code security and analysis → Private vulnerability reporting**.
- **Evidence:** Date: ____ Owner: ____ Release issue URL: ____

- [ ] **Required setting:** Enable Dependabot alerts.
- **Why:** Surfaces vulnerable dependency advisories that can block or trigger release remediation.
- **Verify:** `gh api repos/gurkanguray/pi-docker-sandboxes/dependabot/alerts`; confirm access and review open alerts. UI: **Settings → Security → Code security and analysis → Dependabot alerts**.
- **Evidence:** Date: ____ Owner: ____ Release issue URL: ____

- [ ] **Required setting:** Enable secret scanning and push protection for the repository.
- **Why:** Detects committed credentials and blocks supported secrets before they enter history.
- **Verify:** `gh api repos/gurkanguray/pi-docker-sandboxes --jq '.security_and_analysis'`; require `secret_scanning.status` and `secret_scanning_push_protection.status` to be `enabled`. UI: **Settings → Security → Code security and analysis**.
- **Evidence:** Date: ____ Owner: ____ Release issue URL: ____

### Self-hosted release runner

- [ ] **Required setting:** Scope the macOS ARM64 Docker Sandboxes runner only to this repository and apply the labels `self-hosted`, `macOS`, `ARM64`, and `docker-sandboxes`; do not grant public forks or unrelated repositories access.
- **Why:** The E2E gate executes repository code on privileged local hardware, so broader runner access expands the trust boundary.
- **Verify:** `gh api repos/gurkanguray/pi-docker-sandboxes/actions/runners`; inspect runner labels and repository access. If the runner is organization-owned, also verify its runner-group selected-repository policy. UI: **Settings → Actions → Runners** (and organization **Settings → Actions → Runner groups**, if applicable).
- **Evidence:** Date: ____ Owner: ____ Release issue URL: ____

## Read-only verification commands

These commands read configuration only. They do not enable or change settings.

```sh
repo=gurkanguray/pi-docker-sandboxes
gh api "repos/$repo/branches/main/protection"
gh api "repos/$repo/environments/release"
gh api "repos/$repo/private-vulnerability-reporting"
gh api "repos/$repo/dependabot/alerts"
gh api "repos/$repo" --jq '.security_and_analysis'
gh api "repos/$repo/actions/runners"
gh api "/users/gurkanguray/packages/container/pi-docker-sandboxes/versions"
```
