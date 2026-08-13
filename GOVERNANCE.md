# Governance

## Alpha governance

Guray Gurkan (`@gurkanguray`) is the alpha maintainer and release approver for pi-docker-sandboxes. The maintainer reviews contributions, resolves deadlocks, enforces the Code of Conduct, and decides whether a release is ready.

Design and project decisions occur in public GitHub issues and pull requests whenever confidentiality does not require the private security process. Contributors should state the problem, alternatives, and relevant test evidence there. Decisions favor demonstrated safety, compatibility with the supported public-alpha matrix, and the smallest maintainable change.

Security changes and breaking boundary changes to isolation, credentials, network policy, export/apply, cleanup, or host fallback require maintainer approval. Releases also require explicit approval from the release approver and must follow [RELEASE.md](RELEASE.md).

This alpha governance model reflects the project's current single-maintainer ownership. It makes no promise of permanent benevolent dictator (BDFL) governance beyond alpha. Governance can evolve publicly as the maintainer and contributor base grows.
