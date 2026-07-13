import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issues,
  issueThreadInteractions,
  principalPermissionGrants,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";

// These tests freeze TODAY's behavior of a handful of collab-adjacent invariants
// (assignee XOR, company-boundary status codes, resolver authority, and the
// budget hard-stop gate's interaction with continuation wakeups) as the Stage 0
// regression floor. They are characterization tests, not spec tests: two blocks
// below pin down behavior that Stage 1 will deliberately change, and are marked
// with `// Stage 1 changes this deliberately: <roadmap ref>` comments.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres collab invariants route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("collab invariants (routes)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-collab-invariants-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    // FK-safe order: children before parents. heartbeatRuns references
    // agentWakeupRequests (wakeupRequestId), so it must go first; activityLog
    // references both agents and heartbeatRuns and must precede both.
    await db.delete(issueThreadInteractions);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(agents);
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

  function boardActor(input: {
    userId: string;
    companyId: string;
    membershipRole: string;
  }) {
    return {
      type: "board",
      userId: input.userId,
      companyIds: [input.companyId],
      memberships: [{ companyId: input.companyId, membershipRole: input.membershipRole, status: "active" }],
      source: "cloud_tenant",
      // cloud_tenant actors are never instance admins — access flows through
      // company-scoped membership grants, seeded per test company below.
      isInstanceAdmin: false,
    };
  }

  function agentActor(input: { agentId: string; companyId: string }) {
    // No runId, per brief: this is the shape that hits the plain
    // "board-only route" 403 at routes/issues.ts:3602-3603.
    return {
      type: "agent",
      agentId: input.agentId,
      companyId: input.companyId,
      source: "agent_key",
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

  async function seedMember(companyId: string, userId: string, role: string) {
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: role,
      updatedAt: new Date(),
    });
    await ensureHumanRoleDefaultGrants(db, {
      companyId,
      principalId: userId,
      membershipRole: role,
      grantedByUserId: null,
    });
  }

  async function seedAgent(companyId: string, overrides: Partial<typeof agents.$inferInsert> = {}) {
    const id = randomUUID();
    await db.insert(agents).values({
      id,
      companyId,
      name: "Test Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      ...overrides,
    });
    return id;
  }

  async function seedIssue(companyId: string, overrides: Partial<typeof issues.$inferInsert> = {}) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId,
      title: "Test issue",
      status: "todo",
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
      // The issue_thread_interactions table default is "wake_assignee" (not
      // "none"), so every direct seed here must set this explicitly or the
      // accept/reject route will attempt a continuation wakeup we don't want.
      continuationPolicy: "none",
      payload: { version: 1, prompt: "Approve this?" },
      ...overrides,
    });
    return id;
  }

  describe("assignee XOR", () => {
    // Gate lives in the service, not the zod schema: createIssueSchema has no
    // XOR refine (services/issues.ts:5997 create / :6270-6277 merged-next PATCH).
    it("rejects create with both assigneeAgentId and assigneeUserId; no row persisted", async () => {
      const companyId = await seedCompany("XORA");
      await seedMember(companyId, "owner-1", "owner");
      const agentId = await seedAgent(companyId);
      const app = createApp(boardActor({ userId: "owner-1", companyId, membershipRole: "owner" }));

      const res = await request(app)
        .post(`/api/companies/${companyId}/issues`)
        .send({
          title: "XOR create",
          status: "todo",
          assigneeAgentId: agentId,
          assigneeUserId: "owner-1",
        });

      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body).toMatchObject({ error: "Issue can only have one assignee" });

      const persisted = await db.select().from(issues).where(eq(issues.companyId, companyId));
      expect(persisted).toHaveLength(0);
    });

    it("rejects PATCH adding assigneeUserId onto an agent-assigned issue; row unchanged", async () => {
      const companyId = await seedCompany("XORB");
      await seedMember(companyId, "owner-1", "owner");
      const agentId = await seedAgent(companyId);
      const issueId = await seedIssue(companyId, {
        assigneeAgentId: agentId,
        assigneeUserId: null,
        status: "todo",
      });
      const app = createApp(boardActor({ userId: "owner-1", companyId, membershipRole: "owner" }));

      const res = await request(app)
        .patch(`/api/issues/${issueId}`)
        .send({ assigneeUserId: "owner-1" });

      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body).toMatchObject({ error: "Issue can only have one assignee" });

      const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(row).toMatchObject({ assigneeAgentId: agentId, assigneeUserId: null });
    });

    it("rejects PATCH adding assigneeAgentId onto a user-assigned issue; row unchanged", async () => {
      const companyId = await seedCompany("XORC");
      await seedMember(companyId, "owner-1", "owner");
      const agentId = await seedAgent(companyId);
      const issueId = await seedIssue(companyId, {
        assigneeUserId: "owner-1",
        assigneeAgentId: null,
        status: "todo",
      });
      const app = createApp(boardActor({ userId: "owner-1", companyId, membershipRole: "owner" }));

      const res = await request(app)
        .patch(`/api/issues/${issueId}`)
        .send({ assigneeAgentId: agentId });

      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body).toMatchObject({ error: "Issue can only have one assignee" });

      const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(row).toMatchObject({ assigneeUserId: "owner-1", assigneeAgentId: null });
    });
  });

  describe("company boundary (403 today, not 404)", () => {
    // authz.ts:76-78 (agent) and :103-107 (board); interaction routes resolve
    // the issue unscoped via svc.getById then assert company access after.
    it("denies a cross-company board member creating an interaction", async () => {
      const homeCompanyId = await seedCompany("BOUNDH1");
      const targetCompanyId = await seedCompany("BOUNDT1");
      await seedMember(homeCompanyId, "cross-user-1", "owner");
      const issueId = await seedIssue(targetCompanyId, { status: "todo" });
      const app = createApp(boardActor({ userId: "cross-user-1", companyId: homeCompanyId, membershipRole: "owner" }));

      const res = await request(app)
        .post(`/api/issues/${issueId}/interactions`)
        .send({ kind: "request_confirmation", payload: { version: 1, prompt: "Approve?" } });

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body).toMatchObject({ error: "User does not have access to this company" });

      const rows = await db
        .select()
        .from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.issueId, issueId));
      expect(rows).toHaveLength(0);
    });

    it("denies a cross-company agent creating an interaction", async () => {
      const homeCompanyId = await seedCompany("BOUNDH2");
      const targetCompanyId = await seedCompany("BOUNDT2");
      const agentId = await seedAgent(homeCompanyId);
      const issueId = await seedIssue(targetCompanyId, { status: "todo" });
      const app = createApp(agentActor({ agentId, companyId: homeCompanyId }));

      const res = await request(app)
        .post(`/api/issues/${issueId}/interactions`)
        .send({ kind: "request_confirmation", payload: { version: 1, prompt: "Approve?" } });

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body).toMatchObject({ error: "Agent key cannot access another company" });

      const rows = await db
        .select()
        .from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.issueId, issueId));
      expect(rows).toHaveLength(0);
    });

    it("denies a cross-company board member accept/reject; interaction stays pending", async () => {
      const homeCompanyId = await seedCompany("BOUNDH3");
      const targetCompanyId = await seedCompany("BOUNDT3");
      await seedMember(homeCompanyId, "cross-user-2", "owner");
      const issueId = await seedIssue(targetCompanyId, { status: "todo" });
      const acceptInteractionId = await seedInteraction(targetCompanyId, issueId);
      const rejectInteractionId = await seedInteraction(targetCompanyId, issueId);
      const app = createApp(boardActor({ userId: "cross-user-2", companyId: homeCompanyId, membershipRole: "owner" }));

      const acceptRes = await request(app)
        .post(`/api/issues/${issueId}/interactions/${acceptInteractionId}/accept`)
        .send({});
      expect(acceptRes.status, JSON.stringify(acceptRes.body)).toBe(403);
      expect(acceptRes.body).toMatchObject({ error: "User does not have access to this company" });

      const rejectRes = await request(app)
        .post(`/api/issues/${issueId}/interactions/${rejectInteractionId}/reject`)
        .send({});
      expect(rejectRes.status, JSON.stringify(rejectRes.body)).toBe(403);
      expect(rejectRes.body).toMatchObject({ error: "User does not have access to this company" });

      const rows = await db
        .select()
        .from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.issueId, issueId));
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.status === "pending")).toBe(true);
    });
  });

  // Stage 1 changes this deliberately: roadmap §8.4 resolverPolicy will
  // restrict who may resolve issue-thread interactions. Today (routes/issues.ts
  // :9168-9170 accept / :9276-9278 reject) the only gates are assertCompanyAccess,
  // the agent-denial check, and assertBoard — no assignee/creator/resolverPolicy
  // check exists.
  describe("resolver authority characterization", () => {
    it("lets an active operator who is neither assignee nor creator accept and reject", async () => {
      const companyId = await seedCompany("RAUTH1");
      await seedMember(companyId, "operator-1", "operator");
      const assigneeAgentId = await seedAgent(companyId, { name: "Assignee Agent" });
      const issueId = await seedIssue(companyId, {
        assigneeAgentId,
        createdByUserId: "creator-user",
        status: "in_progress",
      });
      const rejectInteractionId = await seedInteraction(companyId, issueId);
      const acceptInteractionId = await seedInteraction(companyId, issueId);
      const app = createApp(boardActor({ userId: "operator-1", companyId, membershipRole: "operator" }));

      const rejectRes = await request(app)
        .post(`/api/issues/${issueId}/interactions/${rejectInteractionId}/reject`)
        .send({ reason: "not now" });
      expect(rejectRes.status, JSON.stringify(rejectRes.body)).toBe(200);
      expect(rejectRes.body).toMatchObject({ status: "rejected", resolvedByUserId: "operator-1" });

      const acceptRes = await request(app)
        .post(`/api/issues/${issueId}/interactions/${acceptInteractionId}/accept`)
        .send({});
      expect(acceptRes.status, JSON.stringify(acceptRes.body)).toBe(200);
      expect(acceptRes.body).toMatchObject({ status: "accepted", resolvedByUserId: "operator-1" });
    });

    it("denies a viewer with 403 Viewer access is read-only", async () => {
      const companyId = await seedCompany("RAUTH2");
      await seedMember(companyId, "viewer-1", "viewer");
      const issueId = await seedIssue(companyId, { status: "in_progress" });
      const interactionId = await seedInteraction(companyId, issueId);
      const app = createApp(boardActor({ userId: "viewer-1", companyId, membershipRole: "viewer" }));

      const res = await request(app)
        .post(`/api/issues/${issueId}/interactions/${interactionId}/reject`)
        .send({});
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body).toMatchObject({ error: "Viewer access is read-only" });

      const [row] = await db
        .select()
        .from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, interactionId));
      expect(row?.status).toBe("pending");
    });

    it("denies a same-company agent actor (no runId) with the board-only-route 403", async () => {
      const companyId = await seedCompany("RAUTH3");
      const agentId = await seedAgent(companyId);
      const issueId = await seedIssue(companyId, { status: "in_progress" });
      const interactionId = await seedInteraction(companyId, issueId);
      const app = createApp(agentActor({ agentId, companyId }));

      const res = await request(app)
        .post(`/api/issues/${issueId}/interactions/${interactionId}/reject`)
        .send({});
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body).toMatchObject({
        error: "Agent actors cannot resolve issue-thread interactions through this board-only route",
      });

      const [row] = await db
        .select()
        .from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, interactionId));
      expect(row?.status).toBe("pending");
    });

    it("operator not named in responsible_user policy gets 403 on accept (no wake)", async () => {
      const companyId = await seedCompany("RAUTH5");
      await seedMember(companyId, "operator-1", "operator");
      const issueId = await seedIssue(companyId, { status: "in_progress" });
      const interactionId = await seedInteraction(companyId, issueId, {
        payload: {
          version: 1,
          prompt: "Approve plan?",
          reason: "stage1-policy-test",
          resolverPolicy: { kind: "responsible_user", userId: "responsible-user" },
        },
      });
      const app = createApp(boardActor({ userId: "operator-1", companyId, membershipRole: "operator" }));
      const res = await request(app)
        .post(`/api/issues/${issueId}/interactions/${interactionId}/accept`)
        .send({});
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body).toMatchObject({ error: "Not authorized to resolve this interaction" });
      const [row] = await db
        .select()
        .from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, interactionId));
      expect(row?.status).toBe("pending");
    });

    it("named responsible user (board actor) gets 200 under responsible_user policy", async () => {
      const companyId = await seedCompany("RAUTH6");
      await seedMember(companyId, "responsible-user", "operator");
      const issueId = await seedIssue(companyId, { status: "in_progress" });
      const interactionId = await seedInteraction(companyId, issueId, {
        payload: {
          version: 1,
          prompt: "Approve?",
          reason: "named",
          resolverPolicy: { kind: "responsible_user", userId: "responsible-user" },
        },
      });
      const app = createApp(boardActor({ userId: "responsible-user", companyId, membershipRole: "operator" }));
      const res = await request(app)
        .post(`/api/issues/${issueId}/interactions/${interactionId}/accept`)
        .send({});
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({ status: "accepted", resolvedByUserId: "responsible-user" });
    });

    it("create with requiredArtifacts foreign id returns 422", async () => {
      const companyId = await seedCompany("RAUTH7");
      await seedMember(companyId, "owner-1", "owner");
      const issueId = await seedIssue(companyId, { status: "in_progress" });
      const app = createApp(boardActor({ userId: "owner-1", companyId, membershipRole: "owner" }));
      const res = await request(app)
        .post(`/api/issues/${issueId}/interactions`)
        .send({
          kind: "request_confirmation",
          payload: {
            version: 1,
            prompt: "check artifact?",
            reason: "integrity test",
            requiredArtifacts: [{ kind: "work_product", id: randomUUID() }],
          },
        });
      expect(res.status, JSON.stringify(res.body)).toBe(422);
    });
  });

  describe("budget hard-stop blocks collab-triggered continuation wake", () => {
    it("409s the reject's continuation wake while the interaction resolution persists", async () => {
      const companyId = await seedCompany("BUDGETA");
      await seedMember(companyId, "owner-budget", "owner");
      const pausedAgentId = await seedAgent(companyId, { status: "paused", pauseReason: "budget" });
      const issueId = await seedIssue(companyId, { assigneeAgentId: pausedAgentId, status: "in_progress" });
      const interactionId = await seedInteraction(companyId, issueId, { continuationPolicy: "wake_assignee" });
      const app = createApp(boardActor({ userId: "owner-budget", companyId, membershipRole: "owner" }));

      const res = await request(app)
        .post(`/api/issues/${issueId}/interactions/${interactionId}/reject`)
        .send({ reason: "not viable" });

      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body).toMatchObject({ error: "Agent is paused because its budget hard-stop was reached." });

      const [interactionRow] = await db
        .select()
        .from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, interactionId));
      // Stage 1 changes this deliberately: roadmap §4.1 #14 / continuation-outbox
      // plan Track A will make resolve+wake atomic. Today rejectInteraction()
      // commits before queueResolvedInteractionContinuationWakeup() throws, so
      // the interaction resolves even though the wake 409s.
      expect(interactionRow?.status).toBe("rejected");

      const wakeupRows = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.agentId, pausedAgentId));
      expect(wakeupRows).toHaveLength(1);
      expect(wakeupRows[0]).toMatchObject({ status: "skipped", reason: "budget.blocked" });

      const heartbeatRunRows = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.companyId, companyId));
      expect(heartbeatRunRows).toHaveLength(0);
    });

    it("blocks heartbeatService(db).wakeup directly with the budget reason (fires before invokability)", async () => {
      const companyId = await seedCompany("BUDGETB");
      const pausedAgentId = await seedAgent(companyId, { status: "paused", pauseReason: "budget" });
      const heartbeat = heartbeatService(db);

      await expect(
        heartbeat.wakeup(pausedAgentId, { source: "on_demand", reason: "test-wake" }),
      ).rejects.toMatchObject({
        status: 409,
        message: "Agent is paused because its budget hard-stop was reached.",
      });
    });
  });
});
