import { describe, expect, it } from "vitest";
import { completeHouseholdItem, createHouseholdItem, HOUSEHOLD_TEXT_MAX } from "../src";

const NOW = "2026-10-05T12:00:00.000Z";

describe("«Быт» item (Stage 9 Day 1)", () => {
  it("is just text, active until done, then done with a timestamp", () => {
    const created = createHouseholdItem({ id: "h", text: "  позвонить маме ", sourceCaptureId: null, now: NOW });
    expect(created).toEqual({
      ok: true,
      value: {
        id: "h",
        text: "позвонить маме",
        status: "active",
        sourceCaptureId: null,
        version: 1,
        createdAt: NOW,
        completedAt: null,
      },
    });
    if (!created.ok) return;
    const done = completeHouseholdItem(created.value, "2026-10-05T13:00:00.000Z");
    expect(done).toMatchObject({
      ok: true,
      value: { status: "done", completedAt: "2026-10-05T13:00:00.000Z", version: 2 },
    });
    if (done.ok) expect(completeHouseholdItem(done.value, NOW)).toMatchObject({ ok: false });
  });

  it("refuses empty or overlong text", () => {
    expect(createHouseholdItem({ id: "h", text: "   ", sourceCaptureId: null, now: NOW })).toMatchObject({ ok: false });
    expect(
      createHouseholdItem({ id: "h", text: "x".repeat(HOUSEHOLD_TEXT_MAX + 1), sourceCaptureId: null, now: NOW }),
    ).toMatchObject({ ok: false });
  });
});
