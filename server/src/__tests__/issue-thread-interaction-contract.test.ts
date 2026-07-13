import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  companies,
  createDb,
  issues,
  issueThreadInteractions,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { attentionService } from "../services/attention.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";

// Contract-shape freeze (task B5): exhaustive assertions on the
// issue_thread_interactions HTTP body and service-layer return shapes, plus
// the interaction<->attention exit-rule tie. These pin down the fields the
// route/service produce today so Stage 1's resolver-authority and
// continuation-outbox work (roadmap Track A) has a byte-exact floor to diff
// against.
//
// This file deliberately drives the real /api/issues/:id/interactions* HTTP
// routes via supertest (same pattern as attention-service.test.ts's route
// block) rather than mocking issueThreadInteractionService, so response
// bodies reflect real serialization -- not mock echoes. It intentionally
// avoids "route"/"routes"/"authz" in its filename so it is NOT swept into the
// serialized suite by scripts/run-vitest-stable.mjs's routeTestPattern; it
// isn't a route-behavior characterization suite that needs that isolation.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue-thread-interaction contract tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("issue thread interaction contract", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-interaction-contract-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueThreadInteractions);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(actor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  function boardActor(companyId: string, userId = "board-user") {
    return {
      type: "board",
      source: "local_implicit",
      userId,
      companyIds: [companyId],
      isInstanceAdmin: false,
    };
  }

  async function seedCompany(prefix: string) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `${prefix} Co`,
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedIssue(companyId: string, overrides: Partial<typeof issues.$inferInsert> = {}) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId,
      title: "Test issue",
      status: "in_progress",
      priority: "medium",
      ...overrides,
    });
    return id;
  }

  async function seedInteraction(
    companyId: string,
    issueId: string,
    overrides: Partial<typeof issueThreadInteractions.$inferInsert> = {},
  ) {
    const id = randomUUID();
    await db.insert(issueThreadInteractions).values({
      id,
      companyId,
      issueId,
      kind: "request_confirmation",
      status: "pending",
      // The issue_thread_interactions table default is "wake_assignee", but
      // the create route's zod schema (createIssueThreadInteractionSchema)
      // defaults request_confirmation interactions to "none" -- every direct
      // seed here must set this explicitly or accept() would attempt an
      // unwanted continuation wakeup.
      continuationPolicy: "none",
      payload: { version: 1, prompt: "Approve this?" },
      ...overrides,
    });
    return id;
  }

  it("freezes the create response body contract for a pending request_confirmation interaction", async () => {
    const companyId = await seedCompany("CRT");
    const issueId = await seedIssue(companyId);
    const app = createApp(boardActor(companyId));

    const createRes = await request(app)
      .post(`/api/issues/${issueId}/interactions`)
      .send({ kind: "request_confirmation", payload: { version: 1, prompt: "Approve the rollout?" } });

    expect(createRes.status, JSON.stringify(createRes.body)).toBe(201);

    // Matches packages/db/src/schema/issue_thread_interactions.ts:16-35.
    expect(Object.keys(createRes.body).sort()).toEqual([
      "companyId",
      "continuationPolicy",
      "createdAt",
      "createdByAgentId",
      "createdByUserId",
      "id",
      "idempotencyKey",
      "issueId",
      "kind",
      "payload",
      "resolvedAt",
      "resolvedByAgentId",
      "resolvedByUserId",
      "result",
      "sourceCommentId",
      "sourceRunId",
      "status",
      "summary",
      "title",
      "updatedAt",
    ]);
    expect(createRes.body).toEqual({
      id: expect.any(String),
      companyId,
      issueId,
      kind: "request_confirmation",
      idempotencyKey: null,
      sourceCommentId: null,
      sourceRunId: null,
      title: null,
      summary: null,
      status: "pending",
      continuationPolicy: "none",
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
      resolvedAt: null,
      createdByAgentId: null,
      createdByUserId: "board-user",
      resolvedByAgentId: null,
      resolvedByUserId: null,
      payload: {
        version: 1,
        prompt: "Approve the rollout?",
        allowDeclineReason: true,
        supersedeOnUserComment: true,
      },
      result: null,
    });
  });

  it("freezes the accept response contract for a pending request_confirmation interaction", async () => {
    const companyId = await seedCompany("ACC");
    const issueId = await seedIssue(companyId);
    const app = createApp(boardActor(companyId));

    const createRes = await request(app)
      .post(`/api/issues/${issueId}/interactions`)
      .send({ kind: "request_confirmation", payload: { version: 1, prompt: "Approve the rollout?" } });
    expect(createRes.status, JSON.stringify(createRes.body)).toBe(201);
    const interactionId = createRes.body.id as string;

    const acceptRes = await request(app)
      .post(`/api/issues/${issueId}/interactions/${interactionId}/accept`)
      .send({});

    expect(acceptRes.status, JSON.stringify(acceptRes.body)).toBe(200);
    expect(acceptRes.body).toMatchObject({
      status: "accepted",
      result: { version: 1, outcome: "accepted" },
      resolvedByUserId: "board-user",
      resolvedAt: expect.any(String),
    });

    // Same contract at the service layer: acceptInteraction()'s full return
    // shape, for a freshly-seeded interaction (the one accepted above is
    // already resolved and would 409 on a second accept call).
    const secondIssueId = await seedIssue(companyId);
    const secondInteractionId = await seedInteraction(companyId, secondIssueId, {
      payload: { version: 1, prompt: "Approve the second rollout?" },
    });

    const result = await issueThreadInteractionService(db).acceptInteraction(
      { id: secondIssueId, companyId, projectId: null, goalId: null },
      secondInteractionId,
      {},
      { agentId: null, userId: "board-user" },
    );

    expect(result).toEqual({
      interaction: {
        id: secondInteractionId,
        companyId,
        issueId: secondIssueId,
        kind: "request_confirmation",
        status: "accepted",
        continuationPolicy: "none",
        idempotencyKey: null,
        sourceCommentId: null,
        sourceRunId: null,
        title: null,
        summary: null,
        createdByAgentId: null,
        createdByUserId: null,
        resolvedByAgentId: null,
        resolvedByUserId: "board-user",
        payload: { version: 1, prompt: "Approve the second rollout?", allowDeclineReason: true },
        result: { version: 1, outcome: "accepted" },
        resolvedAt: expect.any(Date),
        createdAt: expect.any(Date),
        updatedAt: expect.any(Date),
      },
      createdIssues: [],
      continuationIssue: null,
    });
  });

  it("shows a pending interaction in the attention feed and hides it once the route resolves it", async () => {
    const companyId = await seedCompany("VIS");
    const issueId = await seedIssue(companyId);
    const app = createApp(boardActor(companyId));

    const createRes = await request(app)
      .post(`/api/issues/${issueId}/interactions`)
      .send({ kind: "request_confirmation", payload: { version: 1, prompt: "Approve the rollout?" } });
    expect(createRes.status, JSON.stringify(createRes.body)).toBe(201);
    const interactionId = createRes.body.id as string;
    const dedupKey = `interaction:${interactionId}`;

    const pendingFeed = await attentionService(db).list(companyId, { userId: "board-user" });
    expect(pendingFeed.items.some((item) =>
      item.sourceKind === "issue_thread_interaction" && item.dedupKey === dedupKey
    )).toBe(true);

    const acceptRes = await request(app)
      .post(`/api/issues/${issueId}/interactions/${interactionId}/accept`)
      .send({});
    expect(acceptRes.status, JSON.stringify(acceptRes.body)).toBe(200);

    const resolvedFeed = await attentionService(db).list(companyId, { userId: "board-user" });
    expect(resolvedFeed.items.some((item) =>
      item.sourceKind === "issue_thread_interaction" && item.dedupKey === dedupKey
    )).toBe(false);
  });
});
