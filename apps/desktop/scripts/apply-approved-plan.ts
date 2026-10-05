// Owner-authorized path for an owner-approved project plan (Stage 9, Day 1). The plan is designed OUTSIDE the
// app with the owner and handed over as JSON (ReplaceProjectPlanInput). This tool never invents or improves a
// plan: it validates it, shows exactly what would change (dry run, the default) and applies it only with
// `--apply <fingerprint>` of THAT dry run, through the normal application command `replaceProjectPlan` (actor
// user-ui: the owner's decision). If the project or the file changed since the dry run, nothing is applied.
// It never creates or migrates the database (like MCP) and never touches SQL directly.
//
//   node --import tsx apps/desktop/scripts/apply-approved-plan.ts <plan.json>                        # dry run
//   node --import tsx apps/desktop/scripts/apply-approved-plan.ts <plan.json> --apply <fingerprint>  # apply
import { readFileSync } from "node:fs";
import { createApplication } from "@living-map/application";
import { ApprovedProjectPlanSchema, type ProjectPlanReplacementDto, type Result } from "@living-map/contracts";
import {
  createSqliteStore,
  databaseFile,
  openMcpDatabase,
  resolveDataHome,
  systemClock,
  uuidGenerator,
} from "@living-map/persistence-sqlite";
import { z } from "zod";

export function runApprovedPlan(input: {
  databasePath: string;
  plan: unknown;
  /** The fingerprint printed by the dry run the owner approved; absent = dry run only. */
  applyFingerprint?: string | undefined;
}): Result<ProjectPlanReplacementDto> {
  const parsed = ApprovedProjectPlanSchema.safeParse(input.plan);
  if (!parsed.success)
    return { ok: false, error: { code: "VALIDATION_ERROR", message: z.prettifyError(parsed.error) } };
  const opened = openMcpDatabase(input.databasePath);
  if (opened.status === "missing") return { ok: false, error: { code: "NOT_FOUND", message: "Database not found" } };
  try {
    if (opened.status !== "ready") {
      return {
        ok: false,
        error: {
          code: "SCHEMA_INCOMPATIBLE",
          message: `Schema v${opened.schema.current}, expected v${opened.schema.expected}: open/update the desktop app first`,
        },
      };
    }
    const app = createApplication({
      store: createSqliteStore(opened.handle, uuidGenerator),
      clock: systemClock,
      ids: uuidGenerator,
    });
    return input.applyFingerprint
      ? app.commands.replaceProjectPlan(app.newContext("user-ui", "cli"), {
          ...parsed.data,
          expectedFingerprint: input.applyFingerprint,
        })
      : app.queries.previewProjectPlanReplacement(parsed.data);
  } finally {
    opened.handle.close();
  }
}

function describe(dto: ProjectPlanReplacementDto, applied: boolean): string {
  const lines = [
    `${applied ? "ПРИМЕНЕНО" : "ПРОБНЫЙ ПРОГОН (ничего не записано)"} — проект «${dto.projectTitle}»`,
    ...dto.stages.flatMap((stage, i) => [
      `  Этап ${i + 1}: ${stage.title}${stage.isCurrent ? " (текущий)" : ""}`,
      ...stage.actions.map(
        (a) => `    · ${a.title}${a.carried ? " [перенесено]" : ""}${a.status === "done" ? " ✓" : ""}`,
      ),
    ]),
    `Прежние этапы уходят в историю: ${dto.archivedStages.map((s) => `«${s.title}»`).join(", ") || "нет"}`,
    `Незавершённые прежние действия остаются в истории, неактивны (${dto.leftBehindActions.length}):`,
    ...dto.leftBehindActions.map((a) => `    · ${a.title}`),
    `Завершённые прежние действия остаются в истории как есть: ${dto.keptDoneActions}`,
    `Первое действие нового порядка: «${dto.firstAction.title}»`,
    applied ? `Отпечаток: ${dto.fingerprint}` : `Применить именно это: --apply ${dto.fingerprint}`,
  ];
  return lines.join("\n");
}

const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/apply-approved-plan.ts");
if (isMain) {
  const [planPath, ...flags] = process.argv.slice(2);
  const applyAt = flags.indexOf("--apply");
  const applyFingerprint = applyAt >= 0 ? flags[applyAt + 1] : undefined;
  if (!planPath || (applyAt >= 0 && !applyFingerprint)) {
    console.error("Usage: apply-approved-plan.ts <plan.json> [--apply <fingerprint from the dry run>]");
    process.exit(2);
  }
  const result = runApprovedPlan({
    databasePath: databaseFile(resolveDataHome()),
    plan: JSON.parse(readFileSync(planPath, "utf8")),
    applyFingerprint,
  });
  if (!result.ok) {
    console.error(`${result.error.code}: ${result.error.message}`);
    process.exit(1);
  }
  console.log(describe(result.value, applyFingerprint !== undefined));
}
