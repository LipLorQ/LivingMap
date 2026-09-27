import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Application, createApplication } from "@living-map/application";
import type { ProbeDto, Result } from "@living-map/contracts";
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

function createProbe(app: Application, title: string): ProbeDto {
  const r = app.commands.createProbe(app.newContext("user-ui", "test"), { title });
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

describe("MCP surface", () => {
  it("exposes exactly the whitelisted tools and no raw SQL / filesystem / shell tool", async () => {
    openDesktop();
    const client = await spawnMcp();
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([...MCP_TOOL_NAMES].sort());
    for (const n of names) expect(n).not.toMatch(/sql|exec|raw|shell|file|migrat|delete|policy/i);

    const unknown = await client.callTool({ name: "execute_sql", arguments: { sql: "select 1" } });
    expect(unknown.isError).toBe(true);
    const create = await client.callTool({ name: "create_probe", arguments: { title: "x" } });
    expect(create.isError).toBe(true);
  });

  it("validates tool input with the contract schema (unknown keys, missing expectedVersion)", async () => {
    const app = openDesktop();
    const probe = createProbe(app, "a");
    const client = await spawnMcp();
    expect(await call(client, "rename_probe", { id: probe.id, title: "b" })).toMatchObject({ ok: false });
    expect(
      await call(client, "rename_probe", { id: probe.id, title: "b", expectedVersion: 1, sql: "drop table probes" }),
    ).toMatchObject({ ok: false });
    expect(app.queries.getProbe({ id: probe.id })).toMatchObject({ value: { title: "a", version: 1 } });
  });

  it("a corrupted database file fails the tool call gracefully instead of crashing the MCP process", async () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(databaseFile(home), "not a valid sqlite file, just garbage bytes");

    const client = await spawnMcp();
    const result = await call(client, "list_probes");
    expect(result).toMatchObject({ ok: false });
    // The process is still alive and answers further calls (would hang/reject if it had crashed).
    expect(await call(client, "get_state_revision")).toMatchObject({ ok: false });
  });

  it("refuses to serve (SCHEMA_INCOMPATIBLE) without creating the DB, then recovers once desktop has run", async () => {
    const client = await spawnMcp();
    expect(await call(client, "list_probes")).toMatchObject({ ok: false, error: { code: "SCHEMA_INCOMPATIBLE" } });
    expect(existsSync(databaseFile(home))).toBe(false);

    const probe = createProbe(openDesktop(), "after desktop start");
    expect(await call(client, "list_probes")).toEqual({ ok: true, value: [probe] });
  });
});

describe("desktop + separate MCP process share one SQLite", () => {
  it("both processes read the same data and revision", async () => {
    const app = openDesktop();
    const probe = createProbe(app, "hello from desktop");
    const client = await spawnMcp();

    expect(await call<ProbeDto[]>(client, "list_probes")).toEqual({ ok: true, value: [probe] });
    expect(await call(client, "get_state_revision")).toEqual({ ok: true, value: { stateRevision: 1 } });
    expect(app.queries.listProbes()).toEqual({ ok: true, value: [probe] });
  });

  it("cross-process optimistic concurrency in both directions", async () => {
    const app = openDesktop();
    const { id } = createProbe(app, "v1");
    const client = await spawnMcp();

    // Both saw v1. MCP writes first → wins. Desktop's stale write → CONFLICT_RELOAD.
    expect(await call(client, "rename_probe", { id, expectedVersion: 1, title: "mcp" })).toMatchObject({
      ok: true,
      value: { version: 2 },
    });
    expect(
      app.commands.renameProbe(app.newContext("user-ui", "test"), { id, expectedVersion: 1, title: "ui" }),
    ).toMatchObject({
      ok: false,
      error: { code: "CONFLICT_RELOAD" },
    });

    // Desktop reloads (v2) and writes → wins. MCP's stale write → CONFLICT_RELOAD.
    expect(
      app.commands.renameProbe(app.newContext("user-ui", "test"), { id, expectedVersion: 2, title: "ui" }),
    ).toMatchObject({
      ok: true,
      value: { version: 3 },
    });
    expect(await call(client, "rename_probe", { id, expectedVersion: 2, title: "mcp stale" })).toMatchObject({
      ok: false,
      error: { code: "CONFLICT_RELOAD" },
    });

    expect(await call(client, "get_probe", { id })).toMatchObject({ ok: true, value: { title: "ui", version: 3 } });
    expect(app.queries.getStateRevision()).toEqual({ ok: true, value: { stateRevision: 3 } });
  });

  it("stress: desktop + 2 MCP processes hammer one aggregate — no stale overwrite, no lost update, no SQLITE_BUSY leak", async () => {
    const WRITES_PER_WRITER = 40;
    const app = openDesktop();
    const { id } = createProbe(app, "counter");
    const mcpA = await spawnMcp();
    const mcpB = await spawnMcp();
    const stats = { conflicts: 0, otherErrors: [] as string[], overwrites: [] as string[] };
    // A successful write must be based on exactly the version it read; anything else is a stale overwrite.
    const accept = (seenVersion: number, r: Result<ProbeDto>) => {
      if (r.ok && r.value.version !== seenVersion + 1) stats.overwrites.push(`v${seenVersion}→v${r.value.version}`);
    };

    async function mcpWriter(client: Client, tag: string) {
      for (let done = 0; done < WRITES_PER_WRITER; ) {
        const seen = await call<ProbeDto>(client, "get_probe", { id });
        if (!seen.ok) throw new Error(seen.error.code);
        const r = await call<ProbeDto>(client, "rename_probe", {
          id,
          expectedVersion: seen.value.version,
          title: `${tag}-${done}`,
        });
        accept(seen.value.version, r);
        if (r.ok) done++;
        else if (r.error.code === "CONFLICT_RELOAD") stats.conflicts++;
        else stats.otherErrors.push(r.error.code);
      }
    }

    async function desktopWriter() {
      for (let done = 0; done < WRITES_PER_WRITER; ) {
        const seen = app.queries.getProbe({ id });
        if (!seen.ok) throw new Error(seen.error.code);
        await new Promise((r) => setTimeout(r, Math.random() * 3)); // let the other processes interleave
        const r = app.commands.renameProbe(app.newContext("user-ui", "test"), {
          id,
          expectedVersion: seen.value.version,
          title: `ui-${done}`,
        });
        accept(seen.value.version, r);
        if (r.ok) done++;
        else if (r.error.code === "CONFLICT_RELOAD") stats.conflicts++;
        else stats.otherErrors.push(r.error.code);
      }
    }

    await Promise.all([mcpWriter(mcpA, "A"), mcpWriter(mcpB, "B"), desktopWriter()]);

    const total = 3 * WRITES_PER_WRITER;
    expect(stats.otherErrors).toEqual([]);
    expect(stats.overwrites).toEqual([]);
    expect(stats.conflicts).toBeGreaterThan(0); // the race window was actually exercised
    expect(app.queries.getProbe({ id })).toMatchObject({ ok: true, value: { version: 1 + total } });
    expect(app.queries.getStateRevision()).toEqual({ ok: true, value: { stateRevision: 1 + total } });
    const renames = desktopHandle?.sqlite
      .prepare("select count(*) as n from change_log where command_type = 'probe.rename'")
      .get() as { n: number };
    expect(renames.n).toBe(total);
    console.info(`[stress] ${total} successful writes, ${stats.conflicts} CONFLICT_RELOAD retries, 0 stale overwrites`);
  });
});
