# Stage 1 — Structured Decision Package Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When work waits on a human, WhatNeedsMe shows a decision package — why, options, artifacts, effort — as additive enrichment on the existing `issue_thread_interactions` machinery, with server-enforced resolver authority, bounded queues, failure-atomic resolves, and a permanently human-reserved watchdog. This is the Stage 1 GA promise (decisions record Q9: "WhatNeedsMe shows a decision package").

**Architecture:** No new interaction kinds, no new resolve verbs, no second handoff concept, no second outbox (COLLAB-EXTENSION-POINTS §2, §5, §8). One optional `decisionPackage` object is added to the five existing closed payload schemas; resolution rides the existing `accept | reject | respond | verdicts | cancel` endpoints and `none | wake_assignee | wake_assignee_on_accept` continuation policies; failure-atomicity comes from the continuation-outbox plan Track A, on which this plan takes an explicit dependency (§3).

**Tech Stack:** Zod validators (`packages/shared`), Drizzle (`packages/db`), Express routes + Vitest 4 with embedded Postgres (`server/src`), React + Storybook (`ui/src`, `ui/storybook`), Playwright (`tests/e2e`).

Status: Proposed implementation plan
Date: 2026-07-13
Closes: roadmap §18 item 3 ("Stage 1 implementation plan with verb map + successful-run-handoff coexistence + watchdog eligibility") and pre-Stage-1 execution plan Task C1.

## 0. Binding sources

Everything below is derived from — and must not contradict — these documents. Where this plan repeats them, the source governs.

| Source | What it binds here |
|---|---|
| `doc/plans/2026-07-12-human-agent-collaboration-roadmap.md` §8 (shape §8.4, slices §8.5, verification §8.6, exit §8.7), §3.1 R1/R2/R5/R10, §3.2 cuts | Stage scope, slice list, exit criteria, reassign CUT, silentDefault worker FROZEN |
| `doc/plans/2026-07-13-collab-pre-code-decisions.md` (all 16 closed) | Q1 handoff satisfy, Q2 verb map, Q3 optional-at-GA, Q4 watchdog reserve, Q7 flag scope, Q10 skill policy, Q11 resolver authority, Q12 outbox, Q13 bounds |
| `doc/design/COLLAB-EXTENSION-POINTS.md` (normative) | §2 closed payload schemas, §3 attention/dedup, §5 handoff coexistence, §6 watchdog reserve, §7 timeout-actor matrix, §8 resolve/outbox boundary, §11 change control, §12 metrics |
| `doc/plans/2026-07-12-continuation-outbox-and-immutable-provenance.md` Track A (§§5.1–5.6) | Failure-atomic resolve. **Dependency, not re-planned here** — see §3 |
| Regression floor: `server/src/__tests__/collab-invariants-routes.test.ts`, `server/src/__tests__/attention-service.test.ts`, `server/src/__tests__/issue-thread-interaction-contract.test.ts`, `server/src/__tests__/collab-attention-interaction-exit.test.ts`, `server/src/services/recovery/successful-run-handoff.test.ts`, `server/src/__tests__/low-trust-red-team-routes.test.ts:983–1046` (LT-26: low-trust interaction-create denial — the low-trust floor behind §8.7 exit bullet 3), `tests/e2e/helpers/collab.ts`, `tests/e2e/collab-harness-smoke.spec.ts` | Before-state this plan deliberately amends — exact assertion migrations are listed per task and summarized in §7 |

## Global Constraints

- **No new interaction `kind`, no new resolve verb, no new continuation policy** (extension-points §2; Q2). Enrichment is additive optional fields on the five existing payload schemas only.
- **`reassign` stays cut** from interaction options (roadmap §3.2); assignee changes go through `PATCH /api/issues/:id` only.
- **`silentDefaultHint` is schema-only.** No worker reads it in Stages 1–3 (roadmap §3.2; extension-points §7 row 5).
- **No live LLM in any new test** (roadmap §4.2). Board + agent API keys + heartbeat invoke (`signoff-policy` pattern, via `tests/e2e/helpers/collab.ts`).
- **Flag:** `enableHumanAgentCollab` (instance experimental, exists since Stage 0 — `packages/shared/src/types/instance.ts:61`, default `false`). Gate pattern: `getExperimental()` + `403 { code: "FEATURE_DISABLED" }`, per `server/src/routes/board-chat.ts:99–110`. Flag-off data compatibility per §8.7 exit bullet 1 is specified in §6.
- **COLLAB-EXTENSION-POINTS.md must be updated in the same PR** as any schema field, wake reason, dedupKey family, or event type addition (its §11; roadmap §14 DoD checkbox). Tasks below name the required edit.
- **Server test naming:** files matching `/[^/]*(?:route|routes|authz)[^/]*\.test\.ts$/` are auto-serialized (`scripts/run-vitest-stable.mjs:23`). New route-driving suites below use `…-routes.test.ts` names deliberately; no registry edits.
- **E2E helpers** must not use `.spec.ts` suffix and must not import `@paperclipai/shared` (local structural mirrors only, as `tests/e2e/helpers/collab.ts` already does).
- **Every commit passes:** targeted vitest for touched files; `pnpm typecheck` when shared/server/ui types change; `pnpm test:e2e` when `tests/e2e/` changes; `node .gitnexus/run.cjs detect-changes` scope check before commit (repo CLAUDE.md).
- **Characterization amendments are deliberate, never silent:** every regression-floor assertion this plan changes is listed in the owning task and in §7, replacing the Stage 0 `// Stage 1 changes this deliberately: <roadmap ref>` markers with the delivered behavior.

---

## 1. The shape — final shared-validator fields

### 1.1 New sub-schemas (`packages/shared/src/validators/issue.ts`)

Final field names. These land immediately above `createIssueThreadInteractionSchema` (today at `packages/shared/src/validators/issue.ts:1013–1064`).

```ts
export const decisionPackageResolverPolicySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("board") }),
  z.object({ kind: z.literal("responsible_user"), userId: z.string().trim().min(1).max(255) }),
  z.object({ kind: z.literal("typed_execution_participant"), userId: z.string().trim().min(1).max(255) }),
]);

export const decisionPackageRequiredArtifactSchema = z.object({
  kind: z.enum(["work_product", "attachment"]),
  id: z.string().uuid(),
});

export const decisionPackageOptionLabelsSchema = z.object({
  accept: z.string().trim().min(1).max(80).optional(),
  reject: z.string().trim().min(1).max(80).optional(),
  requestChanges: z.string().trim().min(1).max(80).optional(),
});

// Schema-only until Stage 4b — NO worker enforcement in Stage 1 (roadmap §8.4, §3.2).
export const decisionPackageSilentDefaultHintSchema = z.object({
  afterMinutes: z.number().int().min(5).max(43_200),
  preferred: z.enum(["escalate", "leave_pending"]),
});

// Create-side: what callers may submit. Deliberately has NO humanOnly field —
// zod strips unknown keys, so a caller-supplied humanOnly is discarded, and the
// server stamps the derived value at persist time (Q4: server-derived, callers
// cannot turn it off by omitting or overriding the field).
export const decisionPackageInputSchema = z.object({
  version: z.literal(1),
  reason: z.string().trim().min(1).max(2000),
  optionLabels: decisionPackageOptionLabelsSchema.optional(),
  requiredArtifacts: z.array(decisionPackageRequiredArtifactSchema).max(20).optional(),
  estimatedHumanMinutes: z.number().int().min(1).max(480).optional(),
  resolverPolicy: decisionPackageResolverPolicySchema.optional().default({ kind: "board" }),
  silentDefaultHint: decisionPackageSilentDefaultHintSchema.optional(),
});

// Persisted/read-side: input shape + the server-derived human reservation.
export const decisionPackageSchema = decisionPackageInputSchema.extend({
  humanOnly: z.literal(true),
});

export type DecisionPackageInput = z.infer<typeof decisionPackageInputSchema>;
export type DecisionPackage = z.infer<typeof decisionPackageSchema>;
```

An interaction is **package-bearing** iff its persisted payload has a `decisionPackage` key. All caps, reservations, and detail projections key off exactly that predicate (SQL: `jsonb_exists(payload, 'decisionPackage')`).

### 1.2 Where the field attaches

One line — `decisionPackage: decisionPackageInputSchema.optional(),` — is added **inside the base `z.object({...})` literal** of each of the five payload schemas (they cannot be `.extend()`ed after `.superRefine` wraps them in `ZodEffects`):

| Schema | Anchor today |
|---|---|
| `suggestTasksPayloadSchema` | `packages/shared/src/validators/issue.ts:615` |
| `askUserQuestionsPayloadSchema` | `packages/shared/src/validators/issue.ts:665` |
| `requestConfirmationPayloadSchema` | `packages/shared/src/validators/issue.ts:745` |
| `requestCheckboxConfirmationPayloadSchema` | `packages/shared/src/validators/issue.ts:765` |
| `requestItemVerdictsPayloadSchema` | `packages/shared/src/validators/issue.ts:909` |

The discriminated union `createIssueThreadInteractionSchema` (`issue.ts:1013–1064`) is **not** restructured — it picks the field up through the payload schemas. The shared payload **types** (`packages/shared/src/types/issue.ts:1203`, `IssueThreadInteractionPayload` members) each gain `decisionPackage?: DecisionPackage | null`.

### 1.3 Server-derived fields (never trusted from the caller)

- **`humanOnly: true`** — stamped by `issueThreadInteractionService(db).create` (`server/src/services/issue-thread-interactions.ts:1107`, after `createIssueThreadInteractionSchema.parse` at line 1112) whenever `payload.decisionPackage` is present: `{ ...payload, decisionPackage: { ...payload.decisionPackage, humanOnly: true } }`. In Stage 1 the derivation rule is exactly "package present ⇒ humanOnly"; the persisted field exists so later stages can reserve non-package interactions from issue/policy context without a schema change.
- **`resolverPolicy` identity** — the create path validates that a `responsible_user` / `typed_execution_participant` `userId` is an active human member of the interaction's company (`company_memberships` row, `status = 'active'`); otherwise structured `422 { code: "DECISION_PACKAGE_RESOLVER_INVALID" }`. The server never trusts agent payload authority for resolver identity (roadmap §8.4).
- **Idempotency** — always server-derived (Q13). Package-bearing creates get no new client-supplied idempotency surface; resolve idempotency is the outbox fingerprint (`resolution:v1:<interaction-id>`, outbox plan §5.2).

### 1.4 The Q2 verb map

Decisions record Q2 (RATIFIED, quoted verbatim — the table below is its tabular form; if they ever disagree, the decision text wins):

> Decision-package UI options are presentation labels only (`optionLabels`), never new server verbs. Resolve maps exclusively onto the existing interaction endpoints — `POST /issues/:id/interactions/:interactionId/{accept|reject|respond|verdicts|cancel}` — using the existing continuation policies (`none | wake_assignee | wake_assignee_on_accept`). "Request changes" resolves either as reject/respond carrying a reason plus assignee wake, or, when the interaction lives inside a policy stage, as an execution-decision outcome of `changes_requested`. The `reassign` option is cut entirely from interaction resolution; assignee changes stay on the separate assignee PATCH path.

| UI option (label source) | Endpoint (existing — route anchor) | Status / result written | Continuation side effects |
|---|---|---|---|
| **Accept** (`decisionPackage.optionLabels.accept` ?? kind `acceptLabel` ?? default) | `POST /api/issues/:id/interactions/:interactionId/accept` (`server/src/routes/issues.ts:9157`) | `accepted`; kind result, e.g. `{ version: 1, outcome: "accepted" }`; `suggest_tasks` also creates child issues | `wake_assignee` / `wake_assignee_on_accept` → assignee wake; `none` → no wake. After Task 5: one durable outbox intent `resolution:v1:<interactionId>` (pending, or explicitly `suppressed` for no-wake outcomes) |
| **Reject** (`optionLabels.reject` ?? kind `rejectLabel` ?? default) | `POST …/reject` (`issues.ts:9265`) | `rejected`; result carries `reason` | `wake_assignee` → wake carrying the reason; `wake_assignee_on_accept` → suppressed (not accepted); `none` → suppressed |
| **Request changes** — no executionPolicy stage (`optionLabels.requestChanges`) | `POST …/reject` with `reason` (confirmation kinds) or `POST …/respond` with answers + `summaryMarkdown` (`ask_user_questions`, `issues.ts:9322`) | `rejected` / `answered`, reason text in result | Assignee wake; the continuation context carries the reason so the agent addresses changes |
| **Request changes** — inside an executionPolicy stage | `PATCH /api/issues/:id` stage transition that the policy maps to decision outcome `changes_requested` (decision row insert `issues.ts:8029`; wake builder `issues.ts:1985–2020`) | `issue_execution_decisions` row, `outcome: "changes_requested"` | Executor wake, reason `execution_changes_requested`, via existing stage machinery — never a parallel gate |
| **Answer questions** | `POST …/respond` (`issues.ts:9322`) | `answered`; result `answers[]` | Per continuation policy |
| **Item verdicts** (approve/reject/defer per item) | `POST …/verdicts` (`issues.ts:9375`) | `pending` until complete, then `answered` | Partial submissions wake once with `newlyResolvedItemIds` |
| **Cancel / withdraw** (board) | `POST …/cancel` (`issues.ts:9445`) | `cancelled`; reason in result | Per continuation policy (source `issue.interaction.cancel`) |
| **Reassign** | **CUT — no interaction endpoint exists or will exist** (roadmap §3.2, R2) | n/a | Assignee changes only via `PATCH /api/issues/:id` assignee fields |

### 1.5 Optional at GA (Q3)

Enrichment is **optional at Stage 1 GA**: skills strongly recommend it for human-owned waits (Tasks 7 and 10 carry the recommendations); the server validates it only when present and **never forces it** as a precondition to entering a human-owned wait. Revisit trigger (owned by product, tracked against extension-points §12's "% human waits with decision package enrichment" metric): if that metric stays low or time-to-decision does not improve after skill rollout, add a server-forced requirement via an executionPolicy stage precondition in a later stage.

---

## 2. Resolver authority model (Q11, final)

- `resolverPolicy` defaults to `{ kind: "board" }` (schema default, §1.1). Under the default, resolution authority is exactly today's: any active non-viewer member (board actor) may resolve; agents are denied by the board-only route guard (`server/src/routes/issues.ts:3602`).
- A **non-default** policy (`responsible_user` / `typed_execution_participant`) narrows resolution to: **(a)** the named `userId`, and **(b)** board principals as an audited override. "Board principal" is defined as: `local_implicit` board actor (single-operator instance), `isInstanceAdmin`, or active membership with role `owner` or `admin`. The full role union is `owner | admin | operator | viewer | member` (`COMPANY_MEMBERSHIP_ROLES`, `packages/shared/src/constants.ts:814–821`): active `operator` **and** `member` role principals who are not the named user are denied (the operator case is the deliberate flip of the Stage 0 characterization — Task 3); `viewer` stays denied earlier by the existing read-only guard.
- `typed_execution_participant` additionally requires the named user to still be the persisted participant on the issue's `executionPolicy` at resolve time (server re-derives; a stale participant is denied — unavailability escalates via the future Stage 4b SLA evaluator, never auto-reassigns).
- Every denial is a **non-disclosing** `403 { error: "You cannot resolve this interaction" }` — no policy kind, no named user in the body — and causes **no wake** (the guard runs before any service mutation). Former members (`status != 'active'`) and cross-company principals keep their existing denials (`server/src/routes/authz.ts:103–118`); low-trust runs and agents keep the agent denial at `issues.ts:3602` and the low-trust create denial (`assertLowTrustControlPlaneDenied`, `issues.ts:2643`, wired at create `issues.ts:9119`).
- Board override is audited: the resolve activity `details` gains `resolverPolicyOverride: { policyKind: "responsible_user" | "typed_execution_participant" }` when a board principal resolves an interaction whose policy names someone else.

## 3. Failure-atomic resolve — dependency contract (Q12)

Stage 1 **consumes** Track A of `doc/plans/2026-07-12-continuation-outbox-and-immutable-provenance.md` verbatim; it does not fork or duplicate it:

- **Hard sequencing gate:** outbox **Phase 1** (additive schema, shared contracts, transaction-safe activity primitive — outbox plan §8 Phase 1, files listed there) **must land before or with Task 5** (Stage 1 slice 3). Tasks 1–4 do not depend on it; Task 5 and GA do.
- Stage 1 resolves are **another producer on the same outbox** (extension-points §8): terminal interaction + activity + exactly one continuation intent in one transaction (outbox §5.3); leased CAS dispatcher (§5.4); deterministic event keys `resolution:v1:<interaction-id>` / `verdicts:v1:<interaction-id>:<fingerprint>` with RFC 8785 fingerprints — replay `200`, conflict `409`. No decision-package-specific outbox, event stream, or wake-key family.
- **Never hint-only resume (R10):** resolve always ends in a wake-policy effect, assignee, or explicit recovery action. No `resumeHint`-only path exists anywhere in this plan.
- If outbox Phase 2 (transactional producers) has already landed when Task 5 starts, Task 5 reduces to the package-specific failure-injection tests plus the characterization amendment listed there. If not, Task 5's implementation half **is** outbox Phase 2 for the interaction producers and must follow the outbox plan's §5.3 letter.

## 4. Queue bounds, supersession, pagination (Q13, final numbers)

| Bound | Value | Enforcement point | Failure |
|---|---|---|---|
| Pending package-bearing interactions per issue | **3** | create-transaction count of `status = 'pending' AND jsonb_exists(payload, 'decisionPackage')`, serialized by a `SELECT … FOR UPDATE` on the issue row (Task 4 Step 3) | `422 { code: "DECISION_PACKAGE_PENDING_ISSUE_LIMIT" }` |
| Pending package-bearing interactions per company | **100** | same predicate, company scope, serialized by a company-scoped advisory lock (or serializable-with-retry) — Task 4 Step 3 | `422 { code: "DECISION_PACKAGE_PENDING_COMPANY_LIMIT" }` |
| Encoded payload size | **64 KiB** (matches the outbox envelope bound, outbox plan §5.3) | `Buffer.byteLength(JSON.stringify(payload), "utf8")` in service create | `422 { code: "DECISION_PACKAGE_PAYLOAD_TOO_LARGE" }` |
| Attention pagination | keyset `cursor` + `limit`, **default 50 / max 200** | `GET /api/companies/:companyId/attention` | `422 { code: "ATTENTION_PAGE_INVALID" }` |

- **Attention route query params (first params ever beyond `includeDismissed`, `server/src/routes/attention.ts:10–25`):** `limit` (int, 1–200) and `cursor` — opaque `base64url(JSON.stringify([activityAtIso, itemId]))` taken from the previous page's last item. A JSON tuple, **not** a delimiter-joined string: attention item ids are themselves colon-delimited (`${sourceKind}:${dedupKey}`, and dedupKeys embed further colons), so any single-character delimiter would be ambiguous. Pagination engages when either param is present; a param-less request keeps today's full response byte-compatible with the Stage 0 contract freeze. When engaged, items sort strictly by `(activityAt DESC, id DESC)`, the response envelope gains `nextCursor: string | null`, and `limit` defaults to 50 when only `cursor` is supplied. `rank` remains presentation-only (extension-points §3: copy/rank are not schema); pagination changes nothing about entry/exit rules.
- **Supersession:** a newer package-bearing interaction on the same `(issue, kind, target)` — target = the `requestConfirmationTarget` `key` + `revisionId` when present, else issue-level — expires the older pending one **in the same create transaction**, via the existing supersession lifecycle (status `expired`). **Scope (explicit):** interaction-supersession applies to exactly the four kinds whose result schemas already record supersession — `request_confirmation`, `request_checkbox_confirmation`, `ask_user_questions`, `request_item_verdicts`. The additive schema change is the new member `"superseded_by_interaction"` alongside today's `"superseded_by_comment"` in **all three** result schemas that carry it: `requestConfirmationResultSchema.outcome` (`issue.ts:870–877`, inherited by `requestCheckboxConfirmationResultSchema` via `.extend`), `askUserQuestionsResultSchema.expirationReason` (`issue.ts:708`), and `requestItemVerdictsResultSchema.outcome` (`issue.ts:993`). `suggest_tasks` is **excluded**: its result schema has no supersession member (`suggestTasksResultSchema`, `issue.ts:643`) and the service treats it as non-supersedable today (`shouldSupersedeInteractionOnUserComment` family, `issue-thread-interactions.ts:228–294`) — a newer pending `suggest_tasks` package does not expire an older one; both simply count against the caps. No new supersession mechanism (Q13).

---

## 5. Task sequence

```text
Task 1 (schema + gated create) ──► Task 2 (artifact integrity)
        │                          Task 3 (resolver policy)
        │                          Task 4 (bounds + pagination)
        │                          Task 6 (watchdog reserve)
        │                          Task 7 (handoff coexistence)
        │                          Task 9 (telemetry rider)
        ├──────────────► Task 8 (attention detail + UI)   ◄─ also needs Task 4 (pagination for WhatNeedsMe)
        └─ outbox Phase 1 (external) ─► Task 5 (transactional resolve + failure injection)
Tasks 1–9 ──► Task 10 (skills/OpenAPI/CLI + capability advertisement) ──► Task 11 (thin e2e)
```

Each task is one PR-sized unit with its own tests and commit. Tasks 2, 3, 4, 6, 7, 9 are parallelizable after Task 1. GA ships all eleven in one stop; the release sentence leads with the decision package (Q9).

---

### Task 1: Shared schema + gated server validation (slice 1 + slice 9)

**Files:**
- Modify: `packages/shared/src/validators/issue.ts` (sub-schemas per §1.1; one `decisionPackage` line in each of the five payload object literals per §1.2)
- Modify: `packages/shared/src/types/issue.ts:1203` region (payload types gain `decisionPackage?: DecisionPackage | null`)
- Modify: `server/src/services/issue-thread-interactions.ts:1107–1208` (`create`: stamp `humanOnly`, 64 KiB payload bound, resolver-identity validation per §1.3)
- Modify: `server/src/routes/issues.ts:9109–9154` (create route: flag gate)
- Modify: `doc/design/COLLAB-EXTENSION-POINTS.md` §2 (record the field addition — same-PR change control)
- Test: `packages/shared/src/validators/decision-package.test.ts` (new), `server/src/__tests__/decision-package-create-routes.test.ts` (new; route-suffixed name → serialized suite)

**Interfaces — Produces:** `decisionPackageInputSchema`, `decisionPackageSchema`, `DecisionPackageInput`, `DecisionPackage` (consumed by Tasks 2–10); persisted payloads with `payload.decisionPackage.humanOnly === true`; error codes `FEATURE_DISABLED` (403), `DECISION_PACKAGE_PAYLOAD_TOO_LARGE`, `DECISION_PACKAGE_RESOLVER_INVALID` (422).

- [ ] **Step 1: Write failing shared-validator tests** (`decision-package.test.ts`):
  - `"accepts a minimal package and defaults resolverPolicy to board"` — parse `{ version: 1, reason: "Choose rollout window" }` → `resolverPolicy` equals `{ kind: "board" }`.
  - `"strips caller-supplied humanOnly from the input schema"` — parse input containing `humanOnly: false` → key absent from output.
  - `"rejects unknown resolverPolicy kinds and missing userId"` — `{ kind: "anyone" }` and `{ kind: "responsible_user" }` both fail.
  - `"accepts silentDefaultHint bounds and rejects out-of-range afterMinutes"` — 5 and 43200 pass; 4 and 43201 fail.
  - `"persisted decisionPackageSchema requires humanOnly literal true"` — parse without `humanOnly` fails; `humanOnly: false` fails.
  - `"createIssueThreadInteractionSchema accepts decisionPackage on all five kinds"` — one representative payload per kind parses.
- [ ] **Step 2: Run to verify failure** — `pnpm exec vitest run packages/shared/src/validators/decision-package.test.ts` → FAIL (schemas not defined).
- [ ] **Step 3: Add the schemas and type edits** (§1.1, §1.2). Re-run Step 2's command → PASS. `pnpm typecheck` → clean.
- [ ] **Step 4: Write failing route tests** (`decision-package-create-routes.test.ts`, embedded Postgres + supertest; seed helpers copied from `collab-invariants-routes.test.ts`):
  - `"rejects a package-bearing create with FEATURE_DISABLED while the flag is off; no row persisted"` — flag off (default), POST create with `payload.decisionPackage` → `403 { code: "FEATURE_DISABLED" }`, zero rows.
  - `"creates a plain interaction unchanged while the flag is off"` — body byte-equal to the frozen contract (`issue-thread-interaction-contract.test.ts` create case; no new keys).
  - `"persists a package with server-stamped humanOnly and defaulted resolverPolicy when the flag is on"` — enable via `instanceSettingsService(db).updateExperimental({ enableHumanAgentCollab: true })`; POST create → 201; body `payload.decisionPackage` equals input + `humanOnly: true`, `resolverPolicy { kind: "board" }`.
  - `"overrides caller-supplied humanOnly:false with the server-derived value"`.
  - `"rejects an over-64KiB payload with DECISION_PACKAGE_PAYLOAD_TOO_LARGE; no row"` — `detailsMarkdown` filler crossing 65 536 encoded bytes.
  - `"rejects a resolverPolicy naming a non-member or inactive member with DECISION_PACKAGE_RESOLVER_INVALID"` — two cases: unknown userId; seeded membership with a non-active status.
  - `"keeps the low-trust control-plane denial for a low-trust run creating a package-bearing interaction"` — flag on; seed a low-trust-run actor per the LT-26 fixture pattern (`server/src/__tests__/low-trust-red-team-routes.test.ts:983–1046`); POST create with `payload.decisionPackage` → the existing `assertLowTrustControlPlaneDenied` 403, no row, no wake. (§8.7 exit bullet 3's low-trust leg — the package field must not open a low-trust path that plain payloads don't have.)
  - `"keeps flag-on-created packages readable and resolvable after the flag turns off"` — create with flag on; flip flag off; `GET /api/issues/:id/interactions` returns the package intact; `POST …/accept` → 200. (§8.7 exit bullet 1.)
- [ ] **Step 5: Run to verify failure, then implement** — route gate (before `issueThreadInteractionsSvc.create`, only when `req.body?.payload?.decisionPackage != null`, per the `board-chat.ts:99–110` pattern — reads and resolves are **never** flag-gated); service stamping + payload bound + resolver-identity check inside `create` before the insert.
- [ ] **Step 6: Run** — `pnpm exec vitest run --project @paperclipai/server server/src/__tests__/decision-package-create-routes.test.ts server/src/__tests__/issue-thread-interaction-contract.test.ts` → PASS (contract freeze untouched); `pnpm typecheck` → clean.
- [ ] **Step 7: Update `COLLAB-EXTENSION-POINTS.md` §2** — record that `decisionPackage` now exists on all five schemas, with anchors.
- [ ] **Step 8: Commit** — `feat(shared,server): decision-package enrichment schema + flag-gated create validation`

### Task 2: Nested-reference integrity for `requiredArtifacts` (slice 2, reference half)

**Files:**
- Modify: `server/src/services/issue-thread-interactions.ts` (create: validate `requiredArtifacts` targets)
- Modify: `server/src/routes/issues.ts:6745` (`DELETE /work-products/:id`: pending-package guard) and `server/src/routes/issues.ts:10636` (`DELETE /attachments/:attachmentId`: same guard)
- Test: `server/src/__tests__/decision-package-artifact-routes.test.ts` (new)

**Interfaces — Consumes:** Task 1 schemas. **Produces:** error codes `DECISION_PACKAGE_ARTIFACT_INVALID` (422, create) and `DECISION_PACKAGE_ARTIFACT_IN_USE` (409, delete).

Rule (roadmap §8.4): targets must exist, belong to the interaction's company **and issue**, and remain inspectable while the package is pending. This plan picks the `409` branch of the roadmap's "409 or atomically mark incomplete" choice — deleting a referenced artifact while the package is pending returns `409`; after the interaction reaches any terminal status, deletion proceeds normally. Rationale: no new "incomplete package" state machine (thin core).

- [ ] **Step 1: Write failing tests:**
  - `"rejects a package referencing a work product from another issue"` → 422 `DECISION_PACKAGE_ARTIFACT_INVALID`, no row.
  - `"rejects a cross-company work product reference with a non-disclosing message"` — same code; identical body whether the foreign artifact exists or not.
  - `"rejects an unknown attachment id"` and `"accepts same-issue work_product and attachment references"` (201; both kinds).
  - `"409s work-product deletion while a pending package references it, allows it after resolve"` — DELETE → `409 { code: "DECISION_PACKAGE_ARTIFACT_IN_USE" }`; accept the interaction; DELETE succeeds.
  - `"keeps referenced artifacts listed while the package is pending"` — `GET /api/issues/:id/work-products` still returns the row (inspectability).
- [ ] **Step 2: Run to verify failure, implement** — create-side: one query per kind against `issue_work_products` / issue attachments with `companyId` + `issueId` predicates. Delete-side: `EXISTS` query for pending interactions whose payload `requiredArtifacts` contains the target (`payload->'decisionPackage'->'requiredArtifacts' @> jsonb_build_array(jsonb_build_object('kind','work_product','id', $id))`).
- [ ] **Step 3: Run** — task suite + `server/src/__tests__/decision-package-create-routes.test.ts` → PASS.
- [ ] **Step 4: Commit** — `feat(server): decision-package required-artifact integrity + pending-reference delete guard`

### Task 3: Resolver-policy enforcement (slice 2, authority half)

**Files:**
- Modify: `server/src/routes/issues.ts` — new helper `assertInteractionResolverPolicyAllowed(req, res, issue, interactionId)` beside `rejectAgentIssueThreadInteractionResolution` (`issues.ts:3586–3604`); wired into all five resolve routes (`9157` accept, `9265` reject, `9322` respond, `9375` verdicts, `9445` cancel) after `assertBoard(req)`; resolve activity `details` gains `resolverPolicyOverride` when set
- Modify: `server/src/services/issue-thread-interactions.ts` — export `getInteractionForIssue(issue, interactionId)` (company-scoped read used by the guard)
- Modify: `server/src/__tests__/collab-invariants-routes.test.ts` — deliberate characterization amendment (Step 3)
- Test: `server/src/__tests__/decision-package-resolver-routes.test.ts` (new)

**Interfaces — Consumes:** Task 1 (`resolverPolicy` in persisted payload). **Produces:** the §2 authority model; non-disclosing `403 { error: "You cannot resolve this interaction" }`.

Guard sketch (final semantics per §2):

```ts
const interaction = await issueThreadInteractionsSvc.getInteractionForIssue(issue, interactionId);
const policy = interaction?.payload?.decisionPackage?.resolverPolicy;
if (!policy || policy.kind === "board") return true; // today's authority unchanged
const membership = req.actor.memberships?.find(
  (m) => m.companyId === issue.companyId && m.status === "active",
);
const isBoardPrincipal = req.actor.source === "local_implicit" || req.actor.isInstanceAdmin === true
  || membership?.membershipRole === "owner" || membership?.membershipRole === "admin";
const isNamedResolver = req.actor.userId === policy.userId
  && (policy.kind !== "typed_execution_participant"
      || currentTypedParticipantUserId(issue) === policy.userId);
if (isNamedResolver) return true;
if (isBoardPrincipal) { res.locals.resolverPolicyOverride = { policyKind: policy.kind }; return true; }
res.status(403).json({ error: "You cannot resolve this interaction" });
return false;
```

- [ ] **Step 1: Write failing tests** (`decision-package-resolver-routes.test.ts`; seed pattern from `collab-invariants-routes.test.ts`, package seeded directly in the payload jsonb):
  - `"lets the named responsible_user (operator role) accept"` → 200.
  - `"denies a different active operator with a non-disclosing 403 and no wake"` — 403 exact body `{ error: "You cannot resolve this interaction" }`; interaction still `pending`; zero `agent_wakeup_requests` rows.
  - `"denies an active member-role principal who is not the named user"` — membership role `member` (`COMPANY_MEMBERSHIP_ROLES` includes it alongside the four human roles); same non-disclosing 403, no wake.
  - `"lets an owner resolve against a responsible_user policy and audits the override"` — 200; `activity_log` row `issue.thread_interaction_accepted` with `details.resolverPolicyOverride = { policyKind: "responsible_user" }`.
  - `"lets the local_implicit board actor resolve with the same audited override"`.
  - `"denies a stale member (membership no longer active) before policy evaluation"` — existing `"User does not have active company access"` 403; no wake.
  - `"enforces typed_execution_participant against the persisted policy participant"` — named user matching the issue's executionPolicy participant → 200; same user after the policy participant changed → 403 non-disclosing.
  - `"applies the policy on every resolve verb"` — reject/respond/verdicts/cancel each 403 for the non-named operator (one compact loop).
  - `"leaves package-free interactions on today's authority"` — operator accepts a plain interaction → 200 (unchanged).
  - Cross-company, viewer, and agent denials are **not** re-tested here — they stay frozen in `collab-invariants-routes.test.ts`.
- [ ] **Step 2: Run to verify failure, implement the guard + activity detail.**
- [ ] **Step 3: Amend the characterization floor** (`collab-invariants-routes.test.ts`, "resolver authority characterization" describe) — the before-state → after-state ledger; every change deliberate:
  - `"lets an active operator who is neither assignee nor creator accept and reject"` — **kept green, scope narrowed**: retitle to `"lets an active operator … accept and reject interactions without a decision package"`; replace the `// Stage 1 changes this deliberately: roadmap §8.4 resolverPolicy…` comment with a pointer to the delivered guard and `decision-package-resolver-routes.test.ts`. Assertion body unchanged — plain interactions keep board-wide authority.
  - **New flipped sibling in the same describe**: `"denies that same operator once the interaction carries a narrower resolverPolicy (Stage 1 flip)"` — identical seeding + `payload.decisionPackage = { version: 1, reason: "…", humanOnly: true, resolverPolicy: { kind: "responsible_user", userId: "someone-else" } }` → accept and reject both 403, pending, no wake. **This is the case that flips operator-can-resolve → 403.**
  - `"denies a viewer with 403 Viewer access is read-only"` — **unchanged**.
  - `"denies a same-company agent actor (no runId) with the board-only-route 403"` — **unchanged**.
  - Company-boundary and assignee-XOR blocks — **unchanged**.
- [ ] **Step 4: Run** — `pnpm exec vitest run --project @paperclipai/server server/src/__tests__/decision-package-resolver-routes.test.ts server/src/__tests__/collab-invariants-routes.test.ts` → PASS.
- [ ] **Step 5: Commit** — `feat(server): enforce decision-package resolverPolicy with audited board override`

### Task 4: Queue bounds, supersession, attention pagination (slice 4)

**Files:**
- Modify: `server/src/services/issue-thread-interactions.ts` (create transaction: caps + supersession)
- Modify: `packages/shared/src/validators/issue.ts` (`requestConfirmationResultSchema.outcome` at `issue.ts:870–877`, `askUserQuestionsResultSchema.expirationReason` at `issue.ts:708`, **and** `requestItemVerdictsResultSchema.outcome` at `issue.ts:993` gain `"superseded_by_interaction"`; `suggestTasksResultSchema` is deliberately untouched — §4 scope); mirror in `packages/shared/src/types/issue.ts`
- Modify: `packages/db/src/schema/issue_thread_interactions.ts` + generated migration (next free number after current head `0145`, coordinating with outbox Phase 1 which also expects the next slot): partial index on `("company_id", "status")` `WHERE status = 'pending' AND jsonb_exists(payload, 'decisionPackage')`
- Modify: `server/src/routes/attention.ts:10–25` (params), `server/src/services/attention.ts` (`list` gains optional `page: { limit: number; cursor?: string }`), `packages/shared/src/types/attention.ts:171–177` (`AttentionFeed` gains `nextCursor?: string | null`)
- Modify: `doc/design/COLLAB-EXTENSION-POINTS.md` §2 (result-reason members) and §3 (pagination note: entry/exit rules unaffected)
- Test: `server/src/__tests__/decision-package-bounds-routes.test.ts`, `server/src/__tests__/attention-pagination-routes.test.ts` (both new)

**Interfaces — Consumes:** Task 1. **Produces:** §4 bounds/codes; `AttentionFeed.nextCursor`; `page` option on `attentionService.list` (consumed by Task 8 UI and Task 11 helpers).

- [ ] **Step 1: Write failing bounds tests** (`decision-package-bounds-routes.test.ts`):
  - `"rejects the 4th pending package-bearing interaction on one issue with DECISION_PACKAGE_PENDING_ISSUE_LIMIT"` — 3 seeded pending → 4th create 422; a **plain** 4th interaction still succeeds (caps count package-bearing only).
  - `"rejects the 101st pending package-bearing interaction in a company with DECISION_PACKAGE_PENDING_COMPANY_LIMIT"` — seed 100 rows directly across issues.
  - `"supersedes the older pending package on the same issue/kind/target"` — two package-bearing `request_confirmation` creates, same `target.key` + `revisionId` → older row `expired` with result reason `superseded_by_interaction`, expired **in the same transaction**; newer `pending`; attention shows exactly one item (`interaction:${newerId}`) and the older item exited by terminal status.
  - `"supersedes an older pending ask_user_questions package on the same issue-level target (non-confirmation kind)"` — older row `expired` with `result.expirationReason: "superseded_by_interaction"`; proves the §4 scope covers the questions/verdicts family, not just the confirmation result shape.
  - `"does not supersede across different kinds or targets, and never supersedes suggest_tasks"` — different `kind` or different `target.revisionId` → both pending (both count against the cap); two pending package-bearing `suggest_tasks` interactions coexist (excluded kind per §4 — no supersession member in `suggestTasksResultSchema`), both counting against the cap.
  - `"survives concurrent duplicate creates without exceeding the cap"` — two parallel creates at the cap boundary → exactly one 201. This holds only because Step 3 serializes the count-then-insert (issue-row `FOR UPDATE` / company advisory lock): under plain READ COMMITTED both transactions would read the same pre-insert count and both insert, and the partial index — being non-unique — accelerates the count but enforces nothing.
- [ ] **Step 2: Write failing pagination tests** (`attention-pagination-routes.test.ts`):
  - `"returns the legacy full response when no pagination params are supplied"` — no `nextCursor` key, all items (protects the frozen contract in `attention-service.test.ts:967`).
  - `"pages with limit and cursor without overlap or gaps"` — seed 5 pending interactions; `?limit=2` → 2 items + `nextCursor`; follow twice → 2 + 1, `nextCursor: null`; union of ids equals the unpaginated set, no duplicates.
  - `"defaults limit to 50 when only cursor is supplied"`.
  - `"rejects limit 0, limit 201, and a malformed cursor with ATTENTION_PAGE_INVALID"` — three 422s.
  - `"composes includeDismissed with pagination"`.
- [ ] **Step 3: Run to verify failure, implement** — caps + supersession inside the create transaction, with **explicit serialization** (a count-then-insert under READ COMMITTED cannot enforce a cap by itself; the partial index is non-unique, so it accelerates the count but enforces nothing):
  1. `SELECT … FOR UPDATE` on the company-scoped issue row **first** (the repo's standard issue-before-children lock order, same as the outbox producers), serializing the per-issue count of pending package-bearing rows;
  2. `pg_advisory_xact_lock(hashtext('decision_package_cap:' || companyId))` before the per-company count (alternative: `SERIALIZABLE` with a bounded retry loop — pick one mechanism and use it for both caps consistently), so the 100/company cap cannot be raced across different issues;
  3. then count → structured 422 before insert; supersession `UPDATE … SET status = 'expired', result = …` before insert (kind-scoped per §4), plus an `issue.thread_interaction_expired` activity row with `details.supersededByInteractionId`.
  Pagination per §4 (sort `(activityAt DESC, id DESC)` when `page` present, slice `limit`, `nextCursor` from the last emitted item). `pnpm db:generate` + `pnpm --filter @paperclipai/db check:migrations` for the index.
- [ ] **Step 4: Run** — both new suites + `server/src/__tests__/attention-service.test.ts` + `server/src/__tests__/collab-attention-interaction-exit.test.ts` → PASS (existing freezes untouched); `pnpm typecheck`.
- [ ] **Step 5: Commit** — `feat(server,db): decision-package queue bounds + supersession; attention keyset pagination`

### Task 5: Transactional resolve on the continuation outbox + failure injection (slice 3)

**Blocked by:** outbox plan Phase 1 (hard gate, §3); coordinates with outbox Phase 2.

**Files:**
- Modify: `server/src/services/issue-thread-interactions.ts` (all five resolution families become outbox producers per outbox plan §5.3 — or no production change here if Phase 2 already landed)
- Modify: `server/src/__tests__/collab-invariants-routes.test.ts` (budget block — deliberate flip, Step 2)
- Test: `server/src/__tests__/issue-interaction-continuation-outbox.test.ts` (name from the outbox plan §10; extend it if Phase 2 created it)

**Interfaces — Consumes:** outbox Phase 1 schema (`issue_thread_interaction_continuation_outbox`), `resolution:v1:<interaction-id>` event keys. **Produces:** failure-atomic package resolves; the R1 "durable wake/recovery path" evidence §8.6 requires.

- [ ] **Step 1: Write failing package-specific outbox tests:**
  - `"a package-bearing accept persists interaction, activity, and exactly one continuation intent in one transaction"` — accept with `wake_assignee`; one outbox row, `event_key = "resolution:v1:" + interactionId`, status `pending`; a forced rollback (inject an error after the interaction update inside the transaction) leaves zero rows of all three kinds.
  - `"a policy-none package resolve records an explicit suppressed intent"` — the no-wake decision is durable and inspectable (outbox §5.3 step 6).
  - `"crash after producer commit leaves a claimable intent"` — commit, do not run the dispatcher; row `pending` with due `next_attempt_at`; a later `tick()` delivers exactly one wake.
  - `"crash after outbox claim is recovered by lease expiry"` — claim with a short lease, do not complete; expired lease reclaimed by a second `tick()`; claim-token CAS blocks the stale worker from terminalizing the row.
  - `"replayed accept returns 200 with no duplicate activity/outbox/wake; contradictory replay returns 409"` — same fingerprint vs. changed body.
  - `"R1: resolve restores liveness through an action-path primitive, not a hint"` — after dispatch, an `agent_wakeup_requests` row (or coalesced receipt) exists; no assertion anywhere on `resumeHint`.
  - `"there is no package-specific outbox"` — a package-bearing and a plain resolve produce rows in the **same** table with the same key family.
- [ ] **Step 2: Amend the budget characterization** (`collab-invariants-routes.test.ts`, "budget hard-stop blocks collab-triggered continuation wake") — **deliberate flip**, replacing the `// Stage 1 changes this deliberately: roadmap §4.1 #14 / continuation-outbox plan Track A…` marker:
  - `"409s the reject's continuation wake while the interaction resolution persists"` → becomes `"commits the reject with a durable continuation intent while the budget hard-stop defers delivery"`: response flips **409 → 200**; interaction `rejected` (unchanged); **new:** one outbox row in `pending`/`retry_wait` (budget is a retryable rejection at dispatch, outbox §5.5 — never a lost wake, never an immediate run); still zero `heartbeat_runs`; the old assertion of an immediate `skipped` wake row is dropped (delivery is now owned by the dispatcher).
  - `"blocks heartbeatService(db).wakeup directly with the budget reason (fires before invokability)"` (`collab-invariants-routes.test.ts:453`) — **unchanged** (the budget gate itself is untouched).
- [ ] **Step 3: Run** — new suite + `collab-invariants-routes.test.ts` + `issue-thread-interaction-contract.test.ts` (the service `acceptInteraction` return shape must stay `toEqual`-identical; if Phase 2 changes it, that migration belongs to the outbox plan's PR, not this one) → PASS.
- [ ] **Step 4: Commit** — `feat(server): package resolves ride the continuation outbox; failure-injection coverage`

### Task 6: Watchdog human-reserve + SPEC §9.9 amendment (slice 6, C5)

**Files:**
- Modify: `server/src/routes/issues.ts:3586–3604` (`rejectAgentIssueThreadInteractionResolution` gains the reservation check, evaluated **before** the watchdog-scope branch)
- Modify: `server/src/services/issue-thread-interactions.ts` (export `isHumanReservedInteraction(interaction)` so any future watchdog-resolver path shares the single predicate)
- Modify: `doc/SPEC-implementation.md` §9.9 (amendment text below)
- Modify: `doc/design/COLLAB-EXTENSION-POINTS.md` §6 (mark the clause landed)
- Test: `server/src/__tests__/collab-watchdog-human-reserve-routes.test.ts` (new)

**Interfaces — Consumes:** Task 1 (`humanOnly` stamping). **Produces:** `isHumanReservedInteraction`; 403 body `{ error: "This interaction is reserved for a human decision" }`.

Predicate: `payload.decisionPackage != null` (which implies the stamped `humanOnly: true`); the helper also honors a bare `humanOnly` marker so later stages can reserve without a package. Note today's route already 403s **all** agent actors (`issues.ts:3602`); this task makes the human reservation an explicit, separately-tested precondition so the SPEC §9.9 watchdog resolver can never gain package-bearing/`humanOnly` interactions when it is implemented.

**Exact SPEC-implementation §9.9 amendment.** Insert this bullet into the list "A plan confirmation is eligible only when all of these are true:" (after the purpose-marker bullet):

> - the interaction is not human-reserved: it does not carry a decision package (`payload.decisionPackage`) and is not marked `humanOnly`. Both markers are server-derived from persisted issue/policy context at creation time; no caller — including the watchdog's own plan-confirmation resolution path — can remove the reservation by omitting or overriding a payload field. Package-bearing or `humanOnly` confirmations are permanently watchdog-ineligible (human reservation; see `doc/design/COLLAB-EXTENSION-POINTS.md` §6).

**Review requirement:** §9.9 closes with "Any expansion requires a new product/security review." This amendment *narrows* watchdog authority rather than expanding it, but it edits the authority contract itself — the PR carrying this task therefore requires explicit product + security sign-off recorded in the PR description, per that SPEC clause and roadmap §3.1 R5.

- [ ] **Step 1: Write the failing C5 non-accept test list** (seed a watchdog-context agent run via the `resolveTaskWatchdogMutationScope` fixtures used by existing watchdog route tests, plus package-bearing interactions):
  - `"the watchdog cannot accept a package-bearing plan confirmation"` — accept → 403 `{ error: "This interaction is reserved for a human decision" }`; interaction stays `pending`; zero wake rows.
  - `"the watchdog cannot reject a package-bearing plan confirmation"` — the reservation covers both verdict directions.
  - `"the reservation fires before watchdog scope is evaluated"` — an in-scope watchdog run gets the reservation body, not the scope-denial body (ordering proof).
  - `"a caller-supplied humanOnly:false cannot defeat the reservation"` — create via route with `humanOnly: false` inside the package input; stored payload has `humanOnly: true`; watchdog accept → 403.
  - `"plain agent actors keep today's board-only 403 for non-reserved interactions"` — the existing `issues.ts:3602` body, frozen.
- [ ] **Step 2: Run to verify failure, implement the guard + helper.**
- [ ] **Step 3: Apply the SPEC §9.9 text amendment and the extension-points §6 status update.** Record product/security sign-off in the PR.
- [ ] **Step 4: Run** — new suite + `collab-invariants-routes.test.ts` → PASS.
- [ ] **Step 5: Commit** — `feat(server),docs(spec): permanent watchdog human-reserve for package-bearing/humanOnly confirmations`

### Task 7: Successful-run-handoff coexistence + canonical dedup identity (slice 7, C6)

**Files:**
- Modify: `server/src/services/recovery/successful-run-handoff.ts` (`buildSuccessfulRunHandoffInstruction` — one added sentence, below)
- Modify: `server/src/services/recovery/successful-run-handoff.test.ts` (deliberate baseline migration, Step 1)
- Test: `server/src/__tests__/collab-handoff-coexistence.test.ts` (new, embedded Postgres)

**Interfaces — Consumes:** Task 1. **Produces:** the Q1 coexistence contract, proven end-to-end.

Design (Q1 + extension-points §5): a decision package **satisfies** the pending disposition — it never becomes a second handoff. Mechanics, all existing:

- `decideSuccessfulRunHandoff` already skips when `hasPendingInteractionOrApproval` is true (`successful-run-handoff.ts:340–399`, skip at 389–390). A pending package-bearing interaction sets that input true → the corrective handoff wake never fires while the package owns the wait. **No code change to the skip ladder.**
- **Canonical dedup identity:** the wait is owned by the existing `interaction:${interaction.id}` attention family (extension-points §3 rule R1). The recovery family `recovery:missing_disposition:${sourceIssueId}:successful_run_missing_state:${fingerprint}` appears **only** on exhaustion with no pending interaction. No new dedupKey family is minted anywhere in Stage 1.
- The single-attempt bound (`DEFAULT_MAX_SUCCESSFUL_RUN_HANDOFF_ATTEMPTS = 1`, `successful-run-handoff.ts:9`) stays terminal — a package does not grant a second automatic attempt. The wake idempotency key `finish_successful_run_handoff:${issueId}:${runId}:1` is untouched.
- Per Q3 (optional at GA, skills recommend): the corrective handoff **instruction** gains one sentence, appended to `buildSuccessfulRunHandoffInstruction` output:

> When the disposition you choose is a human decision, attach a decision package to the interaction you create — a one-paragraph reason, option labels, required artifacts, and an estimated human effort — so the board sees a decision package instead of bare status (see the paperclip skill's "Decision packages" section).

- [ ] **Step 1: Migrate the frozen baseline deliberately** (`successful-run-handoff.test.ts`) — the exact assertion changes, and the only ones:
  - `"freezes the coexistence skip contract for pending interactions and approvals"` (line 385): the expected `payload.instruction` is computed by calling `buildSuccessfulRunHandoffInstruction(...)`, so it stays green **by construction** when the builder changes; add `// Stage 1 deliberately extended the instruction text: decisions record Q3 (skills recommend enrichment)`. The skip assertion `toEqual({ kind: "skip", reason: "pending interaction or approval owns the next action" })` is **unchanged** — that is the stability the freeze exists to prove.
  - `"queues one corrective handoff wake …"` (line 68): the three existing `toContain` instruction assertions are **unchanged** (the sentence is additive); add one new `toContain("attach a decision package")`.
  - Everything else in the file, including the exhaustive enqueue-payload `toEqual` keys, is **unchanged**.
  - `attention-service.test.ts:1066` (`"surfaces an exhausted successful-run-handoff recovery action with its production identity"`) — **unchanged**: exhausted recovery still surfaces when no interaction is pending; this test is the standing proof the recovery dedup family survives Stage 1 untouched.
- [ ] **Step 2: Write the failing coexistence integration tests** (`collab-handoff-coexistence.test.ts`):
  - `"a pending package-bearing interaction yields exactly one attention item for the wait"` — seed issue + pending package interaction + the recovery-action row a handoff exhaustion would write; the feed contains the `interaction:${id}` item; assert **no** second item surfaces for the same wait under the recovery family while the interaction is pending (dedupKey scan + `countsBySourceKind`).
  - `"decideSuccessfulRunHandoff skips while the package-bearing interaction is pending and enqueues after it resolves"` — drive the pure function with inputs derived from the seeded rows: pending → `skip` with the frozen reason; resolved + no other action path → `enqueue` with the unchanged idempotency key.
  - `"resolving the package clears the attention item by terminal status"` — `collab-attention-interaction-exit` style; dismissal is not exit (extension-points §3).
- [ ] **Step 3: Run to verify failure; add the instruction sentence; run** — `pnpm exec vitest run --project @paperclipai/server server/src/services/recovery/successful-run-handoff.test.ts server/src/__tests__/collab-handoff-coexistence.test.ts server/src/__tests__/attention-service.test.ts` → PASS.
- [ ] **Step 4: Commit** — `feat(server): decision package satisfies successful-run-handoff disposition; canonical dedup proven`

### Task 8: Attention detail + WhatNeedsMe/IssueDetail rendering (slice 5)

**Files:**
- Modify: `packages/shared/src/types/attention.ts:69–145` — the six interaction-derived `AttentionItemDetail` variants (`plan_approval`, `confirmation`, `questions`, `suggested_tasks`, `checkbox_confirmation`, `item_verdicts`) each gain:

```ts
decisionPackage?: {
  reason: string;
  estimatedHumanMinutes: number | null;
  requiredArtifactCount: number;
  optionLabels: { accept: string | null; reject: string | null; requestChanges: string | null };
  resolverPolicy:
    | { kind: "board" }
    | { kind: "responsible_user" | "typed_execution_participant"; userId: string };
} | null;
```

- Modify: `server/src/services/attention.ts` (`interactionDetail` builder feeding item creation at `attention.ts:672–716`: populate from `payload.decisionPackage`, `null` when absent)
- Modify: `ui/src/components/IssueThreadInteractionCard.tsx` (reason block, effort chip, required-artifact count/links, `optionLabels` on the accept/reject buttons — labels only; buttons keep posting to the existing endpoints), `ui/src/components/AttentionQueueRow.tsx` + `ui/src/components/AttentionInteractionResolver.tsx` (reason excerpt + labels), `ui/src/pages/WhatNeedsMe.tsx` (pass `limit=50` now that pagination exists — Task 4)
- Modify: `ui/storybook/stories/issue-thread-interactions.stories.tsx` + `ui/storybook/stories/what-needs-me.stories.tsx` (package-bearing variants — roadmap §14 DoD: new visual surface needs a story, visual diffs reviewed, a11y clean)
- Modify: `doc/design/COLLAB-EXTENSION-POINTS.md` §3 (detail-variant field addition — same-PR change control)
- Test: `server/src/__tests__/attention-service.test.ts` (one **added** case + one additive field in the frozen literal, Step 1), `ui/src/components/IssueThreadInteractionCard.test.tsx`, `ui/src/pages/IssueDetail.test.tsx`

**Interfaces — Consumes:** Tasks 1, 4. **Produces:** `AttentionItemDetail.decisionPackage` (consumed by Task 11's e2e asserts).

- [ ] **Step 1: Write failing server test** — `"enriches interaction detail with the decision package summary"` (added to `attention-service.test.ts`): seed a package-bearing confirmation; the feed item's `detail.decisionPackage` equals the projection above; a plain interaction's `detail.decisionPackage` is `null`. The frozen case `"freezes the attention item contract for a pending interaction and a pending approval"` (line 967) gets exactly one deliberate edit: add `decisionPackage: null` to its expected interaction `detail` literal with a `// Stage 1 additive field` comment (its seeds are package-free).
- [ ] **Step 2: Write failing UI tests** — `"renders reason, effort, artifact count, and custom labels for a package-bearing interaction"`; `"custom accept label still posts to the accept endpoint"` (assert the fetch URL is the unchanged `/accept` route); `"renders unchanged for package-free interactions"`.
- [ ] **Step 3: Implement server projection + UI rendering + stories.** Run the server suite, the UI test files, `pnpm typecheck`, `pnpm check:token-gates`, and the Storybook visual suite per repo practice → PASS/clean. No UI flag read is needed: the card is data-driven (packages only exist if the flag allowed their creation), which also gives flag-off rendering compatibility for §6.
- [ ] **Step 4: Commit** — `feat(shared,server,ui): decision-package attention detail + WhatNeedsMe/IssueDetail cards`

### Task 9: Telemetry rider (extension-points §12)

**Files:**
- Modify: `packages/shared/src/telemetry/generated/paperclip-telemetry.ts` — hand-edit coordinated with the upstream generator owner per `packages/shared/src/telemetry/README.md` §"Adding Or Changing Telemetry" (no codegen command exists): add `has_decision_package?: boolean`, `item_count?: number`, `resolved_item_count?: number`, and the `request_item_verdicts` member on `interaction_kind`
- Modify: `packages/shared/src/telemetry/events.ts:132–167` (`trackInteractionResolved` forwards the new dimensions)
- Modify: `server/src/services/issue-thread-interactions.ts:380–430` — `buildInteractionResolvedCounts`'s already-computed-but-dropped counts get wired through; `emitInteractionResolvedTelemetry` computes `resolution_latency_seconds = resolvedAt − createdAt` and populates the already-approved-but-unemitted `has_reason`, `interaction_id`, `created_by_agent_id`, `source_run_id`; the three batch call sites at lines 1632/1772/1844 inherit
- Test: extend `server/src/__tests__/issue-thread-interactions-service.test.ts` + the shared events test

- [ ] **Step 1: Write failing tests** — `"emits resolution_latency_seconds and has_decision_package on resolve"` (package-bearing → `true`, plain → `false`; latency equals the seeded timestamp delta); `"forwards item_count and resolved_item_count for request_item_verdicts"`.
- [ ] **Step 2: Implement; run; `pnpm typecheck`.** No flag read: the dimensions describe persisted data, and `has_decision_package` is `false` by construction while the flag is off — the only flag-off delta is a new false-valued dimension, called out in the PR description.
- [ ] **Step 3: Commit** — `feat(shared,server): interaction.resolved latency + decision-package telemetry dimensions`

### Task 10: Skill, capability advertisement, OpenAPI/CLI parity (slice 8, Q10)

**Files:**
- Modify: `skills/paperclip/SKILL.md` (interactions section, ~line 201: new "Decision packages" subsection) and `skills/paperclip/references/api-reference.md` (create-body fields)
- Modify: `server/src/routes/openapi.ts` (interaction create/resolve path docs at `openapi.ts:3398–3470` + `:5358`: document `payload.decisionPackage` and the §4 error codes; document `limit`/`cursor` on the attention path entry)
- Modify: `server/src/services/heartbeat.ts` — wake `contextSnapshot` composition gains `collabCapabilities: { decisionPackage: true }` **only when** `enableHumanAgentCollab` is on (flag-read precedent: `heartbeat.ts:11089`); flag off ⇒ key absent ⇒ snapshot byte-identical to today
- Verify (expected no production change): `cli/src/__tests__/issue-subresources.test.ts` — the CLI posts pass-through interaction bodies; add one case proving a `decisionPackage` body round-trips unmodified
- Test: extend the heartbeat context-composition suite for the capability key

**Q10 policy, applied concretely:** shared validator + server + OpenAPI + skill ship in this same PR series ("capability-advertised, same-change-set", per `doc/plans/2026-05-23-cli-api-parity.md`); the skill teaches the field **conditionally**, so rollout order can never instruct an agent to send a field the server rejects:

> Include `payload.decisionPackage` only when your wake context advertises `collabCapabilities.decisionPackage`. If the server responds `403 FEATURE_DISABLED`, retry the same interaction without the field — a plain interaction is always acceptable; the package is strongly recommended for human-owned waits, never required.

The skill subsection documents: the §1.1 fields, the caller-visible half of the Q2 verb map (labels are presentation; resolution stays on existing endpoints), the §4 bounds with their `422` codes, and the Q3 recommendation rule.

- [ ] **Step 1: Write failing server test** — `"advertises collabCapabilities.decisionPackage in wake context only while the flag is on"` (flag on → key present `{ decisionPackage: true }`; flag off → key absent).
- [ ] **Step 2: Implement the context key; write the skill + reference + OpenAPI edits; add the CLI pass-through case.**
- [ ] **Step 3: Run** — heartbeat context suite, CLI suite, `pnpm typecheck` → PASS. Confirm §8.7 exit bullet 6 evidence: skill guidance is capability-conditioned and shipped in the same change-set as server support.
- [ ] **Step 4: Commit** — `feat(server),docs(skills): capability-advertised decision-package rollout + OpenAPI/CLI parity`

### Task 11: Thin e2e smoke (§8.6 browser layer)

**Files:**
- Create: `tests/e2e/collab-structured-handoff.spec.ts` (tag `@collab`)
- Modify: `tests/e2e/helpers/collab.ts` — additive extensions only (no `.spec.ts` suffix, no `@paperclipai/shared` import):
  - new local structural mirror `interface DecisionPackageInputLite { version: 1; reason: string; optionLabels?: { accept?: string; reject?: string; requestChanges?: string }; requiredArtifacts?: Array<{ kind: "work_product" | "attachment"; id: string }>; estimatedHumanMinutes?: number; resolverPolicy?: { kind: "board" } | { kind: "responsible_user" | "typed_execution_participant"; userId: string } }` — pass-through into the existing `CreateInteractionBody.payload` (`Record<string, unknown>`), so `createInteraction` itself needs no change
  - new helper `getAttentionPage(board, companyId, opts: { limit?: number; cursor?: string; includeDismissed?: boolean })` → `{ items: AttentionItemLite[]; nextCursor: string | null }` (targets Task 4's params; existing `getAttentionItems`/`expectAttentionExit` unchanged)
  - new helper `setHumanAgentCollabFlag(board, enabled: boolean)` → `PATCH /api/instance/settings/experimental`, asserting the response echo `enableHumanAgentCollab === enabled` (the patch schema strips unknown keys silently — the echo assertion is mandatory, per the Stage 0 flag-scaffold note)
- Verify unchanged and green: `tests/e2e/collab-harness-smoke.spec.ts`, `tests/e2e/signoff-policy.spec.ts`

**Spec content** (API-orchestrated state, thin UI asserts — roadmap §5.1: Playwright proves presentation and one happy path, not the matrix):

- [ ] **Step 1: Write the spec:**
  - `test.describe("Structured decision package", { tag: "@collab" }, …)`; `beforeAll`: `setupCollabCompany` with one process-adapter executor; `setHumanAgentCollabFlag(board, true)`. `afterAll`: `setHumanAgentCollabFlag(board, false)`; `cleanupCollabCompany`. Instance-flag flips require the serial e2e posture (roadmap §5.4; the existing webServer/serial config covers this — do not add parallelism).
  - `test("H1: agent files a package-bearing confirmation; board sees the package; accept clears it by terminal status")`:
    1. `createIssue` (`in_progress`, assigned to the executor).
    2. `createInteraction(board, issueId, { kind: "request_confirmation", continuationPolicy: "wake_assignee_on_accept", payload: { version: 1, prompt: "Ship the rollout?", decisionPackage: { version: 1, reason: "Rollout window conflicts with the release freeze.", optionLabels: { accept: "Ship it" }, estimatedHumanMinutes: 5 } } }, ctx.agents.executor)` — exercises the agent-key + run-id path.
    3. API: `getAttentionPage(board, companyId, { limit: 50 })` → item with `sourceKind === "issue_thread_interaction"`, `subject.id === interaction.id`, `detail.decisionPackage.reason` matching.
    4. UI: visit WhatNeedsMe → the reason text and the "Ship it" label are visible; visit the issue → the interaction card shows the package block.
    5. Accept via the UI "Ship it" button (fall back to `resolveInteraction(board, issueId, interactionId, { action: "accept" })` if the click path proves flaky in CI — the API accept is the contract; the UI assert is presentation).
    6. `expectAttentionExit(ctx.boardRequest, companyId, { sourceKind: "issue_thread_interaction", subjectId: interaction.id })` — exit by terminal status, not dismissal; interaction body `status: "accepted"` with `resolvedByUserId` set.
- [ ] **Step 2: Run** — `pnpm test:e2e` → green including the new spec; `signoff-policy.spec.ts` unchanged and green (§8.6 regression: non-package issues unaffected).
- [ ] **Step 3: Commit** — `test(e2e): collab structured-handoff thin smoke (@collab)`

---

## 6. Flag-off data compatibility (§8.7 exit bullet 1, Q7)

With `enableHumanAgentCollab` **off**:

- Package-bearing **creates** are rejected (`403 { code: "FEATURE_DISABLED" }`, Task 1) — the only gated write surface.
- **Reads and resolves are never flag-gated.** Interactions created while the flag was on remain fully readable (`GET /api/issues/:id/interactions`) and resolvable through every existing verb; the board can always resolve (Q11), so no action path is lost. Proven by Task 1's `"keeps flag-on-created packages readable and resolvable after the flag turns off"`.
- `resolverPolicy` on persisted rows stays enforced regardless of the current flag state (fail-closed: turning the flag off must not silently widen who can resolve an existing package; board override guarantees resolvability).
- The attention route's param-less response, wake `contextSnapshot` (capability key absent), telemetry event shapes (modulo a false-valued dimension), and all Stage 0 contract freezes are byte-identical to today when the flag is off (Tasks 4, 9, 10).

## 7. Regression-floor migration ledger (every deliberate change, in one place)

| File | Case | Change | Owning task |
|---|---|---|---|
| `server/src/__tests__/collab-invariants-routes.test.ts` | `"lets an active operator who is neither assignee nor creator accept and reject"` | Kept green; retitled `…interactions without a decision package`; deliberate-change marker replaced with a pointer to the delivered guard | Task 3 |
| same | *(new)* `"denies that same operator once the interaction carries a narrower resolverPolicy (Stage 1 flip)"` | The operator-can-resolve → 403 flip, package-bearing seed | Task 3 |
| same | `"409s the reject's continuation wake while the interaction resolution persists"` | Flips **409 → 200** + durable pending/retry outbox intent; immediate `skipped` wake-row assertion dropped | Task 5 |
| same | `"blocks heartbeatService(db).wakeup directly with the budget reason (fires before invokability)"`, XOR, boundary, viewer, agent-403 cases | **Unchanged** | — |
| `server/src/services/recovery/successful-run-handoff.test.ts` | `"freezes the coexistence skip contract…"` | `payload.instruction` changes via the builder (test computes it — green by construction); skip-contract `toEqual` **unchanged**; comment added | Task 7 |
| same | `"queues one corrective handoff wake…"` | One added `toContain("attach a decision package")`; existing asserts unchanged | Task 7 |
| `server/src/__tests__/attention-service.test.ts` | `"freezes the attention item contract…"` | One additive `decisionPackage: null` field in the frozen interaction `detail` literal, commented | Task 8 |
| same | `"surfaces an exhausted successful-run-handoff recovery action…"` (C6) | **Unchanged** — the standing proof the recovery dedup family survives Stage 1 | Task 7 |
| `server/src/__tests__/issue-thread-interaction-contract.test.ts` | all three cases | **Unchanged** (non-package bodies identical; package coverage lives in the new suites) | — |
| `server/src/__tests__/collab-attention-interaction-exit.test.ts` | all cases | **Unchanged** | — |
| `tests/e2e/helpers/collab.ts` | — | Additive helpers only (`DecisionPackageInputLite`, `getAttentionPage`, `setHumanAgentCollabFlag`) | Task 11 |
| `tests/e2e/collab-harness-smoke.spec.ts`, `tests/e2e/signoff-policy.spec.ts` | all | **Unchanged, must stay green** | Task 11 verifies |

## 8. Verification commands

Per task: the targeted vitest commands listed in each task. Before each PR, and cumulatively before GA:

```sh
pnpm exec vitest run --project @paperclipai/server \
  server/src/__tests__/decision-package-create-routes.test.ts \
  server/src/__tests__/decision-package-artifact-routes.test.ts \
  server/src/__tests__/decision-package-resolver-routes.test.ts \
  server/src/__tests__/decision-package-bounds-routes.test.ts \
  server/src/__tests__/attention-pagination-routes.test.ts \
  server/src/__tests__/issue-interaction-continuation-outbox.test.ts \
  server/src/__tests__/collab-watchdog-human-reserve-routes.test.ts \
  server/src/__tests__/collab-handoff-coexistence.test.ts \
  server/src/__tests__/collab-invariants-routes.test.ts \
  server/src/__tests__/attention-service.test.ts \
  server/src/__tests__/issue-thread-interaction-contract.test.ts \
  server/src/__tests__/collab-attention-interaction-exit.test.ts \
  server/src/__tests__/low-trust-red-team-routes.test.ts \
  server/src/services/recovery/successful-run-handoff.test.ts
pnpm exec vitest run packages/shared/src/validators/decision-package.test.ts
pnpm typecheck
pnpm test:e2e            # when tests/e2e changed (Task 11); full default suite per repo gate otherwise
pnpm db:generate && pnpm --filter @paperclipai/db check:migrations   # Task 4 only
node .gitnexus/run.cjs detect-changes -r jhj-paperclip -s unstaged -l 100   # before every commit
```

## 9. Coverage — §8.5 slices and §8.7 exit criteria → tasks

| Roadmap §8.5 slice | Task(s) |
|---|---|
| 1. Shared schema + server validation | Task 1 |
| 2. Resolver authorization + nested-reference integrity | Task 3 (authority) + Task 2 (references) |
| 3. Transactional resolve/outbox + failure injection tests | Task 5 (on outbox Track A Phase 1 — §3 hard gate) |
| 4. Queue bounds, supersession, payload limits, and attention pagination | Task 4 (payload limit enforced in Task 1's create path, spec'd in §4) |
| 5. Attention detail + IssueDetail card | Task 8 |
| 6. Watchdog eligibility + tests | Task 6 |
| 7. Successful-run-handoff coexistence and canonical dedup identity | Task 7 |
| 8. Agent skill docs + capability advertisement/version compatibility | Task 10 |
| 9. Instance flag if needed | Flag already exists (Stage 0); Stage 1 wiring: Task 1 (create gate), Task 10 (capability advertisement), §6 (flag-off data compatibility) |

| §8.7 exit bullet | Task(s) / evidence |
|---|---|
| 1. Flag-off: old and flag-on-created payloads remain readable/resolvable without losing their action path | §6; Task 1 test `"keeps flag-on-created packages readable and resolvable after the flag turns off"` |
| 2. Watchdog cannot accept humanOnly/handoff plan confirmations | Task 6 (C5 test list + SPEC §9.9 amendment + product/security sign-off) |
| 3. Unauthorized, low-trust, stale-member, and cross-company resolution is denied without a wake | Task 3 (named-user / override / stale-member / no-wake tests) + frozen Stage 0 cases (cross-company, agent/low-trust, viewer) |
| 4. Decision, activity, and continuation outbox/recovery are failure-atomic and idempotent | Task 5 (producer atomicity, crash-after-commit, crash-after-claim, replay 200 / conflict 409) |
| 5. Pending queues and attention responses are bounded and paginated | Task 4 (3/issue, 100/company, 64 KiB, cursor+limit default 50 / max 200) |
| 6. Skill/capability rollout cannot teach disabled fields to agents | Task 10 (capability-conditioned skill text + flag-gated advertisement + same-change-set shipping) |

§8.6 verification mapping: server-primary cases — create/resolve → Tasks 1/3/5; resolver role matrix → Task 3; low-trust denial → frozen floor + Task 1 create gate; C5 watchdog → Task 6; C6 handoff coexistence → Task 7; R1 durable wake/recovery path → Task 5; queue bounds + concurrent/double resolve → Tasks 4/5; nested-reference company/issue checks → Task 2; A1 activity → Tasks 3/4/5 activity asserts. Failure injection ("crash after decision persistence and after outbox claim; both retain exactly one recoverable next action") → Task 5 Step 1. Browser thin (`tests/e2e/collab-structured-handoff.spec.ts`, `@collab`) → Task 11. Regression (`signoff-policy.spec.ts` unchanged for non-package issues) → Task 11 Step 2.
