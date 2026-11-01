import type { PrismaClient } from "../generated/prisma/client";
import { readOwnerThreshold, readRequiredDocuments } from "./joinRequestOnboarding";

export const KYB_DOCUMENT_REJECTION_REASONS = [
  "BLURRY_OR_UNREADABLE",
  "EXPIRED_DOCUMENT",
  "WRONG_DOCUMENT_TYPE",
  "NAME_MISMATCH",
  "INCOMPLETE_DOCUMENT",
  "DUPLICATE_REUSE",
  "REPLACEMENT_REQUESTED",
  "OTHER",
] as const;

export type KybDocumentRejectionReason = (typeof KYB_DOCUMENT_REJECTION_REASONS)[number];

export type KybExpiryState = "EXPIRED" | "DUE_SOON" | "VALID" | "NONE";

export const KYB_EXPIRY_WARNING_DAYS = 30;

export const startOfUtcDay = (value: Date): Date =>
  new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));

export const daysUntilExpiry = (
  expiresOn: Date | null | undefined,
  now: Date = new Date(),
): number | null => {
  if (!expiresOn) return null;
  const oneDay = 86_400_000;
  return Math.ceil(
    (startOfUtcDay(expiresOn).getTime() - startOfUtcDay(now).getTime()) / oneDay,
  );
};

export const expiryState = (
  expiresOn: Date | null | undefined,
  now: Date = new Date(),
): KybExpiryState => {
  const days = daysUntilExpiry(expiresOn, now);
  if (days === null) return "NONE";
  if (days < 0) return "EXPIRED";
  if (days <= KYB_EXPIRY_WARNING_DAYS) return "DUE_SOON";
  return "VALID";
};

export const isKybDocumentActionable = (document: {
  status: string;
  avStatus: string;
  expiresOn?: Date | null;
}, now: Date = new Date()): boolean =>
  document.status === "UPLOADED"
  && document.avStatus === "CLEAN"
  && expiryState(document.expiresOn ?? null, now) !== "EXPIRED";

export const duplicateJustificationRequired = (input: {
  decision: "ACCEPTED" | "REJECTED";
  duplicateMerchantCount: number;
  justification?: string | null;
}): boolean =>
  input.decision === "ACCEPTED"
  && input.duplicateMerchantCount > 0
  && (input.justification ?? "").trim().length < 10;

export const normalizeEntityName = (value: string | null | undefined): string =>
  (value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("en")
    .replaceAll(/[^\p{L}\p{N}]+/gu, "");

export const payoutOwnerMismatch = (input: {
  payoutBankDetails: unknown;
  legalName: string | null | undefined;
  tradeName: string | null | undefined;
}): boolean => {
  if (!input.payoutBankDetails || typeof input.payoutBankDetails !== "object" || Array.isArray(input.payoutBankDetails)) {
    return false;
  }
  const source = input.payoutBankDetails as Record<string, unknown>;
  const holder = normalizeEntityName(String(source.holder ?? source.accountHolder ?? source.account_holder ?? ""));
  if (!holder) return false;
  const legal = normalizeEntityName(input.legalName);
  const trade = normalizeEntityName(input.tradeName);
  return holder !== legal && holder !== trade;
};

export const DEFAULT_KYB_REFRESH_POLICY = {
  lowMonths: 36,
  standardMonths: 24,
  highMonths: 12,
  expiryGraceDays: 30,
  revalidationDueDays: 30,
  duplicateAmlThreshold: 3,
} as const;

export type KybRefreshPolicy = {
  lowMonths: number;
  standardMonths: number;
  highMonths: number;
  expiryGraceDays: number;
  revalidationDueDays: number;
  duplicateAmlThreshold: number;
};

const positiveNumber = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

export const parseKybRefreshPolicy = (value: unknown): KybRefreshPolicy => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...DEFAULT_KYB_REFRESH_POLICY };
  }
  const source = value as Record<string, unknown>;
  return {
    lowMonths: positiveNumber(source.lowMonths ?? source.low_months) ?? DEFAULT_KYB_REFRESH_POLICY.lowMonths,
    standardMonths: positiveNumber(source.standardMonths ?? source.standard_months) ?? DEFAULT_KYB_REFRESH_POLICY.standardMonths,
    highMonths: positiveNumber(source.highMonths ?? source.high_months) ?? DEFAULT_KYB_REFRESH_POLICY.highMonths,
    expiryGraceDays: positiveNumber(source.expiryGraceDays ?? source.expiry_grace_days) ?? DEFAULT_KYB_REFRESH_POLICY.expiryGraceDays,
    revalidationDueDays: positiveNumber(source.revalidationDueDays ?? source.revalidation_due_days) ?? DEFAULT_KYB_REFRESH_POLICY.revalidationDueDays,
    duplicateAmlThreshold: positiveNumber(source.duplicateAmlThreshold ?? source.duplicate_aml_threshold) ?? DEFAULT_KYB_REFRESH_POLICY.duplicateAmlThreshold,
  };
};

export const readKybRefreshPolicy = async (db: PrismaClient): Promise<KybRefreshPolicy> => {
  const setting = await db.platformSetting.findFirst({
    where: { key: "kyb.refresh_policy" },
    orderBy: { version: "desc" },
  });
  return parseKybRefreshPolicy(setting?.valueJson);
};

export const nextKybReviewAt = (
  riskTier: string | null | undefined,
  from: Date,
  policy: KybRefreshPolicy = DEFAULT_KYB_REFRESH_POLICY,
): Date => {
  const tier = (riskTier ?? "STANDARD").toUpperCase();
  const months = tier === "HIGH" ? policy.highMonths : tier === "LOW" ? policy.lowMonths : policy.standardMonths;
  const next = new Date(from.getTime());
  next.setUTCMonth(next.getUTCMonth() + months);
  return next;
};

export const secondsBetween = (from: Date, to: Date): number =>
  Math.max(0, Math.floor((to.getTime() - from.getTime()) / 1000));

export const mergeInfoRequestItems = (
  current: unknown,
  items: Array<{ field: string; message: string }>,
): Array<{ field: string; message: string }> => {
  const existing = Array.isArray(current)
    ? current
        .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
        .map((entry) => ({ field: String(entry.field ?? ""), message: String(entry.message ?? "") }))
        .filter((entry) => entry.field.length > 0)
    : [];
  const merged = new Map(existing.map((entry) => [`${entry.field}:${entry.message}`, entry]));
  for (const item of items) {
    merged.set(`${item.field}:${item.message}`, item);
  }
  return [...merged.values()];
};


/**
 * Recomputes `merchants.kyb_status` from the current accepted, unexpired
 * required documents and the active beneficial owners.
 *
 * It only changes merchants that are already ACTIVE: the onboarding lifecycle
 * owns PENDING/REJECTED transitions, and a SUSPENDED merchant stays suspended
 * until the reinstatement workflow runs.
 */
export const recomputeMerchantKybStatus = async (
  db: PrismaClient,
  merchantId: string,
  now: Date = new Date(),
): Promise<string | null> => {
  const merchant = await db.merchant.findUnique({
    where: { id: merchantId },
    select: { id: true, status: true, kybStatus: true, businessCategory: true },
  });
  if (!merchant || merchant.status !== "ACTIVE") {
    return merchant?.kybStatus ?? null;
  }
  const [requiredDocuments, ownerThreshold, documents, owners] = await Promise.all([
    readRequiredDocuments(db, merchant.businessCategory),
    readOwnerThreshold(db),
    db.kybDocument.findMany({
      where: { merchantId },
      select: { id: true, docType: true, status: true, expiresOn: true },
    }),
    db.beneficialOwner.findMany({
      where: { merchantId, active: true },
      select: { ownershipPercent: true, screeningStatus: true },
    }),
  ]);
  const today = startOfUtcDay(now);
  const acceptedTypes = new Set(
    documents
      .filter(
        (document) =>
          document.status === "ACCEPTED"
          && (!document.expiresOn || startOfUtcDay(document.expiresOn).getTime() >= today.getTime()),
      )
      .map((document) => String(document.docType)),
  );
  const documentsReady = requiredDocuments.every((type) => acceptedTypes.has(type));
  const ownersTotal = owners.reduce((sum, owner) => sum + Number(owner.ownershipPercent ?? 0), 0);
  const ownersReady = owners.length > 0
    && ownersTotal >= ownerThreshold
    && owners.every(
      (owner) => owner.screeningStatus !== "NOT_SCREENED" && owner.screeningStatus !== "CONFIRMED_MATCH",
    );
  const nextStatus = documentsReady && ownersReady ? "VERIFIED" : "PENDING";
  if (merchant.kybStatus !== nextStatus) {
    await db.merchant.update({ where: { id: merchantId }, data: { kybStatus: nextStatus } });
  }
  return nextStatus;
};

export const distinctDuplicateMerchantIds = async (
  db: PrismaClient,
  sha256: string,
  excludingMerchantId: string,
): Promise<string[]> => {
  const rows = await db.kybDocument.findMany({
    where: { sha256, merchantId: { not: excludingMerchantId } },
    select: { merchantId: true },
    distinct: ["merchantId"],
  });
  return rows.map((row) => row.merchantId);
};
