ARG BASE_IMAGE
FROM ${BASE_IMAGE}

ARG PI_VERSION
ARG PACKAGE_VERSION
ARG FD_DEBIAN_VERSION
ARG RG_DEBIAN_VERSION
ARG GIT_DEBIAN_VERSION

USER root
COPY pi-docker-sandboxes.tgz /tmp/pi-docker-sandboxes.tgz
RUN set -eux; \
    apt-get update; \
    apt-get install --yes --no-install-recommends \
      "fd-find=${FD_DEBIAN_VERSION}" \
      "ripgrep=${RG_DEBIAN_VERSION}" \
      "git=${GIT_DEBIAN_VERSION}"; \
    ln -sf /usr/bin/fdfind /usr/local/bin/fd; \
    npm install --global \
      "@earendil-works/pi-coding-agent@${PI_VERSION}" \
      /tmp/pi-docker-sandboxes.tgz \
      --ignore-scripts; \
    test "$(node -p 'require("/usr/local/share/npm-global/lib/node_modules/@earendil-works/pi-coding-agent/package.json").version')" = "${PI_VERSION}"; \
    test "$(node -p 'require("/usr/local/share/npm-global/lib/node_modules/pi-docker-sandboxes/package.json").version')" = "${PACKAGE_VERSION}"; \
    test "$(pi --version)" = "${PI_VERSION}"; \
    test -x /usr/local/share/npm-global/bin/pi-dsbx; \
    su agent -s /bin/sh -c '/usr/local/share/npm-global/bin/pi-dsbx --help >/dev/null'; \
    test "$(dpkg-query -W -f='${Version}' fd-find)" = "${FD_DEBIAN_VERSION}"; \
    test "$(dpkg-query -W -f='${Version}' ripgrep)" = "${RG_DEBIAN_VERSION}"; \
    test "$(dpkg-query -W -f='${Version}' git)" = "${GIT_DEBIAN_VERSION}"; \
    rm -f /usr/libexec/docker/cli-plugins/docker-buildx; \
    test ! -e /usr/libexec/docker/cli-plugins/docker-buildx; \
    fd --version; \
    fdfind --version; \
    rg --version; \
    git --version; \
    node --version; \
    npm --version; \
    rm -f /tmp/pi-docker-sandboxes.tgz; \
    npm cache clean --force; \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/* /root/.npm

USER agent
