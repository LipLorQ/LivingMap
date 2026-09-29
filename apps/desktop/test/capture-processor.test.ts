import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AiRunInput,
  type AiRunner,
  type AiRunOutcome,
  type Application,
  createAiSurface,
  createApplication,
} from "@living-map/application";
import type { Result } from "@living-map/contracts";
import {
  createSqliteStore,
  databaseFile,
  openDesktopDatabase,
  openMcpDatabase,
  type SqliteHandle,
  systemClock,
  uuidGenerator,
} from "@living-map/persistence-sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCaptureProcessor } from "../src/main/ai/capture-processor";

let home: string;
let handle: SqliteHandle;
let app: Application;
const handles: SqliteHandle[] = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "living-map-processor-"));
  handle = openDesktopDatabase(databaseFile(home));
  app = appOn(handle);
});
afterEach(() => {
  for (const h of [handle, ...handles.splice(0)]) if (h.sqlite.open) h.close();
  rmSync(home, { recursive: true, force: true });
});

const appOn = (h: SqliteHandle) =>
  createApplication({ store: createSqliteStore(h, uuidGenerator), clock: systemClock, ids: uuidGenerator });
function unwrap<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
}
const submit = (rawText: string) => unwrap(app.commands.createCapture(app.newContext("user-ui", "test"), { rawText }));
const captures = () => unwrap(app.queries.listCaptures({ limit: 50 }));
const stateOf = (id: string) => captures().find((c) => c.id === id)?.state;
const ANSWER: AiRunOutcome = { ok: true, result: { kind: "answer", reply: "Отдохни.", proposalId: null } };

/** A scripted AiRunner that records what it saw when it was called. */
function fakeRunner(outcomes: AiRunOutcome[] | ((input: AiRunInput) => Promise<AiRunOutcome>)) {
  const calls: { input: AiRunInput; persistedStateAtCall: string | undefined }[] = [];
  const runner: AiRunner = {
    processCapture: async (input) => {
      // Seen from a *separate* connection, as the MCP process would: the Capture must already be committed.
      const other = openMcpDatabase(databaseFile(home));
      if (other.status !== "ready") throw new Error("db not ready");
      handles.push(other.handle);
      const row = other.handle.sqlite.prepare("select state from captures where id = ?").get(input.captureId) as
        | { state: string }
        | undefined;
      calls.push({ input, persistedStateAtCall: row?.state });
      if (typeof outcomes === "function") return outcomes(input);
      return outcomes.shift() ?? ANSWER;
    },
  };
  return { runner, calls };
}

describe("capture processor (single flight, save first)", () => {
  it("the Capture is committed before the AI runs; the result is recorded afterwards", async () => {
    const { runner, calls } = fakeRunner([ANSWER]);
    const p = createCaptureProcessor(app, runner);
    const c = submit("Что мне сейчас делать?");
    p.kick();
    await p.idle();
    expect(calls).toEqual([
      {
        input: { captureId: c.id, rawText: "Что мне сейчас делать?", createdAt: c.createdAt },
        persistedStateAtCall: "processing",
      },
    ]);
    expect(captures()[0]).toMatchObject({ state: "processed", result: { reply: "Отдохни." } });
  });

  it("repeated kicks (double Send) never process one Capture twice; later Captures are picked up by the same run", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { runner, calls } = fakeRunner(async () => {
      await gate;
      return ANSWER;
    });
    const p = createCaptureProcessor(app, runner);
    const a = submit("a");
    p.kick();
    p.kick();
    const b = submit("b");
    p.kick();
    release();
    await p.idle();
    expect(calls.map((c) => c.input.captureId)).toEqual([a.id, b.id]);
    expect(captures().map((c) => [c.rawText, c.state, c.attempts])).toEqual([
      ["b", "processed", 1],
      ["a", "processed", 1],
    ]);
  });

  it("B (Gate B): a retryable failure of one Capture never strands the ones behind it, and is not looped", async () => {
    const { runner, calls } = fakeRunner([{ ok: false, failure: "mcp_failed" }, ANSWER, ANSWER]);
    const reports: string[] = [];
    const p = createCaptureProcessor(app, runner, (m) => reports.push(m));
    const a = submit("a");
    const b = submit("b");
    const c = submit("c");
    p.kick();
    await p.idle();
    expect(calls.map((x) => x.input.captureId)).toEqual([a.id, b.id, c.id]); // each exactly once, in order
    expect([stateOf(a.id), stateOf(b.id), stateOf(c.id)]).toEqual(["failed", "processed", "processed"]);
    expect(reports).toEqual(["capture processing failed: mcp_failed"]); // a code, never user text
  });

  it("a malformed answer to one Capture does not block the next", async () => {
    const { runner } = fakeRunner([{ ok: false, failure: "malformed" }, ANSWER]);
    const p = createCaptureProcessor(app, runner);
    const a = submit("a");
    const b = submit("b");
    p.kick();
    await p.idle();
    expect([stateOf(a.id), stateOf(b.id)]).toEqual(["failed", "processed"]);
  });

  it("F: single flight — never two AI runs at once, however many Captures and kicks", async () => {
    let running = 0;
    let peak = 0;
    const { runner } = fakeRunner(async () => {
      peak = Math.max(peak, ++running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return { ok: false, failure: "offline" };
    });
    const p = createCaptureProcessor(app, runner);
    for (const t of ["a", "b", "c", "d"]) {
      submit(t);
      p.kick();
    }
    await p.idle();
    expect(peak).toBe(1);
    expect(captures().map((c) => c.state)).toEqual(["failed", "failed", "failed", "failed"]);
  });

  it("a throwing runner cannot leave a Capture stuck in processing", async () => {
    const p = createCaptureProcessor(app, {
      processCapture: () => Promise.reject(new Error("boom")),
    });
    const a = submit("a");
    p.kick();
    await p.idle();
    expect(captures().find((c) => c.id === a.id)).toMatchObject({ state: "failed", lastError: "failed" });
  });

  it("quit mid-run: nothing is written; the next launch recovers the Capture and processes it", async () => {
    const aborted: boolean[] = [];
    const first = createCaptureProcessor(app, {
      processCapture: (_input, signal) =>
        new Promise((resolve) =>
          signal.addEventListener("abort", () => {
            aborted.push(true);
            resolve({ ok: false, failure: "failed" });
          }),
        ),
    });
    const a = submit("мысль перед сбоем");
    first.kick();
    await new Promise((r) => setTimeout(r, 50));
    first.stop();
    await first.idle();
    expect(aborted).toEqual([true]);
    expect(stateOf(a.id)).toBe("processing"); // the app died mid-processing

    // Next launch (new processor on a reopened database).
    handle.close();
    handle = openDesktopDatabase(databaseFile(home));
    app = appOn(handle);
    const { runner, calls } = fakeRunner([ANSWER]);
    const second = createCaptureProcessor(app, runner);
    second.start();
    await second.idle();
    expect(calls.map((c) => c.input.rawText)).toEqual(["мысль перед сбоем"]);
    expect(captures()[0]).toMatchObject({ state: "processed", rawText: "мысль перед сбоем", attempts: 2 });
  });

  it("D: app restart recovers failed (retryable) and pending Captures and processes all of them", async () => {
    const offline: AiRunOutcome = { ok: false, failure: "offline" };
    const down = createCaptureProcessor(app, fakeRunner([offline, offline]).runner);
    const a = submit("a");
    const b = submit("b");
    down.kick();
    await down.idle();
    expect([stateOf(a.id), stateOf(b.id)]).toEqual(["failed", "failed"]);
    const c = submit("c"); // saved while nothing processes (e.g. quit right after)

    handle.close();
    handle = openDesktopDatabase(databaseFile(home));
    app = appOn(handle);
    const { runner, calls } = fakeRunner([ANSWER, ANSWER, ANSWER]);
    const up = createCaptureProcessor(app, runner);
    up.start();
    await up.idle();
    expect(calls.map((x) => x.input.captureId)).toEqual([a.id, b.id, c.id]);
    expect(captures().map((x) => x.state)).toEqual(["processed", "processed", "processed"]);
  });
});

describe("Capture → Proposal linkage (idempotent retry, Gate B)", () => {
  function seedIntention(): string {
    const ui = app.newContext("user-ui", "test");
    return unwrap(app.commands.createIntention(ui, { title: "Исполнятор", desiredResult: "Работает" })).id;
  }
  /** What the MCP child started for this Capture does (its context carries the Capture id). */
  const proposeFor = (captureId: string, intentionId: string) =>
    createAiSurface(app, captureId).createRouteProposal({
      intentionId,
      expectedRevision: unwrap(app.queries.getStateRevision()).stateRevision,
      summary: "План",
      rationale: "Потому что",
      newStages: [{ ref: "s1", title: "Этап" }],
      stageEdits: [],
      newActions: [{ ref: "a1", stage: "s1", title: "Шаг", doneWhen: "готово" }],
      actionEdits: [],
      actionOrder: ["a1"],
    });
  const pendingProposals = () => unwrap(app.queries.getPlanningContext()).pendingProposals.length;

  it("A/E: Proposal created, then the result is never recorded (crash): the retry makes no second Proposal, the link survives", async () => {
    const intentionId = seedIntention();
    const c = submit("Перестрой порядок, я закончила Исполнятор");
    let proposalId = "";
    const first = createCaptureProcessor(app, {
      processCapture: async (input, signal) => {
        proposalId = unwrap(proposeFor(input.captureId, intentionId)).id;
        return new Promise((resolve) =>
          signal.addEventListener("abort", () => resolve({ ok: false, failure: "failed" })),
        );
      },
    });
    first.kick();
    await vi.waitFor(() => expect(proposalId).not.toBe(""));
    first.stop(); // the app dies after the Proposal, before the bookkeeping
    await first.idle();
    expect(captures()[0]).toMatchObject({ state: "processing", proposalId });

    const { runner, calls } = fakeRunner([]);
    const second = createCaptureProcessor(app, runner);
    second.start();
    await second.idle();
    expect(calls).toHaveLength(0); // the strategic effect exists: the AI is not asked again
    expect(pendingProposals()).toBe(1);
    expect(captures()[0]).toMatchObject({
      id: c.id,
      state: "processed",
      proposalId,
      result: { kind: "proposal", proposalId },
    });
  });

  it("a timed-out run whose MCP child commits its Proposal late still links it: the retry makes no second one", () => {
    const intentionId = seedIntention();
    const c = submit("перестрой");
    const sys = app.newContext("system", "test");
    unwrap(app.commands.claimNextCapture(sys));
    unwrap(app.commands.finishCapture(sys, { id: c.id, outcome: { ok: false, failure: "timeout" } }));
    const late = unwrap(proposeFor(c.id, intentionId)); // the killed CLI's MCP grandchild finishes its write
    expect(captures()[0]).toMatchObject({ state: "failed", proposalId: late.id });
    expect(unwrap(proposeFor(c.id, intentionId)).id).toBe(late.id);
    expect(pendingProposals()).toBe(1);
  });

  it("A: the AI proposing again for the same Capture gets the existing Proposal back, not a duplicate", () => {
    const intentionId = seedIntention();
    const c = submit("перестрой");
    unwrap(app.commands.claimNextCapture(app.newContext("system", "test")));
    const one = unwrap(proposeFor(c.id, intentionId));
    const two = unwrap(proposeFor(c.id, intentionId));
    expect(two.id).toBe(one.id);
    expect(pendingProposals()).toBe(1);
  });

  it("C: a run reported failed although its Proposal exists ends processed and truthful after retry", async () => {
    const intentionId = seedIntention();
    const c = submit("Перестрой порядок");
    let proposalId = "";
    const p = createCaptureProcessor(app, {
      processCapture: async (input) => {
        proposalId = unwrap(proposeFor(input.captureId, intentionId)).id;
        return { ok: false, failure: "mcp_failed" }; // the Gate B contradiction
      },
    });
    p.kick();
    await p.idle();
    expect(captures()[0]).toMatchObject({ state: "failed", proposalId }); // the link is kept even so

    unwrap(app.commands.retryCapture(app.newContext("user-ui", "test"), { id: c.id })); // «Повторить»
    const { runner, calls } = fakeRunner([]);
    const again = createCaptureProcessor(app, runner);
    again.kick();
    await again.idle();
    expect(calls).toHaveLength(0);
    expect(captures()[0]).toMatchObject({ state: "processed", result: { kind: "proposal", proposalId } });
    expect(pendingProposals()).toBe(1);
  });

  it("a retried run cannot store a reworded duplicate memory; the memory is linked from the run's context", () => {
    const c = submit("Завтра в 10.40 барабаны до 12.10");
    const ai = createAiSurface(app, c.id);
    const save = (text: string) =>
      unwrap(ai.saveMemory({ type: "commitment", text, captureId: null, linkedEntityIds: [] }));
    const one = save("30 сентября, 10:40–12:10 — барабаны");
    const two = save("Барабаны 30 сентября с 10:40 до 12:10");
    expect(two.id).toBe(one.id);
    expect(one.sourceCaptureId).toBe(c.id);
    expect(captures()[0]?.memories).toHaveLength(1);
  });
});
