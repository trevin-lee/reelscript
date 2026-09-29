# reelscript: product demos as code. Canonical render environment.
#
#   docker run --rm -v "$PWD:/work" -v reelscript-cache:/cache ghcr.io/trevin-lee/reelscript render demo.ts
#
# Chromium, ffmpeg, fonts, VS Code (code-server) and the narration model are
# built in under /opt/reelscript/builtin. /cache is for what a render adds
# (editor extensions, narration clips); mount a volume there to keep it.
#
# Slim Node base plus only Chromium's headless shell (the browser reelscript
# drives), pinned to the Playwright version in package-lock.json.

FROM node:22-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN npm ci && npm run build

FROM node:22-bookworm-slim
LABEL org.opencontainers.image.source="https://github.com/trevin-lee/reelscript" \
      org.opencontainers.image.description="reelscript: product demos as code" \
      org.opencontainers.image.licenses="MIT"
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    REELSCRIPT_CODE_SERVER=/opt/reelscript/builtin/code-server/bin/code-server \
    REELSCRIPT_MODELS=/opt/reelscript/builtin/models \
    REELSCRIPT_CACHE=/cache
WORKDIR /opt/reelscript
COPY package.json package-lock.json ./
ARG CODE_SERVER_VERSION=4.138.0
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates git \
 && arch="$(dpkg --print-architecture)" \
 && mkdir -p /opt/reelscript/builtin/code-server \
 && curl -fsSL "https://github.com/coder/code-server/releases/download/v$CODE_SERVER_VERSION/code-server-$CODE_SERVER_VERSION-linux-$arch.tar.gz" \
    | tar -xz -C /opt/reelscript/builtin/code-server --strip-components=1 \
 && rm -rf /var/lib/apt/lists/*
RUN npm ci --omit=dev \
 && npx playwright install --with-deps chromium-headless-shell \
 # onnxruntime ships binaries for every platform; keep only Linux
 && rm -rf node_modules/onnxruntime-node/bin/napi-v*/darwin node_modules/onnxruntime-node/bin/napi-v*/win32 \
 && rm -rf /var/lib/apt/lists/* /root/.npm
COPY --from=build /src/dist ./dist
COPY assets ./assets
# The MCP server's reelscript_docs tool serves the README.
COPY README.md CHANGELOG.md ./
RUN chmod +x dist/cli.js && ln -s /opt/reelscript/dist/cli.js /usr/local/bin/reelscript
# Build the narration model in, and leave /cache empty and writable by any user.
RUN reelscript warmup narration \
 && rm -rf /cache && mkdir -p /cache && chmod 1777 /cache
WORKDIR /work
ENTRYPOINT ["reelscript"]
CMD ["--help"]
