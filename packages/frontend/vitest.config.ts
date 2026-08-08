import { defineConfig } from "vitest/config";

/**
 * Test config for @needy/frontend, kept SEPARATE from vite.config.ts on purpose.
 *
 * The repo has a known dual-vite situation: vitest hoists a newer vite to the workspace root
 * while this package pins vite 5 for the app build (which is why the app tsconfig only
 * `include`s "src", leaving both config files out of `tsc --noEmit`). We work with that rather
 * than against it — this file deliberately does NOT load @vitejs/plugin-react, because that
 * plugin is built against the app's vite 5 and would be handed the root's newer vite instance.
 * We don't need it: React Fast Refresh is a dev-server nicety, and vite's built-in esbuild
 * transform already handles .tsx via the tsconfig's `jsx: "react-jsx"`. So the app keeps its
 * pinned vite 5 + plugin, and the tests run on whatever vite vitest brought with it.
 */
export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    // jsdom + framer-motion + fake timers: generous enough for the reconnect/heartbeat cases
    // without letting a genuinely hung test sit forever.
    testTimeout: 10_000,
  },
});
