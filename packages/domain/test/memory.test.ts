import { describe, expect, it } from "vitest";
import { CAPTURE_TEXT_MAX, createCapture, createMemory, type Memory, rankMemories } from "../src";

const memory = (text: string, createdAt: string, id = createdAt): Memory => ({
  id,
  type: "preference",
  text,
  sourceCaptureId: null,
  sourceCaptureVerified: false,
  linkedEntityIds: [],
  createdBy: "mcp-ai",
  createdAt,
});

describe("Capture", () => {
  it("keeps the raw text exactly as typed (no trimming) and starts pending", () => {
    const r = createCapture({ id: "c1", rawText: "  Завтра в 15:00 стоматолог\n", now: "2026-09-28T10:00:00.000Z" });
    expect(r).toMatchObject({
      ok: true,
      value: { rawText: "  Завтра в 15:00 стоматолог\n", state: "pending", attempts: 0 },
    });
  });

  it("rejects empty and oversized input", () => {
    expect(createCapture({ id: "c", rawText: " \n ", now: "t" }).ok).toBe(false);
    expect(createCapture({ id: "c", rawText: "x".repeat(CAPTURE_TEXT_MAX + 1), now: "t" }).ok).toBe(false);
  });
});

describe("Memory", () => {
  it("trims text and de-duplicates links", () => {
    const r = createMemory({
      id: "m",
      type: "fact",
      text: "  факт  ",
      sourceCaptureId: null,
      sourceCaptureVerified: false,
      linkedEntityIds: ["a", "a", "b"],
      createdBy: "mcp-ai",
      now: "t",
    });
    expect(r).toMatchObject({ ok: true, value: { text: "факт", linkedEntityIds: ["a", "b"] } });
  });

  it("sourceCaptureVerified can never be true without a sourceCaptureId (M-A: no provenance without a link)", () => {
    const r = createMemory({
      id: "m",
      type: "fact",
      text: "x",
      sourceCaptureId: null,
      sourceCaptureVerified: true,
      linkedEntityIds: [],
      createdBy: "mcp-ai",
      now: "t",
    });
    expect(r).toMatchObject({ ok: true, value: { sourceCaptureId: null, sourceCaptureVerified: false } });
  });

  it("sourceCaptureVerified is carried through as given when a sourceCaptureId is present", () => {
    const r = createMemory({
      id: "m",
      type: "fact",
      text: "x",
      sourceCaptureId: "c1",
      sourceCaptureVerified: true,
      linkedEntityIds: [],
      createdBy: "mcp-ai",
      now: "t",
    });
    expect(r).toMatchObject({ ok: true, value: { sourceCaptureId: "c1", sourceCaptureVerified: true } });
  });

  it("resurfaces an old constraint for a later, differently worded request (Russian, case-insensitive)", () => {
    const old = memory("Я не хочу превращать разработку в работу на весь день.", "2026-09-01T10:00:00.000Z", "old");
    const noise = memory("Идея: снять видео про дисциплину", "2026-09-20T10:00:00.000Z", "noise");
    const hits = rankMemories([noise, old], "Помоги перестроить мой ДЕНЬ, работа не идёт", 5);
    expect(hits.map((m) => m.id)).toEqual(["old"]);
  });

  it("ranks by matched words, then newest; empty query = most recent", () => {
    const a = memory("сон важнее работы", "2026-09-01T00:00:00.000Z", "a");
    const b = memory("сон и спорт", "2026-09-02T00:00:00.000Z", "b");
    const c = memory("про работу", "2026-09-03T00:00:00.000Z", "c");
    expect(rankMemories([a, b, c], "сон работа", 5).map((m) => m.id)).toEqual(["a", "c", "b"]);
    expect(rankMemories([a, b, c], "", 2).map((m) => m.id)).toEqual(["c", "b"]);
    expect(rankMemories([a, b, c], "бухгалтерия", 5)).toEqual([]);
  });
});
