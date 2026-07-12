import { describe, expect, it, vi } from "vitest";
import { workProductService } from "../services/work-products.ts";

function createWorkProductRow(overrides: Partial<Record<string, unknown>> = {}) {
  const now = new Date("2026-03-17T00:00:00.000Z");
  return {
    id: "work-product-1",
    companyId: "company-1",
    projectId: "project-1",
    issueId: "issue-1",
    executionWorkspaceId: null,
    runtimeServiceId: null,
    type: "pull_request",
    provider: "github",
    externalId: null,
    title: "PR 1",
    url: "https://example.com/pr/1",
    status: "open",
    reviewState: "draft",
    isPrimary: true,
    healthStatus: "unknown",
    summary: null,
    metadata: null,
    createdByRunId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("workProductService", () => {
  const unlockedSelect = (rows: unknown[]) => ({
    from: vi.fn(() => ({
      where: vi.fn(async () => rows),
    })),
  });
  const lockedSelect = (rows: unknown[]) => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        for: vi.fn(async () => rows),
      })),
    })),
  });

  it("uses a transaction when creating a new primary work product", async () => {
    const updatedWhere = vi.fn(async () => undefined);
    const updateSet = vi.fn(() => ({ where: updatedWhere }));
    const txUpdate = vi.fn(() => ({ set: updateSet }));

    const insertedRow = createWorkProductRow();
    const insertReturning = vi.fn(async () => [insertedRow]);
    const insertValues = vi.fn(() => ({ returning: insertReturning }));
    const txInsert = vi.fn(() => ({ values: insertValues }));

    const txSelect = vi
      .fn()
      .mockImplementationOnce(() => lockedSelect([{
        status: "in_progress",
        assigneeAgentId: "agent-1",
        checkoutRunId: "run-1",
      }]))
      .mockImplementationOnce(() => lockedSelect([insertedRow]));
    const tx = {
      select: txSelect,
      update: txUpdate,
      insert: txInsert,
    };
    const transaction = vi.fn(async (callback: (input: typeof tx) => Promise<unknown>) => await callback(tx));

    const authorize = vi.fn();
    const svc = workProductService({ transaction } as any);
    const result = await svc.createForIssue(
      "issue-1",
      "company-1",
      {
        type: "pull_request",
        provider: "github",
        title: "PR 1",
        status: "open",
        reviewState: "draft",
        isPrimary: true,
      },
      authorize,
    );

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(txUpdate).toHaveBeenCalledTimes(1);
    expect(txInsert).toHaveBeenCalledTimes(1);
    expect(authorize).toHaveBeenCalledWith({
      issueStatus: "in_progress",
      assigneeAgentId: "agent-1",
      checkoutRunId: "run-1",
      existing: null,
      implicitlyUpdated: [expect.objectContaining({ id: "work-product-1" })],
    });
    expect(result?.id).toBe("work-product-1");
  });

  it("uses a transaction when promoting an existing work product to primary", async () => {
    const existingRow = createWorkProductRow({ isPrimary: false });

    const txSelect = vi
      .fn()
      .mockImplementationOnce(() => unlockedSelect([{
        issueId: existingRow.issueId,
        companyId: existingRow.companyId,
      }]))
      .mockImplementationOnce(() => lockedSelect([{
        status: "in_progress",
        assigneeAgentId: "agent-1",
        checkoutRunId: "run-1",
      }]))
      .mockImplementationOnce(() => lockedSelect([existingRow]))
      .mockImplementationOnce(() => lockedSelect([]));

    const updateReturning = vi
      .fn()
      .mockResolvedValue([createWorkProductRow({ reviewState: "ready_for_review" })]);
    const updateWhere = vi.fn(() => ({ returning: updateReturning }));
    const updateSet = vi.fn(() => ({ where: updateWhere }));
    const txUpdate = vi.fn(() => ({ set: updateSet }));

    const tx = {
      select: txSelect,
      update: txUpdate,
    };
    const transaction = vi.fn(async (callback: (input: typeof tx) => Promise<unknown>) => await callback(tx));

    const authorize = vi.fn();
    const svc = workProductService({ transaction } as any);
    const result = await svc.update(
      "work-product-1",
      {
        isPrimary: true,
        reviewState: "ready_for_review",
      },
      authorize,
    );

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(txSelect).toHaveBeenCalledTimes(4);
    expect(txUpdate).toHaveBeenCalledTimes(2);
    expect(authorize).toHaveBeenCalledWith({
      issueStatus: "in_progress",
      assigneeAgentId: "agent-1",
      checkoutRunId: "run-1",
      existing: expect.objectContaining({
        id: "work-product-1",
        reviewState: "draft",
      }),
      implicitlyUpdated: [],
    });
    expect(result?.reviewState).toBe("ready_for_review");
  });
  it("locks the issue and current evidence before removing a work product", async () => {
    const existingRow = createWorkProductRow();
    const txSelect = vi
      .fn()
      .mockImplementationOnce(() => unlockedSelect([{
        issueId: existingRow.issueId,
        companyId: existingRow.companyId,
      }]))
      .mockImplementationOnce(() => lockedSelect([{
        status: "in_progress",
        assigneeAgentId: "agent-1",
        checkoutRunId: "run-1",
      }]))
      .mockImplementationOnce(() => lockedSelect([existingRow]));

    const deleteReturning = vi.fn(async () => [existingRow]);
    const deleteWhere = vi.fn(() => ({ returning: deleteReturning }));
    const txDelete = vi.fn(() => ({ where: deleteWhere }));
    const tx = {
      select: txSelect,
      delete: txDelete,
    };
    const transaction = vi.fn(async (callback: (input: typeof tx) => Promise<unknown>) => await callback(tx));
    const authorize = vi.fn();

    const result = await workProductService({ transaction } as any).remove(
      "work-product-1",
      authorize,
    );

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(txSelect).toHaveBeenCalledTimes(3);
    expect(authorize).toHaveBeenCalledWith({
      issueStatus: "in_progress",
      assigneeAgentId: "agent-1",
      checkoutRunId: "run-1",
      existing: expect.objectContaining({ id: "work-product-1" }),
      implicitlyUpdated: [],
    });
    expect(txDelete).toHaveBeenCalledTimes(1);
    expect(result?.id).toBe("work-product-1");
  });
});
