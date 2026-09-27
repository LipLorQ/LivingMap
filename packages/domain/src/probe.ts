import type { DomainResult, EntityId, Instant, Version } from "./types";

/**
 * Technical spike aggregate. It exists only to prove the process / storage /
 * concurrency architecture and carries no product meaning.
 */
export type Probe = {
  readonly id: EntityId;
  readonly title: string;
  readonly version: Version;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
};

export const PROBE_TITLE_MAX = 200;

function normalizeTitle(title: string): DomainResult<string> {
  const trimmed = title.trim();
  if (trimmed.length === 0) return { ok: false, reason: "Title must not be empty" };
  if (trimmed.length > PROBE_TITLE_MAX) {
    return { ok: false, reason: `Title must be at most ${PROBE_TITLE_MAX} characters` };
  }
  return { ok: true, value: trimmed };
}

export function createProbe(input: { id: EntityId; title: string; now: Instant }): DomainResult<Probe> {
  const title = normalizeTitle(input.title);
  if (!title.ok) return title;
  return {
    ok: true,
    value: { id: input.id, title: title.value, version: 1, createdAt: input.now, updatedAt: input.now },
  };
}

export function renameProbe(probe: Probe, newTitle: string, now: Instant): DomainResult<Probe> {
  const title = normalizeTitle(newTitle);
  if (!title.ok) return title;
  return { ok: true, value: { ...probe, title: title.value, version: probe.version + 1, updatedAt: now } };
}

export function isAtVersion(entity: { version: Version }, expected: Version): boolean {
  return entity.version === expected;
}
