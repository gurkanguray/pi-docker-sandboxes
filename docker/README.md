# Sandbox runtime image

The local fallback and release image use the same `Dockerfile` and `image-lock.json`. The build context is that Dockerfile plus an `npm pack` tarball. Credentials and host personalization are never copied.

```bash
npm run image:build
npm run image:verify -- docker.io/pi-docker-sandboxes/pi:0.1.0-alpha.1
```

`BASE_IMAGE` has no Dockerfile default; `image-lock.json` is the only base. The build installs the locked `fd-find`, `ripgrep`, and Git revisions, then leaves `agent` (UID 1000) as the final user.

Local launch uses a content-addressed tag `docker.io/pi-docker-sandboxes/pi:local-<64-hex-Docker-ID>`, never a raw Docker ID. `publishedImage` stays `null` until an approved registry publication records an immutable digest. Do not publish a local fallback build.
