import { z } from "zod";

const Id = z.uuid();
const Version = z.int().positive();
const Year = z.int().min(1900).max(2200);
const Statement = z.string().trim().min(1).max(120);
const Direction = z.string().trim().min(1).max(200);
/** One short sentence linking a layer to the one above. Empty is allowed (optional link). */
const Why = z.string().trim().max(200);
const Timestamp = z.iso.datetime();

export const CourseLevelSchema = z.enum(["decade", "horizon", "year", "season"]);
export type CourseLevel = z.infer<typeof CourseLevelSchema>;

/** A recorded fact that something real was reached — never an estimate or a percentage. */
export const EvidenceItemDtoSchema = z.object({
  kind: z.enum(["project_completed", "season_closed"]),
  text: z.string(),
  at: Timestamp,
});
export type EvidenceItemDto = z.infer<typeof EvidenceItemDtoSchema>;

export const DecadePlanItemDtoSchema = z.object({
  id: Id,
  startYear: Year,
  endYear: Year,
  statement: z.string(),
  version: Version,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  evidence: z.array(EvidenceItemDtoSchema),
});
export type DecadePlanItemDto = z.infer<typeof DecadePlanItemDtoSchema>;

export const HorizonDtoSchema = z.object({
  id: Id,
  startYear: Year,
  endYear: Year,
  direction: z.string(),
  whyItMatters: z.string(),
  version: Version,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  /** Which decade statements these three years fall into (derived from the years, never stored). */
  decadeItemIds: z.array(Id),
  evidence: z.array(EvidenceItemDtoSchema),
});
export type HorizonDto = z.infer<typeof HorizonDtoSchema>;

export const YearDirectionDtoSchema = z.object({
  id: Id,
  year: Year,
  direction: z.string(),
  whyItMatters: z.string(),
  version: Version,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  /** False once the calendar year has moved on: the owner should set this year's direction. */
  isCurrentYear: z.boolean(),
  evidence: z.array(EvidenceItemDtoSchema),
});
export type YearDirectionDto = z.infer<typeof YearDirectionDtoSchema>;

/** One layer or project a change of course may affect. Described, never rewritten. */
export const ImpactItemDtoSchema = z.object({
  kind: z.enum(["horizon", "year", "season", "project"]),
  id: Id,
  label: z.string(),
  stageCount: z.int().nonnegative(),
  unfinishedActionCount: z.int().nonnegative(),
});
export type ImpactItemDto = z.infer<typeof ImpactItemDtoSchema>;

export const CourseImpactDtoSchema = z.object({
  level: CourseLevelSchema,
  targetId: Id.nullable(),
  items: z.array(ImpactItemDtoSchema),
  /** Hand it back with the change: the change is only applied against the impact that was shown. */
  fingerprint: z.string(),
});
export type CourseImpactDto = z.infer<typeof CourseImpactDtoSchema>;

/** «Курс изменён, нижние уровни ещё не пересмотрены»: open until the owner says it is rebuilt. */
export const CourseChangeDtoSchema = z.object({
  id: Id,
  level: CourseLevelSchema,
  targetId: Id,
  summary: z.string(),
  changedAt: Timestamp,
  /** What may still need a second look, computed live from today's state. */
  impact: z.array(ImpactItemDtoSchema),
});
export type CourseChangeDto = z.infer<typeof CourseChangeDtoSchema>;

/** The whole far-to-near causal line above the projects, as one read model (the Full Map and the main screen share it). */
export const StrategyDtoSchema = z.object({
  currentYear: z.int(),
  decadePlan: z.array(DecadePlanItemDtoSchema),
  horizon: HorizonDtoSchema.nullable(),
  year: YearDirectionDtoSchema.nullable(),
  /** "Завершено 2 из 3 проектов сезона" — a count of explicit projects; null with no projects. */
  seasonProgress: z.object({ completed: z.int().nonnegative(), total: z.int().positive() }).nullable(),
  seasonEvidence: z.array(EvidenceItemDtoSchema),
  openCourseChanges: z.array(CourseChangeDtoSchema),
});
export type StrategyDto = z.infer<typeof StrategyDtoSchema>;

// ─── Commands (desktop only) ─────────────────────────────────────────────────────────────────────

/**
 * MODE A `wording`: same meaning, better words — nothing below is looked at. MODE B `course`: the
 * meaning changes — it must carry the `fingerprint` of the impact the owner was shown (`previewCourseImpact`).
 * Creating a layer that does not exist yet needs neither. Editing an existing one needs `mode`.
 */
const EditMode = z.enum(["wording", "course"]);
const Fingerprint = z.string().max(4000);
const Edit = { mode: EditMode.optional(), impactFingerprint: Fingerprint.optional() };

export const SaveStrategyInputSchema = z.discriminatedUnion("level", [
  z.strictObject({
    level: z.literal("decade"),
    /** Absent = add a new decade item. */
    id: Id.optional(),
    expectedVersion: Version.optional(),
    startYear: Year,
    endYear: Year,
    statement: Statement,
    ...Edit,
  }),
  z.strictObject({
    level: z.literal("horizon"),
    /** Absent = set the very first 3-year horizon. */
    expectedVersion: Version.optional(),
    startYear: Year,
    direction: Direction,
    whyItMatters: Why,
    ...Edit,
  }),
  z.strictObject({
    level: z.literal("year"),
    expectedVersion: Version.optional(),
    year: Year,
    direction: Direction,
    whyItMatters: Why,
    ...Edit,
  }),
]);
export type SaveStrategyInput = z.infer<typeof SaveStrategyInputSchema>;

export const RemoveDecadeItemInputSchema = z.strictObject({
  id: Id,
  expectedVersion: Version,
  impactFingerprint: Fingerprint.optional(),
});
export type RemoveDecadeItemInput = z.infer<typeof RemoveDecadeItemInputSchema>;

/** For a decade, `startYear`/`endYear` are the years the statement is being moved to (moving into the chain matters too). */
export const PreviewCourseImpactInputSchema = z.strictObject({
  level: CourseLevelSchema,
  targetId: Id.optional(),
  startYear: Year.optional(),
  endYear: Year.optional(),
});
export type PreviewCourseImpactInput = z.infer<typeof PreviewCourseImpactInputSchema>;

export const ResolveCourseChangeInputSchema = z.strictObject({ id: Id });
export type ResolveCourseChangeInput = z.infer<typeof ResolveCourseChangeInputSchema>;

// ─── History ─────────────────────────────────────────────────────────────────────────────────────

export const ClosedProjectDtoSchema = z.object({
  id: Id,
  title: z.string(),
  desiredResult: z.string(),
  status: z.enum(["completed", "released"]),
  closedAt: Timestamp,
});
export type ClosedProjectDto = z.infer<typeof ClosedProjectDtoSchema>;

export const PastSeasonDtoSchema = z.object({
  id: Id,
  focus: z.string(),
  whyItMatters: z.string(),
  startedAt: Timestamp,
  endedAt: Timestamp,
  /** Projects completed or released while that season lasted. */
  closedProjects: z.array(ClosedProjectDtoSchema),
});
export type PastSeasonDto = z.infer<typeof PastSeasonDtoSchema>;

/** Past seasons (newest first) and the projects closed during the current one. */
export const StrategyHistoryDtoSchema = z.object({
  pastSeasons: z.array(PastSeasonDtoSchema),
  currentSeasonClosedProjects: z.array(ClosedProjectDtoSchema),
});
export type StrategyHistoryDto = z.infer<typeof StrategyHistoryDtoSchema>;
