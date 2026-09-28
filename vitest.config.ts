import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/*/test/**/*.test.ts",
      "apps/mcp/test/**/*.test.ts",
      "apps/desktop/test/**/*.test.ts",
      "tests/**/*.test.ts",
    ],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
