import type { DomainResult, EntityId, Instant, Version } from "./types";

export type ActionStatus = "open" | "blocked" | "done";

/** A concise reason an Action is currently unavailable. Embedded in Action, not a separate
 * aggregate: at this stage a blocker has no identity or lifecycle beyond that reason and the
 * block/unblock transitions below (this stage's prompt §12 explicitly rules out dependency graphs). */
export type Blocker = {
  readonly reason: string;
  readonly blockedAt: Instant;
};

export type Action = {
  readonly id: EntityId;
  readonly stageId: EntityId;
  readonly title: string;
  readonly doneWhen: string;
  readonly position: number;
  readonly status: ActionStatus;
  readonly blocker: Blocker | null;
  readonly version: Version;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
  readonly completedAt: Instant | null;
};

export const ACTION_TITLE_MAX = 200;
export const DONE_WHEN_MAX = 500;
export const BLOCKER_REASON_MAX = 300;

function normalizeTitle(title: string): DomainResult<string> {
  const trimmed = title.trim();
  if (trimmed.length === 0) return { ok: false, reason: "Action title must not be empty" };
  if (trimmed.length > ACTION_TITLE_MAX) {
    return { ok: false, reason: `Action title must be at most ${ACTION_TITLE_MAX} characters` };
  }
  return { ok: true, value: trimmed };
}

function normalizeDoneWhen(doneWhen: string): DomainResult<string> {
  const trimmed = doneWhen.trim();
  if (trimmed.length > DONE_WHEN_MAX) {
    return { ok: false, reason: `doneWhen must be at most ${DONE_WHEN_MAX} characters` };
  }
  return { ok: true, value: trimmed };
}

function normalizeReason(reason: string): DomainResult<string> {
  const trimmed = reason.trim();
  if (trimmed.length === 0) return { ok: false, reason: "Blocker reason must not be empty" };
  if (trimmed.length > BLOCKER_REASON_MAX) {
    return { ok: false, reason: `Blocker reason must be at most ${BLOCKER_REASON_MAX} characters` };
  }
  return { ok: true, value: trimmed };
}

export function createAction(input: {
  id: EntityId;
  stageId: EntityId;
  title: string;
  doneWhen: string;
  position: number;
  now: Instant;
}): DomainResult<Action> {
  const title = normalizeTitle(input.title);
  if (!title.ok) return title;
  const doneWhen = normalizeDoneWhen(input.doneWhen);
  if (!doneWhen.ok) return doneWhen;
  return {
    ok: true,
    value: {
      id: input.id,
      stageId: input.stageId,
      title: title.value,
      doneWhen: doneWhen.value,
      position: input.position,
      status: "open",
      blocker: null,
      version: 1,
      createdAt: input.now,
      updatedAt: input.now,
      completedAt: null,
    },
  };
}

export function editAction(
  action: Action,
  input: { title: string; doneWhen: string },
  now: Instant,
): DomainResult<Action> {
  if (action.status === "done") return { ok: false, reason: "Cannot edit a completed action" };
  const title = normalizeTitle(input.title);
  if (!title.ok) return title;
  const doneWhen = normalizeDoneWhen(input.doneWhen);
  if (!doneWhen.ok) return doneWhen;
  return {
    ok: true,
    value: { ...action, title: title.value, doneWhen: doneWhen.value, version: action.version + 1, updatedAt: now },
  };
}

export function blockAction(action: Action, reason: string, now: Instant): DomainResult<Action> {
  if (action.status === "done") return { ok: false, reason: "Cannot block a completed action" };
  const normalized = normalizeReason(reason);
  if (!normalized.ok) return normalized;
  return {
    ok: true,
    value: {
      ...action,
      status: "blocked",
      blocker: { reason: normalized.value, blockedAt: now },
      version: action.version + 1,
      updatedAt: now,
    },
  };
}

export function unblockAction(action: Action, now: Instant): DomainResult<Action> {
  if (action.status !== "blocked") return { ok: false, reason: "Action is not blocked" };
  return { ok: true, value: { ...action, status: "open", blocker: null, version: action.version + 1, updatedAt: now } };
}

export function completeAction(action: Action, now: Instant): DomainResult<Action> {
  if (action.status === "done") return { ok: false, reason: "Action is already completed" };
  if (action.status === "blocked") return { ok: false, reason: "Cannot complete a blocked action; unblock it first" };
  return {
    ok: true,
    value: { ...action, status: "done", completedAt: now, version: action.version + 1, updatedAt: now },
  };
}
