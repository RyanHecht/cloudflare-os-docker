# cloudflare-os-docker

An unofficial container image for [Cloudflare OS](https://github.com/cloudflare/cloudflare-os).

```
ghcr.io/ryanhecht/cloudflare-os:latest
ghcr.io/ryanhecht/cloudflare-os:<12-char-upstream-sha>
```

Platform: `linux/amd64` only (see below).

## What this actually runs

Upstream has **no published image and no production deployment path yet**. Its README lists
"Deploy to your own server using `workerd`" as **COMING SOON**, and its worker configs reference a
`generate-wrangler-prod.js` that does not exist in the repo. The only supported way to run the whole
stack today is `wrangler dev`.

So this image runs `run-dev-server.js --serve-frontend-assets` — the same thing `pnpm run-local`
does, minus the source-hash rebuild logic. That means:

- **You are running a dev server in production.** Upstream explicitly says this "is not the right way
  to run the OS on a production server". It works, but expect rough edges.
- Storage (KV, R2, Durable Objects) is provided by Miniflare, persisted as SQLite under
  `/app/.wrangler/state`.

Revisit this image once upstream ships real self-hosting.

## Usage

```bash
docker run -d --name cloudflare-os -p 8787:8787 \
  -v cfos-state:/app/.wrangler/state \
  ghcr.io/ryanhecht/cloudflare-os:latest
```

First start takes roughly a minute: startup regenerates gatekeeper configurator UIs and rebuilds the
backend worker bundle before serving. Allow ~120s before failing a health check.

### Persistence

Mount a volume at **`/app/.wrangler/state`** — and only there.

Do **not** mount over `/app/.wrangler` or `packages/workshop-backend/.wrangler`: the backend's entry
point is `.wrangler/validate/src/server.ts`, which is build output. A volume over the parent
directory hides it and the worker fails to start.

### Configuration

All optional. Cloudflare OS is BYOK by default — each user supplies their own model credentials in
the UI, so no API keys are needed in the container.

| Variable | Purpose |
| --- | --- |
| `ADMINS` | JSON array of admin usernames, e.g. `["ryan"]` |
| `PUBLIC_BASE_URL` | Public URL of the deployment |
| `CF_ACCESS_AUD` | Cloudflare Access audience tag — **enables Access SSO** |
| `CF_ACCESS_ISS` | Access team URL, e.g. `https://<team>.cloudflareaccess.com` |
| `AUTH_GATEKEEPERS` | Comma-separated gatekeepers allowed to drive sign-in, e.g. `github,google` |
| `DISABLE_PASSWORD_AUTH` | `"true"` to require gatekeeper sign-in (only applies if a gatekeeper is allowlisted) |
| `CF_AI_GATEWAY` | Route providers through a Cloudflare AI Gateway with server-managed keys |

### Security

Cloudflare OS lets users prompt an agent to generate and run code. **Do not expose it to the public
internet unauthenticated.** Set `CF_ACCESS_AUD` / `CF_ACCESS_ISS` and put Cloudflare Access in front
— the backend verifies the Access JWT natively and rejects requests without a valid one.

## Why the image is built this way

- **The `dev.ip` patch.** `wrangler dev` binds `127.0.0.1` by default, which is unreachable from
  outside a container. The build injects `"dev": { "ip": "0.0.0.0" }` into `wrangler.jsonc`, which
  `run-dev-server.js` copies into the generated config. The build fails loudly if upstream starts
  setting its own `dev` block, so the patch can't silently stop applying.
- **`run-dev-server.js` instead of `scripts/run-local.mjs`.** `run-local` hashes every source file to
  decide whether to reinstall and rebuild. Sources are baked into the image, and startup codegen
  perturbs that hash, so it would risk a full rebuild on every restart. Install and build happen at
  image build time instead.
- **amd64 only.** Emulated arm64 builds of this monorepo are impractically slow.

## Pinning

`CFOS_REF` in the `Dockerfile` pins the upstream commit. Bump it deliberately — Cloudflare OS is in
heavy development. Tags are the 12-character upstream SHA, plus `latest`.

Build a different revision without editing the file via the `workflow_dispatch` input, or locally:

```bash
docker build -t cloudflare-os --build-arg CFOS_REF=<sha> .
```

## License

Packaging here is Apache-2.0. Cloudflare OS itself is Apache-2.0, copyright Cloudflare, Inc.
