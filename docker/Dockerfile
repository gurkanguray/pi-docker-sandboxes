ARG BASE_IMAGE
FROM ${BASE_IMAGE}

ARG PI_VERSION
ARG FD_DEBIAN_VERSION
ARG RG_DEBIAN_VERSION
ARG GIT_DEBIAN_VERSION

USER root
RUN set -eux; \
    apt-get update; \
    apt-get install --yes --no-install-recommends \
      "fd-find=${FD_DEBIAN_VERSION}" \
      "ripgrep=${RG_DEBIAN_VERSION}" \
      "git=${GIT_DEBIAN_VERSION}"; \
    ln -sf /usr/bin/fdfind /usr/local/bin/fd; \
    npm install --global \
      "@earendil-works/pi-coding-agent@${PI_VERSION}" \
      --ignore-scripts; \
    test "$(node -p 'require("/usr/local/share/npm-global/lib/node_modules/@earendil-works/pi-coding-agent/package.json").version')" = "${PI_VERSION}"; \
    test "$(pi --version)" = "${PI_VERSION}"; \
    test "$(dpkg-query -W -f='${Version}' fd-find)" = "${FD_DEBIAN_VERSION}"; \
    test "$(dpkg-query -W -f='${Version}' ripgrep)" = "${RG_DEBIAN_VERSION}"; \
    test "$(dpkg-query -W -f='${Version}' git)" = "${GIT_DEBIAN_VERSION}"; \
    fd --version; \
    fdfind --version; \
    rg --version; \
    git --version; \
    node --version; \
    npm --version; \
    npm cache clean --force; \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/* /root/.npm

USER agent
