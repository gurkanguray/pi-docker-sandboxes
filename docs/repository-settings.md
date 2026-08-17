# Repository release protections

**Current status: Partially verified as of 2026-08-15.** These repository controls are verified, but release readiness is not complete. Owner: `gurkanguray`. Tracking issue: <https://github.com/gurkanguray/pi-docker-sandboxes/issues/8>.

## Verified settings

### `main` branch protection

Branch protection is enabled with these settings:

- pull requests are required;
- stale pull-request reviews are dismissed;
- linear history and conversation resolution are required;
- force pushes and branch deletion are disabled; and
- enforcement for administrators is disabled (admins are not enforced).

Required status check contexts are intentionally pending until a green run on public `main` identifies the exact reporting names. They must not be configured from intended or guessed names.

### Protected release environment

The `release` environment exists and requires reviewer `gurkanguray`. Its deployment policies allow `main` and `v*`. Prevent-self-review is `false`.

For every release, require the tag commit to be an ancestor of `origin/main`,
then dispatch it with:

```sh
gh workflow run release-candidate.yml --ref "$TAG" -f tag="$TAG"
```

The workflow ref and tag input must be identical. Never dispatch from `main` or
supply a separate SHA.

### GitHub Pages

GitHub Pages is enabled with build_type: `workflow` at <https://gurkanguray.github.io/pi-docker-sandboxes/>. No candidate content has been deployed yet.

### Security and contribution settings

- Private vulnerability reporting is enabled.
- Secret scanning and push protection are enabled.
- Dependabot security updates are enabled, with zero alerts observed.
- DCO web signoff is enabled.

## Pending checks and release evidence

These items remain pending and must not be treated as complete:

- **Required status contexts:** pending a green public-`main` run that reveals the exact reporting names.
- **npm trusted publisher:** pending; npm is unauthenticated and the package is absent. npm requires the package to exist before trusted publishing can be configured, so the one-time reviewed `0.0.0` bootstrap described in `RELEASE.md` must precede OIDC setup.
- **Self-hosted release runner:** pending; the repository Actions runners response reported `total_count=0`.
- **Signing key:** pending.
- **Signed tag:** pending.
- **Hosted receipts:** pending.
- **Publication:** pending.

Do not publish, deploy candidate content, or claim full release readiness until every pending item has current evidence in the tracking issue.

## Read-only verification commands

These commands read configuration only. They do not enable or change settings.

```sh
repo=gurkanguray/pi-docker-sandboxes
gh api "repos/$repo/branches/main/protection"
gh api "repos/$repo/environments/release"
gh api "repos/$repo/pages"
gh api "repos/$repo/private-vulnerability-reporting"
gh api "repos/$repo/dependabot/alerts"
gh api "repos/$repo" --jq '.security_and_analysis'
gh api "repos/$repo/actions/runners"
```
