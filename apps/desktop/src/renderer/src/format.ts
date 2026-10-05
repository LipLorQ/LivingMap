import type { ImpactItemDto, ProjectProgressDto } from "@living-map/contracts";

/**
 * True once the local calendar day of `nowMs` differs from the day the figures were computed on
 * (`computedAt`): «Сегодня» / «За неделю» then belong to a day that is over and must be re-read.
 */
export function isLaterLocalDay(computedAt: string, nowMs: number): boolean {
  return new Date(computedAt).toDateString() !== new Date(nowMs).toDateString();
}

/** Russian plural: pluralRu(2, ["этап", "этапа", "этапов"]). */
export function pluralRu(n: number, forms: readonly [string, string, string]): string {
  const mod100 = n % 100;
  const mod10 = n % 10;
  if (mod100 >= 11 && mod100 <= 14) return forms[2];
  if (mod10 === 1) return forms[0];
  if (mod10 >= 2 && mod10 <= 4) return forms[1];
  return forms[2];
}

/** «Этап 3 из 7 · 4 из 6 действий» — counts of explicit things only, never a percentage. */
export function formatProgress(progress: ProjectProgressDto): string {
  const parts: string[] = [];
  if (progress.stageIndex !== null) parts.push(`Этап ${progress.stageIndex} из ${progress.stageCount}`);
  else if (progress.stageCount > 0)
    parts.push(`${progress.stageCount} ${pluralRu(progress.stageCount, ["этап", "этапа", "этапов"])}`);
  if (progress.actionsTotal > 0) {
    parts.push(
      `${progress.actionsDone} из ${progress.actionsTotal} ${pluralRu(progress.actionsTotal, ["действия", "действий", "действий"])}`,
    );
  }
  return parts.length > 0 ? parts.join(" · ") : "Пока без маршрута";
}

/** «2026–2035», or a single year. */
export function formatYears(startYear: number, endYear: number): string {
  return startYear === endYear ? `${startYear}` : `${startYear}–${endYear}`;
}

/** The owner's own name of a period («25–34», «До следующего дня рождения») when there is one, else its years. */
export function formatPeriod(label: string | null, startYear: number, endYear: number): string {
  return label ?? formatYears(startYear, endYear);
}

/** One affected thing in plain Russian: «Этот год: MVP», «Проект «X» (3 этапа, 12 действий в работе)». */
export function describeImpact(item: ImpactItemDto): string {
  switch (item.kind) {
    case "horizon":
      return `Ближайшие 3 года: ${item.label}`;
    case "year":
      return `Этот год: ${item.label}`;
    case "season":
      return `Этот сезон: ${item.label}`;
    case "project": {
      if (item.stageCount === 0 && item.unfinishedActionCount === 0) return `Проект «${item.label}» (ещё без маршрута)`;
      const stages = `${item.stageCount} ${pluralRu(item.stageCount, ["этап", "этапа", "этапов"])}`;
      const actions = `${item.unfinishedActionCount} ${pluralRu(item.unfinishedActionCount, ["действие", "действия", "действий"])} в работе`;
      return `Проект «${item.label}» (${stages}, ${actions})`;
    }
  }
}

/** A civil calendar day: what the owner calls «5 октября 2026». */
export type CivilDay = { readonly year: number; readonly month: number; readonly day: number };

const MONTHS_GENITIVE = [
  "января",
  "февраля",
  "марта",
  "апреля",
  "мая",
  "июня",
  "июля",
  "августа",
  "сентября",
  "октября",
  "ноября",
  "декабря",
] as const;

/** The civil day of `iso` in `timeZone`. Digits only from Intl (en-CA is fixed `YYYY-MM-DD`), never localized text. */
export function civilDayOf(iso: string, timeZone: string): CivilDay {
  const [year, month, day] = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(new Date(iso))
    .split("-")
    .map(Number) as [number, number, number];
  return { year, month, day };
}

const monthRu = (d: CivilDay) => MONTHS_GENITIVE[d.month - 1] as string;
const yearRu = (d: CivilDay) => `${String(d.year % 100).padStart(2, "0")}г`;

/** `5 октября 26г` (Stage 9, Day 1 — the owner's own format; never browser-locale output). */
export function formatDayRu(d: CivilDay): string {
  return `${d.day} ${monthRu(d)} ${yearRu(d)}`;
}

/**
 * Inclusive range of days, as compact as stays unambiguous: `5–10 октября 26г`, `28 сентября – 4 октября 26г`,
 * `29 декабря 26г – 4 января 27г`; one day is just `5 октября 26г`.
 */
export function formatDayRangeRu(from: CivilDay, to: CivilDay): string {
  if (from.year !== to.year) return `${formatDayRu(from)} – ${formatDayRu(to)}`;
  if (from.month !== to.month) return `${from.day} ${monthRu(from)} – ${to.day} ${monthRu(to)} ${yearRu(to)}`;
  if (from.day !== to.day) return `${from.day}–${to.day} ${monthRu(to)} ${yearRu(to)}`;
  return formatDayRu(from);
}

/** A Review's period in the owner's words. `periodEnd` is exclusive: the last day shown is the one it includes. */
export function formatReviewPeriod(review: { periodStart: string; periodEnd: string; timeZone: string }): string {
  const lastIncluded = new Date(new Date(review.periodEnd).getTime() - 1).toISOString();
  return formatDayRangeRu(civilDayOf(review.periodStart, review.timeZone), civilDayOf(lastIncluded, review.timeZone));
}

export function formatDateRu(iso: string): string {
  return new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
}

export const PROJECT_LIMIT_TEXT =
  "У тебя уже три проекта в этом сезоне. Заверши, поставь на паузу или отпусти один, прежде чем добавлять новый.";
