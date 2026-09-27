import { describe, expect, it } from "vitest";
import { AppErrorSchema, EditGoodLifeConditionInputSchema } from "../src";
import { IPC_CHANNELS } from "../src/ipc";

const ID = "0192f5a0-0000-7000-8000-000000000001";

describe("contracts", () => {
  it("edit input requires expectedVersion and rejects unknown keys", () => {
    expect(EditGoodLifeConditionInputSchema.safeParse({ id: ID, text: "x" }).success).toBe(false);
    expect(
      EditGoodLifeConditionInputSchema.safeParse({ id: ID, text: "x", expectedVersion: 1, sql: "drop" }).success,
    ).toBe(false);
    expect(EditGoodLifeConditionInputSchema.safeParse({ id: ID, text: " x ", expectedVersion: 1 })).toMatchObject({
      success: true,
      data: { text: "x" },
    });
  });

  it("serialized error carries only code + message", () => {
    const parsed = AppErrorSchema.parse({ code: "CONFLICT_RELOAD", message: "reload", stack: "secret" });
    expect(parsed).toEqual({ code: "CONFLICT_RELOAD", message: "reload" });
  });

  it("IPC channels are a finite namespaced set", () => {
    for (const channel of Object.values(IPC_CHANNELS)) expect(channel).toMatch(/^lm:(query|command|event):\w+$/);
  });
});
