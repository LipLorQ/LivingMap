import type { DomainResult, EntityId, Instant, Version } from "./types";

/**
 * The far strategic layers of the one Living Map (Stage 8): a sparse plan by decades, one current
 * 3-year horizon, one current year direction. Far = coarse: every statement is deliberately short, and
 * each layer carries one short "why it matters" sentence linking it to the layer above.
 */

export const MIN_STRATEGY_YEAR = 1900;
export const MAX_STRATEGY_YEAR = 2200;
export const DECADE_STATEMENT_MAX = 120;
export const DECADE_PLAN_MAX_ITEMS = 12;
/** A decade/range spans at most this many calendar years (inclusive). */
export const DECADE_MAX_SPAN_YEARS = 10;
export const HORIZON_SPAN_YEARS = 3;
export const STRATEGY_TEXT_MAX = 200;

/** One very short statement for one decade/range of years. Ordered by `startYear`; ranges never overlap. */
export type DecadePlanItem = {
  readonly id: EntityId;
  readonly startYear: number;
  readonly endYear: number;
  readonly statement: string;
  readonly version: Version;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
};

/** The one current 3-year direction. `endYear` is always `startYear + 2`. */
export type ThreeYearHorizon = {
  readonly id: EntityId;
  readonly startYear: number;
  readonly endYear: number;
  readonly direction: string;
  /** One short sentence: why this matters for the decade direction. May be empty. */
  readonly whyItMatters: string;
  readonly version: Version;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
};

/** The one current year direction. */
export type YearDirection = {
  readonly id: EntityId;
  readonly year: number;
  readonly direction: string;
  /** One short sentence: why this matters for the 3-year horizon. May be empty. */
  readonly whyItMatters: string;
  readonly version: Version;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
};

function normalizeRequired(text: string, max: number, label: string): DomainResult<string> {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ok: false, reason: `${label} must not be empty` };
  if (trimmed.length > max) return { ok: false, reason: `${label} must be at most ${max} characters` };
  return { ok: true, value: trimmed };
}

function normalizeOptional(text: string, max: number, label: string): DomainResult<string> {
  const trimmed = text.trim();
  if (trimmed.length > max) return { ok: false, reason: `${label} must be at most ${max} characters` };
  return { ok: true, value: trimmed };
}

function validateYear(year: number, label: string): DomainResult<number> {
  if (!Number.isInteger(year) || year < MIN_STRATEGY_YEAR || year > MAX_STRATEGY_YEAR) {
    return { ok: false, reason: `${label} must be a year between ${MIN_STRATEGY_YEAR} and ${MAX_STRATEGY_YEAR}` };
  }
  return { ok: true, value: year };
}

/** Decades in their natural order. */
export function sortDecadePlan<T extends { startYear: number; endYear: number }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.startYear - b.startYear || a.endYear - b.endYear);
}

/** True when the two inclusive year ranges share at least one year. */
export function yearRangesOverlap(
  a: { startYear: number; endYear: number },
  b: { startYear: number; endYear: number },
): boolean {
  return a.startYear <= b.endYear && b.startYear <= a.endYear;
}

function validateDecadeRange(
  startYear: number,
  endYear: number,
  others: readonly { startYear: number; endYear: number }[],
): DomainResult<null> {
  const start = validateYear(startYear, "Start year");
  if (!start.ok) return start;
  const end = validateYear(endYear, "End year");
  if (!end.ok) return end;
  if (endYear < startYear) return { ok: false, reason: "End year must not be before the start year" };
  if (endYear - startYear + 1 > DECADE_MAX_SPAN_YEARS) {
    return { ok: false, reason: `A decade range spans at most ${DECADE_MAX_SPAN_YEARS} years` };
  }
  if (others.some((o) => yearRangesOverlap(o, { startYear, endYear }))) {
    return { ok: false, reason: "Decade ranges must not overlap" };
  }
  return { ok: true, value: null };
}

export function createDecadeItem(input: {
  id: EntityId;
  startYear: number;
  endYear: number;
  statement: string;
  /** Every other existing item (overlap and count checks). */
  others: readonly DecadePlanItem[];
  now: Instant;
}): DomainResult<DecadePlanItem> {
  if (input.others.length >= DECADE_PLAN_MAX_ITEMS) {
    return { ok: false, reason: `The decade plan holds at most ${DECADE_PLAN_MAX_ITEMS} items` };
  }
  const statement = normalizeRequired(input.statement, DECADE_STATEMENT_MAX, "Decade statement");
  if (!statement.ok) return statement;
  const range = validateDecadeRange(input.startYear, input.endYear, input.others);
  if (!range.ok) return range;
  return {
    ok: true,
    value: {
      id: input.id,
      startYear: input.startYear,
      endYear: input.endYear,
      statement: statement.value,
      version: 1,
      createdAt: input.now,
      updatedAt: input.now,
    },
  };
}

/** MODE A — same meaning, better words: only the statement changes, never the years. */
export function rewordDecadeItem(item: DecadePlanItem, statement: string, now: Instant): DomainResult<DecadePlanItem> {
  const normalized = normalizeRequired(statement, DECADE_STATEMENT_MAX, "Decade statement");
  if (!normalized.ok) return normalized;
  return { ok: true, value: { ...item, statement: normalized.value, version: item.version + 1, updatedAt: now } };
}

/** MODE B — the direction itself changes (statement and/or years). `others` excludes `item` itself. */
export function reviseDecadeItem(
  item: DecadePlanItem,
  input: { startYear: number; endYear: number; statement: string },
  others: readonly DecadePlanItem[],
  now: Instant,
): DomainResult<DecadePlanItem> {
  const statement = normalizeRequired(input.statement, DECADE_STATEMENT_MAX, "Decade statement");
  if (!statement.ok) return statement;
  const range = validateDecadeRange(input.startYear, input.endYear, others);
  if (!range.ok) return range;
  return {
    ok: true,
    value: {
      ...item,
      startYear: input.startYear,
      endYear: input.endYear,
      statement: statement.value,
      version: item.version + 1,
      updatedAt: now,
    },
  };
}

export function createHorizon(input: {
  id: EntityId;
  startYear: number;
  direction: string;
  whyItMatters: string;
  now: Instant;
}): DomainResult<ThreeYearHorizon> {
  const start = validateYear(input.startYear, "Start year");
  if (!start.ok) return start;
  if (input.startYear + HORIZON_SPAN_YEARS - 1 > MAX_STRATEGY_YEAR) {
    return { ok: false, reason: `Start year must leave room for ${HORIZON_SPAN_YEARS} years` };
  }
  const direction = normalizeRequired(input.direction, STRATEGY_TEXT_MAX, "Horizon direction");
  if (!direction.ok) return direction;
  const why = normalizeOptional(input.whyItMatters, STRATEGY_TEXT_MAX, "Why it matters");
  if (!why.ok) return why;
  return {
    ok: true,
    value: {
      id: input.id,
      startYear: input.startYear,
      endYear: input.startYear + HORIZON_SPAN_YEARS - 1,
      direction: direction.value,
      whyItMatters: why.value,
      version: 1,
      createdAt: input.now,
      updatedAt: input.now,
    },
  };
}

export function rewordHorizon(
  horizon: ThreeYearHorizon,
  input: { direction: string; whyItMatters: string },
  now: Instant,
): DomainResult<ThreeYearHorizon> {
  const direction = normalizeRequired(input.direction, STRATEGY_TEXT_MAX, "Horizon direction");
  if (!direction.ok) return direction;
  const why = normalizeOptional(input.whyItMatters, STRATEGY_TEXT_MAX, "Why it matters");
  if (!why.ok) return why;
  return {
    ok: true,
    value: {
      ...horizon,
      direction: direction.value,
      whyItMatters: why.value,
      version: horizon.version + 1,
      updatedAt: now,
    },
  };
}

export function reviseHorizon(
  horizon: ThreeYearHorizon,
  input: { startYear: number; direction: string; whyItMatters: string },
  now: Instant,
): DomainResult<ThreeYearHorizon> {
  const created = createHorizon({ id: horizon.id, ...input, now });
  if (!created.ok) return created;
  return {
    ok: true,
    value: { ...created.value, version: horizon.version + 1, createdAt: horizon.createdAt },
  };
}

export function createYearDirection(input: {
  id: EntityId;
  year: number;
  direction: string;
  whyItMatters: string;
  now: Instant;
}): DomainResult<YearDirection> {
  const year = validateYear(input.year, "Year");
  if (!year.ok) return year;
  const direction = normalizeRequired(input.direction, STRATEGY_TEXT_MAX, "Year direction");
  if (!direction.ok) return direction;
  const why = normalizeOptional(input.whyItMatters, STRATEGY_TEXT_MAX, "Why it matters");
  if (!why.ok) return why;
  return {
    ok: true,
    value: {
      id: input.id,
      year: input.year,
      direction: direction.value,
      whyItMatters: why.value,
      version: 1,
      createdAt: input.now,
      updatedAt: input.now,
    },
  };
}

export function rewordYearDirection(
  year: YearDirection,
  input: { direction: string; whyItMatters: string },
  now: Instant,
): DomainResult<YearDirection> {
  const direction = normalizeRequired(input.direction, STRATEGY_TEXT_MAX, "Year direction");
  if (!direction.ok) return direction;
  const why = normalizeOptional(input.whyItMatters, STRATEGY_TEXT_MAX, "Why it matters");
  if (!why.ok) return why;
  return {
    ok: true,
    value: { ...year, direction: direction.value, whyItMatters: why.value, version: year.version + 1, updatedAt: now },
  };
}

export function reviseYearDirection(
  year: YearDirection,
  input: { year: number; direction: string; whyItMatters: string },
  now: Instant,
): DomainResult<YearDirection> {
  const created = createYearDirection({ id: year.id, ...input, now });
  if (!created.ok) return created;
  return { ok: true, value: { ...created.value, version: year.version + 1, createdAt: year.createdAt } };
}

/** The decade statements a horizon's years fall into — the derived (never stored) link upward. */
export function decadesServedBy(
  horizon: Pick<ThreeYearHorizon, "startYear" | "endYear">,
  decadePlan: readonly DecadePlanItem[],
): DecadePlanItem[] {
  return sortDecadePlan(decadePlan.filter((d) => yearRangesOverlap(d, horizon)));
}
