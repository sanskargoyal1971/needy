/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",

  experimental: {
    // The monorepo root is two levels up; without this Next infers the workspace root from
    // the nearest lockfile and traces the wrong files into the standalone bundle. Lives under
    // `experimental` in Next 14 — top-level is the Next 15 spelling and is silently ignored
    // here (it warns as an unrecognized key rather than failing).
    outputFileTracingRoot: new URL("../../", import.meta.url).pathname,
  },

  eslint: {
    // Linting is owned by the root flat config (`npm run lint`), which already covers
    // packages/web/src. Running `next lint` here as well loads eslint 8 alongside the root's
    // eslint 9 and typescript-eslint 8, and the two resolve different copies of the same rule
    // modules — which fails as "Cannot read properties of undefined (reading
    // 'allowShortCircuit')". One linter, one config; the build does not need a second.
    ignoreDuringBuilds: true,
  },

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
     */
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
};

export default nextConfig;
