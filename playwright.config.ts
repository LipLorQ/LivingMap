import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "apps/desktop/e2e",
  timeout: 60_000,
  workers: 1,
  reporter: "list",
});
