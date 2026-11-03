import { ApiError } from "./error";
import type { PrismaClient } from "../generated/prisma/client";
import { decimal } from "../engine/ledger/LedgerPoster";
import { loadShardBalanceRows, naturalShardBalance } from "./storageEngine/shardBalances";

export const MERCHANT_DESCRIPTIVE_FIELDS = [
  "tradeName",
  "displayName",
  "logoUrl",
  "supportEmail",
  "supportPhone",
] as const;

export const MERCHANT_CONTACT_FIELDS = ["contactEmail", "contactPhone"] as const;

export const MERCHANT_SENSITIVE_FIELDS = [
  "legalName",
  "taxId",
  "registrationNo",
  "businessCategory",
  "payoutBankDetailsJson",
  "riskTier",
  "kybStatus",
  "commissionReceivableCeiling",
  "negativeBalanceCeiling",
  "contactEmail",
  "contactPhone",
] as const;

export const MERCHANT_PATCH_FIELDS = [
  ...MERCHANT_DESCRIPTIVE_FIELDS,
  ...MERCHANT_CONTACT_FIELDS,
  ...MERCHANT_SENSITIVE_FIELDS,
  "status",
] as const;

export const MERCHANT_SENSITIVE_FIELD_SET = new Set<string>(MERCHANT_SENSITIVE_FIELDS);
export const MERCHANT_PATCH_FIELD_SET = new Set<string>(MERCHANT_PATCH_FIELDS);

export const MERCHANT_SUSPENSION_REASON_CODES = [
  "AML",
  "FRAUD",
  "KYB_EXPIRED",
  "COMMISSION_CEILING",
  "MERCHANT_REQUEST",
  "OTHER",
] as const;

export const MERCHANT_CLOSE_REASON_CODES = [
  "MERCHANT_REQUEST",
  "COMPLIANCE",
  "BUSINESS_CLOSED",
  "OTHER",
] as const;

export type MerchantSuspensionReason = (typeof MERCHANT_SUSPENSION_REASON_CODES)[number];
export type MerchantCloseReason = (typeof MERCHANT_CLOSE_REASON_CODES)[number];

export type MerchantPatchOperation = {
  op: string;
  path: string;
  value?: unknown;
  from?: string;
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export const topLevelMerchantField = (path: string): string | null => {
  if (!path.startsWith("/")) return null;
  const segment = path.slice(1).split("/")[0] ?? "";
  if (!segment) return null;
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
};

export const merchantPatchOperations = (payload: unknown): MerchantPatchOperation[] => {
  const source = Array.isArray(payload)
    ? payload
    : asRecord(payload).patch;
  if (!Array.isArray(source)) {
    throw new ApiError(400, "MERCHANT_PATCH_INVALID", "The merchant patch must be an array");
  }
  return source.map((entry) => {
    const operation = asRecord(entry);
    if (typeof operation.op !== "string" || typeof operation.path !== "string") {
      throw new ApiError(400, "MERCHANT_PATCH_INVALID", "Every merchant patch operation needs op and path");
    }
    return {
      op: operation.op,
      path: operation.path,
      ...(operation.value === undefined ? {} : { value: operation.value }),
      ...(operation.from === undefined ? {} : { from: String(operation.from) }),
    };
  });
};

export const assertMerchantPatchFields = (
  operations: readonly MerchantPatchOperation[],
  allowed: ReadonlySet<string>,
): void => {
  const invalid = operations
    .map((operation) => topLevelMerchantField(operation.path))
    .filter((field): field is string => Boolean(field))
    .filter((field) => !allowed.has(field));
  if (invalid.length > 0) {
    throw new ApiError(400, "MERCHANT_PATCH_FIELD_FORBIDDEN", "The patch contains a field that cannot be edited here", {
      fields: [...new Set(invalid)],
    });
  }
  const nested = operations
    .map((operation) => operation.path)
    .filter((path) => path.split("/").length > 2);
  if (nested.length > 0) {
    throw new ApiError(400, "MERCHANT_PATCH_NESTED_PATH", "Merchant fields are edited at the top level only", {
      paths: nested,
    });
  }
};

export const hasSensitiveMerchantAccess = (authorities: readonly string[]): boolean =>
  authorities.includes("*")
  || authorities.includes("merchant:write")
  || authorities.includes("compliance:read")
  || authorities.includes("compliance:write");

export const hasMerchantAmlAccess = (authorities: readonly string[]): boolean =>
  authorities.includes("*")
  || authorities.includes("aml:read")
  || authorities.includes("aml:write")
  || authorities.includes("compliance:read")
  || authorities.includes("compliance:write");

export const hasMerchantFinancialAccess = (authorities: readonly string[]): boolean =>
  authorities.includes("*")
  || authorities.includes("merchant:write")
  || authorities.includes("finance:read")
  || authorities.includes("finance:write");

export const merchantVersion = (merchant: { version?: unknown }): number => {
  const parsed = Number(merchant.version);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
};

export const assertMerchantVersion = (
  merchant: { version?: unknown },
  baseVersion: unknown,
): void => {
  if (baseVersion === undefined || baseVersion === null) return;
  const expected = Number(baseVersion);
  if (!Number.isInteger(expected) || expected < 1) {
    throw new ApiError(400, "MERCHANT_BASE_VERSION_INVALID", "The base version is invalid");
  }
  if (expected !== merchantVersion(merchant)) {
    throw new ApiError(409, "MERCHANT_VERSION_CONFLICT", "The merchant changed after this form was opened", {
      expected,
      current: merchantVersion(merchant),
    });
  }
};

export const assertMerchantSuspendable = (status: string): void => {
  if (status !== "ACTIVE") {
    throw new ApiError(409, "MERCHANT_NOT_SUSPENDABLE", "Only an active merchant can be suspended");
  }
};

export const assertMerchantReinstatable = (status: string): void => {
  if (status !== "SUSPENDED") {
    throw new ApiError(409, "MERCHANT_NOT_REINSTATABLE", "Only a suspended merchant can be reinstated");
  }
};

export const assertMerchantClosable = (status: string): void => {
  if (!["ACTIVE", "SUSPENDED"].includes(status)) {
    throw new ApiError(409, "MERCHANT_NOT_CLOSABLE", "Only an active or suspended merchant can be closed");
  }
};

export const merchantWalletBalance = async (
  db: PrismaClient,
  merchantId: string,
): Promise<{ balance: string; wallets: Array<{ id: string; walletId: string; currency: string; status: string; balance: string }> }> => {
  const wallets = await db.wallet.findMany({
    where: { merchantId },
    orderBy: { createdAt: "asc" },
    select: { id: true, currency: true, status: true, glAccountId: true },
  });
  if (wallets.length === 0) return { balance: "0.0000", wallets: [] };
  const walletAccountIds = wallets.map((wallet) => wallet.glAccountId);
  const shardRows = await loadShardBalanceRows(db as never, walletAccountIds);
  const shardBalance = new Map(
    shardRows.map((row) => [
      row.id,
      decimal(naturalShardBalance(row.accountType, row.total)),
    ]),
  );
  const missing = walletAccountIds.filter((id) => !shardBalance.has(id));
  if (missing.length > 0) {
    const accounts = await db.glAccount.findMany({
      where: { id: { in: missing } },
      select: { id: true, checkpointBalance: true },
    });
    for (const account of accounts) {
      shardBalance.set(account.id, decimal(account.checkpointBalance ?? 0));
    }
    const lines = await db.journalLine.findMany({
      where: { glAccountId: { in: missing } },
      select: { glAccountId: true, direction: true, amount: true },
    });
    for (const line of lines) {
      const current = shardBalance.get(line.glAccountId) ?? decimal(0);
      const value = decimal(line.amount);
      shardBalance.set(
        line.glAccountId,
        line.direction === "CREDIT" ? current.plus(value) : current.minus(value),
      );
    }
  }
  const rows = wallets.map((wallet) => ({
    id: wallet.id,
    walletId: wallet.id,
    currency: wallet.currency,
    status: String(wallet.status),
    balance: (shardBalance.get(wallet.glAccountId) ?? decimal(0)).toFixed(4),
  }));
  const total = rows.reduce((sum, row) => sum.plus(decimal(row.balance)), decimal(0));
  return { balance: total.toFixed(4), wallets: rows };
};

export const queueMerchantLifecycleNotification = async (
  db: PrismaClient,
  input: {
    merchantId: string;
    code: "MERCHANT_SUSPENDED" | "MERCHANT_REINSTATED" | "MERCHANT_CLOSED";
    payload: Record<string, unknown>;
    eventKey: string;
  },
): Promise<void> => {
  const merchant = await db.merchant.findUnique({
    where: { id: input.merchantId },
    select: { id: true, contactEmail: true, contactPhone: true },
  });
  if (!merchant) return;
  const recipient = await db.user.findFirst({
    where: { merchantId: merchant.id, role: "MERCHANT_ADMIN", status: "ACTIVE" },
    select: { id: true, email: true, phone: true },
  });
  const address = recipient?.email ?? recipient?.phone ?? merchant.contactEmail ?? merchant.contactPhone ?? null;
  const templates: Record<string, { subject: string; body: string }> = {
    MERCHANT_SUSPENDED: {
      subject: "Merchant account suspended",
      body: "Your merchant account is suspended. Please contact support for the next steps.",
    },
    MERCHANT_REINSTATED: {
      subject: "Merchant account reinstated",
      body: "Your merchant account has been reinstated and is active again.",
    },
    MERCHANT_CLOSED: {
      subject: "Merchant account closed",
      body: "Your merchant account has been closed. Please contact support if you need assistance.",
    },
  };
  for (const template of Object.entries(templates)) {
    await db.notificationTemplate.createMany({
      data: [{
        code: template[0],
        channel: "IN_APP",
        lang: "EN",
        subjectTemplate: template[1].subject,
        bodyTemplate: template[1].body,
        confidentialityClass: "MERCHANT",
        version: 1,
        active: true,
      }],
      skipDuplicates: true,
    });
  }
  for (const channel of ["IN_APP", "EMAIL"] as const) {
    try {
      await db.notification.create({
        data: {
          eventId: `merchant:${input.eventKey}:${channel}`,
          recipientUserId: recipient?.id ?? null,
          recipientMerchantId: merchant.id,
          templateCode: input.code,
          channel,
          lang: "EN",
          payloadJson: input.payload as never,
          addressMasked: address
            ? address.includes("@")
              ? `${(address.split("@")[0] ?? "").slice(0, 2)}***@${address.split("@")[1] ?? ""}`
              : `*******${address.slice(-4)}`
            : "merchant-contact",
          addressCiphertext: "",
          status: "QUEUED",
          attempts: 0,
        },
      });
    } catch {
      // event_id uniqueness makes the queue idempotent across retried requests.
    }
  }
};
