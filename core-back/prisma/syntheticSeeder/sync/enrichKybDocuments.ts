import { randomUUID } from "node:crypto";
import type { PrismaClient } from "../../../generated/prisma/client";
import type { SeederContext } from "../context";

/**
 * Creates the small number of periodic re-verification requests. Document
 * ciphertext, missing required documents, owner identity documents and review
 * dates are all produced in phase 1 and bulk-inserted with their final values.
 */
export const enrichKybDocuments = async (
  prisma: PrismaClient,
  ctx?: SeederContext,
): Promise<{
  documents: number;
  ownerDocuments: number;
  revalidations: number;
  merchantsScheduled: number;
}> => {
  const uploader = await prisma.user.findFirst({
    where: { merchantId: null },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  const requestedById = uploader?.id ?? (await prisma.user.findFirstOrThrow({ select: { id: true } })).id;

  const acceptedDocs = await prisma.kybDocument.findMany({
    where: {
      status: "ACCEPTED",
      subjectType: "MERCHANT",
      joinRequest: { status: "APPROVED" },
    },
    select: { id: true, merchantId: true, docType: true },
    take: 12,
  });

  const merchantIds = [...new Set(acceptedDocs.map((document) => document.merchantId))];
  const openRequests = merchantIds.length > 0
    ? await prisma.kybRevalidationRequest.findMany({
        where: { merchantId: { in: merchantIds }, status: "OPEN" },
        select: { merchantId: true },
      })
    : [];
  const merchantsWithOpenRequest = new Set(openRequests.map((request) => request.merchantId));

  const now = new Date();
  const dueAt = new Date(now.getTime() + 30 * 86_400_000);
  const rows = [];
  for (const document of acceptedDocs) {
    if (merchantsWithOpenRequest.has(document.merchantId)) continue;
    merchantsWithOpenRequest.add(document.merchantId);
    rows.push({
      id: randomUUID(),
      merchantId: document.merchantId,
      documentId: document.id,
      docType: document.docType,
      reasonCode: "PERIODIC_REVIEW",
      message: `Periodic KYB re-verification is due for ${document.docType}. Please upload a current document.`,
      status: "OPEN" as const,
      requestedById,
      requestedAt: now,
      dueAt,
    });
  }

  let revalidations = 0;
  if (rows.length > 0) {
    const result = await prisma.kybRevalidationRequest.createMany({ data: rows, skipDuplicates: true });
    revalidations = result.count;
    await prisma.merchant.updateMany({
      where: { id: { in: [...new Set(rows.map((row) => row.merchantId))] } },
      data: { kybStatus: "PENDING" },
    });
  }

  const documents = ctx
    ? ctx.dataset.kybDocuments.filter((document) => document.subjectType === "MERCHANT").length
    : await prisma.kybDocument.count({ where: { subjectType: "MERCHANT" } });
  const ownerDocuments = ctx
    ? ctx.dataset.kybDocuments.filter((document) => document.subjectType === "BENEFICIAL_OWNER").length
    : await prisma.kybDocument.count({ where: { subjectType: "BENEFICIAL_OWNER" } });
  const merchantsScheduled = ctx
    ? ctx.dataset.merchants.filter((merchant) => merchant.status === "ACTIVE" && merchant.nextKybReviewAt).length
    : await prisma.merchant.count({ where: { status: "ACTIVE", nextKybReviewAt: { not: null } } });

  return { documents, ownerDocuments, revalidations, merchantsScheduled };
};
