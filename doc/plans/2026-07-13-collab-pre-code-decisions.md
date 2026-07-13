# Human–Agent Collaboration: Pre-Code Decisions (Q1–Q16)

Date: 2026-07-13  
Status: Accepted (2026-07-13) — Q3/Q9 decided by product 2026-07-13; remaining 14 entries eng-ratified per roadmap  
Closes: [`doc/plans/2026-07-12-human-agent-collaboration-roadmap.md`](2026-07-12-human-agent-collaboration-roadmap.md) §3.3, "Pre-code decisions (block Stage 1 feature work)"  
Audience: Product, engineering

## 0. Why this document exists

Roadmap §0 states: "Do not start Stage 1 feature code until **pre-code decisions** (§3.3) are closed." This document is that closure record. It answers all 16 items listed in roadmap §3.3, one per section below.

Of the 16, review classified **9 as ratify** — the answer is already embedded in the roadmap's design constraints (§2, §3, §8–§12), and this document's job is to state that answer plainly as the canonical, citable record — and **7 as decide** — genuinely open at roadmap-authoring time, closed here by an engineering recommendation. Two of the 16 (Q3, Q9) were **product-judgment** calls rather than engineering calls; those are marked `DECIDED (product, 2026-07-13)` below, with product's decided wording and the revisit trigger that would reopen it. The remaining 14 are marked `RATIFIED (eng, 2026-07-13)`: engineering's closure, ratified per roadmap.

Nothing here overrides roadmap text. Where an entry below says a point is "ratified," that means the roadmap already settled it (see that entry's Evidence); this document is the closure record, not a new source of design truth. Roadmap §18.5's "single program source" rule still applies — if a recommendation here is later overridden, the override belongs in the roadmap, not a fork of this document.

## Index

- [Q1 — Handoff source of truth](#q1--handoff-source-of-truth)
- [Q2 — UI option to API map](#q2--ui-option-to-api-map)
- [Q3 — Handoff required vs optional](#q3--handoff-required-vs-optional) — `DECIDED (product, 2026-07-13)`
- [Q4 — Watchdog human reservation](#q4--watchdog-human-reservation)
- [Q5 — Timeout actor matrix](#q5--timeout-actor-matrix)
- [Q6 — Contract storage and evaluation order](#q6--contract-storage-and-evaluation-order)
- [Q7 — Flag scope](#q7--flag-scope)
- [Q8 — Steer permissions](#q8--steer-permissions)
- [Q9 — First GA one-sentence promise](#q9--first-ga-one-sentence-promise) — `DECIDED (product, 2026-07-13)`
- [Q10 — CLI, skill, and OpenAPI policy](#q10--cli-skill-and-openapi-policy)
- [Q11 — Decision resolver authority](#q11--decision-resolver-authority)
- [Q12 — Failure-atomic resolve](#q12--failure-atomic-resolve)
- [Q13 — Decision queue bounds](#q13--decision-queue-bounds)
- [Q14 — Outcome authority](#q14--outcome-authority)
- [Q15 — Steer delivery](#q15--steer-delivery)
- [Q16 — Command composer](#q16--command-composer)

---

## Q1 — Handoff source of truth

**Status:** RATIFIED (eng, 2026-07-13)

**Decision:** Ratify. A Stage 1 decision package does not replace `SuccessfulRunHandoffState`; it may **satisfy** a pending disposition on that existing path. There is exactly one canonical handoff identity and one attention `dedupKey` family spanning both mechanisms — a package is not a second kind of "handoff" competing with the successful-run path for attention or recovery ownership. Recovery skip rules treat a pending, package-bearing interaction as the live handoff, so stranded/graph-liveness recovery does not race the package or double-surface the same wait as two different attention items.

**Evidence:** `packages/shared/src/types/issue.ts:522` (`SuccessfulRunHandoffState`); `server/src/services/recovery/successful-run-handoff.ts`; roadmap §8.3 ("Successful-run-handoff: Unify... one attention dedup family"), §3.1 R1 ("Stage 1 must unify naming, attention dedup, and recovery skip rules"), §8.5 slice 7 ("Successful-run-handoff coexistence and canonical dedup identity").

**Owner:** eng-ratify

---

## Q2 — UI option to API map

**Status:** RATIFIED (eng, 2026-07-13)

**Decision:** Ratify. Decision-package UI options are presentation labels only (`optionLabels`), never new server verbs. Resolve maps exclusively onto the existing interaction endpoints — `POST /issues/:id/interactions/:interactionId/{accept|reject|respond|verdicts|cancel}` — using the existing continuation policies (`none | wake_assignee | wake_assignee_on_accept`). "Request changes" resolves either as reject/respond carrying a reason plus assignee wake, or, when the interaction lives inside a policy stage, as an execution-decision outcome of `changes_requested`. The `reassign` option is cut entirely from interaction resolution; assignee changes stay on the separate assignee PATCH path.

**Evidence:** `server/src/routes/issues.ts:9158–9446`; roadmap §8.4 ("Resolve rules"), §3.1 R2 ("Map to existing APIs only; drop reassign from interaction options"), §3.2 ("Interaction option `reassign`: Cut").

**Owner:** eng-ratify

---

## Q3 — Handoff required vs optional

**Status:** DECIDED (product, 2026-07-13)

**Decision:** Optional at Stage 1 GA. Skills strongly recommend enrichment for human-owned waits; the server validates it only when present and never forces it as a precondition to entering a human-owned wait. Revisit trigger stays: if §17 "% human waits with decision package" stays low or time-to-decision does not improve after skill rollout, add a server-forced requirement via an executionPolicy stage precondition in a later stage.

**Evidence:** roadmap §8.3 ("Optional vs required: Product decision in §3.3; if optional, orphan rate is skill-dependent"); §8.7 exit ("Skill/capability rollout cannot teach disabled fields to agents"); §17 success metric "% human waits with decision package enrichment" (the revisit signal, tracked after skill rollout).

**Owner:** product (decided 2026-07-13)

---

## Q4 — Watchdog human reservation

**Status:** RATIFIED (eng, 2026-07-13)

**Decision:** Ratify. Yes, permanently. Package-bearing or `humanOnly: true` confirmations are never watchdog-eligible. `humanOnly` is server-derived from persisted issue/policy context, not agent-supplied — no caller, including the watchdog's own plan-confirmation resolution path, can turn it off by omitting or overriding the field. This lands as a new eligibility condition in SPEC-implementation §9.9 (the human-reservation clause), together with tests that specifically prove the watchdog cannot auto-accept a `humanOnly`/handoff-bearing plan confirmation.

**Evidence:** roadmap §8.3 ("Watchdog plan accept: `humanOnly` / handoff present → not watchdog-eligible; SPEC §9.9 update"), §3.1 R5 ("Stage 1: SPEC/watchdog human reservation; tests prove non-accept"), §5.2 C5 ("Watchdog human-reserve: Server").

**Owner:** eng-ratify

---

## Q5 — Timeout actor matrix

**Status:** RATIFIED (eng, 2026-07-13) — the governing constraints are ratified here; the concrete per-state actor/effect matrix is a separate deliverable (Task B7), not re-derived in this document

**Decision:** Human-wait timeouts belong exclusively to the future Stage 4b single SLA evaluator. Its only legal effects are alert/escalate, a compatible `blocked` transition, or an explicit recovery action; it must never terminalize an interaction, pause an agent, or auto-approve a governed action. Existing actors keep their current lanes: the monitor and stranded-recovery paths continue to operate on agent runs, and must treat a pending human interaction as a valid, non-orphaning action path rather than a state to route around or override. Until Stage 4b ships, there is **no** timeout automation on human waits at all — the silentDefault worker stays frozen, and `silentDefaultHint` on the decision-package shape is schema-only (present for forward compatibility, read by no worker). The full actor/effect matrix — which actor legally acts on which issue status, and what effect each is allowed to apply — is recorded in `doc/design/COLLAB-EXTENSION-POINTS.md` as part of Task B7, not restated here.

**Evidence:** roadmap §3.1 R3 ("No silentDefault worker until SLA stage; design priority matrix first"), §3.2 ("Stage 1 silentDefault worker: Frozen until single timeout owner ships"), §8.4 (`silentDefaultHint` schema-only note), §11.2 ("Single timeout / SLA owner (4b)": one evaluator, CAS claim, issue-status-legal effects only).

**Owner:** eng-ratify

---

## Q6 — Contract storage and evaluation order

**Status:** RATIFIED (eng, 2026-07-13) — evaluation order is ratified by the roadmap; the storage backend choice is what this entry closes

**Decision:** **Storage:** a dedicated jsonb column holding the `OutcomeChecklist` (with an integer `revision`) plus separate `OutcomeEvidence` rows — not `execution_policy` free keys, because that validator is locked per `doc/plans/2026-06-03-low-trust-review-contract.md` and its normalizers strip unknown keys, which would silently drop contract fields; and not a document-revision pattern, because documents have no server-side schema validation today. **Evaluation order:** `executionPolicy` stages route review first; the outcome checklist evaluates only on transitions that write a successful `done`, including force-complete; `cancelled` never requires DoD evidence — it fences execution and audits the cancellation reason, but produces no completion-evidence record.

**Evidence:** roadmap §9.3 ("Executor `done` rewritten to `in_review` by policy" → evaluation-order ADR; "Storage in `execution_policy` free keys" → prefer dedicated jsonb/revision), §9.4 (`OutcomeChecklist` / `OutcomeEvidence` shapes), §3.1 R4 ("Contract preflight only; compile or drop independent humanGates; evaluation order ADR").

**Owner:** eng-ratify

---

## Q7 — Flag scope

**Status:** RATIFIED (eng, 2026-07-13)

**Decision:** Ratify. Instance experimental settings only (`InstanceExperimentalSettings`); no company-scoped settings work in Stage 0. This choice has two accepted costs: instance-level flag flips force e2e to run serial (`workers: 1`), and every stage's exit criteria must document flag-off data compatibility (payloads and behavior created while the flag was on must remain readable/resolvable once it is off). A full cost accounting for a future company-scoped flag — what schema and routing work it would require — is deferred to Task B6 and is out of scope for this decision.

**Evidence:** `packages/shared/src/types/instance.ts:47–85` (`InstanceExperimentalSettings`); roadmap §5.4 ("Prefer instance experimental settings... unless Stage 0 explicitly adds company-scoped settings"), §3.1 R7 ("Stage 0 honesty; no Stage 3–5 claims that need missing infra without epic cost").

**Owner:** eng-ratify

---

## Q8 — Steer permissions

**Status:** RATIFIED (eng, 2026-07-13)

**Decision:** Ratify. Posting steer directives is board-only for the MVP: company/issue scoped, activity-logged, rate-limited, and unavailable to low-trust agents. Delivery defaults to non-interrupt: a directive becomes a deferred wake/next-run-context item unless the active adapter positively acknowledges mid-run consumption — a merged `context_snapshot` alone is never treated as delivery. Interrupt/cancel exists only as an explicit, separate board action; it is never an implicit side effect of posting a directive. Steer wakes pass through the same budget/invokability gates as every other collab-triggered wake.

**Evidence:** roadmap §10.4 ("Posting is board-only for the MVP, company/issue scoped, activity-logged, rate-limited, and unavailable to low-trust agents"), §10.3 (collision rules: interrupt vs comment wake defaults to non-interrupt; active-run coalesce requires positive ack; budget hard-stop applies), §2.3 (store-first steer composition rule: "board-first permission; cancel only explicit").

**Owner:** eng-ratify

---

## Q9 — First GA one-sentence promise

**Status:** DECIDED (product, 2026-07-13)

**Decision:** Primary promise is **"WhatNeedsMe shows a decision package."** Contracts ("Optional contracts block done without required artifacts") and store-first steer ("Board can store-first steer without dual ownership") ship as secondary capabilities in the same GA stop — this is a choice of which sentence leads the release, not a scope cut.

**Evidence:**
- §6's program overview places Stage 1 (decision package) first in the dependency chain: Stage 2a/2b and Stage 3a both depend on Stage 0–1 foundations, so the decision-package capability is reachable earliest of the three candidates.
- §5.6's E2E feasibility grades rate Stage 1 at C+ → B if built API-first, versus Stage 2 at C− → B (dual-machine risk) and Stage 3 at D until a steer store and long-run harness exist — decision-package is the safer capability to prove end-to-end first.
- Of the §17 success metrics, the top two — "median time-to-human-decision on attention items" and "% human waits with decision package enrichment" — are both served directly by the decision-package promise, ahead of the checklist and steer metrics further down that table.

**Owner:** product (decided 2026-07-13)

---

## Q10 — CLI, skill, and OpenAPI policy

**Status:** RATIFIED (eng, 2026-07-13)

**Decision:** Decide. Policy is "capability-advertised, same-change-set": any agent-facing field ships its shared validator, server implementation, and OpenAPI/CLI parity together in the same PR series, per `doc/plans/2026-05-23-cli-api-parity.md` (which cites its own OpenAPI source of truth on branch `feature/openapi-spec`). Skills are only allowed to teach a field to agents once the server actually advertises the capability — i.e., once the relevant flag is on — so rollout sequencing can never produce a skill instructing an agent to use a field the server will still reject. The enforcement point for this policy is the roadmap §14 per-stage Definition of Done checkbox: "db / shared / server / ui (+ CLI/skill if agent-facing) synced."

**Evidence:** roadmap §8.7 exit ("Skill/capability rollout cannot teach disabled fields to agents"); §14 ("db / shared / server / ui (+ CLI/skill if agent-facing) synced").

**Owner:** eng-ratify

---

## Q11 — Decision resolver authority

**Status:** RATIFIED (eng, 2026-07-13) — the `resolverPolicy` mechanism itself is already ratified in the roadmap's Stage 1 shape; this entry closes the open default and non-owner behavior

**Decision:** `resolverPolicy` defaults to `{ kind: "board" }` when nothing more specific is configured. Board principals may **always** resolve regardless of the configured policy value — this is audited explicitly as a board override, consistent with the §1 hard constraint "Board governable" — while a non-default `resolverPolicy` (`responsible_user` or `typed_execution_participant`) narrows who else, besides the board, may resolve. Every other principal — former members, agents, low-trust runs, and cross-company principals — receives a non-disclosing `403` and causes no wake. If the configured responsible user is unavailable, that is handled as escalated attention by the future Stage 4b SLA evaluator, never as automatic reassignment to a different resolver.

**Evidence:** roadmap §8.4 (`resolverPolicy` union shape; "Enforce `resolverPolicy` server-side. Non-owners, former members, agents, low-trust runs, and cross-company principals receive a non-disclosing `403` and cause no wake"); today's board-only guard baseline at `server/src/routes/issues.ts:3602`.

**Owner:** eng-ratify

---

## Q12 — Failure-atomic resolve

**Status:** RATIFIED (eng, 2026-07-13)

**Decision:** Ratify. Adopt Track A of `doc/plans/2026-07-12-continuation-outbox-and-immutable-provenance.md` verbatim for Stage 1 resolves: one producer transaction persists the terminal interaction, the activity record, and exactly one continuation intent; a leased, compare-and-set dispatcher claims and delivers it; deterministic event keys (`resolution:v1:<interaction-id>`) plus RFC 8785 canonical-JSON fingerprints make delivery idempotent (a replay returns `200`, a genuine conflict returns `409`). Stage 1 resolves are simply another producer on this same outbox path — there is no second, decision-package-specific outbox.

**Evidence:** roadmap §8.4 ("Resolve is failure-atomic: persist the terminal interaction, activity, and an idempotent outbox wake or explicit recovery action in one transaction"), §4.1 #14 ("Failure-atomic continuation: resolving a human wait persists the decision, activity, and a durable next action in one recoverable operation"), §3.1 R10 ("`resumeHint` alone does not restore liveness... Resolve must set wake policy / assignee / recovery—never hint-only").

**Owner:** eng-ratify

---

## Q13 — Decision queue bounds

**Status:** RATIFIED (eng, 2026-07-13) — the bounding principles (server-derived idempotency, supersession, pagination) are ratified by the roadmap; the numeric caps below are what this entry closes

**Decision:** Idempotency is always server-derived, following the outbox-plan fingerprint pattern — never a client-supplied key. Numeric defaults: at most **3** pending package-bearing interactions per issue and **100** per company, with a structured `422` returned once either cap is exceeded. Payload size is capped at **64 KiB** encoded, matching the outbox envelope bound defined in the outbox plan §5.3/§5.5. A newer package on the same issue/kind/target supersedes the older one via the existing interaction supersession lifecycle — no new supersession mechanism is introduced. The attention feed gains keyset pagination (`cursor` + `limit`, default 50 / max 200); `GET /companies/:companyId/attention` has no pagination today and this closes that gap before Stage 1 GA.

**Evidence:** `server/src/routes/attention.ts` (today's unpaginated route); roadmap §8.4 ("Each source run/request gets a server-derived idempotency key. Enforce payload bounds, pending-per-issue and per-company caps, semantic supersession, and paginated attention reads before Stage 1 GA"), §8.5 slice 4 ("Queue bounds, supersession, payload limits, and attention pagination").

**Owner:** eng-ratify

---

## Q14 — Outcome authority

**Status:** RATIFIED (eng, 2026-07-13)

**Decision:** Ratify. The board, or the persisted responsible user, owns `OutcomeChecklist` definitions once execution starts; agents may attach `OutcomeEvidence` but cannot weaken, delete, or replace required checklist items. Definition edits are optimistic-concurrency controlled — they bump `revision` and invalidate any evidence/attestations recorded against a now-stale revision. Evidence must satisfy the §9.4 work-product qualification matrix (status, health, review-state, and source-trust rules, varying by work-product type) before it counts toward completion. On a transition to `done`, evaluation pins the qualifying evidence ids together with an immutable revision or content hash, so later mutation of the underlying artifact cannot silently invalidate what was approved; cancellation creates no completion-evidence record at all. Reopening a pinned `done` completion record is a board-only, audited transaction. Force-complete is fenced: it first cancels/fences active execution, compare-and-clears locks, and invalidates queued wakes/monitors, and it is blocked by any governed approval unless the board explicitly cancels or waives that approval with a stated reason.

**Evidence:** roadmap §9.4 ("Authority and evidence rules"; work-product qualification matrix), §9.3 ("Board force-complete" collision row), §4.1 #15 ("Durable terminal evidence: completion records pin the qualifying evidence; later mutation cannot silently invalidate what was approved").

**Owner:** eng-ratify

---

## Q15 — Steer delivery

**Status:** RATIFIED (eng, 2026-07-13)

**Decision:** Ratify. Directive text is a provenance-labeled, typed issue comment — never a new chat/message store. A separate `SteerDirectiveDelivery` table owns delivery state only (sequence, lease, ack, retry, status), not the directive content. `seq` is allocated transactionally, unique per `(issueId, seq)`. State transitions (`pending → leased`, expired-lease reclaim, `leased → acked`, reassignment, exhaustion) all use compare-and-set on `version` / `status` / `leaseToken` / `assignmentGeneration`, so a stale ack can never match a lease that has already been reclaimed or superseded. Reassignment atomically supersedes the old-generation lease and rebinds any unacknowledged directive to the new generation. A directive that exhausts its delivery attempts transitions to `dead` and creates a visible recovery action rather than silently disappearing. A merged `context_snapshot` without a positive adapter acknowledgement is never treated as delivery.

**Evidence:** roadmap §10.4 (full `SteerDirectiveDelivery` shape and CAS state-transition rules), §3.1 R6 ("Steer via `issue_execution_decisions` or comment-only is wrong → Typed issue comment + dedicated delivery state + non-interrupt deferred wake").

**Owner:** eng-ratify

---

## Q16 — Command composer

**Status:** RATIFIED (eng, 2026-07-13)

**Decision:** Ratify. The command composer is always issue-backed: it creates and updates issues and comments, never a parallel chat table. The server derives company plus goal/parent/project linkage itself rather than trusting client-supplied linkage. A request produces either an explicit non-waking draft, or exactly one CEO-assigned issue — never an ambiguous mix. Normal budget/invokability gates apply before any wake is triggered. Requests are idempotent on retry, permission-checked, and activity-logged; unanchored or cross-company references are rejected outright. `issues.kind` does not exist in the schema today — only `harnessKind`/`originKind` in `packages/db/src/schema/issues.ts` — and it remains, at most, an optional additive field for a later stage; the composer must not depend on it as hidden infrastructure to ship.

**Evidence:** `packages/db/src/schema/issues.ts` (`harness_kind` / `origin_kind` columns; no `kind` column); roadmap §12.1 ("Command composer (priority)" rule), §3.1 R7 ("Hidden infra assumed... `issues.kind`... Stage 0 honesty; no Stage 3–5 claims that need missing infra without epic cost").

**Owner:** eng-ratify

---

## Summary table

| Q | Topic | Classification | Status | Owner |
|---|---|---|---|---|
| 1 | Handoff source of truth | ratify | RATIFIED (eng, 2026-07-13) | eng-ratify |
| 2 | UI option to API map | ratify | RATIFIED (eng, 2026-07-13) | eng-ratify |
| 3 | Handoff required vs optional | decide | DECIDED (product, 2026-07-13) | product |
| 4 | Watchdog human reservation | ratify | RATIFIED (eng, 2026-07-13) | eng-ratify |
| 5 | Timeout actor matrix | decide | RATIFIED (eng, 2026-07-13) | eng-ratify |
| 6 | Contract storage and evaluation order | decide | RATIFIED (eng, 2026-07-13) | eng-ratify |
| 7 | Flag scope | ratify | RATIFIED (eng, 2026-07-13) | eng-ratify |
| 8 | Steer permissions | ratify | RATIFIED (eng, 2026-07-13) | eng-ratify |
| 9 | First GA one-sentence promise | decide | DECIDED (product, 2026-07-13) | product |
| 10 | CLI, skill, and OpenAPI policy | decide | RATIFIED (eng, 2026-07-13) | eng-ratify |
| 11 | Decision resolver authority | decide | RATIFIED (eng, 2026-07-13) | eng-ratify |
| 12 | Failure-atomic resolve | ratify | RATIFIED (eng, 2026-07-13) | eng-ratify |
| 13 | Decision queue bounds | decide | RATIFIED (eng, 2026-07-13) | eng-ratify |
| 14 | Outcome authority | ratify | RATIFIED (eng, 2026-07-13) | eng-ratify |
| 15 | Steer delivery | ratify | RATIFIED (eng, 2026-07-13) | eng-ratify |
| 16 | Command composer | ratify | RATIFIED (eng, 2026-07-13) | eng-ratify |

9 ratify, 7 decide (Q3, Q9, Q5, Q6, Q10, Q11, Q13) — matches the classification stated in §0.

Per roadmap §0, no Stage 1 feature code starts until all 16 rows above show a closed status. As of this document's date, all 16 rows are closed: 14 are `RATIFIED (eng, 2026-07-13)` and 2 (Q3, Q9) are `DECIDED (product, 2026-07-13)`.
