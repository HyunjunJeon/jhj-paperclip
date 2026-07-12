# Transactional Continuation Outbox and Immutable Promotion Provenance

Date: 2026-07-12
Status: Proposed implementation plan
Preceding remediation: `95c8bdfb` (`fix(server): harden interaction and artifact governance`)

## 1. Purpose

Close the two residual findings left by the July 2026 interaction and artifact-governance security review:

1. Resolving an issue-thread interaction and scheduling its assignee continuation are separate commits. A process crash or wake-enqueue failure can leave a resolved interaction without a durable continuation path.
2. A promoted low-trust derivative points at a mutable source row. Editing or deleting the issue, comment, document, or work product after review can make the promotion provenance ambiguous or unverifiable.

The implementation must preserve Paperclip's control-plane invariants: company isolation, board-governed trust promotion, single-assignee execution, idempotent retries, activity logging, and strict quarantine of hostile raw content.

## 2. Review Trail and Why the Prior Patch Stopped Here

Commit `95c8bdfb` deliberately fixed the bounded authorization and replay defects without pretending to solve these architectural gaps:

- It made wake-enqueue failure observable and marked successful interaction wakes with `mutation: "interaction"`, but it could not atomically include the existing `heartbeat.wakeup()` flow in the interaction service transaction.
- It kept raw low-trust source trust as `quarantined` and created only a sanitized promoted derivative, but the existing source entities do not share an immutable revision model.

Trying to hide either gap with route-level retries would be incorrect. HTTP retries cannot recover a crash between commits, and a digest stored only on a mutable source row cannot preserve evidence after deletion. Both findings require new durable database contracts.

## 3. Scope and Non-Goals

### In scope

- A dedicated transactional outbox for resolved-interaction continuation intents.
- Multi-instance-safe claiming, retry, dead-letter handling, and observability.
- Stable logical wake idempotency across dispatcher crashes and HTTP replay.
- Immutable, content-addressed snapshots for all promotable source kinds: `issue`, `comment`, `document`, and `work_product`.
- A normalized promotion ledger linking the immutable snapshot to the sanitized promoted work product.
- Board-only inspection/redaction controls that never inject quarantined snapshot content into normal agent heartbeat context.
- Schema, migration, shared contracts, services, routes, activity records, and focused tests.

### Not in scope

- General-purpose event sourcing for all Paperclip mutations.
- Replacing every existing `agent_wakeup_requests` producer with the new outbox.
- Making low-trust raw content visible to higher-trust agents.
- Retroactively reconstructing source bytes that no longer exist.
- Changing company-wide visibility defaults for standard-trust work.
- Automatically promoting or re-promoting changed source content.

## 4. Cross-Cutting Invariants

1. **Atomic intent:** a transaction that first resolves an interaction requiring continuation must also insert exactly one durable continuation intent before it commits.
2. **No false failure response:** once resolution and intent commit, the HTTP route returns the resolved interaction; dispatcher availability does not change the resolution response.
3. **Stable identity:** each logical resolution transition has one stable outbox identity and one stable wake idempotency key.
4. **At-least-once dispatch, one logical wake:** workers may retry, but retries converge on the same `agent_wakeup_requests` record/run-coalescing decision.
5. **Current-state routing:** dispatch revalidates company, issue, interaction, status, continuation policy, and current assignee. Reassignment never wakes an agent from another company or a stale assignee silently.
6. **Quarantine:** canonical raw snapshot bytes and digest lookup keys are board-only quarantined data. Normal issue/work-product APIs, continuation summaries, wake payloads, logs, and activity details contain only opaque promotion IDs, bounded board-authored sanitized fields, and board-safe lifecycle state.
7. **Immutable evidence:** a promotion always identifies one immutable snapshot by UUID, canonicalization version, algorithm, and digest. Source-row mutation or deletion cannot change what was reviewed.
8. **Board governance:** creating a promotion and inspecting or redacting a raw snapshot are board-only actions and are activity logged.
9. **Company scope:** every outbox, snapshot, and promotion query includes `company_id`; foreign-key linkage alone is not treated as authorization.
10. **Fail closed:** unknown canonicalization versions, digest mismatches, malformed intents, and cross-company references are rejected or dead-lettered, never dispatched/promoted best-effort.

## 5. Track A — Transactional Interaction Continuation Outbox

### 5.1 Architecture decision

Add a dedicated `issue_thread_interaction_continuation_outbox` table rather than treating `agent_wakeup_requests` itself as the producer transaction's outbox.

`agent_wakeup_requests` represents a wake after heartbeat policy evaluation and is written in many terminal/skipped/coalesced branches. It is not currently a queue consumed from rows with `run_id IS NULL`, and inserting partially formed rows would overload its status model. The dedicated table owns only the gap between interaction resolution and heartbeat wake persistence.

### 5.2 Data model

Add `packages/db/src/schema/issue_thread_interaction_continuation_outbox.ts` with:

- `id uuid primary key defaultRandom()`
- `company_id uuid not null references companies(id)`
- `issue_id uuid not null` — retained audit identity, not a cascading foreign key
- `interaction_id uuid not null` — retained audit identity, not a cascading foreign key
- `event_key text not null`
- `event_kind text not null` — `resolution | item_verdicts`
- `interaction_status text not null`
- `resolution_operation text not null`
- `resolution_request_fingerprint bytea not null`
- `source_interaction_version bigint not null`
- `item_decision_commitments jsonb null` — item IDs plus versioned hashes only, never raw reasons
- `continuation_policy text not null`
- `payload_version integer not null default 1`
- `wake_payload jsonb not null` and `wake_context jsonb not null` — sanitized envelopes only
- `source text not null`
- `requested_by_actor_type text not null`, `requested_by_actor_id text null`
- `target_agent_id_at_commit uuid null` — retained audit identity, not an authorization source
- `status text not null default 'pending'` — `pending | claimed | retry_wait | dispatched | suppressed | dead_letter`
- `suppression_reason text null`
- `attempt_count integer not null default 0`, `max_attempts integer not null default 8`
- `next_attempt_at timestamptz null` — set to transaction `now()` for every new pending event
- `claim_token uuid null`, `claimed_by text null`, `claimed_at timestamptz null`, `lease_expires_at timestamptz null`
- `wakeup_request_id uuid null` — retained delivery identity; ordinary wake cleanup cannot null it
- `dispatched_agent_id uuid null` — retained audit identity
- `last_error_code text null`, `last_error text null`, `last_error_at timestamptz null`
- `created_at`, `updated_at`, `dispatched_at`, `terminal_at`

For final one-shot interactions, mirror nullable `resolution_operation` and `resolution_request_fingerprint` on `issue_thread_interactions`. For item-verdict interactions, every outbox event is the authoritative replay record; later batches never overwrite prior event fingerprints.

Add `continuation_event_version bigint not null default 0` to interactions. A database trigger increments it for every continuation-relevant status/result transition; the matching outbox event stores that returned version.

Compute and store the full 32-byte resolution fingerprint as `SHA256(UTF8("paperclip.interaction-resolution:v1\n") || RFC8785(envelope))`, where `envelope` is `{ version: 1, operation, resolver: { type, id }, request }`. The complete normalized request includes sorted `suggest_tasks.selectedClientKeys`, sorted checkbox IDs, answers sorted by question ID with existing answer normalization, trimmed rejection/cancellation reasons, accepted-plan target/revision, and item-verdict tuples sorted by item ID with trimmed reasons. Same fingerprint is replay; every mismatch is conflict.

Define each item commitment as `SHA256(UTF8("paperclip.item-verdict:v1\n") || RFC8785({ itemId, verdict, normalizedReason, resolverType, resolverId }))`. The dispatcher recomputes commitments from persisted interaction results; wake context carries item IDs, not reasons or hashes.

Constraints and indexes:

- unique `(company_id, event_key)`
- partial due-work index `(next_attempt_at, created_at, id)` for `pending`/`retry_wait`
- partial stale-lease index `(lease_expires_at, id)` for `claimed`
- `(company_id, issue_id, created_at)` and `(interaction_id, created_at)`
- unique partial `wakeup_request_id` when non-null
- CHECK: `next_attempt_at` is non-null for `pending`/`retry_wait`, null for `claimed` and terminal states
- expired `claimed` rows are claimable only by `lease_expires_at <= now()`, independently of `next_attempt_at`
- checks for valid status/claim/terminal field combinations and non-negative attempts

Event keys are deterministic:

- one-shot final resolution: `resolution:v1:<interaction-id>`
- item-verdict event: `verdicts:v1:<interaction-id>:<full-normalized-request-fingerprint>`
- heartbeat bridge: `interaction-continuation:v1:<outbox-id>`

Do not use a wall-clock bucket. Reserve the bridge prefix and add a prefix-scoped partial unique index on `agent_wakeup_requests(company_id, idempotency_key)` so unrelated legacy wake keys are unaffected.

### 5.3 Producer transaction

Refactor every resolution family in `server/src/services/issue-thread-interactions.ts` to use one top-level transaction:

1. Lock the company-scoped issue row first and interaction row second with `FOR UPDATE` in every path.
2. Validate kind, pending/current result state, target revision, actor authority inputs, workspace-finalization state, and exact replay semantics.
3. Perform all related mutations inside the transaction: interaction/result update, accepted-confirmation reassignment, suggested-task creation, issue touch, and item verdict writes.
4. For a new resolution, store `resolution_operation` and the normalized request fingerprint.
5. Insert the existing resolution activity row with a transaction-safe activity writer. It returns live/plugin event payloads for publication only after commit; it must not publish before commit.
6. Insert exactly one pending continuation event when policy can wake. Insert an explicit `suppressed` event for policy-none, non-accepted `wake_assignee_on_accept`, expired interaction, terminal issue, or no agent assignee. This makes the no-wake decision durable and inspectable.
7. Return `{ interaction, replayed, continuationIntentId, createdIssues }`; an exact suggested-task replay returns no newly created issues.

All resolution families use this path: accept, reject, answer, item verdicts, and cancel. Partial item-verdict submissions create an event only when `newlyResolvedItemIds` is non-empty. Their sanitized envelope contains item IDs and bounded structured decision state, not raw quarantined bodies.

The strict versioned outbox envelope has a 64 KiB encoded limit and includes only issue/interaction IDs and state, accepted-plan target/revision plus `forceFreshSession`/workspace-refresh reason, checkbox selection IDs, and newly resolved verdict IDs. It excludes free-form source/result text. Oversize envelopes fail the entire producer transaction.

Exact HTTP replay behavior:

- Equivalent operation/fingerprint: return the stored interaction and intent identity with `200`; do not repeat tasks, activity, outbox rows, assignment wakes, or revisions.
- Contradictory operation/payload: return `409`.
- Equivalent replay after dispatcher failure: return success and issue only a best-effort dispatcher kick; correctness never depends on the client retry or kick.

Item-verdict replay first looks up the full request fingerprint across all events for that interaction, so replay remains identifiable after later batches. A mixed request records commitments for both previously equivalent and newly decided items while only newly resolved IDs enter wake context. Any resolver/verdict/reason mismatch returns `409`.

Partial verdict events are monotonic. A later aggregate interaction result does not invalidate an older pending event when that event's recorded item decisions remain present with matching commitments. The dispatcher claims only the lowest unfinished source interaction version, preserving order across rapid partial submissions and final completion.

Remove correctness-critical calls to `queueResolvedInteractionContinuationWakeup()` and route-side resolution activity writes after all producers are transactional. Routes may trigger a non-blocking targeted dispatch kick after commit, then return the committed result. A fast-dispatch failure must not convert a committed resolution into HTTP `500`.

### 5.4 Dispatcher and multi-instance claim protocol

Add `server/src/services/interaction-continuation-dispatcher.ts` with bounded `tick()` and targeted `kick(id)` entry points:

1. Claim at most 50 due rows using `FOR UPDATE SKIP LOCKED`, including expired `claimed` leases.
2. Set status `claimed`, increment attempts, and assign a random `claim_token`, worker ID, claim time, and 60-second lease.
3. Process outside the claim transaction with concurrency 8; renew leases every 20 seconds.
4. Re-read outbox, interaction, company, issue, and current assignee with company predicates.
5. Use claim-token compare-and-set for every retry/terminal transition so a stale worker cannot complete a reclaimed row.
6. Mark `suppressed` when the issue is closed/deleted, human-assigned/unassigned, company inactive, or policy returns `permanent_skip` before any reserved wake receipt exists.
7. If reassigned, target only the current same-company agent and record commit/current targets. Revalidate current assignment again inside heartbeat's issue-row-locked enqueue transaction.
8. Call the heartbeat idempotent bridge with the stable key and `mutation: "interaction"` in payload/context.
9. Mark `dispatched` with the durable wake request/run linkage. Use the same transaction-safe activity insert and publish live/plugin events only after commit.

Retry only failures for which no durable heartbeat receipt exists. Use attempts 1–7 with delays `5s, 30s, 2m, 10m, 30m, 2h, 6h` plus deterministic ±20% jitter; attempt 8 becomes `dead_letter`. Bound and redact stored error text to 2,000 characters.

Start polling through the existing heartbeat scheduler lifecycle: startup recovery after queued-run resumption and periodic ticks thereafter. Shutdown stops new claims, waits at most 30 seconds for in-flight dispatches, then exits and leaves unfinished leases to expire.

### 5.5 Heartbeat idempotency and lossless coalescing

Add a dedicated structured heartbeat entry point returning `{ outcome, requestId, runId, reason }`, where outcome is `queued | coalesced | deferred | permanent_skip | retryable_rejection`. Preserve public `wakeup()` compatibility for unrelated callers.

For reserved interaction-continuation keys:

- Inside the existing issue-row-locked enqueue transaction, revalidate company, issue, interaction identity, current assignee, and expected assignee before consuming the key.
- Only `queued`, `coalesced`, or `deferred` outcomes insert/consume the reserved unique key and count as delivered.
- Closed/unassigned/policy-invalid state returns `permanent_skip`.
- Budget, pause, scheduling suppression, invokability, and infrastructure failures return `retryable_rejection` without inserting a namespaced skipped row.
- Existing-key lookup validates company/issue/interaction identity and classifies stored status; it never treats every existing row as successful delivery.
- When accepted dispatchers race, catch only the named unique constraint and reload the winning company-scoped receipt.
- Keep one inspectable receipt per outbox event even if several events share a run.

Add immutable reserved-receipt fields to `agent_wakeup_requests`: `interaction_continuation_outbox_id` and `interaction_continuation_accepted_outcome` (`queued | coalesced | deferred`). They are set only when the bridge accepts the event.

Existing-receipt mapping after dispatcher crash:

- A valid reserved receipt with immutable accepted outcome remains `dispatched` even when mutable request/run state later becomes running, completed, failed, or cancelled.
- `deferred` remains `dispatched` and follows the normal deferred recovery path.
- A reserved-key row with skipped status, missing accepted marker, mismatched company/issue/interaction/outbox identity, or impossible outcome is an invariant violation and dead-letters the outbox event; it is never treated as suppression or delivery.
- `permanent_skip` and `retryable_rejection` create no reserved-key row.

This closes the crash window where heartbeat persistence commits but the dispatcher dies before marking the outbox row dispatched.

Replace overwrite-prone scalar coalescing with a versioned `interactionContinuationEvents` array keyed by event key. Update interaction-context normalization/classification/merge helpers to deduplicate events and union newly resolved item IDs. Keep newest scalar fields only for compatibility.

Bounds:

- maximum 64 events
- maximum 64 KiB encoded interaction continuation context
- if a merge would exceed either bound, queue a follow-up request instead of truncating evidence
- preserve `forceFreshSession` and accepted-plan workspace refresh if any merged event requires them

Queued-run claim and final pre-adapter checks must revalidate current issue assignment. The existing broad interaction-wake exemption must not allow a stale assignee to execute after reassignment.

Integrate `reconcileStrandedAssignedIssues()` with the outbox contract:

- pending/claimed/retry rows suppress the legacy differently keyed recovery wake
- dispatched rows defer to their linked wake/run recovery path
- suppressed/dead-letter rows create board-visible recovery/escalation, not another continuation wake
- only pre-activation legacy interactions without an outbox retain the old backstop

Add a recovery-versus-dispatch race test.

### 5.6 Failure semantics and observability

- Crash after resolution commit: pending intent remains claimable.
- Crash after claim: lease expiry makes it claimable.
- Crash after heartbeat commit: the reserved unique key returns the existing receipt.
- Permanent state/policy mismatch: `suppressed`, never retried.
- Transient database/heartbeat failure without receipt: retry with bounded backoff.
- Exhausted retries or malformed sanitized payload: `dead_letter`.
- Delivery, suppression, and dead-letter each produce exactly one content-free activity row from the terminal state transaction.

Add metrics for created, claimed, reclaimed, retried, dispatched, coalesced, suppressed, and dead-lettered events; due/claimed depth; oldest due age; and commit-to-dispatch latency. Logs and activity include IDs, attempts, and stable reason codes only.

Add board-only keyset-paginated `GET /api/companies/:companyId/interaction-continuations?status=&cursor=&limit=`. It returns IDs, state, attempts, timestamps, and stable reason codes; it never returns raw errors or wake payload internals to agents.

### 5.7 Migration, reconciliation, and deployment

1. Add schema/export and generate the next migration (currently expected to follow `0145`).
2. Create the outbox table, replay metadata columns, constraints/indexes, and reserved wake-key partial unique index.
3. Deploy an expand/activate barrier: apply schema; deploy a dual-mode binary with new writers/dispatcher dormant and old synchronous behavior retained; verify every writer instance runs that binary; drain/restart old writers; run reconciliation; then atomically set a database-backed activation timestamp and enable outbox-required writes plus polling.

Activation is database enforced, not advisory:

- An `INITIALLY DEFERRED` constraint trigger checks at commit that every activated continuation-relevant interaction version has a same-company outbox row with matching `source_interaction_version`.
- A second deferred trigger rejects any newly inserted work product whose trust disposition is promoted unless it has a valid same-company `promotion_id`, matching promotion projection, and complete promotion graph.
- Old binaries therefore fail their transaction after activation instead of silently bypassing the invariant.
- Reconciliation runs before activation. There is no ordinary application bypass after activation. Migration/legal-purge exceptions are exposed only through named `SECURITY DEFINER` procedures with execute privilege withheld from request-serving application roles and covered by negative authorization tests.
4. Reconcile only interactions resolved during the prior 24 hours that lack an event. Link a matching existing wake when provable; create pending only when no wake exists and the current issue remains actionable; otherwise create a suppressed record.
5. Final resolutions use the deterministic final key. For item verdicts, group result items by identical resolution time and hash sorted IDs.
6. Never auto-wake resolutions older than 24 hours. Count them as `legacy_unverifiable` for manual review instead of guessing.
7. Unique event keys make concurrent reconcilers converge.
8. After activation, an old writer is not allowed to coexist because it can resolve without an outbox. Remove the synchronous fallback only in a later release after activation is stable.

## 6. Track B — Immutable Low-Trust Promotion Provenance

### 6.1 Architecture decision

Use a two-step board workflow and normalized append-only storage:

1. **Capture:** freeze the exact reviewed source revision into company-scoped quarantine and return an opaque snapshot ID.
2. **Promote:** promote that snapshot ID with board-authored sanitized title/summary and a sanitization-attestation version.

Add:

- `low_trust_source_snapshots`: immutable content descriptor and digest.
- `low_trust_snapshot_payloads`: one-to-one quarantined canonical bytes, separately redactable and never joined by ordinary reads.
- `low_trust_snapshot_objects`: immutable company-scoped copies/manifests for attachment or provider bytes.
- `low_trust_output_promotions`: append-only board decision linking snapshot to sanitized work-product projection.
- `low_trust_promotion_events`: append-only revocation, replacement, and redaction history.

Do not put raw canonical content, raw artifact paths/URLs, or digest lookup keys in general work-product metadata or source-trust responses. A promoted work product exposes only an opaque `promotionId`, board-authored sanitized fields, and board-safe lifecycle state. Digest/details remain board-only to avoid cross-context disclosure and confirmation-oracle behavior.

### 6.2 Snapshot and promotion data model

Add `packages/db/src/schema/low_trust_source_snapshots.ts`:

- `id uuid primary key defaultRandom()`
- `company_id uuid not null references companies(id)`
- retained origin IDs: `target_issue_id`, `source_issue_id`, `source_kind`, `source_artifact_id`
- source revision identity/number and source actor/run/timestamps
- `source_revision_key text not null`
- strict immutable `source_trust_descriptor jsonb not null` containing preset, disposition, source issue/run/agent IDs, and trust-policy version
- `schema_version integer not null`
- `canonicalization text not null` — initially `jcs`
- `hash_algorithm text not null` — initially `sha256`
- `content_hash bytea not null` — exactly 32 bytes
- `canonical_byte_size bigint not null`
- `artifact_manifest jsonb null`
- `captured_by_user_id text not null`
- `captured_at timestamptz not null`
- lifecycle status

Origin IDs are retained values, not cascading foreign keys to mutable source/target rows. Source or target deletion must not erase historical evidence.

Revision keys are kind specific: document revision UUID; for mutable issue/comment/work-product rows, `SHA256("paperclip.source-revision:v1\n" || RFC8785({ rowId, contentUpdatedAt, contentHash }))`.

Give every retained parent table unique `(company_id, id)` identity so all child links can use composite same-company foreign keys.

Add `low_trust_snapshot_payloads` with composite primary key `(company_id, snapshot_id)`, same-company snapshot FK, immutable `canonical_payload bytea`, and creation time. Keeping exact canonical bytes avoids reserialization drift and isolates raw content from ordinary DTO/query paths.

Add `low_trust_snapshot_objects` with unique `(company_id, id)`, same-company snapshot FK, ordinal, quarantine object key, media type, byte size, SHA-256, immutable provider revision, and deletion progress. Enforce unique `(company_id, snapshot_id, ordinal)` and `(company_id, object_key)`. Object keys are company namespaced; content-addressed reuse is company-local only.

Snapshot constraints/indexes:

- valid source kind/algorithm/canonicalization/version
- 32-byte SHA-256 check
- unique exact revision/content identity within `(company_id, target_issue_id, source_kind, source_artifact_id, source_revision_key, schema_version, canonicalization, hash_algorithm, content_hash)`
- no global digest uniqueness or cross-company deduplication
- company/target/capture index

Add `low_trust_output_promotions`:

- unique `(company_id, id)` plus unique `(company_id, target_issue_id, snapshot_id, id)`
- non-null `snapshot_id` with same-company composite snapshot FK
- promoter principal and promotion time
- sanitization-attestation version
- versioned digest of the complete sanitized derivative envelope: `{ title, summary, type, provider, status, reviewState, promotionId, snapshotId, attestationVersion }`
- immutable `replaces_promotion_id` constrained by full composite FK `(company_id, target_issue_id, snapshot_id, replaces_promotion_id)`
- verification state fixed to `verified`
- unique `(company_id, target_issue_id, snapshot_id, sanitized_derivative_digest)` for exact replay
- unique successor per `replaces_promotion_id`

Add `low_trust_promotion_heads` keyed by `(company_id, target_issue_id, snapshot_id)`, with latest/active promotion IDs referencing the full promotion composite key and a monotonic version counter. Direct head UPDATE is revoked from request roles. A guarded database function locks the head and performs compare-and-set initial/revoke/replace transitions; it supplies one active head while preserving immutable historical replacements.

Add `low_trust_promotion_events` with unique `(company_id, idempotency_key)`, `event_kind`, `promotion_id`, `snapshot_id`, optional successor promotion ID, actor, mandatory reason, and timestamp. Full composite FKs enforce the same company, target issue, and snapshot across event, promotion, predecessor, successor, and head. CHECK/unique constraints require:

- `revoked`/`replaced` target a promotion
- `redacted`/`expired` target a snapshot
- one revocation per promotion
- one successor/replacement per predecessor
- at most one content-unavailable event (`redacted` or `expired`) per snapshot

Add nullable `promotion_id` to `issue_work_products` with composite `(company_id, promotion_id)` FK and unique projection per promotion. New sanitized projections reference the ledger row; `externalId`, JSON `metadata.promotion`, and mutable source UUIDs cease being authoritative.

Add separate `low_trust_legacy_promotion_classifications` keyed by same-company promoted work-product ID. It records `legacy_unverified` classification and backfill evidence/checkpoint metadata without pretending a snapshot-backed promotion exists.

### 6.3 Canonicalization, hashing, and binary capture

Create `server/src/services/low-trust-provenance.ts` with one exhaustive versioned canonicalizer.

Canonicalization v1:

- RFC 8785/JCS over `{ schema: "paperclip.low-trust-source", version: 1, kind, content }`
- explicit nullable fields
- UTF-8 exactly as stored
- no trimming, Unicode normalization, newline normalization, locale formatting, or insertion-order JSON
- preserve array order; sort object keys per JCS

Reject non-I-JSON/non-finite or unsupported numeric values and validate against official RFC 8785 vectors. The first release limit is exactly 1 MiB of canonical UTF-8 payload bytes; oversize capture returns `422` before inserting descriptor or payload rows.

Hash:

`SHA256(UTF8("paperclip.low-trust-source:v1\n") || canonicalBytes)`

Store full digest bytes, algorithm, and canonicalization version. Maintain golden canonical-byte/digest vectors and fail closed for unknown versions.

Hashed content by kind:

- `issue`: exact `{ title, description }`
- `comment`: exact `{ body, presentation, metadata }`; treat comments as mutable at storage/import boundaries
- `document`: exact `{ key, title, format, body, changeSummary }` from one pinned `document_revision.id` and revision number
- `work_product`: exact `{ type, provider, externalId, title, url, status, reviewState, isPrimary, healthStatus, summary, metadata, artifact }`

`artifact` is exactly `null` or `{ schema: "paperclip.snapshot-artifact.v1", objects: [...] }`. Objects are sorted by ordinal and contain only `{ ordinal, attachmentId, assetId, mediaType, byteSize, sha256, providerRevision }`, with absent identities represented as explicit `null`. Mutable live object keys, filesystem paths, download URLs, and unsigned provider IDs are excluded.

Origin IDs, actor/run attribution, and timestamps are immutable descriptor fields outside hashed content. The snapshot ID plus descriptor and digest identifies what was reviewed even if the live row disappears.

For Paperclip-managed artifacts, stream bytes into immutable company-scoped quarantine storage, compute SHA-256/size while streaming, and record the quarantine object manifest. Do not embed large bytes in JSON and do not rely only on a mutable storage key. Failed or mismatched capture produces no valid snapshot and orphaned temporary objects are garbage-collected.

For external artifacts, require a reviewed adapter that provides verifiable bytes/digest and immutable provider revision. Until available, reject capture/promotion with `422`; never fetch arbitrary URLs server-side or hash a URL/provider ID as proof of content.

### 6.4 Board capture and promotion transactions

#### Capture

Add a board-only capture service/endpoint. In one transaction:

1. Lock target issue first, then the company-scoped source row and exact document revision/attachment metadata.
2. Under the same locks, revalidate company and exact topology: issue sources are the target or an in-company descendant; comments/documents/work products belong to the target issue; attachments belong to the captured work product, issue, and company; document capture pins the current exact revision; deleted/tombstoned sources are ineligible.
   Capture additionally requires `preset = low_trust_review`, `disposition = quarantined`, and the supported trust-policy version; the immutable board-only descriptor preserves that authorization evidence after live-source deletion.
3. Canonicalize exact source fields without logging them.
4. For managed binary artifacts, finalize the immutable quarantine object and verify declared size/digest.
5. Insert or return the unique immutable snapshot.
6. Insert capture activity with the transaction-safe writer and publish live/plugin events only after commit.

The board inspects the snapshot through a board-only no-store endpoint. Promotion never silently recaptures the current live row, preventing a time-of-check/time-of-use switch between review and approval.

The existing preflight lookup may provide diagnostics only; it never authorizes capture or promotion.

#### Promote

Change `POST /issues/:id/low-trust/promotions` to require `sourceSnapshotId`, sanitized `title`, sanitized `summary`, and sanitization-attestation version. Replacement additionally requires `replacesPromotionId` and mandatory revocation/replacement reason.

In one transaction:

1. Lock target issue, snapshot, and `(companyId, targetIssueId, snapshotId)` promotion head in the standard issue-before-artifact order.
2. Load the snapshot, verify canonical/artifact integrity, and reject any snapshot with a content-unavailable event or pending/claimed/retry/completed deletion job.
3. If the active head's sanitized digest matches, return its promotion/projection as exact replay.
4. If sanitized fields differ, require `replacesPromotionId` to equal the locked latest head. Append revocation/replacement events, insert the new immutable promotion/projection with predecessor link, and update latest/active head atomically.
5. If no head exists, insert initial promotion, projection, and head.
6. Insert all content-free lifecycle activity rows with the transaction-safe writer and publish live/plugin events only after commit.

Repeated identical promotion returns the same promotion/work-product with a replay marker and no duplicate activity. Changed sanitized fields without the exact locked predecessor return `409`. The same snapshot may have multiple immutable historical replacement promotions but only one active head.

The stored sanitized-derivative digest covers every projected field and provenance ID. Generic PATCH/DELETE/demotion remains rejected for every historical projection regardless of active, revoked, or replaced state; correction always creates a new promotion/projection.

The raw live source remains `quarantined`; promotion never rewrites it to `promoted`.

### 6.5 Mutation, deletion, verification, retention, and redaction

Live source behavior:

- Issue/comment/document/work-product sources may continue normal authorized edits, revisions, tombstones, and deletion.
- Those changes never rewrite the immutable snapshot or sanitized derivative.
- Board provenance views compare current content when available and report `unchanged | changed | deleted | unavailable`; they never repair a snapshot from live data.
- Capture after deletion returns `404`; snapshots captured before deletion remain board-inspectable.

Promotion-backed projection behavior:

- Generic work-product PATCH/DELETE rejects any row with `promotionId`, including board callers.
- Generic `isPrimary` replacement cannot implicitly demote a promotion-backed row.
- Explicit board-only revoke/replace routes append lifecycle events. Replacement creates a new promotion/projection linked to its predecessor; it never overwrites history.

Existing mutation-path decisions under source-row locks:

- issue PATCH may change live source text; ordinary issue hard-delete returns `409` whenever any promotion-backed projection/history exists, regardless of active/revoked/replaced state
- comment tombstone/hard-delete may proceed after snapshot capture because evidence is independent
- document upsert/restore/delete may proceed after snapshot capture because the pinned canonical payload is independent
- source work-product PATCH/DELETE and backing attachment delete may proceed only when they do not target the promotion-backed derivative or quarantine object
- promotion-backed work-product PATCH/DELETE and implicit primary demotion always reject

Verification:

- Read-after-capture verification recomputes canonical/artifact digests.
- Board/manual and bounded periodic verification return `verified | mismatch | missing | redacted | unsupported`.
- Unknown algorithm/version and digest mismatch fail closed; verification never falls back to current live content.
- Logs/activity contain IDs, algorithm/version, lifecycle outcome, and reason codes only.

Retention/redaction uses a durable content-deletion workflow, not silent row/object deletion.

Add `low_trust_snapshot_content_deletion_jobs` with same-company snapshot/event links, reason `redacted | expired`, status `pending | claimed | retry_wait | completed | dead_letter`, attempt/backoff fields, claim token/owner/lease, per-object progress, last error, and timestamps. Enforce one job/content-unavailable event per snapshot.

Board redaction and automatic seven-day expiry of unpromoted snapshots use the same transaction:

1. Lock snapshot and re-read promotion head/history.
2. For automatic expiry, proceed only when no promotion history exists; promotion and expiry serialize on the same snapshot/head lock. Board redaction is the only path that may redact promoted evidence.
3. Insert-or-load the unique content-unavailable event (`redacted` or `expired`).
4. Insert-or-load the fenced deletion job.
5. Immediately make raw content endpoints return lifecycle state instead of bytes.
6. Insert content-free activity transactionally and publish after commit.

The deletion worker claims with `FOR UPDATE SKIP LOCKED` and token fencing, deletes quarantine objects idempotently, records and verifies each object deletion, then invokes a guarded database function that removes the payload row and marks the job complete only when every object is confirmed deleted. Crash at any boundary retries; bytes remaining after logical redaction are inaccessible and visible as pending physical deletion. Dead-letter is board visible.

Promoted snapshot descriptors/digests and all promotion history remain retained after content deletion. Company erasure/legal purge is the only hard purge of descriptors/history and uses the documented privileged order.

Database immutability triggers reject ordinary UPDATE/DELETE on descriptors, promotions, and lifecycle events. Direct head UPDATE is denied except through the version-CAS head-transition function. Payload/object rows reject direct deletion outside the claim-token-validated deletion function. Only the explicit privileged company/legal purge procedure can bypass history guards.

### 6.6 Read and context isolation

- `POST /api/issues/:id/low-trust/snapshots` captures an exact source revision for board review.
- `GET /api/issues/:id/low-trust/snapshots/:snapshotId` returns board-safe descriptor/verification metadata.
- `GET /api/issues/:id/low-trust/snapshots/:snapshotId/content` returns raw canonical bytes to board users only with `Cache-Control: no-store`; a content-free access activity row must commit before bytes are streamed.
- `GET /api/issues/:id/low-trust/snapshots/:snapshotId/objects/:ordinal/content` streams the exact immutable quarantined binary object to board users only with `Cache-Control: no-store`; its content-free access audit must commit before streaming.
- `POST /api/issues/:id/low-trust/promotions/:promotionId/revoke` and `POST /api/issues/:id/low-trust/snapshots/:snapshotId/redact` require board authority, mandatory reason, and idempotent terminal behavior.
- Replacement uses a new promotion request with `replacesPromotionId`; it never mutates the predecessor.
- Ordinary agent/shared DTOs expose opaque promotion identity and board-safe lifecycle only, not snapshot digest, object key, canonical payload, arbitrary URL, or hostile metadata.
- `heartbeat-context`, continuation/recovery summaries, work-product lists, activity details, logs, and errors never dereference snapshot payload/object data.
- Sentinel tests place hostile/secret-shaped values in every text field, nested metadata value, filename, URL, document change summary, and artifact body; only the explicit board content endpoint may return them.
- Digest lookup/deduplication is company scoped and board only.

### 6.7 Provenance migration and backfill

1. Add schemas/exports/shared contracts and generate the next available migration.
2. Add additive provenance tables, nullable `issue_work_products.promotionId`, a company-scoped backfill-job/checkpoint table, and a database-backed provenance activation timestamp.
3. Ship service protection for both new `promotionId` and legacy `sourceTrust.disposition = promoted` while provenance capture/promotion remains dormant.
4. The backfill command claims one company-scoped job with lease/fencing, supports dry-run, and advances a durable keyset cursor `(created_at, id)` in fixed batches. Concurrent workers cannot process the same lease generation.
5. Classify every existing promoted work product in `low_trust_legacy_promotion_classifications`; do not create a promotion ledger row or set `promotionId` without independent immutable historical evidence.
6. Never hash current live content and claim it was historically reviewed. Mutable historical rows are `legacy_unverified`, not `verified` or guessed `source-mutated`.
7. Offer explicit board re-review: capture the current source and create a new verified promotion while retaining the legacy classification.
8. Record retryable row failures by ID and error code, use idempotent upserts, and never use `OFFSET` or unbounded updates.
9. After all writer instances run the dual-mode binary and classification is complete, atomically activate snapshot-required writes. Old writers may not coexist after activation.
10. Remove JSON pointer authority and the temporary legacy parser only in a later cleanup release.

## 7. Shared Contract Changes

Add strict shared types/validators for:

- opaque promotion references and board-safe lifecycle
- snapshot/promotion verification states
- outbox states and diagnostics
- a narrowly bounded legacy promoted variant

New promoted `SourceTrustMetadata` references opaque `promotionId`; it does not expose raw payload, digest, or object location through general issue/work-product types. Unknown fields and malformed algorithm/version/state combinations are rejected. Remove the legacy variant only after backfill and rolling-deployment compatibility are complete.

## 8. Implementation Sequence and Commit Boundaries

All implementation may land as reviewable commits, but new behavior remains dormant behind database-backed activation settings until each complete activatable slice is present. No intermediate commit may remove the old synchronous path or enable snapshot-required promotion by itself.

### Phase 1 — Additive schema, contracts, and transaction-safe activity primitive

Files:

- `packages/db/src/schema/issue_thread_interactions.ts`
- new outbox/snapshot/payload/object/promotion/event/classification/job schema files
- `packages/db/src/schema/agent_wakeup_requests.ts`
- `packages/db/src/schema/issue_work_products.ts`
- `packages/db/src/schema/index.ts`
- `packages/shared/src/trust-policy.ts`
- `packages/shared/src/validators/trust-policy.ts`
- `server/src/services/activity-log.ts`
- generated migration SQL and migration journal

Add `insertActivityInTransaction()` plus post-commit `publishCommittedActivityEvents()` so decision/audit rows can be atomic without publishing live/plugin events before commit.

Acceptance: additive migration is safe with old code, activation defaults off, retained audit identities cannot cascade/null, and no current behavior changes.

### Phase 2 — Complete outbox activatable slice

Land together behind the outbox activation setting:

- transactional producers and exact replay in `server/src/services/issue-thread-interactions.ts`
- route compatibility and non-blocking kicks in `server/src/routes/issues.ts`
- dispatcher service, heartbeat reserved-key bridge, lossless coalescing, and reassignment gates
- recovery integration in `reconcileStrandedAssignedIssues()`
- startup polling, bounded shutdown, diagnostics route, metrics, reconciliation, and all fault/concurrency tests

Acceptance: with activation off, old synchronous behavior remains. After all writer instances are dual-mode and activation flips, every new resolution has atomic activity plus pending/suppressed intent, and all crash/replay/recovery/multi-instance tests pass before the old path can be removed.

### Phase 3 — Complete provenance activatable slice

Land together behind the provenance activation setting:

- canonicalizer, quarantine payload/object capture, and official vectors
- board capture/metadata/content/promote/revoke/replace/redact endpoints
- verified snapshot-backed promotion ledger and full sanitized-derivative digest
- generic promoted-projection PATCH/DELETE/primary-demotion guards
- issue hard-delete protection whenever any promotion-backed projection/history exists, regardless of active, revoked, or replaced state
- verification, retention, privileged purge, access audit, and sentinel non-disclosure tests
- low-trust route/work-product/shared contract updates

Acceptance: with activation off, legacy protection remains. After activation, every new promotion is snapshot backed, live source changes cannot rewrite evidence, promoted projections are append-only, and raw/digest data is absent from higher-trust context.

### Phase 4 — Reconciliation, backfill classification, activation, and cleanup

- Reconcile the bounded 24-hour interaction gap before enabling outbox polling.
- Run provenance classification dry-run, then leased keyset batches.
- Verify every writer instance is dual-mode; old writers may not coexist after activation.
- Atomically set activation timestamps and monitor queue age, dead letters, capture failures, and legacy counts.
- Remove synchronous/pointer fallbacks only in a later cleanup release after stable operation.
- Update `doc/SPEC-implementation.md`, `doc/plans/2026-06-03-low-trust-review-contract.md`, operational migration/rollback guidance, and API docs.

Each commit body must record the reviewed finding, invariant established, activation state, rejected shortcuts, migration/rollback effects, and exact verification evidence.

## 9. Required Tests

### Outbox

- Resolution and outbox insert commit or roll back together.
- Crash/failure immediately after resolution commit still leaves a claimable intent.
- Equivalent HTTP replay produces no extra activity/outbox row; contradictory replay remains `409`.
- Partial item verdicts create intents only for newly resolved item IDs.
- Two dispatcher instances cannot concurrently own one unexpired lease.
- Expired leases recover after dispatcher crash.
- Crash after heartbeat persistence returns the existing wake request on retry.
- Wake coalescing preserves inspectable logical delivery linkage.
- Closed issue, missing assignee, expired interaction, inactive company, and policy mismatch become explicit `suppressed` outcomes.
- Reassignment routes to the current same-company assignee and records the change.
- Retry schedule, dead-letter threshold, error redaction, and activity logs are deterministic.
- Lease-reclaim fencing proves a stale claim token cannot renew or complete after a new worker claims.
- Reassignment between dispatcher read and heartbeat's issue lock cannot queue the stale agent.
- Every structured heartbeat outcome and existing-key status is classified as delivered, suppressed, or retryable exactly as specified.
- Legacy recovery racing outbox dispatch produces one logical wake.
- Two rapid partial-verdict batches dispatch in order and remain valid after aggregate completion.
- Resolution/activity/outbox rollback is atomic, and live/plugin activity publishes only after commit.
- Activation permits no old writer after the barrier; dormant mode retains synchronous compatibility.
- Multiple item-verdict request fingerprints remain replayable after later batches; mixed old/new batches validate per-item commitments and preserve ordering.
- A database-trigger test proves an old-style terminal interaction update without matching outbox fails after activation.
- Different `suggest_tasks.selectedClientKeys` from the same resolver produce different fingerprints and `409`; official resolution-fingerprint vectors pin exact bytes/digests.
- Newly committed pending intents are immediately due, retry-wait timestamps gate claims, and expired leases are reclaimed independently.

### Provenance

- Each source kind yields identical digest for semantically identical canonical input and a different digest for every reviewed-content change.
- Object key order does not affect digest; array order and content do.
- Document promotion binds the exact revision, not whichever revision is latest later.
- Attachment-backed work product includes immutable stored digest/version metadata without copying bytes into the promoted derivative.
- Source mutation/deletion after capture does not alter snapshot digest or promoted linkage.
- Authorized live-source mutation/deletion leaves the snapshot and promoted projection unchanged; generic mutation of the promoted projection is denied for agents and board users.
- Duplicate/concurrent identical promotion yields one snapshot, one ledger row, one derivative, and the same returned IDs; changed sanitized payload returns `409`.
- Cross-company source/snapshot/promotion references are rejected.
- Digest mismatch or unknown canonicalization version fails closed.
- Raw prompt-injection/secret-shaped snapshot content is absent from agent APIs, heartbeat context, continuation summaries, logs, and activity details.
- Redaction is one-way, board-only, reason-required, and preserves digest/ledger history.
- Legacy backfill is bounded, resumable, and classifies missing/ambiguous sources without fabricating evidence.
- Official RFC 8785 vectors pass; non-I-JSON numbers and payloads over 1 MiB return `422` without rows.
- Authoritative descendant/linkage and deletion races cannot capture a mixed or unauthorized source.
- Issue hard-delete cannot cascade an active promoted projection; source/run/agent cleanup cannot null retained provenance IDs.
- Database triggers reject direct mutation/deletion of descriptors, promotions, events, payloads, and objects outside governed functions.
- Every actor is denied generic PATCH/DELETE/implicit demotion of the complete promoted derivative.
- Raw-content access is audited before streaming and uses `no-store`.
- Legacy classification never upgrades current mutable content to verified, and concurrent backfill workers respect lease fencing.
- Composite same-company FKs reject malformed snapshot/payload/object/promotion/event/projection graphs.
- Same-snapshot replacement locks the head, permits one successor, replays identical active payload, and rejects stale predecessor races.
- Issue deletion is blocked for active, revoked, and replaced promotion history.
- Redaction and expiry converge on one fenced deletion job; content access stops immediately; object-store/DB crash points retry to verified physical deletion.
- A database-trigger test proves metadata-only promoted work-product insertion fails after activation and privileged bypass is unavailable to ordinary writes.
- Identical mutable content at a later `updated_at` produces a distinct revision key; captured trust descriptor survives source deletion.
- Head/predecessor/event composite constraints reject cross-target or cross-snapshot graph edges, while only the guarded CAS function may update heads.
- Board object-content inspection returns the exact quarantined binary with pre-stream audit/no-store and never leaks through agent surfaces.
- Expiry racing promotion loses after promotion history appears; promotion rejects logically or physically deleting snapshots.

## 10. Verification Commands

Start narrow, then run the full PR-ready gates because the implementation crosses DB/shared/server contracts:

```sh
pnpm db:generate
pnpm --filter @paperclipai/db check:migrations
pnpm exec vitest run server/src/__tests__/issue-thread-interactions-service.test.ts
pnpm exec vitest run server/src/__tests__/issue-interaction-continuation-outbox.test.ts
pnpm exec vitest run server/src/__tests__/issue-thread-interaction-routes.test.ts
pnpm exec vitest run server/src/__tests__/low-trust-red-team-routes.test.ts
pnpm exec vitest run server/src/__tests__/low-trust-provenance.test.ts
pnpm exec vitest run server/src/__tests__/low-trust-provenance-artifacts.test.ts
pnpm exec vitest run packages/shared/src/validators/trust-policy.test.ts
pnpm exec vitest run server/src/__tests__/issue-agent-mutation-ownership-routes.test.ts
pnpm exec vitest run server/src/__tests__/heartbeat-process-recovery.test.ts
pnpm -r typecheck
pnpm test:run
pnpm build
```

Add dedicated dispatcher/provenance service tests rather than overloading route tests with database lifecycle details. Run `node .gitnexus/run.cjs detect-changes -r jhj-paperclip -s unstaged -l 100` before every commit and compare against `master` before PR handoff.

## 11. Operational Rollout and Rollback

### Rollout

1. Apply additive schema and deploy the dual-mode binary with both activation settings off.
2. Verify every writer/scheduler instance runs the dual-mode version; drain or restart older instances.
3. Run the 24-hour continuation reconciliation and provenance classification dry-run.
4. Atomically activate outbox-required writes and polling through the database setting; verify no old writer can serve traffic.
5. Run leased provenance classification batches, then atomically activate snapshot-required promotion writes.
6. Observe pending age, lease reclaims, retry/dead-letter counts, delivery latency, recovery escalations, snapshot capture/verification failures, quarantine storage, and legacy classifications.
7. Remove synchronous and pointer-based fallbacks only in a later release.

### Rollback

- Before activation, rolling back the dual-mode binary preserves old behavior because new paths are dormant.
- After outbox activation, stop new claims and drain or park every pending/claimed/retry row before disabling the producer; never restore an old writer that can resolve without intent.
- Additive tables/columns remain during emergency rollback; do not drop audit/outbox/provenance state.
- Provenance activation may be disabled for new capture/promotion while existing snapshot/promotion protections remain enforced.
- Snapshot/promotion rows and retained audit IDs are never rewritten during rollback.
- Never reverse snapshot redaction, recreate removed raw bytes, or upgrade legacy content heuristically.

## 12. Alternatives Rejected

1. **Keep awaiting `heartbeat.wakeup()` in the route.** Rejected because it cannot close the commit/crash window and can return an error after resolution already committed.
2. **Retry wake only on equivalent HTTP replay.** Rejected because correctness would depend on the client retrying and process crashes may produce no retry.
3. **Insert a partially formed `agent_wakeup_requests` row directly from the interaction transaction.** Rejected because no worker consumes that state and the table's statuses already represent post-policy wake outcomes.
4. **Use a time-bucket idempotency key.** Rejected because retries outside the bucket create duplicate logical wakes.
5. **Store only the current source row ID in promotion metadata.** Rejected because source mutation/deletion changes or destroys the reviewed evidence.
6. **Store only a digest without a quarantined snapshot.** Rejected because deleted non-versioned sources become uninspectable and a digest alone cannot prove which structured fields were reviewed.
7. **Copy raw source into the promoted work product.** Rejected because it crosses the quarantine boundary and reintroduces prompt-injection propagation.
8. **Freeze every source row forever.** Rejected because board correction and legal redaction remain necessary; immutable snapshot history is the authoritative evidence.
9. **Backfill missing historical raw content heuristically.** Rejected because provenance must not be fabricated.

## 13. Definition of Done

The two findings are closed only when all of the following are demonstrated:

- No continuation-relevant interaction resolution can commit without a durable intent in the same transaction.
- A dispatcher crash at every boundary converges to one logical heartbeat wake request or an explicit durable suppressed/dead-letter state.
- Promotion of every supported source kind creates and references an immutable, versioned, content-addressed snapshot.
- Later source mutation/deletion cannot alter the evidence linked to a promotion.
- Quarantined raw snapshot content never appears in higher-trust agent context or general artifact responses.
- Resolution, continuation, capture, promotion, and terminal audit rows commit atomically with their source state; live/plugin publication occurs only after commit.
- Activation barriers prove old writers cannot bypass either invariant.
- Company scoping, board gates, activity logging, migrations, focused failure tests, typecheck, full tests, and build all pass.
