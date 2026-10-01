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
import { MCP_TOOL_NAMES, MCP_TOOLS } from "../src/server";

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
  it("exposes exactly the classified whitelist — no accept, direct domain write, SQL, file or policy tool", async () => {
    openDesktop();
    const client = await spawnMcp();
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([...MCP_TOOL_NAMES].sort());
    expect(
      Object.entries(MCP_TOOLS)
        .filter(([, c]) => c === "safe-write")
        .map(([n]) => n),
    ).toEqual(["reorder_existing_actions", "save_memory"]);
    for (const n of names) {
      expect(n).not.toMatch(
        /sql|exec|raw|shell|file|migrat|delete|policy|forget|accept|approve|confirm|reject|season|condition/i,
      );
    }

    for (const forbidden of [
      "execute_sql",
      "raw_query",
      "accept_proposal",
      "create_intention",
      "complete_action",
      "add_stage",
      "update_any_field",
    ]) {
      const r = await client.callTool({ name: forbidden, arguments: {} });
      expect(r.isError).toBe(true);
    }
  });

  it("Zod-validates every input at the boundary (unknown keys, bad ids)", async () => {
    openDesktop();
    const client = await spawnMcp();
    const extraKey = await call(client, "get_proposal", { id: "00000000-0000-4000-8000-000000000001", sql: "x" });
    expect(extraKey).toMatchObject({ ok: false });
    const badId = await call(client, "get_proposal", { id: "not-a-uuid" });
    expect(badId).toMatchObject({ ok: false });
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
    app.commands.updateSeasonFocus(app.newContext("user-ui", "test"), {
      expectedVersion: 1,
      focus: "y",
      startsNewSeason: false,
    });

    expect(await call(client, "get_state_revision")).toEqual({ ok: true, value: { stateRevision: 2 } });
  });
});

describe("Universal + and Memory over stdio (Stage 6)", () => {
  it("the AI reads a pending Capture, saves a memory from it (safe write, mcp-ai) and finds it again", async () => {
    const app = openDesktop();
    const created = app.commands.createCapture(app.newContext("user-ui", "test"), {
      rawText: "Я поняла, что больше не хочу жертвовать сном ради работы.",
    });
    if (!created.ok) throw new Error(created.error.message);
    const client = await spawnMcp();

    const pending = await call<{ id: string; rawText: string }[]>(client, "list_captures", { state: "pending" });
    expect(pending).toMatchObject({ ok: true, value: [{ id: created.value.id }] });

    const saved = await call<{ id: string; createdBy: string }>(client, "save_memory", {
      type: "preference",
      text: "Не жертвовать сном ради работы",
      captureId: created.value.id,
    });
    expect(saved).toMatchObject({ ok: true, value: { createdBy: "mcp-ai" } });
    expect(await call(client, "search_memory", { query: "сном" })).toMatchObject({
      ok: true,
      value: [{ text: "Не жертвовать сном ради работы", sourceCaptureId: created.value.id }],
    });
    // The Capture itself is untouched and still waits for the desktop's processor.
    expect(await call(client, "list_captures", {})).toMatchObject({
      ok: true,
      value: [{ state: "pending", rawText: "Я поняла, что больше не хочу жертвовать сном ради работы." }],
    });
    expect(await call(client, "save_memory", { type: "bogus", text: "x" })).toMatchObject({ ok: false });

    // Only the user forgets (desktop); MCP has no such tool and immediately stops returning it.
    expect(
      app.commands.forgetMemory(app.newContext("user-ui", "test"), { id: saved.ok ? saved.value.id : "" }),
    ).toMatchObject({ ok: true });
    expect(await call(client, "search_memory", { query: "сном" })).toEqual({ ok: true, value: [] });
    expect(await call(client, "list_captures", {})).toMatchObject({
      ok: true,
      value: [{ rawText: "Я поняла, что больше не хочу жертвовать сном ради работы.", memories: [] }],
    });
  });
});

describe("AI brain over stdio: read → propose → user decides in desktop", () => {
  it("an external MCP client reads the real planning context and can only propose; the desktop decides", async () => {
    const app = openDesktop();
    const ui = () => app.newContext("user-ui", "test");
    const unwrap = <T>(r: Result<T>): T => {
      if (!r.ok) throw new Error(r.error.message);
      return r.value;
    };
    unwrap(app.commands.createSeason(ui(), { focus: "Rebuild momentum" }));
    unwrap(app.commands.addGoodLifeCondition(ui(), { text: "Sleep 8 hours" }));
    const intention = unwrap(app.commands.createIntention(ui(), { title: "Ship MVP", desiredResult: "Used daily" }));
    const stage = unwrap(app.commands.addStage(ui(), { intentionId: intention.id, title: "Foundation" }));
    const action = unwrap(app.commands.addAction(ui(), { stageId: stage.id, title: "Model", doneWhen: "tests" }));
    unwrap(app.commands.blockAction(ui(), { id: action.id, expectedVersion: 1, reason: "waiting on review" }));

    const client = await spawnMcp();
    type Ctx = {
      stateRevision: number;
      meanings: Record<string, string>;
      season: { focus: string };
      goodLifeConditions: { text: string }[];
      intention: { id: string; desiredResult: string };
      stages: { actions: { status: string; blocker: { reason: string } | null }[] }[];
      orderedActionPlan: unknown;
    };
    const ctx = unwrap(await call<Ctx>(client, "get_living_map_context"));
    expect(ctx.season.focus).toBe("Rebuild momentum");
    expect(ctx.goodLifeConditions.map((c) => c.text)).toEqual(["Sleep 8 hours"]);
    expect(ctx.meanings.goodLifeConditions).toContain("Чем ты не хочешь жертвовать ради целей?");
    expect(ctx.meanings.desiredResult).toContain("must become true");
    expect(ctx.intention.desiredResult).toBe("Used daily");
    expect(ctx.stages[0]?.actions[0]).toMatchObject({ status: "blocked", blocker: { reason: "waiting on review" } });
    expect(ctx.orderedActionPlan).toBeNull();

    // No safe reorder before an approved route.
    expect(
      await call(client, "reorder_existing_actions", {
        intentionId: intention.id,
        expectedRevision: ctx.stateRevision,
        expectedPlanVersion: 1,
        orderedActionIds: [action.id],
        rationale: "x",
      }),
    ).toMatchObject({ ok: false, error: { code: "REQUIRES_CONFIRMATION" } });

    const proposal = unwrap(
      await call<{ id: string; status: string }>(client, "create_route_proposal", {
        intentionId: intention.id,
        expectedRevision: ctx.stateRevision,
        summary: "Unblock review first",
        rationale: "Unblock review first",
        newActions: [{ ref: "ask", stage: stage.id, title: "Ask for review", doneWhen: "reviewer replied" }],
        actionOrder: ["ask", action.id],
      }),
    );
    expect(proposal.status).toBe("pending");

    // Desktop sees it (revision moved), nothing applied yet.
    const view = unwrap(app.queries.getCurrentView());
    expect(view.pendingProposals.map((p) => p.id)).toEqual([proposal.id]);
    expect(view.stages[0]?.actions).toHaveLength(1);

    unwrap(app.commands.acceptProposal(ui(), { id: proposal.id }));
    expect(await call(client, "get_proposal", { id: proposal.id })).toMatchObject({
      ok: true,
      value: { status: "accepted", resolvedBy: "user-ui" },
    });
    const after = unwrap(
      await call<Ctx & { orderedActionPlan: { orderedActionIds: string[] } }>(client, "get_living_map_context"),
    );
    expect(after.orderedActionPlan.orderedActionIds).toHaveLength(2);
    expect(after.orderedActionPlan.orderedActionIds[1]).toBe(action.id);
  });
});
