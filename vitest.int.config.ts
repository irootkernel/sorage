import { defineConfig } from "vitest/config";

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
    name: "int",
    include: ["**/test/int/**/*.test.ts"],
    // One real event-loop turn per test keeps the worker's RPC transport
    // acknowledged through long synchronous suites (see the setup file).
    setupFiles: [
      fileURLToPath(
        new URL("./test/setup/cooperative-event-loop.ts", import.meta.url.replace(/vitest.[a-z]+.config.ts$/, "")),
      ),
    ],
    // Integration scenarios spawn processes, ram disks, and Git remotes; the
    // five-second vitest defaults starve them under full-suite parallelism.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
