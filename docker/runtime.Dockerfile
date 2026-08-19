# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
ARG STANDARD_BASE
ARG DOCKER_BASE
ARG PI_VERSION
ARG RUNTIME_VERSION
ARG FD_VERSION
ARG FD_AMD64_NAME
ARG FD_AMD64_SHA256
ARG FD_ARM64_NAME
ARG FD_ARM64_SHA256

FROM ${STANDARD_BASE} AS runtime
ARG TARGETARCH
ARG PI_VERSION
ARG FD_VERSION
ARG FD_AMD64_NAME
ARG FD_AMD64_SHA256
ARG FD_ARM64_NAME
ARG FD_ARM64_SHA256
USER root
COPY runtime-package.json /opt/pi-runtime/package.json
COPY runtime-package-lock.json /opt/pi-runtime/package-lock.json
RUN set -eux; \
    : "${PI_VERSION:?}" "${FD_VERSION:?}"; \
    cd /opt/pi-runtime; \
    npm ci --omit=dev --ignore-scripts; \
    ln -s /opt/pi-runtime/node_modules/.bin/pi /usr/local/bin/pi; \
    case "$TARGETARCH" in \
      amd64) fd_archive="${FD_AMD64_NAME:?}"; fd_sha="${FD_AMD64_SHA256:?}" ;; \
      arm64) fd_archive="${FD_ARM64_NAME:?}"; fd_sha="${FD_ARM64_SHA256:?}" ;; \
      *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    curl --fail --location --silent --show-error \
      --output /tmp/fd.tar.gz \
      "https://github.com/sharkdp/fd/releases/download/v${FD_VERSION}/${fd_archive}"; \
    echo "${fd_sha}  /tmp/fd.tar.gz" | sha256sum --check; \
    tar --extract --gzip --file /tmp/fd.tar.gz --strip-components=1 \
      --directory /tmp "${fd_archive%.tar.gz}/fd"; \
    install --mode=0755 /tmp/fd /usr/local/bin/fd; \
    test "$(pi --version)" = "$PI_VERSION"; \
    test "$(fd --version)" = "fd $FD_VERSION"; \
    git --version; \
    rg --version; \
    npm cache clean --force; \
    rm -rf /tmp/fd /tmp/fd.tar.gz /root/.npm

FROM ${STANDARD_BASE} AS standard
ARG STANDARD_BASE
ARG SOURCE_SHA
ARG PI_VERSION
ARG RUNTIME_VERSION
USER root
COPY --from=runtime /opt/pi-runtime /opt/pi-runtime
COPY --from=runtime /usr/local/bin/fd /usr/local/bin/fd
RUN set -eux; \
    : "${SOURCE_SHA:?}" "${PI_VERSION:?}" "${RUNTIME_VERSION:?}"; \
    rm /usr/libexec/docker/cli-plugins/docker-buildx; \
    test ! -e /usr/libexec/docker/cli-plugins/docker-buildx; \
    ln -s /opt/pi-runtime/node_modules/.bin/pi /usr/local/bin/pi
LABEL org.opencontainers.image.source="https://github.com/gurkanguray/pi-docker-sandboxes" \
      org.opencontainers.image.revision="${SOURCE_SHA}" \
      org.opencontainers.image.version="${RUNTIME_VERSION}" \
      org.opencontainers.image.base.name="${STANDARD_BASE}" \
      io.pi-docker-sandboxes.runtime-schema="1" \
      io.pi-docker-sandboxes.pi-version="${PI_VERSION}" \
      io.pi-docker-sandboxes.variant="standard"
USER agent

FROM ${DOCKER_BASE} AS docker
ARG DOCKER_BASE
ARG SOURCE_SHA
ARG PI_VERSION
ARG RUNTIME_VERSION
USER root
COPY --from=runtime /opt/pi-runtime /opt/pi-runtime
COPY --from=runtime /usr/local/bin/fd /usr/local/bin/fd
RUN set -eux; \
    : "${SOURCE_SHA:?}" "${PI_VERSION:?}" "${RUNTIME_VERSION:?}"; \
    ln -s /opt/pi-runtime/node_modules/.bin/pi /usr/local/bin/pi
LABEL org.opencontainers.image.source="https://github.com/gurkanguray/pi-docker-sandboxes" \
      org.opencontainers.image.revision="${SOURCE_SHA}" \
      org.opencontainers.image.version="${RUNTIME_VERSION}" \
      org.opencontainers.image.base.name="${DOCKER_BASE}" \
      io.pi-docker-sandboxes.runtime-schema="1" \
      io.pi-docker-sandboxes.pi-version="${PI_VERSION}" \
      io.pi-docker-sandboxes.variant="docker"
USER agent
