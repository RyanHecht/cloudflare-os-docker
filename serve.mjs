// Serve Cloudflare OS on Miniflare's programmatic API.
//
// Upstream ships no production deployment path (its README still says COMING SOON), and
// `wrangler dev` is a dev server: it re-runs codegen and bundling on every start and then
// watches sources for changes. Everything is pre-bundled at image build time instead
// (build-bundles.mjs) and this drives Miniflare directly -- the same workerd runtime and
// the same storage emulation wrangler would have used, minus the dev-server behaviour.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { realpathSync, existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.env.CFOS_ROOT ?? "/app";
const BUNDLES = join(ROOT, "bundles");
const PACKAGES = join(ROOT, "packages");
const PERSIST = process.env.CFOS_PERSIST ?? join(ROOT, ".mf-state");
const HOST = process.env.CFOS_HOST ?? "0.0.0.0";
const PORT = Number(process.env.CFOS_PORT ?? 8787);

// Resolve Miniflare through wrangler's real (pnpm-store) path: wrangler pins an exact
// miniflare version and the two share internal APIs, so they must not drift apart.
const wranglerReal = realpathSync(join(ROOT, "node_modules", "wrangler"));
const req = createRequire(join(wranglerReal, "package.json"));
const { Miniflare } = await import(pathToFileURL(req.resolve("miniflare")).href);
const { unstable_getMiniflareWorkerOptions } = await import(
    pathToFileURL(join(wranglerReal, "wrangler-dist", "cli.js")).href);

// Mirrors findGatekeepers() in run-dev-server.js.
function findGatekeepers() {
  return readdirSync(PACKAGES)
      .filter(n => n.startsWith("gatekeeper-"))
      .filter(n => {
        try { return statSync(join(PACKAGES, n, "wrangler.jsonc")).isFile(); }
        catch { return false; }
      })
      .filter(n => existsSync(join(BUNDLES, n)))
      .map(name => ({ name, dir: join(PACKAGES, name) }));
}

const bindingName = gk => gk.name.toUpperCase().replaceAll("-", "_");

function entryScript(dir) {
  const files = readdirSync(dir).filter(f => f.endsWith(".js"));
  // wrangler names the bundle after the worker's entry module.
  return join(dir, files.includes("index.js") ? "index.js" : files[0]);
}

// Let wrangler translate each checked-in wrangler.jsonc into Miniflare options so the
// binding set stays correct across upstream bumps rather than being duplicated here.
function workerFor(configPath, name, bundleDir, extra = {}) {
  const { workerOptions } = unstable_getMiniflareWorkerOptions(configPath);
  // `assets` is re-specified per worker below where needed; drop wrangler's copy so it
  // can't point at a path that doesn't exist in the image.
  const { assets, ...rest } = workerOptions;
  const scriptPath = entryScript(bundleDir);
  return {
    ...rest,
    ...extra,
    // Merge rather than replace: wrangler.jsonc may define vars of its own, and a
    // top-level spread would silently drop them.
    bindings: { ...rest.bindings, ...extra.bindings },
    serviceBindings: { ...rest.serviceBindings, ...extra.serviceBindings },
    name, scriptPath, modules: true, modulesRoot: bundleDir,
  };
}

const gatekeepers = findGatekeepers();

// Gatekeepers are bound two different ways, and mixing them up breaks one side:
//
//   router  -> default export, because it forwards /gatekeeper/* HTTP requests
//              (OAuth callbacks). The GatekeeperVendor class has no fetch().
//   backend -> the GatekeeperVendor entrypoint, which is the capnweb RPC target.
//
// Core discovers gatekeepers by scanning env for the GATEKEEPER_ prefix, so these
// lists *are* the config.
const gatekeeperFetchServices = Object.fromEntries(
    gatekeepers.map(gk => [bindingName(gk), gk.name]));

const gatekeeperRpcServices = Object.fromEntries(gatekeepers.map(gk => [
  bindingName(gk),
  {
    name: gk.name,
    entrypoint: "GatekeeperVendor",
    // The Context gatekeeper namespaces stored data by a "sharingDomain" carried in its
    // binding props. Any stable string works for a single self-hosted instance; changing
    // it later namespaces existing data away.
    ...(gk.name === "gatekeeper-context"
        ? { props: { sharingDomain: process.env.CFOS_SHARING_DOMAIN ?? "default" } }
        : {}),
  },
]));

// SERVER_MODELS is JSON, so it is full of commas -- and Portainer splits environment
// values on commas, which mangles it. SERVER_MODELS_FILE points at a mounted file
// instead, which also keeps the API token out of the stack repo.
if (process.env.SERVER_MODELS_FILE && !process.env.SERVER_MODELS) {
  // Missing file means "no shared models", which is a legitimate configuration.
  if (existsSync(process.env.SERVER_MODELS_FILE)) {
    process.env.SERVER_MODELS = readFileSync(process.env.SERVER_MODELS_FILE, "utf8").trim();
  } else {
    console.log(`No ${process.env.SERVER_MODELS_FILE}; users supply their own model keys.`);
  }
}

// Fail at boot rather than when a user first opens the model picker: the worker only
// parses this lazily, so a typo would otherwise surface much later and look unrelated.
if (process.env.SERVER_MODELS) {
  let parsed;
  try {
    parsed = JSON.parse(process.env.SERVER_MODELS);
  } catch (err) {
    console.error(`SERVER_MODELS is not valid JSON: ${err.message}`);
    process.exit(1);
  }
  if (!Array.isArray(parsed)) {
    console.error("SERVER_MODELS must be a JSON array.");
    process.exit(1);
  }
  // Entries are either an endpoint ({provider, apiUrl, models: [...]}) or the flat
  // one-model form. Models may also be discovered from the endpoint at runtime, so
  // this reports what was configured, not necessarily the final list.
  const described = parsed.map(e => {
    if (e && Array.isArray(e.models)) {
      const names = e.models.map(m => (typeof m === "string" ? m : m?.id ?? m?.model));
      return `${e.apiUrl ?? e.provider} (${names.join(", ")})`;
    }
    if (e && Array.isArray(e.models) === false && e.model) {
      return e.id ?? e.model;
    }
    return `${e?.apiUrl ?? e?.provider} (discover)`;
  });
  console.log(`Server models: ${described.join("; ") || "(none)"}`);

  // The worker only discovers models lazily, on the first authenticated model listing, so a
  // wrong URL or a dead token would otherwise stay invisible until someone opened the picker
  // and saw an empty list. Probe each endpoint once at boot purely for the log line.
  for (const e of parsed) {
    if (!e?.apiUrl || e.discover === false) continue;
    const base = String(e.apiUrl).replace(/\/+$/, "");
    const root = e.provider === "ollama" && !base.endsWith("/v1") ? `${base}/v1` : base;
    const url = `${root}/models`;
    try {
      const res = await fetch(url, {
        headers: {
          accept: "application/json",
          ...(e.apiToken ? { authorization: `Bearer ${e.apiToken}` } : {}),
        },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        console.warn(`  ${url}: HTTP ${res.status} — models will fall back to defaults.`);
        continue;
      }
      const body = await res.json();
      const list = Array.isArray(body) ? body : body?.data;
      const ids = Array.isArray(list)
          ? list.map(m => m?.id).filter(Boolean)
          : [];
      console.log(`  ${url}: ${ids.length} model(s) advertised`);
    } catch (err) {
      console.warn(`  ${url}: unreachable (${err.message}) — models will fall back to defaults.`);
    }
  }
}

const optionalVars = {};
for (const name of ["PUBLIC_BASE_URL", "CF_ACCESS_AUD", "CF_ACCESS_ISS", "AUTH_GATEKEEPERS",
                    "DISABLE_PASSWORD_AUTH", "CF_AI_GATEWAY", "CF_AI_GATEWAY_PROVIDERS",
                    "CF_AI_GATEWAY_ACCOUNT_ID", "CF_AI_GATEWAY_API_TOKEN",
                    // Models this deployment supplies to every user; see the fork's
                    // docs/server-managed-models.md.
                    "SERVER_MODELS"]) {
  if (process.env[name] !== undefined && process.env[name] !== "") {
    optionalVars[name] = process.env[name];
  }
}

const backend = workerFor(join(PACKAGES, "workshop-backend", "wrangler.jsonc"),
    "workshop-backend", join(BUNDLES, "backend"), {
      bindings: {
        // ADMINS is a JSON array binding; the backend also accepts a JSON string.
        ADMINS: JSON.parse(process.env.ADMINS ?? "[]"),
        ...optionalVars,
      },
      serviceBindings: gatekeeperRpcServices,
    });

// The Access flag is compiled into the frontend bundle, so pick the build that
// matches how the backend is configured. Getting this wrong is quiet and
// confusing: with Access on but the plain bundle served, the UI shows its own
// login form and every attempt fails with "This deployment requires Cloudflare
// Access authentication."
const ACCESS_MODE = Boolean(process.env.CF_ACCESS_AUD);
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
const FRONTEND_DEFAULT = join(PACKAGES, "workshop-frontend", "dist");
const FRONTEND_ACCESS = join(PACKAGES, "workshop-frontend", "dist-cfaccess");
const FRONTEND = ACCESS_MODE && existsSync(FRONTEND_ACCESS)
    ? FRONTEND_ACCESS : FRONTEND_DEFAULT;

// The router is the public entrypoint: /api and /gatekeeper/* go to their workers and
// everything else is served from the built frontend, matching the production layout.
const router = workerFor(join(ROOT, "wrangler.jsonc"), "dev-router", join(BUNDLES, "router"), {
  serviceBindings: { WORKSHOP_BACKEND: "workshop-backend", ...gatekeeperFetchServices },
  // invoke_user_worker_ahead_of_assets is essential: the router decides what is
  // an API/gatekeeper request and explicitly falls back to env.ASSETS.fetch()
  // for everything else. Without it Miniflare serves assets first, and the SPA
  // not-found fallback answers /api and /gatekeeper/* with index.html -- the UI
  // loads but every API call silently returns HTML.
  assets: { directory: FRONTEND, binding: "ASSETS",
            routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: true },
            assetConfig: { not_found_handling: "single-page-application" } },
});

// Each gatekeeper builds its own OAuth redirect URIs from BASE_URL, falling back
// to http://localhost:8787/gatekeeper/<vendor> when unset -- which is right for
// `wrangler dev` and useless anywhere else. Upstream's dev server never sets it,
// so connecting an account on a real deployment bounces the browser to localhost.
const gatekeeperWorkers = gatekeepers.map(gk => {
  const vendorId = gk.name.replace(/^gatekeeper-/, "");
  return workerFor(join(gk.dir, "wrangler.jsonc"), gk.name, join(BUNDLES, gk.name), {
    bindings: PUBLIC_BASE_URL
        ? { BASE_URL: `${PUBLIC_BASE_URL}/gatekeeper/${vendorId}` }
        : {},
  });
});

// TLS terminates upstream (Cloudflare/Traefik) and the container is reached over
// plain HTTP, so without this the worker sees http:// URLs. The backend compares
// the browser's Origin header against its own url.origin when Access is enabled,
// so every API call would 403 with "Cross-origin API access not allowed".
const upstream = process.env.PUBLIC_BASE_URL || undefined;

const mf = new Miniflare({
  host: HOST,
  port: PORT,
  ...(upstream ? { upstream } : {}),
  resourcePersistencePath: PERSIST,
  workers: [router, backend, ...gatekeeperWorkers],
});

await mf.ready;
console.log(`Cloudflare OS listening on http://${HOST}:${PORT}`);
console.log(`Gatekeepers: ${gatekeepers.map(g => g.name).join(", ") || "(none)"}`);
console.log(`Auth: ${ACCESS_MODE ? "Cloudflare Access" : "password"}`);
console.log(`State: ${PERSIST}`);

let shuttingDown = false;
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await mf.dispose();
    process.exit(0);
  });
}
