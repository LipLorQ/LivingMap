import type { DomainResult, EntityId, Instant, Version } from "./types";

export type RoutineKind = "morning" | "evening";

/**
 * One item of a stable daily routine (Stage 8). Routines are infrastructure of the day, not work:
 * never an Action, never part of an OrderedActionPlan, never counted as work time or Season progress.
 * Deliberately no recurrence, streaks or completion tracking.
 */
export type RoutineItem = {
  readonly id: EntityId;
  readonly kind: RoutineKind;
  readonly text: string;
  readonly position: number;
  readonly active: boolean;
  readonly version: Version;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
};

export const ROUTINE_TEXT_MAX = 120;
/** A routine is a short anchor of the day, not a task list. */
export const ROUTINE_MAX_ITEMS_PER_KIND = 10;

function normalizeText(text: string): DomainResult<string> {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ok: false, reason: "Routine item must not be empty" };
  if (trimmed.length > ROUTINE_TEXT_MAX) {
    return { ok: false, reason: `Routine item must be at most ${ROUTINE_TEXT_MAX} characters` };
  }
  return { ok: true, value: trimmed };
}

export function createRoutineItem(input: {
  id: EntityId;
  kind: RoutineKind;
  text: string;
  /** Existing items of the same kind. */
  siblingCount: number;
  now: Instant;
}): DomainResult<RoutineItem> {
  if (input.siblingCount >= ROUTINE_MAX_ITEMS_PER_KIND) {
    return { ok: false, reason: `A routine holds at most ${ROUTINE_MAX_ITEMS_PER_KIND} items` };
  }
  const text = normalizeText(input.text);
  if (!text.ok) return text;
  return {
    ok: true,
    value: {
      id: input.id,
      kind: input.kind,
      text: text.value,
      position: input.siblingCount + 1,
      active: true,
      version: 1,
      createdAt: input.now,
      updatedAt: input.now,
    },
  };
}

export function editRoutineItem(
  item: RoutineItem,
  input: { text?: string | undefined; active?: boolean | undefined },
  now: Instant,
): DomainResult<RoutineItem> {
  const text = input.text === undefined ? { ok: true as const, value: item.text } : normalizeText(input.text);
  if (!text.ok) return text;
  const active = input.active ?? item.active;
  if (text.value === item.text && active === item.active) return { ok: false, reason: "Nothing to change" };
  return { ok: true, value: { ...item, text: text.value, active, version: item.version + 1, updatedAt: now } };
}
