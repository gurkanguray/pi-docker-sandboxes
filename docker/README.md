# Production runtime image

Users run the locked public standard OCI index; they do not create a replacement runtime during installation.

`ghcr.io/gurkanguray/pi-docker-sandboxes-runtime-standard@sha256:43433061a13ba16ca6e2d327d245844199acd231b9a4087aa26773e5f2d6714b`

This non-privileged index contains `linux/amd64` and `linux/arm64`. The controller selects the matching manifest and verifies the immutable digest. The private Docker Engine is disabled in 1.0.0 because the production controller does not authorize a privileged runtime variant.

The standard runtime is separate from the npm controller. It contains the locked Pi runtime and required tools; the controller injects its sandbox-only extension through Kit files. This removes any package/image digest cycle.

The release workflow binds the exact index digest to per-platform CycloneDX SBOMs, zero HIGH/CRITICAL raw scans, a runtime receipt, and GitHub OIDC provenance. The npm release then runs its exact tarball and this exact digest on macOS arm64, Ubuntu amd64 KVM, and Ubuntu arm64 KVM before publication approval.

`runtime.Dockerfile`, `runtime-lock.json`, and the locked Docker-owned template digest are maintainer inputs. Runtime publication is two-phase: publish and verify an immutable index first, then review the controller lock update. Floating tags, custom substitutions, and installation-time runtime creation are outside the supported product path.
