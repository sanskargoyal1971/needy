/**
 * Post-build gate: every script the production server sends carries the nonce its own
 * Content-Security-Policy header demands.
 *
 * WHY THIS IS A SCRIPT AND NOT A UNIT TEST. `src/__tests__/proxy.test.ts` pins the header the
 * proxy writes. It cannot pin the other half: that Next stamps the same nonce onto the script
 * tags it emits, which it does only for a page rendered per request. That depends on
 * `await connection()` in `src/app/layout.tsx`, and deleting that line leaves the unit tests,
 * lint, typecheck and `next build` all green while `strict-dynamic` blocks every script on
 * every page — a blank app. Only the built output can show it, so this reads the built output.
 *
 * Two checks, cheapest first:
 *   1. The prerender manifest lists no page. A prerendered page is HTML frozen at build time,
 *      before any request (and so any nonce) existed.
 *   2. The standalone server is started on a loopback port and every static page is fetched;
 *      each `<script>` in each response must carry the nonce from that response's CSP header.
 *
 * Run after `next build`:  npm run check:csp --workspace @needy/web
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

const webRoot = fileURLToPath(new URL("../", import.meta.url));
const nextDir = `${webRoot}.next/`;

/**
 * Next's own fallback for an error thrown in the root layout. It is always prerendered, it is
 * not a route anyone can navigate to, and it has no layout of ours to make dynamic. It is the
 * one page allowed in the manifest; anything else there is a regression.
 */
const FRAMEWORK_STATIC_PAGES = new Set(["/_global-error"]);

function readJson(name) {
  try {
    return JSON.parse(readFileSync(`${nextDir}${name}`, "utf8"));
  } catch (err) {
    throw new Error(`cannot read .next/${name} — run \`next build\` first (${err.message})`);
  }
}

function prerenderedPages() {
  const manifest = readJson("prerender-manifest.json");
  const pages = Object.entries(manifest.routes ?? {})
    .filter(([route, meta]) => meta.routeType === "page" && !FRAMEWORK_STATIC_PAGES.has(route))
    .map(([route]) => route);
  // A dynamic route with a prerendered shell is the same problem with a different spelling.
  return [...pages, ...Object.keys(manifest.dynamicRoutes ?? {})];
}

/** Every page with a fixed URL. `[param]` routes need real ids and share the same layout. */
function probeablePages() {
  const routes = readJson("app-path-routes-manifest.json");
  return Object.entries(routes)
    .filter(([file]) => file.endsWith("/page"))
    .map(([, route]) => route)
    .filter((route) => !route.includes("[") && !FRAMEWORK_STATIC_PAGES.has(route))
    .sort();
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitUntilListening(origin, server) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`server exited early (code ${server.exitCode})`);
    try {
      await fetch(origin, { redirect: "manual" });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error("server did not start listening within 30s");
}

/** Returns a list of human-readable problems with one page; empty means it is sound. */
async function inspect(origin, route) {
  const res = await fetch(`${origin}${route}`, { redirect: "manual" });
  const policy = res.headers.get("content-security-policy") ?? "";
  const nonce = /'nonce-([^']+)'/.exec(policy)?.[1];
  if (!nonce) return [`${route}: response has no nonce in its Content-Security-Policy header`];

  const html = await res.text();
  const scripts = html.match(/<script\b[^>]*>/gi) ?? [];
  // A page with no scripts at all would pass vacuously, and would also mean this check has
  // stopped looking at what it thinks it is looking at.
  if (scripts.length === 0) return [`${route}: no <script> tags found (status ${res.status})`];

  const bare = scripts.filter((tag) => !tag.includes(`nonce="${nonce}"`));
  if (bare.length === 0) return [];
  return [
    `${route}: ${bare.length} of ${scripts.length} <script> tags lack the response's nonce, e.g. ${bare[0].slice(0, 120)}`,
  ];
}

async function main() {
  const problems = prerenderedPages().map(
    (route) => `${route}: prerendered at build time, so its scripts cannot carry a nonce`,
  );

  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, [`${nextDir}standalone/packages/web/server.js`], {
    env: { ...process.env, NODE_ENV: "production", PORT: String(port), HOSTNAME: "127.0.0.1" },
    stdio: ["ignore", "ignore", "inherit"],
  });

  const pages = probeablePages();
  try {
    await waitUntilListening(origin, server);
    for (const route of pages) problems.push(...(await inspect(origin, route)));
  } finally {
    server.kill();
  }

  if (problems.length > 0) {
    console.error("CSP nonce check FAILED — these pages would have their scripts blocked:");
    for (const p of problems) console.error(`  - ${p}`);
    console.error("See the comment on `await connection()` in src/app/layout.tsx.");
    process.exit(1);
  }
  console.log(`CSP nonce check passed: ${pages.length} pages, every <script> carries the nonce.`);
}

main().catch((err) => {
  console.error(`CSP nonce check could not run: ${err.message}`);
  process.exit(1);
});
