# syntax=docker/dockerfile:1

# --- builder: install deps, compile TS, build the KB index + warm the model ---
FROM node:22-slim AS builder
WORKDIR /app
ENV TRANSFORMERS_CACHE=/app/models

# pnpm via corepack
RUN corepack enable

# Install all deps (incl. dev) against the frozen lockfile. Native modules
# (onnxruntime-node, sharp) are built here so the runtime image inherits them.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Compile to dist/ and build the on-disk KB index. Running ingest with the local
# embedder also downloads bge-small into /app/models, baking it into the image so
# the first request in production doesn't pay a cold model download.
COPY . .
RUN pnpm build \
 && EMBED_LOCAL=true EMBED_LOCAL_MODEL=Xenova/bge-small-en-v1.5 pnpm ingest

# --- runtime: slim image with only what's needed to run ---
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    EMBED_LOCAL=true \
    EMBED_LOCAL_MODEL=Xenova/bge-small-en-v1.5 \
    TRANSFORMERS_CACHE=/app/models

# Carry over the built native deps rather than reinstalling, so the ONNX runtime
# binaries are guaranteed to match the build platform.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/models ./models
COPY --from=builder /app/data ./data
COPY --from=builder /app/kb ./kb
COPY --from=builder /app/db ./db
COPY --from=builder /app/public ./public
COPY package.json ./

EXPOSE 8080
CMD ["node", "dist/main.js"]
