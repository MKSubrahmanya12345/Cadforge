# syntax=docker/dockerfile:1
#
# CADForge API server: Express + the pipeline orchestrator + the MCP endpoint.
# Also serves the built client, so one service is the whole application.
#
# Build context is the repo ROOT (so `shared/` and `client/` are both visible),
# not `server/`. The `COPY client/package.json` in this file is what forces
# that — a Dockerfile written for one context reports every COPY as "not found"
# under the other.
#
#   cd cadforge
#   docker build -f server/Dockerfile -t cadforge-api .
#   docker run -p 4000:4000 --env-file .env cadforge-api

FROM oven/bun:1.3-debian AS build

WORKDIR /app

# Install with the lockfile first so the dependency layer caches across code
# changes. Only the shared and server workspaces are needed for an API image;
# the client is a separate concern.
COPY package.json bun.lock bunfig.toml ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
COPY client/package.json ./client/

RUN bun install --frozen-lockfile

COPY tsconfig.base.json ./
COPY shared ./shared
COPY server ./server

RUN bunx tsc -p shared/tsconfig.json --noEmit \
    && bunx tsc -p server/tsconfig.json --noEmit

# ---------------------------------------------------------------------------

FROM oven/bun:1.3-debian-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    PORT=4000 \
    STORAGE_DIR=./storage \
    LOG_LEVEL=info

# The client is built in its own stage and only copied in if it builds, so a
# change to the UI cannot take the API down.
FROM build AS client-build

COPY client ./client
RUN bun run --cwd client build

# ---------------------------------------------------------------------------

FROM oven/bun:1.3-debian-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    PORT=4000 \
    STORAGE_DIR=./storage \
    LOG_LEVEL=info

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/shared ./shared
COPY --from=build /app/server ./server
COPY --from=client-build /app/client/dist ./client/dist

# Artifacts are written here. Mount a volume to persist them; without one, models
# are lost on restart. When the worker is a separate service the API proxies
# downloads through it and does not need this to be shared or persistent.
RUN mkdir -p /app/storage

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD bun -e "const r = await fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health'); process.exit(r.ok?0:1)" || exit 1

CMD ["bun", "run", "--cwd", "server", "start"]
