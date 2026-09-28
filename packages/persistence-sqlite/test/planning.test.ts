import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Application, COMMAND_POLICY, createApplication } from "@living-map/application";
import type { CreateRouteProposalInput, Result } from "@living-map/contracts";
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
let file: string;
const opened: SqliteHandle[] = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "living-map-planning-"));
  file = databaseFile(home);
});
afterEach(() => {
  for (const h of opened.splice(0)) if (h.sqlite.open) h.close();
  rmSync(home, { recursive: true, force: true });
});

function track(h: SqliteHandle): SqliteHandle {
  opened.push(h);
  return h;
}
const appOn = (h: SqliteHandle): Application =>
  createApplication({ store: createSqliteStore(h, uuidGenerator), clock: systemClock, ids: uuidGenerator });

function unwrap<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
}

/** Desktop (migrating) + a separate MCP connection on the same file, like the two real processes. */
function openBoth() {
  const desktopHandle = track(openDesktopDatabase(file));
  const mcpOpen = openMcpDatabase(file);
  if (mcpOpen.status !== "ready") throw new Error(mcpOpen.status);
  const desktop = appOn(desktopHandle);
  const mcp = appOn(track(mcpOpen.handle));
  return {
    desktop,
    mcp,
    handle: desktopHandle,
    ui: () => desktop.newContext("user-ui", "test"),
    ai: () => mcp.newContext("mcp-ai", "test"),
  };
}

/** A Stage-2-shaped real Intention: one Stage, one open and one done Action. */
function seedIntention(app: Application) {
  const ui = () => app.newContext("user-ui", "test");
  unwrap(app.commands.createSeason(ui(), { focus: "Rebuild momentum" }));
  unwrap(app.commands.addGoodLifeCondition(ui(), { text: "Sleep 8 hours" }));
  const intention = unwrap(app.commands.createIntention(ui(), { title: "Ship MVP", desiredResult: "Used daily" }));
  const stage = unwrap(app.commands.addStage(ui(), { intentionId: intention.id, title: "Foundation" }));
  const open = unwrap(app.commands.addAction(ui(), { stageId: stage.id, title: "Model domain", doneWhen: "tests" }));
  const done = unwrap(app.commands.addAction(ui(), { stageId: stage.id, title: "Pick stack", doneWhen: "ADR" }));
  unwrap(app.commands.completeAction(ui(), { id: done.id, expectedVersion: done.version }));
  return { intention, stage, open, done };
}

function routeInput(app: Application, seed: ReturnType<typeof seedIntention>): CreateRouteProposalInput {
  return {
    intentionId: seed.intention.id,
    expectedRevision: unwrap(app.queries.getStateRevision()).stateRevision,
    rationale: "Validate with real users before polishing",
    newStages: [{ ref: "validate", title: "Validation" }],
    stageEdits: [{ stageId: seed.stage.id, title: "Foundation (core)" }],
    newActions: [
      { ref: "interview", stage: "validate", title: "Interview 3 users", doneWhen: "3 notes" },
      { ref: "fix", stage: seed.stage.id, title: "Fix top friction", doneWhen: "friction log empty" },
    ],
    actionEdits: [{ actionId: seed.open.id, title: "Model the domain", doneWhen: "all tests green" }],
    stageOrder: ["validate", seed.stage.id],
    actionOrder: ["interview", seed.open.id, "fix"],
  };
}

const count = (h: SqliteHandle, table: string) =>
  (h.sqlite.prepare(`select count(*) n from ${table}`).get() as { n: number }).n;

describe("migration from the completed Stage 2 schema", () => {
  it("adds plans/proposals, keeps every Stage-2 row, backs up first, and invents no AI order", () => {
    // A real Stage-2 database: the first four real migrations (schema v4) plus user data.
    const legacy = new Database(file);
    legacy.pragma("journal_mode = WAL");
    applyMigrations(legacy, MIGRATIONS.slice(0, 4));
    legacy.close();
    {
      // Write the data through the Stage-2 code paths that are still unchanged, on a v4 store.
      const v4 = new Database(file);
      v4.exec(`
        INSERT INTO season VALUES ('00000000-0000-4000-8000-000000000001','Focus',1,'2026-09-27T10:00:00.000Z','2026-09-27T10:00:00.000Z');
        INSERT INTO good_life_conditions VALUES ('00000000-0000-4000-8000-000000000002','Sleep',1,1,'2026-09-27T10:00:00.000Z','2026-09-27T10:00:00.000Z');
        INSERT INTO intentions VALUES ('00000000-0000-4000-8000-000000000003','Ship','Used daily',1,'2026-09-27T10:00:00.000Z','2026-09-27T10:00:00.000Z');
        INSERT INTO stages VALUES ('00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000003','Foundation',1,1,1,'2026-09-27T10:00:00.000Z','2026-09-27T10:00:00.000Z');
        INSERT INTO actions VALUES ('00000000-0000-4000-8000-000000000005','00000000-0000-4000-8000-000000000004','A','',2,'open',NULL,NULL,NULL,1,'2026-09-27T10:00:00.000Z','2026-09-27T10:00:00.000Z');
        INSERT INTO actions VALUES ('00000000-0000-4000-8000-000000000006','00000000-0000-4000-8000-000000000004','B','',1,'done',NULL,NULL,'2026-09-27T10:00:00.000Z',2,'2026-09-27T10:00:00.000Z','2026-09-27T10:00:00.000Z');
        UPDATE meta SET state_revision = 19;
      `);
      v4.close();
    }

    const h = track(openDesktopDatabase(file));
    expect(h.sqlite.pragma("user_version", { simple: true })).toBe(EXPECTED_SCHEMA_VERSION);
    expect(readdirSync(backupsDir(home)).some((f) => f.includes("schema-v4"))).toBe(true);
    const app = appOn(h);
    const view = unwrap(app.queries.getCurrentView());
    expect(view.season?.focus).toBe("Focus");
    expect(view.goodLifeConditions.map((c) => c.text)).toEqual(["Sleep"]);
    expect(view.intention?.title).toBe("Ship");
    expect(view.stages[0]?.actions.map((a) => [a.title, a.status, a.position])).toEqual([
      ["B", "done", 1],
      ["A", "open", 2],
    ]);
    // The user's manual Stage-2 order is not reinterpreted as an AI decision.
    expect(view.orderedActionPlan).toBeNull();
    expect(view.pendingProposals).toEqual([]);
    expect(unwrap(app.queries.getStateRevision()).stateRevision).toBe(19);
  });
});

describe("capability classes", () => {
  it("mcp-ai may only create proposals and run the whitelisted safe reorder", () => {
    const aiCommands = Object.entries(COMMAND_POLICY)
      .filter(([, actors]) => (actors as readonly string[]).includes("mcp-ai"))
      .map(([name]) => name)
      .sort();
    expect(aiCommands).toEqual(["plan.reorder", "proposal.create"]);
  });

  it("mcp-ai cannot accept/reject proposals or write the domain directly", () => {
    const { desktop, mcp, ai } = openBoth();
    const seed = seedIntention(desktop);
    const proposal = unwrap(mcp.commands.createRouteProposal(ai(), routeInput(mcp, seed)));
    const before = unwrap(desktop.queries.getStateRevision());

    const denied = [
      mcp.commands.acceptProposal(ai(), { id: proposal.id }),
      mcp.commands.rejectProposal(ai(), { id: proposal.id }),
      mcp.commands.addStage(ai(), { intentionId: seed.intention.id, title: "sneaky" }),
      mcp.commands.addAction(ai(), { stageId: seed.stage.id, title: "sneaky", doneWhen: "" }),
      mcp.commands.updateIntention(ai(), {
        id: seed.intention.id,
        expectedVersion: seed.intention.version,
        title: "x",
        desiredResult: "y",
      }),
      mcp.commands.updateSeasonFocus(ai(), { expectedVersion: 1, focus: "x" }),
      mcp.commands.addGoodLifeCondition(ai(), { text: "x" }),
      mcp.commands.completeAction(ai(), { id: seed.open.id, expectedVersion: seed.open.version }),
    ];
    for (const r of denied) expect(r).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
    expect(unwrap(desktop.queries.getStateRevision())).toEqual(before);
    expect(unwrap(desktop.queries.getCurrentView()).pendingProposals[0]?.status).toBe("pending");
  });

  it("user-ui cannot create proposals or run the AI reorder", () => {
    const { desktop, ui } = openBoth();
    const seed = seedIntention(desktop);
    expect(desktop.commands.createRouteProposal(ui(), routeInput(desktop, seed))).toMatchObject({
      ok: false,
      error: { code: "PERMISSION_DENIED" },
    });
  });
});

describe("route proposal lifecycle (desktop + MCP connections)", () => {
  it("creation validates by dry run and changes no strategic state", () => {
    const { desktop, mcp, ai, handle } = openBoth();
    const seed = seedIntention(desktop);
    const viewBefore = unwrap(desktop.queries.getCurrentView());
    const revBefore = unwrap(desktop.queries.getStateRevision()).stateRevision;

    const proposal = unwrap(mcp.commands.createRouteProposal(ai(), routeInput(mcp, seed)));
    expect(proposal).toMatchObject({ kind: "route", status: "pending", createdBy: "mcp-ai", baseRevision: revBefore });
    if (proposal.kind !== "route") throw new Error("kind");
    expect(proposal.payload.isFirstRoute).toBe(true);

    // Exact consequences, produced by the same domain function acceptance uses.
    expect(proposal.preview?.stages.map((s) => [s.title, s.previousTitle, s.isNew, s.isCurrent])).toEqual([
      ["Validation", null, true, false],
      ["Foundation (core)", "Foundation", false, true],
    ]);
    expect(proposal.preview?.stages[1]?.actions.map((a) => [a.title, a.previousTitle, a.isNew, a.status])).toEqual([
      ["Model the domain", "Model domain", false, "open"],
      ["Pick stack", null, false, "done"],
      ["Fix top friction", null, true, "open"],
    ]);
    expect(proposal.preview?.order.map((o) => o.title)).toEqual([
      "Interview 3 users",
      "Model the domain",
      "Fix top friction",
    ]);

    const viewAfter = unwrap(desktop.queries.getCurrentView());
    expect(viewAfter.stages).toEqual(viewBefore.stages);
    expect(viewAfter.intention).toEqual(viewBefore.intention);
    expect(viewAfter.orderedActionPlan).toBeNull();
    expect(viewAfter.pendingProposals.map((p) => p.id)).toEqual([proposal.id]);
    // Desktop notices through the revision watch: one bump, attributed to mcp-ai.
    expect(unwrap(desktop.queries.getStateRevision()).stateRevision).toBe(revBefore + 1);
    expect(
      handle.sqlite.prepare("select actor, command_type from change_log where state_revision = ?").all(revBefore + 1),
    ).toEqual([{ actor: "mcp-ai", command_type: "proposal.create" }]);
  });

  it.each<
    [string, (seed: ReturnType<typeof seedIntention>, input: CreateRouteProposalInput) => CreateRouteProposalInput]
  >([
    ["duplicate action in order", (_s, i) => ({ ...i, actionOrder: [...i.actionOrder, "interview"] })],
    [
      "foreign action in order",
      (_s, i) => ({ ...i, actionOrder: [...i.actionOrder, "00000000-0000-4000-8000-00000000ffff"] }),
    ],
    ["done action in order", (s, i) => ({ ...i, actionOrder: [...i.actionOrder, s.done.id] })],
    ["unfinished action missing", (_s, i) => ({ ...i, actionOrder: ["interview", "fix"] })],
    ["edit of a done action", (s, i) => ({ ...i, actionEdits: [{ actionId: s.done.id, title: "x", doneWhen: "" }] })],
    ["unknown stage", (_s, i) => ({ ...i, newActions: [{ ref: "z", stage: "nowhere", title: "x", doneWhen: "" }] })],
    ["duplicate ref", (_s, i) => ({ ...i, newStages: [...i.newStages, { ref: "interview", title: "dup" }] })],
  ])("rejects a malformed route: %s", (_name, mutate) => {
    const { desktop, mcp, ai } = openBoth();
    const seed = seedIntention(desktop);
    const rev = unwrap(desktop.queries.getStateRevision());
    expect(mcp.commands.createRouteProposal(ai(), mutate(seed, routeInput(mcp, seed)))).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_ERROR" },
    });
    expect(unwrap(desktop.queries.getStateRevision())).toEqual(rev);
  });

  it("refuses a proposal reasoned on an outdated revision", () => {
    const { desktop, mcp, ai } = openBoth();
    const seed = seedIntention(desktop);
    const input = routeInput(mcp, seed);
    unwrap(desktop.commands.addGoodLifeCondition(desktop.newContext("user-ui", "test"), { text: "Evenings free" }));
    expect(mcp.commands.createRouteProposal(ai(), input)).toMatchObject({
      ok: false,
      error: { code: "CONFLICT_RELOAD" },
    });
  });

  it("acceptance applies everything atomically with exactly one revision bump; MCP sees the same state", () => {
    const { desktop, mcp, ui, ai, handle } = openBoth();
    const seed = seedIntention(desktop);
    const proposal = unwrap(mcp.commands.createRouteProposal(ai(), routeInput(mcp, seed)));
    if (proposal.kind !== "route" || !proposal.preview) throw new Error("preview");
    const rev = unwrap(desktop.queries.getStateRevision()).stateRevision;

    const accepted = unwrap(desktop.commands.acceptProposal(ui(), { id: proposal.id }));
    expect(accepted).toMatchObject({ status: "accepted", resolvedBy: "user-ui" });
    expect(unwrap(desktop.queries.getStateRevision()).stateRevision).toBe(rev + 1);

    const view = unwrap(mcp.queries.getPlanningContext());
    // What was previewed is exactly what now exists.
    expect(view.stages.map((s) => s.title)).toEqual(proposal.preview.stages.map((s) => s.title));
    expect(view.stages.map((s) => s.actions.map((a) => [a.title, a.doneWhen]))).toEqual(
      proposal.preview.stages.map((s) => s.actions.map((a) => [a.title, a.doneWhen])),
    );
    expect(view.orderedActionPlan).toMatchObject({
      version: 1,
      createdBy: "mcp-ai",
      sourceRevision: proposal.baseRevision,
      rationale: "Validate with real users before polishing",
      orderedActionIds: proposal.preview.order.map((o) => o.actionId),
    });
    expect(view.pendingProposals).toEqual([]);
    expect(view.unplannedActionIds).toEqual([]);
    expect(unwrap(desktop.queries.getCurrentView())).toEqual(unwrap(mcp.queries.getCurrentView()));

    const log = handle.sqlite
      .prepare("select actor, command_type, entity_type from change_log where state_revision = ? order by rowid")
      .all(rev + 1) as { actor: string; command_type: string; entity_type: string }[];
    expect(new Set(log.map((l) => `${l.actor}:${l.command_type}`))).toEqual(new Set(["user-ui:proposal.accept"]));
    expect(log.map((l) => l.entity_type)).toEqual(["stage", "stage", "action", "action", "action", "plan", "proposal"]);
    expect(view.recentHistory[0]).toMatchObject({ commandType: "proposal.accept", entityType: "proposal" });

    // Accepting twice is an illegal transition.
    expect(desktop.commands.acceptProposal(ui(), { id: proposal.id })).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_ERROR" },
    });
    expect(desktop.commands.rejectProposal(ui(), { id: proposal.id })).toMatchObject({ ok: false });
  });

  it("rejection records the decision and mutates no strategic state", () => {
    const { desktop, mcp, ui, ai } = openBoth();
    const seed = seedIntention(desktop);
    const proposal = unwrap(mcp.commands.createRouteProposal(ai(), routeInput(mcp, seed)));
    const before = unwrap(desktop.queries.getCurrentView());

    expect(unwrap(desktop.commands.rejectProposal(ui(), { id: proposal.id }))).toMatchObject({ status: "rejected" });
    const after = unwrap(desktop.queries.getCurrentView());
    expect(after.stages).toEqual(before.stages);
    expect(after.orderedActionPlan).toBeNull();
    expect(after.pendingProposals).toEqual([]);
    expect(unwrap(mcp.queries.getProposal({ id: proposal.id }))).toMatchObject({ status: "rejected" });
    expect(desktop.commands.acceptProposal(ui(), { id: proposal.id })).toMatchObject({ ok: false });
  });

  it("STALE: created at revision N, relevant state changes, acceptance cannot silently apply", () => {
    const { desktop, mcp, ui, ai } = openBoth();
    const seed = seedIntention(desktop);
    const proposal = unwrap(mcp.commands.createRouteProposal(ai(), routeInput(mcp, seed)));

    // The user edits the Action the AI reasoned about.
    unwrap(
      desktop.commands.editAction(ui(), {
        id: seed.open.id,
        expectedVersion: seed.open.version,
        title: "Something else",
        doneWhen: "x",
      }),
    );
    // Visible as stale before anyone tries to accept.
    expect(unwrap(desktop.queries.getCurrentView()).pendingProposals[0]).toMatchObject({
      status: "stale",
      preview: null,
    });
    const before = unwrap(desktop.queries.getCurrentView());

    expect(desktop.commands.acceptProposal(ui(), { id: proposal.id })).toMatchObject({
      ok: false,
      error: { code: "STALE_PROPOSAL" },
    });
    const after = unwrap(desktop.queries.getCurrentView());
    expect(after.stages).toEqual(before.stages);
    expect(after.orderedActionPlan).toBeNull();
    expect(after.pendingProposals).toEqual([]);
    expect(unwrap(mcp.queries.getProposal({ id: proposal.id }))).toMatchObject({ status: "stale" });
    expect(desktop.commands.acceptProposal(ui(), { id: proposal.id })).toMatchObject({
      ok: false,
      error: { code: "STALE_PROPOSAL" },
    });
  });

  it("accepting one proposal makes the other pending ones stale", () => {
    const { desktop, mcp, ui, ai } = openBoth();
    const seed = seedIntention(desktop);
    const first = unwrap(mcp.commands.createRouteProposal(ai(), routeInput(mcp, seed)));
    const second = unwrap(
      mcp.commands.proposeDesiredResultChange(ai(), {
        intentionId: seed.intention.id,
        expectedRevision: unwrap(mcp.queries.getStateRevision()).stateRevision,
        desiredResult: "Used daily for 7 days",
        rationale: "Measurable",
      }),
    );
    expect(unwrap(desktop.queries.getCurrentView()).pendingProposals.map((p) => p.status)).toEqual([
      "pending",
      "pending",
    ]);
    unwrap(desktop.commands.acceptProposal(ui(), { id: first.id }));
    expect(unwrap(desktop.queries.getCurrentView()).pendingProposals.map((p) => [p.id, p.status])).toEqual([
      [second.id, "stale"],
    ]);
  });

  it("a failure mid-application rolls back every write (no half-applied route)", () => {
    const { desktop, mcp, ui, ai, handle } = openBoth();
    const seed = seedIntention(desktop);
    const proposal = unwrap(mcp.commands.createRouteProposal(ai(), routeInput(mcp, seed)));
    const tables = ["stages", "actions", "ordered_action_plans", "change_log"];
    const before = tables.map((t) => count(handle, t));
    const rev = unwrap(desktop.queries.getStateRevision());

    // Stages get inserted first; the Action insert then fails inside the same transaction.
    handle.sqlite.exec("CREATE TRIGGER boom BEFORE INSERT ON actions BEGIN SELECT RAISE(ABORT, 'boom'); END;");
    expect(desktop.commands.acceptProposal(ui(), { id: proposal.id })).toMatchObject({
      ok: false,
      error: { code: "STORAGE_ERROR" },
    });
    expect(tables.map((t) => count(handle, t))).toEqual(before);
    expect(unwrap(desktop.queries.getStateRevision())).toEqual(rev);
    expect(unwrap(desktop.queries.getProposal({ id: proposal.id }))).toMatchObject({ status: "pending" });

    handle.sqlite.exec("DROP TRIGGER boom");
    expect(unwrap(desktop.commands.acceptProposal(ui(), { id: proposal.id }))).toMatchObject({ status: "accepted" });
  });

  it("a malformed stored payload is never applied", () => {
    const { desktop, mcp, ui, ai, handle } = openBoth();
    const seed = seedIntention(desktop);
    const proposal = unwrap(mcp.commands.createRouteProposal(ai(), routeInput(mcp, seed)));
    handle.sqlite
      .prepare(
        "update proposals set payload = json_set(payload, '$.orderedActionIds', json('[\"not-a-uuid\"]')) where id = ?",
      )
      .run(proposal.id);
    const stagesBefore = count(handle, "stages");
    expect(desktop.commands.acceptProposal(ui(), { id: proposal.id })).toMatchObject({ ok: false });
    expect(count(handle, "stages")).toBe(stagesBefore);
    expect(count(handle, "ordered_action_plans")).toBe(0);
  });

  it("desired-result proposal: the change only happens on acceptance", () => {
    const { desktop, mcp, ui, ai } = openBoth();
    const seed = seedIntention(desktop);
    const proposal = unwrap(
      mcp.commands.proposeDesiredResultChange(ai(), {
        intentionId: seed.intention.id,
        expectedRevision: unwrap(mcp.queries.getStateRevision()).stateRevision,
        desiredResult: "  Used daily for 7 days  ",
        rationale: "Make it measurable",
      }),
    );
    expect(proposal).toMatchObject({
      kind: "desired_result",
      payload: { desiredResult: "Used daily for 7 days", previousDesiredResult: "Used daily" },
    });
    expect(unwrap(desktop.queries.getCurrentView()).intention?.desiredResult).toBe("Used daily");
    unwrap(desktop.commands.acceptProposal(ui(), { id: proposal.id }));
    expect(unwrap(desktop.queries.getCurrentView()).intention?.desiredResult).toBe("Used daily for 7 days");
  });
});

describe("SAFE WRITE: reorder_existing_actions", () => {
  function withApprovedRoute() {
    const both = openBoth();
    const seed = seedIntention(both.desktop);
    const proposal = unwrap(both.mcp.commands.createRouteProposal(both.ai(), routeInput(both.mcp, seed)));
    unwrap(both.desktop.commands.acceptProposal(both.ui(), { id: proposal.id }));
    const plan = unwrap(both.mcp.queries.getPlanningContext()).orderedActionPlan;
    if (!plan) throw new Error("plan");
    return { ...both, seed, plan };
  }

  it("is refused before any route was approved — the first order needs the user", () => {
    const { desktop, mcp, ai } = openBoth();
    const seed = seedIntention(desktop);
    expect(
      mcp.commands.reorderExistingActions(ai(), {
        intentionId: seed.intention.id,
        expectedPlanVersion: 1,
        orderedActionIds: [seed.open.id],
        rationale: "x",
      }),
    ).toMatchObject({ ok: false, error: { code: "REQUIRES_CONFIRMATION" } });
  });

  it("reorders only the plan: same Actions, untouched text/status/blockers, version bump, actor mcp-ai", () => {
    const { mcp, ai, plan, handle } = withApprovedRoute();
    const actionsBefore = handle.sqlite.prepare("select * from actions order by id").all();
    const reversed = [...plan.orderedActionIds].reverse();

    const next = unwrap(
      mcp.commands.reorderExistingActions(ai(), {
        intentionId: plan.intentionId,
        expectedPlanVersion: plan.version,
        orderedActionIds: reversed,
        rationale: "Fix friction first",
      }),
    );
    expect(next).toMatchObject({ version: 2, orderedActionIds: reversed, createdBy: "mcp-ai" });
    expect(handle.sqlite.prepare("select * from actions order by id").all()).toEqual(actionsBefore);
    expect(unwrap(mcp.queries.getPlanningContext()).recentHistory[0]).toMatchObject({
      actor: "mcp-ai",
      commandType: "plan.reorder",
    });
  });

  it.each<[string, (ids: string[], seed: ReturnType<typeof seedIntention>) => string[]]>([
    ["duplicate", (ids) => [...ids, ids[0] as string]],
    ["foreign id", (ids) => [...ids.slice(1), "00000000-0000-4000-8000-00000000ffff"]],
    ["missing action", (ids) => ids.slice(1)],
    ["done action", (ids, seed) => [...ids, seed.done.id]],
  ])("rejects %s without writing", (_name, mutate) => {
    const { mcp, ai, plan, seed, handle } = withApprovedRoute();
    const rev = unwrap(mcp.queries.getStateRevision());
    expect(
      mcp.commands.reorderExistingActions(ai(), {
        intentionId: plan.intentionId,
        expectedPlanVersion: plan.version,
        orderedActionIds: mutate([...plan.orderedActionIds], seed),
        rationale: "x",
      }),
    ).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
    expect(unwrap(mcp.queries.getStateRevision())).toEqual(rev);
    expect(count(handle, "ordered_action_plans")).toBe(1);
  });

  it("a stale plan version conflicts instead of overwriting", () => {
    const { mcp, ai, plan } = withApprovedRoute();
    const input = {
      intentionId: plan.intentionId,
      expectedPlanVersion: plan.version,
      orderedActionIds: [...plan.orderedActionIds],
      rationale: "first",
    };
    unwrap(mcp.commands.reorderExistingActions(ai(), input));
    expect(mcp.commands.reorderExistingActions(ai(), { ...input, rationale: "second" })).toMatchObject({
      ok: false,
      error: { code: "CONFLICT_RELOAD" },
    });
  });

  it("an Action the user adds after approval shows up as unplanned and can then be ordered safely", () => {
    const { desktop, mcp, ui, ai, seed, plan } = withApprovedRoute();
    const added = unwrap(desktop.commands.addAction(ui(), { stageId: seed.stage.id, title: "New", doneWhen: "" }));
    expect(unwrap(mcp.queries.getPlanningContext()).unplannedActionIds).toEqual([added.id]);
    unwrap(
      mcp.commands.reorderExistingActions(ai(), {
        intentionId: plan.intentionId,
        expectedPlanVersion: plan.version,
        orderedActionIds: [added.id, ...plan.orderedActionIds],
        rationale: "Include the user's new action first",
      }),
    );
    expect(unwrap(mcp.queries.getPlanningContext()).unplannedActionIds).toEqual([]);
  });
});
