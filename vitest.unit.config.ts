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
    name: "unit",
    include: ["**/test/unit/**/*.test.ts"],
  },
});
