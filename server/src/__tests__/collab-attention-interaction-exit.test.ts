import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  issues,
  issueThreadInteractions,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { attentionService } from "../services/attention.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";

// Characterization tests: freeze TODAY's attention entry/exit contract for
// issue_thread_interaction attention items (server/src/services/attention.ts).
// These pin down the frozen strings and pending-only filter behavior as the
// Stage 0 regression floor; they are not spec tests.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres attention interaction exit tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("collab attention interaction exit", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-attention-interaction-exit-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    // FK-safe order: children before parents.
    // issueThreadInteractions references issues (issueId) and companies
    // (companyId); issues references companies (companyId).
    await db.delete(issueThreadInteractions);
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(prefix = "AXT") {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `${prefix} Co`,
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    return { companyId, prefix };
  }

  async function insertIssue(input: {
    companyId: string;
    identifier: string;
    title: string;
    status: string;
  }) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId: input.companyId,
      identifier: input.identifier,
      title: input.title,
      status: input.status,
      originFingerprint: `default-${id}`,
    });
    return id;
  }

  async function insertInteraction(input: {
    companyId: string;
    issueId: string;
    status: string;
    title?: string;
  }) {
    const id = randomUUID();
    await db.insert(issueThreadInteractions).values({
      id,
      companyId: input.companyId,
      issueId: input.issueId,
      kind: "request_confirmation",
      status: input.status,
      // DB column default is "wake_assignee" (zod create default is "none");
      // set explicitly per sibling-task finding when seeding rows directly.
      continuationPolicy: "wake_assignee",
      title: input.title ?? "Ship the release",
      payload: { version: 1, prompt: "Ship the release?" },
      createdByAgentId: null,
      sourceRunId: null,
      createdAt: new Date("2026-07-09T12:00:00.000Z"),
      updatedAt: new Date("2026-07-09T12:00:00.000Z"),
    });
    return id;
  }

  it("surfaces a pending request_confirmation interaction with the frozen entry contract", async () => {
    const { companyId } = await seedCompany("AX1");
    const issueId = await insertIssue({
      companyId,
      identifier: "AX1-1",
      title: "Release checklist",
      status: "in_review",
    });
    const interactionId = await insertInteraction({ companyId, issueId, status: "pending" });

    const feed = await attentionService(db).list(companyId, { userId: "board-user" });

    expect(feed.countsBySourceKind.issue_thread_interaction).toBe(1);
    const item = feed.items.find((entry) => entry.sourceKind === "issue_thread_interaction");
    expect(item).toBeDefined();
    expect(item?.sourceKind).toBe("issue_thread_interaction");
    expect(item?.subject.status).toBe("pending");
    expect(item?.entryRule).toBe("issue_thread_interactions.status = 'pending'");
    expect(item?.exitRule).toBe("Interaction resolves, expires, fails, or is cancelled.");
    expect(item?.inlineResolvable).toBe(true);
    expect(item?.dedupKey).toBe(`interaction:${interactionId}`);
  });

  it("removes the attention item once rejectInteraction resolves the interaction", async () => {
    const { companyId } = await seedCompany("AX2");
    const issueId = await insertIssue({
      companyId,
      identifier: "AX2-1",
      title: "Release checklist",
      status: "in_review",
    });
    const interactionId = await insertInteraction({ companyId, issueId, status: "pending" });

    const preFeed = await attentionService(db).list(companyId, { userId: "board-user" });
    expect(preFeed.countsBySourceKind.issue_thread_interaction).toBe(1);

    await issueThreadInteractionService(db).rejectInteraction(
      { id: issueId, companyId },
      interactionId,
      { reason: "declined" },
      { userId: "board-user" },
    );

    const feed = await attentionService(db).list(companyId, { userId: "board-user" });
    expect(feed.countsBySourceKind.issue_thread_interaction).toBe(0);
    expect(feed.items.some((entry) => entry.sourceKind === "issue_thread_interaction")).toBe(false);
  });

  it("removes the attention item once acceptInteraction resolves the interaction", async () => {
    const { companyId } = await seedCompany("AX3");
    const issueId = await insertIssue({
      companyId,
      identifier: "AX3-1",
      title: "Release checklist",
      status: "in_review",
    });
    // createdByAgentId: null and sourceRunId: null skip the creator-return
    // and workspace-finalize gates in acceptRequestConfirmation.
    const interactionId = await insertInteraction({ companyId, issueId, status: "pending" });

    const preFeed = await attentionService(db).list(companyId, { userId: "board-user" });
    expect(preFeed.countsBySourceKind.issue_thread_interaction).toBe(1);

    await issueThreadInteractionService(db).acceptInteraction(
      { id: issueId, companyId, projectId: null, goalId: null },
      interactionId,
      {},
      { userId: "board-user" },
    );

    const feed = await attentionService(db).list(companyId, { userId: "board-user" });
    expect(feed.countsBySourceKind.issue_thread_interaction).toBe(0);
    expect(feed.items.some((entry) => entry.sourceKind === "issue_thread_interaction")).toBe(false);
  });

  it("never surfaces interactions seeded directly in expired, cancelled, or answered status", async () => {
    const { companyId } = await seedCompany("AX4");
    const issueId = await insertIssue({
      companyId,
      identifier: "AX4-1",
      title: "Release checklist",
      status: "in_review",
    });
    await insertInteraction({ companyId, issueId, status: "expired", title: "Expired confirmation" });
    await insertInteraction({ companyId, issueId, status: "cancelled", title: "Cancelled confirmation" });
    await insertInteraction({ companyId, issueId, status: "answered", title: "Answered confirmation" });

    const feed = await attentionService(db).list(companyId, { userId: "board-user" });

    expect(feed.countsBySourceKind.issue_thread_interaction).toBe(0);
    expect(feed.items.some((entry) => entry.sourceKind === "issue_thread_interaction")).toBe(false);
  });
});
