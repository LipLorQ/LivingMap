import type { DomainResult, EntityId, Instant } from "./types";

export type MemoryType = "decision" | "fact" | "observation" | "preference" | "commitment" | "idea" | "note";

/** Something worth remembering for future decisions (Memory v1). Immutable; separate from the raw Capture. */
export type Memory = {
  readonly id: EntityId;
  readonly type: MemoryType;
  readonly text: string;
  readonly sourceCaptureId: EntityId | null;
  /**
   * Whether `sourceCaptureId` came from the trusted Capture-processing job context (`ctx.captureId`,
   * ARCHITECTURE §9/ADR-0007) rather than an AI-supplied argument from an untethered session (e.g. an
   * interactive Desktop-chat MCP connection, ADR-0004). Only a verified link is the SAME underlying
   * lived fact for Stage 7 Pattern-independence purposes (`review-evidence.ts`) — an unverified one is
   * still a real Stage-6 association (shown to the user), just not proof the two are one event.
   */
  readonly sourceCaptureVerified: boolean;
  readonly linkedEntityIds: readonly EntityId[];
  readonly createdBy: string;
  readonly createdAt: Instant;
};

export const MEMORY_TEXT_MAX = 2000;

export function createMemory(input: {
  id: EntityId;
  type: MemoryType;
  text: string;
  sourceCaptureId: EntityId | null;
  sourceCaptureVerified: boolean;
  linkedEntityIds: readonly EntityId[];
  createdBy: string;
  now: Instant;
}): DomainResult<Memory> {
  const text = input.text.trim();
  if (text.length === 0) return { ok: false, reason: "Memory text must not be empty" };
  if (text.length > MEMORY_TEXT_MAX)
    return { ok: false, reason: `Memory must be at most ${MEMORY_TEXT_MAX} characters` };
  return {
    ok: true,
    value: {
      id: input.id,
      type: input.type,
      text,
      sourceCaptureId: input.sourceCaptureId,
      sourceCaptureVerified: input.sourceCaptureId !== null && input.sourceCaptureVerified,
      linkedEntityIds: [...new Set(input.linkedEntityIds)],
      createdBy: input.createdBy,
      createdAt: input.now,
    },
  };
}

const words = (text: string): string[] => text.toLocaleLowerCase("ru").match(/[\p{L}\p{N}]+/gu) ?? [];

// ponytail: crude stem = first 5 letters of a long word ("разработку"/"разработка" match, "сон"/"сна" do not);
// swap for SQLite FTS5 or a real stemmer behind the same function if recall proves too low.
const stem = (word: string): string => (word.length > 5 ? word.slice(0, 5) : word);

/**
 * Deterministic local memory search: a memory scores one point per distinct query word whose stem starts
 * one of its words; ties go to the newest. An empty query returns the most recent memories.
 */
export function rankMemories(memories: readonly Memory[], query: string, limit: number): Memory[] {
  const newestFirst = [...memories].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const stems = [
    ...new Set(
      words(query)
        .filter((w) => w.length >= 3)
        .map(stem),
    ),
  ];
  if (stems.length === 0) return newestFirst.slice(0, limit);
  return newestFirst
    .map((memory) => {
      const own = words(memory.text);
      return { memory, score: stems.filter((s) => own.some((w) => w.startsWith(s))).length };
    })
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score) // stable: equal scores keep newest-first
    .slice(0, limit)
    .map((hit) => hit.memory);
}
