/**
 * A small real-database catalog for the automation suites (AUTO-xx): one merchant with a wallet, the GL accounts a
 * merchant-direct commission needs, an application, a gateway with its version and credential set, a rail, a route, a
 * link and an attempt group, plus helpers to create attempts and to post balanced ledger entries.
 *
 * Every id is unique per call, so suites can run repeatedly on the shared test database. The ledger is append-only,
 * so the helpers only post BALANCED entries (a drift would fail unrelated suites); rows that other suites must not
 * see (operator cases, queued jobs and notifications) are removed by `cleanupAutomationCatalog`.
 */
import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "../../generated/prisma/client";
import { LedgerPoster, type JournalTemplate } from "../../engine/ledger/LedgerPoster";
import { createLedgerPoster } from "../../lib/storageEngine/ledgerPosterFactory";
import { clearShardWidthCache } from "../../lib/storageEngine/shardRouting";

export interface AutomationCatalog {
  label: string;
  userId: string;
  merchantId: string;
  walletId: string;
  walletGlId: string;
  treasuryGlId: string;
  incomeGlId: string;
  receivableGlId: string;
  applicationId: string;
  gatewayId: string;
  gatewayVersionId: string;
  credentialSetId: string;
  railId: string;
  routeId: string;
  commissionProfileId: string;
  linkId: string;
  attemptGroupId: string;
  poster: LedgerPoster;
  /** Creates a payment attempt of this catalog. */
  newAttempt(options?: AttemptOptions): Promise<{ id: string; reference: string }>;
  /** Credits the wallet from the treasury (a balanced entry). */
  fundWallet(amount: string): Promise<void>;
  /** Books the merchant-direct commission recognition of an attempt (`Dr COMMISSION_RECEIVABLE / Cr PLATFORM_INCOME`). */
  recognizeCommission(attemptId: string, amount: string): Promise<void>;
  /** The merchant's receivable on this catalog's receivable account, by the ledger (debit positive). */
  receivableBalance(): Promise<string>;
  /** The wallet balance by the ledger (credit positive). */
  walletBalance(): Promise<string>;
}

export interface AttemptOptions {
  status?: string;
  settlementTarget?: "PLATFORM_CLEARING" | "MERCHANT_DIRECT" | "PROVIDER_HELD";
  amount?: string;
  commission?: string;
  createdAt?: Date;
  expiresAt?: Date;
  /** SANDBOX by default. Regulatory returns count LIVE payments only. */
  env?: "SANDBOX" | "LIVE";
}

const sha = (value: string): string => createHash("sha256").update(value).digest("hex");

export const createAutomationCatalog = async (
  client: PrismaClient,
  options: { label?: string; commissionReceivableCeiling?: string | null; walletStatus?: "ACTIVE" | "FROZEN" } = {},
): Promise<AutomationCatalog> => {
  const label = `${options.label ?? "auto"}-${randomUUID().replace(/-/g, "").slice(0, 10)}`;
  clearShardWidthCache();

  const user = await client.user.create({
    data: {
      email: `${label}-admin@gateway.test`,
      role: "MERCHANT_ADMIN",
      status: "ACTIVE",
      authoritiesMap: {},
      appScopeIds: [],
      isMaker: false,
      isChecker: false,
      mfaRequired: false,
    },
  });
  const merchant = await client.merchant.create({
    data: {
      legalName: `Automation Merchant ${label}`,
      tradeName: `Auto ${label}`,
      onboardingChannel: "AUTOMATION_TEST",
      country: "LY",
      status: "ACTIVE",
      kybStatus: "VERIFIED",
      riskTier: "LOW",
      activatedAt: new Date(),
      contactEmail: `${label}-merchant@gateway.test`,
      contactPhone: "+218910000000",
      negativeBalanceCeiling: new Prisma.Decimal(0),
      ...(options.commissionReceivableCeiling !== undefined && options.commissionReceivableCeiling !== null
        ? { commissionReceivableCeiling: new Prisma.Decimal(options.commissionReceivableCeiling) }
        : {}),
    },
  });
  await client.user.update({ where: { id: user.id }, data: { merchantId: merchant.id } });

  const gateway = await client.gateway.create({
    data: {
      code: `auto-gw-${label}`,
      name: `Automation Gateway ${label}`,
      operator: "Automation",
      country: "LY",
      aliases: [],
      kind: "DIRECT",
      status: "LIVE",
      verificationState: "VERIFIED",
      riskClass: "NORMAL",
    },
  });
  const gatewayVersion = await client.gatewayVersion.create({
    data: {
      gatewayId: gateway.id,
      versionNumber: 1,
      snapshotCiphertext: JSON.stringify({ environment: "SANDBOX" }),
      contentHash: sha(`auto-version:${label}`),
      state: "LIVE",
      createdById: user.id,
      changeNote: "automation",
    },
  });
  await client.gateway.update({ where: { id: gateway.id }, data: { activeVersionId: gatewayVersion.id } });
  const credentialSet = await client.credentialSet.create({
    data: {
      gatewayId: gateway.id,
      env: "SANDBOX",
      ownerType: "PLATFORM",
      externalMerchantId: `auto-${label}`,
      settlementTarget: "PLATFORM_CLEARING",
      entriesCiphertext: [],
      status: "VERIFIED",
      lastVerifiedAt: new Date(),
    },
  });

  const account = async (accountType: string): Promise<string> =>
    (
      await client.glAccount.create({
        data: {
          accountType: accountType as Prisma.GlAccountCreateInput["accountType"],
          ownerId: merchant.id,
          credentialSetId: credentialSet.id,
          env: "SANDBOX",
          currency: "LYD",
        },
      })
    ).id;
  const treasuryGlId = await account("TREASURY");
  const incomeGlId = await account("PLATFORM_INCOME");
  const receivableGlId = await account("COMMISSION_RECEIVABLE");
  const walletGlId = await account("MERCHANT_WALLET");

  const wallet = await client.wallet.create({
    data: { merchantId: merchant.id, glAccountId: walletGlId, currency: "LYD", status: options.walletStatus ?? "ACTIVE" },
  });
  const application = await client.application.create({
    data: {
      merchantId: merchant.id,
      name: `Automation App ${label}`,
      expectedMonthlyVolume: new Prisma.Decimal(0),
      assignedWalletId: wallet.id,
      status: "ACTIVE",
    },
  });
  const rail = await client.rail.create({
    data: {
      code: `auto-rail-${label}`,
      nameAr: `سكة ${label}`,
      nameEn: `Automation Rail ${label}`,
      collectionMode: "OTP_PULL",
      subModes: [],
      currency: "LYD",
      minAmount: new Prisma.Decimal(0),
      maxAmount: new Prisma.Decimal(100000),
      capabilities: { refund: true },
      metadata: { automation: true },
    },
  });
  const route = await client.railRoute.create({
    data: {
      railId: rail.id,
      gatewayId: gateway.id,
      credentialPolicy: "PLATFORM",
      priority: 0,
      routingStrategy: "EFFECTIVE_COST",
      weight: 100,
      costModel: { flat: "0", percent: "0" },
      mismatchPolicy: { tolerance_amount: "0.0100" },
      minAmount: new Prisma.Decimal(0),
      maxAmount: new Prisma.Decimal(100000),
      status: "ACTIVE",
      healthState: "HEALTHY",
      scope: { merchant_ids: [merchant.id], application_ids: [application.id], risk_tiers: ["LOW"], channels: ["WEB"] },
    },
  });
  const commissionProfile = await client.commissionProfile.create({
    data: {
      merchantId: merchant.id,
      applicationId: application.id,
      railCode: rail.code,
      calcType: "PERCENTAGE",
      flatFee: new Prisma.Decimal(0),
      percentageRate: new Prisma.Decimal("0.030000"),
      minFee: new Prisma.Decimal(0),
      feeBearerDefault: "MERCHANT_ABSORBS",
      roundingMode: "HALF_UP",
      effectiveFrom: new Date(Date.now() - 60_000),
    },
  });
  const link = await client.paymentLink.create({
    data: {
      key: `auto-link-${label}`,
      applicationId: application.id,
      walletId: wallet.id,
      amount: new Prisma.Decimal("100.0000"),
      currency: "LYD",
      feeBearer: "MERCHANT_ABSORBS",
      useCount: 1000,
      state: "PENDING",
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
  const attemptGroup = await client.attemptGroup.create({
    data: { linkId: link.id, customerFingerprint: sha(`auto-fp:${label}`) },
  });

  const poster = createLedgerPoster(client as never);
  let sequence = 0;

  const catalog: AutomationCatalog = {
    label,
    userId: user.id,
    merchantId: merchant.id,
    walletId: wallet.id,
    walletGlId,
    treasuryGlId,
    incomeGlId,
    receivableGlId,
    applicationId: application.id,
    gatewayId: gateway.id,
    gatewayVersionId: gatewayVersion.id,
    credentialSetId: credentialSet.id,
    railId: rail.id,
    routeId: route.id,
    commissionProfileId: commissionProfile.id,
    linkId: link.id,
    attemptGroupId: attemptGroup.id,
    poster,

    async newAttempt(attemptOptions = {}) {
      sequence += 1;
      const reference = `PA-${label}-${sequence}`;
      const amount = attemptOptions.amount ?? "100.0000";
      const commission = attemptOptions.commission ?? "3.0000";
      const created = await client.paymentAttempt.create({
        data: {
          reference,
          linkId: link.id,
          attemptGroupId: attemptGroup.id,
          applicationId: application.id,
          merchantId: merchant.id,
          railId: rail.id,
          routeId: route.id,
          credentialSetId: credentialSet.id,
          gatewayVersionId: gatewayVersion.id,
          commissionProfileId: commissionProfile.id,
          env: attemptOptions.env ?? "SANDBOX",
          mode: "OTP_PULL",
          status: (attemptOptions.status ?? "SUCCEEDED") as never,
          requestedAmount: new Prisma.Decimal(amount),
          surchargeAmount: new Prisma.Decimal(0),
          totalChargedAmount: new Prisma.Decimal(amount),
          gatewayFeeAmount: new Prisma.Decimal(0),
          platformCommissionAmount: new Prisma.Decimal(commission),
          netMerchantAmount: new Prisma.Decimal(new Prisma.Decimal(amount).minus(commission)),
          feeBearer: "MERCHANT_ABSORBS",
          settlementTarget: attemptOptions.settlementTarget ?? "MERCHANT_DIRECT",
          currency: "LYD",
          customerFieldsMasked: {},
          contextCiphertext: "",
          expiresAt: attemptOptions.expiresAt ?? new Date(Date.now() + 1_800_000),
          graceExpiresAt: new Date(Date.now() + 86_400_000),
          clientIp: "127.0.0.1",
          userAgent: "core-back-automation",
          ...(attemptOptions.createdAt ? { createdAt: attemptOptions.createdAt } : {}),
        },
      });
      return { id: created.id, reference };
    },

    async fundWallet(amount) {
      const template: JournalTemplate = {
        refType: "ADJUSTMENT",
        refId: `${label}-fund-${randomUUID()}`,
        description: "Automation test: fund the merchant wallet",
        lines: [
          { direction: "DEBIT", amount, account: { accountType: "TREASURY", accountId: treasuryGlId } },
          { direction: "CREDIT", amount, account: { accountType: "MERCHANT_WALLET", accountId: walletGlId } },
        ],
      };
      await poster.post(template, { currency: "LYD" }, client as never);
    },

    async recognizeCommission(attemptId, amount) {
      const template: JournalTemplate = {
        refType: "PAYMENT_ATTEMPT",
        refId: attemptId,
        description: "Automation test: merchant-direct commission recognition",
        lines: [
          { direction: "DEBIT", amount, account: { accountType: "COMMISSION_RECEIVABLE", accountId: receivableGlId } },
          { direction: "CREDIT", amount, account: { accountType: "PLATFORM_INCOME", accountId: incomeGlId } },
        ],
      };
      await poster.post(template, { currency: "LYD" }, client as never);
    },

    async receivableBalance() {
      const rows = await client.$queryRawUnsafe<Array<{ b: string }>>(
        `SELECT COALESCE(SUM(current_balance), 0)::text AS b FROM gl_account_shards WHERE gl_account_id = $1::uuid`,
        receivableGlId,
      );
      return rows[0]?.b ?? "0";
    },

    async walletBalance() {
      const rows = await client.$queryRawUnsafe<Array<{ b: string }>>(
        `SELECT (-COALESCE(SUM(current_balance), 0))::text AS b FROM gl_account_shards WHERE gl_account_id = $1::uuid`,
        walletGlId,
      );
      return rows[0]?.b ?? "0";
    },
  };
  return catalog;
};

/** Removes the rows of a catalog that other suites must not see: its operator cases, queued jobs and notifications. */
export const cleanupAutomationCatalog = async (client: PrismaClient, catalogs: readonly AutomationCatalog[]): Promise<void> => {
  for (const catalog of catalogs) {
    await client.$executeRawUnsafe(
      `DELETE FROM operator_cases WHERE subject_key LIKE $1 OR attempt_id IN (SELECT id FROM payment_attempts WHERE merchant_id = $2::uuid)`,
      `%${catalog.merchantId}%`,
      catalog.merchantId,
    );
    await client.$executeRawUnsafe(`DELETE FROM notifications WHERE recipient_merchant_id = $1::uuid`, catalog.merchantId);
    await client.$executeRawUnsafe(
      `DELETE FROM background_jobs WHERE reference_id IN (SELECT id::text FROM payment_attempts WHERE merchant_id = $1::uuid)
         OR reference_id IN (SELECT id::text FROM adjustments WHERE source_attempt_id IN (SELECT id FROM payment_attempts WHERE merchant_id = $1::uuid))`,
      catalog.merchantId,
    );
  }
};
