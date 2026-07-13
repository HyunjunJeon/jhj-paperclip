# Stage 1 Decision Package — PR #4 Remediation Plan

Date: 2026-07-13  
Status: Ready for PR-A execution (post plan review)  
Branch: `feat/collab-stage1-decision-package`  
Related PR: https://github.com/HyunjunJeon/jhj-paperclip/pull/4  
Binding source: `doc/plans/2026-07-13-structured-decision-package.md`  
Review input: PR #4 code review + remediation plan review (B1–B4, R1–R5)

## 0. Purpose

PR #4 landed S0 ownership hygiene and a partial Stage 1 scaffold, but several Stage 1 invariants diverge from the binding C1 plan or are incorrectly wired. This document is the **corrected execution plan** to bring the branch in line with the plan without claiming full Stage 1 GA (Track A outbox and thin e2e remain deferred).

### 0.1 Non-goals (explicit)

- Track A continuation outbox / failure-atomic resolve (separate plan dependency)
- Thin e2e `collab-structured-handoff` (Task 11; after outbox)
- Skills / OpenAPI / CLI capability advertisement (Task 10)
- `silentDefaultHint` worker enforcement (frozen Stages 1–3)
- Interaction-level `reassign` (cut; assignee PATCH only)
- External connectors, Decision Ledger, mentions, metrics dashboard, Board Pulse, Conference Room, Stage 2+

### 0.2 Closed decisions (do not re-open)

| Decision | Choice | Rationale |
|---|---|---|
| Package shape | **Nested** `payload.decisionPackage` | Plan §1.1–1.2; SQL `jsonb_exists`; later-stage compatibility |
| Package-bearing predicate | `payload.decisionPackage` is a non-null object | Discard flat reason/enrichment heuristics |
| `humanOnly` | Server-stamped `decisionPackage.humanOnly: true` on create | Caller input stripped |
| Feature flag | Gate **create only** when `decisionPackage` present | Reads/resolves remain available after flag-off |
| Track A | Out of this remediation series | Honest PR framing |
| Attention pagination in PR-A | **Revert** broken behavior (restore Stage 0 full feed) | Not optional; Stage 0 freeze regression |
| Supersession in PR-A | **S-lite** (confirmation-family kinds) | Caps alone let agents fill the queue without replacing stale packages |
| Legacy flat payloads | Not package-bearing; no migration script | Only flag-on nested creates carry Stage 1 meaning |

---

## 1. Problem summary (from PR review)

| ID | Severity | Issue |
|---|---|---|
| I1 | Critical/High | Schema is flat enrichment; plan requires nested `decisionPackage` |
| I2 | High | Three divergent `isPackageBearingPayload` / reserve predicates |
| I3 | Critical | S6 human-reserve is dead code after agent board-only denial |
| I4 | High | `resolverPolicy` incomplete (no board override, membership, audit, typed re-check) |
| I5 | High | Package caps race (no FOR UPDATE / advisory lock); wrong error codes |
| I6 | High | Attention pagination breaks Stage 0 contract (always-on limit, interaction-only cursor) |
| I7 | Medium–High | `humanOnly` stamped only on confirmation kinds |
| I8 | Medium–High | `enableHumanAgentCollab` does not gate package create |
| I9 | Medium | Package supersession missing |
| I10 | Process | PR claims Stage 1 complete while Track A deferred |
| I11 | Medium | UI thin; flat field reads will break after nested fix |
| I12 | Low–Medium | Validator bounds drift from plan |
| I13 | Medium | `requiredArtifacts` partial (no delete-in-use, weak codes, N+1) |
| I14 | Low | Handoff coexistence is comment-only |

S0 ownership hygiene and Stage 0 freeze tests are **preserved**.

---

## 2. Principles

1. Binding C1 plan is source of truth; align code to plan, do not rewrite plan to match partial code.
2. One identity, one predicate, one authority model — no duplicated heuristics.
3. Track A stays deferred; PR body must not claim Stage 1 complete.
4. Preserve S0 + Stage 0 freezes; only Stage 1 code is re-aligned.
5. Commit-sized, verifiable slices; P0 must go green before P1–P5 implementation commits.
6. Plan-review amendments are binding: **B1–B4** below are not optional.

---

## 3. Plan-review amendments (binding)

### B1 — P5 starts with path discovery (P5.0)

Do not implement watchdog reserve until the call graph is known.

```text
P5.0 (investigation only, minimal/no product mutation)
  Map callers of:
    acceptInteraction |
    resolve_eligible_request_confirmation_plan_interactions |
    isHumanReservedPlanConfirmation
  Branch:
    A) Real auto-accept path exists → guard that entry + tests
    B) No real path yet → eligibility helper + extension-points/SPEC note +
       red unit fixture that future auto-accept must fail for package-bearing
  Either way: delete dead route branch after rejectAgentIssueThreadInteractionResolution
```

PR must not say “S6 complete” under branch B. **No P5 implementation commit before P5.0 result is recorded** (short note in this file §8.1 or PR comment).

### B2 — P4-B is mandatory in PR-A

Broken pagination is a Stage 0 freeze regression, not a product choice.

- PR-A **must** revert always-on limit / interaction-only keyset / `totalCount = page length` behavior.
- Param-less `GET …/attention` restores Stage 0 full-feed contract.
- `nextCursor?: string | null` type may remain optional no-op.
- Correct re-implementation is **PR-B only**.

### B3 — Cap locking details

- Run cap logic **only** when the new payload is package-bearing.
- Issue: `SELECT id FROM issues WHERE id = $1 FOR UPDATE` then count pending with `jsonb_exists(payload, 'decisionPackage')`.
- Company: transaction-scoped advisory lock; prefer `pg_advisory_xact_lock(namespace, hashtextextended(...))` or two-int form — **not** bare `hashtext` alone (int4 collision risk).
- Verify advisory locks under embedded/PGlite tests; if unsupported, document fallback (issue FOR UPDATE + serializable-with-retry) in the implementing commit message.
- Measure 64 KiB with `Buffer.byteLength(JSON.stringify(payload), "utf8")`.
- Minimum test: three package creates succeed, fourth → `422 DECISION_PACKAGE_PENDING_ISSUE_LIMIT`. Prefer a concurrent stress if stable.

### B4 — Resolver single source of truth

In **one commit**:

1. Add route guard `assertInteractionResolverPolicyAllowed` on all five resolve verbs.
2. **Remove** service-level `assertResolverAuthorized` (no double gate).
3. Keep create-time membership validation **only** in the service create path.

### R1 — S-lite supersession in PR-A

After caps (A5), implement minimal supersession:

- Kinds: `request_confirmation`, `request_checkbox_confirmation`, `ask_user_questions`, `request_item_verdicts` (not `suggest_tasks`).
- Same `(issue, kind, target)` pending package-bearing row → `expired` with `"superseded_by_interaction"` in the same create transaction.
- Full result-schema polish / edge cases may finish in PR-B.

### R4 — UI minimum in PR-A

Nested schema breaks flat UI reads. PR-A includes confirmation-card nested `decisionPackage` reads (reason / optionLabels). Broader UI + attention detail → PR-B.

### Legacy flat policy (one line)

Persisted flat enrichment (if any local/dogfood rows exist) is **not** package-bearing. No migration in this series. Only nested, flag-on creates carry Stage 1 semantics.

---

## 4. Delivery shape

| PR | Scope | Merge bar |
|---|---|---|
| **PR-A** | Core correction: nested identity, flag, stamp, artifacts, resolver, caps, S-lite supersession, pagination revert, watchdog (per P5.0), min UI, docs/PR body | Focused vitest + typecheck + token-gates |
| **PR-B** | Correct attention pagination, attention detail, remaining UI, supersession polish, handoff test | Attention contract + UI tests |
| **PR-C** (later) | Track A outbox, thin e2e, skills/OpenAPI | Outbox plan Phase 1 dependency |

Prefer stacking PR-A commits on the current feature branch and reframing PR #4 body, or opening a follow-up PR that states it corrects #4.

---

## 5. PR-A execution sequence

Order is mandatory:

```text
A0  P5.0 watchdog call-graph note
A1  Nested schema + single predicate + types
A2  Create: stamp all kinds, flag gate, payload bound codes, resolver-invalid on create
A3  requiredArtifacts integrity + delete-in-use
A4  Resolver route guard + remove service assert + override audit (B4)
A5  Serialized caps (B3) + planned error codes
A5b S-lite supersession (R1)
A6  Attention pagination REVERT (B2) — before watchdog
A7  Watchdog reserve per A0 + delete dead route branch
A8  UI confirmation nested read + token-gates (R4)
A9  COLLAB-EXTENSION-POINTS §2 nested + PR body reframe
```

Do not start A3–A7 product logic until A1–A2 tests are green.

---

## 6. Work packages

### A0 / P5.0 — Watchdog path discovery

**Files (read-only unless note is written):**  
`server/src/services/task-watchdogs.ts`, `server/src/routes/issues.ts`, recovery services, tests referencing plan confirmation resolve.

**Output:** Short note in §8.1 of this file (or PR comment) with branch A or B and file:symbol anchors.

**Done when:** Call graph documented; implementation path chosen.

---

### A1 — Nested schema + single predicate

**Files**
- `packages/shared/src/validators/issue.ts`
- `packages/shared/src/types/issue.ts`
- `packages/shared/src/decision-package.ts`
- `packages/shared/src/index.ts`, `packages/shared/src/validators/index.ts`
- Tests: `packages/shared/src/decision-package.test.ts` (or move to `validators/decision-package.test.ts` — single home)

**Implement (plan §1.1)**
```ts
decisionPackageResolverPolicySchema
decisionPackageRequiredArtifactSchema
decisionPackageOptionLabelsSchema
decisionPackageSilentDefaultHintSchema  // afterMinutes 5..43200
decisionPackageInputSchema              // no humanOnly; resolverPolicy default { kind: "board" }
decisionPackageSchema                   // + humanOnly: z.literal(true)
```

Each of the five payload object literals gains:
```ts
decisionPackage: decisionPackageInputSchema.optional()
```

**Remove:** `decisionPackageEnrichmentFields` flat extend; flat type fields on payload interfaces.

**Bounds (plan values)**
- `reason`: 1–2000
- `estimatedHumanMinutes`: 1–480
- `silentDefaultHint.afterMinutes`: 5–43200
- `optionLabels` strings: max 80

**Predicate (only implementation)**
```ts
export function isPackageBearingPayload(payload: unknown): boolean {
  if (payload == null || typeof payload !== "object" || Array.isArray(payload)) return false;
  const dp = (payload as Record<string, unknown>).decisionPackage;
  return dp != null && typeof dp === "object" && !Array.isArray(dp);
}
```

**Tests:** plan Task 1 Step 1 cases (minimal package + default policy, strip humanOnly, bad policy, silentDefault bounds, persisted schema requires humanOnly, all five kinds accept package).

**Done when:** shared vitest green; `pnpm --filter @paperclipai/shared exec tsc --noEmit` clean; no second predicate definition in repo (except temporary during WIP — must be gone by A2).

---

### A2 — Create path: stamp, flag, bounds, resolver identity

**Files**
- `server/src/services/issue-thread-interactions.ts`
- `server/src/routes/issues.ts` (create interaction)
- `server/src/__tests__/decision-package-create-routes.test.ts` (new)

**Service**
1. Delete local `isPackageBearingPayload`; import from `@paperclipai/shared`.
2. On create parse/normalize:
   - Strip client `humanOnly` anywhere under payload / decisionPackage.
   - If package present: stamp  
     `decisionPackage = { ...input, humanOnly: true, resolverPolicy: input.resolverPolicy ?? { kind: "board" } }`  
     for **all five kinds**.
3. If package-bearing and encoded payload > 64 KiB UTF-8 →  
   `422 { code: "DECISION_PACKAGE_PAYLOAD_TOO_LARGE" }`.
4. If `resolverPolicy.kind` is `responsible_user` or `typed_execution_participant`, require active company membership (`company_memberships`, `status = 'active'`, user principal); else  
   `422 { code: "DECISION_PACKAGE_RESOLVER_INVALID" }`.

**Route flag gate** (before create; only when body has `payload.decisionPackage`):
```ts
// Pattern: board-chat FEATURE_DISABLED
if (!experimental.enableHumanAgentCollab) {
  res.status(403).json({
    error: "Human–agent collaboration is not enabled",
    code: "FEATURE_DISABLED",
  });
  return;
}
```

Plain (non-package) creates remain allowed with flag off.  
GET/resolve never flag-gated (exit: packages remain readable/resolvable after flag-off).

**Tests (create-routes):** plan Task 1 Step 4 subset at minimum:
- flag-off package create → 403 FEATURE_DISABLED, no row
- flag-off plain create → success, Stage 0 shape
- flag-on package → humanOnly true, default board policy
- caller humanOnly false overridden
- oversize → DECISION_PACKAGE_PAYLOAD_TOO_LARGE
- non-member / inactive resolver → DECISION_PACKAGE_RESOLVER_INVALID
- flag-on create then flag-off resolve still 200
- low-trust create still denied (LT-26 floor)

**Done when:** create-routes + interaction contract freezes green.

---

### A3 — requiredArtifacts integrity

**Files**
- `server/src/services/issue-thread-interactions.ts`
- `server/src/routes/issues.ts` (work-product DELETE, attachment DELETE)
- `server/src/__tests__/decision-package-artifact-routes.test.ts` (new)

**Rules**
1. Create: each `decisionPackage.requiredArtifacts[]` entry must exist for **same company + issue**.  
   Fail → `422 { code: "DECISION_PACKAGE_ARTIFACT_INVALID" }` (non-disclosing whether missing or cross-company).
2. One query per kind (id set), not N+1.
3. DELETE while pending package references → `409 { code: "DECISION_PACKAGE_ARTIFACT_IN_USE" }`.
4. After terminal interaction status, DELETE allowed.
5. Predicate uses nested JSON:  
   `payload->'decisionPackage'->'requiredArtifacts'`.

**Done when:** artifact-routes green; create-routes still green.

---

### A4 — Resolver authority (Q11)

**Files**
- `server/src/routes/issues.ts` — `assertInteractionResolverPolicyAllowed`
- `server/src/services/issue-thread-interactions.ts` — export `getInteractionForIssue`; **remove** `assertResolverAuthorized`
- `server/src/__tests__/decision-package-resolver-routes.test.ts` (new)
- Amend `server/src/__tests__/collab-invariants-routes.test.ts` comments/expectations deliberately

**Guard semantics (plan §2 / Task 3)**
- After `assertBoard`, before mutation.
- No package / no policy / `kind: "board"` → allow (today’s authority).
- Named user matches `policy.userId` (+ typed participant still on issue for `typed_execution_participant`) → allow.
- Board principal: `local_implicit` | `isInstanceAdmin` | membership role `owner` | `admin` → allow and set  
  `res.locals.resolverPolicyOverride = { policyKind }`.
- Else → `403 { error: "You cannot resolve this interaction" }` (no policy kind/user in body); **no wake**.
- Wire: accept, reject, respond, verdicts, cancel.
- Activity log details include `resolverPolicyOverride` when set.

**Pre-impl note:** locate how `executionPolicy` participant user id is read on issues before coding typed re-check.

**Done when:** named allow; non-named operator deny + pending + zero wakeups; owner override audited; five verbs covered; collab-invariants Stage 1 comments updated.

---

### A5 — Serialized package-bearing caps

**Files**
- `server/src/services/issue-thread-interactions.ts` (create transaction)
- Cap tests in create-routes or dedicated suite

**Logic (package-bearing creates only)**
```text
BEGIN
  SELECT id FROM issues WHERE id = $issueId FOR UPDATE
  count pending issue rows WHERE jsonb_exists(payload, 'decisionPackage')
  if count >= 3 → 422 DECISION_PACKAGE_PENDING_ISSUE_LIMIT

  advisory_xact_lock(company cap key)
  count pending company rows WHERE jsonb_exists(payload, 'decisionPackage')
  if count >= 100 → 422 DECISION_PACKAGE_PENDING_COMPANY_LIMIT

  insert ...
COMMIT
```

**Error codes (exact)**

| Condition | Code |
|---|---|
| Issue pending packages ≥ 3 | `DECISION_PACKAGE_PENDING_ISSUE_LIMIT` |
| Company pending packages ≥ 100 | `DECISION_PACKAGE_PENDING_COMPANY_LIMIT` |
| Payload > 64 KiB | `DECISION_PACKAGE_PAYLOAD_TOO_LARGE` |

Replace partial codes (`pending_package_bearing_*`, `payload_too_large`, etc.).

**Done when:** fourth package on issue 422; many plain pendings do not count; SQL uses `jsonb_exists`; no full-table JS filter for caps.

---

### A5b — S-lite supersession

**Files**
- `packages/shared` result schemas: add `"superseded_by_interaction"` where plan §4 requires
- `server/src/services/issue-thread-interactions.ts` create transaction (same tx as insert)
- Tests on create-routes or interaction service tests

**Rules**
- Only when new create is package-bearing.
- Kinds: four supersedable kinds (not `suggest_tasks`).
- Match target = confirmation target key+revisionId when present, else issue-level kind match per plan §4.
- Older pending → `expired` + supersession reason in result.
- Counts against caps use post-supersession pending set (expire first or count excluding rows being expired in-tx — implement consistently and test).

**Done when:** second package same target expires first; caps allow the new one; suggest_tasks does not expire peers.

---

### A6 — Attention pagination revert (mandatory)

**Files**
- `server/src/services/attention.ts`
- `server/src/routes/attention.ts` (may leave unused query parse if harmless)
- `server/src/__tests__/attention-service.test.ts` — remove/skip weak pagination assertions that encode broken behavior
- `packages/shared/src/types/attention.ts` — `nextCursor?` may stay optional

**Restore**
- Param-less list = full feed Stage 0 behavior (no default slice to 50).
- No interaction-only keyset that desyncs merged sources.
- `totalCount` / `countsBySourceKind` reflect full collected feed as before PR #4 pagination.

**Done when:** attention freeze tests pass; param-less response shape matches Stage 0 contract intent.

---

### A7 — Watchdog human-reserve (after A0)

**Files**
- `server/src/services/task-watchdogs.ts` (and any real resolve entry from A0)
- `server/src/routes/issues.ts` — **delete** dead agent human-reserve block after board-only denial
- Tests per branch A or B

**Helper (shared predicate only)**
```ts
export function isHumanReservedPlanConfirmation(payload: unknown): boolean {
  return isPackageBearingPayload(payload);
  // humanOnly is implied by package stamp; package-bearing is sufficient in Stage 1
}
```

**Branch A:** guard real auto-accept path; test package-bearing cannot be auto-accepted; non-package eligible still can if product allows.  
**Branch B:** eligibility + red fixture + doc note; no “S6 complete” claim.

**Done when:** dead route gone; A0 branch implemented; tests match claimed scope.

---

### A8 — UI minimum (confirmation)

**Files**
- `ui/src/components/IssueThreadInteractionCard.tsx`
- `ui/src/components/IssueThreadInteractionCard.test.tsx`

**Behavior**
- Read `interaction.payload.decisionPackage.reason` / `optionLabels`.
- Map labels onto existing accept/reject CTAs (presentation only; Q2).
- Keep existing amber token patterns; no new hex/raw px.
- Test: package reason visible; custom accept label used.

**Done when:** card tests green; `pnpm check:token-gates` clean.

---

### A9 — Docs + PR framing

**Files**
- `doc/design/COLLAB-EXTENSION-POINTS.md` §2 — nested `decisionPackage` on five schemas; update anchors
- Optional one-liner in `doc/DEVELOPING.md`: enable `enableHumanAgentCollab` for Stage 1 dogfood
- GitHub PR #4 body rewrite:
  - Not “Stage 1 complete”
  - Lists corrected core vs deferred (Track A, e2e V11, skills, full pagination reintro in PR-B)
  - Verification commands updated

**Done when:** extension-points match code; PR body honest.

---

## 7. PR-B and PR-C (outline only)

### PR-B
1. Attention pagination correct design:
   - Engage only when `limit` or `cursor` present
   - Merged multi-source keyset on `(activityAt DESC, id DESC)`
   - Cursor = `base64url(JSON.stringify([activityAtIso, itemId]))`
   - Invalid cursor → `422 ATTENTION_PAGE_INVALID`
   - Param-less remains full feed
2. Attention detail projection for package reason/options
3. Remaining interaction cards (ask / verdicts / checkbox)
4. Supersession polish if S-lite left gaps
5. `decideSuccessfulRunHandoff` skip test with pending package-bearing interaction

### PR-C
1. Track A outbox Phase 1+ producers for interaction resolve
2. Thin e2e structured handoff
3. Skills / OpenAPI / CLI

---

## 8. Issue → work mapping

| Review issue | Work |
|---|---|
| I1 schema | A1 |
| I2 predicate triple | A1 + A2 import |
| I3 S6 dead | A0 + A7 |
| I4 resolver | A4 (+ A2 create membership) |
| I5 caps | A5 |
| I6 pagination | A6 (revert), PR-B (correct) |
| I7 humanOnly partial | A2 |
| I8 flag | A2 |
| I9 supersession | A5b (+ PR-B polish) |
| I10 overclaim | A9 |
| I11 UI | A8 + PR-B |
| I12 bounds | A1 |
| I13 artifacts | A3 |
| I14 handoff | PR-B test |

### 8.1 P5.0 result (fill during A0)

```text
Status: DONE
Branch: B
Anchors:
  - server/src/routes/issues.ts rejectAgentIssueThreadInteractionResolution — all agents 403 board-only before any accept body
  - isHumanReservedPlanConfirmation only used from dead route branch (removed); no task-watchdogs auto-accept caller of acceptInteraction
  - capability string resolve_eligible_request_confirmation_plan_interactions is documentation-only in watchdog denied/allowed lists
Decision:
  - No real watchdog auto-accept path today. Keep isHumanReservedPlanConfirmation as eligibility helper keyed on nested decisionPackage; unit tests lock future path; delete dead route branch.
Date: 2026-07-13
```

---

## 9. Verification matrix

```sh
# A1
pnpm exec vitest run packages/shared/src/decision-package.test.ts
pnpm --filter @paperclipai/shared exec tsc --noEmit

# A2–A5b, A7
pnpm exec vitest run \
  server/src/__tests__/decision-package-create-routes.test.ts \
  server/src/__tests__/decision-package-artifact-routes.test.ts \
  server/src/__tests__/decision-package-resolver-routes.test.ts \
  server/src/__tests__/collab-invariants-routes.test.ts \
  server/src/__tests__/issue-thread-interaction-contract.test.ts \
  server/src/__tests__/attention-service.test.ts \
  server/src/__tests__/issues-responsible-inbox.test.ts \
  server/src/services/recovery/successful-run-handoff.test.ts

pnpm --filter @paperclipai/server exec tsc --noEmit

# A8
pnpm exec vitest run ui/src/components/IssueThreadInteractionCard.test.tsx \
  ui/src/components/IssueProperties.test.tsx \
  ui/src/components/IssueColumns.test.tsx
pnpm check:token-gates
```

### Final checklist before claiming PR-A done

- [ ] Nested `decisionPackage` only; no flat enrichment fields on create schemas
- [ ] Exactly one `isPackageBearingPayload` implementation (shared)
- [ ] Caps use SQL `jsonb_exists` + locks; planned error codes only
- [ ] No dead human-reserve block after agent denial
- [ ] Param-less attention matches Stage 0 full-feed intent
- [ ] Flag-off package create 403; plain create ok
- [ ] Resolver: named / board override / non-named deny tested
- [ ] S-lite supersession tested for at least request_confirmation
- [ ] UI confirmation reads nested package
- [ ] COLLAB-EXTENSION-POINTS §2 updated
- [ ] PR body does not claim Stage 1 GA / Track A complete
- [ ] §8.1 P5.0 filled

---

## 10. Risk register

| ID | Risk | Mitigation |
|---|---|---|
| K1 | Nested rewrite discards large flat diff | Small commits A1→A2 first; delete flat in A1 |
| K2 | Watchdog path missing | A0 branch B + honest S6 scope |
| K3 | Advisory lock on PGlite | Verify in tests; fallback documented |
| K4 | Flag default false hides feature | DEVELOPING one-liner |
| K5 | Review fatigue | Keep PR-A focused; PR-B separate |
| K6 | Cap vs supersession ordering bugs | Expire-in-tx then count; explicit test |
| K7 | Legacy flat dogfood rows | Document non-package-bearing; no migration |

---

## 11. Commit message templates (PR-A)

```text
fix(shared): nested decisionPackage schema + single isPackageBearingPayload
fix(server): flag-gated package create, humanOnly stamp, payload bound codes
feat(server): decision-package requiredArtifacts integrity + delete-in-use
feat(server): resolverPolicy board override + remove service double-gate
fix(server): serialize package-bearing caps with locks + plan error codes
feat(server): S-lite package supersession for confirmation-family kinds
fix(server): revert broken attention pagination to Stage 0 full feed
fix(server): watchdog human-reserve on real path; remove dead route branch
fix(ui): read nested decisionPackage on confirmation card
docs(design,pr): nested package in extension-points; reframe Stage 1 scope
```

---

## 12. Relationship to prior docs

| Document | Role |
|---|---|
| `doc/plans/2026-07-13-structured-decision-package.md` | Binding C1 implementation plan (field shapes, Q11, Q13, tasks) |
| `doc/plans/2026-07-13-collab-pre-code-decisions.md` | Ratified Q1–Q16 |
| `doc/design/COLLAB-EXTENSION-POINTS.md` | Same-PR change control for schema fields |
| `doc/plans/2026-07-12-continuation-outbox-and-immutable-provenance.md` | Track A — **not** executed here |
| This file | Remediation of PR #4 partial delivery; execution checklist for PR-A |

When this remediation conflicts with partial code on the branch, **this file + C1 plan win**. When this file and C1 plan conflict on field shape or error codes, **C1 plan wins** and this file should be amended in the same change set.

---

## 13. Approval

Plan review verdict: **conditionally approved** after incorporating B1–B4, R1, R4, and legacy flat policy.

Execution of product code requires normal repo process (implement on branch, verify, PR update). This document alone is not an execution approval for Track A or PR-C.
