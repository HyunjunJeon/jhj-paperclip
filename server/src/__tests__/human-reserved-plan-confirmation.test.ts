import { describe, expect, it } from "vitest";
import { isHumanReservedPlanConfirmation } from "../services/task-watchdogs.js";

describe("isHumanReservedPlanConfirmation (S6 branch B)", () => {
  it("reserves nested decisionPackage payloads", () => {
    expect(
      isHumanReservedPlanConfirmation({
        version: 1,
        prompt: "ok?",
        decisionPackage: { version: 1, reason: "human wait", humanOnly: true },
      }),
    ).toBe(true);
  });

  it("does not reserve legacy flat reason-only payloads", () => {
    expect(isHumanReservedPlanConfirmation({ version: 1, prompt: "ok?", reason: "legacy" })).toBe(false);
  });

  it("does not reserve plain confirmations", () => {
    expect(isHumanReservedPlanConfirmation({ version: 1, prompt: "ok?" })).toBe(false);
  });
});
