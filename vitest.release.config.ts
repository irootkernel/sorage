import { configDefaults, defineConfig } from "vitest/config";
import e2e from "./vitest.e2e.config";

// Replace the selection arrays: mergeConfig concatenates them and would run
// ordinary journeys again or retain their AJ-16 exclusion.
export default defineConfig({
  ...e2e,
  test: {
    ...e2e.test,
    name: "release",
    include: ["**/test/e2e/aj16-packaging.e2e.test.ts"],
    exclude: [...configDefaults.exclude],
    passWithNoTests: false,
  },
});
