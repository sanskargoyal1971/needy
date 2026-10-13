/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",

  // The monorepo root is two levels up; without this Next infers the workspace root from
  // the nearest lockfile and traces the wrong files into the standalone bundle. Top-level
  // since Next 15 — it lived under `experimental` on 14, and the old spelling is now the one
  // that is ignored. Turbopack reads its own root from the same value.
  outputFileTracingRoot: new URL("../../", import.meta.url).pathname,

  // No `eslint` key: Next 16 removed both `next lint` and lint-during-build, so there is
  // nothing left here to switch off. Linting is owned by the root flat config (`npm run lint`).

  // `next dev` on 16 writes an AGENTS.md beside this file on every start. The repo already has
  // one at the root that carries the project's security and design rules; a second, generated
  // one in the package would sit closer to the code and so be read in preference to it.
  agentRules: false,

  typescript: {
    // Deliberately NOT ignored. `next build` typechecking is a real gate and must stay one.
    ignoreBuildErrors: false,
  },

  webpack: (config) => {
    /**
     * Let a `./types.js` specifier resolve to `types.ts`.
     *
     * `src/realtime/` was written for the Vite app and imports its siblings with explicit
     * `.js` extensions — which is the CORRECT spelling for ESM under TypeScript's NodeNext
     * resolution, and is what the shared package uses too. Next's webpack does not apply that
     * mapping by default, so those modules were unresolvable. It never surfaced because
     * nothing in the Next app imported them: the drivers sat unreferenced from the day the two
     * front ends were merged until the participant screens finally mounted one.
     *
     * The alternative was rewriting every relative import in those files to drop the
     * extension, which would make them inconsistent with the rest of the monorepo to work
     * around a bundler default. This is the same mapping tsc already performs.
     *
     * WHY THE SCRIPTS SAY `--webpack`. Next 16 builds with Turbopack unless told otherwise,
     * and Turbopack has no equivalent of this option: `turbopack.resolveExtensions` only adds
     * extensions to try on an extensionless import, `turbopack.resolveAlias` maps one
     * specifier at a time, and `experimental.extensionAlias` is on Next's own list of options
     * Turbopack ignores. Tried, not assumed — `next build --turbopack` on this tree fails with
     * "Can't resolve './types.js'" at `src/realtime/index.ts`. So `dev` and `build` both opt
     * into webpack explicitly, which keeps one resolver for development and production. The
     * flag is load-bearing in a second way: without it Next 16 refuses to build at all when
     * it finds a `webpack` function and no Turbopack config, precisely so that a block like
     * this one cannot be silently skipped. Revisit when Turbopack grows the mapping.
     */
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
};

export default nextConfig;
