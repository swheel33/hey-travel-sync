FROM oven/bun:1.4.0 AS build
ARG TARGETARCH
ARG HEY_VERSION=1.11.0
WORKDIR /app
RUN set -eu; \
    case "$TARGETARCH" in amd64|arm64) ;; *) echo "unsupported architecture: $TARGETARCH"; exit 1 ;; esac; \
    archive="hey_${HEY_VERSION}_linux_${TARGETARCH}.tar.gz"; \
    base="https://github.com/basecamp/hey-cli/releases/download/v${HEY_VERSION}"; \
    apt-get update && apt-get install -y --no-install-recommends curl ca-certificates; \
    curl -fsSLO "$base/$archive"; curl -fsSLO "$base/checksums.txt"; \
    sha256sum --ignore-missing -c checksums.txt; \
    tar -xzf "$archive" hey; install -m 0755 hey /usr/local/bin/hey
COPY package.json bun.lock tsconfig.json ./
RUN bun install --frozen-lockfile
COPY src ./src
COPY tests ./tests
RUN bun run typecheck && bun test
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4.0-slim
COPY --from=build /usr/local/bin/hey /usr/local/bin/hey
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src ./src
COPY package.json ./
RUN useradd --uid 10001 app && mkdir -p /data && chown app:app /data
ENV HOME=/data/home \
    XDG_CONFIG_HOME=/data/home/.config \
    XDG_DATA_HOME=/data/home/.local/share \
    HEY_NO_KEYRING=1
USER app
VOLUME ["/data"]
ENTRYPOINT ["bun", "run", "src/main.ts"]
CMD ["run"]
