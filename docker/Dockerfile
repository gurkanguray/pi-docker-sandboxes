# syntax=docker/dockerfile:1.7
ARG STANDARD_BASE=docker/sandbox-templates@sha256:c183a8ba03cdb30011c73f555c773c5712b84c6ea066f18409253dcab2cfe799
ARG DOCKER_BASE=docker/sandbox-templates@sha256:d86a6cdc105a1b299667a20c40bcf8d0584e56f21d44490a0737bb1baeb44299

FROM ${STANDARD_BASE} AS runtime
ARG TARGETARCH
USER root
COPY runtime-package.json /opt/pi-runtime/package.json
COPY runtime-package-lock.json /opt/pi-runtime/package-lock.json
RUN set -eux; \
    cd /opt/pi-runtime; \
    npm ci --omit=dev --ignore-scripts; \
    ln -s /opt/pi-runtime/node_modules/.bin/pi /usr/local/bin/pi; \
    case "$TARGETARCH" in \
      amd64) fd_arch=x86_64; fd_sha=c3c2bc79f838e780173fc8f18b337ec273e7ba17c7ff8f551be29fc3c19b7916 ;; \
      arm64) fd_arch=aarch64; fd_sha=66f297e404400a3358e9a0c0b2f3f4725956e7e4435427a9ae56e22adbe73a68 ;; \
      *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    fd_archive="fd-v10.3.0-${fd_arch}-unknown-linux-gnu.tar.gz"; \
    curl --fail --location --silent --show-error \
      --output /tmp/fd.tar.gz \
      "https://github.com/sharkdp/fd/releases/download/v10.3.0/${fd_archive}"; \
    echo "${fd_sha}  /tmp/fd.tar.gz" | sha256sum --check; \
    tar --extract --gzip --file /tmp/fd.tar.gz --strip-components=1 \
      --directory /tmp "fd-v10.3.0-${fd_arch}-unknown-linux-gnu/fd"; \
    install --mode=0755 /tmp/fd /usr/local/bin/fd; \
    test "$(pi --version)" = "0.84.1"; \
    test "$(fd --version)" = "fd 10.3.0"; \
    git --version; \
    rg --version; \
    npm cache clean --force; \
    rm -rf /tmp/fd /tmp/fd.tar.gz /root/.npm

FROM ${STANDARD_BASE} AS standard
ARG SOURCE_SHA=unknown
USER root
COPY --from=runtime /opt/pi-runtime /opt/pi-runtime
COPY --from=runtime /usr/local/bin/fd /usr/local/bin/fd
RUN set -eux; \
    rm /usr/libexec/docker/cli-plugins/docker-buildx; \
    test ! -e /usr/libexec/docker/cli-plugins/docker-buildx; \
    ln -s /opt/pi-runtime/node_modules/.bin/pi /usr/local/bin/pi
LABEL org.opencontainers.image.source="https://github.com/gurkanguray/pi-docker-sandboxes" \
      org.opencontainers.image.revision="${SOURCE_SHA}" \
      org.opencontainers.image.version="runtime-1" \
      org.opencontainers.image.base.name="docker/sandbox-templates@sha256:c183a8ba03cdb30011c73f555c773c5712b84c6ea066f18409253dcab2cfe799" \
      io.pi-docker-sandboxes.runtime-schema="1" \
      io.pi-docker-sandboxes.pi-version="0.84.1" \
      io.pi-docker-sandboxes.variant="standard"
USER agent

FROM ${DOCKER_BASE} AS docker
ARG SOURCE_SHA=unknown
USER root
COPY --from=runtime /opt/pi-runtime /opt/pi-runtime
COPY --from=runtime /usr/local/bin/fd /usr/local/bin/fd
RUN ln -s /opt/pi-runtime/node_modules/.bin/pi /usr/local/bin/pi
LABEL org.opencontainers.image.source="https://github.com/gurkanguray/pi-docker-sandboxes" \
      org.opencontainers.image.revision="${SOURCE_SHA}" \
      org.opencontainers.image.version="runtime-1" \
      org.opencontainers.image.base.name="docker/sandbox-templates@sha256:d86a6cdc105a1b299667a20c40bcf8d0584e56f21d44490a0737bb1baeb44299" \
      io.pi-docker-sandboxes.runtime-schema="1" \
      io.pi-docker-sandboxes.pi-version="0.84.1" \
      io.pi-docker-sandboxes.variant="docker"
USER agent
