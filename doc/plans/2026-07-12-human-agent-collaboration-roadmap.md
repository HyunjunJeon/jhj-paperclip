# Human–Agent Collaboration Roadmap

Status: Planning draft (review-integrated)  
Date: 2026-07-12  
Last revised: 2026-07-12 (deep review findings folded in)  
Audience: Product, engineering, QA  
Related: `doc/PRODUCT.md`, `doc/SPEC-implementation.md`, `doc/execution-semantics.md`, `doc/TASK-WATCHDOG.md`, `ROADMAP.md`, `doc/plans/2026-03-13-features.md`, `doc/plans/2026-03-11-agent-chat-ui-and-issue-backed-conversations.md`

## 0. Purpose

This document is the executable program plan for human–agent collaboration in Paperclip. It combines:

1. Product stages with deliverables, non-goals, and exit criteria  
2. **Macro code / architecture / feature-level** synthesis: what collides, what we gain  
3. **Deep review findings** (product, execution-semantics, E2E/schema feasibility) folded into design rules—not a separate “later” note  
4. Layered verification (unit → API → thin Playwright) so new work does not fake-green CI  

This is **not** a V1 contract change. Implementation still needs per-stage issue plans and PRs. Do not start Stage 1 feature code until **pre-code decisions** (§3.3) are closed.

---

## 1. North star and hard constraints

> **Autonomy without orphaned work. Collaboration without chat sprawl.**

Humans decide, steer, and own risk. Agents execute and surface structured asks. Every interaction remains attached to issues, documents, work products, and activity—never a free-floating chat product.

| Constraint | Implication |
|---|---|
| Single assignee | Co-working uses **capability participants**, never multi-assignee ownership |
| Tasks + comments model | UX may feel conversational; durable store is issues / comments / interactions / approvals |
| Explicit action paths | No silent auto-heal; every wait has a **typed next-action owner** |
| Board governable | Pause, override, budget hard-stop remain authoritative |
| Thin core | Prefer **metadata and presentation on existing machines**, not parallel state machines |
| Output-first | Done means inspectable deliverable + contract satisfaction when a contract exists |

### 1.1 Mapping to public roadmap

| Collaboration slice | Closest `ROADMAP.md` themes |
|---|---|
| Structured decision packages + outcome checks | Enforced Outcomes, Deep Planning, Artifacts & Work Products |
| Store-first steer + hybrid check-ins | MAXIMIZER MODE (safe hybrid), operator loop |
| Question hygiene + single timeout owner | Operator noise control; not free auto-governance |
| Playbooks (later) | Memory/Knowledge edges / skills; must use change-consent |
| Issue-backed command composer | CEO chat / board command surface (`features.md`) |

### 1.2 Source proposal disposition

| Source proposal P0/P1 | Program disposition |
|---|---|
| Accountable human / working agent / next-action owner | Stage 0 resolver/ownership contract; Stage 1 `resolverPolicy` + WhatNeedsMe ownership display |
| Inbox + Decisions → Action Center | Stage 1 extends the canonical Attention/WhatNeedsMe feed; “Action Center” is product copy, not a new queue or route family |
| Standard result-review packet | Stage 2 review layout composes issue, run, work-product, verification, risk, cost, and next-decision data |
| Decision Ledger | Later read model over interactions, approvals, execution decisions, and activity; never a routing or approval source |
| Subscriptions/mentions and collaboration metrics | Explicitly post-GA; metrics instrumentation/source map begins in Stage 0 |

---

## 2. Unified context: three lenses

Deep review concluded: the north star and hard constraints are sound, but an early draft of this program **listed collaboration features as if they were greenfield**, while Paperclip already has dense ownership, liveness, review, and recovery machinery. New work must **compose into that machinery**, or it will look collaborative in UI and **orphan or double-drive** work in the server.

### 2.1 Macro code lens — where collaboration actually lives

Collaboration is not a single package. It is a **cross-cutting path** through existing layers:

```text
ui/  WhatNeedsMe, IssueDetail, LiveRun, Approvals, Inbox
        │
        ▼
server/ routes (issues, attention, approvals, heartbeat, documents, work-products)
        │
        ▼
services/ issues · issue-thread-interactions · issue-execution-policy
          attention · heartbeat (wake, coalesce, context_snapshot)
          recovery (successful-run-handoff, stranded, graph liveness)
          task-watchdogs · budgets · change-consent / skills
        │
        ▼
packages/shared  validators, constants (work modes, interaction kinds, outcomes)
packages/db      issues, issue_thread_interactions, issue_execution_decisions,
                 issue_work_products, documents, heartbeat_runs, approvals, …
```

**Implication for every feature:** name the **tables, services, and closed unions** you extend. If the answer is “new parallel engine,” redesign.

| Existing machine | Role today | Safe collab extension | Unsafe extension |
|---|---|---|---|
| `issue_thread_interactions` | Board-facing structured asks; pending → terminal; supersede | Optional **handoff enrichment** on closed payload schemas | New resolve verbs / parallel approval lifecycle |
| `SuccessfulRunHandoffState` + recovery | After successful run, human disposition can own next action | **Unify** decision packaging with this path | Second “handoff” concept with separate attention/recovery meaning |
| `executionPolicy` + `issue_execution_decisions` | Stage routing; executor `done` → often `in_review` + participant | Contract as **checklist/artifact preflight**; humans via **stages** | Independent `humanGates[]` + `autoPass` second engine |
| `issue_execution_decisions` | StageId + outcome bound | Stage approve / changes_requested only | Mid-run steer storage |
| Heartbeat wake + `context_snapshot` + coalesce | Comment/interaction wakes; merge running context | Store-first steer into wake/snapshot; **non-interrupt default** | Cancel-on-every-steer; freeform comment as only “resume” |
| Task watchdog | Eligible plan `request_confirmation` may auto-resolve | **Human-reserve** when handoff / humanOnly | Assume “governed only” covers all human decisions |
| Attention feed (derived) | Approvals, interactions, recovery, budget, … | Extend `AttentionItemDetail` + stable `dedupKey` | Assert copy/rank in E2E as schema; ignore dismissal vs terminal |
| `ISSUE_WORK_MODES` | `standard \| ask \| planning \| skill_test` | Additive mode only with **server-enforced** rules or pure advisory | Soft-fallback unknown modes; claim semantics without enforcement |
| Instance experimental settings | Flag flips (e.g. conference room); often `workers: 1` in e2e | Instance-scoped collab flags until company settings exist | Assume company-scoped flags without schema work |
| Assignee fields | Service enforces one assignee; **no DB CHECK** | Property tests + reject dual PATCH; optional CHECK later | Pair “approver” that checkouts or advances stages |
| Budget hard-stop | Blocks invokability | All collab-triggered wakes use same gate | Steer/pair/SLA path that enqueues past pause |

**Code anchors (implementers):**

| Concern | Location |
|---|---|
| Gold multi-actor E2E | `tests/e2e/signoff-policy.spec.ts` |
| E2E config / multi-user ignore | `tests/e2e/playwright.config.ts` |
| Interaction kinds / continuation | `packages/shared/src/constants.ts` |
| Closed confirmation payload | `packages/shared/src/validators/issue.ts` |
| Work modes | `ISSUE_WORK_MODES` in constants |
| Attention types | `packages/shared/src/types/attention.ts` |
| Attention service / route | `server/src/services/attention.ts`, `routes/attention.ts` |
| Successful-run handoff | `server/src/services/recovery/successful-run-handoff.ts` |
| Execution policy rewrite of done | `server/src/services/issue-execution-policy.ts` (and related) |
| Wake coalesce / snapshot | `server/src/services/heartbeat.ts` |
| Watchdog plan resolve | `doc/TASK-WATCHDOG.md`, task-watchdog services |
| Assignee XOR | `server/src/services/issues.ts` |
| local_trusted board actor | `server/src/middleware/auth.ts` (`userId: "local-board"`) |

### 2.2 Architecture lens — ownership, not chat

Paperclip separates four concepts that collaboration features constantly blur:

1. **Structure** — parent/sub-issue  
2. **Dependency** — blockers  
3. **Ownership** — single assignee (agent XOR user)  
4. **Execution / next action** — live path, waiting path, or recovery path  

Healthy waiting is a **closed set of action-path primitives** (see `doc/execution-semantics.md`): active run, queued wake, typed execution participant, pending interaction/approval, monitor, user assignee, blocker chain, or explicit recovery.  

**Architecture rule:** new collab UX may **enrich** an existing primitive (e.g. handoff metadata on a pending interaction). It must not create a wait that is only a comment, a card, or a “resumeHint” without one of those primitives.

```text
                    ┌──────────────────────────────────────┐
                    │           Board / humans             │
                    │  WhatNeedsMe · Approvals · Review UI │
                    └───────────────┬──────────────────────┘
                                    │ resolve / steer / force
          ┌─────────────────────────┼─────────────────────────┐
          ▼                         ▼                         ▼
   pending interaction      executionPolicy stage      successful-run
   (+ optional handoff       participant / decision     handoff disposition
    enrichment)              (routing authority)
          │                         │                         │
          └─────────────────────────┼─────────────────────────┘
                                    ▼
                         single assignee + wake/run/lock
                                    │
                                    ▼
                              Agent adapters
                    (consume wake context; optional mid-run)
```

**What we gain at architecture level (if composed correctly):**

- Faster human decisions without inventing a chatbot  
- Fewer orphaned `in_review` / silent dead waits  
- Safer hybrid autonomy: interrupt without dual ownership  
- Measurable loops (time-to-decision, contract completion) on real objects  

**What we lose if composed badly:**

- Two workflow engines on `done` / gates  
- Double attention + recovery thrash  
- Instruction injection that bypasses change-consent  
- E2E green while liveness is red  

### 2.3 Feature lens — gains vs collisions (synthesis)

| Feature (target) | Gains if done right | Collides with / risks | Composition rule |
|---|---|---|---|
| **Structured decision package** | Humans see why/options/artifacts; lower decision time | **Successful-run-handoff** name & ownership; closed Zod payloads; Attention union; **watchdog** auto-accept of plan confirmations | Enrich existing interaction (+ unify with successful-run path); map UI options → **existing** accept/reject/respond + stage outcomes; **humanOnly** for watchdog; **no** silentDefault worker early |
| **Outcome checklist / contract** | Enforced outcomes; fewer “done without deliverable” | `executionPolicy` rewrite of `done`; dual gate order; optional freeform issues | Contract = **preflight checklist + required work products**; human routing stays **stages**; no parallel `humanGates` DSL; no `autoPass` in early GA |
| **Side-by-side review UI** | Output-first progressive disclosure | Document annotation **non-wake** default; IssueDetail size; “not a code-review product” boundary | UI shell on existing plan/artifact/interaction; annotations that need agent action **create issue-thread primitives** |
| **Store-first steer** | Mid-work course correction without chat sprawl | Comment wake vs **interrupt** contract; run locks; coalesce; budget; change-consent / prompt injection | Typed issue comment + delivery state (seq, lease, ack, retry); default **non-interrupt** deferred wake; board-first permission; cancel only explicit |
| **Pair / participants** | Co-working feel; multi-human visibility | Soft dual ownership; checkout rights; multi-user E2E not in default suite | Capability grant only (comment/steer); never second assignee; never stage advance unless also typed participant |
| **`collaborate` work mode** | Hybrid default language | `skill_test` omission; soft-fallback to standard; question budget fights frequent asks | Ship only with **2–3 enforceable server rules**, or keep **skill/advisory only** (no false mode) |
| **Single timeout / SLA owner** | Bounded human waits | Monitor recovery, stranded recovery, watchdog, (bad) silentDefault—**four actors** | **One** timeout evaluator; issue-scoped alert/escalate/`blocked` or recovery only; never pause agents or auto-approve governed actions |
| **Question budget** | Less human noise | Agents blocked mid-work; over-merge bad questions | Conservative defaults; clear 422; prefer batch `ask_user_questions` |
| **Autonomy ladder (later)** | Safe auto for low-risk classes | Self-farming; name clash with low-trust/quarantine “trust”; approvals bypass | Server-derived anti-farm counters; **never** approvals table; rename away from “trust” |
| **Playbook capture (later)** | Organizational learning from rejects | Silent agent config mutation | Draft + **change-consent** / board publish only |
| **Command composer** | “Talk to CEO” without chat product | Parallel chat DB; `issues.kind` missing today | Always issue-backed; optional kind/label later |
| **Alignment threads** | Agent–agent conflict mediation | Unowned debate | Single assignee + real action path + decision record |
| **Deliverable bundles (later)** | Multi-issue board review | Bundle accept ≠ child done confusion | Bundle review **does not** auto-complete children |

---

## 3. Deep review findings (must treat as design constraints)

Review risk level for the program as written **before** these constraints: **High (conditionally Critical)**. The findings below are **binding** for this plan.

### 3.1 Ship-blockers if ignored

| ID | Finding | Required response in this program |
|---|---|---|
| R1 | Dual “handoff” (new package vs successful-run-handoff) | Stage 1 **must unify** naming, attention dedup, and recovery skip rules |
| R2 | `decisionOptions` invent parallel verbs (`request_changes`, `reassign`) | Map to existing APIs only; **drop reassign** from interaction options |
| R3 | Timeout actors without single owner | **No silentDefault worker** until SLA stage; design priority matrix first |
| R4 | Decision contract + executionPolicy dual machines on `done` | Contract preflight only; compile or drop independent humanGates; evaluation order ADR |
| R5 | Watchdog can auto-accept handoff-bearing plan confirmations | Stage 1: SPEC/watchdog **human reservation**; tests prove non-accept |
| R6 | Steer via `issue_execution_decisions` or comment-only is wrong | Typed issue comment + dedicated delivery state + non-interrupt deferred wake |
| R7 | Hidden infra assumed (helpers, company flags, clock, multi-user e2e, `issues.kind`) | Stage 0 honesty; no Stage 3–5 claims that need missing infra without epic cost |
| R8 | Trust ladder self-farming + terminology clash | **Out of first GA**; later rename + anti-farm |
| R9 | E2E plans over-claim (especially Stage 3–5 / journey as CI gate) | API-first proof; thin browser; journey manual unless an owned scheduled workflow is added |
| R10 | `resumeHint` alone does not restore liveness | Resolve must set wake policy / assignee / recovery—never hint-only |

### 3.2 Immediate cuts / freezes

| Item | Status |
|---|---|
| Stage 1 silentDefault **worker** | **Frozen** until single timeout owner ships |
| Interaction option `reassign` | **Cut** (use assignee PATCH separately) |
| Contract `autoPass` / parallel `humanGates[]` DSL | **Cut** from first GA (stages + checklist only) |
| Presence as Stage 3 requirement | **Deferred** |
| Autonomy/trust ladder | **Deferred** past first GA |
| Deliverable bundles | **Deferred** (separate Artifacts epic) |
| Mid-token adapter inject as MVP success | **Not required** (store-only is success) |

### 3.3 Pre-code decisions (block Stage 1 feature work)

Product + eng must answer in writing (issue or ADR):

1. **Handoff source of truth:** replace / include / satisfy successful-run-handoff—how does attention dedup work? → proposed: [decisions doc](2026-07-13-collab-pre-code-decisions.md#q1--handoff-source-of-truth)  
2. **UI option → API map** for accept / reject / request changes (side effects + continuationPolicy). → proposed: [decisions doc](2026-07-13-collab-pre-code-decisions.md#q2--ui-option-to-api-map)  
3. **Handoff required vs optional** when entering human-owned wait (server force vs skill recommend). → proposed: [decisions doc](2026-07-13-collab-pre-code-decisions.md#q3--handoff-required-vs-optional)  
4. **Watchdog:** handoff or `humanOnly` permanently human-reserved? (expected: yes) → proposed: [decisions doc](2026-07-13-collab-pre-code-decisions.md#q4--watchdog-human-reservation)  
5. **Timeout actor matrix** and issue-scoped alert / escalation / `blocked` / recovery mappings. → proposed: [decisions doc](2026-07-13-collab-pre-code-decisions.md#q5--timeout-actor-matrix)
6. **Contract storage + evaluation order** relative to executionPolicy (one line each). → proposed: [decisions doc](2026-07-13-collab-pre-code-decisions.md#q6--contract-storage-and-evaluation-order)  
7. **Flag scope:** instance experimental only vs company settings schema work in Stage 0. → proposed: [decisions doc](2026-07-13-collab-pre-code-decisions.md#q7--flag-scope)  
8. **Steer permissions:** board-only first? membership roles? interrupt vs non-interrupt? → proposed: [decisions doc](2026-07-13-collab-pre-code-decisions.md#q8--steer-permissions)  
9. **First GA one-sentence promise** (pick exactly one primary; the other shipped capabilities are secondary): → proposed: [decisions doc](2026-07-13-collab-pre-code-decisions.md#q9--first-ga-one-sentence-promise)
   - “WhatNeedsMe shows a decision package.”
   - “Optional contracts block done without required artifacts.”
   - “Board can store-first steer without dual ownership.”
10. **CLI / skill / OpenAPI** update policy when agents gain new fields. → proposed: [decisions doc](2026-07-13-collab-pre-code-decisions.md#q10--cli-skill-and-openapi-policy)
11. **Decision resolver authority:** board-any vs responsible user vs typed execution participant; non-owner behavior and escalation. → proposed: [decisions doc](2026-07-13-collab-pre-code-decisions.md#q11--decision-resolver-authority)
12. **Failure-atomic resolve:** transaction/outbox contract for decision + activity + continuation wake or explicit recovery. → proposed: [decisions doc](2026-07-13-collab-pre-code-decisions.md#q12--failure-atomic-resolve)
13. **Decision queue bounds:** idempotency source, pending-per-issue/company caps, supersession, payload limits, and attention pagination. → proposed: [decisions doc](2026-07-13-collab-pre-code-decisions.md#q13--decision-queue-bounds)
14. **Outcome authority:** immutable checklist revision, evaluator/evidence model, edit rights, artifact qualification/pinning, and force-complete fencing. → proposed: [decisions doc](2026-07-13-collab-pre-code-decisions.md#q14--outcome-authority)
15. **Steer delivery:** canonical comment storage, posting permission, sequence/idempotency, lease/ack/retry, reassignment, and active-run behavior. → proposed: [decisions doc](2026-07-13-collab-pre-code-decisions.md#q15--steer-delivery)
16. **Command composer:** company/goal linkage, draft vs assigned execution, budget-gated wake, idempotency, and audit. → proposed: [decisions doc](2026-07-13-collab-pre-code-decisions.md#q16--command-composer)

---

## 4. Compatibility invariants (always)

### 4.1 Domain

1. **Single assignee:** agent XOR user (or neither); never both. Prefer property tests; consider DB CHECK later.  
2. **Atomic checkout** for agent-owned `in_progress`.  
3. **Company boundary** on all new routes.  
4. **Approval authority:** hire / strategy / budget / board approvals never auto-approved by SLA, watchdog expansion, or autonomy ladder.  
5. **Interaction supersession** and closed lifecycle preserved.  
6. **`in_review` health** still requires a typed next-action owner from the closed set.  
7. **Existing work modes** (`standard`, `ask`, `planning`, `skill_test`) unchanged unless issue opts in.  
8. **No free-floating chat store.**  
9. **Activity audit** on mutating collab actions.  
10. **Budget hard-stop** applies to all collab-triggered wakes.  
11. **No second workflow engine:** gates/routing stay on interactions + executionPolicy + recovery; collab adds enrichment and checklists.
12. **Low-trust containment:** every new collab route, nested reference, wake payload, and prompt input preserves `low_trust_review` boundaries.
13. **Nested reference integrity:** artifact, revision, run, issue, and actor references are server-derived or validated against the same company and issue.
14. **Failure-atomic continuation:** resolving a human wait persists the decision, activity, and a durable next action in one recoverable operation.
15. **Durable terminal evidence:** completion records pin the qualifying evidence; later mutation cannot silently invalidate what was approved.

### 4.2 Standing regression

| Layer | Command / suite | Proves |
|---|---|---|
| Unit/contract | Targeted `pnpm test` + shared validators | Schemas, ownership, gate order |
| Types | Package-scoped or monorepo typecheck per repo practice | db/shared/server/ui sync |
| Browser E2E | `pnpm test:e2e` | Default **local_trusted** suite (not multi-user unless that job is explicitly run) |
| Multi-user | `pnpm test:e2e:multiuser-authenticated` (or project scripts) | Only when pair/auth membership is in scope |
| Release smoke | `pnpm test:release-smoke` | Onboard/auth-touching changes |
| Token gates | `pnpm check:token-gates` | UI design tokens |
| Storybook visual | `pnpm test:storybook-visual` | New visual surfaces have stories; intentional diffs publish matching baseline-manifest metadata |

**Baseline default e2e (must stay green):**  
`onboarding.spec.ts`, `signoff-policy.spec.ts`, `pipelines-tutorial-flow.spec.ts`, `planning-mode-visual-verification.spec.ts`, and any flag-touched conference/sidebar specs.

**Honesty:** `playwright.config.ts` **ignores** multi-user specs in the default run. Pair identity tests are **not** covered by `pnpm test:e2e` alone.

New tests: **no live LLM**. Prefer board + agent API keys + heartbeat invoke (`signoff-policy` pattern).

---

## 5. Verification strategy (review-corrected)

### 5.1 Pyramid (correct weight)

```text
┌──────────────────────────────────────────────┐
│ Playwright: thin smoke per stage + UI parity │  not ownership proof
├──────────────────────────────────────────────┤
│ Server API / integration (main collab gate)  │  ownership, gates, wake
├──────────────────────────────────────────────┤
│ Shared validators + pure state machines      │  closed schemas, XOR
└──────────────────────────────────────────────┘
```

Control-plane bugs (orphan waits, dual gates, watchdog accept, budget wake, dual assignee, steer coalesce) are **primarily server tests**. Playwright proves presentation and one happy path—not the full matrix.

### 5.2 Scenario matrix (requirements checklist, not “all in browser”)

| ID | Type | Default layer |
|---|---|---|
| H1 | Happy path | API + optional UI smoke |
| C1 | Single-assignee | Server property |
| C2 | Signoff / executionPolicy | Server + keep `signoff-policy` e2e |
| C3 | Budget hard-stop | Server |
| C4 | Company boundary | Server |
| C5 | Watchdog human-reserve | Server |
| C6 | Successful-run-handoff coexistence | Server |
| R1 | Resume / wake after resolve | Server (assert **action-path primitive**, not resumeHint) |
| R2 | Supersede / stale target | Server + light UI |
| R3 | Steer consume cursor / no cancel storm | Server |
| U1 | Attention / WhatNeedsMe | API feed first (`sourceKind` + subject id); UI second |
| A1 | Audit / activity | Server |

### 5.3 Stage 0 harness (mandatory or later e2e is fiction)

Build `tests/e2e/helpers/collab.ts` (or shared module) by extracting `signoff-policy` patterns:

- Company + process-adapter agents + hire approve  
- Agent key context, `invokeHeartbeat`, checkout/patch with 409 retry  
- `createInteraction` / `resolveInteraction`  
- `GET /api/companies/:id/attention` filters (`sourceKind`, `subject.id`, exit rules)  
- `seedWorkProduct`  
- Optional: sleep/long-running process adapter for steer smoke only  

Server: freeze attention + interaction contract shapes in vitest (`attention-service` patterns).

### 5.4 Feature flags

- Prefer **instance experimental settings** (what exists today) unless Stage 0 explicitly adds company-scoped settings.  
- E2E: flag-off baseline + flag-on path when behavior differs.  
- Flag-off must define **data compatibility** (old handoff payload still resolvable; unknown work_mode display).  
- Instance flag flips force serial e2e (`workers: 1`)—budget CI accordingly.

### 5.5 CI cost

| Suite | When |
|---|---|
| Server collab tests | Every collab PR (default gate) |
| `pnpm test:e2e` | Collab PRs + main CI (existing + thin new smokes) |
| `@collab` journey | **Manual by default**; scheduled nightly only after an owned workflow/filter is wired |
| Multi-user e2e job | Only when pair/auth in stage exit criteria |
| Release smoke | Onboard/auth-touching |

Avoid ~12–14 full serial browser files per stage; that will blow the ~30m PR e2e budget and create skip culture.

### 5.6 E2E feasibility grades (planning honesty)

| Stage | E2E grade | Note |
|---|---|---|
| 0 | B− | Feasible once helpers exist |
| 1 | C+ → B if API-first | Closed schema + attention union work required |
| 2 | C− → B if API gate order proven | Dual machine risk |
| 3 | D until steer store + long-run harness | Pair multi-user not default e2e |
| 4 | D− browser SLA; B server SLA | Injectable `now` required |
| 5 | D until kind/composer surfaces exist | Issue-backed only |
| Full journey as PR gate | F | Use as manual; add a scheduled lane only with explicit workflow ownership |

---

## 6. Program overview (reordered for safety and value)

First GA stops after a coherent hybrid slice—not after every idea.

| Stage | Theme | Outcome | Size | Depends |
|---|---|---|---|---|
| **0** | Foundations | Harness, invariants, extension-points doc, flag scope decision | 1–2 wk | — |
| **1** | Structured decision package | Human waits show reason/options/artifacts on **existing** interactions; watchdog human-reserve | 2–3 wk | 0 + §3.3 |
| **2a** | Outcome checklist | Optional contract: required artifacts/checklist at terminal | 2–3 wk | 0–1 |
| **2b** | Review layout | Side-by-side progressive disclosure (UI-heavy) | 1–2 wk | 2a or parallel after 2a API |
| **3a** | Store-first steer | Board directives + wake/context; no dual ownership | 2–3 wk | 0–1 |
| **3b** | Collaborate mode | Only if enforceable rules exist; else skill-only | 1 wk | 3a optional |
| **GA stop** | Hybrid collaboration | Decision package + optional contract + store-first steer | — | 1–3a |
| **4a** | Question budget / attention hygiene | Less noise | 1–2 wk | GA |
| **4b** | Single timeout / SLA owner | Issue-scoped alert/escalate/block only; never pause agents or auto-approve governed actions | 2–3 wk | 4a optional |
| **5a** | Command composer | Issue-backed board command | 2–3 wk | 1+ (may pull earlier if demand) |
| **Later** | Pair participants, autonomy ladder, playbooks, alignment, bundles | Separate epics | — | after GA |

**Removed from first GA path:** trust/autonomy ladder, silentDefault worker, presence, deliverable bundles, parallel humanGates/autoPass.

Stages 2b and 3a may parallelize only for disjoint server/API slices. Serialize work on shared IssueDetail/IssueChatThread surfaces or first extract owned components with separate contracts.

---

## 7. Stage 0 — Foundations

### 7.1 Goals

1. Codify ownership XOR + resolver authority + company boundary + budget-block-invoke tests
2. Land collab E2E/API harness  
3. Write `doc/design/COLLAB-EXTENSION-POINTS.md` with **true** hooks (closed payloads, attention union, wake keys, successful-run-handoff, watchdog, do-not-use execution_decisions for steer)  
4. Decide flag scope; optional instance flag scaffold  
5. Define telemetry event/source map, metric denominators, local-vs-fleet source, and pre-Stage-1 baselines
6. Define a manual `@collab` command/filter; scheduled execution remains out of scope until an owned workflow is added

### 7.2 Non-goals

User-facing collab UX; SLA workers; steer product UI.

### 7.3 Verification

| Layer | Plan |
|---|---|
| Unit | XOR assignee helpers; boundary |
| API | Attention + interaction create/resolve snapshots; successful-run-handoff coexistence baseline |
| E2E | Full default `pnpm test:e2e` + `collab-harness-smoke.spec.ts` (confirmation → resolve → attention exit) |

### 7.4 Exit

Helpers merged; no product behavior change flag-off; extension-points doc merged; flag scope decision recorded.

---

## 8. Stage 1 — Structured decision package (handoff enrichment)

### 8.1 Intent

When work waits on a human, show a **decision package** (why, options, artifacts, effort), not only status + freeform prose—**without** a second approval system.

### 8.2 Gains

- Lower time-to-decision on WhatNeedsMe  
- Agents learn a standard “block on human” shape via skills  
- Clearer audit of why autonomy stopped  

### 8.3 Collisions (must solve in design)

| Collision | Response |
|---|---|
| Successful-run-handoff | Unify: package may **satisfy** pending disposition; one attention dedup family |
| Closed Zod payloads | Explicit schema fields (unknown keys strip today) |
| Watchdog plan accept | `humanOnly` / handoff present → **not** watchdog-eligible; SPEC §9.9 update |
| Attention detail union | Extend types + feed generators carefully |
| Optional vs required | Product decision in §3.3; if optional, orphan rate is skill-dependent |

### 8.4 Shape (additive enrichment, not new verbs)

```ts
// conceptual — final fields in shared validators on existing kinds
type DecisionPackageEnrichment = {
  reason: string;
  // UI labels only; resolve maps to accept | reject | respond / stage outcomes
  optionLabels?: { accept?: string; reject?: string; requestChanges?: string };
  requiredArtifacts?: Array<{ kind: "work_product" | "attachment"; id: string }>;
  estimatedHumanMinutes?: number;
  resolverPolicy:
    | { kind: "responsible_user"; userId: string }
    | { kind: "typed_execution_participant"; userId: string }
    | { kind: "board" };
  // Server-derived for package-bearing plan confirmations; callers cannot turn it off.
  humanOnly: true;
  // schema-only until Stage 4b — NO worker enforcement in Stage 1
  silentDefaultHint?: { afterMinutes: number; preferred: "escalate" | "leave_pending" };
};
```

`requiredArtifacts` targets must exist, belong to the interaction's company and issue, and remain inspectable while the package is pending. Deletion either returns `409` or atomically marks the package incomplete; it never leaves a dangling reference. The server derives `humanOnly` and resolver identity from persisted issue/policy context rather than trusting agent payload authority.

**Resolve rules:**

- Use existing interaction resolve endpoints and continuation policies (`none` | `wake_assignee` | `wake_assignee_on_accept`).
- Enforce `resolverPolicy` server-side. Non-owners, former members, agents, low-trust runs, and cross-company principals receive a non-disclosing `403` and cause no wake.
- **request changes** = reject/respond with reason + wake assignee (or execution decision `changes_requested` when inside a policy stage).
- **Never** reassign via interaction option.
- Resolve is failure-atomic: persist the terminal interaction, activity, and an idempotent outbox wake or explicit recovery action in one transaction. Delivery retries independently; a failed enqueue cannot clear the only live path.
- Each source run/request gets a server-derived idempotency key. Enforce payload bounds, pending-per-issue and per-company caps, semantic supersession, and paginated attention reads before Stage 1 GA.

### 8.5 Implementation slices

1. Shared schema + server validation
2. Resolver authorization + nested-reference integrity
3. Transactional resolve/outbox + failure injection tests
4. Queue bounds, supersession, payload limits, and attention pagination
5. Attention detail + IssueDetail card
6. Watchdog eligibility + tests
7. Successful-run-handoff coexistence and canonical dedup identity
8. Agent skill docs + capability advertisement/version compatibility
9. Instance flag if needed

### 8.6 Verification

**Primary:** server tests cover create/resolve, resolver role matrix, low-trust denial, C5 watchdog, C6 handoff coexistence, R1 durable wake/recovery path, queue bounds, concurrent/double resolve, nested-reference company/issue checks, and A1 activity. Failure-injection tests crash after decision persistence and after outbox claim; both retain exactly one recoverable next action.

**Browser (thin):** `tests/e2e/collab-structured-handoff.spec.ts` — H1 package visible on WhatNeedsMe/IssueDetail; accept; attention clears by **terminal status** (not mere dismiss).  

**Regression:** `signoff-policy.spec.ts` unchanged for non-package issues.

### 8.7 Exit

- Flag-off: old and flag-on-created payloads remain readable/resolvable without losing their action path
- Watchdog cannot accept humanOnly/handoff plan confirmations
- Unauthorized, low-trust, stale-member, and cross-company resolution is denied without a wake
- Decision, activity, and continuation outbox/recovery are failure-atomic and idempotent
- Pending queues and attention responses are bounded and paginated
- Skill/capability rollout cannot teach disabled fields to agents

---

## 9. Stage 2 — Outcome checklist + review layout

### 9.1 Intent

1. **2a Outcome checklist (contract):** optional machine-checkable DoD + required work product types before terminal completion  
2. **2b Review layout:** artifacts/plan left, decisions/annotations right  

### 9.2 Gains

- Enforced outcomes (ROADMAP)  
- Board reviews outputs, not logs  
- Agents get explicit “what done means” on issue GET  

**Review packet projection (no new source of truth):** request/goal; work performed; created/changed work products; verification evidence; plan deviations; unresolved risks/assumptions; run cost + duration; next human decision; and raw transcript beneath progressive disclosure. Every field links back to the existing issue, run, document revision, work product, activity, or decision that supplies it.

### 9.3 Collisions

| Collision | Response |
|---|---|
| Executor `done` rewritten to `in_review` by policy | **Evaluation order ADR:** stages route review; checklist applies only to transitions that write successful `done`, including force-complete. `cancelled` fences execution and audits the reason but never requires DoD evidence. |
| Parallel humanGates | **Do not ship**; use executionPolicy stages for human authority |
| autoPass | **Do not ship** in first GA |
| Storage in `execution_policy` free keys | Prefer dedicated jsonb + revision **or** document revision pattern; avoid silent strip by normalizers |
| Doc annotations non-wake | Follow-ups must create **issue-thread** interactions / child issues / assignment |
| Board force-complete | Board-only audited transaction first fences/cancels active execution, compare-and-clears locks, invalidates queued/deferred wakes and monitors, then resolves stage/recovery state. Governed approvals block force-complete unless the board explicitly cancels/waives them with a reason. |

### 9.4 Contract shape (first GA)

```ts
type OutcomeChecklist = {
  revision: number;
  definitionOfDone: Array<{
    id: string;
    label: string;
    required: boolean;
    evaluator:
      | { kind: "work_product"; types: IssueWorkProductType[]; minimumCount?: number }
      | { kind: "manual_attestation"; allowedActor: "board" | "responsible_user" };
  }>;
  planDocumentKey?: "plan";
  planRevisionId?: string;
};

type OutcomeEvidence = {
  checklistRevision: number;
  itemId: string;
  kind: "work_product" | "attestation";
  evidenceRef: { id: string; revisionOrHash: string };
  recordedBy:
    | { kind: "user"; userId: string }
    | { kind: "run"; runId: string };
  recordedAt: string;
};
```

**Authority and evidence rules:**

- Board or the persisted responsible user owns checklist definitions once execution starts. Agents may attach evidence but cannot weaken, delete, or replace required items.
- Definition updates use optimistic concurrency, increment `revision`, invalidate stale attestations/decisions, and are audited.
- Work-product evaluators accept only same-company/same-issue, board-inspectable products that satisfy the qualification matrix below. On transition to `done`, evaluation pins ids plus immutable revision/hash.
- Pinned `done` evidence cannot be mutated or deleted unless a board action atomically invalidates/reopens the completion record with activity. Cancellation creates no completion-evidence record.

| Work-product type | Qualifying status | Review / health / evidence rule |
|---|---|---|
| `preview_url`, `runtime_service` | `active`, `ready_for_review`, `approved` | `healthStatus=healthy`; current URL/service is board-openable |
| `pull_request` | `ready_for_review`, `approved`, `merged` | not `changes_requested`; inspectable URL + immutable provider revision |
| `branch`, `commit` | `active`, `ready_for_review`, `approved`, `merged` | immutable commit/ref hash pinned |
| `artifact`, `document` | `ready_for_review`, `approved` | same-origin open path or document revision/content hash pinned |

Absent `sourceTrust` is the standard trusted case; `promoted` is accepted; `quarantined` is rejected. All types reject `draft`, `failed`, `archived`, `closed`, `changes_requested`, `reviewState=changes_requested`, and `healthStatus=unhealthy`. `reviewState=needs_board_review` qualifies only after it becomes `approved`; `healthStatus=unknown` qualifies only for immutable non-runtime evidence with a board-openable pinned snapshot.
- Review-layout approve/request-changes uses execution-policy stage decisions when a stage exists. Otherwise it uses work-product `reviewState`; annotations remain non-authoritative follow-up context, never a third verdict store.

### 9.5 Verification

**Primary server:** partial/unmet checklist → structured 422 on every path that writes `done`; server-derived evidence met → allow `done`; `cancelled` remains available without DoD evidence while still fencing execution and auditing the reason. Duplicate item ids, stale revisions, executor weakening, concurrent edit-vs-done, foreign/wrong-issue/deleted/uninspectable/quarantined evidence, and every successful-completion path are negative cases. C2 fixes signoff order. Force-complete tests active-run fencing, lock compare-and-clear, wake/monitor invalidation, governed-approval blocking/waiver, and activity. No checklist preserves legacy behavior.

**Browser thin:** contract status on issue; review mode shows the standard packet summary, artifact, verification, cost/duration, risk, next decision, and primary actions before the collapsible raw transcript.

**Annotation path:** prove follow-up primitive exists (interaction or child issue), not only document comment.

### 9.6 Exit

Optional only; checklist definition/evidence authority and revision semantics proven; pinned artifacts remain inspectable after `done`; cancellation remains evidence-independent and safely fenced; signoff + planning e2e green; agent skill says “attach evidence to the locked checklist revision before requesting done.”

---

## 10. Stage 3 — Store-first steer (+ optional collaborate / later pair)

### 10.1 Intent

Humans correct course **during** work without dual assignees or cancel storms.

### 10.2 Gains

- Less “cancel run and retype everything”  
- Hybrid supervision for high-stakes work  
- Audit of human course changes  

### 10.3 Collisions

| Collision | Response |
|---|---|
| `issue_execution_decisions` semantics | **Forbidden** as steer store |
| Interrupt vs comment wake | Default **non-interrupt** wake / next-context; interrupt only explicit |
| Active run coalesce | Non-interrupt steer always creates a deferred follow-up unless the active adapter positively acknowledges mid-run consumption; snapshot merge alone is not delivery |
| Budget hard-stop | Steer wake uses same invokability gates |
| Change-consent / injection | Directive text is a provenance-labeled typed issue comment; delivery metadata cannot silently rewrite SOUL/skills or erase the actor boundary |
| Process e2e adapters exit immediately | Long-run sleep adapter **or** pure API snapshot tests |
| Pair multi-user | **Later epic**; not default e2e; capability-only if shipped |

### 10.4 MVP model

```ts
// Directive text remains a typed issue comment; this table owns delivery state only.
type SteerDirectiveDelivery = {
  id: string;
  companyId: string;
  issueId: string;
  commentId: string;
  seq: number;
  idempotencyKey: string;
  status: "pending" | "leased" | "acked" | "superseded" | "dead";
  targetAgentId: string;
  assignmentGeneration: number;
  leasedToRunId?: string | null;
  leaseExpiresAt?: string | null;
  leaseToken?: string | null;
  version: number;
  ackedAt?: string | null;
  attemptCount: number;
  createdAt: string;
};
```

Posting is board-only for the MVP, company/issue scoped, activity-logged, rate-limited, and unavailable to low-trust agents. Allocate `seq` transactionally with unique `(issueId, seq)` and unique idempotency keys. State transitions use compare-and-set on `version`, `status`, `leaseToken`, lease expiry, target agent, and assignment generation:

- `pending → leased`: mint a new lease token/version for one run and generation.
- expired `leased → leased`: reclaim with a new token/version; stale acks cannot match.
- `leased → acked`: require the current token, run, agent, and assignment generation.
- reassignment atomically supersedes the old-generation lease and rebinds any unacknowledged directive to the new generation.
- exhausted attempts move to `dead` and create a visible recovery action.


Adapter matrix: **store-only** guarantees at-least-once deferred next-run delivery; partial mid-run poll/full inject may acknowledge earlier. Carry stable directive id + `seq` in adapter context so processing and ack are idempotent. A merged `context_snapshot` without adapter acknowledgement never marks a directive acked; consume-before-ack crashes may replay safely.

### 10.5 `collaborate` mode

Ship only if server enforces concrete rules (examples: max continuous run policy, required park interaction after N turns, cheaper model lane hints)—otherwise **skill guidance only**, no new enum inflation. Preserve `skill_test`.

### 10.6 Pair (explicitly later)

Participants as capability grants: comment, optional steer post, never checkout, never stage advance unless also `executionState.currentParticipant`. Requires multi-user test job in exit criteria.

### 10.7 Verification

**Primary server:** canonical comment + delivery row persist atomically; transactional sequence/idempotency; deferred follow-up on running adapters; CAS-tokened lease/reclaim/ack/supersede; at-least-once delivery with idempotent processing; crash/restart/failed invoke/cancel/reassignment/coalesce/concurrent-post retries; stale ack denial; no cancel by default; C3 budget; actor/low-trust/company denial; rate and payload limits.

**Browser optional:** timeline shows steer event after API seed.  

**Not required for exit:** real mid-token Claude inject.

### 10.8 Exit

Property tests: single assignee; unique ordered delivery; no lost directive across crash/reassignment; duplicate delivery is safely deduplicated by stable id/`seq`; adapter matrix documented; no orphan runs from steer defaults.

---

## 11. Stage 4 — Hygiene + single timeout owner (post-GA)

### 11.1 Question budget (4a)

**Gain:** fewer low-value human interrupts.  
**Collision:** blocks legitimate questions; fights collaborate check-ins.  
**Rule:** conservative defaults; 422 with clear error; prefer batching.

### 11.2 Single timeout / SLA owner (4b)

**Gain:** bounded waits; escalate noise instead of infinite pending.  
**Collision:** monitor recovery, stranded recovery, watchdog—must not double-fire.  
**Rules:**

- Exactly **one** timeout evaluator for human waits.
- Persist one non-terminal timeout-action row per `(interactionId, policyVersion, action)` with `active | cleared | superseded` state. Timeout automation never terminalizes the interaction, pauses an agent, or approves governed actions.
- Claim an action by compare-and-set only while the interaction is pending and the deadline/policy version still match; the interaction remains resolvable.
- Apply only legal, issue-scoped effects for the current issue status: alert/escalated attention, a compatible `blocked` transition where allowed, or an explicit recovery action when `blocked` is illegal (including `in_review`).
- Human resolution atomically terminalizes the interaction, clears only the matching active timeout action/cause, and restores/queues the valid continuation path. Resolution before timeout prevents a claim; resolution after a claim clears its effect without creating a second interaction.
- Tests cover resolve-before-timeout, timeout-before-resolve, concurrent claim/resolve, stale policy versions, and at most one active action plus one valid continuation.
- Rollout defaults to new waits only. Any legacy backfill requires dry-run counts, bounded batches, clamped deadlines, and rollback/drain rules.
- **Server tests with injectable `now`**; browser only asserts **pre-seeded** escalated attention UI.
- Do not rely on `PAPERCLIP_E2E_SLA_MIN_MS=50` against real scheduler floors.

### 11.3 Deferred: autonomy ladder + playbooks

Documented for completeness only:

- Autonomy ladder: server-derived counters, anti-farm, never approvals table, rename away from “trust”  
- Playbooks: reject → draft skill/doc → **change-consent / board publish**  

---

## 12. Stage 5 — Board command surface (issue-backed)

### 12.1 Command composer (priority)

**Gain:** “Talk to the CEO” without a chat product, reusing the issue-backed conversation model from `doc/plans/2026-03-11-agent-chat-ui-and-issue-backed-conversations.md`.
**Collision:** chat sprawl; missing `issues.kind`; duplicate composer/conversation conventions.
**Rule:** always create/update issues + comments. The server derives company plus goal/parent/project linkage, creates either an explicit non-waking draft or exactly one CEO-assigned issue, and uses normal budget/invokability gates before wake. Requests are idempotent, permission-checked, and activity-logged; unanchored or cross-company references fail.

### 12.2 Alignment (later)

Structured multi-agent dispute issue; single assignee; decision record; may feed playbook candidate.

### 12.3 Bundles (later)

Multi-issue artifact review; **does not** auto-done children.

### 12.4 Verification

API tests prove the composer creates/updates the intended company-scoped issue and comment, preserves goal traceability and single ownership, records actor/activity, is idempotent on retry, applies budget gates before wake, and rejects unauthorized/cross-company input. Browser coverage is a thin submit/render smoke; no chat table is created.

---

## 13. Cross-program journey (manual; scheduled only after workflow wiring)

`tests/e2e/collab-journey.spec.ts` tagged `@collab`—**not** a PR-blocking sole gate.

Happy path (API-orchestrated state, thin UI asserts):

1. Company + executor (harness)  
2. Optional outcome checklist on issue  
3. Plan or confirmation with decision package → human accept  
4. Store-first steer appears in next wake context  
5. Work product attached; checklist satisfied → terminal  
6. Single assignee throughout; attention empty of pending package; activity present  

Negatives (mostly server): dual assignee; unauthorized/low-trust/cross-company nested references; double resolve and resolve-vs-timeout races; decision-outbox crash; unbounded pending rejection; done with partial/stale/deleted/uninspectable evidence; force-complete with active run or governed approval; lost/repeated steer after crash/reassignment; governed approval never timeout-approved; composer without company/goal anchoring.

Disable or avoid task-watchdog noise on journey company when possible.

---

## 14. Per-stage definition of done

- [ ] User-visible behavior documented  
- [ ] db / shared / server / ui (+ CLI/skill if agent-facing) synced  
- [ ] Flag default + flag-off data behavior documented  
- [ ] §4.1 invariants proven by tests  
- [ ] Server tests cover ownership/race cases for the stage  
- [ ] Thin e2e smoke if UI ships; full default `pnpm test:e2e` green  
- [ ] No dual-assignee path; no non-issue chat store  
- [ ] No parallel approval/gate engine  
- [ ] Board pause / force-stop / budget hard-stop still work  
- [ ] Token gates clean for UI  
- [ ] Every new visual surface has a Storybook story; visual diffs reviewed, baseline-manifest metadata updated when intentional, and a11y checks clean
- [ ] Low-trust denial, nested-reference scoping, idempotency, failure-atomic continuation, and bounded-queue cases pass for each new mutating surface

---

## 15. Suggested epic breakdown

### Stage 0

1. Extract collab harness helpers  
2. Ownership XOR + resolver authority + boundary + budget-invoke server tests
3. `COLLAB-EXTENSION-POINTS.md` (accepted timeout actor matrix, wake/interrupt, handoff coexistence, resolve/outbox boundary)
4. Flag scope decision + optional instance flag  
5. Attention/interaction contract snapshots  

### Stage 1

1. Decision package schema on existing interaction kinds
2. Resolver policy + verb mapping table
3. Transactional resolve/outbox + queue bounds
4. Attention + IssueDetail rendering
5. Watchdog human-reserve + SPEC note
6. Successful-run-handoff canonical identity/dedup
7. Skills/capability rollout + thin e2e

### Stage 2

1. Versioned outcome definitions + evidence/attestation storage + terminal guards + order ADR
2. Artifact qualification/pinning + post-terminal mutation policy
3. Force-complete execution fencing + governed-approval handling
4. Review layout shell with one authoritative verdict source
5. Annotation → issue-thread follow-up
6. Server tests + thin e2e

### Stage 3

1. Canonical steer comments + delivery-state table/API
2. Transactional sequence/idempotency + deferred wake
3. Lease/ack/retry/reassignment state machine
4. LiveRun UI control (board)
5. Optional collaborate enforcement **or** skill-only decision
6. Crash/concurrency server tests; optional long-run adapter smoke

### Post-GA

1. Question budget  
2. Single SLA/timeout owner + CAS/race/backfill + injectable clock tests
3. Issue-backed command composer with company/goal/ownership/budget invariants
4. Later: pair, autonomy ladder, playbooks, alignment, bundles  

---

## 16. Risk register (living)

| Risk | L | I | Mitigation |
|---|---|---|---|
| Second workflow engine on gates/done | H | C | Thin core rule; contract preflight only; stages for humans |
| Dual handoff / attention thrash | H | H | Canonical handoff identity, atomic satisfaction, one dedup family |
| Decision resolve commits but continuation is lost | M | C | Transactional activity + outbox/recovery; failure injection and idempotent retry |
| Pending decision/attention queue overload | H | H | Server-derived idempotency, supersession, caps, payload bounds, pagination |
| Mutable or invalid completion evidence | H | H | Type-specific qualification + immutable revision/hash pin + audited reopen |
| Watchdog auto-decides for humans | H | H | humanOnly eligibility + tests |
| Timeout multi-actor / resolve races | H | H | One non-terminal timeout-action owner; CAS claim; issue-status-legal effects; late-resolution cleanup |
| Steer cancel storms / lost directives | M | H | Canonical comment + deferred at-least-once delivery + tokened lease/ack/CAS + consumer dedupe |
| E2E false confidence | H | H | API-first; journey manual unless a scheduled lane is explicitly owned; no LLM; no wall-clock SLA |
| Flag / CI serial blowup | M | M | Instance flags; thin smokes; workers:1 awareness |
| Soft dual ownership via pair | M | H | Capability-only; later epic |
| Autonomy ladder farming | M | H | Deferred; anti-farm if ever |
| Chat product creep | M | C | Composer issue-backed only |
| IssueDetail merge conflict | M | M | Coordinate 2b/3a UI; progressive disclosure |
| Contract feels heavy | M | M | Optional; templates; soft warn before hard 422 optional later |

---

## 17. Success metrics (after Stage 1–2 ship)

| Metric | Direction | Note |
|---|---|---|
| Median time-to-human-decision on attention items | ↓ | Requires real resolve events |
| % human waits with decision package enrichment | ↑ | Define denominator carefully |
| % checklist issues terminal with required artifacts | ↑ → ~100% when checklist present | |
| Orphaned waits (no action-path primitive) | ↓ → ~0 | Server liveness definition |
| Steer events that avoid full run cancel | ↑ | After 3a |
| Board-governed auto-approvals via automation | **= 0 always** | Hard invariant |
| Human questions per completed issue | ↓ | After 4a; quality watch |

---

## 18. Immediate next actions

1. Close **§3.3 pre-code decisions** (product + eng).  
2. Land **Stage 0** harness + invariants + extension-points.  
3. Stage 1 implementation plan with **verb map + successful-run-handoff coexistence + watchdog eligibility** (not open-ended schema brainstorm).  
4. Align public `ROADMAP.md` wording when Stage 1–2 start (Enforced Outcomes / Deep Planning / Artifacts)—without overselling Stage 3–5.  
5. Treat this document as the single program source; update it when decisions land (do not fork parallel “version” docs).  

---

## Appendix A — E2E patterns to copy

From `tests/e2e/signoff-policy.spec.ts`:

- Throwaway `local_trusted` server via Playwright `webServer`  
- Board implicit auth vs agent bearer keys  
- Heartbeat invoke for run ids  
- PATCH with `X-Paperclip-Run-Id`  
- 409 retry when lock moves  
- UI only after API-orchestrated state  

From `tests/e2e/playwright.config.ts`:

- Dedicated port (default 3199)  
- `workers: 1` when instance flags mutate global UI  
- `reuseExistingServer: false`  
- Multi-user specs **not** in default `testMatch` path (ignored)

## Appendix B — Explicit non-goals

- Consumer multi-party chat product / parallel chat DB  
- Multi-assignee execution  
- Silent self-healing orchestration  
- Enterprise fine-grained RBAC rewrite as a dependency  
- Replacing GitHub/Jira as general PM tools  
- Requiring cloud agents before local collab works  
- Mid-token multi-adapter inject as MVP success criterion  
- Autonomy ladder or SLA auto-approve of governed actions  
- Treating Playwright journey green as proof of control-plane safety  

## Appendix C — Review methodology note

This revision integrates findings from a multi-perspective deep review:

- Product / architecture scope and parallel-engine risk  
- Execution-semantics ownership, races, and liveness closed set  
- E2E/schema feasibility and false-confidence analysis  

Those findings are encoded as **§2 synthesis**, **§3 binding constraints**, **reordered stages**, and **corrected verification**—not as a separate addendum that implementers can ignore.
