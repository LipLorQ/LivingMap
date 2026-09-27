import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

// Workspace packages are TypeScript sources and must be bundled; everything else in
// `dependencies` (notably the native better-sqlite3) stays external and is loaded at runtime.
const workspacePackages = ["@living-map/application", "@living-map/contracts", "@living-map/persistence-sqlite"];

export default defineConfig({
  main: {
    build: { externalizeDeps: { exclude: workspacePackages } },
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
