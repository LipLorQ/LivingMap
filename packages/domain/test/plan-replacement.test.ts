import { describe, expect, it } from "vitest";
import { type Action, completeAction, createAction, createStage, replaceProjectPlan, type Stage } from "../src";

const NOW = "2026-10-05T12:00:00.000Z";
let n = 0;
const nextId = () => `id-${++n}`;

function existing(): { stages: Stage[]; actions: Action[] } {
  const stage = createStage({
    id: "s-old",
    intentionId: "p",
    title: "Сгенерированный",
    position: 1,
    isCurrent: true,
    now: NOW,
  });
  if (!stage.ok) throw new Error(stage.reason);
  const make = (id: string, title: string) => {
    const a = createAction({ id, stageId: "s-old", title, doneWhen: "", position: 1, now: NOW });
    if (!a.ok) throw new Error(a.reason);
    return a.value;
  };
  const a1 = completeAction(make("a1", "A1"), NOW);
  if (!a1.ok) throw new Error(a1.reason);
  return { stages: [stage.value], actions: [a1.value, make("a2", "A2"), make("a3", "A3")] };
}

describe("replaceProjectPlan (owner-approved plan, Stage 9 Day 1)", () => {
  it("builds exactly the approved sequence and archives the whole previous structure", () => {
    const before = existing();
    const r = replaceProjectPlan({
      intentionId: "p",
      ...before,
      approved: [
        {
          title: "X",
          actions: [
            { title: "X1", doneWhen: "" },
            { title: "X2", doneWhen: "" },
          ],
        },
        { title: "Y", actions: [{ title: "Y1", doneWhen: "" }] },
      ],
      nextId,
      now: NOW,
    });
    if (!r.ok) throw new Error(r.reason);
    const title = (id: string) => r.value.insertedActions.find((a) => a.id === id)?.title;
    expect(r.value.orderedActionIds.map(title)).toEqual(["X1", "X2", "Y1"]);
    expect(r.value.stages.map((s) => [s.title, s.position, s.isCurrent])).toEqual([
      ["X", 1, true],
      ["Y", 2, false],
    ]);
    expect(r.value.archivedStageIds).toEqual(["s-old"]);
    expect(r.value.leftBehindActionIds).toEqual(["a2", "a3"]); // the finished A1 is history, not "left behind"
    expect(r.value.movedActions).toEqual([]);
  });

  it("carries existing actions by id: finished work keeps its words, unfinished takes the approved wording", () => {
    const before = existing();
    const r = replaceProjectPlan({
      intentionId: "p",
      ...before,
      approved: [
        {
          title: "X",
          actions: [
            { title: "другое", doneWhen: "", existingActionId: "a1" },
            { title: "A2 точнее", doneWhen: "видно", existingActionId: "a2" },
          ],
        },
      ],
      nextId,
      now: NOW,
    });
    if (!r.ok) throw new Error(r.reason);
    const [a1, a2] = r.value.movedActions;
    expect(a1).toMatchObject({ id: "a1", title: "A1", status: "done", position: 1, version: 3 });
    expect(a2).toMatchObject({
      id: "a2",
      title: "A2 точнее",
      doneWhen: "видно",
      status: "open",
      position: 2,
      version: 2,
    });
    expect(a1?.stageId).toBe(r.value.stages[0]?.id);
    expect(r.value.orderedActionIds).toEqual(["a2"]);
    expect(r.value.leftBehindActionIds).toEqual(["a3"]);
  });

  it("refuses what would not be a usable plan", () => {
    const before = existing();
    const attempt = (approved: Parameters<typeof replaceProjectPlan>[0]["approved"]) =>
      replaceProjectPlan({ intentionId: "p", ...before, approved, nextId, now: NOW });
    expect(attempt([])).toMatchObject({ ok: false });
    expect(attempt([{ title: "X", actions: [] }])).toMatchObject({ ok: false }); // nothing to do
    expect(attempt([{ title: "X", actions: [{ title: "a", doneWhen: "", existingActionId: "a1" }] }])).toMatchObject({
      ok: false, // only finished work — no unfinished action to show as `Сейчас`
    });
    expect(attempt([{ title: "X", actions: [{ title: "a", doneWhen: "", existingActionId: "nope" }] }])).toMatchObject({
      ok: false,
    });
    expect(
      attempt([
        {
          title: "X",
          actions: [
            { title: "a", doneWhen: "", existingActionId: "a2" },
            { title: "b", doneWhen: "", existingActionId: "a2" },
          ],
        },
      ]),
    ).toMatchObject({ ok: false });
    expect(attempt([{ title: " ", actions: [{ title: "a", doneWhen: "" }] }])).toMatchObject({ ok: false });
  });
});
