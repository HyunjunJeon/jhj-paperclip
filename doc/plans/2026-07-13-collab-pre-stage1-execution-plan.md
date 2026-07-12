# Pre-Stage-1 Collaboration Program — Execution Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the roadmap's §3.3 pre-code decisions in writing and land every Stage 0 deliverable (harness, invariant tests, contract freezes, flag scaffold, extension-points doc, telemetry map, `@collab` lane), so Stage 1 feature work can start against a ratified contract.

**Architecture:** Everything here is additive and flag-off-neutral. Code tasks either extract existing patterns (`signoff-policy.spec.ts` → harness), freeze today's behavior as characterization tests (invariants, contracts), or add one dormant boolean flag. The one new document (`COLLAB-EXTENSION-POINTS.md`) is normative for Stages 1–5.

**Tech Stack:** Playwright (`tests/e2e`, config `tests/e2e/playwright.config.ts`), Vitest 4 + embedded Postgres (`server/src/__tests__`), Drizzle (`packages/db`), Zod validators (`packages/shared`), Express routes (`server/src/routes`).

**Source of truth:** `doc/plans/2026-07-12-human-agent-collaboration-roadmap.md` (review-integrated). Section references (§…) below point there unless another doc is named. Fact-level claims in this plan were verified against the repo on 2026-07-13.

## Global Constraints

- No product behavior change with the flag off (§7.4). The only observable Stage 0 surface changes: a new `enableHumanAgentCollab: false` key in `/api/instance/settings/experimental` and its settings toggle card.
- No live LLM in any new test (§4.2). Use board + agent API keys + heartbeat invoke (`signoff-policy` pattern).
- Characterization tests freeze *today's* behavior — including behavior Stage 1 will deliberately change (resolver authority, non-atomic resolve-then-wake). Mark those with a `// Stage 1 changes this deliberately: <roadmap ref>` comment.
- Helper files under `tests/e2e/helpers/` must NOT use the `.spec.ts` suffix (`testMatch: "**/*.spec.ts"` under `testDir: "."` would collect them as tests).
- E2E helpers must not import `@paperclipai/shared` (not resolvable from the repo root; define local structural mirrors, as `signoff-policy.spec.ts` already does).
- Server test files matching `/[^/]*(?:route|routes|authz)[^/]*\.test\.ts$/` are auto-grouped into the serialized suite (`scripts/run-vitest-stable.mjs:23`) — name files accordingly, no registry edits.
- Every commit passes: targeted vitest for the touched files, `pnpm typecheck` when shared/server/ui types change, and `pnpm test:e2e` when `tests/e2e/` changes.

## Workstream map

| Workstream | Content | Blocks |
|---|---|---|
| **A** | Close §3.3 decisions 1–16 in writing (ADR/issue) | Stage 1 feature code (§0: "Do not start Stage 1 feature code until pre-code decisions are closed") |
| **B** | Stage 0 deliverables (tasks B1–B9, mostly independent; B1→B2 ordered) | Stage 0 exit (§7.4) |
| **C** | Stage 1 implementation plan authoring | Stage 1 epics |

A and B can run in parallel. C starts once A is signed off and B1–B5 are merged.

---

## Workstream A — Close the §3.3 pre-code decisions

### Task A1: Author the decision record

**Files:**
- Create: `doc/plans/2026-07-13-collab-pre-code-decisions.md` (or one tracking issue per §3.3's "issue or ADR" allowance; a single document is recommended so Stage 1 reviewers have one link)

Verification of the roadmap classified the 16 decisions as **9 ratify** (answer already embedded in the roadmap — the ADR records it) and **7 decide** (genuinely open — recommendation given). Q3 and Q9 are product-judgment; the rest are eng-ratify.

- [ ] **Step 1: Write the decision document with the following 16 entries** (proposed answers below are ready to paste; adjust only if product overrides):

| Q | Decision | Status | Proposed answer (condensed — expand from roadmap refs) |
|---|---|---|---|
| 1 | Handoff source of truth | ratify | A Stage 1 decision package does not replace `SuccessfulRunHandoffState` (`packages/shared/src/types/issue.ts:522`; service `server/src/services/recovery/successful-run-handoff.ts`); it may **satisfy** a pending disposition. One canonical handoff identity, one attention `dedupKey` family; recovery skip rules treat a pending package-bearing interaction as the live handoff. (§8.3, §3.1 R1, §8.5 slice 7) |
| 2 | UI option → API map | ratify | Options are labels only (`optionLabels`); resolve maps exclusively onto existing endpoints `POST /issues/:id/interactions/:interactionId/{accept\|reject\|respond\|verdicts\|cancel}` (`server/src/routes/issues.ts:9158–9446`) with existing continuation policies. "Request changes" = reject/respond + reason + wake, or stage decision `changes_requested` inside a policy stage. `reassign` is cut. (§8.4, §3.1 R2, §3.2) |
| 3 | Handoff required vs optional | **decide (product)** | Recommended: optional at Stage 1 GA — skills strongly recommend, server validates when present, never forces. Revisit if §17 "% human waits with package" stays low after skill rollout. (§8.3 "Optional vs required", §8.7) |
| 4 | Watchdog human reservation | ratify | Yes, permanently: package-bearing or `humanOnly: true` confirmations are not watchdog-eligible; `humanOnly` is server-derived and cannot be disabled by callers. Lands as a new eligibility condition in SPEC-implementation §9.9 (human-reservation clause at line 648) + non-accept tests. (§8.4, §3.1 R5, §5.2 C5) |
| 5 | Timeout actor matrix | decide (constraints ratified; matrix authored in B7) | Human-wait timeouts belong exclusively to the future Stage 4b SLA evaluator (alert/escalate/`blocked`/recovery only; never terminalize, pause, or approve). Monitor + stranded recovery keep their agent-run lanes and must treat a pending interaction as a valid action path. Until 4b: **no** timeout automation on human waits (silentDefault worker frozen; `silentDefaultHint` schema-only). Matrix recorded in `doc/design/COLLAB-EXTENSION-POINTS.md` (Task B7). (§3.1 R3, §3.2, §8.4, §11.2) |
| 6 | Contract storage + evaluation order | decide (order ratified; storage pick open) | Storage: dedicated jsonb with integer `revision` (§9.4 `OutcomeChecklist`) + separate evidence rows — not `execution_policy` free keys (validator-locked per `doc/plans/2026-06-03-low-trust-review-contract.md`; normalizers strip unknown keys), not document revisions (no server-side schema validation). Order: executionPolicy stages route first; checklist evaluates only on transitions that write successful `done` incl. force-complete; `cancelled` never requires DoD evidence. (§9.3, §3.1 R4) |
| 7 | Flag scope | ratify | Instance experimental settings only (`InstanceExperimentalSettings`, `packages/shared/src/types/instance.ts:47–85`); no company-scoped settings work in Stage 0. Accepted costs: instance flag flips keep e2e serial (`workers: 1`); flag-off data compatibility is part of every stage's exit. Full cost-of-company-scoped list lives in Task B6. (§5.4, §3.1 R7) |
| 8 | Steer permissions | ratify | Board-only posting for the steer MVP; company/issue scoped, activity-logged, rate-limited, unavailable to low-trust agents. Default non-interrupt deferred wake; interrupt/cancel only as explicit separate board action; steer wakes pass the same budget/invokability gates. (§10.4, §10.3, §2.3) |
| 9 | First GA one-sentence promise | **decide (product)** | Recommended primary: **"WhatNeedsMe shows a decision package."** Stage 1 is first in the dependency chain (§6), has the best E2E feasibility (§5.6: C+→B vs C−/D), and drives the top §17 metric. Contracts + steer ship as secondary capabilities in the same GA stop. |
| 10 | CLI / skill / OpenAPI policy | decide | "Capability-advertised, same-change-set": agent-facing fields ship shared validator + server + OpenAPI/CLI parity in the same PR series (per `doc/plans/2026-05-23-cli-api-parity.md`, which cites its OpenAPI source on branch `feature/openapi-spec`); skills teach a field only once the server advertises the capability (flag on), so rollout can never teach disabled fields (§8.7 exit). Enforcement point: §14 DoD sync checkbox. |
| 11 | Decision resolver authority | decide (mechanism ratified; default open) | `resolverPolicy` defaults to `{ kind: "board" }`; board principals may always resolve (audited as board override, per §1 "Board governable"). All other non-owners — former members, agents, low-trust runs, cross-company — get a non-disclosing 403 and no wake. Escalation of an unavailable responsible user = escalated attention (Stage 4b), never automatic reassignment. (§8.4; today's board-only guard: `server/src/routes/issues.ts:3603`) |
| 12 | Failure-atomic resolve | ratify | Adopt Track A of `doc/plans/2026-07-12-continuation-outbox-and-immutable-provenance.md` verbatim: one producer transaction persists terminal interaction + activity + exactly one continuation intent; leased/CAS dispatcher; deterministic event keys (`resolution:v1:<interaction-id>`) and RFC 8785 fingerprints (200 replay / 409 conflict). Stage 1 resolves are producers on this same path — no second outbox. (§8.4, §4.1 #14, §3.1 R10) |
| 13 | Decision queue bounds | decide (principles ratified; numbers open) | Idempotency: server-derived (outbox-plan fingerprint pattern), never client keys. Recommended: max 3 pending package-bearing interactions per issue, 100 per company (structured 422 beyond); payload ≤ 64 KiB encoded (matches outbox envelope bound, outbox plan §5.3/§5.5); newer package on same issue/kind/target supersedes via existing lifecycle; attention gains keyset pagination (`cursor` + `limit`, default 50 / max 200 — `GET /companies/:companyId/attention` has none today, `server/src/routes/attention.ts`). (§8.4, §8.5 slice 4) |
| 14 | Outcome authority | ratify | Board or persisted responsible user owns checklist definitions once execution starts; agents attach evidence only. Optimistic-concurrency edits bump `revision` and invalidate stale attestations. Evidence per the §9.4 qualification matrix; `done` pins immutable revision/hash; board-only audited reopen; force-complete fences execution and is blocked by governed approvals unless explicitly waived. (§9.4, §9.3, §4.1 #15) |
| 15 | Steer delivery | ratify | Directive text = provenance-labeled typed issue comment; separate `SteerDirectiveDelivery` table owns delivery state only (§10.4 shape). Transactional `(issueId, seq)` allocation; CAS transitions on version/status/leaseToken/generation; reassignment supersedes old-generation leases; exhausted → `dead` + visible recovery action; merged `context_snapshot` without positive ack ≠ delivery. (§10.4, §3.1 R6) |
| 16 | Command composer | ratify | Always issue-backed (issues + comments, no chat table); server derives company/goal linkage; explicit non-waking draft or exactly one CEO-assigned issue; budget/invokability gates before wake; idempotent, permission-checked, activity-logged. `issues.kind` does not exist today (only `harness_kind`/`origin_kind` in `packages/db/src/schema/issues.ts`) — optional later additive, never a hidden dependency. (§12.1, §3.1 R7) |

- [ ] **Step 2: Route Q3 and Q9 to product** with the recommended defaults above and a 1-week decision deadline; all other rows are eng sign-off.
- [ ] **Step 3: On sign-off, update the roadmap in place** (§18.5: single program source): mark each §3.3 item with `→ decided: <link>`; move any overridden recommendation into the roadmap text.
- [ ] **Step 4: Commit** — `docs(plan): close collab pre-code decisions Q1–Q16`

---

## Workstream B — Stage 0 deliverables

### Task B1: Extract the collab E2E harness

**Files:**
- Create: `tests/e2e/helpers/collab.ts` (directory does not exist yet)

**Interfaces (produces — B2 and every later collab spec consume these):**

```typescript
export const E2E_BASE_URL: string; // `http://127.0.0.1:${Number(process.env.PAPERCLIP_E2E_PORT ?? 3199)}`

export interface AgentAuth { agentId: string; token: string; keyId: string; request: APIRequestContext; }
export interface IssueRunLockState { assigneeAgentId: string | null; checkoutRunId: string | null; executionRunId: string | null; }
export interface CollabCompany { companyId: string; companyPrefix: string; boardRequest: APIRequestContext; agents: Record<string, AgentAuth>; issueIds: string[]; }

export async function createBoardRequest(baseUrl?: string): Promise<APIRequestContext>;
export async function createAgentRequest(token: string, baseUrl?: string): Promise<APIRequestContext>;
export async function assertLocalTrusted(board: APIRequestContext, baseUrl?: string): Promise<void>;
export async function createCompany(board: APIRequestContext, name: string, baseUrl?: string): Promise<{ companyId: string; companyPrefix: string }>;
export async function hireProcessAgent(board: APIRequestContext, companyId: string, opts: { name: string; role: string; title: string; adapterConfig?: { command: string; args: string[] } }, baseUrl?: string): Promise<AgentAuth>;
export async function setupCollabCompany(opts: { name: string; agents: Array<{ key: string; name: string; role: string; title: string }> }, baseUrl?: string): Promise<CollabCompany>;
export async function invokeHeartbeat(board: APIRequestContext, agentId: string, baseUrl?: string): Promise<string>; // MUST throw on 202 { status: "skipped" } (no run id)
export async function getIssueRunLockState(board: APIRequestContext, issueId: string, baseUrl?: string): Promise<IssueRunLockState>;
export async function retryAgentPatchWithCurrentLockOnConflict(board: APIRequestContext, agent: AgentAuth, issueId: string, failedRes: APIResponse, patchData: Record<string, unknown>, baseUrl?: string): Promise<APIResponse>;
export async function agentPatch(board: APIRequestContext, agent: AgentAuth, issueId: string, data: Record<string, unknown>, baseUrl?: string): Promise<APIResponse>;
export async function agentCheckoutAndPatch(board: APIRequestContext, agent: AgentAuth, issueId: string, expectedStatuses: string[], patchData: Record<string, unknown>, baseUrl?: string): Promise<APIResponse>;
export async function createIssue(board: APIRequestContext, companyId: string, data: { title: string } & Record<string, unknown>, ctx?: CollabCompany, baseUrl?: string): Promise<{ id: string; identifier: string } & Record<string, unknown>>;
export async function createInteraction(board: APIRequestContext, issueId: string, body: CreateInteractionBody, asAgent?: AgentAuth, opts?: { runId?: string }, baseUrl?: string): Promise<InteractionRecord>;
export async function resolveInteraction(board: APIRequestContext, issueId: string, interactionId: string, resolution: ResolveInteractionInput, baseUrl?: string): Promise<InteractionRecord>; // board-only by server rule (issues.ts:3603)
export async function getAttentionItems(board: APIRequestContext, companyId: string, filter?: { sourceKind?: string; subjectId?: string; includeDismissed?: boolean }, baseUrl?: string): Promise<AttentionItemLite[]>; // server supports only includeDismissed — sourceKind/subjectId filtering is CLIENT-side
export async function expectAttentionExit(board: APIRequestContext, companyId: string, filter: { sourceKind: string; subjectId: string }, opts?: { timeoutMs?: number }, baseUrl?: string): Promise<void>;
export async function seedWorkProduct(board: APIRequestContext, issueId: string, input?: Partial<{ type: string; provider: string; title: string; url: string | null; status: string; reviewState: string; summary: string | null; isPrimary: boolean }>, baseUrl?: string): Promise<WorkProductRecord>;
export async function cleanupCollabCompany(ctx: CollabCompany, baseUrl?: string): Promise<void>;
export function sleepProcessAdapterConfig(seconds: number): { command: string; args: string[] }; // long-run adapter for steer smoke only (§5.3 last bullet)
```

`CreateInteractionBody`, `ResolveInteractionInput`, `InteractionRecord`, `AttentionItemLite`, `WorkProductRecord` are local structural mirrors of the shared validators/types (`packages/shared/src/validators/issue.ts:1013–1112`, `packages/shared/src/types/issue.ts:1149–1164`, `packages/shared/src/types/attention.ts:147–177`).

- [ ] **Step 1: Write the helper bodies by extracting `tests/e2e/signoff-policy.spec.ts`** — extraction map (helper ← spec lines ← endpoint):
  - `createBoardRequest` ← 264; `createAgentRequest` ← 52–57 (`Authorization: Bearer`)
  - `assertLocalTrusted` ← 164–174 (`GET /api/health`, assert `deploymentMode === "local_trusted"`)
  - `createCompany` ← 176–186 (`POST /api/companies`; prefix fallback `issuePrefix ?? prefix ?? urlKey ?? "E2E"`)
  - `hireProcessAgent` ← 189–224 (`POST /api/companies/:companyId/agent-hires` [201 `{ agent, approval }`], `POST /api/approvals/:id/approve`, `POST /api/agents/:id/keys`; default process adapter `{ command: process.execPath, args: ["-e", "process.stdout.write('done\\n')"] }`)
  - `setupCollabCompany` ← 163–239; `invokeHeartbeat` ← 60–65 (`POST /api/agents/:id/heartbeat/invoke`, 202)
  - `getIssueRunLockState` ← 67–76; `retryAgentPatchWithCurrentLockOnConflict` ← 78–97; `agentPatch` ← 99–112; `agentCheckoutAndPatch` ← 114–161 (`X-Paperclip-Run-Id` header; 409 retry; board-checkout fallback)
  - `createIssue` ← 241–258 generalized (executionPolicy optional); `cleanupCollabCompany` ← 268–289 (best-effort teardown)
  - New (no extraction source): `createInteraction` (→ `issues.ts:9110`; agent path needs bearer + `X-Paperclip-Run-Id`, agents are 401-rejected without a run id), `resolveInteraction` (→ `issues.ts:9158/9266/9323`), `getAttentionItems`/`expectAttentionExit` (→ `attention.ts:10`; `expect.poll` until the filtered list is empty), `seedWorkProduct` (→ `issues.ts:6381`; defaults `{ type: "artifact", provider: "e2e-harness", title: "E2E seeded work product", status: "active" }`; route returns exactly **201**), `sleepProcessAdapterConfig`.
- [ ] **Step 2: Typecheck note** — no tsconfig covers `tests/`; Playwright transpiles without type-checking. Either accept runtime-only checking (status quo) or add `tests/e2e/tsconfig.json` as an explicit extra step in this task. Decide in the PR; do not silently skip.
- [ ] **Step 3: Commit** — `test(e2e): add collab harness helpers` (helpers alone; the smoke spec proves them in B2)

### Task B2: Harness smoke spec

**Files:**
- Create: `tests/e2e/collab-harness-smoke.spec.ts`

- [ ] **Step 1: Write the spec** — `test.describe("Collab harness smoke", { tag: "@collab" }, …)`; `beforeAll`: `setupCollabCompany({ name: \`E2E-CollabSmoke-${Date.now()}\`, agents: [{ key: "worker", name: "Worker", role: "engineer", title: "Software Engineer" }] })`; `afterAll`: `cleanupCollabCompany(ctx)`.

  **Test 1 `"request_confirmation: agent asks, attention lists it, board resolves, attention exits"`:**
  1. `createIssue(...{ title: "Collab harness smoke", status: "in_progress", assigneeAgentId: ctx.agents.worker.agentId })` → ok.
  2. `createInteraction(..., { kind: "request_confirmation", payload: { version: 1, prompt: "Confirm the collab harness smoke run?" } }, ctx.agents.worker)` → 201; `status === "pending"`; `continuationPolicy === "none"` (schema default).
  3. `getAttentionItems(..., { sourceKind: "issue_thread_interaction", subjectId: interaction.id })` → exactly 1 item; `subject.kind === "interaction"`; `inlineResolvable === true`; `entryRule === "issue_thread_interactions.status = 'pending'"`.
  4. UI smoke only after API state: `page.goto(\`/${ctx.companyPrefix}/issues/${issue.identifier}\`)`; expect the prompt text visible.
  5. Negative authz: agent POST to `/accept` with fresh run id → **403**, body contains `"board-only"` (`issues.ts:3603`).
  6. `resolveInteraction(..., { action: "accept" })` → `status === "accepted"`, `result.outcome === "accepted"`.
  7. `expectAttentionExit(...)` → zero items (feed selects only `status = 'pending'` rows).
  8. `GET /api/issues/:id/interactions` still lists the row with `status === "accepted"` (resolved ≠ deleted).

  **Test 2 `"seedWorkProduct: board-seeded artifact appears on the issue"`:** createIssue → `seedWorkProduct` → **201**, `type === "artifact"` → `GET /api/issues/:id/work-products` contains it.
- [ ] **Step 2: Run** — `npx playwright test --config tests/e2e/playwright.config.ts collab-harness-smoke.spec.ts` → 2 passed. Then full `pnpm test:e2e` → green (suite is serial; keep this spec to these two tests, §5.5 budget).
- [ ] **Step 3: Commit** — `test(e2e): collab harness smoke (confirmation → resolve → attention exit)`

### Task B3: Invariant characterization tests (routes)

**Files:**
- Create: `server/src/__tests__/collab-invariants-routes.test.ts` (name matches the serialized-group pattern; no registry edit)

Bootstrap: copy the full-stack pattern from `server/src/__tests__/issue-identifier-routes.test.ts:1–73` — embedded Postgres (`startEmbeddedPostgresTestDatabase("paperclip-collab-invariants-")`, `describeEmbeddedPostgres` gate), real `issueRoutes(db, {} as any)` mounted at `/api` behind an actor-injection middleware + `errorHandler`, supertest. Seed memberships with `db.insert(companyMemberships)` + `ensureHumanRoleDefaultGrants(...)`. Board actor shape: `{ type: "board", userId, companyIds: [companyId], memberships: [{ companyId, membershipRole, status: "active" }], source: "cloud_tenant", isInstanceAdmin: false }`; agent actor: `{ type: "agent", agentId, companyId, source: "agent_key" }` (no `runId` → the agent-denial path hits the plain 403 at `routes/issues.ts:3603`).

- [ ] **Step 1: Write the four describe blocks (tests freeze TODAY's behavior and must pass immediately):**

  **`assignee XOR`** (service gate `server/src/services/issues.ts:5997` create / `6270–6277` merged-next PATCH; `createIssueSchema` has NO XOR refine — the failure must come from the service):
  - create with both `assigneeAgentId` + `assigneeUserId` → 422 `{ error: "Issue can only have one assignee" }`; no row persisted.
  - PATCH adding `assigneeUserId` onto an agent-assigned issue → 422 same message; row unchanged.
  - PATCH adding `assigneeAgentId` onto a user-assigned issue → 422 same message; row unchanged.

  **`company boundary (403 today, not 404)`** (`authz.ts:76–78, 103–107`; interaction routes resolve the issue unscoped then assert):
  - cross-company board member creates interaction → 403 `"User does not have access to this company"`.
  - cross-company agent creates interaction → 403 `"Agent key cannot access another company"`.
  - cross-company board member accept / reject → 403; interaction stays `pending`.

  **`resolver authority characterization`** (`routes/issues.ts:9168–9170` accept / `9276–9278` reject: only `assertCompanyAccess` + agent-denial + `assertBoard`; **no assignee/creator/resolverPolicy check exists** — Stage 1 `resolverPolicy` must update these tests deliberately):
  - active `operator` member who is neither assignee nor creator can reject (200; `resolvedByUserId` recorded) and accept (200).
  - `viewer` member → 403 `"Viewer access is read-only"`.
  - same-company agent (no runId) → 403 `"Agent actors cannot resolve issue-thread interactions through this board-only route"`.

  **`budget hard-stop blocks collab-triggered continuation wake`** (agent seeded `status: "paused"`, `pauseReason: "budget"`; issue assigned to it; pending confirmation with `continuationPolicy: "wake_assignee"`):
  - reject → route **409** with `"Agent is paused because its budget hard-stop was reached."` (`budgets.ts:782–789` via the gate at `heartbeat.ts:14468–14478`); `agentWakeupRequests` has exactly one row `status === "skipped"`, `reason === "budget.blocked"`; `heartbeatRuns` empty; **and the interaction row is `rejected`** — characterization of today's non-atomic split (roadmap §4.1 #14 / outbox plan Track A change this deliberately).
  - direct-gate test: `heartbeatService(db).wakeup(pausedAgentId, {...})` rejects with status 409 + the budget reason (budget gate fires before the invokability gate; `evaluateAgentInvokability` lives in `server/src/services/agent-invokability.ts:73`).
- [ ] **Step 2: Run** — `pnpm exec vitest run --project @paperclipai/server server/src/__tests__/collab-invariants-routes.test.ts` → all pass (self-skip with warning on hosts without embedded Postgres).
- [ ] **Step 3: Commit** — `test(server): freeze collab invariants (XOR, boundary, resolver, budget wake)`

### Task B4: Attention exit characterization tests (service)

**Files:**
- Create: `server/src/__tests__/collab-attention-interaction-exit.test.ts` (general-server group)

Bootstrap: copy `attention-service.test.ts:48–136` (embedded Postgres, `seedCompany`/`insertIssue` factories, afterEach table deletes).

- [ ] **Step 1: Write four cases** against real `attentionService(db)` + `issueThreadInteractionService(db)`:
  - pending `request_confirmation` appears with the frozen contract: `sourceKind === "issue_thread_interaction"`, `subject.status === "pending"`, `entryRule === "issue_thread_interactions.status = 'pending'"`, `exitRule === "Interaction resolves, expires, fails, or is cancelled."`, `inlineResolvable === true`, `dedupKey === \`interaction:${id}\``.
  - after `rejectInteraction(...)` → item absent; `feed.countsBySourceKind.issue_thread_interaction === 0` (field name per `packages/shared/src/types/attention.ts:175`).
  - after `acceptInteraction({ id, companyId, projectId: null, goalId: null }, ...)` → item absent (seed `createdByAgentId: null`, `sourceRunId: null` to skip creator-return/workspace gates).
  - rows seeded directly in `expired`/`cancelled`/`answered` never appear (pending-only filter `attention.ts:75, 663–666`).
- [ ] **Step 2: Run** — `pnpm exec vitest run --project @paperclipai/server server/src/__tests__/collab-attention-interaction-exit.test.ts` → pass.
- [ ] **Step 3: Commit** — `test(server): freeze attention entry/exit contract for interactions`

### Task B5: Contract-shape freezes (attention union, interaction bodies, C6 baseline)

**Files:**
- Modify: `server/src/__tests__/attention-service.test.ts` (extend; harness already present)
- Create: `server/src/__tests__/issue-thread-interaction-contract.test.ts` (model on `issue-thread-interactions-service.test.ts`; do NOT model on `issue-thread-interaction-routes.test.ts` — it mocks the service, so bodies are mock echoes)
- Modify: `server/src/services/recovery/successful-run-handoff.test.ts` (extend; pure unit, `decide()` helper at line 42)

Snapshot style: the repo has **zero** `toMatchSnapshot` usage — freeze with exhaustive inline `toEqual` literals; no `.snap` files.

- [ ] **Step 1: attention-service.test.ts — two new cases:**
  - `"freezes the attention item contract for a pending interaction and a pending approval"` — exhaustive `toEqual` per item: `id = "${sourceKind}:${dedupKey}"`, `dismissalKey = "attention:${dedupKey}"`, dedupKey formats (`interaction:${id}`, `approval:${id}`), entry/exit rule strings, `inlineResolvable`, `severity: "medium"`, `decisionVerbs` ids, `detail.kind`; plus `Object.keys(feed.countsBySourceKind).sort()` = the 10 `AttentionSourceKind` values.
  - `"surfaces an exhausted successful-run-handoff recovery action with its production identity"` — **seed exactly what the production writer writes** (`recovery/service.ts:2472–2573`): `kind: "missing_disposition"`, `cause: "successful_run_missing_state"`, `fingerprint: "source_scoped_recovery:${companyId}:${issueId}:successful_run_missing_state"`, `status: "escalated"`, `ownerType: "board"`, `nextAction: "Choose and record a valid issue disposition without copying transcript content."`. Assert full `dedupKey`, `severity: "high"`, and `subject.metadata` with **all six keys** `{ kind, cause, ownerType, ownerUserId: null, sourceIssueId, recoveryIssueId: null }` (`attention.ts:810–817`). Note: an older test seeds `cause: "missing_disposition"`, which does not match the writer — this case is the real C6 baseline Stage 1's canonical-dedup work must keep stable or migrate deliberately.
- [ ] **Step 2: issue-thread-interaction-contract.test.ts — three cases** (real DB + supertest board actor):
  - POST create → 201, exhaustive body keys (`id, companyId, issueId, kind, idempotencyKey, sourceCommentId, sourceRunId, title, summary, status, continuationPolicy, createdAt, updatedAt, resolvedAt, createdByAgentId, createdByUserId, resolvedByAgentId, resolvedByUserId, payload, result` — matches `packages/db/src/schema/issue_thread_interactions.ts:16–35`), `status: "pending"`, `result: null`.
  - accept → 200 `toMatchObject({ status: "accepted", result: { version: 1, outcome: "accepted" }, resolvedByUserId, resolvedAt: expect.any(String) })`; service-level `acceptInteraction` → `toEqual({ interaction: …, createdIssues: [], continuationIssue: null })`.
  - attention visibility until resolve, absent after (ties the exit rule to the route layer).
- [ ] **Step 3: successful-run-handoff.test.ts — one new case:**
  - `"freezes the coexistence skip contract for pending interactions and approvals"` — `expect(decide({ hasPendingInteractionOrApproval: true })).toEqual({ kind: "skip", reason: "pending interaction or approval owns the next action" })`; plus exhaustive `toEqual` on the enqueue payload keys **including `taskKey`** (`successful-run-handoff.ts:420`) and the four model-profile keys `modelProfile, allowDeliverableWork, allowDocumentUpdates, resumeRequiresNormalModel`, and the idempotencyKey format `finish_successful_run_handoff:${issueId}:${sourceRunId}:1`.
- [ ] **Step 4: Run all three** — `pnpm exec vitest run --project @paperclipai/server server/src/__tests__/attention-service.test.ts server/src/__tests__/issue-thread-interaction-contract.test.ts server/src/services/recovery/successful-run-handoff.test.ts` → pass.
- [ ] **Step 5: Commit** — `test(server): freeze attention/interaction contracts + successful-run-handoff C6 baseline`

### Task B6: `enableHumanAgentCollab` flag scaffold (instance-scoped)

**Files:**
- Modify: `packages/shared/src/types/instance.ts` (interface `InstanceExperimentalSettings`, after `enableDecisions: boolean;` at line 60: add `enableHumanAgentCollab: boolean;`)
- Modify: `packages/shared/src/validators/instance.ts` (in `instanceExperimentalSettingsSchema` after line 54: `enableHumanAgentCollab: z.boolean().default(false),` — patch schema derives automatically)
- Modify: `server/src/services/instance-settings.ts` (`normalizeExperimentalSettings`: success branch `enableHumanAgentCollab: parsed.data.enableHumanAgentCollab ?? false,` after line 217; fallback object `enableHumanAgentCollab: false,` after line 246; `applyExperimentalSettingsPatch` needs no change)
- Modify: `ui/src/pages/InstanceExperimentalSettings.tsx` (derived const near line 293 + a toggle `Card` modeled on the Isolated Workspaces card at lines 557–573, label "Human–Agent Collaboration", `aria-label="Toggle human-agent collaboration experimental setting"`)
- Test: `packages/shared/src/validators/instance.test.ts`, `server/src/__tests__/instance-settings-service.test.ts`, `ui/src/pages/InstanceExperimentalSettings.test.tsx`

No DB migration (singleton jsonb `instance_settings.experimental`), no route/OpenAPI edits (schema-derived). The consumer hook (`useHumanAgentCollabEnabled`) is deferred to the first UI consumer (Stage 2) — do not add it now.

- [ ] **Step 1: Write the failing tests** (patterns: `instance.test.ts:63–77`, `instance-settings-service.test.ts:54–127`):
  - `"defaults human-agent collab off"` — `instanceExperimentalSettingsSchema.parse({}).enableHumanAgentCollab === false`
  - `"accepts human-agent collab patches"` — `patchInstanceExperimentalSettingsSchema.parse({ enableHumanAgentCollab: true })` equals `{ enableHumanAgentCollab: true }`
  - `"defaults enableHumanAgentCollab to false for empty and legacy stored settings"`; `"round-trips an enableHumanAgentCollab patch through the update merge"`; `"rejects non-boolean enableHumanAgentCollab values back to the default"`
  - UI: extend the existing toggle-row coverage for the new card.
- [ ] **Step 2: Run to verify failure** — `npx vitest run packages/shared/src/validators/instance.test.ts server/src/__tests__/instance-settings-service.test.ts` → new cases FAIL (property missing).
- [ ] **Step 3: Apply the four edits above.**
- [ ] **Step 4: Run** — same vitest command + UI test → PASS; `pnpm typecheck` → clean.
- [ ] **Step 5: E2E toggle note for later specs** — flags are flipped via `PATCH /api/instance/settings/experimental` (pattern: `tests/e2e/onboarding.spec.ts:36–40`). The patch schema is `.strip()`: PATCHing an unknown key returns 200 with the key silently dropped — collab specs must assert the echo: `expect(((await flagRes.json()) as { enableHumanAgentCollab?: boolean }).enableHumanAgentCollab).toBe(true);`
- [ ] **Step 6: Commit** — `feat(instance): add enableHumanAgentCollab experimental flag (default off)`

### Task B7: `doc/design/COLLAB-EXTENSION-POINTS.md`

**Files:**
- Create: `doc/design/COLLAB-EXTENSION-POINTS.md`

- [ ] **Step 1: Write the document with these 11 sections** (verified anchors in parentheses):
  1. **Purpose and scope** — the only sanctioned extension points for Stages 1–5; anything else is a redesign (§2.1 rule).
  2. **Closed interaction payload schemas** — kinds/statuses/policies unions (`packages/shared/src/constants.ts:246–275`); payload validators (`packages/shared/src/validators/issue.ts:615/665/745/765/909`, union at 1013–1066). Rule: Stage 1 fields are additive optional on existing schemas; never new kinds or resolve verbs.
  3. **Attention union + dedupKey rules** — closed unions (`packages/shared/src/types/attention.ts:3–23, 69–145`); id/dismissal derivation (`attention.ts:305–306, 323`); the 10 dedupKey formats; one dedup family per underlying wait (R1); exit by terminal status, not dismissal; copy/rank are not schema.
  4. **Wake, coalesce, and idempotency keys** — `enqueueWakeup` coalesce/defer semantics (`heartbeat.ts:15045–15139`); reserved idempotency-key namespaces (`finish_successful_run_handoff:…`, run-liveness, `issue-monitor:…`, `task_watchdog:{id}:{stopFingerprint}`); scheduler tick ordering (`server/src/index.ts:942–1051`). Rule: every collab wake carries a server-derived key + distinct `wakeReason`; steer is non-interrupt default — snapshot merge alone is not delivery (§10.3).
  5. **Successful-run-handoff coexistence** — options, skip ladder incl. `hasPendingInteractionOrApproval` (`successful-run-handoff.ts:19–24, 340–399`); Stage 1 package may satisfy the pending disposition; single-attempt bound stays terminal.
  6. **Task watchdog eligibility + human-reserve** — authority contract (doc/TASK-WATCHDOG.md L107–140; SPEC-implementation §9.9); scope enforcement (`task-watchdog-scope.ts:51,151`; `routes/issues.ts:3329–3342, 3542–3685`); new rule: package-bearing / `humanOnly` confirmations permanently watchdog-ineligible (R5).
  7. **Accepted timeout-actor matrix** — the five-row matrix below, verbatim.
  8. **Resolve/outbox atomicity boundary** — one transaction for terminal interaction + activity + intent; delivery retries independently; never hint-only resume (R10; outbox plan Track A).
  9. **Do-not-use: `issue_execution_decisions` for steer** — rows are stage-bound (stageId + outcome NOT NULL); steer = typed comment + dedicated delivery-state row (§10.3, R6).
  10. **Live-events WS channel rules** — endpoint (`live-events-ws.ts:86`), closed `LIVE_EVENT_TYPES` union of 11 (`constants.ts:793–806`); UI transport only — no wait may exist only as a WS event; company-scoping mandatory.
  11. **Change control** — every stage PR adding a schema field / wake reason / dedupKey family / event type updates this doc in the same PR. Also **amend roadmap §14** to add a DoD checkbox referencing this doc (it does not reference it today — this is a proposed roadmap edit, include it in this PR).

- [ ] **Step 2: Embed the timeout-actor matrix** (§3.3 Q5 deliverable; corrected anchors):

| Actor | Trigger | Action scope | Must yield to | Anchor |
|---|---|---|---|---|
| Monitor `recoveryPolicy` | `timeout_exceeded` / `max_attempts_exhausted` at monitor dispatch (via `tickDueIssueMonitors`) | Clears monitor; `wake_owner` (default) / `create_recovery_issue` / `escalate_to_board`; never terminalizes interactions or the issue | Agent-async lane only — never the timeout owner for human waits; wakes ride standard budget/pause gates | `heartbeat.ts:5909–6215, 16075`; execution-semantics §8 |
| Stranded-liveness recovery | Periodic scan of non-terminal issues with no live execution path — incl. **unassigned `in_review`** issues resolved via typed participant (`recovery/service.ts:2984–3022`) | One bounded auto-requeue preserving owner; on exhaustion `blocked` + explicit recovery; never reassigns | Active path, pending interaction/approval, pause holds, budget, execution-policy state; successful-run-handoff owns the succeeded-no-disposition case | `recovery/service.ts:2979–3060`; `run-liveness-continuations.ts:9,85–189` |
| Task watchdog | Whole watched subtree at rest + new stop fingerprint | In-subtree verification; may resolve ONLY eligible plan confirmations; cannot touch config/typed decisions/approvals | Any live path; scope checks; **Stage 1 human-reserve (package/`humanOnly`)**; Stage 4b owns interaction deadlines | TASK-WATCHDOG.md L82–140; `task-watchdogs.ts:496–498` |
| Future single SLA owner (4b) | Deadline on a human-wait interaction; CAS claim on a non-terminal timeout-action row per `(interactionId, policyVersion, action)`; injectable `now` | Issue-scoped alert/escalate/`blocked`/recovery only; never terminalize, pause agents, or approve governed actions | Human resolution always wins (resolve-before-timeout prevents claim; resolve-after-claim clears it) | roadmap §11.2 |
| Frozen `silentDefault` (hint) | Never triggers in Stages 1–3 | Schema-only (`silentDefaultHint`, §8.4); persisted/displayed at most; future input to the 4b evaluator | Everything | roadmap §8.4, §3.2, §6 GA-cut list |

- [ ] **Step 3: Commit** — `docs(design): collab extension points + accepted timeout-actor matrix` (include the §14 roadmap amendment)

### Task B8: Telemetry source map + pre-Stage-1 baselines

**Files:**
- Modify: `doc/design/COLLAB-EXTENSION-POINTS.md` (add section 12 "Metrics source map") — or a sibling `doc/design/COLLAB-METRICS.md` if B7 grows too large
- Modify (one-line, optional but recommended): `tests/e2e/playwright.config.ts` webServer `env` — add `PAPERCLIP_TELEMETRY_DISABLED: "1"` (local e2e runs are NOT opted out today: the CI opt-out envs don't apply locally and the server defaults telemetry on, `server/src/config.ts:335`)

There is **no telemetry codegen command** — `packages/shared/src/telemetry/generated/paperclip-telemetry.ts` is a vendored canonical contract (commit `8a93a0de`); changes are hand-edits coordinated with the upstream generator owner, per `packages/shared/src/telemetry/README.md` §"Adding Or Changing Telemetry".

- [ ] **Step 1: Record the per-metric source map** (§17 → source → owning stage → baseline):

| §17 metric | Source | Stage | Pre-Stage-1 baseline |
|---|---|---|---|
| Median time-to-human-decision | Extend `interaction.resolved` emission with the **already-contract-approved but unemitted** `resolution_latency_seconds` (compute from `resolvedAt − createdAt` inside `emitInteractionResolvedTelemetry`, `issue-thread-interactions.ts:429`; batch sites at 1632/1772/1844 inherit). Local SQL: `percentile_cont(0.5)` over `resolved_at − created_at` where `resolved_by_user_id IS NOT NULL` | Stage 0 defines; Stage 1 emits | Run the local SQL on dogfood instances; record in Stage 0 exit notes |
| % human waits with decision package | New dim `has_decision_package?: boolean` on `interaction.resolved` (contract edit). Denominator: `created_by_kind="agent" AND resolved_by_kind="user"` | Stage 1 | Denominator volume (already emitted); numerator 0% by construction |
| % checklist issues terminal with artifacts | New event `issue.checklist_completed` (no terminal-transition event exists). Local join `issues.status='done'` × `issue_work_products` | Stage 2a | Local proxy: share of done issues with ≥1 work product |
| Orphaned waits → ~0 | **Local DB query only** (server liveness definition): pending interactions older than 24h, refined by the R1 action-path predicate | Stage 0 defines predicate | Run pre-Stage-1; record count + age distribution |
| Steer without cancel | New event `steer.applied` (`consumed_by`, `run_cancelled`, `coalesced`) | Stage 3a | None (feature absent) |
| Board-governed auto-approvals = 0 | **Not telemetry** — server invariant tests (B3) + local audit query | Stage 0, every stage | Run now; expected 0 (permanent target) |
| Human questions per completed issue | Numerator exists (`interaction_kind="ask_user_questions"`); denominator local ratio vs `issues.status='done'` | Stage 4a | Compute local ratio pre-Stage-1 |

  Also record the Stage 1 rider: start emitting the already-approved `has_reason`, `interaction_id`, `created_by_agent_id`, `source_run_id`; add `request_item_verdicts` + `item_count`/`resolved_item_count` to the contract (computed today, silently dropped — `events.ts:380–403`).
- [ ] **Step 2: Run the three baseline queries** (latency median, orphaned-wait count, questions-per-done-issue) against a dogfood instance; record results + date in the doc.
- [ ] **Step 3: Commit** — `docs(design): collab metrics source map + baselines; disable telemetry in e2e webServer`

### Task B9: `@collab` lane + CI honesty

**Files:**
- Modify: `tests/e2e/playwright.config.ts` (add `grepInvert: process.env.PAPERCLIP_E2E_COLLAB_JOURNEY === "1" ? undefined : /@collab-journey/` — note: this is the first env-conditional in this config; `PAPERCLIP_E2E_SKIP_LLM` is only ever *set* by workflows, nothing reads it)
- Modify: `doc/DEVELOPING.md` ("Test Commands" section, `pnpm test:e2e` block at ~line 159)
- Modify: `doc/plans/2026-07-12-human-agent-collaboration-roadmap.md` (§5.5 wording)

- [ ] **Step 1: Tagging convention** — all collab specs get `{ tag: "@collab" }` (B2 already does); the future §13 journey spec gets `{ tag: ["@collab", "@collab-journey"] }` so the default run excludes only the journey.
- [ ] **Step 2: Document the manual commands** in DEVELOPING.md: all collab specs `pnpm run test:e2e -- --grep @collab`; including the journey `PAPERCLIP_E2E_COLLAB_JOURNEY=1 pnpm run test:e2e -- --grep @collab`. Scheduled execution stays out of scope (§7.1 goal 6); if later owned, it is a new `.github/workflows/e2e-collab-nightly.yml` with a `schedule:` trigger — the first in this repo (zero exist today) — plus a named flake owner.
- [ ] **Step 3: Fix §5.5 honesty** — "main CI" today means *PR-to-master CI + manual `workflow_dispatch` (`e2e.yml`)*; no push-to-master or scheduled lane runs e2e (verified across all 10 workflow files). Update the row so Stage exit criteria never assume a lane that doesn't exist.
- [ ] **Step 4: Run** — `pnpm test:e2e` → green (journey tag not present yet, `grepInvert` is a no-op today by design).
- [ ] **Step 5: Commit** — `test(e2e): @collab lane + grepInvert journey guard; document manual commands`

### Task B10 (optional, same epic): Re-base `signoff-policy.spec.ts` onto the harness

- [ ] Replace its local copies of lines 28–161 and 163–258 with imports from `tests/e2e/helpers/collab.ts`; behavior must be diff-identical (§7.4). Run full `pnpm test:e2e` before/after. Commit separately — `refactor(e2e): signoff-policy uses collab harness`. Skip if it churns the gold spec too close to a release.

---

## Workstream C — Stage 1 implementation plan (authoring gate)

### Task C1: Write `doc/plans/2026-07-XX-structured-decision-package.md`

**Blocked by:** Workstream A signed off; B1–B5 merged (harness + frozen baselines are the regression floor).

- [ ] **Step 1: Required content checklist** (§18.3 — "not an open-ended schema brainstorm"):
  - Final `DecisionPackageEnrichment` shared-validator fields (from §8.4 shape + Q11/Q13 ratified answers), as additive optional fields on the existing closed payload schemas.
  - The Q2 verb-map table verbatim (UI label → endpoint → status/result → continuation side effects).
  - Successful-run-handoff coexistence design: how a package satisfies the pending disposition; the canonical dedup identity; which B5 baseline assertions change and how (deliberate migration, not silent).
  - Watchdog human-reserve: the SPEC-implementation §9.9 eligibility amendment text + the C5 non-accept test list; note that watchdog-authority expansion requires product/security review per SPEC.
  - Resolver policy enforcement design against today's authority (B3 characterization tests are the before-state; list exactly which of them flip to 403 and why).
  - Transactional resolve/outbox integration: consume `doc/plans/2026-07-12-continuation-outbox-and-immutable-provenance.md` Track A as a dependency — Phase 1 (additive schema/contracts) must land before or with Stage 1 slice 3; failure-injection test plan per §8.6.
  - Queue bounds + attention pagination numbers (Q13), including the attention route's first query params.
  - Flag gating (`enableHumanAgentCollab`), skill/capability rollout per Q10, thin e2e (`collab-structured-handoff.spec.ts`, `@collab` tag).
- [ ] **Step 2: Review the plan against §8.5's nine slices and §8.7 exit criteria** — every slice and every exit bullet must map to a task.

---

## Definition of done (Stage 0 exit, maps to §7.4)

- [ ] A1 decision record merged; Q3/Q9 have product answers; roadmap §3.3 items annotated
- [ ] B1–B5: helpers + smoke green in `pnpm test:e2e`; all characterization/contract tests green in `pnpm test`
- [ ] B6: flag defaults off everywhere; `pnpm typecheck` clean; no behavior change flag-off
- [ ] B7: extension-points doc merged (incl. timeout-actor matrix + §14 DoD amendment)
- [ ] B8: metrics source map recorded; three baseline numbers captured with date
- [ ] B9: `@collab` commands documented; §5.5 CI wording honest
- [ ] Full default `pnpm test:e2e` green twice in CI (PR run + re-run of the same commit — the measurable form of §5.4 Stage 0 exit)
