import { configDefaults, defineConfig } from "vitest/config";

import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "bun:sqlite": fileURLToPath(
        new URL("./test/aliases/bun-sqlite.ts", import.meta.url.replace(/vitest.[a-z]+.config.ts$/, "")),
      ),
    },
  },
  test: {
    name: "e2e",
    include: ["**/test/e2e/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "**/test/e2e/aj16-packaging.e2e.test.ts"],
    passWithNoTests: true,
    // One real event-loop turn per test keeps the worker's RPC transport
    // acknowledged through long synchronous journeys (see the setup file).
    setupFiles: [
      fileURLToPath(
        new URL("./test/setup/cooperative-event-loop.ts", import.meta.url.replace(/vitest.[a-z]+.config.ts$/, "")),
      ),
    ],
    // Journeys drive the compiled binary, a daemon, and a real browser; the
    // five-second vitest default starves them under full-suite parallelism.
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
