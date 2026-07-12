import { and, desc, eq, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues, issueWorkProducts } from "@paperclipai/db";
import type { IssueWorkProduct } from "@paperclipai/shared";

type IssueWorkProductRow = typeof issueWorkProducts.$inferSelect;

type WorkProductMutationGuard = (context: {
  issueStatus: string;
  assigneeAgentId: string | null;
  checkoutRunId: string | null;
  existing: IssueWorkProduct | null;
  implicitlyUpdated: IssueWorkProduct[];
}) => void | Promise<void>;

function toIssueWorkProduct(row: IssueWorkProductRow): IssueWorkProduct {
  return {
    id: row.id,
    companyId: row.companyId,
    projectId: row.projectId ?? null,
    issueId: row.issueId,
    executionWorkspaceId: row.executionWorkspaceId ?? null,
    runtimeServiceId: row.runtimeServiceId ?? null,
    type: row.type as IssueWorkProduct["type"],
    provider: row.provider,
    externalId: row.externalId ?? null,
    title: row.title,
    url: row.url ?? null,
    status: row.status,
    reviewState: row.reviewState as IssueWorkProduct["reviewState"],
    isPrimary: row.isPrimary,
    healthStatus: row.healthStatus as IssueWorkProduct["healthStatus"],
    summary: row.summary ?? null,
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    sourceTrust: row.sourceTrust ?? null,
    createdByRunId: row.createdByRunId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function workProductService(db: Db) {
  return {
    listForIssue: async (issueId: string) => {
      const rows = await db
        .select()
        .from(issueWorkProducts)
        .where(eq(issueWorkProducts.issueId, issueId))
        .orderBy(desc(issueWorkProducts.isPrimary), desc(issueWorkProducts.updatedAt));
      return rows.map(toIssueWorkProduct);
    },

    getById: async (id: string) => {
      const row = await db
        .select()
        .from(issueWorkProducts)
        .where(eq(issueWorkProducts.id, id))
        .then((rows) => rows[0] ?? null);
      return row ? toIssueWorkProduct(row) : null;
    },

    createForIssue: async (
      issueId: string,
      companyId: string,
      data: Omit<typeof issueWorkProducts.$inferInsert, "issueId" | "companyId">,
      authorize?: WorkProductMutationGuard,
    ) => {
      const row = await db.transaction(async (tx) => {
        const lockedIssue = await tx
          .select({
            status: issues.status,
            assigneeAgentId: issues.assigneeAgentId,
            checkoutRunId: issues.checkoutRunId,
          })
          .from(issues)
          .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!lockedIssue) return null;
        const implicitlyUpdated = data.isPrimary
          ? await tx
              .select()
              .from(issueWorkProducts)
              .where(and(
                eq(issueWorkProducts.companyId, companyId),
                eq(issueWorkProducts.issueId, issueId),
                eq(issueWorkProducts.type, data.type),
                eq(issueWorkProducts.isPrimary, true),
              ))
              .for("update")
          : [];
        await authorize?.({
          issueStatus: lockedIssue.status,
          assigneeAgentId: lockedIssue.assigneeAgentId,
          checkoutRunId: lockedIssue.checkoutRunId,
          existing: null,
          implicitlyUpdated: implicitlyUpdated.map(toIssueWorkProduct),
        });

        if (data.isPrimary) {
          await tx
            .update(issueWorkProducts)
            .set({ isPrimary: false, updatedAt: new Date() })
            .where(
              and(
                eq(issueWorkProducts.companyId, companyId),
                eq(issueWorkProducts.issueId, issueId),
                eq(issueWorkProducts.type, data.type),
                eq(issueWorkProducts.isPrimary, true),
              ),
            );
        }
        return await tx
          .insert(issueWorkProducts)
          .values({
            ...data,
            companyId,
            issueId,
          })
          .returning()
          .then((rows) => rows[0] ?? null);
      });
      return row ? toIssueWorkProduct(row) : null;
    },

    update: async (
      id: string,
      patch: Partial<typeof issueWorkProducts.$inferInsert>,
      authorize?: WorkProductMutationGuard,
    ) => {
      const row = await db.transaction(async (tx) => {
        const candidate = await tx
          .select({
            issueId: issueWorkProducts.issueId,
            companyId: issueWorkProducts.companyId,
          })
          .from(issueWorkProducts)
          .where(eq(issueWorkProducts.id, id))
          .then((rows) => rows[0] ?? null);
        if (!candidate) return null;

        const lockedIssue = await tx
          .select({
            status: issues.status,
            assigneeAgentId: issues.assigneeAgentId,
            checkoutRunId: issues.checkoutRunId,
          })
          .from(issues)
          .where(and(
            eq(issues.id, candidate.issueId),
            eq(issues.companyId, candidate.companyId),
          ))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!lockedIssue) return null;

        const existing = await tx
          .select()
          .from(issueWorkProducts)
          .where(eq(issueWorkProducts.id, id))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!existing) return null;
        const implicitlyUpdated = patch.isPrimary === true
          ? await tx
              .select()
              .from(issueWorkProducts)
              .where(and(
                eq(issueWorkProducts.companyId, existing.companyId),
                eq(issueWorkProducts.issueId, existing.issueId),
                eq(issueWorkProducts.type, existing.type),
                eq(issueWorkProducts.isPrimary, true),
                ne(issueWorkProducts.id, id),
              ))
              .for("update")
          : [];
        await authorize?.({
          issueStatus: lockedIssue.status,
          assigneeAgentId: lockedIssue.assigneeAgentId,
          checkoutRunId: lockedIssue.checkoutRunId,
          existing: toIssueWorkProduct(existing),
          implicitlyUpdated: implicitlyUpdated.map(toIssueWorkProduct),
        });

        if (patch.isPrimary === true) {
          await tx
            .update(issueWorkProducts)
            .set({ isPrimary: false, updatedAt: new Date() })
            .where(
              and(
                eq(issueWorkProducts.companyId, existing.companyId),
                eq(issueWorkProducts.issueId, existing.issueId),
                eq(issueWorkProducts.type, existing.type),
                eq(issueWorkProducts.isPrimary, true),
                ne(issueWorkProducts.id, id),
              ),
            );
        }

        return await tx
          .update(issueWorkProducts)
          .set({ ...patch, updatedAt: new Date() })
          .where(eq(issueWorkProducts.id, id))
          .returning()
          .then((rows) => rows[0] ?? null);
      });
      return row ? toIssueWorkProduct(row) : null;
    },

    remove: async (id: string, authorize?: WorkProductMutationGuard) => {
      const row = await db.transaction(async (tx) => {
        const candidate = await tx
          .select({
            issueId: issueWorkProducts.issueId,
            companyId: issueWorkProducts.companyId,
          })
          .from(issueWorkProducts)
          .where(eq(issueWorkProducts.id, id))
          .then((rows) => rows[0] ?? null);
        if (!candidate) return null;

        const lockedIssue = await tx
          .select({
            status: issues.status,
            assigneeAgentId: issues.assigneeAgentId,
            checkoutRunId: issues.checkoutRunId,
          })
          .from(issues)
          .where(and(
            eq(issues.id, candidate.issueId),
            eq(issues.companyId, candidate.companyId),
          ))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!lockedIssue) return null;

        const existing = await tx
          .select()
          .from(issueWorkProducts)
          .where(eq(issueWorkProducts.id, id))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!existing) return null;
        await authorize?.({
          issueStatus: lockedIssue.status,
          assigneeAgentId: lockedIssue.assigneeAgentId,
          checkoutRunId: lockedIssue.checkoutRunId,
          existing: toIssueWorkProduct(existing),
          implicitlyUpdated: [],
        });

        return tx
          .delete(issueWorkProducts)
          .where(eq(issueWorkProducts.id, id))
          .returning()
          .then((rows) => rows[0] ?? null);
      });
      return row ? toIssueWorkProduct(row) : null;
    },
  };
}

export { toIssueWorkProduct };
