import type { CreateRouteProposalInput, IntentionDto, Result } from "@living-map/contracts";
import { describe, expect, it } from "vitest";
import { type Clock, COMMAND_POLICY, createApplication, isAllowed } from "../src";
import { memoryStore, sequentialIds } from "./fakes";

const clock: Clock = { now: () => "2026-10-02T10:00:00.000Z" };

function setup() {
  const store = memoryStore();
  const app = createApplication({ store, clock, ids: sequentialIds(), timeZone: () => "UTC" });
  const ui = () => app.newContext("user-ui", "test");
  const ai = () => app.newContext("mcp-ai", "test");
  return { store, app, ui, ai };
}
type Ctx = ReturnType<typeof setup>;

function unwrap<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
}

const view = (c: Ctx) => unwrap(c.app.queries.getCurrentView());
const revision = (c: Ctx) => unwrap(c.app.queries.getStateRevision()).stateRevision;

function project(c: Ctx, title: string): IntentionDto {
  return unwrap(c.app.commands.createIntention(c.ui(), { title, desiredResult: `${title} done` }));
}

/** A project with one stage and an approved order over `titles` (real first-route Proposal, accepted). */
function routedProject(c: Ctx, title: string, titles: string[]): { intention: IntentionDto; actionIds: string[] } {
  const intention = project(c, title);
  const refs = titles.map((_, i) => `a${i + 1}`);
  const input: CreateRouteProposalInput = {
    intentionId: intention.id,
    expectedRevision: revision(c),
    summary: "route",
    rationale: "because",
    newStages: [{ ref: "s1", title: "Stage 1" }],
    stageEdits: [],
    newActions: titles.map((t, i) => ({ ref: refs[i] as string, stage: "s1", title: t, doneWhen: "done" })),
    actionEdits: [],
    actionOrder: refs,
  };
  const proposal = unwrap(c.app.commands.createRouteProposal(c.ai(), input));
  unwrap(c.app.commands.acceptProposal(c.ui(), { id: proposal.id }));
  const v = view(c);
  const p = v.projects.find((x) => x.intention.id === intention.id);
  return { intention, actionIds: p?.stages.flatMap((s) => s.actions.map((a) => a.id)) ?? [] };
}

describe("active project limit (Stage 8: max 3)", () => {
  it("the fourth project is refused with a typed result and changes nothing", () => {
    const c = setup();
    project(c, "A");
    project(c, "B");
    project(c, "C");
    const before = revision(c);
    const snapshotBefore = JSON.stringify(view(c).projects);
    const fourth = c.app.commands.createIntention(c.ui(), { title: "D", desiredResult: "" });
    expect(fourth).toMatchObject({ ok: false, error: { code: "ACTIVE_PROJECT_LIMIT" } });
    expect(revision(c)).toBe(before);
    expect(JSON.stringify(view(c).projects)).toBe(snapshotBefore);
    expect(view(c).projectSlots).toEqual({ active: 3, max: 3 });
  });

  it("completed, released and paused projects free a slot; reopening cannot bypass the limit", () => {
    const c = setup();
    const a = project(c, "A");
    const b = project(c, "B");
    const cc = project(c, "C");
    const done = unwrap(
      c.app.commands.changeIntentionStatus(c.ui(), { id: a.id, expectedVersion: a.version, to: "completed" }),
    );
    expect(done).toMatchObject({ status: "completed", closedAt: clock.now() });
    expect(view(c).projectSlots.active).toBe(2);
    const d = project(c, "D"); // the freed slot
    expect(d.status).toBe("active");
    // The completed project cannot come straight back to active (and would be a 4th anyway).
    expect(
      c.app.commands.changeIntentionStatus(c.ui(), { id: a.id, expectedVersion: done.version, to: "active" }),
    ).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
    // It comes back paused; resuming it needs a free slot.
    const reopened = unwrap(
      c.app.commands.changeIntentionStatus(c.ui(), { id: a.id, expectedVersion: done.version, to: "deferred" }),
    );
    expect(reopened).toMatchObject({ status: "deferred", closedAt: null });
    expect(
      c.app.commands.changeIntentionStatus(c.ui(), { id: a.id, expectedVersion: reopened.version, to: "active" }),
    ).toMatchObject({ ok: false, error: { code: "ACTIVE_PROJECT_LIMIT" } });
    const paused = unwrap(
      c.app.commands.changeIntentionStatus(c.ui(), { id: b.id, expectedVersion: b.version, to: "deferred" }),
    );
    expect(paused.status).toBe("deferred");
    expect(
      c.app.commands.changeIntentionStatus(c.ui(), { id: a.id, expectedVersion: reopened.version, to: "active" }),
    ).toMatchObject({ ok: true, value: { status: "active" } });
    const released = unwrap(
      c.app.commands.changeIntentionStatus(c.ui(), { id: cc.id, expectedVersion: cc.version, to: "released" }),
    );
    expect(released.status).toBe("released");
    expect(view(c).projectSlots.active).toBe(2);
  });

  it("the Season's progress counts explicit projects, never a percentage", () => {
    const c = setup();
    unwrap(c.app.commands.createSeason(c.ui(), { focus: "Рабочая карта" }));
    const a = project(c, "A");
    project(c, "B");
    expect(view(c).strategy.seasonProgress).toEqual({ completed: 0, total: 2 });
    unwrap(c.app.commands.changeIntentionStatus(c.ui(), { id: a.id, expectedVersion: a.version, to: "completed" }));
    const strategy = view(c).strategy;
    expect(strategy.seasonProgress).toEqual({ completed: 1, total: 2 });
    expect(strategy.seasonEvidence).toEqual([{ kind: "project_completed", text: "A", at: clock.now() }]);
    expect(JSON.stringify(strategy)).not.toMatch(/percent/i);
  });

  it("only the owner can change a project's lifecycle or order — never the AI", () => {
    const c = setup();
    const a = project(c, "A");
    for (const command of [
      "intention.changeStatus",
      "intention.reorder",
      "strategy.save",
      "strategy.remove",
      "strategy.resolveCourseChange",
      "routine.add",
      "routine.edit",
      "routine.remove",
      "routine.reorder",
    ] as const) {
      expect(isAllowed(command, "mcp-ai"), command).toBe(false);
      expect(isAllowed(command, "user-ui"), command).toBe(true);
    }
    expect(
      c.app.commands.changeIntentionStatus(c.ai(), { id: a.id, expectedVersion: a.version, to: "released" }),
    ).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
    // The whole capability table still gives the AI only its two proposals and two safe writes.
    const aiCommands = Object.entries(COMMAND_POLICY)
      .filter(([, actors]) => (actors as readonly string[]).includes("mcp-ai"))
      .map(([name]) => name)
      .sort();
    expect(aiCommands).toEqual(["memory.save", "plan.reorder", "proposal.create"]);
  });

  it("a paused or closed project cannot be planned by the AI", () => {
    const c = setup();
    const a = project(c, "A");
    unwrap(c.app.commands.changeIntentionStatus(c.ui(), { id: a.id, expectedVersion: a.version, to: "deferred" }));
    const attempt = c.app.commands.proposeDesiredResultChange(c.ai(), {
      intentionId: a.id,
      expectedRevision: revision(c),
      desiredResult: "other",
      summary: "s",
      rationale: "r",
    });
    expect(attempt).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
  });
});

describe("one Сейчас across projects (deterministic, no strategic scoring)", () => {
  it("asks the projects in the owner's order and takes the first admissible Action", () => {
    const c = setup();
    const p1 = routedProject(c, "P1", ["p1-first"]);
    const p2 = routedProject(c, "P2", ["p2-first", "p2-second"]);
    expect(view(c).currentAction).toMatchObject({ actionId: p1.actionIds[0], intentionId: p1.intention.id });
    // The owner puts P2 first: that is the whole difference — the selector itself is untouched.
    unwrap(c.app.commands.reorderProjects(c.ui(), { orderedIds: [p2.intention.id, p1.intention.id] }));
    expect(view(c).currentAction).toMatchObject({ actionId: p2.actionIds[0], intentionId: p2.intention.id });
    expect(view(c).intention?.id).toBe(p2.intention.id);
  });

  it("skips a project with nothing admissible instead of inventing work, and tells which one needs a replan", () => {
    const c = setup();
    const p1 = routedProject(c, "P1", ["only"]);
    const p2 = routedProject(c, "P2", ["next"]);
    const done = view(c).projects[0]?.stages[0]?.actions[0];
    unwrap(c.app.commands.completeAction(c.ui(), { id: done?.id as string, expectedVersion: done?.version as number }));
    const v = view(c);
    expect(v.currentAction).toMatchObject({ actionId: p2.actionIds[0], intentionId: p2.intention.id });
    expect(v.needsAiReplan).toBe(false);
    expect(v.projects.find((p) => p.intention.id === p1.intention.id)?.needsAiReplan).toBe(true);
    expect(v.projects.find((p) => p.intention.id === p2.intention.id)?.needsAiReplan).toBe(false);
  });

  it("NeedsAIReplan only when no active project can offer anything; paused projects never offer work", () => {
    const c = setup();
    const p1 = routedProject(c, "P1", ["a"]);
    const p2 = routedProject(c, "P2", ["b"]);
    unwrap(
      c.app.commands.changeIntentionStatus(c.ui(), {
        id: p1.intention.id,
        expectedVersion: view(c).projects[0]?.intention.version as number,
        to: "deferred",
      }),
    );
    expect(view(c).currentAction?.intentionId).toBe(p2.intention.id);
    const second = view(c).projects.find((p) => p.intention.id === p2.intention.id);
    const action = second?.stages[0]?.actions[0];
    unwrap(
      c.app.commands.completeAction(c.ui(), { id: action?.id as string, expectedVersion: action?.version as number }),
    );
    const v = view(c);
    expect(v.currentAction).toBeNull();
    expect(v.needsAiReplan).toBe(true);
    // the paused project's open Action is NOT offered as a fallback
    expect(v.projects.find((p) => p.intention.id === p1.intention.id)?.intention.status).toBe("deferred");
  });

  it("progress is counts of explicit Stages/Actions", () => {
    const c = setup();
    routedProject(c, "P1", ["a", "b", "c"]);
    expect(view(c).projects[0]?.progress).toEqual({ stageIndex: 1, stageCount: 1, actionsDone: 0, actionsTotal: 3 });
    const first = view(c).projects[0]?.stages[0]?.actions[0];
    unwrap(
      c.app.commands.completeAction(c.ui(), { id: first?.id as string, expectedVersion: first?.version as number }),
    );
    expect(view(c).projects[0]?.progress).toMatchObject({ actionsDone: 1, actionsTotal: 3 });
  });
});

describe("strategic layers: one map, far = coarse", () => {
  it("fills the decades, the 3-year horizon and the year; the map stays sorted and honest about links", () => {
    const c = setup();
    const ui = c.ui();
    unwrap(c.app.commands.saveStrategy(ui, { level: "decade", startYear: 2036, endYear: 2045, statement: "Передать" }));
    unwrap(c.app.commands.saveStrategy(ui, { level: "decade", startYear: 2026, endYear: 2035, statement: "Строить" }));
    unwrap(
      c.app.commands.saveStrategy(ui, {
        level: "horizon",
        startYear: 2026,
        direction: "Запустить и вырасти",
        whyItMatters: "Это первый шаг к построенному делу",
      }),
    );
    unwrap(c.app.commands.saveStrategy(ui, { level: "year", year: 2026, direction: "Рабочий MVP", whyItMatters: "" }));
    const { strategy } = view(c);
    expect(strategy.decadePlan.map((d) => d.statement)).toEqual(["Строить", "Передать"]);
    expect(strategy.horizon).toMatchObject({ startYear: 2026, endYear: 2028, whyItMatters: expect.any(String) });
    expect(strategy.horizon?.decadeItemIds).toEqual([strategy.decadePlan[0]?.id]);
    expect(strategy.year).toMatchObject({ year: 2026, isCurrentYear: true });
    expect(strategy.currentYear).toBe(2026);
    // overlapping decades are refused
    expect(
      c.app.commands.saveStrategy(ui, { level: "decade", startYear: 2030, endYear: 2040, statement: "x" }),
    ).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
  });

  it("an empty map is a valid, quiet state", () => {
    const c = setup();
    const { strategy, projects } = view(c);
    expect(strategy).toMatchObject({
      decadePlan: [],
      horizon: null,
      year: null,
      seasonProgress: null,
      seasonEvidence: [],
      openCourseChanges: [],
    });
    expect(projects).toEqual([]);
  });

  it("a year that has passed is flagged, not silently shown as current", () => {
    const c = setup();
    unwrap(
      c.app.commands.saveStrategy(c.ui(), { level: "year", year: 2025, direction: "Старый год", whyItMatters: "" }),
    );
    expect(view(c).strategy.year?.isCurrentYear).toBe(false);
  });

  it("an owner-named annual horizon («До следующего дня рождения») is shown by its name and never flagged by the calendar", () => {
    const c = setup();
    const ui = c.ui();
    unwrap(
      c.app.commands.saveStrategy(ui, {
        level: "year",
        year: 2025,
        label: "До следующего дня рождения",
        direction: "Машина",
        whyItMatters: "",
      }),
    );
    unwrap(
      c.app.commands.saveStrategy(ui, {
        level: "decade",
        startYear: 2026,
        endYear: 2035,
        label: "25–34",
        statement: "Личный капитал",
      }),
    );
    const { strategy } = view(c);
    expect(strategy.year).toMatchObject({ year: 2025, label: "До следующего дня рождения", isCurrentYear: true });
    expect(strategy.decadePlan[0]).toMatchObject({ label: "25–34", startYear: 2026, endYear: 2035 });
    const year = strategy.year as NonNullable<typeof strategy.year>;
    const decade = strategy.decadePlan[0] as NonNullable<(typeof strategy.decadePlan)[0]>;

    // renaming the period is a change of course, not a wording edit — for the year and for a decade
    const before = revision(c);
    expect(
      c.app.commands.saveStrategy(ui, {
        level: "year",
        expectedVersion: year.version,
        year: 2025,
        label: "2026",
        direction: "Машина",
        whyItMatters: "",
        mode: "wording",
      }),
    ).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
    expect(
      c.app.commands.saveStrategy(ui, {
        level: "decade",
        id: decade.id,
        expectedVersion: decade.version,
        startYear: 2026,
        endYear: 2035,
        label: "26–35",
        statement: "Личный капитал",
        mode: "wording",
      }),
    ).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
    expect(revision(c)).toBe(before);

    // a wording edit that resends the same label (or omits it) keeps the label
    unwrap(
      c.app.commands.saveStrategy(ui, {
        level: "year",
        expectedVersion: year.version,
        year: 2025,
        label: " До следующего дня рождения ",
        direction: "Машина, яснее",
        whyItMatters: "",
        mode: "wording",
      }),
    );
    expect(view(c).strategy.year).toMatchObject({ direction: "Машина, яснее", label: "До следующего дня рождения" });

    // a course change may rename it; "" brings it back to the plain calendar year (then the calendar flags it)
    const v2 = view(c).strategy.year as NonNullable<typeof strategy.year>;
    unwrap(
      c.app.commands.saveStrategy(ui, {
        level: "year",
        expectedVersion: v2.version,
        year: 2025,
        label: "",
        direction: "Машина, яснее",
        whyItMatters: "",
        mode: "course",
      }),
    );
    expect(view(c).strategy.year).toMatchObject({ label: null, isCurrentYear: false });
  });

  it("an owner-named annual horizon gathers evidence since it was set, not cut at 31 December", () => {
    let now = "2026-10-05T10:00:00.000Z";
    const app = createApplication({
      store: memoryStore(),
      clock: { now: () => now },
      ids: sequentialIds(),
      timeZone: () => "UTC",
    });
    const ui = () => app.newContext("user-ui", "test");
    const close = (title: string) => {
      const p = unwrap(app.commands.createIntention(ui(), { title, desiredResult: "" }));
      unwrap(app.commands.changeIntentionStatus(ui(), { id: p.id, expectedVersion: p.version, to: "completed" }));
    };
    close("До года"); // closed before the annual horizon existed: not its evidence
    now = "2026-10-05T11:00:00.000Z";
    unwrap(
      app.commands.saveStrategy(ui(), {
        level: "year",
        year: 2026,
        label: "До следующего дня рождения",
        direction: "Машина",
        whyItMatters: "",
      }),
    );
    now = "2026-12-20T10:00:00.000Z";
    close("Декабрь");
    now = "2027-03-01T10:00:00.000Z";
    close("Март следующего календарного года");
    const year = unwrap(app.queries.getCurrentView()).strategy.year;
    expect(year).toMatchObject({ isCurrentYear: true, label: "До следующего дня рождения" });
    expect(year?.evidence.map((e) => e.text)).toEqual(["Декабрь", "Март следующего календарного года"]);
  });

  it("the 3-year horizon holds the owner's direction, inner capability and outer result together", () => {
    const c = setup();
    const direction = [
      "Стать машиной превращения идей в реальность.",
      "Внутренняя способность: умею превращать идеи в законченные вещи и распространять их.",
      "Внешний результат: сильные медиа, большая аудитория, устойчивый доход, ИИ-команда снимает операционку.",
    ].join("\n");
    expect(direction.length).toBeGreaterThan(200);
    unwrap(c.app.commands.saveStrategy(c.ui(), { level: "horizon", startYear: 2026, direction, whyItMatters: "" }));
    expect(view(c).strategy.horizon?.direction).toBe(direction);
  });
});

describe("MODE A wording vs MODE B change of course", () => {
  function mapWithProject() {
    const c = setup();
    const ui = c.ui();
    unwrap(c.app.commands.createSeason(ui, { focus: "Рабочая карта" }));
    unwrap(c.app.commands.saveStrategy(ui, { level: "decade", startYear: 2026, endYear: 2035, statement: "Строить" }));
    unwrap(
      c.app.commands.saveStrategy(ui, { level: "horizon", startYear: 2026, direction: "Запуск", whyItMatters: "" }),
    );
    unwrap(c.app.commands.saveStrategy(ui, { level: "year", year: 2026, direction: "MVP", whyItMatters: "" }));
    const routed = routedProject(c, "P1", ["a", "b"]);
    return { c, ...routed };
  }

  it("a wording edit changes only the words: no impact, no gate, nothing below touched, proposals stay fresh", () => {
    const { c, intention } = mapWithProject();
    // A pending route proposal that reasoned about the current world.
    const pending = unwrap(
      c.app.commands.proposeDesiredResultChange(c.ai(), {
        intentionId: intention.id,
        expectedRevision: revision(c),
        desiredResult: "Новый результат",
        summary: "s",
        rationale: "r",
      }),
    );
    const before = view(c);
    const horizon = before.strategy.horizon;
    unwrap(
      c.app.commands.saveStrategy(c.ui(), {
        level: "horizon",
        expectedVersion: horizon?.version as number,
        startYear: 2026,
        direction: "Запуск, сказанный лучше",
        whyItMatters: "",
        mode: "wording",
      }),
    );
    const after = view(c);
    expect(after.strategy.horizon?.direction).toBe("Запуск, сказанный лучше");
    expect(after.strategy.openCourseChanges).toEqual([]);
    expect(after.projects).toEqual(before.projects);
    expect(after.season).toEqual(before.season);
    expect(after.strategy.year).toEqual(before.strategy.year);
    expect(unwrap(c.app.queries.getProposal({ id: pending.id })).status).toBe("pending");
  });

  it("a wording edit may not smuggle in a change of years", () => {
    const { c } = mapWithProject();
    const horizon = view(c).strategy.horizon;
    expect(
      c.app.commands.saveStrategy(c.ui(), {
        level: "horizon",
        expectedVersion: horizon?.version as number,
        startYear: 2027,
        direction: "Запуск",
        whyItMatters: "",
        mode: "wording",
      }),
    ).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
  });

  it("editing something that exists must say wording or course", () => {
    const { c } = mapWithProject();
    const year = view(c).strategy.year;
    expect(
      c.app.commands.saveStrategy(c.ui(), {
        level: "year",
        expectedVersion: year?.version as number,
        year: 2026,
        direction: "x",
        whyItMatters: "",
      }),
    ).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
  });

  it("a change of course is refused until the owner has the impact fingerprint — and then touches nothing below", () => {
    const { c, intention } = mapWithProject();
    const before = view(c);
    const year = before.strategy.year;
    const edit = (impactFingerprint?: string) =>
      c.app.commands.saveStrategy(c.ui(), {
        level: "year",
        expectedVersion: year?.version as number,
        year: 2026,
        direction: "Совсем другое направление",
        whyItMatters: "",
        mode: "course",
        ...(impactFingerprint === undefined ? {} : { impactFingerprint }),
      });

    const revisionBefore = revision(c);
    expect(edit()).toMatchObject({ ok: false, error: { code: "REQUIRES_CONFIRMATION" } });
    expect(edit("made-up")).toMatchObject({ ok: false, error: { code: "REQUIRES_CONFIRMATION" } });
    expect(revision(c)).toBe(revisionBefore); // nothing was written

    const impact = unwrap(c.app.queries.previewCourseImpact({ level: "year" }));
    expect(impact.items.map((i) => i.kind)).toEqual(["season", "project"]);
    expect(impact.items[1]).toMatchObject({ id: intention.id, label: "P1", stageCount: 1, unfinishedActionCount: 2 });

    unwrap(edit(impact.fingerprint));
    const after = view(c);
    expect(after.strategy.year?.direction).toBe("Совсем другое направление");
    // No silent rewrite: every lower level is byte-for-byte what it was.
    expect(after.season).toEqual(before.season);
    expect(after.projects).toEqual(before.projects);
    // …but the owner is reminded, with the affected entities in plain data.
    expect(after.strategy.openCourseChanges).toHaveLength(1);
    expect(after.strategy.openCourseChanges[0]).toMatchObject({ level: "year", summary: "Совсем другое направление" });
    expect(after.strategy.openCourseChanges[0]?.impact.map((i) => i.kind)).toEqual(["season", "project"]);
  });

  it("the shown impact goes stale if anything below changes before the owner confirms", () => {
    const { c, intention } = mapWithProject();
    const year = view(c).strategy.year;
    const impact = unwrap(c.app.queries.previewCourseImpact({ level: "year" }));
    const stage = view(c).projects[0]?.stages[0];
    unwrap(c.app.commands.addAction(c.ui(), { stageId: stage?.id as string, title: "Ещё", doneWhen: "" }));
    expect(
      c.app.commands.saveStrategy(c.ui(), {
        level: "year",
        expectedVersion: year?.version as number,
        year: 2026,
        direction: "Другое",
        whyItMatters: "",
        mode: "course",
        impactFingerprint: impact.fingerprint,
      }),
    ).toMatchObject({ ok: false, error: { code: "REQUIRES_CONFIRMATION" } });
    expect(intention.id).toBeTruthy();
  });

  it("a change of course makes a pending AI proposal stale — the AI must rebuild, nothing is silently rebased", () => {
    const { c, intention } = mapWithProject();
    const pending = unwrap(
      c.app.commands.proposeDesiredResultChange(c.ai(), {
        intentionId: intention.id,
        expectedRevision: revision(c),
        desiredResult: "Новый результат",
        summary: "s",
        rationale: "r",
      }),
    );
    const year = view(c).strategy.year;
    const impact = unwrap(c.app.queries.previewCourseImpact({ level: "year" }));
    unwrap(
      c.app.commands.saveStrategy(c.ui(), {
        level: "year",
        expectedVersion: year?.version as number,
        year: 2026,
        direction: "Новый курс",
        whyItMatters: "",
        mode: "course",
        impactFingerprint: impact.fingerprint,
      }),
    );
    expect(unwrap(c.app.queries.getProposal({ id: pending.id })).status).toBe("stale");
    expect(c.app.commands.acceptProposal(c.ui(), { id: pending.id })).toMatchObject({
      ok: false,
      error: { code: "STALE_PROPOSAL" },
    });
    // The project's own desired result is untouched.
    expect(view(c).projects[0]?.intention.desiredResult).toBe("P1 done");
  });

  it("a far decade statement changes course without touching anything; removing one in the chain needs the impact", () => {
    const { c } = mapWithProject();
    const ui = c.ui();
    unwrap(c.app.commands.saveStrategy(ui, { level: "decade", startYear: 2046, endYear: 2055, statement: "Далеко" }));
    const far = view(c).strategy.decadePlan.find((d) => d.statement === "Далеко");
    unwrap(
      c.app.commands.saveStrategy(ui, {
        level: "decade",
        id: far?.id as string,
        expectedVersion: far?.version as number,
        startYear: 2046,
        endYear: 2055,
        statement: "Совсем иное далеко",
        mode: "course",
      }),
    );
    expect(view(c).strategy.openCourseChanges).toEqual([]);

    const near = view(c).strategy.decadePlan.find((d) => d.statement === "Строить");
    expect(
      c.app.commands.removeDecadeItem(ui, { id: near?.id as string, expectedVersion: near?.version as number }),
    ).toMatchObject({ ok: false, error: { code: "REQUIRES_CONFIRMATION" } });
    const impact = unwrap(c.app.queries.previewCourseImpact({ level: "decade", targetId: near?.id as string }));
    expect(impact.items.map((i) => i.kind)).toEqual(["horizon", "year", "season", "project"]);
    unwrap(
      c.app.commands.removeDecadeItem(ui, {
        id: near?.id as string,
        expectedVersion: near?.version as number,
        impactFingerprint: impact.fingerprint,
      }),
    );
    const after = view(c).strategy;
    expect(after.decadePlan.map((d) => d.statement)).toEqual(["Совсем иное далеко"]);
    // The reminder survives the removal of its decade statement and still lists what to look at.
    expect(after.openCourseChanges[0]?.impact.map((i) => i.kind)).toEqual(["horizon", "year", "season", "project"]);
  });

  it("a decade moved into the chain's years needs the shown impact, and moving one out leaves a reminder that still lists what to rebuild (review M1)", () => {
    const c = setup();
    const ui = c.ui();
    unwrap(c.app.commands.createSeason(ui, { focus: "Цель" }));
    unwrap(c.app.commands.saveStrategy(ui, { level: "decade", startYear: 2040, endYear: 2049, statement: "Far" }));
    unwrap(
      c.app.commands.saveStrategy(ui, { level: "horizon", startYear: 2026, direction: "Запуск", whyItMatters: "" }),
    );
    routedProject(c, "P1", ["a"]);
    const far = view(c).strategy.decadePlan[0];
    const edit = (impactFingerprint?: string) =>
      c.app.commands.saveStrategy(ui, {
        level: "decade",
        id: far?.id as string,
        expectedVersion: far?.version as number,
        startYear: 2025,
        endYear: 2034,
        statement: "Теперь про ближайшие годы",
        mode: "course",
        ...(impactFingerprint === undefined ? {} : { impactFingerprint }),
      });
    // Without the preview the move is refused — it is NOT silently applied.
    expect(edit()).toMatchObject({ ok: false, error: { code: "REQUIRES_CONFIRMATION" } });
    const impact = unwrap(
      c.app.queries.previewCourseImpact({
        level: "decade",
        targetId: far?.id as string,
        startYear: 2025,
        endYear: 2034,
      }),
    );
    expect(impact.items.map((i) => i.kind)).toEqual(["horizon", "season", "project"]);
    unwrap(edit(impact.fingerprint));
    expect(view(c).strategy.horizon?.decadeItemIds).toEqual([far?.id]);
    expect(view(c).strategy.openCourseChanges).toHaveLength(1);
    // Moving it out again: the gate shows the impact, and the reminder keeps listing what to look at.
    const here = view(c).strategy.decadePlan[0];
    const out = unwrap(
      c.app.queries.previewCourseImpact({
        level: "decade",
        targetId: here?.id as string,
        startYear: 2040,
        endYear: 2049,
      }),
    );
    expect(out.items.map((i) => i.kind)).toEqual(["horizon", "season", "project"]);
    unwrap(
      c.app.commands.saveStrategy(ui, {
        level: "decade",
        id: here?.id as string,
        expectedVersion: here?.version as number,
        startYear: 2040,
        endYear: 2049,
        statement: "Снова далеко",
        mode: "course",
        impactFingerprint: out.fingerprint,
      }),
    );
    for (const change of view(c).strategy.openCourseChanges) {
      expect(change.impact.map((i) => i.kind)).toEqual(["horizon", "season", "project"]);
    }
  });

  it("a Season wording edit and reordering projects do NOT stale a pending AI proposal; a real season turn does (review M2)", () => {
    const { c, intention } = mapWithProject();
    const other = project(c, "P2");
    const pending = unwrap(
      c.app.commands.proposeDesiredResultChange(c.ai(), {
        intentionId: intention.id,
        expectedRevision: revision(c),
        desiredResult: "Новый результат",
        summary: "s",
        rationale: "r",
      }),
    );
    const status = () => unwrap(c.app.queries.getProposal({ id: pending.id })).status;
    const season = view(c).season;
    unwrap(
      c.app.commands.updateSeasonFocus(c.ui(), {
        expectedVersion: season?.version as number,
        focus: "Рабочая карта, сказанная лучше",
        startsNewSeason: false,
      }),
    );
    expect(status()).toBe("pending");
    unwrap(c.app.commands.reorderProjects(c.ui(), { orderedIds: [other.id, intention.id] }));
    expect(status()).toBe("pending");
    unwrap(c.app.commands.reorderProjects(c.ui(), { orderedIds: [intention.id, other.id] }));
    expect(status()).toBe("pending");
    // The season really turning is a change of course: the world the proposal reasoned about is gone.
    const impact = unwrap(c.app.queries.previewCourseImpact({ level: "season" }));
    unwrap(
      c.app.commands.updateSeasonFocus(c.ui(), {
        expectedVersion: view(c).season?.version as number,
        focus: "Совсем другая цель",
        startsNewSeason: true,
        impactFingerprint: impact.fingerprint,
      }),
    );
    expect(status()).toBe("stale");
  });

  it("the owner closes the reminder; it stays in the fingerprint history so proposals are not re-staled", () => {
    const { c } = mapWithProject();
    const year = view(c).strategy.year;
    const impact = unwrap(c.app.queries.previewCourseImpact({ level: "year" }));
    unwrap(
      c.app.commands.saveStrategy(c.ui(), {
        level: "year",
        expectedVersion: year?.version as number,
        year: 2026,
        direction: "Новый курс",
        whyItMatters: "",
        mode: "course",
        impactFingerprint: impact.fingerprint,
      }),
    );
    const open = view(c).strategy.openCourseChanges[0];
    const intention = view(c).projects[0]?.intention;
    const rebuild = unwrap(
      c.app.commands.proposeDesiredResultChange(c.ai(), {
        intentionId: intention?.id as string,
        expectedRevision: revision(c),
        desiredResult: "Пересобранный результат",
        summary: "s",
        rationale: "r",
      }),
    );
    unwrap(c.app.commands.resolveCourseChange(c.ui(), { id: open?.id as string }));
    expect(view(c).strategy.openCourseChanges).toEqual([]);
    expect(unwrap(c.app.queries.getProposal({ id: rebuild.id })).status).toBe("pending");
    expect(c.app.commands.resolveCourseChange(c.ui(), { id: open?.id as string })).toMatchObject({
      ok: false,
      error: { code: "CONFLICT_RELOAD" },
    });
  });

  it("starting a new Season is MODE B: gated, archives the old goal, keeps projects untouched", () => {
    const { c } = mapWithProject();
    const season = view(c).season;
    const turn = (impactFingerprint?: string) =>
      c.app.commands.updateSeasonFocus(c.ui(), {
        expectedVersion: season?.version as number,
        focus: "Новая главная цель",
        startsNewSeason: true,
        ...(impactFingerprint === undefined ? {} : { impactFingerprint }),
      });
    expect(turn()).toMatchObject({ ok: false, error: { code: "REQUIRES_CONFIRMATION" } });
    const impact = unwrap(c.app.queries.previewCourseImpact({ level: "season" }));
    expect(impact.items.map((i) => i.kind)).toEqual(["project"]);
    const projectsBefore = view(c).projects;
    unwrap(turn(impact.fingerprint));
    expect(view(c).season).toMatchObject({ focus: "Новая главная цель", startedAt: clock.now() });
    expect(view(c).projects).toEqual(projectsBefore);
    const history = unwrap(c.app.queries.getStrategyHistory());
    expect(history.pastSeasons.map((s) => s.focus)).toEqual(["Рабочая карта"]);
    expect(view(c).strategy.openCourseChanges[0]).toMatchObject({ level: "season", summary: "Новая главная цель" });
  });

  it("a Season wording edit is MODE A: no gate, no archive, no reminder", () => {
    const { c } = mapWithProject();
    const season = view(c).season;
    unwrap(
      c.app.commands.updateSeasonFocus(c.ui(), {
        expectedVersion: season?.version as number,
        focus: "Рабочая карта, яснее",
        whyItMatters: "Она двигает год",
        startsNewSeason: false,
      }),
    );
    expect(view(c).season).toMatchObject({ focus: "Рабочая карта, яснее", whyItMatters: "Она двигает год" });
    expect(unwrap(c.app.queries.getStrategyHistory()).pastSeasons).toEqual([]);
    expect(view(c).strategy.openCourseChanges).toEqual([]);
  });

  it("a Season turn with no projects needs no confirmation (nothing to affect)", () => {
    const c = setup();
    const season = unwrap(c.app.commands.createSeason(c.ui(), { focus: "Старый" }));
    expect(
      c.app.commands.updateSeasonFocus(c.ui(), {
        expectedVersion: season.version,
        focus: "Новый",
        startsNewSeason: true,
      }),
    ).toMatchObject({ ok: true });
    expect(view(c).strategy.openCourseChanges).toEqual([]);
  });
});

describe("routines: stable infrastructure of the day, never work", () => {
  it("keeps an ordered morning and evening routine, owner-editable", () => {
    const c = setup();
    const w = unwrap(c.app.commands.addRoutineItem(c.ui(), { kind: "morning", text: "Стакан воды" }));
    unwrap(c.app.commands.addRoutineItem(c.ui(), { kind: "evening", text: "Читать" }));
    const z = unwrap(c.app.commands.addRoutineItem(c.ui(), { kind: "morning", text: "Зарядка" }));
    expect(view(c).routines.map((r) => `${r.kind}:${r.position}:${r.text}`)).toEqual([
      "morning:1:Стакан воды",
      "morning:2:Зарядка",
      "evening:1:Читать",
    ]);
    unwrap(c.app.commands.reorderRoutineItems(c.ui(), { kind: "morning", orderedIds: [z.id, w.id] }));
    expect(
      view(c)
        .routines.filter((r) => r.kind === "morning")
        .map((r) => r.text),
    ).toEqual(["Зарядка", "Стакан воды"]);
    const current = view(c).routines.find((r) => r.id === w.id);
    const off = unwrap(
      c.app.commands.editRoutineItem(c.ui(), { id: w.id, expectedVersion: current?.version as number, active: false }),
    );
    expect(off.active).toBe(false);
    expect(c.app.commands.editRoutineItem(c.ui(), { id: w.id, expectedVersion: 1, active: true })).toMatchObject({
      ok: false,
      error: { code: "CONFLICT_RELOAD" },
    });
  });

  it("closing a gap keeps positions unique, so the next item never collides", () => {
    const c = setup();
    const a = unwrap(c.app.commands.addRoutineItem(c.ui(), { kind: "morning", text: "A" }));
    unwrap(c.app.commands.addRoutineItem(c.ui(), { kind: "morning", text: "B" }));
    unwrap(c.app.commands.addRoutineItem(c.ui(), { kind: "morning", text: "C" }));
    unwrap(c.app.commands.removeRoutineItem(c.ui(), { id: a.id, expectedVersion: a.version }));
    unwrap(c.app.commands.addRoutineItem(c.ui(), { kind: "morning", text: "D" }));
    const positions = view(c).routines.map((r) => r.position);
    expect(positions).toEqual([1, 2, 3]);
    expect(view(c).routines.map((r) => r.text)).toEqual(["B", "C", "D"]);
  });

  it("a routine is not an Action: it cannot be started, ordered or planned, and is not in the AI's planning context", () => {
    const c = setup();
    const item = unwrap(c.app.commands.addRoutineItem(c.ui(), { kind: "morning", text: "Зарядка" }));
    routedProject(c, "P1", ["work"]);
    // Work can only start on the current Action — never on a routine id.
    expect(c.app.commands.startWork(c.ui(), { actionId: item.id })).toMatchObject({ ok: false });
    // The current Action is project work, with no routine in sight.
    const v = view(c);
    expect(v.currentAction?.actionId).not.toBe(item.id);
    expect(v.projects.flatMap((p) => p.stages.flatMap((s) => s.actions.map((a) => a.id)))).not.toContain(item.id);
    // The AI cannot put a routine into the order (not an Action of the route) …
    const plan = v.orderedActionPlan;
    expect(plan?.orderedActionIds).not.toContain(item.id);
    const bad = c.app.commands.reorderExistingActions(c.ai(), {
      intentionId: v.intention?.id as string,
      expectedRevision: revision(c),
      expectedPlanVersion: plan?.version as number,
      orderedActionIds: [item.id, ...(plan?.orderedActionIds ?? [])],
      rationale: "sneaky",
    });
    expect(bad).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
    // … and the planning context the AI reads does not even contain routines.
    const context = unwrap(c.app.queries.getPlanningContext());
    expect(Object.keys(context)).not.toContain("routines");
    expect(JSON.stringify(context)).not.toContain("Зарядка");
    // Routine time is not work time: nothing about routines reaches execution totals.
    expect(v.execution.todayWorkedMs).toBe(0);
  });

  it("is a short anchor, not a task list", () => {
    const c = setup();
    for (let i = 0; i < 10; i++) unwrap(c.app.commands.addRoutineItem(c.ui(), { kind: "evening", text: `#${i}` }));
    expect(c.app.commands.addRoutineItem(c.ui(), { kind: "evening", text: "one more" })).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_ERROR" },
    });
    expect(c.app.commands.addRoutineItem(c.ui(), { kind: "morning", text: "separate routine" })).toMatchObject({
      ok: true,
    });
  });
});

describe("planning context for the AI", () => {
  it("carries the whole causal line, the projects and their honest progress — read-only", () => {
    const c = setup();
    unwrap(c.app.commands.createSeason(c.ui(), { focus: "Рабочая карта", whyItMatters: "Двигает год" }));
    unwrap(
      c.app.commands.saveStrategy(c.ui(), { level: "decade", startYear: 2026, endYear: 2035, statement: "Строить" }),
    );
    unwrap(c.app.commands.saveStrategy(c.ui(), { level: "year", year: 2026, direction: "MVP", whyItMatters: "" }));
    routedProject(c, "P1", ["a", "b"]);
    const context = unwrap(c.app.queries.getPlanningContext());
    expect(context.strategy.decadePlan[0]?.statement).toBe("Строить");
    expect(context.strategy.year?.direction).toBe("MVP");
    expect(context.season).toMatchObject({ focus: "Рабочая карта", whyItMatters: "Двигает год" });
    expect(context.projects[0]?.progress).toMatchObject({ actionsTotal: 2 });
    expect(context.meanings.strategy).toContain("belong to the user alone");
    expect(context.meanings.intention).toContain("At most THREE");
  });
});
