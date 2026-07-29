import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Socket.io + real timers: give the race/reconnect tests room to settle.
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
