import { test, expect } from "@playwright/test";
import {
  setupCollabCompany,
  cleanupCollabCompany,
  createIssue,
  agentPatch,
  agentCheckoutAndPatch,
  type CollabCompany,
} from "./helpers/collab";

/**
 * E2E: Signoff execution policy flow.
 *
 * Validates the full signoff lifecycle through the API and UI:
 *   1. Create a company with executor + reviewer + approver agents
 *   2. Create an issue with a two-stage execution policy (review → approval)
 *   3. Executor marks done → issue routes to reviewer (in_review)
 *   4. Reviewer approves → issue routes to approver
 *   5. Approver approves → execution completes, issue marked done
 *   6. Verify "changes requested" flow returns to executor
 *
 * Requires local_trusted deployment mode (set in playwright.config.ts webServer env).
 *
 * Setup/teardown and the agent-auth request machinery (board + agent API
 * keys + heartbeat invoke; checkout-then-PATCH for the executor vs. direct
 * PATCH for reviewer/approver) live in `./helpers/collab` — see that file's
 * JSDoc for the full flow. This spec was the extraction source for that
 * harness; it now consumes it.
 */

const COMPANY_NAME = `E2E-Signoff-${Date.now()}`;

async function createIssueWithPolicy(ctx: CollabCompany, title: string, stages?: unknown[]) {
  const defaultStages = [
    { type: "review", participants: [{ type: "agent", agentId: ctx.agents.reviewer.agentId }] },
    { type: "approval", participants: [{ type: "agent", agentId: ctx.agents.approver.agentId }] },
  ];
  return createIssue(
    ctx.boardRequest,
    ctx.companyId,
    {
      title,
      status: "in_progress",
      assigneeAgentId: ctx.agents.executor.agentId,
      executionPolicy: { stages: stages ?? defaultStages },
    },
    ctx,
  );
}

test.describe("Signoff execution policy", () => {
  let ctx: CollabCompany;

  test.beforeAll(async () => {
    ctx = await setupCollabCompany({
      name: COMPANY_NAME,
      agents: [
        { key: "executor", name: "Executor", role: "engineer", title: "Software Engineer" },
        { key: "reviewer", name: "Reviewer", role: "qa", title: "QA Engineer" },
        { key: "approver", name: "Approver", role: "cto", title: "CTO" },
      ],
    });
  });

  test.afterAll(async () => {
    await cleanupCollabCompany(ctx);
  });

  test("happy path: executor → review → approval → done", async ({ page }) => {
    const issue = await createIssueWithPolicy(ctx, "Signoff happy path");
    const issueId = issue.id;

    // Verify policy was saved
    expect(issue.executionPolicy).toBeTruthy();
    expect(issue.executionPolicy.stages).toHaveLength(2);
    expect(issue.executionPolicy.stages[0].type).toBe("review");
    expect(issue.executionPolicy.stages[1].type).toBe("approval");

    // Step 1: Executor marks done → should route to reviewer
    const step1Res = await agentCheckoutAndPatch(
      ctx.boardRequest, ctx.agents.executor, issueId, ["in_progress"],
      { status: "done", comment: "Implemented the feature, ready for review." },
    );
    expect(step1Res.ok()).toBe(true);
    const step1Issue = await step1Res.json();

    expect(step1Issue.status).toBe("in_review");
    expect(step1Issue.assigneeAgentId).toBe(ctx.agents.reviewer.agentId);
    expect(step1Issue.executionState).toBeTruthy();
    expect(step1Issue.executionState.status).toBe("pending");
    expect(step1Issue.executionState.currentStageType).toBe("review");
    expect(step1Issue.executionState.returnAssignee).toMatchObject({
      type: "agent",
      agentId: ctx.agents.executor.agentId,
    });

    // Step 2: Navigate to issue in UI and verify execution label
    await page.goto(`/${ctx.companyPrefix}/issues/${issue.identifier}`);
    await expect(page.locator("text=Review pending")).toBeVisible({ timeout: 10_000 });

    // Step 3: Reviewer approves → should route to approver
    const step3Res = await agentPatch(
      ctx.boardRequest, ctx.agents.reviewer, issueId,
      { status: "done", comment: "QA signoff complete. Looks good." },
    );
    expect(step3Res.ok()).toBe(true);
    const step3Issue = await step3Res.json();

    expect(step3Issue.status).toBe("in_review");
    expect(step3Issue.assigneeAgentId).toBe(ctx.agents.approver.agentId);
    expect(step3Issue.executionState.status).toBe("pending");
    expect(step3Issue.executionState.currentStageType).toBe("approval");
    expect(step3Issue.executionState.completedStageIds).toHaveLength(1);

    // Step 4: Verify UI shows approval pending
    await page.reload();
    await expect(page.locator("text=Approval pending")).toBeVisible({ timeout: 10_000 });

    // Step 5: Approver approves → should complete
    const step5Res = await agentPatch(
      ctx.boardRequest, ctx.agents.approver, issueId,
      { status: "done", comment: "Approved. Ship it." },
    );
    expect(step5Res.ok()).toBe(true);
    const step5Issue = await step5Res.json();

    expect(step5Issue.status).toBe("done");
    expect(step5Issue.executionState.status).toBe("completed");
    expect(step5Issue.executionState.completedStageIds).toHaveLength(2);
    expect(step5Issue.executionState.lastDecisionOutcome).toBe("approved");
  });

  test("changes requested: reviewer bounces back to executor", async () => {
    const issue = await createIssueWithPolicy(ctx, "Signoff changes requested");
    const issueId = issue.id;

    // Executor marks done → routes to reviewer
    const doneRes = await agentCheckoutAndPatch(
      ctx.boardRequest, ctx.agents.executor, issueId, ["in_progress"],
      { status: "done", comment: "Ready for review." },
    );
    expect(doneRes.ok()).toBe(true);
    expect((await doneRes.json()).status).toBe("in_review");

    // Reviewer requests changes → returns to executor
    const changesRes = await agentPatch(
      ctx.boardRequest, ctx.agents.reviewer, issueId,
      { status: "in_progress", comment: "Needs another pass on edge cases." },
    );
    expect(changesRes.ok()).toBe(true);
    const changesIssue = await changesRes.json();

    expect(changesIssue.status).toBe("in_progress");
    expect(changesIssue.assigneeAgentId).toBe(ctx.agents.executor.agentId);
    expect(changesIssue.executionState.status).toBe("changes_requested");
    expect(changesIssue.executionState.lastDecisionOutcome).toBe("changes_requested");

    // Executor re-submits → goes back to reviewer (same stage)
    const resubmitRes = await agentCheckoutAndPatch(
      ctx.boardRequest, ctx.agents.executor, issueId, ["in_progress"],
      { status: "done", comment: "Fixed the edge cases." },
    );
    expect(resubmitRes.ok()).toBe(true);
    const resubmitIssue = await resubmitRes.json();

    expect(resubmitIssue.status).toBe("in_review");
    expect(resubmitIssue.assigneeAgentId).toBe(ctx.agents.reviewer.agentId);
    expect(resubmitIssue.executionState.status).toBe("pending");
    expect(resubmitIssue.executionState.currentStageType).toBe("review");
  });

  test("comment required: approval without comment fails", async () => {
    const issue = await createIssueWithPolicy(ctx, "Signoff comment required");
    const issueId = issue.id;

    // Executor marks done → routes to reviewer
    const doneRes = await agentCheckoutAndPatch(
      ctx.boardRequest, ctx.agents.executor, issueId, ["in_progress"],
      { status: "done", comment: "Done." },
    );
    expect(doneRes.ok()).toBe(true);
    const doneIssue = await doneRes.json();
    expect(doneIssue.status).toBe("in_review");
    expect(doneIssue.assigneeAgentId).toBe(ctx.agents.reviewer.agentId);

    // Reviewer tries to approve without comment → should fail
    const noCommentRes = await agentPatch(
      ctx.boardRequest, ctx.agents.reviewer, issueId,
      { status: "done" },
    );
    expect(noCommentRes.ok()).toBe(false);
    const errorBody = await noCommentRes.json();
    expect(JSON.stringify(errorBody)).toContain("comment");
  });

  test("non-participant cannot advance stage", async () => {
    const issue = await createIssueWithPolicy(ctx, "Signoff access control");
    const issueId = issue.id;

    // Executor marks done → routes to reviewer
    const doneRes = await agentCheckoutAndPatch(
      ctx.boardRequest, ctx.agents.executor, issueId, ["in_progress"],
      { status: "done", comment: "Done." },
    );
    expect(doneRes.ok()).toBe(true);

    // Verify issue is in_review with reviewer
    const issueRes = await ctx.boardRequest.get(`/api/issues/${issueId}`);
    const inReviewIssue = await issueRes.json();
    expect(inReviewIssue.status).toBe("in_review");
    expect(inReviewIssue.assigneeAgentId).toBe(ctx.agents.reviewer.agentId);
    expect(inReviewIssue.executionState.currentStageType).toBe("review");

    // Non-participant (approver at this stage) tries to advance → should be rejected
    const advanceRes = await agentPatch(
      ctx.boardRequest, ctx.agents.approver, issueId,
      { status: "done", comment: "I'm the approver, not the reviewer." },
    );
    expect(advanceRes.ok()).toBe(false);
    expect(advanceRes.status()).toBeGreaterThanOrEqual(400);
  });

  test("review-only policy: reviewer approval completes execution", async () => {
    const issue = await createIssueWithPolicy(ctx, "Signoff review-only", [
      { type: "review", participants: [{ type: "agent", agentId: ctx.agents.reviewer.agentId }] },
    ]);

    // Executor marks done → routes to reviewer
    const doneRes = await agentCheckoutAndPatch(
      ctx.boardRequest, ctx.agents.executor, issue.id, ["in_progress"],
      { status: "done", comment: "Ready for review." },
    );
    expect(doneRes.ok()).toBe(true);
    expect((await doneRes.json()).status).toBe("in_review");

    // Reviewer approves → should complete immediately (no approval stage)
    const approveRes = await agentPatch(
      ctx.boardRequest, ctx.agents.reviewer, issue.id,
      { status: "done", comment: "LGTM." },
    );
    expect(approveRes.ok()).toBe(true);
    const doneIssue = await approveRes.json();
    expect(doneIssue.status).toBe("done");
    expect(doneIssue.executionState.status).toBe("completed");
    expect(doneIssue.executionState.completedStageIds).toHaveLength(1);
  });
});
