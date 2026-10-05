import type { DomainResult, EntityId, Instant, Version } from "./types";

export type HouseholdItemStatus = "active" | "done";

/**
 * «Быт» (Stage 9, Day 1): one small one-off errand of everyday life — «записаться к врачу», «отвезти байк в
 * ремонт». A side pocket, not a task manager: never an Action, never part of any project, order, `Сейчас`,
 * work time, Season count or AI ordering. Deliberately no priority, due date, recurrence, tags or subtasks.
 * Done items stay as minimal history.
 */
export type HouseholdItem = {
  readonly id: EntityId;
  readonly text: string;
  readonly status: HouseholdItemStatus;
  /** The «+» Capture the owner accepted this errand from, if any (provenance; the Capture itself is untouched). */
  readonly sourceCaptureId: EntityId | null;
  readonly version: Version;
  readonly createdAt: Instant;
  readonly completedAt: Instant | null;
};

export const HOUSEHOLD_TEXT_MAX = 300;

export function createHouseholdItem(input: {
  id: EntityId;
  text: string;
  sourceCaptureId: EntityId | null;
  now: Instant;
}): DomainResult<HouseholdItem> {
  const text = input.text.trim();
  if (text.length === 0) return { ok: false, reason: "Household item must not be empty" };
  if (text.length > HOUSEHOLD_TEXT_MAX) {
    return { ok: false, reason: `Household item must be at most ${HOUSEHOLD_TEXT_MAX} characters` };
  }
  return {
    ok: true,
    value: {
      id: input.id,
      text,
      status: "active",
      sourceCaptureId: input.sourceCaptureId,
      version: 1,
      createdAt: input.now,
      completedAt: null,
    },
  };
}

export function completeHouseholdItem(item: HouseholdItem, now: Instant): DomainResult<HouseholdItem> {
  if (item.status === "done") return { ok: false, reason: "Household item is already done" };
  return { ok: true, value: { ...item, status: "done", completedAt: now, version: item.version + 1 } };
}
