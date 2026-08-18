# Sandbox runtime image

The local fallback and release image use the same `Dockerfile` and `image-lock.json`. The standard image is exactly `linux/arm64`; image verification rejects other platforms. Credentials and host personalization are never copied.

From a source checkout, `npm run image:build` builds and verifies the image. After the public release, installed-package users run:

```bash
npm exec --package=pi-docker-sandboxes@0.1.0 -- pi-dsbx image build
```

`BASE_IMAGE` has no Dockerfile default; `image-lock.json` is the only base. The build installs the locked `fd-find`, `ripgrep`, and Git revisions, then leaves `agent` (UID 1000) as the final user.

Local launch uses a content-addressed tag `docker.io/pi-docker-sandboxes/pi:local-<64-hex-Docker-ID>`, never a raw Docker ID. Registry publication is deferred during Early Access. Do not publish a local fallback build.
