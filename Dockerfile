# syntax=docker/dockerfile:1

# Cloudflare OS has no published container image and no production deployment path
# upstream: its README still says "COMING SOON" and the generate-wrangler-prod.js its
# configs reference does not exist in the repo. The only supported way to run the whole
# stack is `wrangler dev`.
#
# Rather than ship a dev server, this image pre-bundles every worker at build time and
# serves them with Miniflare's programmatic API -- the same workerd runtime and the same
# storage emulation `wrangler dev` uses, without the file watching and per-start rebuilds.

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

RUN pnpm install --frozen-lockfile

# Frontend bundle: the router serves this as static assets.
RUN pnpm --filter @gadgets/typed-storage build \
 && pnpm --filter @gadgets/workshop-frontend exec vite build

# Codegen + bundle every worker (router, backend, and each gatekeeper) so that no
# building happens at container start.
COPY build-bundles.mjs /app/build-bundles.mjs
RUN node build-bundles.mjs

FROM node:24-bookworm-slim
ARG CFOS_REF
ARG PNPM_VERSION=11.17.0

LABEL org.opencontainers.image.title="cloudflare-os" \
      org.opencontainers.image.description="Unofficial container image for Cloudflare OS, served via Miniflare's programmatic API" \
      org.opencontainers.image.source="https://github.com/RyanHecht/cloudflare-os-docker" \
      org.opencontainers.image.revision="${CFOS_REF}"

# procps supplies `ps`, which the toolchain shells out to; without it startup can die
# with "Error: spawn ps ENOENT".
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl procps tini \
 && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

WORKDIR /app
COPY --from=build /app /app
COPY serve.mjs /app/serve.mjs

# KV, R2 and Durable Object state (SQLite). Kept outside .wrangler so it can never
# shadow build output.
ENV CFOS_PERSIST=/app/state
VOLUME ["/app/state"]

ENV NODE_ENV=production \
    CFOS_HOST=0.0.0.0 \
    CFOS_PORT=8787
EXPOSE 8787

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "serve.mjs"]
