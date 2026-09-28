import type { DomainResult, EntityId, Instant } from "./types";

/** Only the kinds Stage 3 needs. Season / Good Life Conditions changes have no AI path at all yet. */
export type ProposalKind = "route" | "desired_result";

export type ProposalStatus = "pending" | "accepted" | "rejected" | "stale";

/**
 * A strategic change the AI wants but may not apply (ARCHITECTURE §23–24). `payload` is opaque to
 * the domain: the application validates it against the typed contract schema for `kind` both when
 * the proposal is created and again right before it is applied.
 */
export type Proposal = {
  readonly id: EntityId;
  readonly kind: ProposalKind;
  readonly status: ProposalStatus;
  readonly createdBy: string;
  readonly createdAt: Instant;
  readonly baseRevision: number;
  /** planningFingerprint() of the context the proposal was built on; any difference ⇒ stale. */
  readonly baseFingerprint: string;
  readonly affectedEntityIds: readonly EntityId[];
  readonly payload: unknown;
  /** Short decision-oriented explanation shown by default («Зачем это»). */
  readonly summary: string;
  /** Full reasoning, shown collapsed for transparency/audit («Подробнее о логике»). */
  readonly rationale: string;
  readonly resolvedAt: Instant | null;
  readonly resolvedBy: string | null;
};

export const PROPOSAL_RATIONALE_MAX = 4000;
export const PROPOSAL_SUMMARY_MAX = 280;
export const MAX_PENDING_PROPOSALS = 10;

export function createProposal(input: {
  id: EntityId;
  kind: ProposalKind;
  createdBy: string;
  baseRevision: number;
  baseFingerprint: string;
  affectedEntityIds: readonly EntityId[];
  payload: unknown;
  summary: string;
  rationale: string;
  now: Instant;
}): DomainResult<Proposal> {
  const summary = input.summary.trim();
  if (summary.length === 0) return { ok: false, reason: "Proposal summary must not be empty" };
  if (summary.length > PROPOSAL_SUMMARY_MAX) {
    return { ok: false, reason: `Proposal summary must be at most ${PROPOSAL_SUMMARY_MAX} characters` };
  }
  const rationale = input.rationale.trim();
  if (rationale.length === 0) return { ok: false, reason: "Proposal rationale must not be empty" };
  if (rationale.length > PROPOSAL_RATIONALE_MAX) {
    return { ok: false, reason: `Proposal rationale must be at most ${PROPOSAL_RATIONALE_MAX} characters` };
  }
  return {
    ok: true,
    value: {
      id: input.id,
      kind: input.kind,
      status: "pending",
      createdBy: input.createdBy,
      createdAt: input.now,
      baseRevision: input.baseRevision,
      baseFingerprint: input.baseFingerprint,
      affectedEntityIds: [...new Set(input.affectedEntityIds)],
      payload: input.payload,
      summary,
      rationale,
      resolvedAt: null,
      resolvedBy: null,
    },
  };
}

/** pending → accepted | rejected | stale. Every other transition is illegal. */
export function resolveProposal(
  proposal: Proposal,
  status: Exclude<ProposalStatus, "pending">,
  actor: string,
  now: Instant,
): DomainResult<Proposal> {
  if (proposal.status !== "pending") {
    return { ok: false, reason: `Proposal is already ${proposal.status}` };
  }
  return { ok: true, value: { ...proposal, status, resolvedAt: now, resolvedBy: actor } };
}

/**
 * Order-independent identity of "the world a strategic proposal reasoned about": every entity's id
 * and version. Any edit, addition, removal, completion or reorder changes it — deliberately
 * conservative, because strategic proposals are never silently rebased.
 */
export function planningFingerprint(entities: readonly { readonly id: EntityId; readonly version: number }[]): string {
  return entities
    .map((e) => `${e.id}@${e.version}`)
    .sort()
    .join(",");
}
