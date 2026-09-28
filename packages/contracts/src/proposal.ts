import { z } from "zod";
import { ActionStatusSchema } from "./action";
import { RationaleSchema } from "./plan";

const Id = z.uuid();
const Revision = z.int().nonnegative();
const StageTitle = z.string().trim().min(1).max(200);
const ActionTitle = z.string().trim().min(1).max(200);
const DoneWhen = z.string().trim().max(500);
const DesiredResult = z.string().trim().max(2000);
const Summary = z.string().trim().min(1).max(280);

/** A temporary name for an entity the proposal creates. At most 32 chars, so it can never be a UUID. */
const Ref = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,31}$/, "ref: letter, then letters/digits/_/-, max 32 chars");
/** Either an existing entity UUID or a ref declared in the same proposal. */
const IdOrRef = z.union([Id, Ref]);

// ─── AI-facing inputs (MCP) ──────────────────────────────────────────────────────────────────────

export const CreateRouteProposalInputSchema = z.strictObject({
  intentionId: Id,
  expectedRevision: Revision.describe("stateRevision from get_living_map_context; a mismatch returns CONFLICT_RELOAD"),
  summary: Summary.describe(
    "Short, plain-language reason to accept (2-4 lines): what this helps accomplish and why it's the useful next step. Shown by default as «Зачем это». No IDs, round numbers or implementation detail.",
  ),
  rationale: RationaleSchema.describe(
    "Full detailed reasoning, shown collapsed as «Подробнее о логике» for transparency/audit.",
  ),
  newStages: z
    .array(z.strictObject({ ref: Ref, title: StageTitle }))
    .max(20)
    .default([])
    .describe("Stages to create; refer to them elsewhere by ref"),
  stageEdits: z
    .array(z.strictObject({ stageId: Id, title: StageTitle }))
    .max(50)
    .default([])
    .describe("Rename existing Stages"),
  newActions: z
    .array(
      z.strictObject({
        ref: Ref,
        stage: IdOrRef.describe("Existing Stage id or a newStages ref"),
        title: ActionTitle,
        doneWhen: DoneWhen.describe("Observable condition that makes this Action done («готово, когда»)"),
      }),
    )
    .max(100)
    .default([]),
  actionEdits: z
    .array(z.strictObject({ actionId: Id, title: ActionTitle, doneWhen: DoneWhen }))
    .max(100)
    .default([])
    .describe("Change title/doneWhen of existing unfinished Actions"),
  stageOrder: z
    .array(IdOrRef)
    .max(100)
    .optional()
    .describe("Full resulting Stage sequence (every existing id + every new ref). Omit to append new Stages"),
  actionOrder: z
    .array(IdOrRef)
    .min(1)
    .max(200)
    .describe("The OrderedActionPlan: every unfinished Action of the resulting route exactly once, in execution order"),
});
export type CreateRouteProposalInput = z.infer<typeof CreateRouteProposalInputSchema>;

export const ProposeDesiredResultChangeInputSchema = z.strictObject({
  intentionId: Id,
  expectedRevision: Revision,
  desiredResult: DesiredResult.describe("What must become true for the Intention to count as embodied/completed"),
  summary: Summary.describe("Short, plain-language reason to accept, shown by default as «Зачем это»"),
  rationale: RationaleSchema.describe(
    "Full detailed reasoning, shown collapsed as «Подробнее о логике» for transparency/audit.",
  ),
});
export type ProposeDesiredResultChangeInput = z.infer<typeof ProposeDesiredResultChangeInputSchema>;

export const GetProposalInputSchema = z.strictObject({ id: Id });
export type GetProposalInput = z.infer<typeof GetProposalInputSchema>;

/** Desktop only (user-ui): accept / reject. Never exposed to MCP. */
export const ResolveProposalInputSchema = z.strictObject({ id: Id });
export type ResolveProposalInput = z.infer<typeof ResolveProposalInputSchema>;

// ─── Stored payloads (re-validated before being applied) ─────────────────────────────────────────

export const RoutePayloadSchema = z.strictObject({
  intentionId: Id,
  isFirstRoute: z.boolean(),
  newStages: z.array(z.strictObject({ id: Id, title: StageTitle })),
  stageEdits: z.array(z.strictObject({ id: Id, title: StageTitle })),
  newActions: z.array(z.strictObject({ id: Id, stageId: Id, title: ActionTitle, doneWhen: DoneWhen })),
  actionEdits: z.array(z.strictObject({ id: Id, title: ActionTitle, doneWhen: DoneWhen })),
  stageOrder: z.array(Id).nullable(),
  orderedActionIds: z.array(Id).min(1),
});
export type RoutePayload = z.infer<typeof RoutePayloadSchema>;

export const DesiredResultPayloadSchema = z.strictObject({
  intentionId: Id,
  desiredResult: DesiredResult,
  previousDesiredResult: z.string(),
});
export type DesiredResultPayload = z.infer<typeof DesiredResultPayloadSchema>;

// ─── Read models ─────────────────────────────────────────────────────────────────────────────────

/** The resulting route exactly as acceptance would write it (computed by the same domain function). */
export const RoutePreviewDtoSchema = z.object({
  stages: z.array(
    z.object({
      id: Id,
      title: z.string(),
      previousTitle: z.string().nullable(),
      isNew: z.boolean(),
      isCurrent: z.boolean(),
      actions: z.array(
        z.object({
          id: Id,
          title: z.string(),
          doneWhen: z.string(),
          status: ActionStatusSchema,
          previousTitle: z.string().nullable(),
          previousDoneWhen: z.string().nullable(),
          isNew: z.boolean(),
        }),
      ),
    }),
  ),
  order: z.array(z.object({ actionId: Id, title: z.string() })),
});
export type RoutePreviewDto = z.infer<typeof RoutePreviewDtoSchema>;

/** `pending` + changed planning context is reported as `stale` even before anyone tries to accept it. */
export const ProposalStatusSchema = z.enum(["pending", "accepted", "rejected", "stale"]);

const ProposalBase = z.object({
  id: Id,
  status: ProposalStatusSchema,
  createdBy: z.string(),
  createdAt: z.iso.datetime(),
  baseRevision: Revision,
  affectedEntityIds: z.array(Id),
  summary: z.string(),
  rationale: z.string(),
  resolvedAt: z.iso.datetime().nullable(),
  resolvedBy: z.string().nullable(),
});

export const ProposalDtoSchema = z.discriminatedUnion("kind", [
  ProposalBase.extend({
    kind: z.literal("route"),
    payload: RoutePayloadSchema,
    preview: RoutePreviewDtoSchema.nullable(),
  }),
  ProposalBase.extend({ kind: z.literal("desired_result"), payload: DesiredResultPayloadSchema }),
]);
export type ProposalDto = z.infer<typeof ProposalDtoSchema>;
