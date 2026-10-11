# eso-proton-pass: node plus the pass-cli binary, nothing else.
FROM node:24-slim

# pass-cli is published as a static-ish binary per architecture, with a
# .sha256 next to it. The checksum is verified before the binary is kept.
ARG PASS_CLI_VERSION=2.4.2
ARG TARGETARCH
RUN set -eu; \
    case "${TARGETARCH:-$(dpkg --print-architecture)}" in \
      amd64) arch=x86_64 ;; \
      arm64) arch=aarch64 ;; \
      *) echo "no pass-cli build for ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl; \
    base="https://github.com/protonpass/pass-cli/releases/download/${PASS_CLI_VERSION}"; \
    curl -fsSLo /tmp/pass-cli "${base}/pass-cli-linux-${arch}"; \
    curl -fsSLo /tmp/pass-cli.sha256 "${base}/pass-cli-linux-${arch}.sha256"; \
    echo "$(cut -d' ' -f1 /tmp/pass-cli.sha256)  /tmp/pass-cli" | sha256sum -c -; \
    install -m 0755 /tmp/pass-cli /usr/local/bin/pass-cli; \
    rm /tmp/pass-cli /tmp/pass-cli.sha256; \
    apt-get purge -y curl; \
    apt-get autoremove -y; \
    rm -rf /var/lib/apt/lists/*; \
    pass-cli --version

WORKDIR /app
COPY package.json ./
COPY bin ./bin
COPY src ./src

# A container has no kernel keyring to keep the session key in, so it goes
# next to the session, in a directory the Deployment mounts as an emptyDir.
ENV NODE_ENV=production \
    PROTON_PASS_KEY_PROVIDER=fs \
    PROTON_PASS_SESSION_DIR=/session \
    PORT=8080

USER node
EXPOSE 8080
ENTRYPOINT ["node", "/app/bin/eso-proton-pass.mjs"]
