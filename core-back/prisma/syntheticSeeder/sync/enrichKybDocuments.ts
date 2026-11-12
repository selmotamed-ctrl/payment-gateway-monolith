import { randomUUID } from "node:crypto";
import type { PrismaClient } from "../../../generated/prisma/client";
import { createObjectStorageSdk } from "../../../lib/objectStorageSdk";
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
 * shared object-storage document content, owner identity documents, a few
 * active-merchant re-verification requests and the next periodic KYB review
 * date.
 */
export const enrichKybDocuments = async (prisma: PrismaClient): Promise<{
  documents: number;
  ownerDocuments: number;
  revalidations: number;
  merchantsScheduled: number;
}> => {
  const objectStorage = createObjectStorageSdk({ prisma });
  const uploader = await prisma.user.findFirst({
    where: { merchantId: null },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  const actorId = uploader?.id ?? "synthetic-seeder";

  const attachPreview = async (document: {
    id: string;
    merchantId: string;
    docType: string;
    originalFileName: string | null;
    avStatus: string;
  }): Promise<void> => {
    const bytes = previewPdf(document.id);
    const fileName = document.originalFileName ?? `${document.docType.toLowerCase()}.pdf`;
    const actor = {
      actorType: "SYSTEM_WORKER" as const,
      actorId,
      authorities: ["*"],
    };
    const staged = document.avStatus === "CLEAN"
      ? await objectStorage.workerClient.stageSystemGenerated({
          namespace: "KYB_DOCUMENTS",
          data: bytes,
          originalFilename: fileName,
          claimedMimeType: "application/pdf",
          ownerMerchantId: document.merchantId,
          actorId,
          metadata: { synthetic: true, documentId: document.id },
        })
      : await objectStorage.routeClient.stageUpload({
          namespace: "KYB_DOCUMENTS",
          data: bytes,
          originalFilename: fileName,
          claimedMimeType: "application/pdf",
          ownerMerchantId: document.merchantId,
          actor,
          metadata: { synthetic: true, documentId: document.id },
        });
    await prisma.$transaction(async (tx) => {
      await tx.kybDocument.update({
        where: { id: document.id },
        data: {
          storageObjectId: staged.objectId,
          storageKey: staged.storageKey,
          originalFileName: fileName,
        },
      });
      await objectStorage.routeClient.bind(tx as never, {
        objectId: staged.objectId,
        holderType: "KYB_DOCUMENT",
        holderId: document.id,
        actorId,
        reason: "SYNTHETIC_KYB_DOCUMENT",
        autoPromoteIfNoAvRequired: document.avStatus === "CLEAN",
      });
    });
    if (document.avStatus === "INFECTED") {
      await objectStorage.workerClient.applyScanVerdict({
        objectId: staged.objectId,
        verdict: "INFECTED",
        signature: "SYNTHETIC_INFECTED_DOCUMENT",
      });
    }
  };

  const documents = await prisma.kybDocument.findMany({
    where: { storageObjectId: null },
    select: {
      id: true,
      merchantId: true,
      docType: true,
      originalFileName: true,
      uploadedById: true,
      avStatus: true,
    },
  });
  for (const document of documents) {
    await attachPreview(document);
    if (!document.uploadedById && uploader) {
      await prisma.kybDocument.update({
        where: { id: document.id },
        data: { uploadedById: uploader.id },
      });
    }
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
      const bytes = previewPdf(id);
      await prisma.kybDocument.create({
        data: {
          id,
          merchantId: merchant.id,
          joinRequestId: joinRequest?.id ?? null,
          subjectType: "MERCHANT",
          subjectId: merchant.id,
          docType: docType as never,
          storageKey: `pending-object-storage/${id}`,
          originalFileName: `${docType.toLowerCase()}.pdf`,
          sha256: `seed-valid-${merchant.id}-${docType}`.padEnd(64, "0").slice(0, 64),
          mime: "application/pdf",
          sizeBytes: bytes.byteLength,
          avStatus: "CLEAN",
          status: "ACCEPTED",
          uploadedById: uploader?.id ?? null,
          reviewedById: uploader?.id ?? null,
          reviewedAt: new Date(),
          expiresOn,
          statusChangedAt: new Date(),
        },
      });
      await attachPreview({
        id,
        merchantId: merchant.id,
        docType,
        originalFileName: `${docType.toLowerCase()}.pdf`,
        avStatus: "CLEAN",
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
    const originalFileName = `${owner.fullNameAr.replaceAll(/\s+/g, "-")}-identity.pdf`;
    const bytes = previewPdf(id);
    await prisma.kybDocument.create({
      data: {
        id,
        merchantId: owner.merchantId,
        joinRequestId: joinRequest?.id ?? null,
        subjectType: "BENEFICIAL_OWNER",
        subjectId: owner.id,
        docType: "OWNER_ID",
        storageKey: `pending-object-storage/${id}`,
        originalFileName,
        sha256: `seed-owner-${owner.id}`.padEnd(64, "0").slice(0, 64),
        mime: "application/pdf",
        sizeBytes: bytes.byteLength,
        avStatus: "CLEAN",
        status: "UPLOADED",
        uploadedById: uploader?.id ?? null,
        expiresOn: new Date(Date.now() + 365 * 86_400_000),
        statusChangedAt: new Date(),
      },
    });
    await attachPreview({
      id,
      merchantId: owner.merchantId,
      docType: "OWNER_ID",
      originalFileName,
      avStatus: "CLEAN",
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
