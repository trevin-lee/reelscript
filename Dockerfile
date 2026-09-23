# reelscript: product demos as code. Canonical render environment.
#
#   docker run --rm -v "$PWD:/work" ghcr.io/trevin-lee/reelscript render demo.ts --out demo.mp4
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
    REELSCRIPT_CACHE=/opt/reelscript/cache
WORKDIR /opt/reelscript
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
 && npx playwright install --with-deps chromium-headless-shell \
 # onnxruntime ships binaries for every platform; keep only Linux
 && rm -rf node_modules/onnxruntime-node/bin/napi-v*/darwin node_modules/onnxruntime-node/bin/napi-v*/win32 \
 && rm -rf /var/lib/apt/lists/* /root/.npm
COPY --from=build /src/dist ./dist
COPY assets ./assets
RUN chmod +x dist/cli.js && ln -s /opt/reelscript/dist/cli.js /usr/local/bin/reelscript
# Bake the narration model into the image so renders never download at run time.
RUN reelscript warmup
WORKDIR /work
ENTRYPOINT ["reelscript"]
CMD ["--help"]
