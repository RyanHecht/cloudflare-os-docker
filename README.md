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
stack out of the box is `wrangler dev`.

This image does **not** run a dev server. Instead:

- **Build time** (`build-bundles.mjs`): runs the codegen `run-dev-server.js` would do at startup,
  then bundles every worker (router, backend, and each gatekeeper) with
  `wrangler deploy --dry-run --outdir`.
- **Run time** (`serve.mjs`): drives **Miniflare's programmatic API** directly with those
  pre-bundled scripts — the same workerd runtime and the same storage emulation `wrangler dev`
  would have used, minus the file watching and per-start rebuilds.

Startup is **~4 seconds**, versus ~60s for `wrangler dev`, because nothing is built at boot.

Binding configuration is not duplicated here: `serve.mjs` calls wrangler's
`unstable_getMiniflareWorkerOptions()` on each checked-in `wrangler.jsonc`, so KV, R2, Durable
Object classes (including which are SQLite-backed), and the Worker Loader binding stay correct
across upstream bumps.

### Why not plain workerd?

workerd alone can't run this. Its `kvNamespace` and `r2Bucket` bindings are protocol adapters —
the capnp docs say they turn operations "into HTTP requests aimed at the named service" — so you
must supply services implementing KV and R2 yourself. Miniflare's implementations are not portable
into a hand-written `config.capnp`: they import `miniflare:shared` and extend
`MiniflareDurableObject`, i.e. Miniflare's internal, unversioned runtime. Going that route means
writing and owning a KV and R2 implementation.

Revisit once upstream ships real self-hosting.

## Usage

```bash
docker run -d --name cloudflare-os -p 8787:8787 \
  -v cfos-state:/app/state \
  ghcr.io/ryanhecht/cloudflare-os:latest
```

Ready in about 4 seconds; a 30s health-check `start_period` is plenty.

### Persistence

Mount a volume at **`/app/state`** (KV, R2 and Durable Object SQLite files).

State deliberately lives outside `.wrangler` so a volume can never shadow build output — the
backend's entry point is generated under `packages/workshop-backend/.wrangler`.

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
| `SERVER_MODELS` | JSON array of models offered to every user, with credentials held server-side. See the fork's [docs](https://github.com/RyanHecht/cloudflare-os/blob/server-managed-models/docs/server-managed-models.md) |
| `CFOS_SHARING_DOMAIN` | Namespace for Context gadget data (default `default`). Changing it later namespaces existing data away. |
| `CFOS_PERSIST` / `CFOS_HOST` / `CFOS_PORT` | Override state path, bind address, port |

### Security

Cloudflare OS lets users prompt an agent to generate and run code. **Do not expose it to the public
internet unauthenticated.** Set `CF_ACCESS_AUD` / `CF_ACCESS_ISS` and put Cloudflare Access in front
— the backend verifies the Access JWT natively and rejects requests without a valid one.

## Why the image is built this way

- **Miniflare is resolved through wrangler's own `node_modules`.** wrangler pins an exact Miniflare
  version and the two share internal APIs, so resolving Miniflare independently risks a version
  split. `serve.mjs` resolves it from wrangler's real (pnpm-store) path.
- **The router is the entrypoint, with an `ASSETS` binding.** That mirrors the production layout:
  `/api` and `/gatekeeper/*` route to their workers, everything else is served from the built
  frontend. (`run-local` instead makes the backend serve assets, which is a dev-only arrangement.)
- **amd64 only.** Emulated arm64 builds of this monorepo are impractically slow.

## Fork

`CFOS_REPO` points at [RyanHecht/cloudflare-os](https://github.com/RyanHecht/cloudflare-os), a
fork carrying `SERVER_MODELS` — deployment-supplied model providers, so users don't each have to
paste their own API key. That change is proposed upstream; if it lands, point `CFOS_REPO` back at
`cloudflare/cloudflare-os` and drop this section.

## Pinning

`CFOS_REF` in the `Dockerfile` pins the commit. Bump it deliberately — Cloudflare OS is in
heavy development. Tags are the 12-character upstream SHA, plus `latest`.

Build a different revision without editing the file via the `workflow_dispatch` input, or locally:

```bash
docker build -t cloudflare-os --build-arg CFOS_REF=<sha> .
```

## License

Packaging here is Apache-2.0. Cloudflare OS itself is Apache-2.0, copyright Cloudflare, Inc.
