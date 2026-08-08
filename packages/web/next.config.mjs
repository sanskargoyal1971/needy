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
};

export default nextConfig;
