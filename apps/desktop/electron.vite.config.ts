import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

// Workspace packages are TypeScript sources and must be bundled; everything else in
// `dependencies` (notably the native better-sqlite3) stays external and is loaded at runtime.
const workspacePackages = [
  "@living-map/application",
  "@living-map/contracts",
  "@living-map/integrations-ical-calendar",
  "@living-map/persistence-sqlite",
];

export default defineConfig({
  main: {
    build: {
      externalizeDeps: { exclude: workspacePackages },
      // The MCP server ships with the desktop build (out/main/mcp.js): the in-app AI host starts it with
      // this Electron in Node mode (ADR-0007) — no tsx, no repo-relative source paths.
      rollupOptions: { input: { index: "src/main/index.ts", mcp: "../mcp/src/main.ts" } },
    },
  },
  preload: {
    build: {
      // Sandboxed preloads cannot use ESM or require() arbitrary modules: bundle everything into one CJS file.
      externalizeDeps: false,
      rollupOptions: { output: { format: "cjs", entryFileNames: "[name].cjs" } },
    },
  },
  renderer: {
    plugins: [react(), tailwindcss()],
  },
});
