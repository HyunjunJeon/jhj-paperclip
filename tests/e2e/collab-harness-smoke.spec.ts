import { test, expect, type APIRequestContext } from "@playwright/test";
import {
  E2E_BASE_URL,
  setupCollabCompany,
  cleanupCollabCompany,
  createIssue,
  resolveInteraction,
  getAttentionItems,
  expectAttentionExit,
  seedWorkProduct,
  invokeHeartbeat,
  getIssueRunLockState,
  type AgentAuth,
  type CreateInteractionBody,
  type InteractionRecord,
  type CollabCompany,
} from "./helpers/collab";

/**
 * Creating an issue with a non-backlog status and an assignee fires a real
 * (fire-and-forget) assignment wakeup for the assignee agent
 * (issue-assignment-wakeup.ts, queued from issues.ts:7244), which races to
 * check the issue out via its own process-adapter run. On in_progress issues,
 * the interactions route enforces run-ownership (assertCheckoutOwner in
 * issues.ts), so posting with an independently invoked run id can conflict
 * with whatever run currently holds the checkout (observed: 409 "Issue run
 * ownership conflict") — and, since the background run's own completion is
 * finalized asynchronously (observed in server logs: "skipping late run
 * finalization because the run already left running state"), the lock
 * holder can also flip between reading it and using it.
 *
 * `createInteraction` (tests/e2e/helpers/collab.ts) has no equivalent to
 * `retryAgentPatchWithCurrentLockOnConflict`'s "current lock holder" retry
 * for this route, and it can't be adapted to retry here anyway — its
 * internal `expect(res.ok())` throws on the very 409 this needs to catch.
 * [B1 gap, noted in report.] This local retry re-samples the lock (or mints
 * a fresh run if nothing holds it) before each attempt, mirroring that same
 * established harness pattern, and asserts the raw 201 the brief's step 2
 * wants.
 */
async function createRequestConfirmationWithLockRetry(
  board: APIRequestContext,
  issueId: string,
  agent: AgentAuth,
  body: CreateInteractionBody,
  opts: { maxAttempts?: number; retryDelayMs?: number } = {},
): Promise<InteractionRecord> {
  const maxAttempts = opts.maxAttempts ?? 5;
  const retryDelayMs = opts.retryDelayMs ?? 250;
  let lastStatus = -1;
  let lastBody = "";
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    const lock = await getIssueRunLockState(board, issueId);
    const runId = lock.checkoutRunId ?? lock.executionRunId ?? (await invokeHeartbeat(board, agent.agentId));
    const res = await agent.request.post(`${E2E_BASE_URL}/api/issues/${issueId}/interactions`, {
      headers: { "X-Paperclip-Run-Id": runId },
      data: body,
    });
    if (res.status() === 201) return res.json();
    lastStatus = res.status();
    lastBody = await res.text();
    if (res.status() !== 409) break;
  }
  throw new Error(
    `createRequestConfirmationWithLockRetry: exhausted ${maxAttempts} attempts on issue ${issueId}; ` +
      `last response ${lastStatus}: ${lastBody}`,
  );
}

/**
 * E2E: Collab harness smoke.
 *
 * First consumer (and end-to-end proof) of `tests/e2e/helpers/collab.ts`.
 * Walks the full request_confirmation lifecycle through the API and UI —
 * agent asks, attention lists it, board resolves it, attention exits — plus
 * a board-seeded work-product smoke check. No live LLM (plan §4.2): agents
 * run a process adapter that exits immediately, driven via board + agent
 * API keys and heartbeat invoke.
 *
 * Requires local_trusted deployment mode (set in playwright.config.ts
 * webServer env).
 */

test.describe("Collab harness smoke", { tag: "@collab" }, () => {
  let ctx: CollabCompany;

  test.beforeAll(async () => {
    ctx = await setupCollabCompany({
      name: `E2E-CollabSmoke-${Date.now()}`,
      agents: [{ key: "worker", name: "Worker", role: "engineer", title: "Software Engineer" }],
    });
  });

  test.afterAll(async () => {
    await cleanupCollabCompany(ctx);
  });

  test("request_confirmation: agent asks, attention lists it, board resolves, attention exits", async ({ page }) => {
    // Step 1: create an in-progress issue assigned to the worker agent.
    const issue = await createIssue(
      ctx.boardRequest,
      ctx.companyId,
      {
        title: "Collab harness smoke",
        status: "in_progress",
        assigneeAgentId: ctx.agents.worker.agentId,
      },
      ctx,
    );

    // Step 2: worker agent asks for confirmation (POST /issues/:id/interactions).
    // See `createRequestConfirmationWithLockRetry` above for why this doesn't
    // go through the `createInteraction` helper directly.
    const interaction = await createRequestConfirmationWithLockRetry(ctx.boardRequest, issue.id, ctx.agents.worker, {
      kind: "request_confirmation",
      payload: { version: 1, prompt: "Confirm the collab harness smoke run?" },
    });
    expect(interaction.status).toBe("pending");
    // Schema default for request_confirmation (packages/shared/src/validators/issue.ts:1041).
    expect(interaction.continuationPolicy).toBe("none");

    // Step 3: attention feed lists exactly this interaction.
    const items = await getAttentionItems(ctx.boardRequest, ctx.companyId, {
      sourceKind: "issue_thread_interaction",
      subjectId: interaction.id,
    });
    expect(items).toHaveLength(1);
    expect(items[0].subject.kind).toBe("interaction");
    expect(items[0].inlineResolvable).toBe(true);
    expect(items[0].entryRule).toBe("issue_thread_interactions.status = 'pending'");

    // Step 4: UI smoke only after API state is settled.
    await page.goto(`/${ctx.companyPrefix}/issues/${issue.identifier}`);
    await expect(page.getByText("Confirm the collab harness smoke run?")).toBeVisible({ timeout: 10_000 });

    // Step 5: negative authz — agent actors cannot resolve issue-thread
    // interactions through this board-only route, even with a fresh run id.
    //
    // Stage 1 changes this deliberately: pre-code-decisions.md Q11 (decision
    // resolver authority) replaces this unconditional board-only guard with a
    // `resolverPolicy`-based check; this test freezes today's behavior
    // (today's guard: server/src/routes/issues.ts:3603).
    const workerRunId = await invokeHeartbeat(ctx.boardRequest, ctx.agents.worker.agentId);
    const agentAcceptRes = await ctx.agents.worker.request.post(
      `${E2E_BASE_URL}/api/issues/${issue.id}/interactions/${interaction.id}/accept`,
      { headers: { "X-Paperclip-Run-Id": workerRunId }, data: {} },
    );
    expect(agentAcceptRes.status()).toBe(403);
    expect(await agentAcceptRes.text()).toContain("board-only");

    // Step 6: board resolves the interaction.
    const resolved = await resolveInteraction(ctx.boardRequest, issue.id, interaction.id, { action: "accept" });
    expect(resolved.status).toBe("accepted");
    expect(resolved.result?.outcome).toBe("accepted");

    // Step 7: attention exits — the feed selects only `status = 'pending'` rows.
    await expectAttentionExit(ctx.boardRequest, ctx.companyId, {
      sourceKind: "issue_thread_interaction",
      subjectId: interaction.id,
    });

    // Step 8: resolved !== deleted — GET /interactions still lists the row.
    const listRes = await ctx.boardRequest.get(`${E2E_BASE_URL}/api/issues/${issue.id}/interactions`);
    expect(listRes.ok()).toBe(true);
    const list: Array<{ id: string; status: string }> = await listRes.json();
    const row = list.find((item) => item.id === interaction.id);
    expect(row).toBeTruthy();
    expect(row?.status).toBe("accepted");
  });

  test("seedWorkProduct: board-seeded artifact appears on the issue", async () => {
    const issue = await createIssue(
      ctx.boardRequest,
      ctx.companyId,
      {
        title: "Collab harness smoke - work product",
        status: "in_progress",
        assigneeAgentId: ctx.agents.worker.agentId,
      },
      ctx,
    );

    const workProduct = await seedWorkProduct(ctx.boardRequest, issue.id);
    expect(workProduct.type).toBe("artifact");

    const listRes = await ctx.boardRequest.get(`${E2E_BASE_URL}/api/issues/${issue.id}/work-products`);
    expect(listRes.ok()).toBe(true);
    const list: Array<{ id: string }> = await listRes.json();
    expect(list.some((item) => item.id === workProduct.id)).toBe(true);
  });
});
