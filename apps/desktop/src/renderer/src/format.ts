import type { ImpactItemDto, ProjectProgressDto } from "@living-map/contracts";

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

export function formatDateRu(iso: string): string {
  return new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
}

export const PROJECT_LIMIT_TEXT =
  "У тебя уже три проекта в этом сезоне. Заверши, поставь на паузу или отпусти один, прежде чем добавлять новый.";
