import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "int",
    include: ["**/test/int/**/*.test.ts"],

  },
});
