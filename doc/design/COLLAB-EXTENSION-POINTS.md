# Collaboration Extension Points

Date: 2026-07-13
Status: Normative for Human–Agent Collaboration Stages 1–5
Closes: [`doc/plans/2026-07-12-human-agent-collaboration-roadmap.md`](../plans/2026-07-12-human-agent-collaboration-roadmap.md) §7.4 (Stage 0 exit) and §3.3 Q5 (timeout actor matrix)
Audience: Engineers implementing Stage 1–5 collaboration features

## 1. Purpose and scope

This document is the closed list of places Stages 1–5 are allowed to extend the collaboration surface. Roadmap §2.1 states the governing rule: **name the tables, services, and closed unions you extend; if the answer is "a new parallel engine," redesign.** Every section below names one of those tables, services, or unions, plus the rule that bounds how it may grow.

If a Stage 1–5 change does not fit into one of sections 2–10 below, it is not a sanctioned extension — it requires a redesign discussion before code, not a workaround inside this document's spirit. This is the same posture the roadmap's own extension table (§2.1) takes: existing machines get **safe** additive extensions; "new parallel engine," "new resolve verbs," or "second concept with separate attention/recovery meaning" are explicitly **unsafe**, no matter how small the incremental diff looks.

This document is a Stage 0 exit deliverable (roadmap §7.4: "extension-points doc merged") and is also the home of the accepted timeout-actor matrix that closes roadmap §3.3 Q5 (see [`doc/plans/2026-07-13-collab-pre-code-decisions.md`](../plans/2026-07-13-collab-pre-code-decisions.md#q5--timeout-actor-matrix), which ratifies the governing constraints and points here for the concrete matrix — §7 below).

## 2. Closed interaction payload schemas

Human-facing structured asks run through exactly one mechanism: `issue_thread_interactions`, gated by five closed payload schemas and their discriminated union.

- **Kind, status, and continuation-policy unions** (closed, do not add members without a corresponding schema/UI/route change across the stack): `ISSUE_THREAD_INTERACTION_KINDS`, `ISSUE_THREAD_INTERACTION_STATUSES`, `ISSUE_THREAD_INTERACTION_CONTINUATION_POLICIES` — `packages/shared/src/constants.ts:246–275`.
- **The five payload schemas**, each named after its kind, in `packages/shared/src/validators/issue.ts`:
  - `suggestTasksPayloadSchema` — line 615
  - `askUserQuestionsPayloadSchema` — line 665
  - `requestConfirmationPayloadSchema` — line 745
  - `requestCheckboxConfirmationPayloadSchema` — line 765
  - `requestItemVerdictsPayloadSchema` — line 909
- **The discriminated union that wires kind → payload schema**, `createIssueThreadInteractionSchema` — `packages/shared/src/validators/issue.ts:1013–1064`.

**Rule:** Stage 1's decision-package enrichment (`reason`, `optionLabels`, `requiredArtifacts`, `estimatedHumanMinutes`, `resolverPolicy`, `humanOnly`, `silentDefaultHint` — roadmap §8.4) is **additive optional fields on these existing schemas**, not a sixth kind. Never add a new `kind` to the union above, and never add a new resolve verb — resolution always routes through the existing `accept | reject | respond | verdicts | cancel` interaction endpoints and the existing `none | wake_assignee | wake_assignee_on_accept` continuation policies. This is the ratified answer to decisions-record Q2.

## 3. Attention union + dedupKey rules

The attention feed is derived, not a store of record. It has two closed unions plus a single dedup mechanism that every source must use identically.

- **Closed unions** — `AttentionSourceKind` and `AttentionSubjectKind`, `packages/shared/src/types/attention.ts:3–23`; the `AttentionItemDetail` discriminated union (one variant per attention-worthy shape), `packages/shared/src/types/attention.ts:69–145`.
- **Id/dismissal derivation** — implemented in `server/src/services/attention.ts` (not the shared types file above — the two `attention.ts` files serve different purposes: shared types vs. the server-side service that builds items). `itemId(sourceKind, dedupKey)` at `server/src/services/attention.ts:305–306` derives `AttentionItem.id` as `` `${sourceKind}:${dedupKey}` ``; `createItem` derives `dismissalKey` as `` `attention:${dedupKey}` `` at `server/src/services/attention.ts:323`.
- **The 10 dedupKey formats** (`server/src/services/attention.ts`), one per source kind — this is the closed enumeration; a new source kind needs a new format here, an existing source kind must not invent a second format:
  1. `approval:${approval.id}`
  2. `interaction:${interaction.id}`
  3. `join:${join.id}`
  4. `recovery:${recovery.kind}:${recovery.sourceIssueId}:${recovery.cause}:${recovery.fingerprint}`
  5. `productivity_review:${review.originFingerprint ?? review.originId ?? review.id}`
  6. `blocker:${issue.id}:${sample}`
  7. `review:${review.id}`
  8. `run:${run.id}`
  9. `budget:${incident.policyId}:${toIso(incident.windowStart)}:${incident.thresholdType}`
  10. `agent_error:${agent.id}`

**Rules:**
- **One dedup family per underlying wait (R1).** A Stage 1 decision package does not mint a new dedupKey family — it enriches the existing `interaction:${interaction.id}` family (or, where it satisfies a successful-run-handoff disposition, that path's own family), so recovery and attention never race the same wait as two different items. This is the mechanism behind decisions-record Q1.
- **Exit is by terminal status, not dismissal.** An attention item leaves the feed because its underlying row reaches a terminal status (interaction resolved, approval decided, recovery action cleared, etc.), never because a user merely dismissed/snoozed it — dismissal only hides an item locally (`AttentionItemDismissal`); it does not retire the dedupKey. See the frozen entry/exit contract in `server/src/__tests__/collab-attention-interaction-exit.test.ts`.
- **Copy and rank are not schema.** Human-readable summary text, images, and the numeric `rank` field are presentation details computed at read time; they are never treated as part of the closed union or as a stable identity a client can rely on across releases.

## 4. Wake, coalesce, and idempotency keys

All human-facing and recovery wakes go through one function, `enqueueWakeup`, `server/src/services/heartbeat.ts:14274`. Its coalesce/defer decision body — merge into the running run's `context_snapshot` ("coalesced") vs. park as `deferred_issue_execution` — is at `server/src/services/heartbeat.ts:15045–15139`.

**Reserved idempotency-key namespaces** (do not reuse a prefix below for an unrelated wake source; each is scoped to one mechanism):
- `finish_successful_run_handoff:…` — `FINISH_SUCCESSFUL_RUN_HANDOFF_REASON`, `server/src/services/recovery/successful-run-handoff.ts:7`.
- run-liveness continuation keys — `buildRunLivenessContinuationIdempotencyKey`, `server/src/services/recovery/run-liveness-continuations.ts:49`.
- `issue-monitor:${claimed.id}:${scheduledAtIso}` — `server/src/services/heartbeat.ts:6270`.
- `task_watchdog:${watchdogId}:${stopFingerprint}` — `taskWatchdogWakeIdempotencyKey`, `server/src/services/task-watchdogs.ts:493–495`.

**Scheduler tick ordering** — the single `setInterval` loop that drives timers, routines, environment cleanup, and periodic recovery (orphan reaping, scheduled-retry promotion, queued-run resume, stranded-issue reconciliation, issue-graph liveness, task-watchdog reconciliation, silent active-run scan, stale-lock sweep, productivity review) in that order — `server/src/index.ts:943–1052`. A new collab wake source is added as another `trackHeartbeatSchedulerWork(...)` step inside this loop, not a second interval.

**Rules:**
- Every collab wake carries a server-derived idempotency key (never client-supplied) plus a distinct `wakeReason` string in the `context_snapshot` — this is what lets recovery, dedup, and replay-safety all key off the same wake without colliding with another mechanism's namespace.
- Steer is **non-interrupt by default** (decisions-record Q8, Q15; roadmap §10.3). A merged `context_snapshot` alone is never treated as delivery of a steer directive — delivery requires a positive adapter acknowledgement (§10.3 collision table: "snapshot merge alone is not delivery"). Coalescing a wake into a running run's snapshot is a courtesy to avoid redundant invocations; it is not a substitute for the `SteerDirectiveDelivery` ack state machine described in §9 below.

## 5. Successful-run-handoff coexistence

`SuccessfulRunHandoffState` (`packages/shared/src/types/issue.ts:522`) is the existing path for "successful run, no disposition" — Stage 1's decision package **satisfies** this path, it does not replace it (decisions-record Q1).

- **Options** — `SUCCESSFUL_RUN_HANDOFF_OPTIONS`, `server/src/services/recovery/successful-run-handoff.ts:19–24`: `mark_done_or_cancelled`, `send_for_review_or_ask_for_input`, `mark_blocked`, `delegate_or_continue_from_checkpoint`.
- **Skip ladder** — `decideSuccessfulRunHandoff`, `server/src/services/recovery/successful-run-handoff.ts:340–399`. It skips (declines to fire the corrective handoff wake) when, among other conditions, `input.hasPendingInteractionOrApproval` is true (line 389–390) — a pending interaction or approval already owns the next action, so a Stage 1 package sitting on that interaction is sufficient; the handoff path must not also fire.
- **Single-attempt bound** — `DEFAULT_MAX_SUCCESSFUL_RUN_HANDOFF_ATTEMPTS = 1` (`successful-run-handoff.ts:9`). This stays terminal in Stage 1: a package does not grant a second automatic attempt.

**Rule:** a Stage 1 decision package may satisfy the pending disposition on this path (by carrying `resolverPolicy`/`humanOnly` on the same interaction the handoff would otherwise create), but it must not become a second, competing "handoff" concept with its own attention dedup family or its own recovery skip rule. There is exactly one canonical handoff identity.

## 6. Task watchdog eligibility + human-reserve

The task watchdog's authority is defined once, in `doc/TASK-WATCHDOG.md:107–140` ("mandate... enforces safety constraints" through "Scope enforcement") and formalized as the authority contract in `doc/SPEC-implementation.md` §9.9. Server-side scope checks live in `server/src/services/task-watchdog-scope.ts`: `resolveTaskWatchdogMutationScope` (line 51) resolves the run's watchdog context to a scope envelope; `taskWatchdogScopeAllowsIssueMutation` (line 151) enforces it per-mutation. The route-layer wiring for this is in `server/src/routes/issues.ts:3329–3342` (comment-mutation gate) and `server/src/routes/issues.ts:3542–3685` (watchdog-config-mutation rejection and related scope guards).

**New rule (ratified — decisions-record Q4):** package-bearing or `humanOnly: true` confirmations are **permanently** watchdog-ineligible. `humanOnly` is server-derived from persisted issue/policy context — no caller, including the watchdog's own plan-confirmation resolution path (SPEC-implementation §9.9's "Interaction resolution" eligibility test), can turn it off by omitting or overriding the field. This lands as a new bullet in the §9.9 eligibility test ("plan confirmation is eligible only when... the interaction is not `humanOnly` and does not carry a decision package") plus tests proving the watchdog cannot auto-accept a `humanOnly`/handoff-bearing plan confirmation. Today's §9.9 text does not yet contain this clause — adding it is Stage 1 work; this document is what makes the omission a bug rather than silent scope creep.

## 7. Accepted timeout-actor matrix

This is the closed deliverable for roadmap §3.3 Q5. Decisions-record Q5 ratifies the governing constraints (human-wait timeouts belong exclusively to the future Stage 4b evaluator; no timeout automation on human waits exists before then) and defers the concrete per-actor matrix here. **No row below may be extended with a new automated effect without amending this table in the same PR** (§11).

| Actor | Trigger | Action scope | Must yield to | Anchor |
|---|---|---|---|---|
| Monitor `recoveryPolicy` | `timeout_exceeded` / `max_attempts_exhausted` at monitor dispatch (via `tickDueIssueMonitors`) | Clears monitor; `wake_owner` (default) / `create_recovery_issue` / `escalate_to_board`; never terminalizes interactions or the issue | Agent-async lane only — never the timeout owner for human waits; wakes ride standard budget/pause gates | `heartbeat.ts:5909–6215, 16072`; execution-semantics §8 |
| Stranded-liveness recovery | Periodic scan of non-terminal issues with no live execution path — incl. **unassigned `in_review`** issues resolved via typed participant (`recovery/service.ts:2984–3022`) | One bounded auto-requeue preserving owner; on exhaustion `blocked` + explicit recovery; never reassigns | Active path, pending interaction/approval, pause holds, budget, execution-policy state; successful-run-handoff owns the succeeded-no-disposition case | `recovery/service.ts:2976–3060`; `run-liveness-continuations.ts:9,85–189` |
| Task watchdog | Whole watched subtree at rest + new stop fingerprint | In-subtree verification; may resolve ONLY eligible plan confirmations; cannot touch config/typed decisions/approvals | Any live path; scope checks; **Stage 1 human-reserve (package/`humanOnly`)**; Stage 4b owns interaction deadlines | TASK-WATCHDOG.md L82–140; `task-watchdogs.ts:493–495` |
| Future single SLA owner (4b) | Deadline on a human-wait interaction; CAS claim on a non-terminal timeout-action row per `(interactionId, policyVersion, action)`; injectable `now` | Issue-scoped alert/escalate/`blocked`/recovery only; never terminalize, pause agents, or approve governed actions | Human resolution always wins (resolve-before-timeout prevents claim; resolve-after-claim clears it) | roadmap §11.2 |
| Frozen `silentDefault` (hint) | Never triggers in Stages 1–3 | Schema-only (`silentDefaultHint`, §8.4); persisted/displayed at most; future input to the 4b evaluator | Everything | roadmap §8.4, §3.2, §6 GA-cut list |

**Anchor drift note:** row 1's trailing line ref moved from `16075` to `16072` (`tickDueIssueMonitors(now)` call site — the file gained lines elsewhere since the matrix was drafted); row 2's "Anchor" column start moved from `2979` to `2976` (the actual start of `reconcileStrandedAssignedIssues`); row 3's watchdog idempotency-key anchor moved from `496–498` to `493–495` (`taskWatchdogWakeIdempotencyKey`). Row 2's "Trigger" column anchor (`2984–3022`) was re-verified unchanged: it correctly brackets the `in_review`-inclusion clause (2984) through the typed-participant `agentId` resolution (3022). Re-verify anchors against `HEAD` before relying on exact line numbers; they drift as the surrounding files change.

**Rule:** no actor outside this table may apply an automated effect to a pending human-wait interaction. Adding an actor or widening an existing actor's action scope requires updating this table in the same PR as the code change (§11).

## 8. Resolve/outbox atomicity boundary

Resolving a human wait is failure-atomic (decisions-record Q12, ratifying Track A of [`doc/plans/2026-07-12-continuation-outbox-and-immutable-provenance.md`](../plans/2026-07-12-continuation-outbox-and-immutable-provenance.md)):

- **One producer transaction** persists the terminal interaction, the activity record, and exactly one continuation intent (an idempotent outbox wake or an explicit recovery action).
- **Delivery retries independently** of that transaction via a leased, compare-and-set dispatcher; a failed enqueue attempt cannot clear the only live path back to the interaction, because the intent row itself is the durable record of "what should happen next," not the delivery attempt.
- **Never hint-only resume (R10).** `resumeHint` alone does not restore liveness. Resolve must always set a concrete wake policy, assignee, or recovery action — never leave only a hint field for some other actor to interpret later.
- Stage 1 resolves are **another producer on this same outbox path** — there is no second, decision-package-specific outbox, no parallel "package resolved" event stream.

**Rule:** any new mutating surface that terminalizes a human wait (a new resolve verb, a new recovery action, a future Stage 4b timeout effect) must persist through this same one-transaction-plus-independent-delivery shape. A surface that terminalizes state and separately, non-atomically, tries to enqueue the next wake is not a sanctioned extension.

## 9. Do-not-use: `issue_execution_decisions` for steer

`issue_execution_decisions` (`packages/db/src/schema/issue_execution_decisions.ts`) is stage-bound: `stageId` and `outcome` are both `NOT NULL` columns (lines 13 and 17). Every row belongs to exactly one `executionPolicy` stage and records that stage's approve/`changes_requested` outcome. It has no concept of an ordered, ackable, mid-run directive stream.

**Rule: `issue_execution_decisions` must never be used to store steer directives.** This is forbidden per roadmap §10.3's collision table ("`issue_execution_decisions` semantics — **Forbidden** as steer store") and decisions-record R6. Steer instead uses two separate mechanisms, ratified in decisions-record [Q15](../plans/2026-07-13-collab-pre-code-decisions.md#q15--steer-delivery):

- **Directive content** is a provenance-labeled, typed issue comment — never a new chat/message store, never a row in `issue_execution_decisions`.
- **Delivery state** lives in its own table, `SteerDirectiveDelivery` (roadmap §10.4 — `id`, `companyId`, `issueId`, `commentId`, `seq`, `idempotencyKey`, `status: "pending" | "leased" | "acked" | "superseded" | "dead"`, `targetAgentId`, `assignmentGeneration`, lease/version fields, `attemptCount`). `seq` is allocated transactionally, unique per `(issueId, seq)`. All state transitions (`pending → leased`, expired-lease reclaim, `leased → acked`, reassignment, exhaustion → `dead`) use compare-and-set on `version` / `status` / `leaseToken` / `assignmentGeneration` — never a bare `UPDATE ... SET status`.

**Rule:** posting a directive is board-only, company/issue-scoped, activity-logged, and rate-limited (roadmap §10.4). A merged `context_snapshot` without a positive adapter acknowledgement is never treated as delivery (§4 above repeats this because it is the same rule at the wake layer — the two must not drift apart).

## 10. Live-events WS channel rules

The live-events WebSocket endpoint is `server/src/realtime/live-events-ws.ts:86` (`^/api/companies/([^/]+)/events/ws$`, company-scoped by construction). It carries exactly the 11 event types in the closed `LIVE_EVENT_TYPES` union, `packages/shared/src/constants.ts:793–805`:

`heartbeat.run.queued`, `heartbeat.run.status`, `heartbeat.run.progress`, `heartbeat.run.event`, `heartbeat.run.log`, `agent.status`, `activity.logged`, `external_object.updated`, `plugin.ui.updated`, `plugin.worker.crashed`, `plugin.worker.restarted`.

**Rules:**
- This channel is a **UI transport only**. It is a live mirror of state that already exists durably elsewhere (runs, activity, agent status); it is never the sole record of a wait, a directive, or a decision.
- **No wait may exist only as a WS event.** Anything a human or agent needs to act on later — a pending interaction, a steer directive, a timeout action — must be a durable row (per §2, §7, §9) that survives a dropped socket, a page reload, or a server restart. The WS event announces the row; it does not replace it.
- **Company-scoping is mandatory** for any new event type added to this union — the endpoint's `companyId` path segment is the only boundary; an event type must not leak cross-company data through a shared/global channel.
- Adding a 12th event type requires updating the closed union above and this document in the same PR (§11) — it does not get a separate side channel.

## 11. Change control

Every stage PR that adds a schema field, a wake reason, a dedupKey family, or an event type updates this document in the same PR. Concretely, that means a PR is incomplete if it does any of the following without a matching edit here:

- adds a field to `packages/shared/src/validators/issue.ts`'s five payload schemas or the `createIssueThreadInteractionSchema` union (§2)
- adds a member to `AttentionSourceKind`, `AttentionSubjectKind`, `AttentionItemDetail`, or a new dedupKey format (§3)
- adds a wake reason, an idempotency-key namespace, or a scheduler tick step (§4)
- adds or widens an actor's legal effect on a pending human-wait interaction (§7's matrix)
- adds a member to `LIVE_EVENT_TYPES` (§10)

This rule is now also enforced procedurally: roadmap §14's per-stage Definition of Done gains the checkbox below (the only roadmap edit made by this task):

```
- [ ] COLLAB-EXTENSION-POINTS.md updated in the same PR when a schema field, wake reason, dedupKey family, or event type is added
```

If a future change needs to violate one of the "never" rules above (a new resolve verb, a second outbox, a timeout actor outside §7's table), that is by definition not an extension — it is a redesign, and belongs in a roadmap amendment, not a quiet drift in this file. Roadmap §18, item 5 states the governing rule: "Treat this document as the single program source; update it when decisions land (do not fork parallel “version” docs)."
