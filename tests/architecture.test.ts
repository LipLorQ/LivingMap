import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Enforces the dependency direction of ARCHITECTURE §6 on real source files.
const root = fileURLToPath(new URL("..", import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && /\.(ts|tsx)$/.test(e.name))
    .map((e) => join(e.parentPath, e.name));
}

function importsOf(file: string): string[] {
  const src = readFileSync(file, "utf8");
  const specifiers = [
    ...src.matchAll(
      /(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["']/g,
    ),
  ];
  return specifiers.map((m) => m[1] ?? m[2] ?? m[3] ?? "");
}

function violations(dir: string, forbidden: RegExp): string[] {
  return sourceFiles(dir).flatMap((f) =>
    importsOf(f)
      .filter((s) => forbidden.test(s))
      .map((s) => `${relative(root, f)} → ${s}`),
  );
}

const UI_OR_ELECTRON = /^(electron|react|react-dom)(\/|$)/;
const STORAGE = /^(drizzle-orm|better-sqlite3|node:sqlite|@libsql\/|@living-map\/persistence-sqlite)(\/|$)/;
const MCP_SDK = /^@modelcontextprotocol\//;

describe("dependency direction (ARCHITECTURE §6)", () => {
  it("domain imports nothing but itself (no Electron, React, Drizzle, SQLite, MCP, other layers)", () => {
    expect(violations("packages/domain/src", /^(?!\.)/)).toEqual([]);
  });

  it("application imports no Electron, React, Drizzle, SQLite or MCP SDK", () => {
    const forbidden = new RegExp(`${UI_OR_ELECTRON.source}|${STORAGE.source}|${MCP_SDK.source}`);
    expect(violations("packages/application/src", forbidden)).toEqual([]);
  });

  it("domain/application package manifests declare no forbidden dependencies", () => {
    const deps = (pkg: string) => {
      const json = JSON.parse(readFileSync(join(root, pkg, "package.json"), "utf8"));
      return Object.keys({ ...json.dependencies, ...json.peerDependencies });
    };
    expect(deps("packages/domain")).toEqual([]);
    expect(deps("packages/application").sort()).toEqual(["@living-map/contracts", "@living-map/domain"]);
  });

  it("contracts stay a leaf (only zod)", () => {
    expect(violations("packages/contracts/src", /^(?!\.|zod$)/)).toEqual([]);
  });

  it("renderer never touches SQLite, Node or Electron directly", () => {
    expect(violations("apps/desktop/src/renderer", new RegExp(`${STORAGE.source}|^node:|^electron`))).toEqual([]);
  });

  it("MCP app never imports SQL/Drizzle/SQLite driver — only the persistence adapter's composition API", () => {
    expect(violations("apps/mcp/src", /^(drizzle-orm|better-sqlite3|node:sqlite)(\/|$)/)).toEqual([]);
  });

  it("MCP app never touches migration/backup internals or the raw sqlite handle (ADR-0003)", () => {
    const forbidden = /\bapplyMigrations\b|\bcreateBackup\b|\brestoreBackup\b|\.sqlite\b/;
    const hits = sourceFiles("apps/mcp/src").filter((f) => forbidden.test(readFileSync(f, "utf8")));
    expect(hits.map((f) => relative(root, f))).toEqual([]);
  });
});
