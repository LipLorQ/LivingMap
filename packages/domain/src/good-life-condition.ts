import type { DomainResult, EntityId, Instant, Version } from "./types";

/**
 * A lightweight user-defined constraint describing what must remain true for life to still feel
 * good while pursuing the Season. Context for decisions, not a KPI or enforcement mechanism.
 */
export type GoodLifeCondition = {
  readonly id: EntityId;
  readonly text: string;
  readonly position: number;
  readonly version: Version;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
};

export const CONDITION_TEXT_MAX = 300;

function normalizeText(text: string): DomainResult<string> {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ok: false, reason: "Condition text must not be empty" };
  if (trimmed.length > CONDITION_TEXT_MAX) {
    return { ok: false, reason: `Condition text must be at most ${CONDITION_TEXT_MAX} characters` };
  }
  return { ok: true, value: trimmed };
}

export function createGoodLifeCondition(input: {
  id: EntityId;
  text: string;
  position: number;
  now: Instant;
}): DomainResult<GoodLifeCondition> {
  const text = normalizeText(input.text);
  if (!text.ok) return text;
  return {
    ok: true,
    value: {
      id: input.id,
      text: text.value,
      position: input.position,
      version: 1,
      createdAt: input.now,
      updatedAt: input.now,
    },
  };
}

export function editGoodLifeCondition(
  condition: GoodLifeCondition,
  text: string,
  now: Instant,
): DomainResult<GoodLifeCondition> {
  const normalized = normalizeText(text);
  if (!normalized.ok) return normalized;
  return { ok: true, value: { ...condition, text: normalized.value, version: condition.version + 1, updatedAt: now } };
}
