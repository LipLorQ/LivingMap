import { describe, expect, it } from "vitest";
import {
  type ExecutionAction,
  type ExecutionStage,
  effectiveActionOrder,
  OWNER_ORDER_NOTE,
  ownerOrderRationale,
  selectProjectExecution,
  stageToFollowReorder,
} from "../src";

const NOW = "2026-10-06T10:00:00.000Z";
const stage = (id: string, position: number, isCurrent = false): ExecutionStage => ({ id, position, isCurrent });
const act = (
  id: string,
  stageId: string,
  position: number,
  status: ExecutionAction["status"] = "open",
): ExecutionAction => ({ id, stageId, position, status });
const run = (
  stages: ExecutionStage[],
  actions: ExecutionAction[],
  orderedActionIds: string[] | null,
): ReturnType<typeof selectProjectExecution> =>
  selectProjectExecution({ stages, actions, orderedActionIds, now: NOW, nextHardEventStart: null });

describe("selectProjectExecution — the owner's structure decides `Сейчас`", () => {
  it("the explicit current Stage wins over an older AI order that starts elsewhere", () => {
    const stages = [stage("new", 1, true), stage("old", 2)];
    const actions = [act("old1", "old", 1), act("new1", "new", 1), act("new2", "new", 2)];
    expect(run(stages, actions, ["old1"])).toMatchObject({ status: "selected", actionId: "new1", stageId: "new" });
  });

  it("inside a Stage: approved order first, hand-added Actions after by position, finished ones only explain", () => {
    const stages = [stage("s", 1, true)];
    const actions = [act("hand", "s", 1), act("a", "s", 2), act("b", "s", 3), act("gone", "s", 4, "done")];
    expect(run(stages, actions, ["b", "a"])).toMatchObject({ actionId: "b", reason: { kind: "previous-done" } });
    expect(run(stages, [act("hand", "s", 1), act("a", "s", 2)], ["a"])).toMatchObject({ actionId: "a" });
  });

  it("a current Stage with nothing usable is reported, never replaced by another Stage's Action", () => {
    const stages = [stage("empty", 1, true), stage("old", 2)];
    expect(run(stages, [act("old1", "old", 1)], ["old1"])).toEqual({ status: "stage-empty", stageId: "empty" });
    expect(run(stages, [act("old1", "old", 1), act("blocked", "empty", 1, "blocked")], ["old1"])).toEqual({
      status: "stage-empty",
      stageId: "empty",
    });
  });

  it("a really finished Stage hands over to the next one in the owner's Stage order, wrapping round", () => {
    const stages = [stage("first", 1), stage("last", 2, true)];
    const actions = [act("l1", "last", 1, "done"), act("f1", "first", 1)];
    expect(run(stages, actions, ["f1"])).toMatchObject({ status: "selected", actionId: "f1", stageId: "first" });
  });

  it("without a current Stage the Stage order is followed; without a route it is NeedsAIReplan", () => {
    const stages = [stage("b", 2), stage("a", 1)];
    const actions = [act("a1", "a", 1), act("b1", "b", 1)];
    expect(run(stages, actions, ["b1", "a1"])).toMatchObject({ actionId: "a1" });
    expect(run(stages, actions, null)).toEqual({ status: "needs-ai-replan" });
    expect(run(stages, [act("a1", "a", 1, "done")], [])).toEqual({ status: "needs-ai-replan" });
  });
});

describe("stageToFollowReorder", () => {
  const none = new Set<string>();
  it("an unfinished Stage moved above the current one becomes current", () => {
    expect(stageToFollowReorder({ before: ["a", "b"], after: ["b", "a"], currentId: "a", withoutWork: none })).toBe(
      "b",
    );
  });
  it("reorders that do not cross the current Stage change nothing", () => {
    expect(
      stageToFollowReorder({ before: ["a", "b", "c"], after: ["a", "c", "b"], currentId: "a", withoutWork: none }),
    ).toBe(null);
    expect(
      stageToFollowReorder({ before: ["a", "b", "c"], after: ["c", "b", "a"], currentId: "b", withoutWork: none }),
    ).toBe("c");
    expect(
      stageToFollowReorder({ before: ["a", "b", "c"], after: ["b", "a", "c"], currentId: "c", withoutWork: none }),
    ).toBe(null);
  });
  it("a finished Stage is skipped; no current Stage means no move", () => {
    expect(
      stageToFollowReorder({ before: ["a", "b"], after: ["b", "a"], currentId: "a", withoutWork: new Set(["b"]) }),
    ).toBeNull();
    expect(
      stageToFollowReorder({ before: ["a", "b"], after: ["b", "a"], currentId: null, withoutWork: none }),
    ).toBeNull();
  });
});

describe("effectiveActionOrder — the ONE order", () => {
  it("owner Stage order first; inside a Stage the stored order; hand-added Actions appended by position", () => {
    const stages = [stage("c", 1), stage("a", 2)];
    const actions = [act("a1", "a", 1), act("a2", "a", 2), act("c1", "c", 1), act("c2", "c", 2), act("hand", "c", 3)];
    // The stored (AI) order says A before C and a2 before a1: Stage order is hers, in-Stage order is the stored one.
    expect(effectiveActionOrder({ stages, actions, orderedActionIds: ["a2", "a1", "c2", "c1"] })).toEqual([
      "c2",
      "c1",
      "hand",
      "a2",
      "a1",
    ]);
  });

  it("finished Actions are not part of the order; no stored order falls back to positions", () => {
    const stages = [stage("s", 1)];
    const actions = [act("x", "s", 2), act("done", "s", 1, "done"), act("y", "s", 1)];
    expect(effectiveActionOrder({ stages, actions, orderedActionIds: null })).toEqual(["y", "x"]);
  });

  it("is what selectProjectExecution follows: its first Action is the selected one", () => {
    const stages = [stage("b", 1), stage("a", 2, true)];
    const actions = [act("a1", "a", 1), act("b1", "b", 1)];
    const order = effectiveActionOrder({ stages, actions, orderedActionIds: ["a1", "b1"] });
    expect(order[0]).toBe("b1");
    // an explicit current Stage still decides WHERE she is — the order only decides what follows
    expect(run(stages, actions, order)).toMatchObject({ actionId: "a1" });
  });
});

describe("ownerOrderRationale", () => {
  it("notes the takeover and keeps the AI's reasoning; stays stable on repeats", () => {
    const once = ownerOrderRationale("Сначала проверить с людьми");
    expect(once.startsWith(OWNER_ORDER_NOTE)).toBe(true);
    expect(once).toContain("Сначала проверить с людьми");
    expect(ownerOrderRationale(once)).toBe(once);
  });
});
