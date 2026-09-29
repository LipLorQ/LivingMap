import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Application, createAiSurface, createApplication } from "@living-map/application";
import type { Result } from "@living-map/contracts";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  backupsDir,
  createSqliteStore,
  databaseFile,
  EXPECTED_SCHEMA_VERSION,
  openDesktopDatabase,
  openMcpDatabase,
  type SqliteHandle,
  systemClock,
  uuidGenerator,
} from "../src";
import { MIGRATIONS } from "../src/migrations.generated";

let home: string;
let handle: SqliteHandle;
let app: Application;
const extra: SqliteHandle[] = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "living-map-capture-"));
  root = home;
  handle = openDesktopDatabase(databaseFile(home));
  app = createApplication({ store: createSqliteStore(handle, uuidGenerator), clock: systemClock, ids: uuidGenerator });
});
let root: string;
afterEach(() => {
  for (const h of [handle, ...extra.splice(0)]) if (h.sqlite.open) h.close();
  rmSync(root, { recursive: true, force: true });
});

function unwrap<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
}
const ui = () => app.newContext("user-ui", "test");
const sys = () => app.newContext("system", "test");
const ai = () => app.newContext("mcp-ai", "test");
const capture = (text = "Завтра в 15:00 стоматолог") => unwrap(app.commands.createCapture(ui(), { rawText: text }));
const stored = (id: string) =>
  handle.sqlite.prepare("select raw_text, state, attempts, last_error, result from captures where id = ?").get(id) as {
    raw_text: string;
    state: string;
    attempts: number;
    last_error: string | null;
    result: string | null;
  };
const ANSWER = { kind: "answer", reply: "Сейчас — Исполнятор.", proposalId: null } as const;

describe("Capture: saved first", () => {
  it("commits the raw text exactly as typed, pending, with a history entry — no AI involved", () => {
    const c = capture("  Сырая мысль\nвторая строка ");
    expect(c).toMatchObject({ state: "pending", attempts: 0, rawText: "  Сырая мысль\nвторая строка ", result: null });
    // Visible to a separate connection (another process) immediately: it is committed.
    const other = openMcpDatabase(databaseFile(home));
    if (other.status !== "ready") throw new Error(other.status);
    extra.push(other.handle);
    expect(other.handle.sqlite.prepare("select raw_text from captures").get()).toEqual({
      raw_text: "  Сырая мысль\nвторая строка ",
    });
    expect(unwrap(app.queries.listChangeHistory({ limit: 5 })).map((e) => e.commandType)).toEqual(["capture.create"]);
  });

  it("rejects an empty capture without writing anything", () => {
    expect(app.commands.createCapture(ui(), { rawText: "   " })).toMatchObject({ ok: false });
    expect(unwrap(app.queries.getStateRevision()).stateRevision).toBe(0);
  });

  it("raw_text is immutable as a database fact", () => {
    const c = capture();
    expect(() => handle.sqlite.prepare("update captures set raw_text = 'overwritten' where id = ?").run(c.id)).toThrow(
      /immutable/,
    );
    expect(stored(c.id).raw_text).toBe("Завтра в 15:00 стоматолог");
  });
});

describe("Capture processing lifecycle", () => {
  it("claims oldest-first, one at a time; a claimed Capture is never claimed twice", () => {
    const first = capture("первая");
    const second = capture("вторая");
    expect(unwrap(app.commands.claimNextCapture(sys()))?.id).toBe(first.id);
    expect(unwrap(app.commands.claimNextCapture(sys()))?.id).toBe(second.id);
    expect(unwrap(app.commands.claimNextCapture(sys()))).toBeNull();
    expect(stored(first.id)).toMatchObject({ state: "processing", attempts: 1 });
  });

  it("records a validated result separately from the original; history shows it, bookkeeping is hidden", () => {
    const c = capture();
    unwrap(app.commands.claimNextCapture(sys()));
    const done = unwrap(app.commands.finishCapture(sys(), { id: c.id, outcome: { ok: true, result: ANSWER } }));
    expect(done).toMatchObject({ state: "processed", rawText: "Завтра в 15:00 стоматолог", result: ANSWER });
    expect(unwrap(app.queries.listChangeHistory({ limit: 10 })).map((e) => e.commandType)).toEqual([
      "capture.processed",
      "capture.create",
    ]);
    // Finishing again (a duplicate / stale processor) changes nothing.
    expect(app.commands.finishCapture(sys(), { id: c.id, outcome: { ok: true, result: ANSWER } })).toMatchObject({
      ok: false,
      error: { code: "CONFLICT_RELOAD" },
    });
  });

  it("a malformed AI result never lands: the Capture becomes failed/retryable, nothing else is written", () => {
    const c = capture();
    unwrap(app.commands.claimNextCapture(sys()));
    const bad = { kind: "delete_everything", reply: "", proposalId: "x" } as never;
    expect(unwrap(app.commands.finishCapture(sys(), { id: c.id, outcome: { ok: true, result: bad } }))).toMatchObject({
      state: "failed",
      lastError: "malformed",
      result: null,
    });
    expect(stored(c.id).result).toBeNull();
  });

  it("an AI failure keeps the Capture; «Повторить» makes it wait again", () => {
    const c = capture();
    unwrap(app.commands.claimNextCapture(sys()));
    unwrap(app.commands.finishCapture(sys(), { id: c.id, outcome: { ok: false, failure: "not_authenticated" } }));
    expect(stored(c.id)).toMatchObject({ state: "failed", last_error: "not_authenticated", raw_text: c.rawText });
    expect(unwrap(app.commands.retryCapture(ui(), { id: c.id }))).toMatchObject({ state: "pending" });
    // Retrying something that is not failed is refused.
    expect(app.commands.retryCapture(ui(), { id: c.id })).toMatchObject({
      ok: false,
      error: { code: "CONFLICT_RELOAD" },
    });
  });

  it("launch recovery: interrupted `processing` and non-exhausted `failed` wait again; exhausted ones stay failed", () => {
    const interrupted = capture("прерванная");
    const failed = capture("упавшая");
    const exhausted = capture("безнадёжная");
    const crashing = capture("роняет приложение при каждом запуске");
    for (let i = 0; i < 4; i++) unwrap(app.commands.claimNextCapture(sys()));
    handle.sqlite.prepare("update captures set attempts = 5 where id = ?").run(crashing.id);
    unwrap(app.commands.finishCapture(sys(), { id: failed.id, outcome: { ok: false, failure: "offline" } }));
    unwrap(app.commands.finishCapture(sys(), { id: exhausted.id, outcome: { ok: false, failure: "timeout" } }));
    handle.sqlite.prepare("update captures set attempts = 5 where id = ?").run(exhausted.id);

    expect(unwrap(app.commands.recoverCaptures(sys()))).toBe(3);
    expect(stored(crashing.id)).toMatchObject({ state: "failed", last_error: "failed" }); // not re-run forever
    expect(stored(interrupted.id).state).toBe("pending");
    expect(stored(failed.id).state).toBe("pending");
    expect(stored(exhausted.id).state).toBe("failed");
    expect(unwrap(app.commands.recoverCaptures(sys()))).toBe(0); // nothing left: no write, no revision bump
  });

  it("links only a real AI proposal; an invented id is dropped", () => {
    const c = capture();
    unwrap(app.commands.claimNextCapture(sys()));
    const fake = { kind: "proposal", reply: "Готово", proposalId: "00000000-0000-4000-8000-000000000099" } as const;
    expect(unwrap(app.commands.finishCapture(sys(), { id: c.id, outcome: { ok: true, result: fake } })).result).toEqual(
      {
        ...fake,
        proposalId: null,
      },
    );
  });

  it("only the desktop's own processor (system) may move Captures; mcp-ai can neither create nor resolve them", () => {
    const c = capture();
    expect(app.commands.createCapture(ai(), { rawText: "x" })).toMatchObject({
      ok: false,
      error: { code: "PERMISSION_DENIED" },
    });
    expect(app.commands.claimNextCapture(ai())).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
    expect(app.commands.claimNextCapture(ui())).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
    expect(app.commands.finishCapture(ai(), { id: c.id, outcome: { ok: true, result: ANSWER } })).toMatchObject({
      ok: false,
      error: { code: "PERMISSION_DENIED" },
    });
    expect(app.commands.retryCapture(ai(), { id: c.id })).toMatchObject({ ok: false });
    const surface = createAiSurface(app) as Record<string, unknown>;
    for (const name of ["createCapture", "claimNextCapture", "finishCapture", "retryCapture", "acceptProposal"]) {
      expect(surface[name]).toBeUndefined();
    }
  });
});

describe("Memory v1", () => {
  it("save (mcp-ai, safe write) → linked to its Capture → searchable; the same memory twice is a no-op", () => {
    const c = capture("Я не хочу превращать разработку в работу на весь день.");
    const input = {
      type: "preference" as const,
      text: "Не превращать разработку в работу на весь день",
      captureId: c.id,
      linkedEntityIds: [],
    };
    const saved = unwrap(app.commands.saveMemory(ai(), input));
    expect(saved).toMatchObject({ createdBy: "mcp-ai", sourceCaptureId: c.id });
    const revision = unwrap(app.queries.getStateRevision()).stateRevision;
    expect(unwrap(app.commands.saveMemory(ai(), input)).id).toBe(saved.id);
    expect(unwrap(app.queries.getStateRevision()).stateRevision).toBe(revision);

    expect(unwrap(app.queries.listCaptures({ limit: 5 }))[0]?.memories.map((m) => m.id)).toEqual([saved.id]);
    // A later, differently worded request finds the old constraint.
    expect(
      unwrap(app.queries.searchMemory({ query: "Помоги перестроить мой день", limit: 5 })).map((m) => m.id),
    ).toEqual([saved.id]);
    // The original Capture is untouched by the memory.
    expect(stored(c.id).raw_text).toBe("Я не хочу превращать разработку в работу на весь день.");
  });

  it("links must point at existing entities; filter by entity works", () => {
    const i = unwrap(app.commands.createIntention(ui(), { title: "Ship", desiredResult: "Used" }));
    expect(
      app.commands.saveMemory(ai(), {
        type: "fact",
        text: "x",
        captureId: null,
        linkedEntityIds: ["00000000-0000-4000-8000-000000000042"],
      }),
    ).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    const linked = unwrap(
      app.commands.saveMemory(ai(), {
        type: "decision",
        text: "Главный замысел — Ship",
        captureId: null,
        linkedEntityIds: [i.id],
      }),
    );
    unwrap(
      app.commands.saveMemory(ai(), {
        type: "idea",
        text: "Видео про дисциплину",
        captureId: null,
        linkedEntityIds: [],
      }),
    );
    expect(unwrap(app.queries.searchMemory({ query: "", entityId: i.id, limit: 10 })).map((m) => m.id)).toEqual([
      linked.id,
    ]);
  });

  it("the user forgets a memory: gone from search and its Capture, Capture text kept, others untouched, AI cannot", () => {
    const raw = "Я поняла, что больше не хочу жертвовать работой ради сна";
    const c = capture(raw);
    const unwanted = unwrap(
      app.commands.saveMemory(ai(), { type: "preference", text: raw, captureId: c.id, linkedEntityIds: [] }),
    );
    unwrap(app.commands.claimNextCapture(sys()));
    const reply = { kind: "memory", reply: `Запомнила: ${raw}`, proposalId: null } as const;
    unwrap(app.commands.finishCapture(sys(), { id: c.id, outcome: { ok: true, result: reply } }));
    const kept = unwrap(
      app.commands.saveMemory(ai(), { type: "idea", text: "Видео про сон", captureId: null, linkedEntityIds: [] }),
    );
    expect(app.commands.forgetMemory(ai(), { id: unwanted.id })).toMatchObject({
      ok: false,
      error: { code: "PERMISSION_DENIED" },
    });

    expect(unwrap(app.commands.forgetMemory(ui(), { id: unwanted.id }))).toBeNull();
    expect(app.commands.forgetMemory(ui(), { id: unwanted.id })).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    expect(unwrap(app.queries.searchMemory({ query: "", limit: 50 })).map((m) => m.id)).toEqual([kept.id]);
    expect(unwrap(app.queries.searchMemory({ query: "жертвовать работой", limit: 50 }))).toEqual([]);
    // The raw text stays; the old «Запомнила: …» reply no longer echoes the forgotten memory (UI and MCP).
    expect(unwrap(app.queries.listCaptures({ limit: 5 }))[0]).toMatchObject({
      id: c.id,
      rawText: raw,
      memories: [],
      result: { kind: "memory", reply: "Этого больше нет в памяти." },
    });
    expect(stored(c.id).raw_text).toBe(raw);
    expect(unwrap(app.queries.listChangeHistory({ limit: 1 }))[0]).toMatchObject({ commandType: "memory.forget" });
  });

  it("the user-ui actor has no memory write (only the AI or system)", () => {
    expect(
      app.commands.saveMemory(ui(), { type: "note", text: "x", captureId: null, linkedEntityIds: [] }),
    ).toMatchObject({
      ok: false,
      error: { code: "PERMISSION_DENIED" },
    });
  });
});

describe("migration from the completed Stage 5 schema", () => {
  it("adds captures/memories, keeps every Stage-5 row and the revision, backs up first", () => {
    handle.close();
    home = join(home, "stage5"); // a fresh data home holding a real v10 (Stage 5) database
    mkdirSync(home);
    const file = databaseFile(home);
    const stage5 = new Database(file);
    stage5.pragma("journal_mode = WAL");
    applyMigrations(stage5, MIGRATIONS.slice(0, 10));
    stage5.exec(`
      INSERT INTO season VALUES ('00000000-0000-4000-8000-000000000001','Focus',1,'2026-09-27T10:00:00.000Z','2026-09-27T10:00:00.000Z');
      INSERT INTO intentions VALUES ('00000000-0000-4000-8000-000000000003','Ship','Used daily',1,'2026-09-27T10:00:00.000Z','2026-09-27T10:00:00.000Z');
      INSERT INTO stages VALUES ('00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000003','Foundation',1,1,1,'2026-09-27T10:00:00.000Z','2026-09-27T10:00:00.000Z');
      INSERT INTO actions VALUES ('00000000-0000-4000-8000-000000000005','00000000-0000-4000-8000-000000000004','A','',1,'done',NULL,NULL,'2026-09-28T10:00:00.000Z',2,'2026-09-27T10:00:00.000Z','2026-09-28T10:00:00.000Z');
      INSERT INTO work_intervals VALUES ('00000000-0000-4000-8000-000000000006','00000000-0000-4000-8000-000000000005','2026-09-28T09:00:00.000Z','2026-09-28T10:00:00.000Z','2026-09-28T10:00:00.000Z','Asia/Jakarta');
      UPDATE settings SET daily_work_target_minutes = 300;
      UPDATE meta SET state_revision = 67;
    `);
    stage5.close();

    handle = openDesktopDatabase(file);
    expect(handle.sqlite.pragma("user_version", { simple: true })).toBe(EXPECTED_SCHEMA_VERSION);
    expect(readdirSync(backupsDir(home)).some((f) => f.includes("schema-v10"))).toBe(true);
    app = createApplication({
      store: createSqliteStore(handle, uuidGenerator),
      clock: systemClock,
      ids: uuidGenerator,
    });
    const view = unwrap(app.queries.getCurrentView());
    expect(view.season?.focus).toBe("Focus");
    expect(view.stages[0]?.actions.map((a) => a.status)).toEqual(["done"]);
    expect(view.execution.dailyWorkTargetMinutes).toBe(300);
    expect(unwrap(app.queries.getStateRevision()).stateRevision).toBe(67);
    expect(unwrap(app.queries.listCaptures({ limit: 5 }))).toEqual([]);
    capture("после миграции");
    expect(unwrap(app.queries.getStateRevision()).stateRevision).toBe(68);
  });
});
