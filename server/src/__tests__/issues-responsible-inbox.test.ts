import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  issueInboxArchives,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres responsible inbox tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issueService.list responsibleUserId inbox membership (touchedByUserId)", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issues-responsible-inbox-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueInboxArchives);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(name = "Paperclip") {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, id: string, name = "Coder") {
    await db.insert(agents).values({
      id,
      companyId,
      name,
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
  }

  it("includes issue when user is only responsibleUserId (createdBy other, assigneeUser null, assigneeAgent optional, no comments/read by me)", async () => {
    const companyId = await seedCompany();
    const me = "user-responsible";
    const other = "user-other";
    const issueId = randomUUID();

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Only responsible",
      status: "todo",
      priority: "medium",
      createdByUserId: other,
      assigneeUserId: null,
      responsibleUserId: me,
      createdAt: new Date("2026-07-13T10:00:00.000Z"),
      updatedAt: new Date("2026-07-13T10:00:00.000Z"),
    });

    const result = await svc.list(companyId, { touchedByUserId: me });
    expect(result.map((i) => i.id)).toContain(issueId);
  });

  it("still includes creator-only and assigneeUser-only issues", async () => {
    const companyId = await seedCompany();
    const me = "user-me";
    const creatorOnlyId = randomUUID();
    const assigneeOnlyId = randomUUID();
    const responsibleOnlyId = randomUUID();

    await db.insert(issues).values([
      {
        id: creatorOnlyId,
        companyId,
        title: "Creator only",
        status: "todo",
        priority: "medium",
        createdByUserId: me,
        createdAt: new Date("2026-07-13T10:00:00.000Z"),
        updatedAt: new Date("2026-07-13T10:00:00.000Z"),
      },
      {
        id: assigneeOnlyId,
        companyId,
        title: "Assignee only",
        status: "todo",
        priority: "medium",
        assigneeUserId: me,
        createdAt: new Date("2026-07-13T10:01:00.000Z"),
        updatedAt: new Date("2026-07-13T10:01:00.000Z"),
      },
      {
        id: responsibleOnlyId,
        companyId,
        title: "Responsible only",
        status: "todo",
        priority: "medium",
        responsibleUserId: me,
        createdAt: new Date("2026-07-13T10:02:00.000Z"),
        updatedAt: new Date("2026-07-13T10:02:00.000Z"),
      },
    ]);

    const result = await svc.list(companyId, { touchedByUserId: me });
    const ids = result.map((i) => i.id);
    expect(ids).toContain(creatorOnlyId);
    expect(ids).toContain(assigneeOnlyId);
    expect(ids).toContain(responsibleOnlyId);
  });

  it("does not include stranger company-member-only issue", async () => {
    const companyId = await seedCompany();
    const me = "user-me";
    const stranger = "user-stranger";
    const strangerIssueId = randomUUID();

    await db.insert(issues).values({
      id: strangerIssueId,
      companyId,
      title: "Stranger only",
      status: "todo",
      priority: "medium",
      createdByUserId: stranger,
      createdAt: new Date("2026-07-13T10:00:00.000Z"),
      updatedAt: new Date("2026-07-13T10:00:00.000Z"),
    });

    const result = await svc.list(companyId, { touchedByUserId: me });
    expect(result.map((i) => i.id)).not.toContain(strangerIssueId);
  });

  it("includes responsible-only with inboxArchivedByUserId filter when not archived", async () => {
    const companyId = await seedCompany();
    const me = "user-me";
    const issueId = randomUUID();

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Responsible not archived",
      status: "todo",
      priority: "medium",
      responsibleUserId: me,
      createdAt: new Date("2026-07-13T10:00:00.000Z"),
      updatedAt: new Date("2026-07-13T10:00:00.000Z"),
    });

    const result = await svc.list(companyId, {
      touchedByUserId: me,
      inboxArchivedByUserId: me,
    });
    expect(result.map((i) => i.id)).toContain(issueId);
  });

  it("hides after archiveInbox; unarchive restores", async () => {
    const companyId = await seedCompany();
    const me = "user-me";
    const issueId = randomUUID();

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Responsible for archive",
      status: "todo",
      priority: "medium",
      responsibleUserId: me,
      createdAt: new Date("2026-07-13T10:00:00.000Z"),
      updatedAt: new Date("2026-07-13T10:00:00.000Z"),
    });

    const before = await svc.list(companyId, {
      touchedByUserId: me,
      inboxArchivedByUserId: me,
    });
    expect(before.map((i) => i.id)).toContain(issueId);

    await svc.archiveInbox(companyId, issueId, me, new Date("2026-07-13T11:00:00.000Z"));

    const afterArchive = await svc.list(companyId, {
      touchedByUserId: me,
      inboxArchivedByUserId: me,
    });
    expect(afterArchive.map((i) => i.id)).not.toContain(issueId);

    await svc.unarchiveInbox(companyId, issueId, me);

    const afterUnarchive = await svc.list(companyId, {
      touchedByUserId: me,
      inboxArchivedByUserId: me,
    });
    expect(afterUnarchive.map((i) => i.id)).toContain(issueId);
  });

  it("responsibleUserId works with assigneeAgentId set", async () => {
    const companyId = await seedCompany();
    const me = "user-me";
    const agentId = randomUUID();
    const issueId = randomUUID();

    await seedAgent(companyId, agentId);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Responsible with agent assignee",
      status: "todo",
      priority: "medium",
      responsibleUserId: me,
      assigneeAgentId: agentId,
      createdAt: new Date("2026-07-13T10:00:00.000Z"),
      updatedAt: new Date("2026-07-13T10:00:00.000Z"),
    });

    const result = await svc.list(companyId, { touchedByUserId: me });
    expect(result.map((i) => i.id)).toContain(issueId);
  });

  it("creator+responsible same user returns one row", async () => {
    const companyId = await seedCompany();
    const me = "user-me";
    const issueId = randomUUID();

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Creator and responsible same",
      status: "todo",
      priority: "medium",
      createdByUserId: me,
      responsibleUserId: me,
      createdAt: new Date("2026-07-13T10:00:00.000Z"),
      updatedAt: new Date("2026-07-13T10:00:00.000Z"),
    });

    const result = await svc.list(companyId, { touchedByUserId: me });
    const matches = result.filter((i) => i.id === issueId);
    expect(matches).toHaveLength(1);
  });

  it("company scoping: list company B does not return company A responsible issue", async () => {
    const companyA = await seedCompany("CompanyA");
    const companyB = await seedCompany("CompanyB");
    const me = "user-me";
    const issueA = randomUUID();

    await db.insert(issues).values({
      id: issueA,
      companyId: companyA,
      title: "Responsible in A",
      status: "todo",
      priority: "medium",
      responsibleUserId: me,
      createdAt: new Date("2026-07-13T10:00:00.000Z"),
      updatedAt: new Date("2026-07-13T10:00:00.000Z"),
    });

    const listB = await svc.list(companyB, { touchedByUserId: me });
    expect(listB.map((i) => i.id)).not.toContain(issueA);

    const listA = await svc.list(companyA, { touchedByUserId: me });
    expect(listA.map((i) => i.id)).toContain(issueA);
  });

  it("does NOT treat assigneeAgentId alone as human touch for me", async () => {
    const companyId = await seedCompany();
    const me = "user-me";
    const agentId = randomUUID();
    const issueId = randomUUID();

    await seedAgent(companyId, agentId);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Agent only assignee",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      // no human createdBy, assigneeUser, responsibleUser for me
      createdAt: new Date("2026-07-13T10:00:00.000Z"),
      updatedAt: new Date("2026-07-13T10:00:00.000Z"),
    });

    const result = await svc.list(companyId, { touchedByUserId: me });
    expect(result.map((i) => i.id)).not.toContain(issueId);
  });
});
