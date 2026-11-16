import { Router, type Request } from "express";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { client } from "../../prisma/client";
import { requireAuthentication, principalOf, isStaffPrincipal } from "../middleware/authDoubleCheck";
import { ApiError, parseOrThrow } from "../../lib/error";
import { isSandboxPlane } from "../../lib/executionPlane";
import { generateAccessToken, hashAccessToken } from "../../lib/auth";
import { accessTokenPrefixForPlane } from "../../lib/executionPlane";
import { loadLiveAccountBalances } from "../../lib/storageEngine/shardBalances";
import { getPlatformRuntime } from "../../engine/runtime";
import { FakeRailsControlClient } from "../../engine/rails/FakeRailsControlClient";
import { Prisma } from "../../generated/prisma/client";
import { executeAdjustment, executeCashout, type GovernanceExecutionContext } from "../../engine/governance/GovernanceExecution";
import { payoutAccountHash } from "../../lib/joinRequestOnboarding";
import { listAccountLines } from "./ledgerLines";
import { writeAudit } from "../../lib/audit/writeAudit";
import { StatementIngestor } from "../../engine/reconciliation/StatementIngestor";
import { buildListQuery, listResponse } from "../../lib/listQuery";
import { loadAccountCheckpointSummary, naturalShardBalance } from "../../lib/storageEngine/shardBalances";

/**
 * The Sandbox Studio control plane.
 *
 * This router exists only on `pg-core-sandbox` (`EXECUTION_PLANE=SANDBOX`).
 * It owns the merchant sandbox envelope, the virtual wallet balance, the
 * demo workspace seeder/reset, and the proxy to the Fake Rails v2 test
 * customer accounts. Every operation is scoped to the authenticated
 * merchant; a staff principal must name the merchant explicitly.
 */

const router = Router();
router.use(requireAuthentication);
router.use((_request, _response, next) => {
  if (!isSandboxPlane()) {
    next(
      new ApiError(
        403,
        "SANDBOX_PLANE_REQUIRED",
        "This endpoint is only available on the SANDBOX execution plane (pg-core-sandbox)",
      ),
    );
    return;
  }
  next();
});

const fakeRails = new FakeRailsControlClient();

const governanceContext = (platform: ReturnType<typeof getPlatformRuntime>): GovernanceExecutionContext => ({
  ledgerPoster: platform.ledgerPoster,
  repositories: platform.repositories,
  engine: platform.engine,
  transitionBus: undefined,
  slots: platform.slots,
  reconciliationScheduler: platform.refundScheduler,
  commissionNetting: platform.commissionNetting,
});

const SANDBOX_PAYOUT_DETAILS = {
  bankName: "Sandbox Test Bank",
  accountNumber: "SBX-0000000001",
  iban: "LY0000000000000000000001",
  accountHolder: "Sandbox Test Merchant",
} as const;

type SandboxMerchantRow = NonNullable<Awaited<ReturnType<typeof client.merchant.findUnique>>>;

const ensureSandboxPayoutProfile = async (merchant: SandboxMerchantRow): Promise<SandboxMerchantRow> => {
  if (merchant.payoutAccountHash) return merchant;
  const details = merchant.payoutBankDetailsJson ?? SANDBOX_PAYOUT_DETAILS;
  const hash = payoutAccountHash(details);
  if (!hash) return merchant;
  return client.merchant.update({
    where: { id: merchant.id },
    data: { payoutBankDetailsJson: details as never, payoutAccountHash: hash },
  });
};

const requireStaff = (request: Request) => {
  const principal = principalOf(request);
  if (!isStaffPrincipal(principal)) {
    throw new ApiError(403, "STAFF_ONLY", "A staff principal is required");
  }
  return principal;
};

const merchantIdSchema = z.object({ merchantId: z.string().uuid() });

const resolveMerchantId = (request: Request, explicit?: string | null): string => {
  const principal = principalOf(request);
  if (principal.merchantId) return principal.merchantId;
  if (!isStaffPrincipal(principal)) {
    throw new ApiError(403, "MERCHANT_CONTEXT_REQUIRED", "A merchant principal is required");
  }
  const candidate = String(
    explicit
    ?? request.header("x-sandbox-merchant-id")
    ?? request.query.merchantId
    ?? "",
  ).trim();
  if (!candidate) {
    throw new ApiError(400, "SANDBOX_MERCHANT_REQUIRED", "A staff Sandbox operation must name the merchant");
  }
  return candidate;
};

const ensureSandboxMerchantEnvelope = async (input: {
  merchantId: string;
  businessName?: string | null;
  email?: string | null;
}) => {
  const existing = await client.merchant.findUnique({ where: { id: input.merchantId } });
  if (existing) return ensureSandboxPayoutProfile(existing);
  const payoutHash = payoutAccountHash(SANDBOX_PAYOUT_DETAILS);
  const created = await client.merchant.create({
    data: {
      id: input.merchantId,
      legalName: input.businessName?.trim() || `Sandbox Merchant ${input.merchantId.slice(0, 8)}`,
      tradeName: input.businessName?.trim() || `Sandbox Merchant ${input.merchantId.slice(0, 8)}`,
      onboardingChannel: "SANDBOX",
      country: "LY",
      status: "ACTIVE",
      kybStatus: "VERIFIED",
      contactEmail: input.email?.trim() || `sandbox+${input.merchantId}@sandbox.local`,
      payoutBankDetailsJson: SANDBOX_PAYOUT_DETAILS as never,
      payoutAccountHash: payoutHash,
    },
  });
  return created;
};

const walletBalances = async (wallets: Array<{ id: string; glAccountId: string }>) => {
  const rows = await loadLiveAccountBalances(client as never, wallets.map((wallet) => wallet.glAccountId));
  const byAccount = new Map(rows.map((row) => [row.id, row.balance]));
  return wallets.map((wallet) => ({
    walletId: wallet.id,
    availableBalance: byAccount.get(wallet.glAccountId) ?? "0.0000",
  }));
};

const postWalletAdjustment = async (input: {
  wallet: { id: string; merchantId: string; currency: string; glAccountId: string };
  deltaMicros: bigint;
  reason: string;
  actorId: string;
  actorRole: string;
}): Promise<string> => {
  if (input.deltaMicros === 0n) {
    const [balance] = await walletBalances([input.wallet]);
    return balance?.availableBalance ?? "0.0000";
  }
  const amount = new Prisma.Decimal(input.deltaMicros.toString()).div(10_000).toFixed(4);
  const credit = input.deltaMicros > 0n;
  const template = {
    refType: "ADJUSTMENT" as const,
    refId: `SANDBOX_WALLET:${input.wallet.id}:${randomUUID()}`,
    description: `Sandbox wallet ${credit ? "top-up" : "debit"} (${amount} ${input.wallet.currency})`,
    lines: credit
      ? [
          { direction: "DEBIT" as const, amount, account: { accountType: "TREASURY" as const } },
          {
            direction: "CREDIT" as const,
            amount,
            account: { accountType: "MERCHANT_WALLET" as const, accountId: input.wallet.glAccountId },
          },
        ]
      : [
          {
            direction: "DEBIT" as const,
            amount,
            account: { accountType: "MERCHANT_WALLET" as const, accountId: input.wallet.glAccountId },
          },
          { direction: "CREDIT" as const, amount, account: { accountType: "TREASURY" as const } },
        ],
  };
  const runtime = getPlatformRuntime(client as never);
  await client.$transaction(async (tx) => {
    await runtime.ledgerPoster.post(template, { currency: input.wallet.currency, env: "SANDBOX" }, tx as never);
    await tx.sandboxSyncAudit.create({
      data: {
        syncType: "WALLET_TOPUP",
        merchantId: input.wallet.merchantId,
        actorId: input.actorId,
        actorRole: input.actorRole,
        summaryJson: {
          walletId: input.wallet.id,
          delta: amount,
          direction: credit ? "CREDIT" : "DEBIT",
          reason: input.reason,
        },
      },
    });
  });
  const [balance] = await walletBalances([input.wallet]);
  return balance?.availableBalance ?? "0.0000";
};

router.get("/merchant/overview", async (request, response) => {
  const merchantId = resolveMerchantId(request);
  const merchant = await ensureSandboxMerchantEnvelope({
    merchantId,
    businessName: request.header("x-merchant-name"),
    email: request.header("x-merchant-email"),
  });
  const [wallets, applications, links, attempts, tokens, planeState, pendingCashouts, syncAudits, refs] = await Promise.all([
    client.wallet.findMany({ where: { merchantId }, orderBy: { createdAt: "desc" } }),
    client.application.count({ where: { merchantId } }),
    client.paymentLink.count({ where: { application: { merchantId } } }),
    client.paymentAttempt.count({ where: { merchantId } }),
    client.accessToken.count({ where: { merchantId, env: "SANDBOX", revokedAt: null } }),
    client.systemExecutionPlane.findUnique({ where: { id: 1 } }),
    client.cashoutRequest.count({ where: { merchantId, state: { in: ["PENDING", "PROCESSING"] } } }),
    client.sandboxSyncAudit.findMany({ where: { merchantId }, orderBy: { createdAt: "desc" }, take: 10 }),
    Promise.all([
      client.rail.count(),
      client.gateway.count(),
      client.railRoute.count(),
      client.commissionProfile.count({ where: { merchantId: null, applicationId: null } }),
    ]),
  ]);
  const balances = await walletBalances(wallets);
  const balanceByWallet = new Map(balances.map((row) => [row.walletId, row.availableBalance]));
  let fakeCustomerAccounts: unknown[] = [];
  let fakeRailsHealth: { ok: boolean; message?: string } = { ok: true };
  try {
    fakeCustomerAccounts = await fakeRails.listAccounts({ merchantId });
  } catch (error) {
    fakeRailsHealth = { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  const [rails, gateways, routes, commissionProfiles] = refs;
  response.json({
    plane: "SANDBOX",
    merchantId,
    merchantName: merchant.tradeName,
    payoutBankDetails: merchant.payoutBankDetailsJson,
    liveSyncRevision: planeState?.liveSyncRevision ?? 0,
    lastSyncedFromLive: planeState?.lastSyncedFromLive ?? null,
    fakeRails: fakeRailsHealth,
    reference: { rails, gateways, routes, commissionProfiles, ready: rails > 0 && gateways > 0 && routes > 0 },
    counts: {
      wallets: wallets.length,
      applications,
      links,
      payments: attempts,
      pendingCashouts,
      activeTestTokens: tokens,
      fakeCustomerAccounts: fakeCustomerAccounts.length,
    },
    syncAudits,
    wallets: wallets.map((wallet) => ({
      id: wallet.id,
      name: wallet.name,
      currency: wallet.currency,
      status: wallet.status,
      availableBalance: balanceByWallet.get(wallet.id) ?? "0.0000",
    })),
  });
});

router.post("/merchant/wallets/:walletId/balance", async (request, response) => {
  const merchantId = resolveMerchantId(request);
  const { walletId } = request.params;
  const body = parseOrThrow(
    z
      .object({
        mode: z.enum(["CREDIT", "DEBIT", "SET_EXACT"]),
        amountMinor: z.coerce.number().int().nonnegative().optional(),
        amountLyd: z.string().regex(/^\d{1,14}(\.\d{1,4})?$/).optional(),
        reason: z.string().max(255).optional(),
      })
      .strict(),
    request.body,
  );
  const wallet = await client.wallet.findFirst({ where: { id: walletId, merchantId } });
  if (!wallet) {
    throw new ApiError(404, "SANDBOX_WALLET_NOT_FOUND", "The sandbox wallet does not exist");
  }
  const [current] = await walletBalances([wallet]);
  const currentMicros = BigInt(
    Math.round(Number(current?.availableBalance ?? "0") * 10_000),
  );
  const requestedMicros = body.amountLyd !== undefined
    ? BigInt(Math.round(Number(body.amountLyd) * 10_000))
    : BigInt(Math.max(0, Math.trunc(Number(body.amountMinor ?? 0)) * 10));
  const delta = body.mode === "CREDIT"
    ? requestedMicros
    : body.mode === "DEBIT"
      ? -requestedMicros
      : requestedMicros - currentMicros;
  if (currentMicros + delta < 0n) {
    throw new ApiError(
      409,
      "NEGATIVE_SANDBOX_WALLET_BALANCE",
      "The resulting sandbox wallet balance cannot be negative",
    );
  }
  const principal = principalOf(request);
  const balance = await postWalletAdjustment({
    wallet,
    deltaMicros: delta,
    reason: body.reason ?? `Sandbox wallet ${body.mode}`,
    actorId: principal.userId ?? merchantId,
    actorRole: isStaffPrincipal(principal) ? "ADMIN" : "MERCHANT",
  });
  response.json({ ok: true, walletId: wallet.id, availableBalance: balance });
});

router.post("/merchant/seed-history", async (request, response) => {
  const merchantId = resolveMerchantId(request);
  const body = parseOrThrow(
    z.object({
      count: z.coerce.number().int().min(1).max(100).default(20),
      amountLyd: z.string().regex(/^\d{1,14}(\.\d{1,4})?$/).optional(),
    }).strict(),
    request.body ?? {},
  );
  const principal = principalOf(request);
  await ensureSandboxMerchantEnvelope({ merchantId });
  const link = await client.paymentLink.findFirst({
    where: { application: { merchantId } },
    include: { application: true, wallet: true },
    orderBy: { createdAt: "asc" },
  });
  if (!link) throw new ApiError(409, "SANDBOX_LINK_REQUIRED", "Seed the demo workspace before generating payment history");
  const route = await client.railRoute.findFirst({
    where: { status: "ACTIVE", gateway: { status: "LIVE" } },
    include: { rail: true, gateway: true },
    orderBy: { priority: "desc" },
  });
  if (!route) throw new ApiError(503, "SANDBOX_ROUTE_MISSING", "No active sandbox route is available");
  const gatewayVersion = await client.gatewayVersion.findFirst({
    where: { gatewayId: route.gatewayId },
    orderBy: { versionNumber: "desc" },
  });
  const credentialSet = await client.credentialSet.findFirst({
    where: { gatewayId: route.gatewayId, env: "SANDBOX", ownerMerchantId: null },
    orderBy: { createdAt: "asc" },
  }) ?? await client.credentialSet.findFirst({
    where: { gatewayId: route.gatewayId, env: "SANDBOX", ownerMerchantId: merchantId },
    orderBy: { createdAt: "asc" },
  });
  let commissionProfile = await client.commissionProfile.findFirst({
    where: {
      OR: [
        { merchantId, applicationId: null },
        { merchantId: null, applicationId: null },
      ],
    },
    orderBy: [{ merchantId: "desc" }, { createdAt: "asc" }],
  });
  if (!gatewayVersion || !credentialSet) {
    throw new ApiError(503, "SANDBOX_REFERENCE_INCOMPLETE", "The sandbox gateway version or credential set is missing");
  }
  if (!commissionProfile) {
    commissionProfile = await client.commissionProfile.create({
      data: {
        railCode: route.rail.code,
        calcType: "FLAT",
        flatFee: new Prisma.Decimal(0),
        percentageRate: new Prisma.Decimal(0),
        minFee: new Prisma.Decimal(0),
        feeBearerDefault: link.feeBearer,
        roundingMode: "HALF_UP",
        effectiveFrom: new Date(0),
        seedKey: `sandbox-history:${merchantId}:${route.rail.code}`,
      },
    });
  }
  const platform = getPlatformRuntime(client as never);
  const created: string[] = [];
  for (let index = 0; index < body.count; index += 1) {
    const amount = new Prisma.Decimal(body.amountLyd ?? link.amount.toString()).toFixed(4);
    const reference = `sbx_hist_${Date.now().toString(36)}_${index}_${randomBytes(3).toString("hex")}`;
    const occurredAt = new Date(Date.now() - (index + 1) * 86_400_000);
    await client.$transaction(async (tx) => {
      const group = await tx.attemptGroup.create({
        data: {
          linkId: link.id,
          customerFingerprint: `sandbox-history:${reference}`,
          successCount: 1,
        },
      });
      const attempt = await tx.paymentAttempt.create({
        data: {
          reference,
          linkId: link.id,
          attemptGroupId: group.id,
          applicationId: link.applicationId,
          merchantId,
          railId: route.railId,
          routeId: route.id,
          credentialSetId: credentialSet.id,
          gatewayVersionId: gatewayVersion.id,
          commissionProfileId: commissionProfile.id,
          env: "SANDBOX",
          mode: "SANDBOX_HISTORY",
          status: "SUCCEEDED",
          requestedAmount: new Prisma.Decimal(amount),
          totalChargedAmount: new Prisma.Decimal(amount),
          settledAmount: new Prisma.Decimal(amount),
          gatewayFeeAmount: new Prisma.Decimal(0),
          platformCommissionAmount: new Prisma.Decimal(0),
          netMerchantAmount: new Prisma.Decimal(amount),
          feeBearer: link.feeBearer,
          currency: link.currency,
          customerFieldsMasked: {},
          contextCiphertext: "",
          expiresAt: occurredAt,
          graceExpiresAt: occurredAt,
          terminalAt: occurredAt,
          createdAt: occurredAt,
          providerReference: `FAKE-${reference}`,
        },
      });
      const posted = await platform.ledgerPoster.post(
        {
          refType: "PAYMENT_ATTEMPT",
          refId: attempt.id,
          description: `Sandbox historical payment ${reference}`,
          lines: [
            { direction: "DEBIT", amount, account: { accountType: "TREASURY" } },
            { direction: "CREDIT", amount, account: { accountType: "MERCHANT_WALLET", accountId: link.wallet.glAccountId } },
          ],
        },
        { currency: link.currency, env: "SANDBOX", merchantId },
        tx as never,
      );
      await tx.paymentAttempt.update({ where: { id: attempt.id }, data: { ledgerEntryId: posted.entry.id } });
      created.push(attempt.id);
    });
  }
  await client.sandboxSyncAudit.create({
    data: {
      syncType: "MERCHANT_HISTORY_SEED",
      merchantId,
      actorId: principal.userId ?? merchantId,
      actorRole: isStaffPrincipal(principal) ? "ADMIN" : "MERCHANT",
      summaryJson: { attempts: created.length, railCode: route.rail.code, gatewayCode: route.gateway.code },
    },
  });
  response.status(201).json({ ok: true, created: created.length, attemptIds: created });
});

router.post("/merchant/seed-demo", async (request, response) => {
  const merchantId = resolveMerchantId(request);
  await ensureSandboxMerchantEnvelope({
    merchantId,
    businessName: request.header("x-merchant-name"),
    email: request.header("x-merchant-email"),
  });
  const principal = principalOf(request);
  const created = await client.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtext($1))", `sandbox-seed:${merchantId}`);
    let wallet = await tx.wallet.findFirst({ where: { merchantId }, orderBy: { createdAt: "asc" } });
    if (!wallet) {
      const glAccount = await tx.glAccount.create({
        data: { accountType: "MERCHANT_WALLET", ownerId: merchantId, currency: "LYD" },
      });
      wallet = await tx.wallet.create({
        data: {
          merchantId,
          glAccountId: glAccount.id,
          currency: "LYD",
          name: "Sandbox Primary LYD Wallet",
          status: "ACTIVE",
        },
      });
    } else if (wallet.status !== "ACTIVE") {
      wallet = await tx.wallet.update({ where: { id: wallet.id }, data: { status: "ACTIVE" } });
    }
    let application = await tx.application.findFirst({ where: { merchantId, assignedWalletId: wallet.id } });
    if (!application) {
      application = await tx.application.create({
        data: {
          merchantId,
          assignedWalletId: wallet.id,
          name: "Sandbox Store & Employee Training",
          businessUseDescription: "Sandbox integration testing and employee training",
          status: "ACTIVE",
        },
      });
    } else if (application.status !== "ACTIVE") {
      application = await tx.application.update({ where: { id: application.id }, data: { status: "ACTIVE" } });
    }

    const links: Array<{ id: string; key: string }> = [];
    for (const sample of [
      { title: "Sandbox test checkout — 125.000 LYD", amount: "125.0000" },
      { title: "Sandbox test checkout — 1,500.000 LYD", amount: "1500.0000" },
      { title: "Sandbox test checkout — 25,000.000 LYD", amount: "25000.0000" },
    ]) {
      let link = await tx.paymentLink.findFirst({
        where: { applicationId: application.id, amount: new Prisma.Decimal(sample.amount) },
      });
      if (!link) {
        link = await tx.paymentLink.create({
          data: {
            key: `sbx_${randomBytes(12).toString("base64url")}`,
            title: sample.title,
            description: "Use the Sandbox Test Assistant on Checkout to test OTPs, balances and disputes",
            applicationId: application.id,
            walletId: wallet.id,
            amount: new Prisma.Decimal(sample.amount),
            currency: "LYD",
            feeBearer: "MERCHANT_ABSORBS",
            infiniteUse: true,
            useCount: 1_000_000,
            env: "SANDBOX",
            state: "PENDING",
          },
        });
      }
      links.push({ id: link.id, key: link.key });
    }

    const terminal = await tx.posTerminal.findFirst({ where: { applicationId: application.id } });
    if (!terminal) {
      await tx.posTerminal.create({
        data: {
          applicationId: application.id,
          name: "SBX-POS-001 Employee Training Terminal",
          location: "Sandbox training room",
          status: "ACTIVE",
        },
      });
    }
    return { wallet, application, links };
  });

  const [current] = await walletBalances([{ id: created.wallet.id, glAccountId: created.wallet.glAccountId }]);
  if (Number(current?.availableBalance ?? "0") < 5_000) {
    const delta = 5_000_000n - BigInt(Math.round(Number(current?.availableBalance ?? "0") * 10_000));
    await postWalletAdjustment({
      wallet: created.wallet,
      deltaMicros: delta,
      reason: "Sandbox demo workspace starting balance",
      actorId: principal.userId ?? merchantId,
      actorRole: "SYSTEM",
    });
  }

  let testToken: string | null = null;
  const existingToken = await client.accessToken.findFirst({
    where: { merchantId, env: "SANDBOX", revokedAt: null },
  });
  if (!existingToken) {
    const plaintext = `${accessTokenPrefixForPlane("SANDBOX")}${generateAccessToken().slice("pg_live_".length)}`;
    await client.accessToken.create({
      data: {
        merchantId,
        applicationId: created.application.id,
        name: "Sandbox demo token",
        env: "SANDBOX",
        tokenHash: hashAccessToken(plaintext),
        lastFour: plaintext.slice(-4),
        scopes: ["link:write", "link:read", "payment:read"],
      },
    });
    testToken = plaintext;
  }

  await client.sandboxSyncAudit.create({
    data: {
      syncType: "MERCHANT_DEMO_SEED",
      merchantId,
      actorId: merchantId,
      actorRole: "MERCHANT",
      summaryJson: {
        walletId: created.wallet.id,
        applicationId: created.application.id,
        linkKeys: created.links.map((link) => link.key),
      },
    },
  });

  response.status(201).json({
    ok: true,
    walletId: created.wallet.id,
    applicationId: created.application.id,
    linkKey: created.links[0]?.key ?? null,
    linkKeys: created.links.map((link) => link.key),
    checkoutUrl: created.links[0] ? `/pay/${created.links[0].key}` : null,
    checkoutUrls: created.links.map((link) => `/pay/${link.key}`),
    testToken,
    testTokenWarning: testToken ? "This pg_test_ token is shown once" : "An active sandbox token already exists",
  });
});

const resetMerchantSandbox = async (merchantId: string) => {
  const summary = await client.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtext($1))", `sandbox-reset:${merchantId}`);
    const attempts = await tx.paymentAttempt.findMany({ where: { merchantId }, select: { id: true } });
    const attemptIds = attempts.map((attempt) => attempt.id);
    const disputes = await tx.dispute.findMany({ where: { attempt: { merchantId } }, select: { id: true } });
    const disputeIds = disputes.map((dispute) => dispute.id);
    if (disputeIds.length > 0) {
      await tx.disputeAttachment.deleteMany({ where: { disputeId: { in: disputeIds } } });
      await tx.dispute.deleteMany({ where: { id: { in: disputeIds } } });
    }
    if (attemptIds.length > 0) {
      await tx.adjustment.deleteMany({ where: { sourceAttemptId: { in: attemptIds } } });
      await tx.operatorCase.deleteMany({ where: { attemptId: { in: attemptIds } } });
      await tx.gatewayInquirySchedule.deleteMany({ where: { attemptId: { in: attemptIds } } });
      await tx.reconciliationItem.deleteMany({ where: { attemptId: { in: attemptIds } } });
      await tx.attemptStepLog.deleteMany({ where: { attemptId: { in: attemptIds } } });
    }
    const applications = await tx.application.findMany({ where: { merchantId }, select: { id: true } });
    const applicationIds = applications.map((application) => application.id);
    const links = await tx.paymentLink.findMany({
      where: { application: { merchantId } },
      select: { id: true },
    });
    const linkIds = links.map((link) => link.id);
    await tx.merchantWebhookDelivery.deleteMany({ where: { merchantId } });
    await tx.merchantWebhookEndpoint.deleteMany({ where: { merchantId } });
    await tx.cashoutRequest.deleteMany({ where: { merchantId } });
    await tx.paymentAttempt.deleteMany({ where: { merchantId } });
    if (linkIds.length > 0) {
      await tx.attemptGroup.deleteMany({ where: { linkId: { in: linkIds } } });
    }
    if (applicationIds.length > 0) {
      await tx.posScreen.deleteMany({ where: { pos: { applicationId: { in: applicationIds } } } });
      await tx.posTerminal.deleteMany({ where: { applicationId: { in: applicationIds } } });
      await tx.commissionProfile.deleteMany({ where: { applicationId: { in: applicationIds } } });
      await tx.approvalRequest.deleteMany({
        where: { subjectType: "APPLICATION", subjectId: { in: applicationIds } },
      });
    }
    await tx.commissionProfile.deleteMany({ where: { merchantId } });
    await tx.credentialSet.deleteMany({ where: { ownerMerchantId: merchantId } });
    await tx.paymentLink.deleteMany({ where: { application: { merchantId } } });
    await tx.application.deleteMany({ where: { merchantId } });
    await tx.accessToken.deleteMany({ where: { merchantId } });
    await tx.wallet.deleteMany({ where: { merchantId } });
    return {
      attempts: attemptIds.length,
      applications: applicationIds.length,
      links: linkIds.length,
      disputes: disputeIds.length,
    };
  });
  let fakeRailsReset = { removed: 0 };
  try {
    fakeRailsReset = await fakeRails.resetAccounts({ merchantId });
  } catch {
    fakeRailsReset = { removed: 0 };
  }
  return { ...summary, fakeCustomerAccountsRemoved: fakeRailsReset.removed };
};

router.post("/merchant/reset", async (request, response) => {
  const merchantId = resolveMerchantId(request);
  const principal = principalOf(request);
  const body = parseOrThrow(
    z.object({ confirm: z.string().max(32).optional() }).strict(),
    request.body ?? {},
  );
  if (body.confirm !== undefined && body.confirm !== "RESET") {
    throw new ApiError(400, "SANDBOX_RESET_CONFIRMATION_REQUIRED", "Type RESET to confirm the sandbox reset");
  }
  const summary = await resetMerchantSandbox(merchantId);
  await client.sandboxSyncAudit.create({
    data: {
      syncType: "MERCHANT_RESET",
      merchantId,
      actorId: principal.userId ?? merchantId,
      actorRole: isStaffPrincipal(principal) ? "ADMIN" : "MERCHANT",
      summaryJson: { resetAt: new Date().toISOString(), ...summary },
    },
  });
  response.json({
    ok: true,
    merchantId,
    ...summary,
    message: "Sandbox wallets, applications, links, payments and test customer accounts reset. Journal history is retained.",
  });
});

router.get("/merchant/wallets/:walletId", async (request, response) => {
  const merchantId = resolveMerchantId(request);
  const wallet = await client.wallet.findFirst({
    where: { id: String(request.params.walletId), merchantId },
    include: { glAccount: true },
  });
  if (!wallet) throw new ApiError(404, "SANDBOX_WALLET_NOT_FOUND", "The sandbox wallet does not exist");
  const [balance, pendingCashouts, applications, links, attempts] = await Promise.all([
    walletBalances([wallet]),
    client.cashoutRequest.count({ where: { walletId: wallet.id, state: { in: ["PENDING", "PROCESSING"] } } }),
    client.application.count({ where: { assignedWalletId: wallet.id } }),
    client.paymentLink.count({ where: { walletId: wallet.id } }),
    client.paymentAttempt.count({ where: { link: { walletId: wallet.id } } }),
  ]);
  response.json({
    wallet: {
      id: wallet.id,
      name: wallet.name,
      merchantId: wallet.merchantId,
      currency: wallet.currency,
      status: wallet.status,
      glAccountId: wallet.glAccountId,
      createdAt: wallet.createdAt,
    },
    availableBalance: balance[0]?.availableBalance ?? "0.0000",
    pendingCashouts,
    applications,
    links,
    attempts,
  });
});

router.get("/merchant/wallets/:walletId/ledger", async (request, response) => {
  const merchantId = resolveMerchantId(request);
  const wallet = await client.wallet.findFirst({
    where: { id: String(request.params.walletId), merchantId },
    select: { id: true, glAccountId: true, currency: true },
  });
  if (!wallet) throw new ApiError(404, "SANDBOX_WALLET_NOT_FOUND", "The sandbox wallet does not exist");
  const lines = await listAccountLines(wallet.glAccountId, request.query as Record<string, unknown>);
  response.json({ walletId: wallet.id, currency: wallet.currency, ...lines });
});

router.post("/merchant/wallets/:walletId/simulate-cashout", async (request, response) => {
  const merchantId = resolveMerchantId(request);
  const body = parseOrThrow(
    z
      .object({
        amountLyd: z.string().regex(/^\d{1,14}(\.\d{1,4})?$/),
        idempotencyKey: z.string().min(8).max(128).optional(),
        reason: z.string().max(255).optional(),
      })
      .strict(),
    request.body ?? {},
  );
  const wallet = await client.wallet.findFirst({ where: { id: String(request.params.walletId), merchantId } });
  if (!wallet) throw new ApiError(404, "SANDBOX_WALLET_NOT_FOUND", "The sandbox wallet does not exist");
  const merchant = await client.merchant.findUnique({ where: { id: merchantId } });
  if (!merchant) throw new ApiError(404, "MERCHANT_NOT_FOUND", "The merchant does not exist");
  const withPayout = await ensureSandboxPayoutProfile(merchant);
  const destination = withPayout.payoutBankDetailsJson ?? SANDBOX_PAYOUT_DETAILS;
  const principal = principalOf(request);
  const idempotencyKey = body.idempotencyKey ?? `sandbox-cashout:${randomUUID()}`;
  const cashout = await client.$transaction(async (tx) => {
    const existing = await tx.cashoutRequest.findFirst({ where: { merchantId, idempotencyKey } });
    if (existing) return existing;
    return tx.cashoutRequest.create({
      data: {
        merchantId,
        walletId: wallet.id,
        amount: new Prisma.Decimal(body.amountLyd),
        destinationBankJson: { ...(destination as Record<string, unknown>), payoutVerified: true } as never,
        state: "PENDING",
        idempotencyKey,
        requestedByUserId: principal.userId,
      },
    });
  });
  const platform = getPlatformRuntime(client as never);
  const result = await client.$transaction(async (tx) =>
    executeCashout(governanceContext(platform), tx as never, {
      cashoutId: cashout.id,
      decision: "APPROVE",
      reason: body.reason ?? "Sandbox simulated cash-out",
      actorUserId: principal.userId ?? merchantId,
      actorRole: principal.role ?? "MERCHANT_ADMIN",
    }),
  );
  const updated = await client.cashoutRequest.findUnique({ where: { id: cashout.id } });
  response.status(201).json({
    ok: true,
    cashoutId: cashout.id,
    state: updated?.state ?? cashout.state,
    status: result.status,
    journalEntryId: result.journalEntryId ?? null,
  });
});

router.get("/merchant/payments/:attemptId", async (request, response) => {
  const merchantId = resolveMerchantId(request);
  const attempt = await client.paymentAttempt.findFirst({
    where: { id: String(request.params.attemptId), merchantId },
    include: {
      link: { select: { id: true, key: true, title: true, applicationId: true, walletId: true, wallet: { select: { id: true, name: true, currency: true, status: true } }, application: { select: { id: true, name: true, status: true } } } },
      application: { select: { id: true, name: true, status: true } },
      rail: { select: { code: true, nameEn: true, nameAr: true } },
      gatewayVersion: { select: { gateway: { select: { code: true, name: true } }, versionNumber: true } },
      ledgerEntry: { include: { journalLines: true } },
      stepLogs: { orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 200 },
      disputes: { orderBy: { openedAt: "desc" } },
      adjustments: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!attempt) throw new ApiError(404, "PAYMENT_ATTEMPT_NOT_FOUND", "The sandbox payment does not exist");
  const refunds = attempt.adjustments
    .filter((adjustment) => adjustment.type === "REFUND" && ["EXECUTED", "EXECUTING"].includes(adjustment.state))
    .reduce((sum, adjustment) => sum + Number(adjustment.amount), 0);
  const refundable = Math.max(0, Number(attempt.settledAmount ?? attempt.totalChargedAmount ?? 0) - refunds);
  let inspector: unknown = null;
  try {
    inspector = await fakeRails.checkoutHelper(attempt.providerReference ?? attempt.reference);
  } catch {
    inspector = null;
  }
  response.json({
    attempt: {
      ...attempt,
      requestedAmount: attempt.requestedAmount.toString(),
      surchargeAmount: attempt.surchargeAmount.toString(),
      totalChargedAmount: attempt.totalChargedAmount.toString(),
      settledAmount: attempt.settledAmount?.toString() ?? null,
      gatewayFeeAmount: attempt.gatewayFeeAmount?.toString() ?? null,
      platformCommissionAmount: attempt.platformCommissionAmount.toString(),
      netMerchantAmount: attempt.netMerchantAmount.toString(),
    },
    link: attempt.link,
    application: attempt.application,
    rail: attempt.rail,
    gateway: attempt.gatewayVersion.gateway,
    stepLogs: attempt.stepLogs,
    adjustments: attempt.adjustments,
    ledgerLines: (attempt.ledgerEntry?.journalLines ?? []).map((line) => ({
      lineId: line.id,
      entryId: line.entryId,
      direction: line.direction,
      amount: line.amount.toFixed(4),
      createdAt: line.createdAt,
      refType: attempt.ledgerEntry?.refType ?? "PAYMENT_ATTEMPT",
      refId: attempt.ledgerEntry?.refId ?? attempt.id,
      description: attempt.ledgerEntry?.description ?? "Sandbox payment ledger line",
    })),
    refunds: attempt.adjustments.filter((adjustment) => adjustment.type === "REFUND").map((adjustment) => ({ ...adjustment, amount: adjustment.amount.toFixed(4) })),
    disputes: attempt.disputes,
    refundableAmount: refundable.toFixed(4),
    inspector,
  });
});

router.post("/merchant/payments/:attemptId/refund", async (request, response) => {
  const merchantId = resolveMerchantId(request);
  const body = parseOrThrow(
    z
      .object({
        amountLyd: z.string().regex(/^\d{1,14}(\.\d{1,4})?$/).optional(),
        reason: z.string().min(2).max(1000).optional(),
      })
      .strict(),
    request.body ?? {},
  );
  const attempt = await client.paymentAttempt.findFirst({
    where: { id: String(request.params.attemptId), merchantId },
    include: {
      link: { select: { wallet: { select: { glAccountId: true } } } },
      adjustments: { select: { amount: true, state: true, type: true } },
    },
  });
  if (!attempt) throw new ApiError(404, "PAYMENT_ATTEMPT_NOT_FOUND", "The sandbox payment does not exist");
  if (!["SUCCEEDED", "PARTIALLY_REFUNDED"].includes(attempt.status)) {
    throw new ApiError(409, "REFUND_NOT_ALLOWED", "Only a successful sandbox payment can be refunded");
  }
  const alreadyRefunded = attempt.adjustments
    .filter((adjustment) => adjustment.type === "REFUND" && ["EXECUTED", "EXECUTING"].includes(adjustment.state))
    .reduce((sum, adjustment) => sum + Number(adjustment.amount), 0);
  const refundable = Math.max(0, Number(attempt.settledAmount ?? attempt.totalChargedAmount ?? 0) - alreadyRefunded);
  if (refundable <= 0) throw new ApiError(409, "REFUND_ALREADY_COMPLETED", "The sandbox payment is fully refunded");
  const amount = body.amountLyd ?? refundable.toFixed(4);
  if (Number(amount) <= 0 || Number(amount) > refundable) {
    throw new ApiError(
      409,
      "REFUND_EXCEEDS_SETTLED_AMOUNT",
      `The refund must be between 0.0001 and the remaining ${refundable.toFixed(4)} LYD`,
    );
  }
  const principal = principalOf(request);
  const adjustment = await client.adjustment.create({
    data: {
      type: "REFUND",
      targetGlAccountId: attempt.link.wallet.glAccountId,
      sourceAttemptId: attempt.id,
      amount: new Prisma.Decimal(amount),
      reverseCommission: true,
      reason: body.reason ?? "Sandbox refund",
      state: "APPROVED",
    },
  });
  const platform = getPlatformRuntime(client as never);
  const result = await client.$transaction(async (tx) =>
    executeAdjustment(governanceContext(platform), tx as never, {
      adjustmentId: adjustment.id,
      checkerUserId: principal.userId ?? merchantId,
      checkerRole: principal.role ?? "MERCHANT_ADMIN",
    }),
  );
  const updated = await client.adjustment.findUnique({ where: { id: adjustment.id } });
  response.status(201).json({
    ok: true,
    adjustmentId: adjustment.id,
    state: updated?.state ?? adjustment.state,
    status: result.status,
    journalEntryId: result.journalEntryId ?? null,
    amount,
  });
});

router.post("/merchant/payments/:attemptId/simulate-dispute", async (request, response) => {
  const merchantId = resolveMerchantId(request);
  const body = parseOrThrow(
    z.object({ reasonCode: z.string().max(80).optional() }).strict(),
    request.body ?? {},
  );
  const attempt = await client.paymentAttempt.findFirst({
    where: { id: String(request.params.attemptId), merchantId },
    include: { route: { select: { gatewayId: true } } },
  });
  if (!attempt) throw new ApiError(404, "PAYMENT_ATTEMPT_NOT_FOUND", "The sandbox payment does not exist");
  if (!["SUCCEEDED", "PARTIALLY_REFUNDED", "DISPUTED"].includes(attempt.status)) {
    throw new ApiError(409, "DISPUTE_NOT_ALLOWED", "Only a successful sandbox payment can be disputed");
  }
  const existing = await client.dispute.findFirst({
    where: { attemptId: attempt.id, status: { in: ["OPENED", "EVIDENCE_REQUESTED", "EVIDENCE_SUBMITTED"] } },
  });
  if (existing) {
    throw new ApiError(409, "DISPUTE_ALREADY_OPEN", "An open dispute already exists for this payment");
  }
  const now = new Date();
  const dispute = await client.dispute.create({
    data: {
      attemptId: attempt.id,
      gatewayId: attempt.route.gatewayId,
      railId: attempt.railId,
      externalDisputeRef: `SBX-DSP-${randomUUID()}`,
      source: "MANUAL",
      reasonCode: body.reasonCode ?? "SANDBOX_SIMULATED",
      amount: attempt.totalChargedAmount,
      currency: attempt.currency,
      status: "OPENED",
      openedAt: now,
      evidenceDueAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
      evidenceJson: { sandbox: true, note: "Created from the Sandbox Studio dispute simulator" },
    },
  });
  await client.paymentAttempt.update({ where: { id: attempt.id }, data: { status: "DISPUTED" } });
  await client.outboxEvent.create({
    data: {
      topic: "dispute.opened",
      aggregateType: "DISPUTE",
      aggregateId: dispute.id,
      merchantId,
      payloadJson: {
        disputeId: dispute.id,
        attemptId: attempt.id,
        reference: attempt.reference,
        amount: attempt.totalChargedAmount.toString(),
        currency: attempt.currency,
        occurredAt: now.toISOString(),
      },
    },
  });
  response.status(201).json({ ok: true, disputeId: dispute.id, attemptId: attempt.id });
});

router.post("/merchant/disputes/:disputeId/resolve", async (request, response) => {
  const merchantId = resolveMerchantId(request);
  const body = parseOrThrow(
    z
      .object({
        outcome: z.enum(["WON", "LOST"]),
        notes: z.string().max(1000).optional(),
      })
      .strict(),
    request.body ?? {},
  );
  const dispute = await client.dispute.findFirst({
    where: { id: String(request.params.disputeId), attempt: { merchantId } },
    include: { attempt: { include: { link: { select: { wallet: { select: { glAccountId: true } } } } } } },
  });
  if (!dispute) throw new ApiError(404, "DISPUTE_NOT_FOUND", "The sandbox dispute does not exist");
  if (["WON", "LOST", "WITHDRAWN"].includes(dispute.status)) {
    throw new ApiError(409, "DISPUTE_ALREADY_RESOLVED", "The sandbox dispute is already resolved");
  }
  const principal = principalOf(request);
  await client.dispute.update({
    where: { id: dispute.id },
    data: {
      status: body.outcome,
      closedAt: new Date(),
      evidenceJson: {
        ...((dispute.evidenceJson as Record<string, unknown> | null) ?? {}),
        sandboxOutcome: body.outcome,
        sandboxNotes: body.notes ?? null,
      } as never,
    },
  });
  if (body.outcome === "WON") {
    await client.paymentAttempt.update({ where: { id: dispute.attemptId }, data: { status: "SUCCEEDED" } });
    response.json({ ok: true, disputeId: dispute.id, outcome: "WON", ledgerPosted: false });
    return;
  }
  const checker = await client.user.findFirst({
    where: { role: "FINANCE", status: "ACTIVE", merchantId: null },
    orderBy: { createdAt: "asc" },
    select: { id: true, role: true },
  });
  if (!checker) throw new ApiError(503, "SANDBOX_FINANCE_CHECKER_MISSING", "The sandbox finance checker user is missing");
  const adjustment = await client.adjustment.create({
    data: {
      type: "CHARGEBACK",
      targetGlAccountId: dispute.attempt.link.wallet.glAccountId,
      sourceAttemptId: dispute.attemptId,
      disputeId: dispute.id,
      amount: dispute.amount,
      reason: body.notes ?? "Sandbox chargeback (lost dispute)",
      state: "APPROVED",
    },
  });
  const platform = getPlatformRuntime(client as never);
  const result = await client.$transaction(async (tx) =>
    executeAdjustment(governanceContext(platform), tx as never, {
      adjustmentId: adjustment.id,
      checkerUserId: checker.id,
      checkerRole: "FINANCE",
      outcome: "LOST",
    }),
  );
  await client.paymentAttempt.update({ where: { id: dispute.attemptId }, data: { status: "SUCCEEDED" } });
  response.json({
    ok: true,
    disputeId: dispute.id,
    outcome: "LOST",
    adjustmentId: adjustment.id,
    journalEntryId: result.journalEntryId ?? null,
    status: result.status,
    requestedBy: principal.userId ?? merchantId,
  });
});

const adjustmentBody = z
  .object({
    merchantId: z.string().uuid().optional(),
    railCode: z.string().optional(),
    gatewayCode: z.string().optional(),
    instrumentType: z.enum(["MOBILE_WALLET", "BANK_ACCOUNT", "CARD", "VOUCHER"]).optional(),
    identifier: z.string().min(3).max(64).optional(),
    holderName: z.string().min(2).max(120).optional(),
    secretPin: z.string().min(3).max(16).optional(),
    expiry: z.string().max(16).nullable().optional(),
    availableBalanceLyd: z.string().regex(/^\d{1,14}(\.\d{1,4})?$/).optional(),
    deltaLyd: z.string().regex(/^-?\d{1,14}(\.\d{1,4})?$/).optional(),
    dailyLimitLyd: z.string().regex(/^\d{1,14}(\.\d{1,4})?$/).optional(),
    dailySpentLyd: z.string().regex(/^\d{1,14}(\.\d{1,4})?$/).optional(),
    status: z.enum(["ACTIVE", "FROZEN", "EXPIRED", "BLOCKED"]).optional(),
    staticOtp: z.string().regex(/^\d{4,8}$/).nullable().optional(),
    presetFault: z.string().max(64).nullable().optional(),
    quickPreset: z.enum(["SET_ZERO", "SET_LINK_AMOUNT", "TOP_UP_5000", "RESET_DAILY_SPENT"]).optional(),
    linkAmountLyd: z.string().optional(),
    notes: z.string().max(255).nullable().optional(),
    reason: z.string().max(255).optional(),
  })
  .strict();

router.get("/fake-rails/accounts", async (request, response) => {
  const principal = principalOf(request);
  const staff = isStaffPrincipal(principal);
  const merchantId = principal.merchantId
    ?? (typeof request.query.merchantId === "string" ? request.query.merchantId : undefined);
  if (!merchantId && !staff) {
    throw new ApiError(403, "MERCHANT_CONTEXT_REQUIRED", "A merchant principal is required");
  }
  const payload = await fakeRails.listAccountsPage({
    merchantId: merchantId || undefined,
    railCode: typeof request.query.railCode === "string" ? request.query.railCode : undefined,
    gatewayCode: typeof request.query.gatewayCode === "string" ? request.query.gatewayCode : undefined,
    status: typeof request.query.status === "string" ? request.query.status : undefined,
    instrumentType: typeof request.query.instrumentType === "string" ? request.query.instrumentType : undefined,
    scope: typeof request.query.scope === "string" ? request.query.scope : undefined,
    createdFrom: typeof request.query.from === "string" ? request.query.from : undefined,
    createdTo: typeof request.query.to === "string" ? request.query.to : undefined,
    search: typeof request.query.search === "string" ? request.query.search : undefined,
    includeGlobal: staff && String(request.query.includeGlobal ?? "") === "true",
    page: request.query.page !== undefined ? Number(request.query.page) : 1,
    pageSize: request.query.pageSize !== undefined ? Number(request.query.pageSize) : 50,
  });
  response.json(payload);
});

const merchantScopeForAccounts = (request: Request, required = false): string | null => {
  const principal = principalOf(request);
  if (principal.merchantId) return principal.merchantId;
  const candidate = String(
    request.header("x-sandbox-merchant-id") ?? request.body?.merchantId ?? request.query.merchantId ?? "",
  ).trim();
  if (candidate) return candidate;
  if (required) {
    throw new ApiError(400, "SANDBOX_MERCHANT_REQUIRED", "A merchant id is required for this account operation");
  }
  if (!isStaffPrincipal(principal)) {
    throw new ApiError(403, "MERCHANT_CONTEXT_REQUIRED", "A merchant principal is required");
  }
  return null;
};

const requireMerchantForAccounts = (request: Request): string => {
  const merchantId = merchantScopeForAccounts(request, true);
  if (!merchantId) throw new ApiError(400, "SANDBOX_MERCHANT_REQUIRED", "A merchant id is required");
  return merchantId;
};

router.get("/admin/fake-rails/accounts/summary", async (request, response) => {
  requireStaff(request);
  const page = await fakeRails.listAccountsPage({ includeGlobal: true, page: 1, pageSize: 200 });
  const accounts = page.accounts;
  const status = accounts.reduce<Record<string, number>>((acc, account) => { acc[account.status] = (acc[account.status] ?? 0) + 1; return acc; }, {});
  const sum = (key: "available_balance_lyd" | "reserved_balance_lyd") => accounts.reduce((total, account) => total.plus(account[key]), new Prisma.Decimal(0)).toFixed(4);
  response.json({ summary: { total: page.total, global: accounts.filter((account) => !account.merchant_id).length, merchant: accounts.filter((account) => account.merchant_id).length, status, available: sum("available_balance_lyd"), held: sum("reserved_balance_lyd") } });
});

router.get("/fake-rails/accounts/:accountId", async (request, response) => {
  const principal = principalOf(request);
  const account = await fakeRails.getAccount(String(request.params.accountId));
  if (!account) throw new ApiError(404, "FAKE_ACCOUNT_NOT_FOUND", "The test account does not exist");
  if (!isStaffPrincipal(principal) && account.merchant_id && account.merchant_id !== principal.merchantId) {
    throw new ApiError(403, "FAKE_ACCOUNT_FORBIDDEN", "The test account belongs to another merchant");
  }
  response.json({ account });
});

router.get("/fake-rails/accounts/:accountId/movements", async (request, response) => {
  const account = await fakeRails.getAccount(String(request.params.accountId));
  if (!account) throw new ApiError(404, "FAKE_ACCOUNT_NOT_FOUND", "The test account does not exist");
  const principal = principalOf(request);
  if (!isStaffPrincipal(principal) && account.merchant_id && account.merchant_id !== principal.merchantId) {
    throw new ApiError(403, "FAKE_ACCOUNT_FORBIDDEN", "The test account belongs to another merchant");
  }
  const limit = request.query.limit ? Number(request.query.limit) : 100;
  response.json({ movements: await fakeRails.accountMovements(account.id, limit) });
});

router.get("/fake-rails/accounts/:accountId/holds", async (request, response) => {
  const account = await fakeRails.getAccount(String(request.params.accountId));
  if (!account) throw new ApiError(404, "FAKE_ACCOUNT_NOT_FOUND", "The test account does not exist");
  const principal = principalOf(request);
  if (!isStaffPrincipal(principal) && account.merchant_id && account.merchant_id !== principal.merchantId) {
    throw new ApiError(403, "FAKE_ACCOUNT_FORBIDDEN", "The test account belongs to another merchant");
  }
  const limit = request.query.limit ? Number(request.query.limit) : 100;
  response.json({ holds: await fakeRails.accountHolds(account.id, limit) });
});

router.post("/fake-rails/accounts/:accountId/restore", async (request, response) => {
  const principal = principalOf(request);
  const account = await fakeRails.getAccount(String(request.params.accountId));
  if (!account) throw new ApiError(404, "FAKE_ACCOUNT_NOT_FOUND", "The test account does not exist");
  if (!isStaffPrincipal(principal) && account.merchant_id !== principal.merchantId) {
    throw new ApiError(403, "FAKE_ACCOUNT_FORBIDDEN", "Only a merchant-owned test account can be restored");
  }
  response.json({ account: await fakeRails.restorePreset(account.id) });
});

router.post("/fake-rails/accounts", async (request, response) => {
  const merchantId = merchantScopeForAccounts(request, false);
  const body = parseOrThrow(
    adjustmentBody
      .extend({
        railCode: z.string().min(1),
        gatewayCode: z.string().min(1),
        identifier: z.string().min(3).max(64),
        holderName: z.string().min(2).max(120),
      })
      .strict(),
    request.body,
  );
  const account = await fakeRails.createAccount({
    ...body,
    merchantId,
  });
  response.status(201).json({ account });
});

router.patch("/fake-rails/accounts/:accountId", async (request, response) => {
  const merchantId = merchantScopeForAccounts(request, false);
  const body = parseOrThrow(adjustmentBody, request.body);
  const account = await fakeRails.adjustAccount(
    String(request.params.accountId),
    body,
    merchantId ?? undefined,
  );
  response.json({ account });
});

router.patch("/fake-rails/accounts/:accountId/balance", async (request, response) => {
  const merchantId = merchantScopeForAccounts(request, false);
  const body = parseOrThrow(
    z
      .object({
        mode: z.enum(["CREDIT", "DEBIT", "SET_EXACT"]).default("SET_EXACT"),
        amountLyd: z.string().regex(/^\d{1,14}(\.\d{1,4})?$/).optional(),
        amount_minor: z.coerce.number().int().optional(),
        reason: z.string().max(255).optional(),
      })
      .strict(),
    request.body,
  );
  const amountLyd = body.amountLyd
    ?? (body.amount_minor !== undefined ? (body.amount_minor / 1000).toFixed(4) : undefined);
  const account = await fakeRails.adjustAccount(
    String(request.params.accountId),
    {
      ...(amountLyd !== undefined
        ? body.mode === "SET_EXACT"
          ? { availableBalanceLyd: amountLyd }
          : { deltaLyd: body.mode === "DEBIT" ? `-${amountLyd}` : amountLyd }
        : {}),
      reason: body.reason,
    },
    merchantId ?? undefined,
  );
  response.json({ account });
});

router.patch("/fake-rails/accounts/:accountId/state", async (request, response) => {
  const merchantId = merchantScopeForAccounts(request, false);
  const body = parseOrThrow(
    z
      .object({
        status: z.enum(["ACTIVE", "FROZEN", "EXPIRED", "BLOCKED"]).optional(),
        staticOtp: z.string().regex(/^\d{4,8}$/).nullable().optional(),
        static_otp: z.string().regex(/^\d{4,8}$/).nullable().optional(),
        dailyLimitLyd: z.string().regex(/^\d{1,14}(\.\d{1,4})?$/).optional(),
        daily_limit_minor: z.coerce.number().int().optional(),
      })
      .strict(),
    request.body,
  );
  const account = await fakeRails.adjustAccount(
    String(request.params.accountId),
    {
      status: body.status,
      staticOtp: body.staticOtp ?? body.static_otp,
      dailyLimitLyd: body.dailyLimitLyd
        ?? (body.daily_limit_minor !== undefined ? (body.daily_limit_minor / 1000).toFixed(4) : undefined),
    },
    merchantId ?? undefined,
  );
  response.json({ account });
});

router.post("/fake-rails/accounts/reset", async (request, response) => {
  const merchantId = merchantScopeForAccounts(request, false);
  if (!merchantId) requireStaff(request);
  response.json(await fakeRails.resetAccounts({ merchantId: merchantId ?? undefined }));
});

router.post("/merchant/webhooks/test-ping", async (request, response) => {
  const merchantId = resolveMerchantId(request);
  const body = parseOrThrow(
    z.object({ event: z.string().max(64).default("payment.succeeded") }).strict(),
    request.body ?? {},
  );
  const endpoints = await client.merchantWebhookEndpoint.findMany({
    where: { merchantId, status: "ACTIVE" },
  });
  if (endpoints.length === 0) {
    throw new ApiError(409, "NO_WEBHOOK_ENDPOINT", "The merchant has no active webhook endpoint");
  }
  const now = new Date();
  for (const endpoint of endpoints) {
    const eventId = `evt_test_${randomUUID()}`;
    await client.merchantWebhookDelivery.create({
      data: {
        endpointId: endpoint.id,
        merchantId,
        eventId,
        eventType: body.event,
        body: JSON.stringify({
          id: eventId,
          type: body.event,
          created: now.toISOString(),
          data: { sandbox: true, message: "Sandbox Studio test event" },
        }),
        status: "PENDING",
        nextAttemptAt: now,
      },
    });
  }
  response.status(202).json({ ok: true, endpoints: endpoints.length, event: body.event });
});

router.get("/fake-rails/clearing/pools", async (_request, response) => {
  response.json(await fakeRails.clearingPools());
});

router.post("/fake-rails/clearing/generate-statement", async (request, response) => {
  const body = parseOrThrow(
    z
      .object({
        from: z.string().optional(),
        to: z.string().optional(),
        gatewayCode: z.string().optional(),
        merchantId: z.string().uuid().optional(),
        includeSettled: z.boolean().optional(),
        includeIncluded: z.boolean().optional(),
      })
      .strict(),
    request.body ?? {},
  );
  const principal = principalOf(request);
  const merchantId = principal.merchantId ?? body.merchantId;
  response.json(await fakeRails.generateStatement({ ...body, merchantId }));
});

router.post("/fake-rails/clearing/settle", async (request, response) => {
  requireStaff(request);
  const body = parseOrThrow(
    z.object({ gatewayCode: z.string().max(64).optional() }).strict(),
    request.body ?? {},
  );
  response.json(await fakeRails.settleClearing(body));
});

// --- Staff (admin) views -------------------------------------------------

router.post("/merchant/reconciliation/import-fake-rails", async (request, response) => {
  const merchantId = resolveMerchantId(request);
  const body = parseOrThrow(
    z
      .object({
        gatewayCode: z.string().trim().min(1).max(80).optional(),
        includeSettled: z.boolean().optional().default(true),
        includeIncluded: z.boolean().optional().default(false),
      })
      .strict(),
    request.body ?? {},
  );
  const statement = await fakeRails.generateStatement({
    ...(body.gatewayCode ? { gatewayCode: body.gatewayCode } : {}),
    merchantId,
    includeSettled: body.includeSettled,
    includeIncluded: body.includeIncluded,
  }) as {
    rows?: Array<{ id: string; createdAt?: string; gatewayCode?: string }>;
    csv?: string;
  };
  const rows = statement.rows ?? [];
  if (rows.length === 0 || !statement.csv) {
    throw new ApiError(409, "FAKE_RAILS_STATEMENT_EMPTY", "Fake Rails has no clearing entries for this merchant yet");
  }
  const gatewayCode = body.gatewayCode ?? rows.find((row) => row.gatewayCode)?.gatewayCode;
  const gateway = gatewayCode
    ? await client.gateway.findUnique({ where: { code: gatewayCode } })
    : await client.gateway.findFirst({ where: { status: "LIVE" }, orderBy: { code: "asc" } });
  if (!gateway) throw new ApiError(404, "GATEWAY_NOT_FOUND", "No sandbox gateway is available for reconciliation");
  const parserConfig = {
    format: "CSV" as const,
    headerRow: true,
    delimiter: ",",
    columnsMap: {
      ourReference: "our_reference",
      providerReference: "provider_reference",
      amount: "amount_lyd",
      fee: "fee_lyd",
      currency: "currency",
      occurredAt: "occurred_at",
      type: "entry_type",
    },
  };
  const source = await client.statementSource.findFirst({
    where: { gatewayId: gateway.id, type: "UPLOAD" },
    orderBy: { createdAt: "asc" },
  }) ?? await client.statementSource.create({
    data: {
      gatewayId: gateway.id,
      type: "UPLOAD",
      parserConfig: parserConfig as never,
      settlementLagDays: 0,
    },
  });
  const platform = getPlatformRuntime(client as never);
  const ingestor = new StatementIngestor({
    db: client as never,
    repositories: platform.repositories,
  });
  const windowStart = rows[0]?.createdAt ? new Date(rows[0].createdAt) : undefined;
  const windowEnd = rows[rows.length - 1]?.createdAt ? new Date(rows[rows.length - 1]!.createdAt!) : undefined;
  const result = await ingestor.ingest({
    statementSourceId: source.id,
    content: statement.csv,
    fileName: `fake-rails-${gateway.code}-${new Date().toISOString().slice(0, 10)}.csv`,
    windowStart,
    windowEnd,
  });
  const marked = await fakeRails.markClearingIncluded({ entryIds: rows.map((row) => row.id), runId: result.runId });
  response.status(201).json({ ok: true, gatewayCode: gateway.code, statementSourceId: source.id, marked, ...result });
});


const sandboxMoney = (value: unknown): string =>
  value === null || value === undefined ? "0.0000" : new Prisma.Decimal(value as never).toFixed(4);

const sandboxNatural = (accountType: string, value: unknown): string =>
  value === null || value === undefined ? "0.0000" : naturalShardBalance(accountType, sandboxMoney(value));

const groupCount = (rows: Array<{ _count?: { _all?: number } }>): number =>
  rows.reduce((sum, row) => sum + Number(row._count?._all ?? 0), 0);

const walletAmounts = async (wallets: Array<{ id: string; glAccountId: string; currency: string }>) => {
  const accountIds = wallets.map((wallet) => wallet.glAccountId);
  const [live, checkpoints] = await Promise.all([
    loadLiveAccountBalances(client as never, accountIds),
    loadAccountCheckpointSummary(client as never, accountIds),
  ]);
  const liveByAccount = new Map(live.map((row) => [row.id, row]));
  const checkpointByAccount = new Map(checkpoints.map((row) => [row.id, row]));
  return wallets.map((wallet) => {
    const balance = liveByAccount.get(wallet.glAccountId);
    const checkpoint = checkpointByAccount.get(wallet.glAccountId);
    return {
      walletId: wallet.id,
      availableBalance: balance?.balance ?? "0.0000",
      checkpointBalance: sandboxNatural("MERCHANT_WALLET", checkpoint?.checkpointBalance),
      checkpointAt: checkpoint?.checkpointAt ?? null,
      pendingLines: Number(checkpoint?.pendingLines ?? 0),
      shardCount: Number(checkpoint?.shardCount ?? 0),
      checkpointStatus: checkpoint?.status ?? "OK",
    };
  });
};

const studioWalletRows = async (
  merchantId: string,
  rows: Array<{
    id: string;
    name: string | null;
    createdAt: Date;
    updatedAt: Date;
    currency: string;
    status: string;
    glAccountId: string;
  }>,
) => {
  const ids = rows.map((row) => row.id);
  const [amounts, applicationCounts, linkCounts, cashoutCounts, links] = await Promise.all([
    walletAmounts(rows),
    client.application.groupBy({
      by: ["assignedWalletId"],
      where: { assignedWalletId: { in: ids } },
      _count: { _all: true },
    }),
    client.paymentLink.groupBy({
      by: ["walletId"],
      where: { walletId: { in: ids } },
      _count: { _all: true },
    }),
    client.cashoutRequest.groupBy({
      by: ["walletId"],
      where: { walletId: { in: ids }, state: { in: ["PENDING", "PROCESSING"] } },
      _count: { _all: true },
    }),
    client.paymentLink.findMany({ where: { walletId: { in: ids } }, select: { id: true, walletId: true } }),
  ]);
  const attempts = links.length > 0
    ? await client.paymentAttempt.groupBy({
        by: ["linkId"],
        where: { linkId: { in: links.map((link) => link.id) } },
        _count: { _all: true },
      })
    : [];
  const applications = new Map(applicationCounts.map((row) => [row.assignedWalletId, Number(row._count._all)]));
  const linkCount = new Map(linkCounts.map((row) => [row.walletId, Number(row._count._all)]));
  const cashouts = new Map(cashoutCounts.map((row) => [row.walletId, Number(row._count._all)]));
  const linkWallet = new Map(links.map((link) => [link.id, link.walletId]));
  const paymentCounts = new Map<string, number>();
  for (const row of attempts) {
    const walletId = linkWallet.get(row.linkId);
    if (walletId) paymentCounts.set(walletId, (paymentCounts.get(walletId) ?? 0) + Number(row._count._all));
  }
  const amountByWallet = new Map(amounts.map((row) => [row.walletId, row]));
  return rows.map((row) => {
    const amount = amountByWallet.get(row.id);
    return {
      id: row.id,
      name: row.name,
      merchantId,
      currency: row.currency,
      status: row.status,
      glAccountId: row.glAccountId,
      availableBalance: amount?.availableBalance ?? "0.0000",
      checkpointBalance: amount?.checkpointBalance ?? "0.0000",
      checkpointAt: amount?.checkpointAt ?? null,
      checkpointStatus: amount?.checkpointStatus ?? "OK",
      pendingLines: amount?.pendingLines ?? 0,
      shardCount: amount?.shardCount ?? 0,
      applications: applications.get(row.id) ?? 0,
      links: linkCount.get(row.id) ?? 0,
      payments: paymentCounts.get(row.id) ?? 0,
      pendingCashouts: cashouts.get(row.id) ?? 0,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  });
};

router.get("/merchant/studio/overview", async (request, response) => {
  const merchantId = resolveMerchantId(request);
  const merchant = await ensureSandboxMerchantEnvelope({
    merchantId,
    businessName: request.header("x-merchant-name"),
    email: request.header("x-merchant-email"),
  });
  const now = new Date();
  const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const [wallets, applications, links, attempts, tokens, pendingCashouts, disputes, accounts, refs, recentPayments, syncAudits] = await Promise.all([
    client.wallet.findMany({ where: { merchantId }, orderBy: { createdAt: "desc" } }),
    client.application.findMany({ where: { merchantId }, select: { id: true } }),
    client.paymentLink.findMany({ where: { application: { merchantId } }, select: { id: true } }),
    client.paymentAttempt.findMany({
      where: { merchantId },
      select: { id: true, status: true, createdAt: true, totalChargedAmount: true, settledAmount: true, gatewayFeeAmount: true, platformCommissionAmount: true, netMerchantAmount: true },
    }),
    client.accessToken.count({ where: { merchantId, env: "SANDBOX", revokedAt: null } }),
    client.cashoutRequest.count({ where: { merchantId, state: { in: ["PENDING", "PROCESSING"] } } }),
    client.dispute.count({ where: { attempt: { merchantId }, status: { in: ["OPENED", "EVIDENCE_REQUESTED", "EVIDENCE_SUBMITTED"] } } }),
    fakeRails.listAccounts({ merchantId }).catch(() => []),
    Promise.all([
      client.rail.count(),
      client.gateway.count(),
      client.railRoute.count(),
      client.commissionProfile.count({ where: { merchantId: null, applicationId: null } }),
    ]),
    client.paymentAttempt.findMany({
      where: { merchantId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 8,
      include: { rail: { select: { code: true } }, link: { select: { key: true } } },
    }),
    client.sandboxSyncAudit.findMany({ where: { merchantId }, orderBy: { createdAt: "desc" }, take: 10 }),
  ]);
  const amounts = await walletAmounts(wallets);
  const balanceByWallet = new Map(amounts.map((row) => [row.walletId, row]));
  const sum = (values: unknown[]): Prisma.Decimal =>
    values.reduce<Prisma.Decimal>((total, value) => total.plus(new Prisma.Decimal(value as never)), new Prisma.Decimal(0));
  const statusCounts = attempts.reduce<Record<string, number>>((acc, attempt) => {
    acc[attempt.status] = (acc[attempt.status] ?? 0) + 1;
    return acc;
  }, {});
  const recent24h = attempts.filter((attempt) => attempt.createdAt >= since24h);
  const [rails, gateways, routes, commissionProfiles] = refs;
  response.json({
    plane: "SANDBOX",
    merchantId,
    merchantName: merchant.tradeName,
    payoutBankDetails: merchant.payoutBankDetailsJson,
    fakeRails: { ok: Array.isArray(accounts), accounts: Array.isArray(accounts) ? accounts.length : 0 },
    reference: { rails, gateways, routes, commissionProfiles, ready: rails > 0 && gateways > 0 && routes > 0 },
    counts: {
      wallets: wallets.length,
      applications: applications.length,
      links: links.length,
      payments: attempts.length,
      pendingCashouts,
      disputes,
      activeTestTokens: tokens,
      fakeCustomerAccounts: Array.isArray(accounts) ? accounts.length : 0,
    },
    money: {
      available: sum(amounts.map((row) => row.availableBalance)).toFixed(4),
      checkpoint: sum(amounts.map((row) => row.checkpointBalance)).toFixed(4),
      charged: sum(attempts.map((row) => row.totalChargedAmount)).toFixed(4),
      settled: sum(attempts.map((row) => row.settledAmount ?? 0)).toFixed(4),
      fees: sum(attempts.map((row) => row.gatewayFeeAmount ?? 0)).toFixed(4),
      commission: sum(attempts.map((row) => row.platformCommissionAmount)).toFixed(4),
      net: sum(attempts.map((row) => row.netMerchantAmount)).toFixed(4),
      charged24h: sum(recent24h.map((row) => row.totalChargedAmount)).toFixed(4),
      settled24h: sum(recent24h.map((row) => row.settledAmount ?? 0)).toFixed(4),
    },
    statusCounts,
    wallets: wallets.map((wallet) => {
      const amount = balanceByWallet.get(wallet.id);
      return { id: wallet.id, name: wallet.name, currency: wallet.currency, status: wallet.status, availableBalance: amount?.availableBalance ?? "0.0000", checkpointBalance: amount?.checkpointBalance ?? "0.0000" };
    }),
    recentPayments: recentPayments.map((attempt) => ({
      id: attempt.id,
      reference: attempt.reference,
      status: attempt.status,
      currency: attempt.currency,
      amount: sandboxMoney(attempt.totalChargedAmount),
      net: sandboxMoney(attempt.netMerchantAmount),
      railCode: attempt.rail.code,
      linkKey: attempt.link.key,
      createdAt: attempt.createdAt,
    })),
    syncAudits,
  });
});

router.get("/merchant/studio/wallets/summary", async (request, response) => {
  const merchantId = resolveMerchantId(request);
  const wallets = await client.wallet.findMany({ where: { merchantId }, select: { id: true, status: true, currency: true, glAccountId: true } });
  const amounts = await walletAmounts(wallets);
  const byCurrency: Record<string, string> = {};
  const checkpointByCurrency: Record<string, string> = {};
  for (const amount of amounts) {
    const wallet = wallets.find((row) => row.id === amount.walletId);
    if (!wallet) continue;
    byCurrency[wallet.currency] = new Prisma.Decimal(byCurrency[wallet.currency] ?? 0).plus(amount.availableBalance).toFixed(4);
    checkpointByCurrency[wallet.currency] = new Prisma.Decimal(checkpointByCurrency[wallet.currency] ?? 0).plus(amount.checkpointBalance).toFixed(4);
  }
  const status = wallets.reduce<Record<string, number>>((acc, wallet) => { acc[wallet.status] = (acc[wallet.status] ?? 0) + 1; return acc; }, {});
  const [applications, links, payments, pendingCashouts] = await Promise.all([
    client.application.count({ where: { merchantId } }),
    client.paymentLink.count({ where: { application: { merchantId } } }),
    client.paymentAttempt.count({ where: { merchantId } }),
    client.cashoutRequest.count({ where: { merchantId, state: { in: ["PENDING", "PROCESSING"] } } }),
  ]);
  response.json({ summary: { total: wallets.length, status, byCurrency, checkpointByCurrency, applications, links, payments, pendingCashouts } });
});

router.get("/merchant/studio/wallets", async (request, response) => {
  const merchantId = resolveMerchantId(request);
  const built = buildListQuery(request.query, {
    search: ["name"],
    in: { status: "status" },
    equals: { currency: "currency" },
    dates: { createdAt: { path: "createdAt", fromKey: "from", toKey: "to" } },
    sortable: { name: "name", currency: "currency", status: "status", createdAt: "createdAt", updatedAt: "updatedAt" },
    defaultSort: { createdAt: "desc" },
  });
  const where = { merchantId, ...built.where } as never;
  const [rows, total] = await Promise.all([
    client.wallet.findMany({ where, orderBy: built.orderBy as never, skip: built.skip, take: built.take, select: { id: true, name: true, createdAt: true, updatedAt: true, currency: true, status: true, glAccountId: true } }),
    client.wallet.count({ where }),
  ]);
  response.json(listResponse("wallets", await studioWalletRows(merchantId, rows), total, built));
});

router.get("/merchant/studio/wallets/:walletId", async (request, response) => {
  const merchantId = resolveMerchantId(request);
  const wallet = await client.wallet.findFirst({
    where: { id: String(request.params.walletId), merchantId },
    include: { glAccount: true, applications: { select: { id: true, name: true, status: true, createdAt: true } }, paymentLinks: { select: { id: true, key: true, title: true, amount: true, currency: true, state: true, useCount: true, confirmedCount: true, createdAt: true } }, cashoutRequests: { orderBy: { createdAt: "desc" }, take: 20 } },
  });
  if (!wallet) throw new ApiError(404, "SANDBOX_WALLET_NOT_FOUND", "The sandbox wallet does not exist");
  const [row] = await studioWalletRows(merchantId, [wallet]);
  const [attempts, disputes] = await Promise.all([
    client.paymentAttempt.count({ where: { merchantId, link: { walletId: wallet.id } } }),
    client.dispute.count({ where: { attempt: { link: { walletId: wallet.id } } } }),
  ]);
  response.json({
    wallet: {
      id: wallet.id, name: wallet.name, merchantId: wallet.merchantId, currency: wallet.currency, status: wallet.status,
      glAccountId: wallet.glAccountId, createdAt: wallet.createdAt, updatedAt: wallet.updatedAt,
      glAccount: { id: wallet.glAccount.id, accountType: wallet.glAccount.accountType, currency: wallet.glAccount.currency, shardCount: wallet.glAccount.shardCount },
    },
    ...row,
    applications: wallet.applications,
    links: wallet.paymentLinks,
    cashouts: wallet.cashoutRequests,
    attempts,
    disputes,
    pendingCashouts: wallet.cashoutRequests.filter((entry) => ["PENDING", "PROCESSING"].includes(entry.state)).length,
  });
});

router.patch("/merchant/wallets/:walletId/status", async (request, response) => {
  const merchantId = resolveMerchantId(request);
  const body = parseOrThrow(z.object({ status: z.enum(["ACTIVE", "FROZEN"]), reason: z.string().min(3).max(255) }).strict(), request.body ?? {});
  const wallet = await client.wallet.findFirst({ where: { id: String(request.params.walletId), merchantId } });
  if (!wallet) throw new ApiError(404, "SANDBOX_WALLET_NOT_FOUND", "The sandbox wallet does not exist");
  const updated = await client.wallet.update({ where: { id: wallet.id }, data: { status: body.status } });
  const principal = principalOf(request);
  await client.sandboxSyncAudit.create({
    data: { syncType: body.status === "FROZEN" ? "WALLET_FROZEN" : "WALLET_ACTIVATED", merchantId, actorId: principal.userId ?? merchantId, actorRole: isStaffPrincipal(principal) ? "ADMIN" : "MERCHANT", summaryJson: { walletId: wallet.id, reason: body.reason } },
  });
  response.json({ wallet: { id: updated.id, status: updated.status } });
});

router.get("/merchant/studio/applications/summary", async (request, response) => {
  const merchantId = resolveMerchantId(request);
  const [applications, links, payments] = await Promise.all([
    client.application.groupBy({ by: ["status"], where: { merchantId }, _count: { _all: true } }),
    client.paymentLink.count({ where: { application: { merchantId } } }),
    client.paymentAttempt.count({ where: { merchantId } }),
  ]);
  response.json({ summary: { total: applications.reduce((sum, row) => sum + Number(row._count._all), 0), status: Object.fromEntries(applications.map((row) => [row.status, Number(row._count._all)])), links, payments } });
});

router.get("/merchant/studio/applications", async (request, response) => {
  const merchantId = resolveMerchantId(request);
  const built = buildListQuery(request.query, {
    search: ["name", "businessUseDescription"],
    in: { status: "status" },
    equals: { assignedWalletId: "assignedWalletId" },
    dates: { createdAt: { path: "createdAt", fromKey: "from", toKey: "to" } },
    sortable: { name: "name", status: "status", createdAt: "createdAt" },
    defaultSort: { createdAt: "desc" },
  });
  const where = { merchantId, ...built.where } as never;
  const [rows, total] = await Promise.all([
    client.application.findMany({ where, orderBy: built.orderBy as never, skip: built.skip, take: built.take, include: { assignedWallet: { select: { id: true, name: true, currency: true } } } }),
    client.application.count({ where }),
  ]);
  const ids = rows.map((row) => row.id);
  const [links, payments] = await Promise.all([
    client.paymentLink.groupBy({ by: ["applicationId"], where: { applicationId: { in: ids } }, _count: { _all: true } }),
    client.paymentAttempt.groupBy({ by: ["applicationId"], where: { applicationId: { in: ids } }, _count: { _all: true } }),
  ]);
  const linkMap = new Map(links.map((row) => [row.applicationId, Number(row._count._all)]));
  const paymentMap = new Map(payments.map((row) => [row.applicationId, Number(row._count._all)]));
  response.json(listResponse("applications", rows.map((row) => ({ ...row, expectedMonthlyVolume: sandboxMoney(row.expectedMonthlyVolume), walletName: row.assignedWallet.name, walletCurrency: row.assignedWallet.currency, links: linkMap.get(row.id) ?? 0, payments: paymentMap.get(row.id) ?? 0 })), total, built));
});

router.get("/merchant/studio/applications/:applicationId", async (request, response) => {
  const merchantId = resolveMerchantId(request);
  const application = await client.application.findFirst({ where: { id: String(request.params.applicationId), merchantId }, include: { assignedWallet: true } });
  if (!application) throw new ApiError(404, "SANDBOX_APPLICATION_NOT_FOUND", "The sandbox application does not exist");
  const [links, payments] = await Promise.all([
    client.paymentLink.findMany({ where: { applicationId: application.id }, orderBy: { createdAt: "desc" }, take: 50 }),
    client.paymentAttempt.findMany({ where: { applicationId: application.id }, orderBy: { createdAt: "desc" }, take: 20, select: { id: true, reference: true, status: true, totalChargedAmount: true, currency: true, createdAt: true } }),
  ]);
  response.json({ application: { ...application, expectedMonthlyVolume: sandboxMoney(application.expectedMonthlyVolume) }, wallet: application.assignedWallet, links: links.map((link) => ({ ...link, amount: sandboxMoney(link.amount) })), payments: payments.map((payment) => ({ ...payment, totalChargedAmount: sandboxMoney(payment.totalChargedAmount) })) });
});

router.get("/merchant/studio/links/summary", async (request, response) => {
  const merchantId = resolveMerchantId(request);
  const groups = await client.paymentLink.groupBy({ by: ["state"], where: { application: { merchantId } }, _count: { _all: true } });
  const aggregate = await client.paymentLink.aggregate({ where: { application: { merchantId } }, _sum: { amount: true, useCount: true, confirmedCount: true } });
  response.json({ summary: { total: groups.reduce((sum, row) => sum + Number(row._count._all), 0), states: Object.fromEntries(groups.map((row) => [row.state, Number(row._count._all)])), amount: sandboxMoney(aggregate._sum.amount), uses: Number(aggregate._sum.useCount ?? 0), confirmed: Number(aggregate._sum.confirmedCount ?? 0) } });
});

router.get("/merchant/studio/links", async (request, response) => {
  const merchantId = resolveMerchantId(request);
  const built = buildListQuery(request.query, {
    search: ["key", "title", "description"],
    in: { state: "state" },
    equals: { applicationId: "applicationId", walletId: "walletId" },
    ranges: { amount: { path: "amount", kind: "decimal" } },
    dates: { createdAt: { path: "createdAt", fromKey: "from", toKey: "to" }, expiresAt: { path: "expiresAt", fromKey: "expiryFrom", toKey: "expiryTo" } },
    sortable: { key: "key", title: "title", amount: "amount", state: "state", createdAt: "createdAt", expiresAt: "expiresAt" },
    defaultSort: { createdAt: "desc" },
  });
  const where = { application: { merchantId }, ...built.where } as never;
  const [rows, total] = await Promise.all([
    client.paymentLink.findMany({ where, orderBy: built.orderBy as never, skip: built.skip, take: built.take, include: { application: { select: { name: true } }, wallet: { select: { name: true, currency: true } } } }),
    client.paymentLink.count({ where }),
  ]);
  const linkIds = rows.map((row) => row.id);
  const attempts = await client.paymentAttempt.groupBy({ by: ["linkId"], where: { linkId: { in: linkIds } }, _count: { _all: true } });
  const attemptMap = new Map(attempts.map((row) => [row.linkId, Number(row._count._all)]));
  response.json(listResponse("links", rows.map((row) => ({ id: row.id, key: row.key, linkKey: row.key, title: row.title, description: row.description, amount: sandboxMoney(row.amount), currency: row.currency, state: row.state, feeBearer: row.feeBearer, useCount: row.useCount, confirmedCount: row.confirmedCount, activeLockedCount: row.activeLockedCount, infiniteUse: row.infiniteUse, applicationId: row.applicationId, applicationName: row.application.name, walletId: row.walletId, walletName: row.wallet.name, walletCurrency: row.wallet.currency, expiresAt: row.expiresAt, redirectUrl: row.redirectUrl, railWhitelist: row.railWhitelist, createdAt: row.createdAt, payments: attemptMap.get(row.id) ?? 0 })), total, built));
});

router.get("/merchant/studio/links/:linkId", async (request, response) => {
  const merchantId = resolveMerchantId(request);
  const link = await client.paymentLink.findFirst({ where: { id: String(request.params.linkId), application: { merchantId } }, include: { application: { select: { id: true, name: true, status: true } }, wallet: { select: { id: true, name: true, currency: true, status: true } } } });
  if (!link) throw new ApiError(404, "SANDBOX_LINK_NOT_FOUND", "The sandbox link does not exist");
  const attempts = await client.paymentAttempt.findMany({ where: { linkId: link.id }, orderBy: { createdAt: "desc" }, take: 100, select: { id: true, reference: true, status: true, totalChargedAmount: true, currency: true, createdAt: true, terminalAt: true } });
  response.json({ link: { ...link, amount: sandboxMoney(link.amount) }, application: link.application, wallet: link.wallet, attempts: attempts.map((attempt) => ({ ...attempt, totalChargedAmount: sandboxMoney(attempt.totalChargedAmount) })) });
});

router.get("/merchant/studio/payments/summary", async (request, response) => {
  const merchantId = resolveMerchantId(request);
  const [groups, aggregate] = await Promise.all([
    client.paymentAttempt.groupBy({ by: ["status"], where: { merchantId }, _count: { _all: true } }),
    client.paymentAttempt.aggregate({ where: { merchantId }, _sum: { totalChargedAmount: true, settledAmount: true, gatewayFeeAmount: true, platformCommissionAmount: true, netMerchantAmount: true } }),
  ]);
  response.json({ summary: { total: groups.reduce((sum, row) => sum + Number(row._count._all), 0), status: Object.fromEntries(groups.map((row) => [row.status, Number(row._count._all)])), charged: sandboxMoney(aggregate._sum.totalChargedAmount), settled: sandboxMoney(aggregate._sum.settledAmount), fees: sandboxMoney(aggregate._sum.gatewayFeeAmount), commission: sandboxMoney(aggregate._sum.platformCommissionAmount), net: sandboxMoney(aggregate._sum.netMerchantAmount) } });
});

router.get("/merchant/studio/payments", async (request, response) => {
  const merchantId = resolveMerchantId(request);
  const built = buildListQuery(request.query, {
    search: ["reference"],
    in: { status: "status" },
    equals: { railId: "railId", applicationId: "applicationId", linkId: "linkId" },
    ranges: { amount: { path: "totalChargedAmount", kind: "decimal" }, commission: { path: "platformCommissionAmount", kind: "decimal" }, net: { path: "netMerchantAmount", kind: "decimal" } },
    dates: { createdAt: { path: "createdAt", fromKey: "from", toKey: "to" }, confirmedAt: { path: "terminalAt", fromKey: "dateFrom", toKey: "dateTo" } },
    sortable: { reference: "reference", amount: "totalChargedAmount", status: "status", createdAt: "createdAt", confirmedAt: "terminalAt" },
    defaultSort: { createdAt: "desc" },
  });
  const where = { merchantId, ...built.where } as never;
  const [rows, total] = await Promise.all([
    client.paymentAttempt.findMany({
      where, orderBy: built.orderBy as never, skip: built.skip, take: built.take,
      include: { link: { select: { key: true, title: true, walletId: true } }, application: { select: { name: true } }, rail: { select: { code: true, nameEn: true, nameAr: true } }, gatewayVersion: { select: { gateway: { select: { code: true, name: true } } } } },
    }),
    client.paymentAttempt.count({ where }),
  ]);
  const ids = rows.map((row) => row.id);
  const refunds = ids.length > 0 ? await client.adjustment.groupBy({ by: ["sourceAttemptId"], where: { sourceAttemptId: { in: ids }, type: "REFUND", state: { in: ["EXECUTED", "EXECUTING"] } }, _sum: { amount: true } }) : [];
  const refundMap = new Map(refunds.map((row) => [row.sourceAttemptId, sandboxMoney(row._sum.amount)]));
  response.json(listResponse("payments", rows.map((row) => ({
    id: row.id, reference: row.reference, createdAt: row.createdAt, terminalAt: row.terminalAt, updatedAt: row.updatedAt,
    status: row.status, substatus: row.substatus, mode: row.mode, subMode: row.subMode, env: row.env,
    railId: row.railId, railCode: row.rail.code, railName: row.rail.nameEn || row.rail.nameAr,
    gatewayCode: row.gatewayVersion.gateway.code, gatewayName: row.gatewayVersion.gateway.name,
    applicationId: row.applicationId, applicationName: row.application.name, linkId: row.linkId, linkKey: row.link.key, linkTitle: row.link.title, walletId: row.link.walletId,
    requestedAmount: sandboxMoney(row.requestedAmount), surchargeAmount: sandboxMoney(row.surchargeAmount), totalChargedAmount: sandboxMoney(row.totalChargedAmount),
    settledAmount: row.settledAmount ? sandboxMoney(row.settledAmount) : null, gatewayFeeAmount: row.gatewayFeeAmount ? sandboxMoney(row.gatewayFeeAmount) : null,
    platformCommissionAmount: sandboxMoney(row.platformCommissionAmount), netMerchantAmount: sandboxMoney(row.netMerchantAmount),
    refundedAmount: refundMap.get(row.id) ?? "0.0000", providerReference: row.providerReference, networkReference: row.networkReference,
    feeBearer: row.feeBearer, settlementTarget: row.settlementTarget, currency: row.currency, expiresAt: row.expiresAt,
  })), total, built));
});

router.get("/merchant/studio/tokens/summary", async (request, response) => {
  const merchantId = resolveMerchantId(request);
  const [total, active, revoked, expiring] = await Promise.all([
    client.accessToken.count({ where: { merchantId, env: "SANDBOX" } }),
    client.accessToken.count({ where: { merchantId, env: "SANDBOX", revokedAt: null } }),
    client.accessToken.count({ where: { merchantId, env: "SANDBOX", revokedAt: { not: null } } }),
    client.accessToken.count({ where: { merchantId, env: "SANDBOX", revokedAt: null, expiresAt: { lte: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) } } }),
  ]);
  response.json({ summary: { total, active, revoked, expiring } });
});

router.get("/merchant/studio/tokens", async (request, response) => {
  const merchantId = resolveMerchantId(request);
  const built = buildListQuery(request.query, {
    search: ["name", "lastFour"],
    booleans: { ipWhitelistEnabled: "ipWhitelistEnabled" },
    dates: { createdAt: { path: "createdAt", fromKey: "from", toKey: "to" }, lastUsedAt: { path: "lastUsedAt", fromKey: "lastFrom", toKey: "lastTo" } },
    sortable: { name: "name", lastUsedAt: "lastUsedAt", createdAt: "createdAt" },
    defaultSort: { createdAt: "desc" },
  });
  const tokenStatus = String(request.query.status ?? "").trim().toUpperCase();
  const statusWhere: Record<string, unknown> = tokenStatus === "ACTIVE"
    ? { revokedAt: null }
    : tokenStatus === "REVOKED"
      ? { revokedAt: { not: null } }
      : tokenStatus === "EXPIRING"
        ? { revokedAt: null, expiresAt: { lte: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) } }
        : {};
  const where = { merchantId, env: "SANDBOX", ...statusWhere, ...built.where } as never;
  const [rows, total] = await Promise.all([
    client.accessToken.findMany({ where, orderBy: built.orderBy as never, skip: built.skip, take: built.take, include: { application: { select: { name: true } }, ips: { select: { cidr: true } } } }),
    client.accessToken.count({ where }),
  ]);
  response.json(listResponse("tokens", rows.map((row) => ({ id: row.id, name: row.name, lastFour: row.lastFour, applicationId: row.applicationId, applicationName: row.application.name, scopes: row.scopes, expiresAt: row.expiresAt, revokedAt: row.revokedAt, lastUsedAt: row.lastUsedAt, ipWhitelistEnabled: row.ipWhitelistEnabled, allowedCidrs: row.ips.map((entry) => entry.cidr), createdAt: row.createdAt })), total, built));
});

router.get("/merchant/studio/tokens/:tokenId", async (request, response) => {
  const merchantId = resolveMerchantId(request);
  const token = await client.accessToken.findFirst({ where: { id: String(request.params.tokenId), merchantId, env: "SANDBOX" }, include: { application: { select: { name: true, id: true } }, ips: { select: { cidr: true } } } });
  if (!token) throw new ApiError(404, "SANDBOX_TOKEN_NOT_FOUND", "The sandbox token does not exist");
  response.json({ token: { id: token.id, name: token.name, lastFour: token.lastFour, applicationName: token.application.name, scopes: token.scopes, expiresAt: token.expiresAt, revokedAt: token.revokedAt, lastUsedAt: token.lastUsedAt, ipWhitelistEnabled: token.ipWhitelistEnabled, allowedCidrs: token.ips.map((entry) => entry.cidr), createdAt: token.createdAt } });
});

router.get("/admin/merchants/summary", async (request, response) => {
  requireStaff(request);
  const [total, groups, wallets, attempts, cashouts, disputes, accounts] = await Promise.all([
    client.merchant.count(),
    client.merchant.groupBy({ by: ["status"], _count: { _all: true } }),
    client.wallet.findMany({ select: { id: true, currency: true, glAccountId: true } }),
    client.paymentAttempt.count(),
    client.cashoutRequest.count({ where: { state: { in: ["PENDING", "PROCESSING"] } } }),
    client.dispute.count({ where: { status: { in: ["OPENED", "EVIDENCE_REQUESTED", "EVIDENCE_SUBMITTED"] } } }),
    fakeRails.listAccounts({}).catch(() => []),
  ]);
  const amounts = await walletAmounts(wallets);
  const byCurrency = amounts.reduce<Record<string, string>>((acc, row) => {
    const wallet = wallets.find((entry) => entry.id === row.walletId);
    if (!wallet) return acc;
    acc[wallet.currency] = new Prisma.Decimal(acc[wallet.currency] ?? 0).plus(row.availableBalance).toFixed(4);
    return acc;
  }, {});
  response.json({ summary: { total, status: Object.fromEntries(groups.map((row) => [row.status, Number(row._count._all)])), wallets: wallets.length, attempts, pendingCashouts: cashouts, openDisputes: disputes, fakeAccounts: Array.isArray(accounts) ? accounts.length : 0, byCurrency } });
});

router.get("/admin/merchants", async (request, response) => {
  requireStaff(request);
  const built = buildListQuery(request.query, {
    search: ["tradeName", "legalName", "displayName"],
    in: { status: "status" },
    dates: { createdAt: { path: "createdAt", fromKey: "from", toKey: "to" } },
    sortable: { tradeName: "tradeName", legalName: "legalName", status: "status", createdAt: "createdAt" },
    defaultSort: { createdAt: "desc" },
  });
  const [rows, total] = await Promise.all([
    client.merchant.findMany({ where: built.where as never, orderBy: built.orderBy as never, skip: built.skip, take: built.take, include: { _count: { select: { wallets: true, applications: true, paymentAttempts: true, cashoutRequests: true } } } }),
    client.merchant.count({ where: built.where as never }),
  ]);
  const wallets = await client.wallet.findMany({ where: { merchantId: { in: rows.map((row) => row.id) } }, select: { id: true, merchantId: true, currency: true, glAccountId: true } });
  const amounts = await walletAmounts(wallets);
  const amountMap = new Map(amounts.map((row) => [row.walletId, row.availableBalance]));
  const walletMap = new Map(wallets.map((wallet) => [wallet.id, wallet]));
  const balanceByMerchant = new Map<string, string>();
  for (const amount of amounts) {
    const wallet = walletMap.get(amount.walletId);
    if (!wallet) continue;
    balanceByMerchant.set(wallet.merchantId, new Prisma.Decimal(balanceByMerchant.get(wallet.merchantId) ?? 0).plus(amount.availableBalance).toFixed(4));
  }
  void amountMap;
  response.json(listResponse("merchants", rows.map((row) => ({ id: row.id, tradeName: row.tradeName, legalName: row.legalName, displayName: row.displayName, status: row.status, onboardingChannel: row.onboardingChannel, country: row.country, createdAt: row.createdAt, wallets: row._count.wallets, applications: row._count.applications, payments: row._count.paymentAttempts, cashouts: row._count.cashoutRequests, availableBalance: balanceByMerchant.get(row.id) ?? "0.0000" })), total, built));
});

router.get("/admin/merchants/:merchantId", async (request, response) => {
  requireStaff(request);
  const { merchantId } = parseOrThrow(merchantIdSchema, request.params);
  const merchant = await client.merchant.findUnique({ where: { id: merchantId }, include: { wallets: { orderBy: { createdAt: "desc" } } } });
  if (!merchant) throw new ApiError(404, "SANDBOX_MERCHANT_NOT_FOUND", "The sandbox merchant does not exist");
  const amounts = await walletAmounts(merchant.wallets);
  const [applications, links, payments, cashouts, disputes, accounts, audits] = await Promise.all([
    client.application.findMany({ where: { merchantId }, select: { id: true, name: true, status: true, assignedWalletId: true, expectedMonthlyVolume: true, createdAt: true } }),
    client.paymentLink.findMany({ where: { application: { merchantId } }, select: { id: true, key: true, title: true, amount: true, currency: true, state: true, useCount: true, confirmedCount: true, createdAt: true } }),
    client.paymentAttempt.findMany({ where: { merchantId }, orderBy: { createdAt: "desc" }, take: 20, select: { id: true, reference: true, status: true, totalChargedAmount: true, netMerchantAmount: true, currency: true, createdAt: true } }),
    client.cashoutRequest.findMany({ where: { merchantId }, orderBy: { createdAt: "desc" }, take: 20 }),
    client.dispute.findMany({ where: { attempt: { merchantId } }, orderBy: { openedAt: "desc" }, take: 20 }),
    fakeRails.listAccounts({ merchantId }).catch(() => []),
    client.sandboxSyncAudit.findMany({ where: { merchantId }, orderBy: { createdAt: "desc" }, take: 50 }),
  ]);
  response.json({
    merchant,
    walletAmounts: amounts,
    wallets: merchant.wallets.map((wallet) => ({ id: wallet.id, name: wallet.name, currency: wallet.currency, status: wallet.status, createdAt: wallet.createdAt, ...(amounts.find((row) => row.walletId === wallet.id) ?? { availableBalance: "0.0000", checkpointBalance: "0.0000" }) })),
    applications: applications.map((row) => ({ ...row, expectedMonthlyVolume: sandboxMoney(row.expectedMonthlyVolume) })),
    links: links.map((row) => ({ ...row, amount: sandboxMoney(row.amount) })),
    payments: payments.map((row) => ({ ...row, totalChargedAmount: sandboxMoney(row.totalChargedAmount), netMerchantAmount: sandboxMoney(row.netMerchantAmount) })),
    cashouts: cashouts.map((row) => ({ ...row, amount: sandboxMoney(row.amount) })),
    disputes,
    accounts: Array.isArray(accounts) ? accounts : [],
    audits,
  });
});

router.get("/admin/audits", async (request, response) => {
  requireStaff(request);
  const built = buildListQuery(request.query, {
    in: { syncType: "type" },
    equals: { actorRole: "role", actorId: "actorId" },
    dates: { createdAt: { path: "createdAt", fromKey: "from", toKey: "to" } },
    sortable: { createdAt: "createdAt", syncType: "syncType" },
    defaultSort: { createdAt: "desc" },
  });
  const [rows, total] = await Promise.all([
    client.sandboxSyncAudit.findMany({ where: built.where as never, orderBy: built.orderBy as never, skip: built.skip, take: built.take }),
    client.sandboxSyncAudit.count({ where: built.where as never }),
  ]);
  response.json(listResponse("audits", rows, total, built));
});



router.get("/admin/overview", async (request, response) => {
  const principal = principalOf(request);
  if (!isStaffPrincipal(principal)) {
    throw new ApiError(403, "STAFF_ONLY", "A staff principal is required");
  }
  const [merchants, wallets, applications, links, attempts, tokens, plane, refs, syncAudits] = await Promise.all([
    client.merchant.count(),
    client.wallet.count(),
    client.application.count(),
    client.paymentLink.count(),
    client.paymentAttempt.count(),
    client.accessToken.count({ where: { env: "SANDBOX", revokedAt: null } }),
    client.systemExecutionPlane.findUnique({ where: { id: 1 } }),
    Promise.all([client.rail.count(), client.gateway.count(), client.railRoute.count(), client.commissionProfile.count()]),
    client.sandboxSyncAudit.findMany({ orderBy: { createdAt: "desc" }, take: 20 }),
  ]);
  let fakeRailsHealth: { ok: boolean; message?: string } = { ok: true };
  try {
    await fakeRails.listAccounts({});
  } catch (error) {
    fakeRailsHealth = { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  const [rails, gateways, routes, commissionProfiles] = refs;
  response.json({
    plane: "SANDBOX",
    planeState: plane,
    sandbox: { merchants, wallets, applications, links, attempts, tokens },
    reference: { rails, gateways, routes, commissionProfiles, ready: rails > 0 && gateways > 0 && routes > 0 },
    fakeRails: fakeRailsHealth,
    liveSyncRevision: plane?.liveSyncRevision ?? 0,
    lastSyncedFromLive: plane?.lastSyncedFromLive ?? null,
    syncAudits,
  });
});

router.get("/admin/merchants", async (request, response) => {
  requireStaff(request);
  const search = typeof request.query.search === "string" ? request.query.search.trim() : "";
  const merchants = await client.merchant.findMany({
    where: search
      ? { OR: [{ tradeName: { contains: search, mode: "insensitive" } }, { legalName: { contains: search, mode: "insensitive" } }] }
      : {},
    orderBy: { createdAt: "desc" },
    take: 200,
    select: { id: true, tradeName: true, legalName: true, status: true, createdAt: true },
  });
  response.json({ merchants });
});

router.get("/admin/merchants/:merchantId/overview", async (request, response) => {
  const principal = principalOf(request);
  if (!isStaffPrincipal(principal)) {
    throw new ApiError(403, "STAFF_ONLY", "A staff principal is required");
  }
  const { merchantId } = parseOrThrow(merchantIdSchema, request.params);
  const [wallets, applications, links, attempts, cashouts, disputes, audits] = await Promise.all([
    client.wallet.findMany({ where: { merchantId }, orderBy: { createdAt: "desc" } }),
    client.application.count({ where: { merchantId } }),
    client.paymentLink.count({ where: { application: { merchantId } } }),
    client.paymentAttempt.count({ where: { merchantId } }),
    client.cashoutRequest.count({ where: { merchantId } }),
    client.dispute.count({ where: { attempt: { merchantId } } }),
    client.sandboxSyncAudit.findMany({ where: { merchantId }, orderBy: { createdAt: "desc" }, take: 20 }),
  ]);
  const balances = await walletBalances(wallets);
  response.json({
    merchantId,
    counts: { wallets: wallets.length, applications, links, attempts, cashouts, disputes },
    syncAudits: audits,
    wallets: wallets.map((wallet) => ({
      id: wallet.id,
      name: wallet.name,
      currency: wallet.currency,
      status: wallet.status,
      availableBalance: balances.find((row) => row.walletId === wallet.id)?.availableBalance ?? "0.0000",
    })),
  });
});

// --- Staff Fake Rails control center ------------------------------------

router.get("/admin/fake-rails/scenarios", async (request, response) => {
  requireStaff(request);
  response.json(await fakeRails.listScenarios());
});

router.put("/admin/fake-rails/scenarios/:railCode", async (request, response) => {
  requireStaff(request);
  response.json({ scenario: await fakeRails.updateScenario(String(request.params.railCode), request.body ?? {}) });
});

router.post("/admin/fake-rails/scenarios/preset/:railCode/:preset", async (request, response) => {
  requireStaff(request);
  response.json({ scenario: await fakeRails.applyScenarioPreset(String(request.params.railCode), String(request.params.preset)) });
});

router.post("/admin/fake-rails/scenarios/global/:preset", async (request, response) => {
  requireStaff(request);
  response.json({ scenarios: await fakeRails.applyGlobalScenarioPreset(String(request.params.preset)) });
});

router.post("/admin/fake-rails/scenarios/reset", async (request, response) => {
  requireStaff(request);
  response.json({ scenarios: await fakeRails.resetScenarios() });
});

router.get("/admin/fake-rails/transactions", async (request, response) => {
  requireStaff(request);
  response.json(await fakeRails.listTransactions({
    railCode: typeof request.query.railCode === "string" ? request.query.railCode : undefined,
    gatewayCode: typeof request.query.gatewayCode === "string" ? request.query.gatewayCode : undefined,
    status: typeof request.query.status === "string" ? request.query.status : undefined,
    reference: typeof request.query.reference === "string" ? request.query.reference : undefined,
    from: typeof request.query.from === "string" ? request.query.from : undefined,
    to: typeof request.query.to === "string" ? request.query.to : undefined,
    limit: request.query.limit
      ? Number(request.query.limit)
      : request.query.pageSize
        ? Number(request.query.pageSize)
        : 100,
    offset: request.query.offset
      ? Number(request.query.offset)
      : request.query.page
        ? (Math.max(1, Number(request.query.page)) - 1) * Number(request.query.pageSize ?? 100)
        : 0,
  }));
});

router.get("/admin/fake-rails/transactions/summary", async (request, response) => {
  requireStaff(request);
  response.json(await fakeRails.transactionSummary());
});

router.get("/admin/fake-rails/transactions/:transactionId", async (request, response) => {
  requireStaff(request);
  response.json(await fakeRails.transaction(String(request.params.transactionId)));
});

router.post("/admin/fake-rails/transactions/:transactionId/action", async (request, response) => {
  requireStaff(request);
  const body = parseOrThrow(
    z.object({
      action: z.enum(["APPROVE", "REJECT", "APPROVE_MISMATCH", "APPROVE_LATE", "FORCE_OUTCOME", "CANCEL"]),
      phase: z.string().max(32).optional(),
      failureMode: z.string().max(80).optional(),
    }).strict(),
    request.body ?? {},
  );
  response.json(await fakeRails.transactionAction(String(request.params.transactionId), body));
});

router.get("/admin/fake-rails/webhooks", async (request, response) => {
  requireStaff(request);
  response.json({
    deliveries: await fakeRails.webhookDeliveries(
      typeof request.query.transactionId === "string" ? request.query.transactionId : undefined,
    ),
  });
});

router.post("/admin/fake-rails/webhooks/:transactionId/fire", async (request, response) => {
  requireStaff(request);
  response.json(await fakeRails.fireWebhook(String(request.params.transactionId), request.body ?? {}));
});

router.post("/admin/fake-rails/webhooks/deliveries/:deliveryId/replay", async (request, response) => {
  requireStaff(request);
  response.json(await fakeRails.replayWebhook(String(request.params.deliveryId), String(request.query.tamper ?? "") === "true"));
});

router.post("/admin/fake-rails/webhooks/deliveries/:deliveryId/send-now", async (request, response) => {
  requireStaff(request);
  response.json(await fakeRails.sendWebhookNow(String(request.params.deliveryId)));
});

router.post("/admin/fake-rails/webhooks/:transactionId/dispute", async (request, response) => {
  requireStaff(request);
  response.json(await fakeRails.disputeWebhook(String(request.params.transactionId)));
});

router.get("/admin/fake-rails/statements", async (request, response) => {
  requireStaff(request);
  response.json({ statements: await fakeRails.listStatements() });
});

router.post("/admin/fake-rails/statements/generate", async (request, response) => {
  requireStaff(request);
  const body = parseOrThrow(
    z.object({
      gatewayCode: z.string().min(1).max(64),
      from: z.string().optional(),
      to: z.string().optional(),
      anomalies: z.record(z.string(), z.unknown()).optional(),
    }).strict(),
    request.body ?? {},
  );
  response.json(await fakeRails.generateTesterStatement(body));
});

router.post("/admin/reset", async (request, response) => {
  const principal = requireStaff(request);
  const body = parseOrThrow(z.object({ confirm: z.literal("RESET SANDBOX") }).strict(), request.body ?? {});
  void body;
  const merchants = await client.merchant.findMany({ select: { id: true } });
  const summaries: Array<Record<string, unknown>> = [];
  for (const merchant of merchants) {
    summaries.push({ merchantId: merchant.id, ...(await resetMerchantSandbox(merchant.id)) });
  }
  let fakeReset: unknown = null;
  try {
    fakeReset = await fakeRails.resetAccounts({});
  } catch (error) {
    fakeReset = { error: error instanceof Error ? error.message : String(error) };
  }
  await client.sandboxSyncAudit.create({
    data: {
      syncType: "GLOBAL_RESET",
      actorId: principal.userId,
      actorRole: "ADMIN",
      summaryJson: { merchants: summaries.length },
    },
  });
  response.json({ ok: true, merchants: summaries, fakeRails: fakeReset });
});

export default router;
