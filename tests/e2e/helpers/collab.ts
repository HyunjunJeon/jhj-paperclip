import { expect, request as pwRequest, type APIRequestContext, type APIResponse } from "@playwright/test";

/**
 * Reusable harness for collab E2E specs (board + agent API keys + heartbeat
 * invoke; no live LLM — see plan §4.2).
 *
 * Extracted from `tests/e2e/signoff-policy.spec.ts` (see per-helper JSDoc for
 * the originating line ranges). Functions marked "New" have no extraction
 * source; their JSDoc names the target server route instead.
 *
 * Agent auth flow (unchanged from the source spec):
 *   - Board request (local_trusted auto-auth) handles setup/teardown.
 *   - Agent-specific actions use API keys + heartbeat run IDs.
 *   - PATCHing an issue as an agent requires a fresh `X-Paperclip-Run-Id`
 *     from a heartbeat invoke; a 409 means someone else — or a prior run of
 *     the same agent — holds the lock, in which case the retry helper
 *     re-attempts with whatever run id currently holds the lock.
 */

export const E2E_BASE_URL = `http://127.0.0.1:${Number(process.env.PAPERCLIP_E2E_PORT ?? 3199)}`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentAuth {
  agentId: string;
  token: string;
  keyId: string;
  request: APIRequestContext;
}

export interface IssueRunLockState {
  assigneeAgentId: string | null;
  checkoutRunId: string | null;
  executionRunId: string | null;
}

export interface CollabCompany {
  companyId: string;
  companyPrefix: string;
  boardRequest: APIRequestContext;
  agents: Record<string, AgentAuth>;
  issueIds: string[];
}

/**
 * Local structural mirror of `createIssueThreadInteractionSchema`
 * (packages/shared/src/validators/issue.ts:1013-1112). `payload` is left as
 * `Record<string, unknown>` here — its shape is discriminated by `kind` on
 * the server and callers only need to pass through whatever the target
 * interaction kind expects.
 */
export interface CreateInteractionBody {
  kind:
    | "suggest_tasks"
    | "ask_user_questions"
    | "request_confirmation"
    | "request_checkbox_confirmation"
    | "request_item_verdicts";
  idempotencyKey?: string | null;
  sourceCommentId?: string | null;
  sourceRunId?: string | null;
  title?: string | null;
  summary?: string | null;
  continuationPolicy?: "none" | "wake_assignee" | "wake_assignee_on_accept";
  payload: Record<string, unknown>;
}

/**
 * Board-only resolution input, routed by `action` to one of the
 * accept/reject/respond routes (server/src/routes/issues.ts:9157, 9265,
 * 9322). `verdicts` and `cancel` are out of scope for this harness — no
 * current or planned spec (per plan) exercises them.
 */
export type ResolveInteractionInput =
  | { action: "accept"; selectedClientKeys?: string[]; selectedOptionIds?: string[] }
  | { action: "reject"; reason?: string }
  | {
      action: "respond";
      answers: Array<{ questionId: string; optionIds: string[]; otherText?: string | null }>;
      summaryMarkdown?: string | null;
    };

/**
 * Local structural mirror of `IssueThreadInteractionBase`
 * (packages/shared/src/types/issue.ts:1149-1164).
 */
export interface InteractionRecord {
  id: string;
  companyId: string;
  issueId: string;
  kind: string;
  idempotencyKey?: string | null;
  sourceCommentId?: string | null;
  sourceRunId?: string | null;
  title?: string | null;
  summary?: string | null;
  status: "pending" | "accepted" | "rejected" | "answered" | "cancelled" | "expired" | "failed";
  continuationPolicy: "none" | "wake_assignee" | "wake_assignee_on_accept";
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string | null;
  payload?: Record<string, unknown>;
  result?: Record<string, unknown> | null;
}

/**
 * Local structural mirror of `AttentionItem`
 * (packages/shared/src/types/attention.ts:147-177), trimmed to the fields
 * collab specs assert on.
 */
export interface AttentionItemLite {
  id: string;
  companyId: string;
  sourceKind: string;
  subject: { kind: string; id: string; companyId: string } & Record<string, unknown>;
  inlineResolvable: boolean;
  entryRule: string;
  dedupKey: string;
  dismissalKey: string;
  severity: string;
  rank: number;
  activityAt: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Local structural mirror of `IssueWorkProduct`
 * (packages/shared/src/types/work-product.ts), trimmed to the fields collab
 * specs assert on.
 */
export interface WorkProductRecord {
  id: string;
  issueId: string;
  type: string;
  provider: string;
  title: string;
  url: string | null;
  status: string;
  reviewState: string;
  isPrimary: boolean;
  summary: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Request contexts
// ---------------------------------------------------------------------------

/** signoff-policy.spec.ts:264 — board request context (local_trusted auto-auth, no bearer token). */
export async function createBoardRequest(baseUrl: string = E2E_BASE_URL): Promise<APIRequestContext> {
  return pwRequest.newContext({ baseURL: baseUrl });
}

/** signoff-policy.spec.ts:52-57 — authenticated request context for an agent (Authorization: Bearer). */
export async function createAgentRequest(token: string, baseUrl: string = E2E_BASE_URL): Promise<APIRequestContext> {
  return pwRequest.newContext({
    baseURL: baseUrl,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
}

// ---------------------------------------------------------------------------
// Company / agent setup
// ---------------------------------------------------------------------------

/** signoff-policy.spec.ts:164-174 — GET /api/health; asserts deploymentMode === "local_trusted". */
export async function assertLocalTrusted(board: APIRequestContext, baseUrl: string = E2E_BASE_URL): Promise<void> {
  const healthRes = await board.get(`${baseUrl}/api/health`);
  expect(healthRes.ok()).toBe(true);
  const health = await healthRes.json();
  if (health.deploymentMode !== "local_trusted") {
    throw new Error(
      `Collab e2e tests require local_trusted deployment mode, ` +
        `but server is in "${health.deploymentMode}" mode. ` +
        `Set PAPERCLIP_DEPLOYMENT_MODE=local_trusted or use the webServer config.`,
    );
  }
}

/** signoff-policy.spec.ts:176-186 — POST /api/companies; prefix fallback issuePrefix ?? prefix ?? urlKey ?? "E2E". */
export async function createCompany(
  board: APIRequestContext,
  name: string,
  baseUrl: string = E2E_BASE_URL,
): Promise<{ companyId: string; companyPrefix: string }> {
  const companyRes = await board.post(`${baseUrl}/api/companies`, {
    data: { name },
  });
  if (!companyRes.ok()) {
    const errBody = await companyRes.text();
    throw new Error(`POST /api/companies → ${companyRes.status()}: ${errBody}`);
  }
  const company = await companyRes.json();
  return {
    companyId: company.id,
    companyPrefix: company.issuePrefix ?? company.prefix ?? company.urlKey ?? "E2E",
  };
}

/**
 * signoff-policy.spec.ts:189-224 — hire + approve a process-adapter agent, mint an API key,
 * and build its request context. POST /api/companies/:companyId/agent-hires (201 { agent, approval }),
 * POST /api/approvals/:id/approve, POST /api/agents/:id/keys.
 */
export async function hireProcessAgent(
  board: APIRequestContext,
  companyId: string,
  opts: { name: string; role: string; title: string; adapterConfig?: { command: string; args: string[] } },
  baseUrl: string = E2E_BASE_URL,
): Promise<AgentAuth> {
  const { name, role, title } = opts;
  const adapterConfig = opts.adapterConfig ?? {
    command: process.execPath,
    args: ["-e", "process.stdout.write('done\\n')"],
  };
  const agentRes = await board.post(`${baseUrl}/api/companies/${companyId}/agent-hires`, {
    data: {
      name,
      role,
      title,
      adapterType: "process",
      adapterConfig,
    },
  });
  expect(agentRes.ok()).toBe(true);
  const hire = await agentRes.json();
  const agent = hire.agent;
  if (hire.approval) {
    const approvalRes = await board.post(`${baseUrl}/api/approvals/${hire.approval.id}/approve`, {
      data: { decisionNote: "Approved for collab e2e setup." },
    });
    expect(approvalRes.ok()).toBe(true);
  }

  const keyRes = await board.post(`${baseUrl}/api/agents/${agent.id}/keys`, {
    data: { name: `e2e-${name.toLowerCase()}` },
  });
  expect(keyRes.ok()).toBe(true);
  const keyData = await keyRes.json();

  return {
    agentId: agent.id,
    token: keyData.token,
    keyId: keyData.id,
    request: await createAgentRequest(keyData.token, baseUrl),
  };
}

/**
 * signoff-policy.spec.ts:163-239 — generalized `setupCompany`: asserts local_trusted, creates the
 * company, then hires/approves each requested agent sequentially (order preserved from the source,
 * which awaited executor → reviewer → approver one at a time).
 */
export async function setupCollabCompany(
  opts: { name: string; agents: Array<{ key: string; name: string; role: string; title: string }> },
  baseUrl: string = E2E_BASE_URL,
): Promise<CollabCompany> {
  const boardRequest = await createBoardRequest(baseUrl);
  await assertLocalTrusted(boardRequest, baseUrl);

  const { companyId, companyPrefix } = await createCompany(boardRequest, opts.name, baseUrl);

  const agents: Record<string, AgentAuth> = {};
  for (const agentSpec of opts.agents) {
    agents[agentSpec.key] = await hireProcessAgent(
      boardRequest,
      companyId,
      { name: agentSpec.name, role: agentSpec.role, title: agentSpec.title },
      baseUrl,
    );
  }

  return {
    companyId,
    companyPrefix,
    boardRequest,
    agents,
    issueIds: [],
  };
}

// ---------------------------------------------------------------------------
// Heartbeat / run-lock / patch flow
// ---------------------------------------------------------------------------

/**
 * signoff-policy.spec.ts:60-65 — POST /api/agents/:id/heartbeat/invoke (202), returning the run ID.
 *
 * Hardened beyond the source: the route returns 202 { status: "skipped" } (no run id) when the
 * heartbeat is skipped (e.g. agent already has an active run). The original silently returned
 * `undefined` in that case; this throws so callers get a diagnosable failure instead of a
 * downstream "runId is undefined" error.
 */
export async function invokeHeartbeat(
  board: APIRequestContext,
  agentId: string,
  baseUrl: string = E2E_BASE_URL,
): Promise<string> {
  const res = await board.post(`${baseUrl}/api/agents/${agentId}/heartbeat/invoke`);
  expect(res.ok()).toBe(true);
  const run = await res.json();
  if (!run || typeof run.id !== "string" || run.id.length === 0) {
    throw new Error(
      `heartbeat/invoke for agent ${agentId} returned no run id ` +
        `(body: ${JSON.stringify(run)}). The agent likely already has an active run, ` +
        `or the invocation was otherwise skipped.`,
    );
  }
  return run.id;
}

/** signoff-policy.spec.ts:67-76 — GET /api/issues/:id; reads the assignee/checkout/execution run lock fields. */
export async function getIssueRunLockState(
  board: APIRequestContext,
  issueId: string,
  baseUrl: string = E2E_BASE_URL,
): Promise<IssueRunLockState> {
  const res = await board.get(`${baseUrl}/api/issues/${issueId}`);
  expect(res.ok()).toBe(true);
  const issue = await res.json();
  return {
    assigneeAgentId: issue.assigneeAgentId ?? null,
    checkoutRunId: issue.checkoutRunId ?? null,
    executionRunId: issue.executionRunId ?? null,
  };
}

/**
 * New — sanctioned way to get a run id for an issue-scoped agent call (any request that needs
 * an `X-Paperclip-Run-Id` header, e.g. POST /interactions or PATCH /issues/:id).
 *
 * Exists because creating an issue with a non-backlog status and an assignee fires a real
 * (fire-and-forget) assignment wakeup for the assignee agent
 * (server/src/services/issue-assignment-wakeup.ts, queued from server/src/routes/issues.ts:7244),
 * which races to check the issue out via its own process-adapter run. Two failure modes follow
 * from that race: a plain `invokeHeartbeat` can throw its skipped-heartbeat error when the agent
 * already has an active run (the background wakeup run), and a freshly minted run id can still
 * lose to that background run's checkout because its completion is finalized asynchronously.
 *
 * Strategy is current-lock-first: if `opts.issueId` is given, read the issue's run lock and — if
 * it is currently held by a run (`checkoutRunId ?? executionRunId`) — return that run id
 * directly, since that's the run a mutating request must present to pass `assertCheckoutOwner`.
 * Otherwise (no issueId, or the lock isn't held), invoke a fresh heartbeat run. If that throws
 * because the heartbeat was skipped (agent already has an active run — almost always the
 * background wakeup run), the loop retries: a subsequent lock read will typically pick up that
 * active run. Bounded by `opts.maxAttempts` (default 5) with a short backoff between attempts;
 * throws a descriptive error on exhaustion.
 */
export async function acquireAgentRunId(
  board: APIRequestContext,
  agent: AgentAuth,
  opts?: { issueId?: string; maxAttempts?: number },
  baseUrl: string = E2E_BASE_URL,
): Promise<string> {
  const maxAttempts = opts?.maxAttempts ?? 5;
  const retryDelayMs = 250;
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    if (opts?.issueId) {
      const lock = await getIssueRunLockState(board, opts.issueId, baseUrl);
      const lockedRunId = lock.checkoutRunId ?? lock.executionRunId;
      if (lockedRunId) return lockedRunId;
    }
    try {
      return await invokeHeartbeat(board, agent.agentId, baseUrl);
    } catch (err) {
      lastError = err;
      // Skipped heartbeat (agent already has an active run) — most likely the
      // background assignment-wakeup run. Loop and re-read the lock (if an
      // issueId was given) or retry the heartbeat on the next attempt.
    }
  }
  throw new Error(
    `acquireAgentRunId: exhausted ${maxAttempts} attempts for agent ${agent.agentId}` +
      (opts?.issueId ? ` on issue ${opts.issueId}` : "") +
      `; last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

/**
 * signoff-policy.spec.ts:78-97 — on a 409, re-reads the current run lock and retries the PATCH with
 * whatever run id currently holds it (only if the lock is still held by the same agent).
 */
export async function retryAgentPatchWithCurrentLockOnConflict(
  board: APIRequestContext,
  agent: AgentAuth,
  issueId: string,
  failedRes: APIResponse,
  patchData: Record<string, unknown>,
  baseUrl: string = E2E_BASE_URL,
): Promise<APIResponse> {
  if (failedRes.status() !== 409) return failedRes;
  const issueRunLock = await getIssueRunLockState(board, issueId, baseUrl);
  if (issueRunLock.assigneeAgentId !== agent.agentId) return failedRes;

  const lockedRunId = issueRunLock.checkoutRunId ?? issueRunLock.executionRunId;
  if (!lockedRunId) return failedRes;

  const retryRes = await agent.request.patch(`${baseUrl}/api/issues/${issueId}`, {
    headers: { "X-Paperclip-Run-Id": lockedRunId },
    data: patchData,
  });
  return retryRes.ok() ? retryRes : failedRes;
}

/** signoff-policy.spec.ts:99-112 — PATCH an issue as an agent with a fresh heartbeat run ID. */
export async function agentPatch(
  board: APIRequestContext,
  agent: AgentAuth,
  issueId: string,
  data: Record<string, unknown>,
  baseUrl: string = E2E_BASE_URL,
): Promise<APIResponse> {
  const runId = await invokeHeartbeat(board, agent.agentId, baseUrl);
  const res = await agent.request.patch(`${baseUrl}/api/issues/${issueId}`, {
    headers: { "X-Paperclip-Run-Id": runId },
    data,
  });
  return res;
}

/**
 * signoff-policy.spec.ts:114-161 — checkout an issue as an agent, then PATCH it. Used for
 * executor mark-done (where the issue isn't already checked out to the agent, unlike
 * reviewer/approver actions which use `agentPatch` directly).
 *
 * Order preserved from the source: try a direct PATCH first (covers the case where the agent
 * already holds the lock); on failure, agent-checkout then PATCH; on checkout 409, retry via
 * the current lock; if that also fails, fall back to a board checkout + board PATCH.
 */
export async function agentCheckoutAndPatch(
  board: APIRequestContext,
  agent: AgentAuth,
  issueId: string,
  expectedStatuses: string[],
  patchData: Record<string, unknown>,
  baseUrl: string = E2E_BASE_URL,
): Promise<APIResponse> {
  const runId = await invokeHeartbeat(board, agent.agentId, baseUrl);
  const directPatchRes = await agent.request.patch(`${baseUrl}/api/issues/${issueId}`, {
    headers: { "X-Paperclip-Run-Id": runId },
    data: patchData,
  });
  if (directPatchRes.ok()) return directPatchRes;

  // Checkout (sets executionRunId so PATCH is allowed)
  const checkoutRes = await agent.request.post(`${baseUrl}/api/issues/${issueId}/checkout`, {
    headers: { "X-Paperclip-Run-Id": runId },
    data: { agentId: agent.agentId, expectedStatuses },
  });
  if (!checkoutRes.ok()) {
    if (checkoutRes.status() === 409) {
      const res = await retryAgentPatchWithCurrentLockOnConflict(board, agent, issueId, checkoutRes, patchData, baseUrl);
      if (res.ok()) {
        return res;
      }
    }
    // If agent checkout fails (e.g. run expired), fall back to board checkout
    // then PATCH with the agent's identity
    const boardCheckout = await board.post(`${baseUrl}/api/issues/${issueId}/checkout`, {
      data: { agentId: agent.agentId, expectedStatuses },
    });
    if (!boardCheckout.ok()) {
      throw new Error(`Board checkout failed: ${await boardCheckout.text()}`);
    }
    // Board PATCH (executor mark-done triggers signoff regardless of actor)
    const res = await board.patch(`${baseUrl}/api/issues/${issueId}`, {
      data: patchData,
    });
    return res;
  }
  // PATCH with agent identity
  const res = await agent.request.patch(`${baseUrl}/api/issues/${issueId}`, {
    headers: { "X-Paperclip-Run-Id": runId },
    data: patchData,
  });
  return retryAgentPatchWithCurrentLockOnConflict(board, agent, issueId, res, patchData, baseUrl);
}

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

/**
 * signoff-policy.spec.ts:241-258, generalized — `createIssueWithPolicy` hardcoded a two-stage
 * review/approval `executionPolicy`; here the caller passes whatever issue fields it needs
 * (including `executionPolicy` when relevant) directly in `data`. POST
 * /api/companies/:companyId/issues. When `ctx` is supplied, the created issue id is pushed
 * onto `ctx.issueIds` for `cleanupCollabCompany` teardown, matching the source's bookkeeping.
 */
export async function createIssue(
  board: APIRequestContext,
  companyId: string,
  data: { title: string } & Record<string, unknown>,
  ctx?: CollabCompany,
  baseUrl: string = E2E_BASE_URL,
): Promise<{ id: string; identifier: string } & Record<string, unknown>> {
  const res = await board.post(`${baseUrl}/api/companies/${companyId}/issues`, {
    data,
  });
  expect(res.ok()).toBe(true);
  const issue = await res.json();
  if (ctx) ctx.issueIds.push(issue.id);
  return issue;
}

// ---------------------------------------------------------------------------
// Issue-thread interactions — New (no extraction source)
// ---------------------------------------------------------------------------

/**
 * New — target route: POST /api/issues/:id/interactions (server/src/routes/issues.ts:9109).
 * Board callers need no run id. Agent callers must supply a run id (via `opts.runId`, or a
 * fresh one is acquired automatically via `acquireAgentRunId`) — the route 401s agents with no
 * `X-Paperclip-Run-Id` (server/src/routes/issues.ts:3369-3375, `requireAgentRunId`).
 *
 * On a freshly created in_progress+assigned issue, the fire-and-forget assignment wakeup
 * (`acquireAgentRunId`'s JSDoc has the full race) can hold/flip the issue's run lock out from
 * under an independently-acquired run id — and because the background run's completion is
 * finalized asynchronously, even reading the current lock and immediately reusing it can still
 * lose. So the agent path here retries the POST itself on a 409 in the "Issue run ownership
 * conflict" class (server/src/services/issues.ts `assertCheckoutOwner`) with a freshly
 * re-acquired run id, bounded at 5 attempts with a short backoff between attempts to let that
 * async finalization settle — mirroring `retryAgentPatchWithCurrentLockOnConflict`'s established
 * pattern for PATCH. Other 409s (e.g. an idempotency-key conflict) are not retried and surface
 * immediately.
 */
export async function createInteraction(
  board: APIRequestContext,
  issueId: string,
  body: CreateInteractionBody,
  asAgent?: AgentAuth,
  opts?: { runId?: string },
  baseUrl: string = E2E_BASE_URL,
): Promise<InteractionRecord> {
  if (!asAgent) {
    const res = await board.post(`${baseUrl}/api/issues/${issueId}/interactions`, {
      data: body,
    });
    expect(res.ok()).toBe(true);
    return res.json();
  }

  const maxAttempts = 5;
  const retryDelayMs = 250;
  let lastRes: APIResponse | undefined;
  let lastText = "";
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Give the background wakeup run's asynchronous completion/finalization
    // a moment to settle before re-sampling the lock — retrying immediately
    // can keep losing the race (see this function's JSDoc).
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    const runId =
      attempt === 0 && opts?.runId
        ? opts.runId
        : await acquireAgentRunId(board, asAgent, { issueId }, baseUrl);
    const res = await asAgent.request.post(`${baseUrl}/api/issues/${issueId}/interactions`, {
      headers: { "X-Paperclip-Run-Id": runId },
      data: body,
    });
    if (res.status() === 201) return res.json();
    lastRes = res;
    lastText = await res.text();
    const isOwnershipConflict = res.status() === 409 && /ownership conflict/i.test(lastText);
    if (!isOwnershipConflict) break;
  }
  throw new Error(
    `createInteraction: exhausted ${maxAttempts} attempts on issue ${issueId} for agent ${asAgent.agentId}; ` +
      `last response ${lastRes?.status()}: ${lastText}`,
  );
}

/**
 * New — target routes: POST /api/issues/:id/interactions/:interactionId/{accept,reject,respond}
 * (server/src/routes/issues.ts:9157, 9265, 9322). Board-only by server rule: agent actors are
 * rejected with 403 ("Agent actors cannot resolve issue-thread interactions through this
 * board-only route" — server/src/routes/issues.ts:3603, `rejectAgentIssueThreadInteractionResolution`).
 */
export async function resolveInteraction(
  board: APIRequestContext,
  issueId: string,
  interactionId: string,
  resolution: ResolveInteractionInput,
  baseUrl: string = E2E_BASE_URL,
): Promise<InteractionRecord> {
  const { action, ...data } = resolution;
  const res = await board.post(`${baseUrl}/api/issues/${issueId}/interactions/${interactionId}/${action}`, {
    data,
  });
  expect(res.ok()).toBe(true);
  return res.json();
}

// ---------------------------------------------------------------------------
// Attention feed — New (no extraction source)
// ---------------------------------------------------------------------------

/**
 * New — target route: GET /api/companies/:companyId/attention (server/src/routes/attention.ts:10).
 * The server supports only `includeDismissed` as a query filter; `sourceKind`/`subjectId`
 * filtering happens client-side here.
 */
export async function getAttentionItems(
  board: APIRequestContext,
  companyId: string,
  filter?: { sourceKind?: string; subjectId?: string; includeDismissed?: boolean },
  baseUrl: string = E2E_BASE_URL,
): Promise<AttentionItemLite[]> {
  const query = filter?.includeDismissed ? "?includeDismissed=true" : "";
  const res = await board.get(`${baseUrl}/api/companies/${companyId}/attention${query}`);
  expect(res.ok()).toBe(true);
  const feed = await res.json();
  let items: AttentionItemLite[] = feed.items ?? [];
  if (filter?.sourceKind) {
    items = items.filter((item) => item.sourceKind === filter.sourceKind);
  }
  if (filter?.subjectId) {
    items = items.filter((item) => item.subject?.id === filter.subjectId);
  }
  return items;
}

/**
 * New — polls `getAttentionItems` with the given filter until the matching set is empty
 * (i.e. the attention item has exited the feed).
 */
export async function expectAttentionExit(
  board: APIRequestContext,
  companyId: string,
  filter: { sourceKind: string; subjectId: string },
  opts?: { timeoutMs?: number },
  baseUrl: string = E2E_BASE_URL,
): Promise<void> {
  await expect
    .poll(async () => (await getAttentionItems(board, companyId, filter, baseUrl)).length, {
      timeout: opts?.timeoutMs ?? 10_000,
    })
    .toBe(0);
}

// ---------------------------------------------------------------------------
// Work products — New (no extraction source)
// ---------------------------------------------------------------------------

/**
 * New — target route: POST /api/issues/:id/work-products (server/src/routes/issues.ts:6380),
 * called as the board so it always passes the route's actor checks. Returns exactly 201 on
 * success (not merely `res.ok()`, to catch a silent status drift from the route).
 */
export async function seedWorkProduct(
  board: APIRequestContext,
  issueId: string,
  input?: Partial<{
    type: string;
    provider: string;
    title: string;
    url: string | null;
    status: string;
    reviewState: string;
    summary: string | null;
    isPrimary: boolean;
  }>,
  baseUrl: string = E2E_BASE_URL,
): Promise<WorkProductRecord> {
  const data = {
    type: "artifact",
    provider: "e2e-harness",
    title: "E2E seeded work product",
    status: "active",
    ...input,
  };
  const res = await board.post(`${baseUrl}/api/issues/${issueId}/work-products`, { data });
  if (res.status() !== 201) {
    throw new Error(`POST /api/issues/${issueId}/work-products → ${res.status()}: ${await res.text()}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

/**
 * signoff-policy.spec.ts:268-289 — generalized `afterAll` teardown: dispose all agent request
 * contexts, best-effort cancel every tracked issue, best-effort delete each agent's key + the
 * agent itself, best-effort delete the company, then dispose the board request. Order preserved
 * from the source.
 */
export async function cleanupCollabCompany(ctx: CollabCompany, baseUrl: string = E2E_BASE_URL): Promise<void> {
  if (!ctx) return;
  const board = ctx.boardRequest;
  const agents = Object.values(ctx.agents);

  // Dispose agent request contexts
  for (const agent of agents) {
    await agent.request.dispose();
  }

  // Clean up issues, keys, agents, company (best-effort)
  for (const issueId of ctx.issueIds) {
    await board
      .patch(`${baseUrl}/api/issues/${issueId}`, {
        data: { status: "cancelled", comment: "E2E test cleanup." },
      })
      .catch(() => {});
  }
  for (const agent of agents) {
    await board.delete(`${baseUrl}/api/agents/${agent.agentId}/keys/${agent.keyId}`).catch(() => {});
    await board.delete(`${baseUrl}/api/agents/${agent.agentId}`).catch(() => {});
  }
  await board.delete(`${baseUrl}/api/companies/${ctx.companyId}`).catch(() => {});
  await board.dispose();
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

/**
 * New — long-running process adapter for steer smoke tests only (plan §5.3 last bullet).
 * Unlike the default `hireProcessAgent` adapter (which exits immediately), this sleeps for
 * `seconds` before writing to stdout, giving a test window to steer/interrupt a live run.
 */
export function sleepProcessAdapterConfig(seconds: number): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: ["-e", `setTimeout(() => process.stdout.write('done\\n'), ${seconds * 1000})`],
  };
}
