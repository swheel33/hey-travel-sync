FROM oven/bun:1.4.0 AS build

WORKDIR /app
COPY package.json bun.lock* tsconfig.json ./
RUN bun install --frozen-lockfile
COPY src ./src
RUN bun run typecheck

FROM ubuntu:26.04

ARG TARGETARCH
ARG HEY_VERSION=1.4.0
ARG OPENCODE_VERSION=1.18.25

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

RUN set -eu; \
    case "$TARGETARCH" in amd64|arm64) arch="$TARGETARCH" ;; *) echo "unsupported architecture: $TARGETARCH"; exit 1 ;; esac; \
    archive="hey_${HEY_VERSION}_linux_${arch}.tar.gz"; \
    curl -fsSLO "https://github.com/basecamp/hey-cli/releases/download/v${HEY_VERSION}/${archive}"; \
    curl -fsSLO "https://github.com/basecamp/hey-cli/releases/download/v${HEY_VERSION}/checksums.txt"; \
    sha256sum --ignore-missing -c checksums.txt; \
    tar -xzf "$archive"; \
    install -m 0755 hey /usr/local/bin/hey; \
    rm -f "$archive" checksums.txt hey

RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) arch="x64"; checksum="58a3729a6f3432dd6d2917fcc4a949788891a035818646ad480e12c947f56e78" ;; \
      arm64) arch="arm64"; checksum="35ef77897425e41b5183a2c21ac4fb1d4d944d82a94e3c920f57b5490af11ac5" ;; \
      *) echo "unsupported architecture: $TARGETARCH"; exit 1 ;; \
    esac; \
    archive="opencode-linux-${arch}.tar.gz"; \
    curl -fsSLo "$archive" "https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/${archive}"; \
    printf '%s  %s\n' "$checksum" "$archive" | sha256sum -c -; \
    tar -xzf "$archive"; \
    install -m 0755 opencode /usr/local/bin/opencode; \
    rm -f "$archive" opencode

RUN useradd --create-home --uid 10001 app \
    && mkdir -p /app /config /data /tmp/hey-travel-sync \
    && chown -R app:app /app /data /tmp/hey-travel-sync

WORKDIR /app
COPY --from=build /usr/local/bin/bun /usr/local/bin/bun
COPY --from=build --chown=app:app /app/src ./src
ENV HOME=/data/home \
    XDG_CONFIG_HOME=/data/home/.config \
    XDG_DATA_HOME=/data/home/.local/share \
    HEY_NO_KEYRING=1 \
    HEY_TRAVEL_CONFIG=/config/config.toml

USER app
VOLUME ["/data"]
ENTRYPOINT ["bun", "run", "src/cli.ts"]
CMD ["watch"]
