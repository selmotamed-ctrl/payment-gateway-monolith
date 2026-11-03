import type { PrismaClient } from "../../generated/prisma/client";
import { ensureSystemAutomationUser } from "../governance/GovernanceExecution";
import { readRequiredDocuments } from "../../lib/joinRequestOnboarding";
import {
  daysUntilExpiry,
  nextKybReviewAt,
  readKybRefreshPolicy,
  startOfUtcDay,
} from "../../lib/kybReview";
import { queueKybNotification } from "../../lib/kybNotifications";
import { BaseWorker } from "./workerRuntime";
import { createAuditLog } from "../../lib/auditLog";

/**
 * The KYB lifecycle worker (design §16.4 and §16.10).
 *
 * It is deliberately split into bounded passes:
 *
 *  1. mark accepted/uploaded documents whose `expires_on` passed as EXPIRED;
 *  2. queue the 30-day and 7-day expiry notices;
 *  3. suspend an active merchant whose required document is more than the
 *     configured grace period past expiry and has no replacement;
 *  4. start the periodic re-verification for merchants whose
 *     `next_kyb_review_at` is due;
 *  5. expire open revalidation requests whose due date passed.
 *
 * Every pass is row-bounded by the worker batch size and every notification
 * uses the unique outbox event id, so a retried tick never spams a merchant.
 */
export class KybExpiryWorker extends BaseWorker {
  protected async tick(): Promise<void> {
    const now = this.clock();
    const db = this.db as unknown as PrismaClient;
    const policy = await readKybRefreshPolicy(db);
    await this.markExpiredDocuments(db, now);
    await this.sendExpiryNotices(db, now);
    await this.suspendMerchantsWithExpiredRequiredDocuments(db, now, policy.expiryGraceDays);
    await this.startPeriodicRevalidations(db, now);
    await this.expireOverdueRevalidations(db, now);
  }

  private async markExpiredDocuments(db: PrismaClient, now: Date): Promise<void> {
    const today = startOfUtcDay(now);
    const documents = await db.kybDocument.findMany({
      where: {
        status: { in: ["ACCEPTED", "UPLOADED"] },
        expiresOn: { lt: today },
      },
      select: { id: true, merchantId: true, status: true, expiresOn: true, joinRequestId: true },
      take: this.batchSize,
      orderBy: { expiresOn: "asc" },
    });
    if (documents.length === 0) return;
    await db.$transaction(async (tx) => {
      const actorId = await ensureSystemAutomationUser(tx as never);
      for (const document of documents) {
        const changed = await tx.kybDocument.updateMany({
          where: { id: document.id, status: { in: ["ACCEPTED", "UPLOADED"] } },
          data: { status: "EXPIRED", statusChangedAt: now, expiredAt: now },
        });
        if (changed.count === 0) continue;
        await createAuditLog(tx, {
          data: {
            actorId,
            role: "SYSTEM",
            action: "KYB_DOCUMENT_EXPIRED",
            entityType: "KYB_DOCUMENT",
            entityId: document.id,
            beforeJson: {
              status: document.status,
              expiresOn: document.expiresOn?.toISOString() ?? null,
              joinRequestId: document.joinRequestId,
            },
            afterJson: { status: "EXPIRED", expiredAt: now.toISOString() },
          },
        });
      }
    });
    this.logger.info("KybExpiryWorker: marked expired documents", {
      expired: documents.length,
    });
  }

  private async sendExpiryNotices(db: PrismaClient, now: Date): Promise<void> {
    const today = startOfUtcDay(now);
    const afterSevenDays = new Date(today.getTime() + 7 * 86_400_000);
    const afterThirtyDays = new Date(today.getTime() + 30 * 86_400_000);
    const ranges: Array<{
      days: 30 | 7;
      field: "expiryNotice30SentAt" | "expiryNotice7SentAt";
      gte: Date;
      lte: Date;
    }> = [
      { days: 30, field: "expiryNotice30SentAt", gte: new Date(afterSevenDays.getTime() + 86_400_000), lte: afterThirtyDays },
      { days: 7, field: "expiryNotice7SentAt", gte: today, lte: afterSevenDays },
    ];
    for (const range of ranges) {
      const documents = await db.kybDocument.findMany({
        where: {
          status: "ACCEPTED",
          expiresOn: { gte: range.gte, lte: range.lte },
          [range.field]: null,
        },
        select: { id: true, merchantId: true, docType: true, expiresOn: true },
        take: this.batchSize,
        orderBy: { expiresOn: "asc" },
      });
      for (const document of documents) {
        await queueKybNotification(db, {
          merchantId: document.merchantId,
          code: "KYB_DOC_EXPIRING",
          payload: {
            documentType: document.docType,
            expiresOn: document.expiresOn?.toISOString().slice(0, 10) ?? "",
            daysUntilExpiry: daysUntilExpiry(document.expiresOn, now),
          },
          eventKey: `expiring:${document.id}:${range.days}`,
        });
        await db.kybDocument.update({
          where: { id: document.id },
          data: { [range.field]: now },
        });
      }
      if (documents.length > 0) {
        this.logger.info("KybExpiryWorker: queued expiry notices", {
          days: range.days,
          documents: documents.length,
        });
      }
    }
  }

  private async suspendMerchantsWithExpiredRequiredDocuments(
    db: PrismaClient,
    now: Date,
    graceDays: number,
  ): Promise<void> {
    const cutoff = new Date(startOfUtcDay(now).getTime() - graceDays * 86_400_000);
    const merchants = await db.merchant.findMany({
      where: { status: "ACTIVE" },
      select: {
        id: true,
        legalName: true,
        tradeName: true,
        businessCategory: true,
        riskTier: true,
        kybStatus: true,
      },
      take: this.batchSize,
      orderBy: { id: "asc" },
    });
    for (const merchant of merchants) {
      const [requiredDocuments, documents] = await Promise.all([
        readRequiredDocuments(db, merchant.businessCategory),
        db.kybDocument.findMany({
          where: { merchantId: merchant.id },
          select: { id: true, docType: true, status: true, expiresOn: true },
        }),
      ]);
      const today = startOfUtcDay(now);
      const validAcceptedTypes = new Set(
        documents
          .filter(
            (document) =>
              document.status === "ACCEPTED"
              && (!document.expiresOn || startOfUtcDay(document.expiresOn).getTime() >= today.getTime()),
          )
          .map((document) => String(document.docType)),
      );
      const expiredBeyondGrace = documents.filter(
        (document) =>
          ["ACCEPTED", "EXPIRED"].includes(String(document.status))
          && document.expiresOn
          && startOfUtcDay(document.expiresOn).getTime() < cutoff.getTime()
          && requiredDocuments.includes(String(document.docType)),
      );
      const blocking = expiredBeyondGrace.filter((document) => !validAcceptedTypes.has(String(document.docType)));
      if (blocking.length === 0) continue;
      const changed = await db.$transaction(async (tx) => {
        const updated = await tx.merchant.updateMany({
          where: { id: merchant.id, status: "ACTIVE" },
          data: {
            status: "SUSPENDED",
            kybStatus: "PENDING",
            suspendedAt: now,
            suspensionReasonCode: "KYB_EXPIRED",
            version: { increment: 1 },
          },
        });
        if (updated.count === 0) return false;
        const actorId = await ensureSystemAutomationUser(tx as never);
        await createAuditLog(tx, {
          data: {
            actorId,
            role: "SYSTEM",
            action: "MERCHANT_SUSPENDED_KYB_EXPIRED",
            entityType: "MERCHANT",
            entityId: merchant.id,
            beforeJson: { status: "ACTIVE", kybStatus: merchant.kybStatus },
            afterJson: {
              status: "SUSPENDED",
              kybStatus: "PENDING",
              reasonCode: "KYB_EXPIRED",
              expiredDocumentIds: blocking.map((document) => document.id),
            },
          },
        });
        return true;
      });
      if (changed) {
        await queueKybNotification(db, {
          merchantId: merchant.id,
          code: "KYB_EXPIRED_SUSPENSION",
          payload: {
            merchantName: merchant.tradeName || merchant.legalName,
            documentTypes: [...new Set(blocking.map((document) => document.docType))],
          },
          eventKey: `expired-suspension:${merchant.id}:${startOfUtcDay(now).toISOString().slice(0, 10)}`,
        });
        this.logger.info("KybExpiryWorker: suspended merchant for expired KYB", {
          merchantId: merchant.id,
          documents: blocking.map((document) => document.id),
        });
      }
    }
  }

  private async startPeriodicRevalidations(db: PrismaClient, now: Date): Promise<void> {
    const due = await db.merchant.findMany({
      where: { status: "ACTIVE", nextKybReviewAt: { lte: now } },
      select: { id: true, businessCategory: true, riskTier: true, nextKybReviewAt: true },
      take: this.batchSize,
      orderBy: { nextKybReviewAt: "asc" },
    });
    const policy = await readKybRefreshPolicy(db);
    for (const merchant of due) {
      const [requiredDocuments, documents, openRequests] = await Promise.all([
        readRequiredDocuments(db, merchant.businessCategory),
        db.kybDocument.findMany({
          where: { merchantId: merchant.id, status: "ACCEPTED" },
          orderBy: { createdAt: "desc" },
        }),
        db.kybRevalidationRequest.findMany({
          where: { merchantId: merchant.id, status: "OPEN" },
          select: { docType: true },
        }),
      ]);
      const alreadyOpen = new Set(openRequests.map((request) => String(request.docType)));
      const latestByType = new Map<string, (typeof documents)[number]>();
      for (const document of documents) {
        const type = String(document.docType);
        if (!latestByType.has(type)) latestByType.set(type, document);
      }
      const created: Array<{ id: string; docType: string }> = [];
      await db.$transaction(async (tx) => {
        const actorId = await ensureSystemAutomationUser(tx as never);
        for (const docType of requiredDocuments) {
          if (alreadyOpen.has(docType)) continue;
          const source = latestByType.get(docType);
          if (!source) continue;
          const request = await tx.kybRevalidationRequest.create({
            data: {
              merchantId: merchant.id,
              documentId: source.id,
              docType: docType as never,
              reasonCode: "PERIODIC_REVIEW",
              message: `Periodic KYB re-verification is due for ${docType}. Please upload a current document.`,
              status: "OPEN",
              requestedById: actorId,
              requestedAt: now,
              dueAt: new Date(now.getTime() + policy.revalidationDueDays * 86_400_000),
            },
          });
          created.push({ id: request.id, docType });
          await createAuditLog(tx, {
            data: {
              actorId,
              role: "SYSTEM",
              action: "KYB_REVALIDATION_SCHEDULED",
              entityType: "KYB_REVALIDATION_REQUEST",
              entityId: request.id,
              beforeJson: {},
              afterJson: { merchantId: merchant.id, docType, sourceDocumentId: source.id },
            },
          });
        }
        await tx.merchant.update({
          where: { id: merchant.id },
          data: {
            ...(created.length > 0 ? { kybStatus: "PENDING" } : {}),
            nextKybReviewAt: nextKybReviewAt(merchant.riskTier, now, policy),
            version: { increment: 1 },
          },
        });
      });
      for (const request of created) {
        await queueKybNotification(db, {
          merchantId: merchant.id,
          code: "KYB_REVALIDATION_DUE",
          payload: { documentType: request.docType },
          eventKey: `revalidation-due:${request.id}`,
        });
      }
      if (created.length > 0) {
        this.logger.info("KybExpiryWorker: scheduled periodic KYB revalidation", {
          merchantId: merchant.id,
          requests: created.length,
        });
      }
    }
  }

  private async expireOverdueRevalidations(db: PrismaClient, now: Date): Promise<void> {
    const overdue = await db.kybRevalidationRequest.findMany({
      where: { status: "OPEN", dueAt: { lt: now } },
      select: { id: true, merchantId: true, docType: true },
      take: this.batchSize,
    });
    for (const request of overdue) {
      const changed = await db.kybRevalidationRequest.updateMany({
        where: { id: request.id, status: "OPEN" },
        data: { status: "EXPIRED" },
      });
      if (changed.count === 0) continue;
      await db.$transaction(async (tx) => {
        const actorId = await ensureSystemAutomationUser(tx as never);
        await createAuditLog(tx, {
          data: {
            actorId,
            role: "SYSTEM",
            action: "KYB_REVALIDATION_EXPIRED",
            entityType: "KYB_REVALIDATION_REQUEST",
            entityId: request.id,
            beforeJson: { status: "OPEN" },
            afterJson: { status: "EXPIRED", merchantId: request.merchantId, docType: request.docType },
          },
        });
      });
    }
    if (overdue.length > 0) {
      this.logger.info("KybExpiryWorker: expired overdue revalidation requests", {
        expired: overdue.length,
      });
    }
  }
}
