import {
  type CalendarSnapshotDto,
  type CurrentActionDto,
  type DesiredResultPayload,
  DesiredResultPayloadSchema,
  type OrderedActionPlanDto,
  type ProposalDto,
  type RoutePayload,
  RoutePayloadSchema,
  type RoutePreviewDto,
} from "@living-map/contracts";
import {
  type Action,
  applyRouteChange,
  type EntityId,
  type Instant,
  type Intention,
  type OrderedActionPlan,
  type Proposal,
  planningFingerprint,
  type RouteChange,
  type Stage,
  selectCurrentAction,
} from "@living-map/domain";
import type { ReadScope } from "./ports";

/**
 * Product meaning of every concept the AI reads (vendor-neutral; returned by the planning context).
 * Technical names stay English; these tell the AI what they *mean* to the user.
 */
export const PLANNING_MEANINGS: Record<string, string> = {
  language: "LivingMap is a Russian-language product. Talk to the user in Russian.",
  season:
    "«Главная цель сезона» (season.focus) — the Season's ONE main goal: what this stretch of the user's life is about right now. Every route should serve it. whyItMatters says how it moves the current year; startedAt is when this season began.",
  goodLifeConditions:
    "«Чем ты не хочешь жертвовать ради целей?» — things the user refuses to sacrifice for their goals (sleep, health, relationships, free time…). These are hard strategic constraints: every route and every order must respect them. They are NOT optional motivational notes.",
  intention:
    "«Замысел» — a project: one real, significant thing the user wants to bring into their life. At most THREE are active in the Season at once (usually one or two); status: active, deferred (paused), completed, released. `projects` lists the active ones in their order, then paused ones, each with its own Stages, Actions, order and honest progress; `intention`/`stages`/`orderedActionPlan` describe the FOCUS project — the one that owns «Сейчас». Always pass the intentionId of the project you mean. You cannot activate, pause, complete or release a project: that is the user's decision.",
  strategy:
    "One life, one causal line, no categories: the sparse plan by decades (strategy.decadePlan, a few words each) → the next 3 years (strategy.horizon) → this year (strategy.year) → this Season (season.focus is its ONE main goal) → the active projects → the current Stage → the current Action («Сейчас»). Far = coarse, near = detailed. Every layer carries one short «whyItMatters» sentence saying why it serves the layer above. Use the whole line to understand WHY the user does what they do, and propose routes that serve it. You can read all of it but change none of it: the decades, the 3-year horizon, the year and the Season goal belong to the user alone. If strategy.openCourseChanges is not empty the user has just changed course and the projects listed in its impact may no longer fit: propose a rebuilt route for them (create_route_proposal) — never act as if the old direction still stood. Progress is only ever a count of explicit things (projects[].progress, strategy.seasonProgress) and evidence is only recorded facts: never invent percentages.",
  desiredResult:
    "«Желаемый результат» — what must become true for the Intention to count as embodied/completed. It is the finish line, not a description. Changing it requires the user's confirmation (propose_desired_result_change).",
  stages:
    "«Этапы» — the major phases of the route, in sequence. Exactly one is current («текущий»). Their position is the phase sequence.",
  actions:
    "«Действия» — concrete steps. doneWhen («готово, когда») is the observable condition that makes an action done. status: open = can be worked on, blocked = unavailable (blocker.reason says why), done = finished. Action `position` is only the display order inside its Stage — it is NOT the execution order.",
  orderedActionPlan:
    "«Порядок действий» — the canonical execution order across all Stages: given current reality, the order in which it makes sense to move. It always covers exactly the unfinished actions. null means no route has been approved yet. unplannedActionIds are unfinished actions the approved order does not cover yet (e.g. the user added them manually) — include them next time you order.",
  permissions:
    "You may NOT change strategy directly. A first route, any new/edited Stage or Action, doneWhen changes and route replanning go through create_route_proposal; changes to the desired result through propose_desired_result_change. The user reviews and confirms or rejects every proposal in the LivingMap desktop app — never claim a proposal is applied until get_proposal says accepted. The only direct writes you have are reorder_existing_actions (reorder the already-approved unfinished actions of an already-approved route) and save_memory (remember something; it never changes the route, the order or «Сейчас»). Changing the Season, the year, the 3-year horizon, the decades, a project's status or order (activate, pause, complete, release), the daily routines or «Чем ты не хочешь жертвовать ради целей?» is not available to you: suggest it to the user in words. Writing to the external calendar is not available.",
  memory:
    "«Память» — decisions, facts, observations, preferences/constraints, dated commitments and ideas the user told LivingMap, each with the «+» Capture it came from. Before answering or planning, search_memory for anything relevant and respect what you find (earlier decisions and constraints still hold unless the user changed them). Memory is context, not strategy: a memory never changes the route by itself.",
  captures:
    "«+» — raw user inputs, saved exactly as typed before any AI sees them (list_captures). state: pending = waits for AI, processing, processed (result.reply is what the user was answered), failed (lastError).",
  proposals:
    "pendingProposals are awaiting the user's decision. status=stale means LivingMap changed after the proposal was made; it can no longer be applied — reread the context and propose again if still relevant.",
  history: "recentHistory: meaningful changes, newest first. actor user-ui = the user, mcp-ai = an AI via MCP.",
  currentAction:
    "«Сейчас» — the one Action CurrentActionSelector picked as admissible right now (ARCHITECTURE §26). It may belong to any active project (currentAction.intentionId): LivingMap asks the projects in the user's order and takes the first admissible Action of the first project that has one. null with needsAiReplan=false means there is no active project yet; null with needsAiReplan=true means orders exist but nothing in any of them can be safely selected — propose a replan (per project: projects[].needsAiReplan says which), do not invent a local order.",
  execution:
    "«Исполнение» — factual work time the user tracked with Начать/Пауза/Продолжить/Готово: state of the current Action (idle/running/paused), all time worked on it, today's and this week's totals (local days, Monday-start weeks) and the user's daily work target. Facts, not a score. You can read it; you cannot start, pause or change it.",
  calendarSnapshot:
    "«Календарь» — read-only calendar snapshot (private iCal feed) LivingMap itself refreshed and stored. connected=false or a stale syncedAt means treat it as unavailable, not as ground truth.",
  reviewInbox:
    "«Разборы» (Stage 7): counts only, for the nav badge. Reviews are a separate learning surface you do not participate in through this context.",
  activePlanningRules:
    "Durable context the user confirmed from a repeated pattern in «Разборы» (e.g. «медицинские визиты обычно съедают половину рабочего дня»). Treat each as real context for planning/replanning — never a rigid rule you enforce mechanically, and never something you can create, confirm or deactivate yourself. An empty list is normal and means nothing has been confirmed yet.",
};

type PlanningScope = Pick<
  ReadScope,
  "season" | "goodLifeConditions" | "intentions" | "stages" | "actions" | "plans" | "courseChanges"
>;

/** Every Stage and Action of one Intention. */
export function intentionTree(s: PlanningScope, intentionId: EntityId): { stages: Stage[]; actions: Action[] } {
  const stages = s.stages.listByIntention(intentionId);
  return { stages, actions: s.actions.listByStages(stages.map((stage) => stage.id)) };
}

/**
 * Identity of everything a strategic proposal about `intentionId` reasoned about: the Season (which
 * stretch of life it is — not its wording), the Good Life Conditions, the Intention, its Stages, Actions and
 * plan — plus every recorded change of course (Stage 8): the owner turning the year/3-year/decade/season
 * makes a pending proposal stale, while a mere re-wording does not. Reordering projects does not either (it
 * leaves versions alone). Other proposals are not part of it, so creating one never stales another, and
 * neither does anything that happens to a different project.
 */
export function contextFingerprint(s: PlanningScope, intentionId: EntityId): string {
  const { stages, actions } = intentionTree(s, intentionId);
  const season = s.season.get();
  const intention = s.intentions.findById(intentionId);
  const plan = s.plans.findByIntention(intentionId);
  return planningFingerprint([
    ...(season ? [{ id: `${season.id}:${season.startedAt}`, version: 1 }] : []),
    ...s.goodLifeConditions.list(),
    ...(intention ? [intention] : []),
    ...stages,
    ...actions,
    ...(plan ? [plan] : []),
    ...s.courseChanges.listAll().map((c) => ({ id: c.id, version: 1 })),
  ]);
}

export const toPlanDto = (plan: OrderedActionPlan): OrderedActionPlanDto => ({
  ...plan,
  orderedActionIds: [...plan.orderedActionIds],
});

/**
 * Earliest not-yet-started, real (not all-day) event in the snapshot, or null — the selector's only
 * calendar input. An all-day event's `start` is a UTC-midnight sort anchor, not a real time boundary
 * (packages/integrations-ical-calendar): treating it as a hard constraint would be exactly the
 * invented fit logic Stage 4 §5 forbids.
 */
function nextHardEventStart(snapshot: CalendarSnapshotDto, now: Instant): Instant | null {
  const nowMs = new Date(now).getTime();
  let earliest: Instant | null = null;
  let earliestMs = Number.POSITIVE_INFINITY;
  for (const event of snapshot.events) {
    if (event.allDay) continue;
    const startMs = new Date(event.start).getTime();
    if (startMs >= nowMs && startMs < earliestMs) {
      earliest = event.start;
      earliestMs = startMs;
    }
  }
  return earliest;
}

/**
 * Derives `Сейчас` for the current-view query (ARCHITECTURE §26). Not a domain aggregate: it is a
 * read-only projection recomputed on every read, never stored. No Intention yet is a distinct,
 * calmer state from `needsAiReplan` — there is nothing to replan, just nothing started.
 */
export function computeCurrentAction(
  intention: Intention | undefined,
  actions: readonly Action[],
  plan: OrderedActionPlan | undefined,
  calendarSnapshot: CalendarSnapshotDto,
  now: Instant,
  runningActionId: EntityId | null = null,
): { currentAction: CurrentActionDto | null; needsAiReplan: boolean } {
  if (!intention) return { currentAction: null, needsAiReplan: false };
  // Running work pins `Сейчас` (Stage 5 §7): a reorder never yanks the card away mid-work. Only an
  // open Action can be running — completing/blocking it closes the interval in the same command.
  const running = runningActionId ? actions.find((a) => a.id === runningActionId && a.status === "open") : undefined;
  if (running) {
    return {
      currentAction: {
        actionId: running.id,
        intentionId: intention.id,
        stageId: running.stageId,
        reason: { kind: "working" },
        planRationale: plan?.rationale ?? null,
      },
      needsAiReplan: false,
    };
  }
  const selection = selectCurrentAction({
    orderedActionIds: plan ? plan.orderedActionIds : null,
    actions: actions.map((a) => ({ id: a.id, status: a.status })),
    now,
    nextHardEventStart: nextHardEventStart(calendarSnapshot, now),
  });
  if (selection.status === "needs-ai-replan") return { currentAction: null, needsAiReplan: true };
  const selected = actions.find((a) => a.id === selection.actionId) as Action;
  return {
    currentAction: {
      actionId: selection.actionId,
      intentionId: intention.id,
      stageId: selected.stageId,
      reason: selection.reason,
      planRationale: plan?.rationale ?? null,
    },
    needsAiReplan: false,
  };
}

export function routeChangeFromPayload(p: RoutePayload): RouteChange {
  return {
    newStages: p.newStages,
    stageEdits: p.stageEdits,
    newActions: p.newActions,
    actionEdits: p.actionEdits,
    stageOrder: p.stageOrder,
    orderedActionIds: p.orderedActionIds,
  };
}

export type ParsedPayload =
  | { kind: "route"; payload: RoutePayload }
  | { kind: "desired_result"; payload: DesiredResultPayload };

/** Stored JSON → typed payload. Undefined = corrupt/unknown: such a proposal must never be applied. */
export function parsePayload(proposal: Proposal): ParsedPayload | undefined {
  if (proposal.kind === "route") {
    const r = RoutePayloadSchema.safeParse(proposal.payload);
    return r.success ? { kind: "route", payload: r.data } : undefined;
  }
  const r = DesiredResultPayloadSchema.safeParse(proposal.payload);
  return r.success ? { kind: "desired_result", payload: r.data } : undefined;
}

/** The resulting route as acceptance would write it — produced by the same domain function. */
function routePreview(s: PlanningScope, payload: RoutePayload, now: Instant): RoutePreviewDto | null {
  const before = intentionTree(s, payload.intentionId);
  const outcome = applyRouteChange({
    ...before,
    intentionId: payload.intentionId,
    change: routeChangeFromPayload(payload),
    now,
  });
  if (!outcome.ok) return null;
  const oldStages = new Map(before.stages.map((st) => [st.id, st]));
  const oldActions = new Map(before.actions.map((a) => [a.id, a]));
  const changed = (was: string | undefined, now: string) => (was !== undefined && was !== now ? was : null);
  const titles = new Map(outcome.value.actions.map((a) => [a.id, a.title]));
  return {
    stages: outcome.value.stages.map((stage) => ({
      id: stage.id,
      title: stage.title,
      previousTitle: changed(oldStages.get(stage.id)?.title, stage.title),
      isNew: !oldStages.has(stage.id),
      isCurrent: stage.isCurrent,
      actions: outcome.value.actions
        .filter((a) => a.stageId === stage.id)
        .sort((a, b) => a.position - b.position)
        .map((a) => ({
          id: a.id,
          title: a.title,
          doneWhen: a.doneWhen,
          status: a.status,
          previousTitle: changed(oldActions.get(a.id)?.title, a.title),
          previousDoneWhen: changed(oldActions.get(a.id)?.doneWhen, a.doneWhen),
          isNew: !oldActions.has(a.id),
        })),
    })),
    order: outcome.value.orderedActionIds.map((actionId) => ({ actionId, title: titles.get(actionId) ?? "" })),
  };
}

/**
 * Read model of a proposal. A stored `pending` proposal whose planning context has since changed
 * (or whose route no longer applies) is reported as `stale` right away, so neither the user nor
 * the AI ever sees it as actionable; the stored status flips when someone tries to accept it.
 */
export function toProposalDto(s: PlanningScope, proposal: Proposal, now: Instant): ProposalDto | undefined {
  const parsed = parsePayload(proposal);
  if (!parsed) return undefined;
  const fresh =
    proposal.status === "pending" && contextFingerprint(s, parsed.payload.intentionId) === proposal.baseFingerprint;
  const base = {
    id: proposal.id,
    createdBy: proposal.createdBy,
    createdAt: proposal.createdAt,
    baseRevision: proposal.baseRevision,
    affectedEntityIds: [...proposal.affectedEntityIds],
    summary: proposal.summary,
    rationale: proposal.rationale,
    resolvedAt: proposal.resolvedAt,
    resolvedBy: proposal.resolvedBy,
  };
  if (parsed.kind === "desired_result") {
    return {
      ...base,
      kind: "desired_result",
      status: proposal.status === "pending" && !fresh ? "stale" : proposal.status,
      payload: parsed.payload,
    };
  }
  const preview = fresh ? routePreview(s, parsed.payload, now) : null;
  const status = proposal.status === "pending" && (!fresh || !preview) ? "stale" : proposal.status;
  return { ...base, kind: "route", status, payload: parsed.payload, preview };
}
