import { describe, expect, it } from "vitest";
import { createIssueThreadInteractionSchema } from "./validators/issue.js";
import { isPackageBearingPayload } from "./decision-package.js";

describe("decision-package", () => {
  it("isPackageBearingPayload true/false cases", () => {
    expect(isPackageBearingPayload({ reason: "why", optionLabels: { accept: "ok" } })).toBe(true);
    expect(isPackageBearingPayload({ reason: "why", resolverPolicy: { kind: "board" } })).toBe(true);
    expect(isPackageBearingPayload({ reason: "why", requiredArtifacts: [{ kind: "work_product", id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }] })).toBe(true);
    expect(isPackageBearingPayload({ reason: "why", estimatedHumanMinutes: 5 })).toBe(true);
    expect(isPackageBearingPayload({ reason: "why", humanOnly: true })).toBe(true);
    expect(isPackageBearingPayload({ reason: "why" })).toBe(false);
    expect(isPackageBearingPayload({ optionLabels: { accept: "x" } })).toBe(false);
    expect(isPackageBearingPayload(null)).toBe(false);
    expect(isPackageBearingPayload({})).toBe(false);
  });

  it("strips humanOnly from client input on payload (not in output)", () => {
    const parsed = createIssueThreadInteractionSchema.parse({
      kind: "request_confirmation",
      payload: {
        version: 1,
        prompt: "ok?",
        humanOnly: true,
        reason: "for package",
        optionLabels: {},
      },
    });
    expect(parsed.kind).toBe("request_confirmation");
    if (parsed.kind !== "request_confirmation") return;
    expect("humanOnly" in parsed.payload).toBe(false);
    expect(parsed.payload.reason).toBe("for package");
  });

  it("parses request_confirmation with reason+resolverPolicy", () => {
    const policy = { kind: "responsible_user", userId: "11111111-1111-4111-8111-111111111111" } as const;
    const parsed = createIssueThreadInteractionSchema.parse({
      kind: "request_confirmation",
      payload: {
        version: 1,
        prompt: "Confirm?",
        reason: "Plan looks good, please apply.",
        resolverPolicy: policy,
      },
    });
    expect(parsed.kind).toBe("request_confirmation");
    if (parsed.kind !== "request_confirmation") return;
    expect(parsed.payload.reason).toBe("Plan looks good, please apply.");
    expect(parsed.payload.resolverPolicy).toEqual(policy);
    expect("humanOnly" in parsed.payload).toBe(false);
  });
});
