/**
 * Admin commerce surface: wallets, applications (and their access tokens),
 * payment links, POS terminals, merchant beneficial owners and KYB
 * re-validation requests.
 *
 * Governance rule (project invariant: sensitive actions use maker-checker):
 *   - a MORE restrictive state is immediate, needs a `reason` (min 10 chars)
 *     and writes an audit record in the same transaction;
 *   - a LESS restrictive state, or a change of what an entity may accept
 *     (rail whitelist, redirect allowlist, settlement wallet), is an approval
 *     request executed by `GovernanceExecution` after a checker (never the
 *     maker) approves it.
 *
 * Authorities are enforced here; the edge BFF checks are advisory. Secrets
 * never leave this module: no token hash, no national id ciphertext, no POS
 * screen token hash.
 */
import express, { type Request, type Response } from "express";
import { z } from "zod";
import { Prisma } from "../../generated/prisma/client";
import { client } from "../../prisma/client";
import { ApiError, parseOrThrow } from "../../lib/error";
import { buildListQuery, csv, listResponse } from "../../lib/listQuery";
import { principalOf, requireAuthorities } from "../middleware/authDoubleCheck";
import { actorFromRequest } from "../middleware/makerCheckerGuard";
import { writeAudit } from "../../lib/audit/writeAudit";
import { APPROVAL_PENDING_STATES, approvalSubjectTypeVariants } from "../../lib/approvalQueue";
import { hasMerchantFinancialAccess, hasSensitiveMerchantAccess } from "../../lib/merchantOps";
import { loadAccountCheckpointSummary, loadLiveAccountBalances } from "../../lib/storageEngine/shardBalances";
import { decimal } from "../../engine/ledger/LedgerPoster";
import { naturalBalance } from "../../engine/ledger/InvariantVerifier";
import { Vault } from "../../engine/crypto/Vault";
import { nationalIdHash } from "../../lib/joinRequestOnboarding";
import { queueKybNotification } from "../../lib/kybNotifications";
import { readKybRefreshPolicy } from "../../lib/kybReview";
import { listAccountLines } from "./ledgerLines";

const router = express.Router();
export const adminCommerceRouter = router;

const vault = new Vault();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const idParam = z.string().regex(UUID, "must be a UUID");
const idSchema = z.object({ id: idParam }).strict();

/** The maker's justification of a state change (contract section 1). */
export const COMMERCE_REASON_MIN_LENGTH = 10;
const reasonSchema = z.string().trim().min(COMMERCE_REASON_MIN_LENGTH).max(500);

const WALLET_STATUSES = ["PENDING", "ACTIVE", "FROZEN", "CLOSED"] as const;
const APPLICATION_STATUSES = ["DRAFT", "PENDING", "ACTIVE", "SUSPENDED", "CLOSED"] as const;
const PAYMENT_LINK_STATES = ["PENDING", "COMPLETED", "EXPIRED", "CANCELLED"] as const;
const POS_STATUSES = ["ACTIVE", "INACTIVE", "BLOCKED"] as const;
const PENDING_CASHOUT_STATES = ["PENDING", "PROCESSING"] as const;
const APPROVAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const merchantSelect = { id: true, legalName: true, tradeName: true } as const;

type Flags = { support: boolean; canFinancial: boolean; canSensitive: boolean };

/**
 * The same visibility rule as `/merchants/:id/wallets`: support staff and
 * principals without a finance or merchant-write authority never see balances.
 */
const flagsOf = (request: Request): Flags => {
  const principal = principalOf(request);
  const support = principal.role === "SUPPORT";
  return {
    support,
    canFinancial: !support && hasMerchantFinancialAccess(principal.authorities),
    canSensitive: !support && hasSensitiveMerchantAccess(principal.authorities),
  };
};

const money = (value: unknown): string => {
  if (value === null || value === undefined) return "0.0000";
  try {
    return decimal(value as never).toFixed(4);
  } catch {
    return String(value);
  }
};

const assertEnumFilter = (value: unknown, allowed: readonly string[], name: string): void => {
  if (typeof value !== "string" || value === "") return;
  const invalid = csv(value).filter((entry) => !allowed.includes(entry));
  if (invalid.length > 0) {
    throw new ApiError(400, "INVALID_FILTER", `Unknown ${name} filter value`, { invalid, allowed });
  }
};

const assertUuidFilter = (value: unknown, name: string): void => {
  if (typeof value === "string" && value !== "" && !UUID.test(value)) {
    throw new ApiError(400, "INVALID_FILTER", `${name} must be a UUID`);
  }
};

const stringList = (value: unknown): string[] | null =>
  Array.isArray(value) ? value.map((entry) => String(entry)) : null;

const merchantRef = (merchant: { id: string; legalName: string; tradeName: string }) => ({
  id: merchant.id,
  legalName: merchant.legalName,
  tradeName: merchant.tradeName,
});

const pendingApprovalsFor = async (subjectType: string, subjectId: string) => {
  const rows = await client.approvalRequest.findMany({
    where: {
      subjectType: { in: approvalSubjectTypeVariants(subjectType) },
      subjectId,
      state: { in: [...APPROVAL_PENDING_STATES] },
    },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { id: true, state: true, payloadDiffJson: true, makerReason: true, createdAt: true },
  });
  return rows.map((row) => ({
    id: row.id,
    state: row.state,
    payloadDiffJson: row.payloadDiffJson,
    makerReason: row.makerReason,
    createdAt: row.createdAt,
  }));
};

const hasPendingApproval = async (subjectType: string, subjectId: string): Promise<string | null> => {
  const pending = await client.approvalRequest.findFirst({
    where: {
      subjectType: { in: approvalSubjectTypeVariants(subjectType) },
      subjectId,
      state: { in: [...APPROVAL_PENDING_STATES] },
    },
    select: { id: true },
  });
  return pending?.id ?? null;
};

/** One approval request, audited in the same transaction. */
const proposeChange = async (
  request: Request,
  input: {
    subjectType: "WALLET" | "APPLICATION" | "POS_TERMINAL";
    subjectId: string;
    merchantId: string;
    action: string;
    reason: string;
    payload: Record<string, unknown>;
  },
): Promise<{ id: string; state: string }> => {
  const actor = actorFromRequest(request);
  return client.$transaction(async (tx) => {
    const approval = await tx.approvalRequest.create({
      data: {
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        payloadDiffJson: { action: input.action, ...input.payload, reason: input.reason } as Prisma.InputJsonValue,
        makerReason: input.reason,
        mode: "STANDARD",
        makerUserId: actor.userId,
        state: "PENDING_REVIEW",
        expiresAt: new Date(Date.now() + APPROVAL_TTL_MS),
      },
    });
    await auditTx(tx, {
      data: {
        actorId: actor.userId,
        role: actor.role,
        action: `${input.action}_REQUESTED`,
        entityType: input.subjectType,
        entityId: input.subjectId,
        merchantId: input.merchantId,
        approvalRequestId: approval.id,
        beforeJson: {},
        afterJson: { ...input.payload, reason: input.reason } as Prisma.InputJsonValue,
      },
    });
    return { id: approval.id, state: approval.state };
  });
};

/**
 * `audit_log` has no merchant column: the merchant of the entity travels in
 * the `afterJson` document so the trail stays searchable per merchant.
 */
const auditTx = async (
  tx: Parameters<typeof writeAudit>[0],
  input: { data: { merchantId?: string | null; afterJson: unknown } & Record<string, unknown> },
): Promise<void> => {
  const { merchantId, afterJson, ...rest } = input.data;
  await writeAudit(tx, {
    data: {
      beforeJson: {},
      ...rest,
      afterJson: { ...(afterJson as Record<string, unknown>), ...(merchantId ? { merchantId } : {}) },
    } as never,
  });
};

const staffAudit = (request: Request) => {
  const actor = actorFromRequest(request);
  return { actorId: actor.userId, role: actor.role };
};

/* -------------------------------------------------------------------------- */
/* Wallets                                                                     */
/* -------------------------------------------------------------------------- */

const walletListSelect = {
  id: true,
  merchantId: true,
  currency: true,
  status: true,
  glAccountId: true,
  createdAt: true,
  merchant: { select: merchantSelect },
  _count: { select: { applications: true, paymentLinks: true } },
} as const;

/**
 * A wallet is a liability: its GL account is credit-natural and the checkpoint is STORED
 * debit-positive (a merchant owed 25.000 has a stored checkpoint of -25.0000). The wallet
 * views show every balance in the natural sign, like `liveBalance`, so live minus checkpoint
 * is the amount posted since the last rollup. Never "-0.0000".
 */
const walletNaturalBalance = (storedDebitPositive: unknown): string => {
  const natural = naturalBalance("MERCHANT_WALLET", decimal(storedDebitPositive as never));
  return natural.isZero() ? "0.0000" : natural.toFixed(4);
};

const serializeWalletRow = (
  wallet: {
    id: string;
    merchantId: string;
    currency: string;
    status: string;
    glAccountId: string;
    createdAt: Date;
    merchant: { id: string; legalName: string; tradeName: string };
    _count: { applications: number; paymentLinks: number };
  },
  flags: Flags,
  liveBalance: string | undefined,
  pendingCashouts: number,
  /** Sum of the wallet's shard checkpoints as STORED (debit-positive). */
  storedCheckpointBalance?: string,
) => ({
  id: wallet.id,
  merchantId: wallet.merchantId,
  merchant: merchantRef(wallet.merchant),
  currency: wallet.currency,
  status: wallet.status,
  glAccountId: wallet.glAccountId,
  liveBalance: flags.canFinancial ? liveBalance ?? "0.0000" : null,
  checkpointBalance: flags.canFinancial ? walletNaturalBalance(storedCheckpointBalance ?? 0) : null,
  applicationCount: wallet._count.applications,
  paymentLinkCount: wallet._count.paymentLinks,
  pendingCashoutCount: pendingCashouts,
  createdAt: wallet.createdAt,
  redactedFields: flags.canFinancial ? [] : ["liveBalance", "checkpointBalance"],
});

const pendingCashoutCounts = async (walletIds: string[]): Promise<Map<string, number>> => {
  const counts = new Map<string, number>();
  if (walletIds.length === 0) return counts;
  const rows = await client.cashoutRequest.groupBy({
    by: ["walletId"],
    where: { walletId: { in: walletIds }, state: { in: [...PENDING_CASHOUT_STATES] } },
    _count: { _all: true },
  });
  for (const row of rows) counts.set(row.walletId, row._count._all);
  return counts;
};

router.get("/wallets", async (request: Request, response: Response) => {
  requireAuthorities(request, ["merchant:read"]);
  const flags = flagsOf(request);
  assertEnumFilter(request.query.status, WALLET_STATUSES, "status");
  assertUuidFilter(request.query.merchantId, "merchantId");
  const built = buildListQuery(request.query, {
    search: ["id", "glAccountId", "merchant.legalName", "merchant.tradeName"],
    in: { status: "status", currency: "currency" },
    equals: { merchantId: "merchantId" },
    dates: { createdAt: { path: "createdAt" } },
    sortable: { currency: "currency", status: "status", createdAt: "createdAt" },
    defaultSort: { createdAt: "desc" },
    defaultPageSize: 25,
  });
  const [wallets, total] = await Promise.all([
    client.wallet.findMany({
      where: built.where as never,
      orderBy: built.orderBy as never,
      skip: built.skip,
      take: built.take,
      select: walletListSelect,
    }),
    client.wallet.count({ where: built.where as never }),
  ]);
  const accountIds = wallets.map((wallet) => wallet.glAccountId);
  const [pending, live, checkpoints] = await Promise.all([
    pendingCashoutCounts(wallets.map((wallet) => wallet.id)),
    flags.canFinancial ? loadLiveAccountBalances(client as never, accountIds) : Promise.resolve([]),
    flags.canFinancial ? loadAccountCheckpointSummary(client as never, accountIds) : Promise.resolve([]),
  ]);
  const liveById = new Map(live.map((row) => [row.id, decimal(row.balance).toFixed(4)]));
  const checkpointById = new Map(checkpoints.map((row) => [row.id, row.checkpointBalance]));
  response.json({
    ...listResponse(
      "wallets",
      wallets.map((wallet) => serializeWalletRow(wallet, flags, liveById.get(wallet.glAccountId), pending.get(wallet.id) ?? 0, checkpointById.get(wallet.glAccountId))),
      total,
      built,
      wallets,
    ),
  });
});

router.get("/wallets/summary", async (request: Request, response: Response) => {
  requireAuthorities(request, ["merchant:read"]);
  const flags = flagsOf(request);
  const [totalWallets, activeWallets, frozenWallets, pendingGroups, wallets] = await Promise.all([
    client.wallet.count(),
    client.wallet.count({ where: { status: "ACTIVE" } }),
    client.wallet.count({ where: { status: "FROZEN" } }),
    client.cashoutRequest.groupBy({
      by: ["walletId"],
      where: { state: { in: [...PENDING_CASHOUT_STATES] } },
      _count: { _all: true },
    }),
    flags.canFinancial
      ? client.wallet.findMany({ select: { glAccountId: true, currency: true } })
      : Promise.resolve([] as Array<{ glAccountId: string; currency: string }>),
  ]);
  let totalBalanceByCurrency: Array<{ currency: string; total: string | null }>;
  if (flags.canFinancial) {
    const live = await loadLiveAccountBalances(client as never, wallets.map((wallet) => wallet.glAccountId));
    const currencyByAccount = new Map(wallets.map((wallet) => [wallet.glAccountId, wallet.currency]));
    const totals = new Map<string, ReturnType<typeof decimal>>();
    for (const row of live) {
      const currency = currencyByAccount.get(row.id);
      if (!currency) continue;
      totals.set(currency, (totals.get(currency) ?? decimal(0)).plus(decimal(row.balance)));
    }
    for (const wallet of wallets) {
      if (!totals.has(wallet.currency)) totals.set(wallet.currency, decimal(0));
    }
    totalBalanceByCurrency = [...totals.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([currency, total]) => ({ currency, total: total.toFixed(4) }));
  } else {
    const currencies = await client.wallet.findMany({ distinct: ["currency"], select: { currency: true }, orderBy: { currency: "asc" } });
    totalBalanceByCurrency = currencies.map((row) => ({ currency: row.currency, total: null }));
  }
  response.json({
    totalWallets,
    activeWallets,
    frozenWallets,
    pendingCashoutWallets: pendingGroups.length,
    totalBalanceByCurrency,
    redactedFields: flags.canFinancial ? [] : ["totalBalanceByCurrency"],
  });
});

router.get("/wallets/:id", async (request: Request, response: Response) => {
  requireAuthorities(request, ["merchant:read"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const flags = flagsOf(request);
  const wallet = await client.wallet.findUnique({
    where: { id },
    select: {
      ...walletListSelect,
      glAccount: {
        select: { id: true, accountType: true, currency: true, shardCount: true, shardScaledAt: true },
      },
      applications: { select: { id: true, name: true, status: true }, orderBy: { createdAt: "desc" }, take: 50 },
    },
  });
  if (!wallet) throw new ApiError(404, "WALLET_NOT_FOUND", "The wallet does not exist");
  const [pending, live, checkpoints, shards, cashouts, pendingApprovals] = await Promise.all([
    pendingCashoutCounts([wallet.id]),
    flags.canFinancial ? loadLiveAccountBalances(client as never, [wallet.glAccountId]) : Promise.resolve([]),
    flags.canFinancial ? loadAccountCheckpointSummary(client as never, [wallet.glAccountId]) : Promise.resolve([]),
    flags.canFinancial
      ? client.glAccountShard.findMany({
          where: { glAccountId: wallet.glAccountId },
          orderBy: { shardId: "asc" },
          include: { checkpoint: true },
        })
      : Promise.resolve([]),
    flags.canFinancial
      ? client.cashoutRequest.findMany({
          where: { walletId: wallet.id },
          orderBy: { createdAt: "desc" },
          take: 10,
          select: { id: true, state: true, amount: true, createdAt: true },
        })
      : Promise.resolve([]),
    pendingApprovalsFor("WALLET", wallet.id),
  ]);
  const checkpoint = checkpoints[0];
  const base = serializeWalletRow(
    wallet,
    flags,
    live[0] ? decimal(live[0].balance).toFixed(4) : undefined,
    pending.get(wallet.id) ?? 0,
    checkpoint?.checkpointBalance,
  );
  response.json({
    wallet: {
      ...base,
      glAccount: {
        id: wallet.glAccount.id,
        accountType: wallet.glAccount.accountType,
        currency: wallet.glAccount.currency,
        /** Derived from the shard checkpoints (the account stores none), natural sign like liveBalance. */
        checkpointBalance: flags.canFinancial ? walletNaturalBalance(checkpoint?.checkpointBalance ?? 0) : null,
        checkpointAt: flags.canFinancial ? checkpoint?.checkpointAt ?? null : null,
        shardCount: wallet.glAccount.shardCount,
        shardScaledAt: wallet.glAccount.shardScaledAt,
        pendingLines: flags.canFinancial ? checkpoint?.pendingLines ?? "0" : null,
      },
      shards: shards.map((shard) => ({
        shardId: shard.shardId,
        currentBalance: money(shard.currentBalance),
        lineSeq: shard.lineSeq.toString(),
        checkpointSeq: (shard.checkpoint?.checkpointSeq ?? 0n).toString(),
        checkpointAt: shard.checkpoint?.checkpointAt ?? null,
        pendingLines: (shard.lineSeq - (shard.checkpoint?.checkpointSeq ?? 0n)).toString(),
        updatedAt: shard.updatedAt,
      })),
      applications: wallet.applications,
      cashouts: cashouts.map((cashout) => ({
        id: cashout.id,
        state: cashout.state,
        amount: money(cashout.amount),
        currency: wallet.currency,
        createdAt: cashout.createdAt,
      })),
      pendingApprovals,
      redactedFields: flags.canFinancial
        ? []
        : ["liveBalance", "checkpointBalance", "shards", "cashouts", "statementLines"],
    },
  });
});

/**
 * The wallet statement: the posting lines of the wallet's GL account, paginated. The detail
 * response no longer embeds a fixed page of lines. Roles without financial visibility get an
 * empty page flagged as redacted, exactly like the other financial fields of the wallet.
 */
router.get("/wallets/:id/statement", async (request: Request, response: Response) => {
  requireAuthorities(request, ["merchant:read"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const flags = flagsOf(request);
  const wallet = await client.wallet.findUnique({ where: { id }, select: { id: true, glAccountId: true, currency: true } });
  if (!wallet) throw new ApiError(404, "WALLET_NOT_FOUND", "The wallet does not exist");
  if (!flags.canFinancial) {
    response.json({
      lines: [],
      total: 0,
      page: 1,
      pageSize: 25,
      totals: { lineCount: 0, totalDebit: null, totalCredit: null, netDebit: null },
      currency: wallet.currency,
      redactedFields: ["statementLines"],
    });
    return;
  }
  response.json({
    ...(await listAccountLines(wallet.glAccountId, request.query as Record<string, unknown>)),
    currency: wallet.currency,
    redactedFields: [],
  });
});

/** Status history of one wallet (freeze / unfreeze), newest first, from the audit trail. */
router.get("/wallets/:id/audit-events", async (request: Request, response: Response) => {
  requireAuthorities(request, ["merchant:read"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const wallet = await client.wallet.findUnique({ where: { id }, select: { id: true } });
  if (!wallet) throw new ApiError(404, "WALLET_NOT_FOUND", "The wallet does not exist");
  const flags = flagsOf(request);
  const built = buildListQuery(request.query, {
    in: { action: "action", role: "role" },
    dates: { createdAt: { path: "createdAt" } },
    sortable: { action: "action", role: "role", createdAt: "createdAt" },
    defaultSort: { createdAt: "desc" },
    defaultPageSize: 10,
  });
  const conditions = Array.isArray(built.where.AND) ? built.where.AND : [];
  const where = { AND: [{ entityType: "WALLET", entityId: id }, ...conditions] };
  const [events, total] = await Promise.all([
    client.auditLog.findMany({
      where: where as never,
      orderBy: built.orderBy as never,
      skip: built.skip,
      take: built.take,
      select: {
        id: true,
        action: true,
        role: true,
        beforeJson: true,
        afterJson: true,
        approvalRequestId: true,
        createdAt: true,
        actor: { select: { email: true } },
      },
    }),
    client.auditLog.count({ where: where as never }),
  ]);
  response.json(
    listResponse(
      "auditEvents",
      events.map((event) => ({
        id: event.id,
        action: event.action,
        role: event.role,
        actorEmail: event.actor.email,
        approvalRequestId: event.approvalRequestId,
        before: flags.canSensitive ? event.beforeJson : null,
        after: flags.canSensitive ? event.afterJson : null,
        createdAt: event.createdAt,
        redacted: !flags.canSensitive,
      })),
      total,
      built,
    ),
  );
});

router.post("/wallets/:id/status", async (request: Request, response: Response) => {
  requireAuthorities(request, ["merchant:write"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const body = parseOrThrow(
    z.object({ status: z.enum(["FROZEN", "ACTIVE"]), reason: reasonSchema }).strict(),
    request.body,
  );
  const actor = staffAudit(request);
  const wallet = await client.wallet.findUnique({
    where: { id },
    select: { id: true, merchantId: true, currency: true, status: true, glAccountId: true },
  });
  if (!wallet) throw new ApiError(404, "WALLET_NOT_FOUND", "The wallet does not exist");

  if (body.status === "FROZEN") {
    if (wallet.status !== "ACTIVE") {
      throw new ApiError(409, "WALLET_INVALID_TRANSITION", "Only an active wallet can be frozen", {
        currentStatus: wallet.status,
        requested: body.status,
      });
    }
    const updated = await client.$transaction(async (tx) => {
      const changed = await tx.wallet.updateMany({ where: { id: wallet.id, status: "ACTIVE" }, data: { status: "FROZEN" } });
      if (changed.count !== 1) {
        throw new ApiError(409, "WALLET_INVALID_TRANSITION", "The wallet changed concurrently", { requested: body.status });
      }
      await auditTx(tx, {
        data: {
          ...actor,
          action: "WALLET_FROZEN",
          entityType: "WALLET",
          entityId: wallet.id,
          merchantId: wallet.merchantId,
          beforeJson: { status: "ACTIVE" },
          afterJson: { status: "FROZEN", reason: body.reason },
        },
      });
      return tx.wallet.findUniqueOrThrow({ where: { id: wallet.id }, select: { id: true, merchantId: true, currency: true, status: true } });
    });
    response.json({ wallet: updated });
    return;
  }

  // ACTIVE is the loosening direction: a checker has to approve it.
  if (wallet.status !== "FROZEN") {
    throw new ApiError(409, "WALLET_INVALID_TRANSITION", "Only a frozen wallet can be reactivated", {
      currentStatus: wallet.status,
      requested: body.status,
    });
  }
  const pendingId = await hasPendingApproval("WALLET", wallet.id);
  if (pendingId) {
    throw new ApiError(409, "WALLET_APPROVAL_PENDING", "A wallet change is already awaiting a checker", {
      approvalRequestId: pendingId,
    });
  }
  const approval = await proposeChange(request, {
    subjectType: "WALLET",
    subjectId: wallet.id,
    merchantId: wallet.merchantId,
    action: "WALLET_UNFREEZE",
    reason: body.reason,
    payload: { fromStatus: wallet.status, toStatus: "ACTIVE" },
  });
  response.status(202).json({ approvalRequestId: approval.id, state: approval.state });
});

/* -------------------------------------------------------------------------- */
/* Applications                                                                */
/* -------------------------------------------------------------------------- */

const applicationListSelect = {
  id: true,
  name: true,
  merchantId: true,
  status: true,
  assignedWalletId: true,
  expectedMonthlyVolume: true,
  railWhitelist: true,
  redirectDomainAllowlist: true,
  createdAt: true,
  updatedAt: true,
  merchant: { select: merchantSelect },
  assignedWallet: { select: { id: true, currency: true, status: true } },
  _count: { select: { accessTokens: true, paymentLinks: true, posTerminals: true } },
} as const;

type ApplicationListRow = Prisma.ApplicationGetPayload<{ select: typeof applicationListSelect }>;

const serializeApplicationRow = (application: ApplicationListRow, flags: Flags) => {
  const railWhitelist = stringList(application.railWhitelist);
  const redirectDomains = stringList(application.redirectDomainAllowlist) ?? [];
  const redacted: string[] = [];
  if (flags.support) redacted.push("expectedMonthlyVolume");
  if (!flags.canSensitive) redacted.push("redirectDomains");
  return {
    id: application.id,
    name: application.name,
    merchantId: application.merchantId,
    merchant: merchantRef(application.merchant),
    status: application.status,
    assignedWalletId: application.assignedWalletId,
    assignedWallet: application.assignedWallet,
    expectedMonthlyVolume: flags.support ? null : money(application.expectedMonthlyVolume),
    railWhitelist,
    railWhitelistMode: railWhitelist === null ? "ALL" : railWhitelist.length === 0 ? "NONE" : "LIST",
    railWhitelistCount: railWhitelist?.length ?? 0,
    redirectDomains: flags.canSensitive ? redirectDomains : [],
    accessTokenCount: application._count.accessTokens,
    paymentLinkCount: application._count.paymentLinks,
    posTerminalCount: application._count.posTerminals,
    createdAt: application.createdAt,
    updatedAt: application.updatedAt,
    redactedFields: redacted,
  };
};

const withoutWhitelistWhere = {
  OR: [
    { railWhitelist: { equals: Prisma.DbNull } },
    { railWhitelist: { equals: Prisma.JsonNull } },
  ],
};

router.get("/applications", async (request: Request, response: Response) => {
  requireAuthorities(request, ["merchant:read"]);
  const flags = flagsOf(request);
  assertEnumFilter(request.query.status, APPLICATION_STATUSES, "status");
  assertUuidFilter(request.query.merchantId, "merchantId");
  assertUuidFilter(request.query.walletId, "walletId");
  const built = buildListQuery(request.query, {
    search: ["name", "id", "merchant.legalName", "merchant.tradeName"],
    in: { status: "status" },
    equals: { merchantId: "merchantId", walletId: "assignedWalletId" },
    dates: { createdAt: { path: "createdAt" } },
    sortable: { name: "name", status: "status", createdAt: "createdAt", expectedMonthlyVolume: "expectedMonthlyVolume" },
    defaultSort: { createdAt: "desc" },
    defaultPageSize: 25,
  });
  const [applications, total] = await Promise.all([
    client.application.findMany({
      where: built.where as never,
      orderBy: built.orderBy as never,
      skip: built.skip,
      take: built.take,
      select: applicationListSelect,
    }),
    client.application.count({ where: built.where as never }),
  ]);
  response.json(
    listResponse("applications", applications.map((application) => serializeApplicationRow(application, flags)), total, built, applications),
  );
});

router.get("/applications/summary", async (request: Request, response: Response) => {
  requireAuthorities(request, ["merchant:read"]);
  const [total, active, suspended, pending, withoutWhitelist] = await Promise.all([
    client.application.count(),
    client.application.count({ where: { status: "ACTIVE" } }),
    client.application.count({ where: { status: "SUSPENDED" } }),
    client.application.count({ where: { status: "PENDING" } }),
    client.application.count({ where: withoutWhitelistWhere as never }),
  ]);
  response.json({ total, active, suspended, pending, withoutWhitelist });
});

const tokenStatus = (token: { revokedAt: Date | null; expiresAt: Date | null }): "ACTIVE" | "REVOKED" | "EXPIRED" => {
  if (token.revokedAt) return "REVOKED";
  if (token.expiresAt && token.expiresAt.getTime() <= Date.now()) return "EXPIRED";
  return "ACTIVE";
};

const serializeToken = (token: {
  id: string;
  name: string;
  lastFour: string;
  scopes: unknown;
  ipWhitelistEnabled: boolean;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  ips?: Array<{ cidr: string }>;
}) => ({
  id: token.id,
  name: token.name,
  lastFour: token.lastFour,
  scopes: stringList(token.scopes) ?? [],
  ipWhitelistEnabled: token.ipWhitelistEnabled,
  cidrs: (token.ips ?? []).map((entry) => entry.cidr),
  lastUsedAt: token.lastUsedAt,
  expiresAt: token.expiresAt,
  revokedAt: token.revokedAt,
  status: tokenStatus(token),
  createdAt: token.createdAt,
});

router.get("/applications/:id", async (request: Request, response: Response) => {
  requireAuthorities(request, ["merchant:read"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const flags = flagsOf(request);
  const application = await client.application.findUnique({ where: { id }, select: applicationListSelect });
  if (!application) throw new ApiError(404, "APPLICATION_NOT_FOUND", "The application does not exist");
  const [tokens, links, terminals, pendingApprovals] = await Promise.all([
    client.accessToken.findMany({
      where: { applicationId: id },
      orderBy: { createdAt: "desc" },
      take: 100,
      // tokenHash is never selected: it can not leak through a spread.
      select: {
        id: true,
        name: true,
        lastFour: true,
        scopes: true,
        ipWhitelistEnabled: true,
        lastUsedAt: true,
        expiresAt: true,
        revokedAt: true,
        createdAt: true,
        ips: { select: { cidr: true } },
      },
    }),
    client.paymentLink.findMany({ where: { applicationId: id }, orderBy: { createdAt: "desc" }, take: 25, select: paymentLinkSelect }),
    client.posTerminal.findMany({ where: { applicationId: id }, orderBy: { createdAt: "desc" }, take: 25, select: posTerminalSelect }),
    pendingApprovalsFor("APPLICATION", id),
  ]);
  response.json({
    application: {
      ...serializeApplicationRow(application, flags),
      accessTokens: tokens.map(serializeToken),
      paymentLinks: links.map(serializePaymentLink),
      posTerminals: terminals.map(serializePosTerminal),
      pendingApprovals,
    },
  });
});

/** Accepts a bare hostname or an https origin and normalises it to lowercase. */
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$|^localhost$/;
export const normalizeRedirectDomain = (raw: string): string => {
  const value = raw.trim().toLowerCase();
  if (HOSTNAME.test(value)) return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ApiError(400, "REDIRECT_DOMAIN_INVALID", "A redirect domain must be a hostname or an https origin", { value: raw });
  }
  if (url.protocol !== "https:" || url.username || url.password || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw new ApiError(400, "REDIRECT_DOMAIN_INVALID", "A redirect domain must be a hostname or an https origin", { value: raw });
  }
  return url.origin;
};

router.patch("/applications/:id", async (request: Request, response: Response) => {
  requireAuthorities(request, ["merchant:write"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const body = parseOrThrow(
    z
      .object({
        status: z.enum(["SUSPENDED", "ACTIVE"]).optional(),
        assignedWalletId: idParam.optional(),
        railWhitelist: z.array(z.string().trim().min(1).max(64)).max(200).nullable().optional(),
        redirectDomainAllowlist: z.array(z.string().trim().min(1).max(253)).max(100).optional(),
        reason: reasonSchema,
      })
      .strict(),
    request.body,
  );
  const application = await client.application.findUnique({
    where: { id },
    select: {
      id: true,
      merchantId: true,
      status: true,
      assignedWalletId: true,
      railWhitelist: true,
      redirectDomainAllowlist: true,
      updatedAt: true,
      assignedWallet: { select: { currency: true } },
    },
  });
  if (!application) throw new ApiError(404, "APPLICATION_NOT_FOUND", "The application does not exist");

  const editsConfiguration =
    body.assignedWalletId !== undefined || body.railWhitelist !== undefined || body.redirectDomainAllowlist !== undefined;
  if (body.status === undefined && !editsConfiguration) {
    throw new ApiError(400, "APPLICATION_UPDATE_REQUIRED", "A status or a configuration change is required");
  }
  if (application.status === "CLOSED") {
    throw new ApiError(409, "APPLICATION_INVALID_TRANSITION", "A closed application can not be changed", {
      currentStatus: application.status,
    });
  }

  // Status: only ACTIVE <-> SUSPENDED is handled here.
  let statusChange: "SUSPEND" | "REACTIVATE" | null = null;
  if (body.status !== undefined && body.status !== application.status) {
    if (body.status === "SUSPENDED" && application.status === "ACTIVE") statusChange = "SUSPEND";
    else if (body.status === "ACTIVE" && application.status === "SUSPENDED") statusChange = "REACTIVATE";
    else {
      throw new ApiError(409, "APPLICATION_INVALID_TRANSITION", "That status change is not allowed", {
        currentStatus: application.status,
        requested: body.status,
      });
    }
  } else if (body.status !== undefined && !editsConfiguration) {
    throw new ApiError(409, "APPLICATION_INVALID_TRANSITION", "The application already has that status", {
      currentStatus: application.status,
      requested: body.status,
    });
  }

  if (statusChange === "SUSPEND") {
    if (editsConfiguration) {
      throw new ApiError(
        400,
        "APPLICATION_SUSPEND_MUST_BE_ALONE",
        "A suspension is immediate and can not be combined with a configuration change",
      );
    }
    const actor = staffAudit(request);
    const updated = await client.$transaction(async (tx) => {
      const changed = await tx.application.updateMany({ where: { id: application.id, status: "ACTIVE" }, data: { status: "SUSPENDED" } });
      if (changed.count !== 1) {
        throw new ApiError(409, "APPLICATION_INVALID_TRANSITION", "The application changed concurrently", { requested: "SUSPENDED" });
      }
      await auditTx(tx, {
        data: {
          ...actor,
          action: "APPLICATION_SUSPENDED",
          entityType: "APPLICATION",
          entityId: application.id,
          merchantId: application.merchantId,
          beforeJson: { status: "ACTIVE" },
          afterJson: { status: "SUSPENDED", reason: body.reason },
        },
      });
      return tx.application.findUniqueOrThrow({
        where: { id: application.id },
        select: { id: true, merchantId: true, name: true, status: true, assignedWalletId: true },
      });
    });
    response.json({ application: updated });
    return;
  }

  // Everything else changes what the application may accept: one approval.
  const changes: Record<string, unknown> = {};
  if (body.assignedWalletId !== undefined && body.assignedWalletId !== application.assignedWalletId) {
    const wallet = await client.wallet.findUnique({
      where: { id: body.assignedWalletId },
      select: { id: true, merchantId: true, currency: true, status: true },
    });
    if (!wallet || wallet.merchantId !== application.merchantId) {
      throw new ApiError(404, "WALLET_NOT_FOUND", "The wallet does not exist for this merchant");
    }
    if (wallet.currency !== application.assignedWallet.currency) {
      throw new ApiError(409, "WALLET_CURRENCY_MISMATCH", "The new wallet must use the same currency as the current one", {
        current: application.assignedWallet.currency,
        requested: wallet.currency,
      });
    }
    if (wallet.status !== "ACTIVE") {
      throw new ApiError(409, "WALLET_NOT_ACTIVE", "The application can only be assigned to an active wallet", {
        walletStatus: wallet.status,
      });
    }
    changes.assignedWalletId = wallet.id;
  }
  if (body.railWhitelist !== undefined) {
    const rails = body.railWhitelist === null ? null : [...new Set(body.railWhitelist)];
    if (rails !== null && rails.length > 0) {
      const known = await client.rail.findMany({ where: { code: { in: rails } }, select: { code: true } });
      const knownCodes = new Set(known.map((rail) => rail.code));
      const unknown = rails.filter((code) => !knownCodes.has(code));
      if (unknown.length > 0) {
        throw new ApiError(422, "RAIL_NOT_FOUND", "The rail whitelist contains an unknown rail code", { unknown });
      }
    }
    const current = stringList(application.railWhitelist);
    const same = JSON.stringify(current === null ? null : [...current].sort()) === JSON.stringify(rails === null ? null : [...rails].sort());
    if (!same) changes.railWhitelist = rails;
  }
  if (body.redirectDomainAllowlist !== undefined) {
    const domains = [...new Set(body.redirectDomainAllowlist.map(normalizeRedirectDomain))];
    const current = [...(stringList(application.redirectDomainAllowlist) ?? [])].sort();
    if (JSON.stringify(current) !== JSON.stringify([...domains].sort())) changes.redirectDomainAllowlist = domains;
  }
  if (statusChange === "REACTIVATE") changes.status = "ACTIVE";
  if (Object.keys(changes).length === 0) {
    throw new ApiError(409, "APPLICATION_NO_CHANGE", "The request does not change the application");
  }
  const pendingId = await hasPendingApproval("APPLICATION", application.id);
  if (pendingId) {
    throw new ApiError(409, "APPLICATION_APPROVAL_PENDING", "An application change is already awaiting a checker", {
      approvalRequestId: pendingId,
    });
  }
  const approval = await proposeChange(request, {
    subjectType: "APPLICATION",
    subjectId: application.id,
    merchantId: application.merchantId,
    action: statusChange === "REACTIVATE" ? "APPLICATION_REACTIVATE" : "APPLICATION_UPDATE",
    reason: body.reason,
    payload: { fromStatus: application.status, baseUpdatedAt: application.updatedAt.toISOString(), ...changes },
  });
  response.status(202).json({ approvalRequestId: approval.id, state: approval.state });
});

router.post("/applications/:id/tokens/:tokenId/revoke", async (request: Request, response: Response) => {
  requireAuthorities(request, ["merchant:write"]);
  const params = parseOrThrow(z.object({ id: idParam, tokenId: idParam }).strict(), request.params);
  const body = parseOrThrow(z.object({ reason: reasonSchema }).strict(), request.body);
  const actor = staffAudit(request);
  const token = await client.accessToken.findFirst({
    where: { id: params.tokenId, applicationId: params.id },
    select: { id: true, merchantId: true, applicationId: true, name: true, lastFour: true, revokedAt: true },
  });
  if (!token) throw new ApiError(404, "ACCESS_TOKEN_NOT_FOUND", "The access token does not exist");
  if (token.revokedAt) {
    throw new ApiError(409, "TOKEN_ALREADY_REVOKED", "The access token is already revoked", { revokedAt: token.revokedAt });
  }
  const revokedAt = new Date();
  // The merchant and checkout channels read the token row on every request
  // (there is no token cache to invalidate), so the revocation is effective at
  // commit time.
  await client.$transaction(async (tx) => {
    const changed = await tx.accessToken.updateMany({ where: { id: token.id, revokedAt: null }, data: { revokedAt } });
    if (changed.count !== 1) {
      throw new ApiError(409, "TOKEN_ALREADY_REVOKED", "The access token is already revoked");
    }
    await auditTx(tx, {
      data: {
        ...actor,
        action: "ACCESS_TOKEN_REVOKED",
        entityType: "ACCESS_TOKEN",
        entityId: token.id,
        merchantId: token.merchantId,
        beforeJson: { revokedAt: null, lastFour: token.lastFour },
        afterJson: { revokedAt: revokedAt.toISOString(), applicationId: token.applicationId, reason: body.reason },
      },
    });
  });
  response.json({
    token: { id: token.id, name: token.name, lastFour: token.lastFour, revokedAt, status: "REVOKED" as const },
  });
});

/* -------------------------------------------------------------------------- */
/* Payment links                                                               */
/* -------------------------------------------------------------------------- */

const paymentLinkSelect = {
  id: true,
  key: true,
  applicationId: true,
  walletId: true,
  amount: true,
  currency: true,
  feeBearer: true,
  infiniteUse: true,
  useCount: true,
  confirmedCount: true,
  activeLockedCount: true,
  state: true,
  redirectUrl: true,
  expiresAt: true,
  createdAt: true,
  application: { select: { id: true, name: true, merchantId: true, merchant: { select: merchantSelect } } },
} as const;

type PaymentLinkRow = Prisma.PaymentLinkGetPayload<{ select: typeof paymentLinkSelect }>;

const serializePaymentLink = (link: PaymentLinkRow) => ({
  id: link.id,
  key: link.key,
  applicationId: link.applicationId,
  application: { id: link.application.id, name: link.application.name },
  merchant: merchantRef(link.application.merchant),
  walletId: link.walletId,
  amount: money(link.amount),
  currency: link.currency,
  feeBearer: link.feeBearer,
  infiniteUse: link.infiniteUse,
  useCount: link.useCount,
  confirmedCount: link.confirmedCount,
  activeLockedCount: link.activeLockedCount,
  state: link.state,
  redirectUrl: link.redirectUrl,
  expiresAt: link.expiresAt,
  createdAt: link.createdAt,
});

router.get("/payment-links", async (request: Request, response: Response) => {
  requireAuthorities(request, ["merchant:read"]);
  assertEnumFilter(request.query.state, PAYMENT_LINK_STATES, "state");
  assertUuidFilter(request.query.merchantId, "merchantId");
  assertUuidFilter(request.query.applicationId, "applicationId");
  assertUuidFilter(request.query.walletId, "walletId");
  const built = buildListQuery(request.query, {
    search: ["key"],
    in: { state: "state", currency: "currency" },
    equals: { merchantId: "application.merchantId", applicationId: "applicationId", walletId: "walletId" },
    dates: { createdAt: { path: "createdAt" } },
    ranges: { amount: { path: "amount", kind: "decimal" } },
    sortable: { createdAt: "createdAt", amount: "amount", state: "state", expiresAt: "expiresAt" },
    defaultSort: { createdAt: "desc" },
    defaultPageSize: 25,
  });
  const [links, total] = await Promise.all([
    client.paymentLink.findMany({
      where: built.where as never,
      orderBy: built.orderBy as never,
      skip: built.skip,
      take: built.take,
      select: paymentLinkSelect,
    }),
    client.paymentLink.count({ where: built.where as never }),
  ]);
  response.json(listResponse("paymentLinks", links.map(serializePaymentLink), total, built, links));
});

router.post("/payment-links/:id/state", async (request: Request, response: Response) => {
  requireAuthorities(request, ["merchant:write"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const body = parseOrThrow(z.object({ state: z.literal("CANCELLED"), reason: reasonSchema }).strict(), request.body);
  const actor = staffAudit(request);
  const link = await client.paymentLink.findUnique({
    where: { id },
    select: { id: true, key: true, state: true, application: { select: { merchantId: true } } },
  });
  if (!link) throw new ApiError(404, "PAYMENT_LINK_NOT_FOUND", "The payment link does not exist");
  if (link.state !== "PENDING") {
    throw new ApiError(409, "PAYMENT_LINK_INVALID_TRANSITION", "Only a pending payment link can be cancelled", {
      currentState: link.state,
      requested: body.state,
    });
  }
  const updated = await client.$transaction(async (tx) => {
    const changed = await tx.paymentLink.updateMany({ where: { id: link.id, state: "PENDING" }, data: { state: "CANCELLED" } });
    if (changed.count !== 1) {
      throw new ApiError(409, "PAYMENT_LINK_INVALID_TRANSITION", "The payment link changed concurrently");
    }
    await auditTx(tx, {
      data: {
        ...actor,
        action: "PAYMENT_LINK_CANCELLED",
        entityType: "PAYMENT_LINK",
        entityId: link.id,
        merchantId: link.application.merchantId,
        beforeJson: { state: "PENDING" },
        afterJson: { state: "CANCELLED", key: link.key, reason: body.reason },
      },
    });
    return tx.paymentLink.findUniqueOrThrow({ where: { id: link.id }, select: paymentLinkSelect });
  });
  response.json({ paymentLink: serializePaymentLink(updated) });
});

/* -------------------------------------------------------------------------- */
/* POS terminals                                                               */
/* -------------------------------------------------------------------------- */

const posTerminalSelect = {
  id: true,
  name: true,
  location: true,
  applicationId: true,
  status: true,
  createdAt: true,
  // authTokenHash is never selected.
  screens: { select: { id: true, lastActiveAt: true } },
  application: { select: { id: true, name: true, merchantId: true, merchant: { select: merchantSelect } } },
} as const;

type PosTerminalRow = Prisma.PosTerminalGetPayload<{ select: typeof posTerminalSelect }>;

const serializePosTerminal = (terminal: PosTerminalRow) => {
  const lastActive = terminal.screens
    .map((screen) => screen.lastActiveAt)
    .filter((value): value is Date => value instanceof Date)
    .sort((left, right) => right.getTime() - left.getTime())[0];
  return {
    id: terminal.id,
    name: terminal.name,
    location: terminal.location,
    applicationId: terminal.applicationId,
    application: { id: terminal.application.id, name: terminal.application.name },
    merchant: merchantRef(terminal.application.merchant),
    status: terminal.status,
    screenCount: terminal.screens.length,
    lastActiveAt: lastActive ?? null,
    createdAt: terminal.createdAt,
  };
};

router.get("/pos-terminals", async (request: Request, response: Response) => {
  requireAuthorities(request, ["merchant:read"]);
  assertEnumFilter(request.query.status, POS_STATUSES, "status");
  assertUuidFilter(request.query.merchantId, "merchantId");
  assertUuidFilter(request.query.applicationId, "applicationId");
  const built = buildListQuery(request.query, {
    search: ["name", "location", "id", "application.name"],
    in: { status: "status" },
    equals: { merchantId: "application.merchantId", applicationId: "applicationId" },
    dates: { createdAt: { path: "createdAt" } },
    sortable: { name: "name", status: "status", createdAt: "createdAt" },
    defaultSort: { createdAt: "desc" },
    defaultPageSize: 25,
  });
  const [terminals, total] = await Promise.all([
    client.posTerminal.findMany({
      where: built.where as never,
      orderBy: built.orderBy as never,
      skip: built.skip,
      take: built.take,
      select: posTerminalSelect,
    }),
    client.posTerminal.count({ where: built.where as never }),
  ]);
  response.json(listResponse("posTerminals", terminals.map(serializePosTerminal), total, built, terminals));
});

router.post("/pos-terminals/:id/status", async (request: Request, response: Response) => {
  requireAuthorities(request, ["merchant:write"]);
  const { id } = parseOrThrow(idSchema, request.params);
  const body = parseOrThrow(
    z.object({ status: z.enum(["INACTIVE", "BLOCKED", "ACTIVE"]), reason: reasonSchema }).strict(),
    request.body,
  );
  const actor = staffAudit(request);
  const terminal = await client.posTerminal.findUnique({
    where: { id },
    select: { id: true, status: true, application: { select: { merchantId: true } } },
  });
  if (!terminal) throw new ApiError(404, "POS_TERMINAL_NOT_FOUND", "The POS terminal does not exist");
  if (terminal.status === body.status) {
    throw new ApiError(409, "POS_TERMINAL_INVALID_TRANSITION", "The POS terminal already has that status", {
      currentStatus: terminal.status,
    });
  }

  if (body.status === "ACTIVE") {
    const pendingId = await hasPendingApproval("POS_TERMINAL", terminal.id);
    if (pendingId) {
      throw new ApiError(409, "POS_TERMINAL_APPROVAL_PENDING", "A POS terminal change is already awaiting a checker", {
        approvalRequestId: pendingId,
      });
    }
    const approval = await proposeChange(request, {
      subjectType: "POS_TERMINAL",
      subjectId: terminal.id,
      merchantId: terminal.application.merchantId,
      action: "POS_TERMINAL_REACTIVATE",
      reason: body.reason,
      payload: { fromStatus: terminal.status, toStatus: "ACTIVE" },
    });
    response.status(202).json({ approvalRequestId: approval.id, state: approval.state });
    return;
  }

  // ACTIVE -> INACTIVE | BLOCKED and INACTIVE -> BLOCKED only tighten. A
  // BLOCKED terminal leaves that state through an approved reactivation only.
  if (terminal.status === "BLOCKED") {
    throw new ApiError(409, "POS_TERMINAL_INVALID_TRANSITION", "A blocked terminal can only be reactivated through an approval", {
      currentStatus: terminal.status,
      requested: body.status,
    });
  }
  const updated = await client.$transaction(async (tx) => {
    const changed = await tx.posTerminal.updateMany({ where: { id: terminal.id, status: terminal.status }, data: { status: body.status } });
    if (changed.count !== 1) {
      throw new ApiError(409, "POS_TERMINAL_INVALID_TRANSITION", "The POS terminal changed concurrently");
    }
    await auditTx(tx, {
      data: {
        ...actor,
        action: "POS_TERMINAL_STATUS_CHANGED",
        entityType: "POS_TERMINAL",
        entityId: terminal.id,
        merchantId: terminal.application.merchantId,
        beforeJson: { status: terminal.status },
        afterJson: { status: body.status, reason: body.reason },
      },
    });
    return tx.posTerminal.findUniqueOrThrow({ where: { id: terminal.id }, select: posTerminalSelect });
  });
  response.json({ posTerminal: serializePosTerminal(updated) });
});

/* -------------------------------------------------------------------------- */
/* Merchant beneficial owners and KYB re-validations                           */
/* -------------------------------------------------------------------------- */

const merchantParam = z.object({ id: idParam }).strict();
const ownerParams = z.object({ id: idParam, ownerId: idParam }).strict();

// Mirrors `adminOwnerSchema` of the join-request owner handlers (admin.ts).
const ownerBase = z.object({
  fullName: z.string().min(2).max(160),
  fullNameEn: z.string().min(2).max(160).optional(),
  identityType: z.enum(["NATIONAL_ID", "PASSPORT"]),
  identityNumber: z.string().min(4).max(32),
  nationality: z.string().length(2).optional(),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  ownershipPercent: z.string().regex(/^\d{1,3}(?:\.\d{1,2})?$/).optional(),
  role: z.enum(["OWNER", "DIRECTOR", "SIGNATORY", "CONTROLLER"]).optional(),
  pepDeclared: z.boolean().optional(),
  position: z.string().min(2).max(80).optional(),
});
const ownerCreateSchema = ownerBase.strict();
const ownerUpdateSchema = ownerBase.partial().strict();

const ownerSelect = {
  id: true,
  fullNameAr: true,
  fullNameEn: true,
  role: true,
  ownershipPercent: true,
  nationality: true,
  pepDeclared: true,
  screeningStatus: true,
  active: true,
  validFrom: true,
  validTo: true,
  dateOfBirth: true,
} as const;

// nationalIdCiphertext and nationalIdHash are never selected.
const serializeOwner = (owner: Prisma.BeneficialOwnerGetPayload<{ select: typeof ownerSelect }>) => ({
  id: owner.id,
  fullNameAr: owner.fullNameAr,
  fullNameEn: owner.fullNameEn,
  role: owner.role,
  ownershipPercent: owner.ownershipPercent === null ? null : decimal(owner.ownershipPercent).toFixed(2),
  nationality: owner.nationality,
  pepDeclared: owner.pepDeclared,
  screeningStatus: owner.screeningStatus,
  active: owner.active,
  validFrom: owner.validFrom,
  validTo: owner.validTo,
  dateOfBirth: owner.dateOfBirth,
});

const loadOpenMerchant = async (id: string) => {
  const merchant = await client.merchant.findUnique({ where: { id }, select: { id: true, status: true } });
  if (!merchant) throw new ApiError(404, "MERCHANT_NOT_FOUND", "The merchant does not exist");
  if (merchant.status === "CLOSED") {
    throw new ApiError(409, "MERCHANT_CLOSED", "A closed merchant can not be changed");
  }
  return merchant;
};

const activeOwnershipTotal = async (merchantId: string, excludeOwnerId?: string) => {
  const owners = await client.beneficialOwner.findMany({
    where: { merchantId, active: true, ...(excludeOwnerId ? { id: { not: excludeOwnerId } } : {}) },
    select: { ownershipPercent: true },
  });
  return owners.reduce((sum, owner) => sum.plus(owner.ownershipPercent === null ? 0 : decimal(owner.ownershipPercent)), decimal(0));
};

const assertOwnershipWithinLimit = (others: ReturnType<typeof decimal>, percent: string | undefined): void => {
  if (percent === undefined) return;
  if (others.plus(decimal(percent)).greaterThan(100)) {
    throw new ApiError(409, "OWNERSHIP_PERCENT_EXCEEDED", "The active beneficial owners can not hold more than 100 percent", {
      otherOwnersPercent: others.toFixed(2),
      requestedPercent: decimal(percent).toFixed(2),
    });
  }
};

router.get("/merchants/:id/beneficial-owners", async (request: Request, response: Response) => {
  requireAuthorities(request, ["merchant:read", "kyb:read", "kyb:write"]);
  const { id } = parseOrThrow(merchantParam, request.params);
  const merchant = await client.merchant.findUnique({ where: { id }, select: { id: true } });
  if (!merchant) throw new ApiError(404, "MERCHANT_NOT_FOUND", "The merchant does not exist");
  const owners = await client.beneficialOwner.findMany({
    where: { merchantId: id },
    orderBy: [{ active: "desc" }, { createdAt: "asc" }],
    select: ownerSelect,
  });
  response.json({ beneficialOwners: owners.map(serializeOwner) });
});

router.post("/merchants/:id/beneficial-owners", async (request: Request, response: Response) => {
  requireAuthorities(request, ["kyb:write", "merchant:write"]);
  const { id } = parseOrThrow(merchantParam, request.params);
  const body = parseOrThrow(ownerCreateSchema, request.body);
  const actor = staffAudit(request);
  await loadOpenMerchant(id);
  assertOwnershipWithinLimit(await activeOwnershipTotal(id), body.ownershipPercent);
  const identityNumber = body.identityNumber;
  const created = await client.$transaction(async (tx) => {
    const owner = await tx.beneficialOwner.create({
      data: {
        merchantId: id,
        fullNameAr: body.fullName,
        fullNameEn: body.fullNameEn ?? null,
        nationalIdCiphertext: await vault.encryptSecret(identityNumber, "kyb-national-id"),
        nationalIdHash: nationalIdHash(identityNumber),
        // Same default as the join-request handler (the column is NOT NULL).
        dateOfBirth: body.dateOfBirth ? new Date(body.dateOfBirth) : new Date(),
        nationality: (body.nationality ?? "LY").toUpperCase(),
        ownershipPercent: body.ownershipPercent ? new Prisma.Decimal(body.ownershipPercent) : null,
        role: body.role ?? "OWNER",
        pepDeclared: body.pepDeclared ?? false,
        screeningStatus: "NOT_SCREENED",
        validFrom: new Date(),
      },
      select: ownerSelect,
    });
    await auditTx(tx, {
      data: {
        ...actor,
        action: "BENEFICIAL_OWNER_ADDED",
        entityType: "BENEFICIAL_OWNER",
        entityId: owner.id,
        merchantId: id,
        beforeJson: {},
        afterJson: { role: owner.role, ownershipPercent: body.ownershipPercent ?? null, pepDeclared: owner.pepDeclared },
      },
    });
    return owner;
  });
  response.status(201).json({ beneficialOwner: serializeOwner(created) });
});

router.patch("/merchants/:id/beneficial-owners/:ownerId", async (request: Request, response: Response) => {
  requireAuthorities(request, ["kyb:write", "merchant:write"]);
  const params = parseOrThrow(ownerParams, request.params);
  const body = parseOrThrow(ownerUpdateSchema, request.body);
  if (Object.keys(body).length === 0) {
    throw new ApiError(400, "BENEFICIAL_OWNER_UPDATE_REQUIRED", "At least one beneficial owner field is required");
  }
  const actor = staffAudit(request);
  await loadOpenMerchant(params.id);
  const owner = await client.beneficialOwner.findFirst({
    where: { id: params.ownerId, merchantId: params.id },
    select: ownerSelect,
  });
  if (!owner) throw new ApiError(404, "BENEFICIAL_OWNER_NOT_FOUND", "The beneficial owner does not exist");
  if (!owner.active) {
    throw new ApiError(409, "BENEFICIAL_OWNER_INACTIVE", "A deactivated beneficial owner can not be edited");
  }
  if (body.ownershipPercent !== undefined) {
    assertOwnershipWithinLimit(await activeOwnershipTotal(params.id, owner.id), body.ownershipPercent);
  }
  const data: Prisma.BeneficialOwnerUpdateInput = {};
  const name = body.fullName;
  if (name !== undefined) data.fullNameAr = name;
  if (body.fullNameEn !== undefined) data.fullNameEn = body.fullNameEn;
  if (body.identityNumber !== undefined) {
    data.nationalIdCiphertext = await vault.encryptSecret(body.identityNumber, "kyb-national-id");
    data.nationalIdHash = nationalIdHash(body.identityNumber);
  }
  if (body.nationality !== undefined) data.nationality = body.nationality.toUpperCase();
  if (body.dateOfBirth !== undefined) data.dateOfBirth = new Date(body.dateOfBirth);
  if (body.ownershipPercent !== undefined) data.ownershipPercent = new Prisma.Decimal(body.ownershipPercent);
  if (body.role !== undefined) data.role = body.role;
  if (body.pepDeclared !== undefined) data.pepDeclared = body.pepDeclared;
  // Any change of who the person is invalidates the earlier screening result.
  const identityChanged =
    name !== undefined || body.identityNumber !== undefined || body.nationality !== undefined
    || body.dateOfBirth !== undefined || body.pepDeclared !== undefined;
  if (identityChanged) data.screeningStatus = "NOT_SCREENED";
  const updated = await client.$transaction(async (tx) => {
    const saved = await tx.beneficialOwner.update({ where: { id: owner.id }, data, select: ownerSelect });
    await auditTx(tx, {
      data: {
        ...actor,
        action: "BENEFICIAL_OWNER_UPDATED",
        entityType: "BENEFICIAL_OWNER",
        entityId: owner.id,
        merchantId: params.id,
        beforeJson: { role: owner.role, screeningStatus: owner.screeningStatus },
        afterJson: {
          changedFields: Object.keys(body).map((key) => (key === "identityNumber" ? "identity" : key)),
          screeningReset: identityChanged,
        },
      },
    });
    return saved;
  });
  response.json({ beneficialOwner: serializeOwner(updated) });
});

router.delete("/merchants/:id/beneficial-owners/:ownerId", async (request: Request, response: Response) => {
  requireAuthorities(request, ["kyb:write", "merchant:write"]);
  const params = parseOrThrow(ownerParams, request.params);
  const actor = staffAudit(request);
  await loadOpenMerchant(params.id);
  const owner = await client.beneficialOwner.findFirst({
    where: { id: params.ownerId, merchantId: params.id, active: true },
    select: { id: true, role: true },
  });
  if (!owner) throw new ApiError(404, "BENEFICIAL_OWNER_NOT_FOUND", "The beneficial owner does not exist");
  await client.$transaction(async (tx) => {
    const changed = await tx.beneficialOwner.updateMany({
      where: { id: owner.id, active: true },
      data: { active: false, validTo: new Date() },
    });
    if (changed.count !== 1) {
      throw new ApiError(404, "BENEFICIAL_OWNER_NOT_FOUND", "The beneficial owner does not exist");
    }
    await auditTx(tx, {
      data: {
        ...actor,
        action: "BENEFICIAL_OWNER_DEACTIVATED",
        entityType: "BENEFICIAL_OWNER",
        entityId: owner.id,
        merchantId: params.id,
        beforeJson: { active: true, role: owner.role },
        afterJson: { active: false },
      },
    });
  });
  response.json({ id: owner.id, active: false });
});

const KYB_DOC_TYPES = [
  "COMMERCIAL_REGISTRY",
  "TAX_CERTIFICATE",
  "ARTICLES_OF_ASSOCIATION",
  "OWNER_ID",
  "SIGNATORY_ID",
  "PROOF_OF_ADDRESS",
  "BANK_LETTER",
  "SECTOR_LICENSE",
  "OTHER",
] as const;

router.post("/merchants/:id/revalidations", async (request: Request, response: Response) => {
  requireAuthorities(request, ["kyb:write", "merchant:write"]);
  const { id } = parseOrThrow(merchantParam, request.params);
  const body = parseOrThrow(
    z
      .object({
        docType: z.enum(KYB_DOC_TYPES),
        dueAt: z.string().min(10).max(64).optional(),
        message: z.string().trim().min(3).max(1000),
        reasonCode: z.string().trim().min(1).max(64).optional(),
      })
      .strict(),
    request.body,
  );
  const actor = actorFromRequest(request);
  await loadOpenMerchant(id);
  const now = new Date();
  const policy = await readKybRefreshPolicy(client);
  const dueAt = body.dueAt ? new Date(body.dueAt) : new Date(now.getTime() + policy.revalidationDueDays * 24 * 60 * 60 * 1000);
  if (Number.isNaN(dueAt.getTime())) {
    throw new ApiError(400, "INVALID_BODY", "dueAt must be an ISO date or date-time");
  }
  if (dueAt.getTime() <= now.getTime()) {
    throw new ApiError(400, "KYB_REVALIDATION_DUE_IN_PAST", "The due date must be in the future");
  }
  const existing = await client.kybRevalidationRequest.findFirst({
    where: { merchantId: id, docType: body.docType, status: "OPEN" },
    select: { id: true },
  });
  if (existing) {
    throw new ApiError(409, "KYB_REVALIDATION_ALREADY_OPEN", "A revalidation request is already open for this document type", {
      revalidationRequestId: existing.id,
    });
  }
  const source = await client.kybDocument.findFirst({
    where: { merchantId: id, docType: body.docType },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  const created = await client.$transaction(async (tx) => {
    const row = await tx.kybRevalidationRequest.create({
      data: {
        merchantId: id,
        documentId: source?.id ?? null,
        docType: body.docType,
        reasonCode: body.reasonCode ?? "MERCHANT_REVALIDATION",
        message: body.message,
        status: "OPEN",
        requestedById: actor.userId,
        requestedAt: now,
        dueAt,
      },
    });
    await tx.merchant.update({ where: { id }, data: { kybStatus: "PENDING" } });
    await auditTx(tx, {
      data: {
        actorId: actor.userId,
        role: actor.role,
        action: "KYB_REVALIDATION_REQUESTED",
        entityType: "KYB_REVALIDATION_REQUEST",
        entityId: row.id,
        merchantId: id,
        beforeJson: {},
        afterJson: { docType: body.docType, dueAt: dueAt.toISOString(), reasonCode: row.reasonCode },
      },
    });
    return row;
  });
  await queueKybNotification(client, {
    merchantId: id,
    code: "KYB_REVALIDATION_DUE",
    payload: { documentType: body.docType, dueAt: dueAt.toISOString(), message: body.message },
    eventKey: `revalidation:${created.id}`,
  });
  response.status(201).json({
    revalidation: {
      id: created.id,
      merchantId: id,
      docType: created.docType,
      reasonCode: created.reasonCode,
      message: created.message,
      status: created.status,
      dueAt: created.dueAt,
      requestedAt: created.requestedAt,
    },
  });
});
