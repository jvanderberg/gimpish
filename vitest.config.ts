import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/core/test/**/*.test.ts", "packages/cli/test/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
