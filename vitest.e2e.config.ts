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
    name: "e2e",
    include: ["**/test/e2e/**/*.test.ts"],
    passWithNoTests: true,
    // Journeys drive the compiled binary, a daemon, and a real browser; the
    // five-second vitest default starves them under full-suite parallelism.
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
