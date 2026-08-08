// Pre-bundle every Cloudflare OS worker at image build time.
//
// run-dev-server.js does this work on every startup (and then watches for changes).
// Doing it once here keeps startup fast and keeps sources out of the serving path.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.env.CFOS_ROOT ?? "/app";
const PACKAGES = join(ROOT, "packages");
const BUNDLES = join(ROOT, "bundles");
const BACKEND = join(PACKAGES, "workshop-backend");

function run(cmd, args, cwd) {
  console.log(`> ${cmd} ${args.join(" ")}  (cwd=${cwd})`);
  execFileSync(cmd, args, { stdio: "inherit", cwd });
}

// Mirrors findGatekeepers() in run-dev-server.js.
export function findGatekeepers() {
  return readdirSync(PACKAGES)
      .filter(n => n.startsWith("gatekeeper-"))
      .filter(n => {
        try { return statSync(join(PACKAGES, n, "wrangler.jsonc")).isFile(); }
        catch { return false; }
      })
      .map(name => ({ name, dir: join(PACKAGES, name) }));
}

rmSync(BUNDLES, { recursive: true, force: true });
mkdirSync(BUNDLES, { recursive: true });

// Codegen the backend expects to exist before bundling.
run(process.execPath, [join(BACKEND, "scripts", "build-format-blueprints.mjs")], BACKEND);

const gatekeepers = findGatekeepers();
console.log(`\nFound ${gatekeepers.length} gatekeepers.`);

for (const gk of gatekeepers) {
  if (existsSync(join(gk.dir, "src", "configurator"))) {
    run(process.execPath,
        [join(ROOT, "scripts", "build-gatekeeper-configurator.mjs"), gk.dir, "--quiet"], ROOT);
  }
  if (existsSync(join(gk.dir, "build-app.mjs"))) {
    run(process.execPath, [join(gk.dir, "build-app.mjs")], gk.dir);
  }
}

function bundle(cwd, outName) {
  run("pnpm", ["exec", "wrangler", "deploy", "--dry-run", `--outdir=${join(BUNDLES, outName)}`], cwd);
}

bundle(ROOT, "router");
bundle(BACKEND, "backend");
for (const gk of gatekeepers) bundle(gk.dir, gk.name);

console.log(`\nBundled ${gatekeepers.length + 2} workers into ${BUNDLES}`);
