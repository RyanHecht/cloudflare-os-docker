# syntax=docker/dockerfile:1

# Cloudflare OS has no published container image and its self-hosted deployment
# path is "COMING SOON" upstream (the generate-wrangler-prod.js its configs
# reference does not exist yet). Until then the only supported way to run the
# whole stack is `wrangler dev`, which is what this image does.

FROM node:24-bookworm-slim AS build

# Pinned upstream revision. Bump deliberately; cloudflare-os is in heavy development.
ARG CFOS_REPO=https://github.com/cloudflare/cloudflare-os.git
ARG CFOS_REF=1cb5e3d9096589e38f3fcfaf3f2191aa95a4c592
ARG PNPM_VERSION=11.17.0

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git \
 && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

WORKDIR /app
RUN git init -q . \
 && git remote add origin "${CFOS_REPO}" \
 && git fetch -q --depth 1 origin "${CFOS_REF}" \
 && git checkout -q FETCH_HEAD

# wrangler dev binds 127.0.0.1 by default, which is unreachable from outside the
# container. dev.ip is the supported override and run-dev-server.js copies this
# file into the generated wrangler.dev.jsonc.
RUN node -e '\
  const fs = require("fs"); \
  const f = "wrangler.jsonc"; \
  const s = fs.readFileSync(f, "utf8"); \
  if (s.includes("\"dev\"")) { throw new Error("upstream now sets dev config; re-check the 0.0.0.0 patch"); } \
  fs.writeFileSync(f, s.replace("\"compatibility_date\"", "\"dev\": { \"ip\": \"0.0.0.0\" },\n  \"compatibility_date\"")); \
  ' \
 && grep -q '"ip": "0.0.0.0"' wrangler.jsonc

RUN pnpm install --frozen-lockfile

# Build only what is needed to serve, mirroring scripts/run-local.mjs.
RUN pnpm --filter @gadgets/typed-storage build \
 && pnpm --filter @gadgets/workshop-frontend exec vite build

# Prime the backend worker bundle so the first request isn't a cold build.
RUN pnpm --filter @gadgets/workshop-backend run build:worker

FROM node:24-bookworm-slim
ARG CFOS_REF
ARG PNPM_VERSION=11.17.0

LABEL org.opencontainers.image.title="cloudflare-os" \
      org.opencontainers.image.description="Unofficial container image for Cloudflare OS (self-hosted, runs on wrangler dev + workerd)" \
      org.opencontainers.image.source="https://github.com/RyanHecht/cloudflare-os-docker" \
      org.opencontainers.image.revision="${CFOS_REF}"

# procps supplies `ps`, which wrangler shells out to during startup; without it
# the process dies with "Error: spawn ps ENOENT".
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl procps tini \
 && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

WORKDIR /app
COPY --from=build /app /app

# Persistent state (KV, R2, Durable Objects) lives here. Note this is the repo-root
# .wrangler; the backend's build output is under packages/workshop-backend/.wrangler
# and must NOT be shadowed by a volume.
VOLUME ["/app/.wrangler/state"]

ENV NODE_ENV=production \
    VITE_BACKEND_HOST=0.0.0.0:8787
EXPOSE 8787

# Bypass scripts/run-local.mjs: it re-hashes sources to decide whether to rebuild,
# which is pointless here (sources are baked in) and would rebuild on every start
# once startup codegen perturbs the hash. Install and build already happened above.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "run-dev-server.js", "--serve-frontend-assets"]
