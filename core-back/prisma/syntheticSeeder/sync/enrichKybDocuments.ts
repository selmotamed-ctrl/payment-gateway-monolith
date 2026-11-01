import { randomUUID } from "node:crypto";
import type { PrismaClient } from "../../../generated/prisma/client";
import { Vault } from "../../../engine/crypto/Vault";
import {
  DEFAULT_KYB_REFRESH_POLICY,
  nextKybReviewAt,
} from "../../../lib/kybReview";
import { readRequiredDocuments } from "../../../lib/joinRequestOnboarding";

const previewPdf = (documentId: string): Buffer =>
  Buffer.from(
    `%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]>>endobj\ntrailer<</Size 4/Root 1 0 R>>\n% synthetic KYB preview ${documentId}\n%%EOF\n`,
    "utf8",
  );

/**
 * Adds the data that cannot be produced by the synchronous row generator:
 * encrypted document content, owner identity documents, a few active-merchant
 * re-verification requests and the next periodic KYB review date.
 */
export const enrichKybDocuments = async (prisma: PrismaClient): Promise<{
  documents: number;
  ownerDocuments: number;
  revalidations: number;
  merchantsScheduled: number;
}> => {
  const vault = new Vault();
  const uploader = await prisma.user.findFirst({
    where: { merchantId: null },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });

  const documents = await prisma.kybDocument.findMany({
    where: { contentCiphertext: null },
    select: {
      id: true,
      merchantId: true,
      joinRequestId: true,
      docType: true,
      mime: true,
      originalFileName: true,
      uploadedById: true,
      status: true,
      expiresOn: true,
      createdAt: true,
    },
  });
  for (const document of documents) {
    await prisma.kybDocument.update({
      where: { id: document.id },
      data: {
        contentCiphertext: await vault.encryptSecret(previewPdf(document.id).toString("base64"), "kyb-document"),
        originalFileName: document.originalFileName ?? `${document.docType.toLowerCase()}.pdf`,
        uploadedById: document.uploadedById ?? uploader?.id ?? null,
      },
    });
  }

  const activeForDocuments = await prisma.merchant.findMany({
    where: { status: "ACTIVE" },
    select: { id: true, businessCategory: true },
  });
  let validDocuments = 0;
  for (const merchant of activeForDocuments) {
    const required = await readRequiredDocuments(prisma, merchant.businessCategory);
    const existing = await prisma.kybDocument.findMany({
      where: { merchantId: merchant.id },
      select: { docType: true, status: true, expiresOn: true },
    });
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const validTypes = new Set(
      existing
        .filter((doc) => doc.status === "ACCEPTED" && (!doc.expiresOn || doc.expiresOn.getTime() >= today.getTime()))
        .map((doc) => String(doc.docType)),
    );
    const joinRequest = await prisma.joinRequest.findFirst({
      where: { merchantId: merchant.id, status: "APPROVED" },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    for (const docType of required) {
      if (validTypes.has(docType)) continue;
      const id = randomUUID();
      const expiresOn = new Date(Date.now() + 365 * 86_400_000);
      await prisma.kybDocument.create({
        data: {
          id,
          merchantId: merchant.id,
          joinRequestId: joinRequest?.id ?? null,
          subjectType: "MERCHANT",
          subjectId: merchant.id,
          docType: docType as never,
          storageKey: `synthetic/kyb/merchants/${merchant.id}/${docType}.pdf`,
          originalFileName: `${docType.toLowerCase()}.pdf`,
          contentCiphertext: await vault.encryptSecret(previewPdf(id).toString("base64"), "kyb-document"),
          sha256: `seed-valid-${merchant.id}-${docType}`.padEnd(64, "0").slice(0, 64),
          mime: "application/pdf",
          sizeBytes: previewPdf(id).byteLength,
          avStatus: "CLEAN",
          status: "ACCEPTED",
          uploadedById: uploader?.id ?? null,
          reviewedById: uploader?.id ?? null,
          reviewedAt: new Date(),
          expiresOn,
          statusChangedAt: new Date(),
        },
      });
      validDocuments += 1;
    }
  }

  const owners = await prisma.beneficialOwner.findMany({
    where: { active: true },
    select: { id: true, merchantId: true, fullNameAr: true },
    take: 24,
  });
  let ownerDocuments = 0;
  for (const owner of owners) {
    const exists = await prisma.kybDocument.findFirst({
      where: { subjectType: "BENEFICIAL_OWNER", subjectId: owner.id, docType: "OWNER_ID" },
      select: { id: true },
    });
    if (exists) continue;
    const joinRequest = await prisma.joinRequest.findFirst({
      where: { merchantId: owner.merchantId },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    const id = randomUUID();
    await prisma.kybDocument.create({
      data: {
        id,
        merchantId: owner.merchantId,
        joinRequestId: joinRequest?.id ?? null,
        subjectType: "BENEFICIAL_OWNER",
        subjectId: owner.id,
        docType: "OWNER_ID",
        storageKey: `synthetic/kyb/owners/${owner.id}/OWNER_ID.pdf`,
        originalFileName: `${owner.fullNameAr.replaceAll(/\s+/g, "-")}-identity.pdf`,
        contentCiphertext: await vault.encryptSecret(previewPdf(id).toString("base64"), "kyb-document"),
        sha256: `seed-owner-${owner.id}`.padEnd(64, "0").slice(0, 64),
        mime: "application/pdf",
        sizeBytes: previewPdf(id).byteLength,
        avStatus: "CLEAN",
        status: "UPLOADED",
        uploadedById: uploader?.id ?? null,
        expiresOn: new Date(Date.now() + 365 * 86_400_000),
        statusChangedAt: new Date(),
      },
    });
    ownerDocuments += 1;
  }

  const activeMerchants = await prisma.merchant.findMany({
    where: { status: "ACTIVE" },
    select: { id: true, riskTier: true, activatedAt: true, createdAt: true, nextKybReviewAt: true },
  });
  let merchantsScheduled = 0;
  for (const merchant of activeMerchants) {
    if (merchant.nextKybReviewAt) continue;
    await prisma.merchant.update({
      where: { id: merchant.id },
      data: {
        nextKybReviewAt: nextKybReviewAt(merchant.riskTier, new Date(), DEFAULT_KYB_REFRESH_POLICY),
      },
    });
    merchantsScheduled += 1;
  }

  const acceptedDocs = await prisma.kybDocument.findMany({
    where: {
      status: "ACCEPTED",
      subjectType: "MERCHANT",
      joinRequest: { status: "APPROVED" },
    },
    select: { id: true, merchantId: true, docType: true },
    take: 12,
  });
  let revalidations = 0;
  for (const document of acceptedDocs) {
    const existing = await prisma.kybRevalidationRequest.findFirst({
      where: { merchantId: document.merchantId, status: "OPEN" },
      select: { id: true },
    });
    if (existing) continue;
    await prisma.kybRevalidationRequest.create({
      data: {
        id: randomUUID(),
        merchantId: document.merchantId,
        documentId: document.id,
        docType: document.docType,
        reasonCode: "PERIODIC_REVIEW",
        message: `Periodic KYB re-verification is due for ${document.docType}. Please upload a current document.`,
        status: "OPEN",
        requestedById: uploader?.id ?? (await prisma.user.findFirstOrThrow({ select: { id: true } })).id,
        requestedAt: new Date(),
        dueAt: new Date(Date.now() + 30 * 86_400_000),
      },
    });
    await prisma.merchant.update({
      where: { id: document.merchantId },
      data: { kybStatus: "PENDING" },
    });
    revalidations += 1;
  }

  return { documents: documents.length + validDocuments, ownerDocuments, revalidations, merchantsScheduled };
};
