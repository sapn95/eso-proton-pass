# eso-proton-pass: node plus the pass-cli binary, nothing else.
# Pinned by digest; Dependabot moves the digest along with the tag.
FROM node:26-slim@sha256:0d1e33586362bb9e608c4e751e7a9e7edb55c9ac11461ed5666af696cc461dd4

# pass-cli is published as one binary per architecture. Its checksums are
# written down here rather than fetched next to the binary: a .sha256 from the
# same release would only prove the download was not cut short, not that the
# release asset is the one that was reviewed. A new version means new lines.
ARG PASS_CLI_VERSION=2.4.2
ARG PASS_CLI_SHA256_AMD64=4089bdf5981140ac5bee65d2d79bf98767537f54d33197b79e5f86c630714842
ARG PASS_CLI_SHA256_ARM64=eee38fc4549a5dfcbb794aafcb6d517c9e0cd0dc3c53bbb2997fd8142ed681c7
ARG TARGETARCH
RUN set -eu; \
    case "${TARGETARCH:-$(dpkg --print-architecture)}" in \
      amd64) arch=x86_64; sum="${PASS_CLI_SHA256_AMD64}" ;; \
      arm64) arch=aarch64; sum="${PASS_CLI_SHA256_ARM64}" ;; \
      *) echo "no pass-cli build for ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl; \
    curl -fsSLo /tmp/pass-cli "https://github.com/protonpass/pass-cli/releases/download/${PASS_CLI_VERSION}/pass-cli-linux-${arch}"; \
    echo "${sum}  /tmp/pass-cli" | sha256sum -c -; \
    install -m 0755 /tmp/pass-cli /usr/local/bin/pass-cli; \
    rm /tmp/pass-cli; \
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
# pass-cli reports usage telemetry unless told not to (any value turns it
# off), and checks for updates, which an image pinned to a version must not.
ENV NODE_ENV=production \
    PROTON_PASS_KEY_PROVIDER=fs \
    PROTON_PASS_SESSION_DIR=/session \
    PROTON_PASS_DISABLE_TELEMETRY=1 \
    PROTON_PASS_NO_UPDATE_CHECK=1 \
    PORT=8080

USER node
EXPOSE 8080
ENTRYPOINT ["node", "/app/bin/eso-proton-pass.mjs"]
