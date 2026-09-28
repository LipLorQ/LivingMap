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
  season: "«Фокус сезона» — what this stretch of the user's life is about right now. Every route should serve it.",
  goodLifeConditions:
    "«Чем ты не хочешь жертвовать ради целей?» — things the user refuses to sacrifice for their goals (sleep, health, relationships, free time…). These are hard strategic constraints: every route and every order must respect them. They are NOT optional motivational notes.",
  intention: "«Замысел» — one real, significant thing the user wants to bring into their life.",
  desiredResult:
    "«Желаемый результат» — what must become true for the Intention to count as embodied/completed. It is the finish line, not a description. Changing it requires the user's confirmation (propose_desired_result_change).",
  stages:
    "«Этапы» — the major phases of the route, in sequence. Exactly one is current («текущий»). Their position is the phase sequence.",
  actions:
    "«Действия» — concrete steps. doneWhen («готово, когда») is the observable condition that makes an action done. status: open = can be worked on, blocked = unavailable (blocker.reason says why), done = finished. Action `position` is only the display order inside its Stage — it is NOT the execution order.",
  orderedActionPlan:
    "«Порядок действий» — the canonical execution order across all Stages: given current reality, the order in which it makes sense to move. It always covers exactly the unfinished actions. null means no route has been approved yet. unplannedActionIds are unfinished actions the approved order does not cover yet (e.g. the user added them manually) — include them next time you order.",
  permissions:
    "You may NOT change strategy directly. A first route, any new/edited Stage or Action, doneWhen changes and route replanning go through create_route_proposal; changes to the desired result through propose_desired_result_change. The user reviews and confirms or rejects every proposal in the LivingMap desktop app — never claim a proposal is applied until get_proposal says accepted. The only direct write you have is reorder_existing_actions: reorder the already-approved unfinished actions of an already-approved route. Changing the Season or «Чем ты не хочешь жертвовать ради целей?» is not available to you: suggest it to the user in words.",
  proposals:
    "pendingProposals are awaiting the user's decision. status=stale means LivingMap changed after the proposal was made; it can no longer be applied — reread the context and propose again if still relevant.",
  history: "recentHistory: meaningful changes, newest first. actor user-ui = the user, mcp-ai = an AI via MCP.",
  currentAction:
    "«Сейчас» — the one Action CurrentActionSelector picked as admissible right now (ARCHITECTURE §26). null with needsAiReplan=false means there is no active Intention yet; null with needsAiReplan=true means the order exists but nothing in it can be safely selected — propose a replan, do not invent a local order.",
  calendarSnapshot:
    "«Календарь» — read-only calendar snapshot (private iCal feed) LivingMap itself refreshed and stored. connected=false or a stale syncedAt means treat it as unavailable, not as ground truth.",
};

type PlanningScope = Pick<ReadScope, "season" | "goodLifeConditions" | "intentions" | "stages" | "actions" | "plans">;

/** Every Stage and Action of one Intention. */
export function intentionTree(s: PlanningScope, intentionId: EntityId): { stages: Stage[]; actions: Action[] } {
  const stages = s.stages.listByIntention(intentionId);
  return { stages, actions: s.actions.listByStages(stages.map((stage) => stage.id)) };
}

/**
 * Identity of everything a strategic proposal about `intentionId` reasoned about: Season, the
 * Good Life Conditions, the Intention, its Stages, Actions and plan. Changes to any of them make a
 * pending proposal stale. Other proposals are not part of it, so creating one never stales another.
 */
export function contextFingerprint(s: PlanningScope, intentionId: EntityId): string {
  const { stages, actions } = intentionTree(s, intentionId);
  const season = s.season.get();
  const intention = s.intentions.findById(intentionId);
  const plan = s.plans.findByIntention(intentionId);
  return planningFingerprint([
    ...(season ? [season] : []),
    ...s.goodLifeConditions.list(),
    ...(intention ? [intention] : []),
    ...stages,
    ...actions,
    ...(plan ? [plan] : []),
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
): { currentAction: CurrentActionDto | null; needsAiReplan: boolean } {
  if (!intention) return { currentAction: null, needsAiReplan: false };
  const selection = selectCurrentAction({
    orderedActionIds: plan ? plan.orderedActionIds : null,
    actions: actions.map((a) => ({ id: a.id, status: a.status })),
    now,
    nextHardEventStart: nextHardEventStart(calendarSnapshot, now),
  });
  if (selection.status === "needs-ai-replan") return { currentAction: null, needsAiReplan: true };
  return {
    currentAction: { actionId: selection.actionId, reason: selection.reason, planRationale: plan?.rationale ?? null },
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
