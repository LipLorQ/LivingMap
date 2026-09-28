import { describe, expect, it } from "vitest";
import {
  type Action,
  applyRouteChange,
  createPlan,
  type Proposal,
  planningFingerprint,
  type RouteChange,
  replacePlanOrder,
  resolveProposal,
  type Stage,
  unplannedActionIds,
  validateActionOrder,
} from "../src";

const T0 = "2026-09-27T10:00:00.000Z";
const T1 = "2026-09-28T10:00:00.000Z";

const stage = (id: string, position: number, isCurrent = false): Stage => ({
  id,
  intentionId: "i1",
  title: `stage ${id}`,
  position,
  isCurrent,
  version: 1,
  createdAt: T0,
  updatedAt: T0,
});

const action = (id: string, stageId: string, position: number, status: Action["status"] = "open"): Action => ({
  id,
  stageId,
  title: `action ${id}`,
  doneWhen: "",
  position,
  status,
  blocker: status === "blocked" ? { reason: "waiting", blockedAt: T0 } : null,
  version: 1,
  createdAt: T0,
  updatedAt: T0,
  completedAt: status === "done" ? T0 : null,
});

describe("validateActionOrder", () => {
  const actions = [action("a1", "s1", 1), action("a2", "s1", 2, "blocked"), action("a3", "s1", 3, "done")];

  it("accepts exactly a permutation of the unfinished actions", () => {
    expect(validateActionOrder(["a2", "a1"], actions)).toEqual({ ok: true, value: ["a2", "a1"] });
  });

  it.each([
    [[], "at least one"],
    [["a1", "a1", "a2"], "duplicate"],
    [["a1", "a2", "zz"], "does not belong"],
    [["a1", "a2", "a3"], "already done"],
    [["a1"], "missing: a2"],
  ])("rejects %j", (order, reason) => {
    const r = validateActionOrder(order, actions);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain(reason);
  });
});

describe("OrderedActionPlan", () => {
  it("is created at version 1 and each new order bumps the version exactly once", () => {
    const created = createPlan({
      id: "p1",
      intentionId: "i1",
      orderedActionIds: ["a1"],
      rationale: " start small ",
      createdBy: "mcp-ai",
      sourceRevision: 7,
      now: T0,
    });
    if (!created.ok) throw new Error(created.reason);
    expect(created.value).toMatchObject({ version: 1, rationale: "start small", sourceRevision: 7 });

    const next = replacePlanOrder(
      created.value,
      { orderedActionIds: ["a2", "a1"], rationale: "unblock first", createdBy: "mcp-ai", sourceRevision: 9 },
      T1,
    );
    expect(next).toMatchObject({ ok: true, value: { version: 2, orderedActionIds: ["a2", "a1"], updatedAt: T1 } });
  });

  it("requires a rationale", () => {
    expect(
      createPlan({
        id: "p1",
        intentionId: "i1",
        orderedActionIds: ["a1"],
        rationale: "  ",
        createdBy: "mcp-ai",
        sourceRevision: 0,
        now: T0,
      }).ok,
    ).toBe(false);
  });

  it("reports unfinished actions the plan does not mention", () => {
    const actions = [action("a1", "s1", 1), action("a2", "s1", 2), action("a3", "s1", 3, "done")];
    const plan = createPlan({
      id: "p1",
      intentionId: "i1",
      orderedActionIds: ["a1"],
      rationale: "r",
      createdBy: "mcp-ai",
      sourceRevision: 0,
      now: T0,
    });
    if (!plan.ok) throw new Error(plan.reason);
    expect(unplannedActionIds(plan.value, actions)).toEqual(["a2"]);
    expect(unplannedActionIds(undefined, actions)).toEqual(["a1", "a2"]);
  });
});

describe("Proposal status transitions", () => {
  const pending: Proposal = {
    id: "pr1",
    kind: "route",
    status: "pending",
    createdBy: "mcp-ai",
    createdAt: T0,
    baseRevision: 3,
    baseFingerprint: "x",
    affectedEntityIds: [],
    payload: {},
    rationale: "because",
    resolvedAt: null,
    resolvedBy: null,
  };

  it.each(["accepted", "rejected", "stale"] as const)("pending → %s records who and when", (status) => {
    expect(resolveProposal(pending, status, "user-ui", T1)).toEqual({
      ok: true,
      value: { ...pending, status, resolvedAt: T1, resolvedBy: "user-ui" },
    });
  });

  it.each(["accepted", "rejected", "stale"] as const)("a %s proposal can never transition again", (from) => {
    for (const to of ["accepted", "rejected", "stale"] as const) {
      expect(resolveProposal({ ...pending, status: from }, to, "user-ui", T1).ok).toBe(false);
    }
  });

  it("fingerprint is order-independent and changes with any version", () => {
    const a = [
      { id: "x", version: 1 },
      { id: "y", version: 2 },
    ];
    expect(planningFingerprint(a)).toBe(planningFingerprint([...a].reverse()));
    expect(planningFingerprint(a)).not.toBe(planningFingerprint([a[0] as never, { id: "y", version: 3 }]));
    expect(planningFingerprint(a)).not.toBe(planningFingerprint([...a, { id: "z", version: 1 }]));
  });
});

describe("applyRouteChange", () => {
  const noChange: RouteChange = {
    newStages: [],
    stageEdits: [],
    newActions: [],
    actionEdits: [],
    stageOrder: null,
    orderedActionIds: [],
  };

  it("builds a first route on an empty Intention: first Stage becomes current, order covers new actions", () => {
    const r = applyRouteChange({
      intentionId: "i1",
      stages: [],
      actions: [],
      now: T1,
      change: {
        ...noChange,
        newStages: [
          { id: "s1", title: "Research" },
          { id: "s2", title: "Build" },
        ],
        newActions: [
          { id: "a1", stageId: "s1", title: "Interview 3 people", doneWhen: "3 notes written" },
          { id: "a2", stageId: "s2", title: "Prototype", doneWhen: "demo runs" },
          { id: "a3", stageId: "s1", title: "Summarize", doneWhen: "1 page" },
        ],
        orderedActionIds: ["a1", "a3", "a2"],
      },
    });
    if (!r.ok) throw new Error(r.reason);
    expect(r.value.stages.map((s) => [s.id, s.position, s.isCurrent])).toEqual([
      ["s1", 1, true],
      ["s2", 2, false],
    ]);
    expect(r.value.insertedActions.map((a) => [a.id, a.stageId, a.position])).toEqual([
      ["a1", "s1", 1],
      ["a2", "s2", 1],
      ["a3", "s1", 2],
    ]);
    expect(r.value.orderedActionIds).toEqual(["a1", "a3", "a2"]);
    expect(r.value.updatedStages).toEqual([]);
  });

  it("keeps the existing current Stage, edits, reorders Stages and bumps each changed entity once", () => {
    const r = applyRouteChange({
      intentionId: "i1",
      stages: [stage("s1", 1, true)],
      actions: [action("a1", "s1", 1), action("a0", "s1", 2, "done")],
      now: T1,
      change: {
        ...noChange,
        newStages: [{ id: "s0", title: "Before everything" }],
        stageEdits: [{ id: "s1", title: "Renamed" }],
        actionEdits: [{ id: "a1", title: "Sharper", doneWhen: "measurable" }],
        newActions: [{ id: "a2", stageId: "s0", title: "First", doneWhen: "done" }],
        stageOrder: ["s0", "s1"],
        orderedActionIds: ["a2", "a1"],
      },
    });
    if (!r.ok) throw new Error(r.reason);
    expect(r.value.stages.map((s) => [s.id, s.position, s.isCurrent, s.version])).toEqual([
      ["s0", 1, false, 1],
      ["s1", 2, true, 2],
    ]);
    expect(r.value.updatedStages.map((s) => s.title)).toEqual(["Renamed"]);
    expect(r.value.updatedActions).toMatchObject([{ id: "a1", title: "Sharper", doneWhen: "measurable", version: 2 }]);
  });

  it.each<[string, Partial<RouteChange>, string]>([
    ["foreign stage edit", { stageEdits: [{ id: "nope", title: "x" }] }, "does not belong"],
    ["foreign action edit", { actionEdits: [{ id: "nope", title: "x", doneWhen: "" }] }, "does not belong"],
    ["edit of a done action", { actionEdits: [{ id: "a0", title: "x", doneWhen: "" }] }, "completed"],
    [
      "new action in a foreign stage",
      { newActions: [{ id: "n1", stageId: "nope", title: "x", doneWhen: "" }] },
      "does not belong",
    ],
    ["new id colliding with existing", { newStages: [{ id: "s1", title: "x" }] }, "unique"],
    [
      "duplicate edits",
      {
        stageEdits: [
          { id: "s1", title: "x" },
          { id: "s1", title: "y" },
        ],
      },
      "more than once",
    ],
    ["stage order not a permutation", { stageOrder: ["s1", "s1"] }, "duplicates"],
    ["order missing an unfinished action", { orderedActionIds: [] }, "at least one"],
    ["order with a done action", { orderedActionIds: ["a1", "a0"] }, "already done"],
    ["empty title", { stageEdits: [{ id: "s1", title: "   " }] }, "empty"],
  ])("rejects %s", (_name, patch, reason) => {
    const r = applyRouteChange({
      intentionId: "i1",
      stages: [stage("s1", 1, true)],
      actions: [action("a1", "s1", 1), action("a0", "s1", 2, "done")],
      now: T1,
      change: { ...noChange, orderedActionIds: ["a1"], ...patch },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain(reason);
  });
});
