import { createHash } from "node:crypto";
import type { PrismaClient } from "../generated/prisma/client";

export const JOIN_REQUEST_CHECKLIST_KEYS = [
  "Identity Verified",
  "Business Existence Verified",
  "Beneficial Owners Identified",
  "Screening Result Reviewed",
  "Category And Volume Consistent",
  "Payout Account Ownership Verified",
  "Risk Tier Assigned",
] as const;

export const DEFAULT_REQUIRED_KYB_DOCUMENTS = [
  "COMMERCIAL_REGISTRY",
  "TAX_CERTIFICATE",
  "BANK_LETTER",
  "PROOF_OF_ADDRESS",
] as const;

export const normalizePhone = (value: string): string =>
  value.replace(/[\s\-().]/g, "").replace(/^218/, "0");

export const normalizeEmail = (value: string): string => value.trim().toLowerCase();

const normalizeIdentity = (value: string): string =>
  value.trim().replace(/[\s-]/g, "").toUpperCase();

export const sha256Hex = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

export const nationalIdHash = (value: string | null | undefined): string | null => {
  const normalized = normalizeIdentity(value ?? "");
  return normalized.length > 0 ? sha256Hex(`kyb-national-id:${normalized}`) : null;
};

export const payoutAccountHash = (value: unknown): string | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const account = String(
    source.iban ?? source.accountNumber ?? source.account ?? source.account_number ?? "",
  ).trim();
  if (!account) return null;
  const bank = String(source.bank ?? source.bankName ?? source.bank_name ?? "").trim();
  return sha256Hex(`payout-account:${normalizeIdentity(bank)}:${normalizeIdentity(account)}`);
};

export type ProfileInput = {
  legalName?: string;
  tradeName?: string;
  country?: string;
  businessCategory?: string;
  registrationNumber?: string;
  taxId?: string;
  registeredAddress?: string;
  websiteUrl?: string;
  contactPhone?: string;
  contactEmail?: string;
  expectedMonthlyVolume?: string;
  currency?: string;
  businessUseDescription?: string;
};

export const buildProfileJson = (input: ProfileInput, existing?: unknown): Record<string, unknown> => {
  const current = existing && typeof existing === "object" && !Array.isArray(existing)
    ? (existing as Record<string, unknown>)
    : {};
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) next[key] = value;
  }
  return next;
};

export type DuplicateFlag = {
  type: "DUPLICATE_DOCUMENT" | "DUPLICATE_OR_RELATED";
  field: string;
  matchedMerchantId?: string;
  matchedDocumentId?: string;
  matchedOwnerId?: string;
  valueHash?: string;
};

export const detectDuplicateFlags = async (
  db: PrismaClient,
  input: {
    merchantId: string;
    joinRequestId: string;
    taxId?: string | null;
    registrationNo?: string | null;
    contactPhone?: string | null;
    contactEmail?: string | null;
    payoutHash?: string | null;
    ownerHashes?: string[];
    documentHashes?: string[];
  },
): Promise<DuplicateFlag[]> => {
  const flags: DuplicateFlag[] = [];
  const matches = new Map<string, DuplicateFlag>();
  const add = (flag: DuplicateFlag) => {
    const key = `${flag.type}:${flag.field}:${flag.matchedMerchantId ?? ""}:${flag.matchedDocumentId ?? ""}:${flag.matchedOwnerId ?? ""}`;
    if (!matches.has(key)) {
      matches.set(key, flag);
      flags.push(flag);
    }
  };

  const or: Record<string, unknown>[] = [];
  if (input.taxId) or.push({ taxId: input.taxId });
  if (input.registrationNo) or.push({ registrationNo: input.registrationNo });
  if (input.contactPhone) or.push({ contactPhone: input.contactPhone });
  if (input.contactEmail) or.push({ contactEmail: normalizeEmail(input.contactEmail) });
  if (input.payoutHash) or.push({ payoutAccountHash: input.payoutHash });
  if (or.length > 0) {
    const merchants = await db.merchant.findMany({
      where: { id: { not: input.merchantId }, OR: or as never },
      select: {
        id: true,
        taxId: true,
        registrationNo: true,
        contactPhone: true,
        contactEmail: true,
        payoutAccountHash: true,
      },
    });
    for (const merchant of merchants) {
      if (input.taxId && merchant.taxId === input.taxId) {
        add({ type: "DUPLICATE_OR_RELATED", field: "taxId", matchedMerchantId: merchant.id });
      }
      if (input.registrationNo && merchant.registrationNo === input.registrationNo) {
        add({ type: "DUPLICATE_OR_RELATED", field: "registrationNo", matchedMerchantId: merchant.id });
      }
      if (input.contactPhone && merchant.contactPhone === input.contactPhone) {
        add({ type: "DUPLICATE_OR_RELATED", field: "contactPhone", matchedMerchantId: merchant.id });
      }
      if (input.contactEmail && merchant.contactEmail === normalizeEmail(input.contactEmail)) {
        add({ type: "DUPLICATE_OR_RELATED", field: "contactEmail", matchedMerchantId: merchant.id });
      }
      if (input.payoutHash && merchant.payoutAccountHash === input.payoutHash) {
        add({ type: "DUPLICATE_OR_RELATED", field: "payoutAccount", matchedMerchantId: merchant.id });
      }
    }
  }

  const ownerHashes = (input.ownerHashes ?? []).filter((entry): entry is string => Boolean(entry));
  if (ownerHashes.length > 0) {
    const owners = await db.beneficialOwner.findMany({
      where: {
        merchantId: { not: input.merchantId },
        nationalIdHash: { in: ownerHashes },
      },
      select: { id: true, merchantId: true, nationalIdHash: true },
    });
    for (const owner of owners) {
      add({
        type: "DUPLICATE_OR_RELATED",
        field: "ownerNationalId",
        matchedMerchantId: owner.merchantId,
        matchedOwnerId: owner.id,
        valueHash: owner.nationalIdHash ?? undefined,
      });
    }
  }

  const documentHashes = (input.documentHashes ?? []).filter((entry): entry is string => Boolean(entry));
  if (documentHashes.length > 0) {
    const documents = await db.kybDocument.findMany({
      where: {
        merchantId: { not: input.merchantId },
        sha256: { in: documentHashes },
      },
      select: { id: true, merchantId: true, sha256: true },
    });
    for (const document of documents) {
      add({
        type: "DUPLICATE_DOCUMENT",
        field: "documentSha256",
        matchedMerchantId: document.merchantId,
        matchedDocumentId: document.id,
        valueHash: document.sha256,
      });
    }
  }

  return flags;
};

const readRequiredDocuments = async (db: PrismaClient): Promise<string[]> => {
  const setting = await db.platformSetting.findFirst({
    where: { key: "onboarding.required_documents" },
    orderBy: { version: "desc" },
  });
  const value = setting?.valueJson as Record<string, unknown> | undefined;
  if (Array.isArray(value?.default)) {
    return value.default.map(String);
  }
  return [...DEFAULT_REQUIRED_KYB_DOCUMENTS];
};

const readOwnerThreshold = async (db: PrismaClient): Promise<number> => {
  const setting = await db.platformSetting.findFirst({
    where: { key: "join_request.four_eyes_policy" },
    orderBy: { version: "desc" },
  });
  const value = setting?.valueJson as Record<string, unknown> | undefined;
  const threshold = Number(value?.ownerThresholdPercent ?? value?.owner_threshold_percent);
  return Number.isFinite(threshold) && threshold > 0 ? threshold : 25;
};

export type JoinRequestReadiness = {
  ready: boolean;
  blockers: string[];
  checklistComplete: boolean;
  requiredDocuments: string[];
  acceptedDocuments: string[];
  missingDocuments: string[];
  expiredDocuments: string[];
  ownersTotal: number;
  ownerThreshold: number;
  ownersReady: boolean;
  screeningResult: string | null;
  screeningBlocked: boolean;
  duplicateFlags: DuplicateFlag[];
  approvalPending: boolean;
  payoutBankReady: boolean;
};

export const computeJoinRequestReadiness = async (
  db: PrismaClient,
  joinRequestId: string,
): Promise<JoinRequestReadiness> => {
  const joinRequest = await db.joinRequest.findUnique({
    where: { id: joinRequestId },
    include: {
      merchant: true,
      screening: { include: { matches: true, amlCases: true } },
      kybDocuments: true,
      approvalRequest: true,
    },
  });
  if (!joinRequest) {
    throw new Error(`Join request '${joinRequestId}' does not exist`);
  }
  const [requiredDocuments, ownerThreshold, activeOwners] = await Promise.all([
    readRequiredDocuments(db),
    readOwnerThreshold(db),
    db.beneficialOwner.findMany({ where: { merchantId: joinRequest.merchantId, active: true } }),
  ]);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const acceptedDocuments = joinRequest.kybDocuments.filter(
    (doc) => doc.status === "ACCEPTED" && (!doc.expiresOn || doc.expiresOn.getTime() >= today.getTime()),
  );
  const acceptedTypes = new Set(acceptedDocuments.map((doc) => String(doc.docType)));
  const missingDocuments = requiredDocuments.filter((type) => !acceptedTypes.has(type));
  const expiredDocuments = joinRequest.kybDocuments
    .filter(
      (doc) =>
        ["ACCEPTED", "EXPIRED"].includes(String(doc.status))
        && doc.expiresOn
        && doc.expiresOn.getTime() < today.getTime()
        && requiredDocuments.includes(String(doc.docType))
        && !acceptedTypes.has(String(doc.docType)),
    )
    .map((doc) => doc.id);
  const ownersTotal = activeOwners.reduce((sum, owner) => sum + Number(owner.ownershipPercent ?? 0), 0);
  const ownersReady = activeOwners.length > 0 && ownersTotal >= ownerThreshold;
  const ownersScreened = activeOwners.every(
    (owner) => ["CLEAR", "POTENTIAL_MATCH"].includes(String(owner.screeningStatus))
      && owner.screeningStatus !== "NOT_SCREENED",
  );
  const screeningResult = joinRequest.screening?.result ? String(joinRequest.screening.result) : null;
  const pendingMatches = joinRequest.screening?.matches.filter((match) => match.disposition === "UNREVIEWED") ?? [];
  const openAmlCases = joinRequest.screening?.amlCases.filter(
    (amlCase) => !["RELEASED", "REJECTED_VOID"].includes(String(amlCase.status)),
  ) ?? [];
  const screeningBlocked = !screeningResult
    || screeningResult === "ERROR"
    || screeningResult === "CONFIRMED_MATCH"
    || (screeningResult === "POTENTIAL_MATCH" && pendingMatches.length > 0)
    || openAmlCases.length > 0
    || !ownersScreened;
  const checklist = (joinRequest.reviewChecklistJson ?? {}) as Record<string, unknown>;
  const checklistComplete = JOIN_REQUEST_CHECKLIST_KEYS.every((key) => checklist[key] === true);
  const payoutBankReady = Boolean(joinRequest.merchant.payoutBankDetailsJson);
  const duplicateFlags = Array.isArray(joinRequest.duplicateFlagsJson)
    ? (joinRequest.duplicateFlagsJson as unknown as DuplicateFlag[])
    : [];

  const blockers: string[] = [];
  if (missingDocuments.length > 0) blockers.push("MISSING_REQUIRED_DOCUMENTS");
  if (expiredDocuments.length > 0) blockers.push("EXPIRED_REQUIRED_DOCUMENTS");
  if (!ownersReady) blockers.push("BENEFICIAL_OWNERS_NOT_READY");
  if (!ownersScreened) blockers.push("BENEFICIAL_OWNER_SCREENING_INCOMPLETE");
  if (screeningBlocked) blockers.push("SCREENING_NOT_CLEAR");
  if (!checklistComplete) blockers.push("REVIEW_CHECKLIST_INCOMPLETE");
  if (!payoutBankReady) blockers.push("PAYOUT_BANK_MISSING");
  const approvalPending = joinRequest.approvalRequest?.state === "PENDING_REVIEW";

  return {
    ready: blockers.length === 0,
    blockers,
    checklistComplete,
    requiredDocuments,
    acceptedDocuments: [...acceptedTypes],
    missingDocuments,
    expiredDocuments,
    ownersTotal,
    ownerThreshold,
    ownersReady,
    screeningResult,
    screeningBlocked,
    duplicateFlags,
    approvalPending,
    payoutBankReady,
  };
};
