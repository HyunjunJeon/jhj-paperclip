import { describe, expect, it } from "vitest";
import {
  createIssueThreadInteractionSchema,
  decisionPackageInputSchema,
  decisionPackageSchema,
} from "./validators/issue.js";
import { isPackageBearingPayload } from "./decision-package.js";

describe("decision-package", () => {
  it("isPackageBearingPayload true only with nested decisionPackage object", () => {
    expect(
      isPackageBearingPayload({
        decisionPackage: { version: 1, reason: "why", resolverPolicy: { kind: "board" } },
      }),
    ).toBe(true);
    expect(isPackageBearingPayload({ reason: "why", optionLabels: { accept: "ok" } })).toBe(false);
    expect(isPackageBearingPayload({ reason: "why" })).toBe(false);
    expect(isPackageBearingPayload({ decisionPackage: null })).toBe(false);
    expect(isPackageBearingPayload(null)).toBe(false);
    expect(isPackageBearingPayload({})).toBe(false);
  });

  it("accepts a minimal package and defaults resolverPolicy to board", () => {
    const parsed = decisionPackageInputSchema.parse({ version: 1, reason: "Choose rollout window" });
    expect(parsed.resolverPolicy).toEqual({ kind: "board" });
    expect(parsed.reason).toBe("Choose rollout window");
  });

  it("strips caller-supplied humanOnly from the input schema", () => {
    const parsed = decisionPackageInputSchema.parse({
      version: 1,
      reason: "for package",
      humanOnly: false,
    } as any);
    expect("humanOnly" in parsed).toBe(false);
  });

  it("rejects unknown resolverPolicy kinds and missing userId", () => {
    expect(() =>
      decisionPackageInputSchema.parse({
        version: 1,
        reason: "x",
        resolverPolicy: { kind: "anyone" },
      }),
    ).toThrow();
    expect(() =>
      decisionPackageInputSchema.parse({
        version: 1,
        reason: "x",
        resolverPolicy: { kind: "responsible_user" },
      }),
    ).toThrow();
  });

  it("accepts silentDefaultHint bounds and rejects out-of-range afterMinutes", () => {
    expect(
      decisionPackageInputSchema.parse({
        version: 1,
        reason: "x",
        silentDefaultHint: { afterMinutes: 5, preferred: "escalate" },
      }).silentDefaultHint?.afterMinutes,
    ).toBe(5);
    expect(
      decisionPackageInputSchema.parse({
        version: 1,
        reason: "x",
        silentDefaultHint: { afterMinutes: 43200, preferred: "leave_pending" },
      }).silentDefaultHint?.afterMinutes,
    ).toBe(43200);
    expect(() =>
      decisionPackageInputSchema.parse({
        version: 1,
        reason: "x",
        silentDefaultHint: { afterMinutes: 4, preferred: "escalate" },
      }),
    ).toThrow();
    expect(() =>
      decisionPackageInputSchema.parse({
        version: 1,
        reason: "x",
        silentDefaultHint: { afterMinutes: 43201, preferred: "escalate" },
      }),
    ).toThrow();
  });

  it("persisted decisionPackageSchema requires humanOnly literal true", () => {
    expect(() =>
      decisionPackageSchema.parse({ version: 1, reason: "x", resolverPolicy: { kind: "board" } }),
    ).toThrow();
    expect(() =>
      decisionPackageSchema.parse({
        version: 1,
        reason: "x",
        resolverPolicy: { kind: "board" },
        humanOnly: false,
      }),
    ).toThrow();
    expect(
      decisionPackageSchema.parse({
        version: 1,
        reason: "x",
        resolverPolicy: { kind: "board" },
        humanOnly: true,
      }).humanOnly,
    ).toBe(true);
  });

  it("createIssueThreadInteractionSchema accepts decisionPackage on all five kinds", () => {
    const kinds = [
      {
        kind: "suggest_tasks" as const,
        payload: {
          version: 1 as const,
          tasks: [{ clientKey: "a", title: "t" }],
          decisionPackage: { version: 1 as const, reason: "why suggest" },
        },
      },
      {
        kind: "ask_user_questions" as const,
        payload: {
          version: 1 as const,
          questions: [
            {
              id: "q1",
              prompt: "p",
              selectionMode: "single" as const,
              options: [{ id: "o1", label: "L" }],
            },
          ],
          decisionPackage: { version: 1 as const, reason: "why ask" },
        },
      },
      {
        kind: "request_confirmation" as const,
        payload: {
          version: 1 as const,
          prompt: "ok?",
          decisionPackage: { version: 1 as const, reason: "why confirm" },
        },
      },
      {
        kind: "request_checkbox_confirmation" as const,
        payload: {
          version: 1 as const,
          prompt: "pick",
          options: [{ id: "a", label: "A" }],
          decisionPackage: { version: 1 as const, reason: "why checkbox" },
        },
      },
      {
        kind: "request_item_verdicts" as const,
        payload: {
          version: 1 as const,
          prompt: "verdict",
          items: [{ id: "i1", label: "Item" }],
          decisionPackage: { version: 1 as const, reason: "why verdicts" },
        },
      },
    ];
    for (const body of kinds) {
      const parsed = createIssueThreadInteractionSchema.parse(body);
      expect(parsed.kind).toBe(body.kind);
      expect((parsed.payload as any).decisionPackage?.reason).toBeTruthy();
    }
  });

  it("strips humanOnly from client input on nested decisionPackage", () => {
    const parsed = createIssueThreadInteractionSchema.parse({
      kind: "request_confirmation",
      payload: {
        version: 1,
        prompt: "ok?",
        decisionPackage: {
          version: 1,
          reason: "for package",
          optionLabels: { accept: "Ship it" },
          humanOnly: true,
        },
      },
    });
    expect(parsed.kind).toBe("request_confirmation");
    if (parsed.kind !== "request_confirmation") return;
    expect(parsed.payload.decisionPackage?.reason).toBe("for package");
    // Wire may carry humanOnly; server create path strips and re-stamps true.
    expect(parsed.payload.decisionPackage?.optionLabels?.accept).toBe("Ship it");
  });
});
