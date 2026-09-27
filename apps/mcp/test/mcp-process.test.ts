import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Application, createApplication } from "@living-map/application";
import type { Result } from "@living-map/contracts";
import {
  createSqliteStore,
  databaseFile,
  openDesktopDatabase,
  type SqliteHandle,
  systemClock,
  uuidGenerator,
} from "@living-map/persistence-sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MCP_TOOL_NAMES } from "../src/server";

const mcpDir = fileURLToPath(new URL("..", import.meta.url));

let home: string;
let desktopHandle: SqliteHandle | undefined;
const clients: Client[] = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "living-map-mcp-"));
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  desktopHandle?.close();
  desktopHandle = undefined;
  rmSync(home, { recursive: true, force: true });
});

/** The "desktop side": same composition as Electron main (opens + migrates), in the test process. */
function openDesktop(): Application {
  desktopHandle = openDesktopDatabase(databaseFile(home));
  return createApplication({
    store: createSqliteStore(desktopHandle, uuidGenerator),
    clock: systemClock,
    ids: uuidGenerator,
  });
}

/** A separate OS process launched exactly like an MCP host would: node over stdio. */
async function spawnMcp(): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/main.ts"],
    cwd: mcpDir,
    env: { ...getDefaultEnvironment(), LIVING_MAP_HOME: home },
    stderr: "pipe",
  });
  const client = new Client({ name: "living-map-spike-test", version: "0" });
  await client.connect(transport);
  clients.push(client);
  return client;
}

async function call<T>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Result<T>> {
  const res = await client.callTool({ name, arguments: args });
  const first = (res.content as Array<{ type: string; text?: string }>)[0];
  if (first?.type !== "text" || first.text === undefined) throw new Error("unexpected tool result");
  try {
    return JSON.parse(first.text) as Result<T>;
  } catch {
    // SDK-level input validation failure: plain text error, not our envelope.
    return { ok: false, error: { code: "VALIDATION_ERROR", message: first.text } };
  }
}

describe("MCP surface", () => {
  it("exposes exactly the whitelisted (read-only) tools — no product-domain writes yet (this stage's prompt §2/§19)", async () => {
    openDesktop();
    const client = await spawnMcp();
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([...MCP_TOOL_NAMES].sort());
    for (const n of names) expect(n).not.toMatch(/sql|exec|raw|shell|file|migrat|delete|policy/i);

    const unknown = await client.callTool({ name: "execute_sql", arguments: { sql: "select 1" } });
    expect(unknown.isError).toBe(true);
    for (const forbidden of ["create_intention", "complete_action", "add_stage"]) {
      const r = await client.callTool({ name: forbidden, arguments: {} });
      expect(r.isError).toBe(true);
    }
  });

  it("a corrupted database file fails the tool call gracefully instead of crashing the MCP process", async () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(databaseFile(home), "not a valid sqlite file, just garbage bytes");

    const client = await spawnMcp();
    const result = await call(client, "get_state_revision");
    expect(result).toMatchObject({ ok: false });
    // The process is still alive and answers further calls (would hang/reject if it had crashed).
    expect(await call(client, "get_state_revision")).toMatchObject({ ok: false });
  });

  it("refuses to serve (SCHEMA_INCOMPATIBLE) without creating the DB, then recovers once desktop has run", async () => {
    const client = await spawnMcp();
    expect(await call(client, "get_state_revision")).toMatchObject({
      ok: false,
      error: { code: "SCHEMA_INCOMPATIBLE" },
    });
    expect(existsSync(databaseFile(home))).toBe(false);

    openDesktop();
    expect(await call(client, "get_state_revision")).toEqual({ ok: true, value: { stateRevision: 0 } });
  });
});

describe("desktop + separate MCP process share one SQLite", () => {
  it("both processes see the same state_revision after a desktop write to the real domain", async () => {
    const app = openDesktop();
    const created = app.commands.createSeason(app.newContext("user-ui", "test"), { focus: "hello from desktop" });
    if (!created.ok) throw new Error(created.error.message);
    const client = await spawnMcp();

    expect(await call(client, "get_state_revision")).toEqual({ ok: true, value: { stateRevision: 1 } });
    expect(app.queries.getStateRevision()).toEqual({ ok: true, value: { stateRevision: 1 } });
  });

  it("MCP observes further desktop writes without restarting", async () => {
    const app = openDesktop();
    const client = await spawnMcp();
    expect(await call(client, "get_state_revision")).toEqual({ ok: true, value: { stateRevision: 0 } });

    const created = app.commands.createSeason(app.newContext("user-ui", "test"), { focus: "x" });
    if (!created.ok) throw new Error(created.error.message);
    app.commands.updateSeasonFocus(app.newContext("user-ui", "test"), { expectedVersion: 1, focus: "y" });

    expect(await call(client, "get_state_revision")).toEqual({ ok: true, value: { stateRevision: 2 } });
  });
});
