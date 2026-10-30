import "dotenv/config";
import { createHash } from "node:crypto";
import { Prisma } from "../generated/prisma/client";
import { client } from "../prisma/client";
import { Vault } from "../engine/crypto/Vault";
import { VaultContextCipher } from "../engine/runtime/contextCipher";
import { InvariantVerifier } from "../engine/ledger/InvariantVerifier";
import { buildLedgerTemplate, buildPaymentConfirmationTemplate, decimal } from "../engine/ledger/LedgerPoster";
import {
  GENERATOR_VERSION,
  manifestKey,
  manifestMatches,
  mulberry32,
  parseSyntheticConfig,
  pick,
  syntheticGuardError,
  syntheticId,
  syntheticReference,
  USAGE,
  type SyntheticConfig,
  type SyntheticManifest,
} from "./syntheticDataPlan";

const DAY = 24 * 60 * 60 * 1000;
const CURRENCY = "LYD";
const json = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;
const dec = (value: string | number): Prisma.Decimal => new Prisma.Decimal(String(value));
const sha = (value: string): string => createHash("sha256").update(value).digest("hex");
const chunk = <T>(values: readonly T[], size: number): T[][] => {
  const output: T[][] = [];
  for (let index = 0; index < values.length; index += size) output.push(values.slice(index, index + size));
  return output;
};

interface CatalogRoute {
  routeId: string;
  railId: string;
  railCode: string;
  gatewayId: string;
  gatewayCode: string;
  gatewayKind: string;
  gatewayVersionId: string;
  credentialSetId: string;
  settlementTarget: string;
  commissionProfileId: string;
}

interface JournalBatch {
  entries: Prisma.JournalEntryCreateManyInput[];
  lines: Prisma.JournalLineCreateManyInput[];
}

const loadManifest = async (namespace: string): Promise<SyntheticManifest | null> => {
  const row = await client.platformSetting.findUnique({
    where: { key_scope_version: { key: manifestKey(namespace), scope: "PLATFORM", version: 1 } },
  });
  if (!row) return null;
  return row.valueJson as unknown as SyntheticManifest;
};

const writeManifest = async (manifest: SyntheticManifest): Promise<void> => {
  await client.platformSetting.upsert({
    where: { key_scope_version: { key: manifestKey(manifest.namespace), scope: "PLATFORM", version: 1 } },
    update: { valueJson: json(manifest), effectiveFrom: new Date() },
    create: {
      key: manifestKey(manifest.namespace),
      scope: "PLATFORM",
      version: 1,
      valueJson: json(manifest),
      effectiveFrom: new Date(),
    },
  });
};

const deleteNamespace = async (namespace: string): Promise<void> => {
  const starts = namespace;
  const entryIds = (await client.journalEntry.findMany({
    where: { refId: { startsWith: starts } },
    select: { id: true },
  })).map((entry) => entry.id);
  if (entryIds.length > 0) {
    await client.journalLine.deleteMany({ where: { entryId: { in: entryIds } } });
  }
  await client.notification.deleteMany({ where: { id: { startsWith: starts } } });
  await client.detailChangeLog.deleteMany({ where: { id: { startsWith: starts } } });
  await client.auditLog.deleteMany({ where: { id: { startsWith: starts } } });
  await client.regulatoryReport.deleteMany({ where: { id: { startsWith: starts } } });
  await client.amlCase.deleteMany({ where: { id: { startsWith: starts } } });
  await client.amlScreeningMatch.deleteMany({ where: { id: { startsWith: starts } } });
  await client.amlScreening.deleteMany({ where: { id: { startsWith: starts } } });
  await client.dispute.deleteMany({ where: { id: { startsWith: starts } } });
  await client.adjustment.deleteMany({ where: { id: { startsWith: starts } } });
  await client.cashoutRequest.deleteMany({ where: { id: { startsWith: starts } } });
  await client.approvalRequest.deleteMany({ where: { id: { startsWith: starts } } });
  await client.operatorCase.deleteMany({ where: { id: { startsWith: starts } } });
  await client.reconciliationItem.deleteMany({ where: { id: { startsWith: starts } } });
  await client.reconciliationRun.deleteMany({ where: { id: { startsWith: starts } } });
  await client.statementSource.deleteMany({ where: { id: { startsWith: starts } } });
  await client.attemptStepLog.deleteMany({ where: { id: { startsWith: starts } } });
  await client.inboundEvent.deleteMany({ where: { id: { startsWith: starts } } });
  await client.paymentAttempt.deleteMany({ where: { id: { startsWith: starts } } });
  await client.journalEntry.deleteMany({ where: { id: { in: entryIds } } });
  await client.attemptGroup.deleteMany({ where: { id: { startsWith: starts } } });
  await client.paymentLink.deleteMany({ where: { id: { startsWith: starts } } });
  await client.commissionProfile.deleteMany({ where: { seedKey: { startsWith: starts } } });
  await client.joinRequest.deleteMany({ where: { id: { startsWith: starts } } });
  await client.kybDocument.deleteMany({ where: { id: { startsWith: starts } } });
  await client.beneficialOwner.deleteMany({ where: { id: { startsWith: starts } } });
  await client.user.deleteMany({ where: { email: { startsWith: `${starts}-merchant-` } } });
  await client.application.deleteMany({ where: { id: { startsWith: starts } } });
  await client.wallet.deleteMany({ where: { id: { startsWith: starts } } });
  await client.glAccount.deleteMany({ where: { id: { startsWith: starts } } });
  await client.merchant.deleteMany({ where: { id: { startsWith: starts } } });
  await client.gatewayHealthSample.deleteMany({ where: { id: { startsWith: starts } } });
  await client.platformSetting.deleteMany({ where: { key: manifestKey(namespace) } });
};

const loadCatalog = async (): Promise<{ routes: CatalogRoute[]; commissionProfileId: string; adminIds: string[] }> => {
  const adminIds = (await client.user.findMany({
    where: { role: { in: ["GATEWAY_ADMIN", "SECURITY_ADMIN", "FINANCE", "COMPLIANCE", "MLRO", "OPERATOR", "SUPPORT"] } },
    select: { id: true },
    take: 20,
  })).map((user) => user.id);
  if (adminIds.length === 0) throw new Error("no seeded admin user exists; run bun run db-seed first");
  const defaultProfile = await client.commissionProfile.findFirst({
    where: { seedKey: "platform-default" },
  });
  if (!defaultProfile) throw new Error("the platform default commission profile is missing; run bun run db-seed first");
  const routes = await client.railRoute.findMany({
    where: { status: "ACTIVE" },
    include: {
      rail: true,
      gateway: { select: { id: true, code: true, kind: true, activeVersionId: true } },
    },
  });
  const credentialSets = await client.credentialSet.findMany({
    where: { status: "VERIFIED", ownerType: "PLATFORM" },
  });
  const catalog: CatalogRoute[] = [];
  for (const route of routes) {
    const credentialSet = credentialSets.find(
      (entry) => entry.gatewayId === route.gatewayId && entry.env === "LIVE",
    ) ?? credentialSets.find((entry) => entry.gatewayId === route.gatewayId);
    if (!credentialSet || !route.gateway.activeVersionId) continue;
    catalog.push({
      routeId: route.id,
      railId: route.railId,
      railCode: route.rail.code,
      gatewayId: route.gatewayId,
      gatewayCode: route.gateway.code,
      gatewayKind: route.gateway.kind,
      gatewayVersionId: route.gateway.activeVersionId,
      credentialSetId: credentialSet.id,
      settlementTarget: credentialSet.settlementTarget,
      commissionProfileId: defaultProfile.id,
    });
  }
  if (catalog.length === 0) throw new Error("no executable rail route with a verified platform credential set exists; run bun run db-seed and optionally bun run seed-fake-rails");
  return { routes: catalog, commissionProfileId: defaultProfile.id, adminIds };
};

const run = async (config: SyntheticConfig): Promise<void> => {
  const manifest = await loadManifest(config.namespace);
  if (config.auto && manifestMatches(manifest, config)) {
    console.log(`Synthetic dataset '${config.namespace}' is already complete; skipping.`);
    return;
  }
  if (config.verify) {
    if (!manifest) throw new Error(`no manifest exists for namespace '${config.namespace}'`);
    const invariant = await new InvariantVerifier(client as never).verify();
    console.log(JSON.stringify({ manifest, ledgerDrift: invariant.drift, ok: invariant.ok }, null, 2));
    return;
  }
  if (config.reset || manifest) {
    await deleteNamespace(config.namespace);
  }

  const catalog = await loadCatalog();
  const random = mulberry32(config.seed);
  const vault = new Vault();
  const reportingCipher = new VaultContextCipher(vault, "reporting-payload");
  const end = new Date(`${config.endDate}T23:59:59.000Z`).getTime();
  const start = end - config.years * 365 * DAY;
  const startedAt = new Date().toISOString();
  const counts: Record<string, number> = {};
  let idSequence = 0;
  const nextId = (kind: string) => syntheticId(config.namespace, kind, ++idSequence);

  const platformAccounts = await client.glAccount.findMany({ where: { currency: CURRENCY } });
  const platformAccount = (type: string): string => {
    const match = platformAccounts.find((account) => account.accountType === type && !account.ownerId)
      ?? platformAccounts.find((account) => account.accountType === type);
    if (!match) throw new Error(`missing GL account ${type}; run bun run db-seed first`);
    return match.id;
  };
  const platformAccountIds = new Map<string, string>();
  for (const type of ["TREASURY", "GATEWAY_CLEARING", "PLATFORM_INCOME", "PROVIDER_FEE_EXPENSE", "GATEWAY_FEE_EXPENSE", "GATEWAY_FEE_ACCRUAL", "COMMISSION_RECEIVABLE", "AML_HOLD", "CHARGEBACK_RESERVE", "SUSPENSE"]) {
    platformAccountIds.set(type, platformAccount(type));
  }

  const merchants: Array<{
    id: string;
    userId: string;
    applicationId: string;
    walletId: string;
    glAccountId: string;
    tradeName: string;
    email: string;
    activatedAt: Date;
    balance: number;
  }> = [];
  for (let index = 0; index < config.merchants; index += 1) {
    const merchantId = nextId("mer");
    const userId = nextId("usr");
    const applicationId = nextId("app");
    const walletId = nextId("wal");
    const glAccountId = nextId("gl");
    const email = `${config.namespace}-merchant-${index + 1}@synthetic.payment-gateway.local`;
    const tradeName = `SYNTH Merchant ${String(index + 1).padStart(3, "0")}`;
    const activatedAt = new Date(start + Math.floor(random() * (end - start) * 0.75));
    await client.merchant.create({
      data: {
        id: merchantId,
        legalName: `${tradeName} LLC`,
        tradeName,
        taxId: `SYNTH-TAX-${index + 1}`,
        registrationNo: `SYNTH-REG-${index + 1}`,
        businessCategory: pick(random, ["Retail", "E-commerce", "Services", "Travel", "Education"]),
        status: "ACTIVE",
        kybStatus: "VERIFIED",
        riskTier: pick(random, ["LOW", "STANDARD", "STANDARD", "HIGH"]),
        onboardingChannel: "SELF_SERVICE",
        country: "LY",
        contactPhone: `+21891${String(1000000 + index).slice(-7)}`,
        contactEmail: email,
        activatedAt,
        negativeBalanceCeiling: dec(0),
      },
    });
    await client.user.create({
      data: {
        id: userId,
        merchantId,
        email,
        phone: `+21891${String(1000000 + index).slice(-7)}`,
        role: "MERCHANT_ADMIN",
        authoritiesMap: json(["merchant:read", "merchant:write", "link:write", "payment:read"]),
        appScopeIds: json([applicationId]),
        isMaker: true,
        isChecker: false,
        mfaRequired: false,
        status: "ACTIVE",
      },
    });
    await client.glAccount.create({
      data: { id: glAccountId, accountType: "MERCHANT_WALLET", ownerId: merchantId, currency: CURRENCY, checkpointBalance: dec(0) },
    });
    await client.wallet.create({
      data: { id: walletId, merchantId, glAccountId, currency: CURRENCY, status: "ACTIVE" },
    });
    await client.application.create({
      data: {
        id: applicationId,
        merchantId,
        name: `${tradeName} Store`,
        expectedMonthlyVolume: dec(50000),
        assignedWalletId: walletId,
        status: "ACTIVE",
      },
    });
    const joinRequestId = nextId("jr");
    await client.joinRequest.create({
      data: {
        id: joinRequestId,
        merchantId,
        submittedByUserId: userId,
        status: "APPROVED",
        onboardingChannel: "SELF_SERVICE",
        submittedAt: new Date(activatedAt.getTime() - 7 * DAY),
        slaDueAt: new Date(activatedAt.getTime() - 2 * DAY),
        proposedRiskTier: "STANDARD",
        fourEyesRequired: false,
        decision: "APPROVED",
        decisionReasonCode: "KYB_COMPLETE",
      },
    });
    await client.kybDocument.create({
      data: {
        id: nextId("kyb"),
        merchantId,
        joinRequestId,
        subjectType: "MERCHANT",
        subjectId: merchantId,
        docType: "COMMERCIAL_REGISTRY",
        storageKey: `synthetic/${merchantId}/registry.pdf`,
        sha256: sha(`${merchantId}:registry`),
        mime: "application/pdf",
        sizeBytes: 1024,
        avStatus: "CLEAN",
        status: "ACCEPTED",
        reviewedById: pick(random, catalog.adminIds),
        reviewedAt: activatedAt,
      },
    });
    await client.beneficialOwner.create({
      data: {
        id: nextId("bo"),
        merchantId,
        fullNameAr: `مالك ${index + 1}`,
        fullNameEn: `Owner ${index + 1}`,
        nationalIdCiphertext: await vault.encryptSecret(`SYNTH-ID-${index + 1}`, "beneficial-owner"),
        dateOfBirth: new Date("1985-01-01T00:00:00Z"),
        nationality: "LY",
        ownershipPercent: dec(100),
        role: "OWNER",
        pepDeclared: false,
        screeningStatus: "CLEAR",
        active: true,
        validFrom: activatedAt,
      },
    });
    merchants.push({ id: merchantId, userId, applicationId, walletId, glAccountId, tradeName, email, activatedAt, balance: 0 });
  }
  counts.merchants = merchants.length;
  counts.users = merchants.length;

  interface AttemptSpec {
    index: number;
    date: Date;
    merchant: typeof merchants[number];
    route: CatalogRoute;
    amount: number;
    commission: number;
    gatewayFee: number;
    status: "SUCCEEDED" | "FAILED" | "EXPIRED" | "CANCELLED" | "BLOCKED" | "UNKNOWN";
    refund?: "FULL" | "PARTIAL";
    dispute?: "WON" | "LOST";
  }
  const specs: AttemptSpec[] = [];
  for (let index = 0; index < config.attempts; index += 1) {
    const merchant = pick(random, merchants);
    const earliest = merchant.activatedAt.getTime();
    if (earliest >= end) continue;
    const date = new Date(earliest + Math.floor(random() * (end - earliest)));
    const route = pick(random, catalog.routes);
    const amount = Math.round((5 + random() * 4950) * 100) / 100;
    const commission = Math.round(amount * 0.025 * 100) / 100;
    const gatewayFee = Math.round(amount * 0.015 * 100) / 100;
    const roll = random();
    const status: AttemptSpec["status"] = roll < 0.91 ? "SUCCEEDED" : roll < 0.95 ? "FAILED" : roll < 0.97 ? "EXPIRED" : roll < 0.985 ? "CANCELLED" : roll < 0.995 ? "UNKNOWN" : "BLOCKED";
    const refund = status === "SUCCEEDED" && random() < 0.025 ? (random() < 0.6 ? "FULL" : "PARTIAL") : undefined;
    const dispute = status === "SUCCEEDED" && !refund && random() < 0.004 ? (random() < 0.6 ? "LOST" : "WON") : undefined;
    specs.push({ index, date, merchant, route, amount, commission, gatewayFee, status, refund, dispute });
  }
  specs.sort((left, right) => left.date.getTime() - right.date.getTime());
  counts.attempts = specs.length;

  const journal: JournalBatch = { entries: [], lines: [] };
  const adjustments: Prisma.AdjustmentCreateManyInput[] = [];
  const disputes: Prisma.DisputeCreateManyInput[] = [];
  const cashouts: Prisma.CashoutRequestCreateManyInput[] = [];
  const operatorCases: Prisma.OperatorCaseCreateManyInput[] = [];
  const attempts: Prisma.PaymentAttemptCreateManyInput[] = [];
  const links: Prisma.PaymentLinkCreateManyInput[] = [];
  const groups: Prisma.AttemptGroupCreateManyInput[] = [];
  const settlements = new Map<string, { amount: number; fee: number; merchantId: string; gatewayId: string; month: string }>();
  const disputeAdjustments: Array<{ disputeId: string; adjustmentId: string }> = [];
  let journalSequence = 0;

  const materialize = (
    template: ReturnType<typeof buildLedgerTemplate>,
    refId: string,
    date: Date,
    merchantWalletId: string,
  ): string | null => {
    const entryId = syntheticId(config.namespace, "je", ++journalSequence);
    const lines: Prisma.JournalLineCreateManyInput[] = [];
    for (const [index, line] of template.lines.entries()) {
      const type = String(line.account.accountType);
      const glAccountId = type === "MERCHANT_WALLET"
        ? merchantWalletId
        : platformAccountIds.get(type) ?? platformAccount(type);
      lines.push({
        id: `${entryId}_l${index}`,
        entryId,
        glAccountId,
        direction: line.direction as never,
        amount: dec(line.amount.toString()),
        createdAt: date,
        updatedAt: date,
      });
    }
    journal.entries.push({
      id: entryId,
      refType: template.refType as never,
      refId,
      description: template.description,
      createdAt: date,
      updatedAt: date,
    });
    journal.lines.push(...lines);
    return entryId;
  };

  for (const spec of specs) {
    const linkId = syntheticId(config.namespace, "lnk", spec.index + 1);
    const groupId = syntheticId(config.namespace, "grp", spec.index + 1);
    const attemptId = syntheticId(config.namespace, "att", spec.index + 1);
    const reference = syntheticReference(config.namespace, "PA", spec.index + 1);
    const finalStatus = spec.dispute ? "DISPUTED" : spec.refund === "FULL" ? "REFUNDED" : spec.refund === "PARTIAL" ? "PARTIALLY_REFUNDED" : spec.status;
    const netMerchant = Math.round((spec.amount - spec.commission) * 100) / 100;
    let ledgerEntryId: string | undefined;
    if (spec.status === "SUCCEEDED") {
      const ownership = spec.route.gatewayKind === "INTERNAL" ? "INTERNAL" : spec.route.settlementTarget === "MERCHANT_DIRECT" ? "MERCHANT_DIRECT" : "PLATFORM_CLEARING";
      const template = buildPaymentConfirmationTemplate({
        ownershipMode: ownership,
        amount: spec.amount.toFixed(4),
        commissionAmount: spec.commission.toFixed(4),
        gatewayFeeAmount: spec.gatewayFee.toFixed(4),
        merchantAmount: netMerchant.toFixed(4),
        feeBearer: "MERCHANT_ABSORBS",
        feeAccrual: ownership === "PLATFORM_CLEARING",
      });
      ledgerEntryId = materialize(template, attemptId, spec.date, spec.merchant.glAccountId) ?? undefined;
      if (ownership !== "MERCHANT_DIRECT") {
        spec.merchant.balance += netMerchant;
      }
      if (ownership === "PLATFORM_CLEARING") {
        const month = spec.date.toISOString().slice(0, 7);
        const key = `${spec.route.gatewayId}:${month}`;
        const current = settlements.get(key) ?? { amount: 0, fee: 0, merchantId: spec.merchant.id, gatewayId: spec.route.gatewayId, month };
        current.amount += spec.amount;
        current.fee += spec.gatewayFee;
        settlements.set(key, current);
      }
    }

    if (spec.refund) {
      const refundAmount = spec.refund === "FULL" ? spec.amount : Math.round(spec.amount * 0.4 * 100) / 100;
      const refundCommission = spec.refund === "FULL" ? spec.commission : Math.round(spec.commission * 0.4 * 100) / 100;
      const refundMerchant = Math.round((refundAmount - refundCommission) * 100) / 100;
      const adjustmentId = syntheticId(config.namespace, "adj", spec.index + 1);
      const entryId = materialize(
        buildLedgerTemplate("FULL_REFUND", {
          amount: refundAmount.toFixed(4),
          commissionAmount: refundCommission.toFixed(4),
          merchantAmount: refundMerchant.toFixed(4),
        }),
        adjustmentId,
        new Date(spec.date.getTime() + Math.floor((5 + random() * 25) * DAY)),
        spec.merchant.glAccountId,
      );
      spec.merchant.balance -= refundMerchant;
      adjustments.push({
        id: adjustmentId,
        type: "REFUND",
        targetGlAccountId: platformAccount("TREASURY"),
        sourceAttemptId: attemptId,
        draftedBySystem: false,
        amount: dec(refundAmount),
        reverseCommission: true,
        reason: "Synthetic customer refund",
        state: "EXECUTED",
        journalEntryId: entryId,
        createdAt: new Date(spec.date.getTime() + Math.floor((5 + random() * 25) * DAY)),
        updatedAt: new Date(spec.date.getTime() + Math.floor((5 + random() * 25) * DAY)),
      });
    }

    if (spec.dispute) {
      const disputeId = syntheticId(config.namespace, "dsp", spec.index + 1);
      const adjustmentId = syntheticId(config.namespace, "adj", spec.index + 1 + config.attempts);
      const disputeDate = new Date(spec.date.getTime() + Math.floor((10 + random() * 50) * DAY));
      const entryId = materialize(
        buildLedgerTemplate("CHARGEBACK_RESERVE_AND_LOST", {
          amount: spec.amount.toFixed(4),
          commissionAmount: spec.commission.toFixed(4),
          merchantAmount: netMerchant.toFixed(4),
          stage: spec.dispute === "LOST" ? "LOST" : "RESERVE",
        }),
        adjustmentId,
        disputeDate,
        spec.merchant.glAccountId,
      );
      if (spec.dispute === "LOST") spec.merchant.balance -= netMerchant;
      disputes.push({
        id: disputeId,
        attemptId,
        gatewayId: spec.route.gatewayId,
        railId: spec.route.railId,
        externalDisputeRef: `SYNTH-CB-${config.namespace}-${spec.index + 1}`,
        source: "WEBHOOK",
        reasonCode: "FRAUD",
        amount: dec(spec.amount),
        currency: CURRENCY,
        status: spec.dispute,
        openedAt: disputeDate,
        evidenceDueAt: new Date(disputeDate.getTime() + 14 * DAY),
        outcomeAt: new Date(disputeDate.getTime() + 21 * DAY),
      });
      disputeAdjustments.push({ disputeId, adjustmentId });
      adjustments.push({
        id: adjustmentId,
        type: "CHARGEBACK",
        targetGlAccountId: platformAccount("CHARGEBACK_RESERVE"),
        sourceAttemptId: attemptId,
        disputeId,
        draftedBySystem: true,
        amount: dec(spec.amount),
        reverseCommission: true,
        reason: `Synthetic chargeback ${spec.dispute}`,
        externalDisputeRef: `SYNTH-CB-${config.namespace}-${spec.index + 1}`,
        state: "EXECUTED",
        journalEntryId: entryId,
        createdAt: disputeDate,
        updatedAt: disputeDate,
      });
    }

    if (spec.status === "UNKNOWN" && random() < 0.35) {
      operatorCases.push({
        id: nextId("opc"),
        attemptId,
        kind: "UNKNOWN",
        priority: pick(random, ["P1", "P2", "P3"]),
        slaDueAt: new Date(spec.date.getTime() + 4 * 60 * 60 * 1000),
        state: pick(random, ["OPEN", "IN_PROGRESS", "RESOLVED"]),
        resolutionNotes: random() < 0.5 ? "Synthetic inquiry resolved" : null,
        createdAt: spec.date,
        updatedAt: spec.date,
      });
    }

    const createdAt = spec.date;
    links.push({
      id: linkId,
      key: `synth-${config.namespace}-${spec.index + 1}`,
      applicationId: spec.merchant.applicationId,
      walletId: spec.merchant.walletId,
      amount: dec(spec.amount),
      currency: CURRENCY,
      feeBearer: "MERCHANT_ABSORBS",
      useCount: 1,
      confirmedCount: spec.status === "SUCCEEDED" ? 1 : 0,
      activeLockedCount: 0,
      state: spec.status === "SUCCEEDED" ? "COMPLETED" : "EXPIRED",
      expiresAt: new Date(createdAt.getTime() + 30 * 60 * 1000),
      createdAt,
      updatedAt: createdAt,
    });
    groups.push({
      id: groupId,
      linkId,
      customerFingerprint: sha(`${config.namespace}:${spec.index}:${spec.merchant.id}`),
      successCount: spec.status === "SUCCEEDED" ? 1 : 0,
      createdAt,
      updatedAt: createdAt,
    });
    attempts.push({
      id: attemptId,
      reference,
      linkId,
      attemptGroupId: groupId,
      applicationId: spec.merchant.applicationId,
      merchantId: spec.merchant.id,
      railId: spec.route.railId,
      routeId: spec.route.routeId,
      credentialSetId: spec.route.credentialSetId,
      gatewayVersionId: spec.route.gatewayVersionId,
      commissionProfileId: spec.route.commissionProfileId,
      env: "LIVE",
      mode: pick(random, ["OTP_PULL", "QR_DISPLAY", "PUSH_APPROVAL", "REDIRECT"]),
      status: finalStatus as never,
      gatewayReference: spec.status === "SUCCEEDED" ? `GW-${reference}` : null,
      providerReference: spec.status === "SUCCEEDED" ? `PROV-${reference}` : null,
      requestedAmount: dec(spec.amount),
      surchargeAmount: dec(0),
      totalChargedAmount: dec(spec.amount),
      settledAmount: spec.status === "SUCCEEDED" ? dec(spec.amount) : null,
      gatewayFeeAmount: spec.status === "SUCCEEDED" ? dec(spec.gatewayFee) : null,
      platformCommissionAmount: spec.status === "SUCCEEDED" ? dec(spec.commission) : dec(0),
      netMerchantAmount: spec.status === "SUCCEEDED" ? dec(netMerchant) : dec(0),
      feeBearer: "MERCHANT_ABSORBS",
      settlementTarget: spec.route.settlementTarget as never,
      currency: CURRENCY,
      customerFieldsMasked: json({ phone: `+21891****${String(spec.index).slice(-3)}` }),
      publicOutputs: json({ synthetic: true }),
      contextCiphertext: "",
      pointOfNoReturn: spec.status === "SUCCEEDED",
      otpAttempts: spec.status === "FAILED" ? 1 : 0,
      clientIp: "10.0.0.10",
      userAgent: "synthetic-data-generator",
      expiresAt: new Date(createdAt.getTime() + 30 * 60 * 1000),
      graceExpiresAt: new Date(createdAt.getTime() + DAY),
      ledgerEntryId: ledgerEntryId ?? null,
      terminalAt: ["SUCCEEDED", "FAILED", "EXPIRED", "CANCELLED", "BLOCKED"].includes(spec.status) ? new Date(createdAt.getTime() + 60_000) : null,
      createdAt,
      updatedAt: createdAt,
    });
  }

  for (const settlement of settlements.values()) {
    const date = new Date(`${settlement.month}-01T02:00:00.000Z`);
    const settled = Math.max(0, settlement.amount - settlement.fee);
    materialize(
      buildLedgerTemplate("SETTLEMENT_SWEEP", {
        amount: settlement.amount.toFixed(4),
        gatewayFeeAmount: settlement.fee.toFixed(4),
        settledAmount: settled.toFixed(4),
      }),
      `SYNTH-SETTLE-${config.namespace}-${settlement.gatewayId}-${settlement.month}`,
      date,
      platformAccount("MERCHANT_WALLET"),
    );
  }

  for (const merchant of merchants) {
    if (merchant.balance <= 100) continue;
    const amount = Math.min(5000, Math.round(merchant.balance * 0.3 * 100) / 100);
    if (amount <= 0) continue;
    const date = new Date(end - Math.floor(random() * 180) * DAY);
    const cashoutId = nextId("cash");
    materialize(buildLedgerTemplate("CASHOUT", { amount: amount.toFixed(4) }), cashoutId, date, merchant.glAccountId);
    cashouts.push({
      id: cashoutId,
      merchantId: merchant.id,
      walletId: merchant.walletId,
      amount: dec(amount),
      destinationBankJson: json({ iban: `LY${String(100000000000000000000000 + Number(merchant.id.slice(-6)) || 0)}` }),
      state: "SUBTRACTED",
      createdAt: date,
      updatedAt: date,
    });
    merchant.balance -= amount;
  }

  for (const batch of chunk(journal.entries, 1000)) await client.journalEntry.createMany({ data: batch, skipDuplicates: true });
  for (const batch of chunk(journal.lines, 1000)) await client.journalLine.createMany({ data: batch, skipDuplicates: true });
  for (const batch of chunk(links, 1000)) await client.paymentLink.createMany({ data: batch, skipDuplicates: true });
  for (const batch of chunk(groups, 1000)) await client.attemptGroup.createMany({ data: batch, skipDuplicates: true });
  for (const batch of chunk(attempts, 1000)) await client.paymentAttempt.createMany({ data: batch, skipDuplicates: true });
  for (const batch of chunk(disputes, 500)) await client.dispute.createMany({ data: batch, skipDuplicates: true });
  for (const batch of chunk(adjustments, 500)) await client.adjustment.createMany({ data: batch, skipDuplicates: true });
  for (const link of disputeAdjustments) {
    await client.dispute.update({ where: { id: link.disputeId }, data: { adjustmentId: link.adjustmentId } });
  }
  for (const batch of chunk(cashouts, 500)) await client.cashoutRequest.createMany({ data: batch, skipDuplicates: true });
  for (const batch of chunk(operatorCases, 500)) await client.operatorCase.createMany({ data: batch, skipDuplicates: true });

  counts.links = links.length;
  counts.attemptGroups = groups.length;
  counts.journalEntries = journal.entries.length;
  counts.journalLines = journal.lines.length;
  counts.adjustments = adjustments.length;
  counts.disputes = disputes.length;
  counts.cashouts = cashouts.length;
  counts.operatorCases = operatorCases.length;

  // Reconciliation history: one source per gateway and monthly runs.
  const gateways = [...new Set(catalog.routes.map((route) => route.gatewayId))];
  const statementSourceIds = new Map<string, string>();
  for (const gatewayId of gateways) {
    const sourceId = nextId("src");
    statementSourceIds.set(gatewayId, sourceId);
    await client.statementSource.create({
      data: {
        id: sourceId,
        gatewayId,
        type: "UPLOAD",
        scheduleCron: "0 2 * * *",
        parserConfig: json({ fileType: "CSV", delimiter: ",", hasHeader: true }),
        settlementLagDays: 1,
      },
    });
  }
  let reconciliationRuns = 0;
  let reconciliationItems = 0;
  const sampleAttempts = attempts.filter((attempt) => attempt.status === "SUCCEEDED").slice(-200);
  const endDate = new Date(end);
  for (let monthIndex = 0; monthIndex < Math.min(12, config.years * 12); monthIndex += 1) {
    const monthDate = new Date(Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth() - monthIndex, 1));
    const month = monthDate.toISOString().slice(0, 7);
    for (const gatewayId of gateways) {
      const sourceId = statementSourceIds.get(gatewayId);
      if (!sourceId) continue;
      const runId = nextId("run");
      const windowStart = new Date(`${month}-01T00:00:00.000Z`);
      const windowEnd = new Date(windowStart.getTime() + 30 * DAY);
      await client.reconciliationRun.create({
        data: {
          id: runId,
          statementSourceId: sourceId,
          windowStart,
          windowEnd,
          fileHash: sha(`${config.namespace}:${gatewayId}:${month}`),
          statsJson: json({ synthetic: true, matched: 0, mismatch: 0 }),
          fileName: `${config.namespace}-${gatewayId}-${month}.csv`,
          fileContent: Buffer.from(`reference,amount\nSYNTH-${month},0.0000\n`),
          ingestedAt: windowEnd,
          createdAt: windowEnd,
          updatedAt: windowEnd,
        },
      });
      reconciliationRuns += 1;
      const items = sampleAttempts.slice(0, 10).map((attempt, index) => ({
        id: nextId("ritem"),
        runId,
        attemptId: attempt.id as string,
        ourReference: String(attempt.reference),
        providerReference: String(attempt.providerReference ?? attempt.reference),
        statementAmount: attempt.totalChargedAmount as Prisma.Decimal,
        statementFee: attempt.gatewayFeeAmount as Prisma.Decimal ?? dec(0),
        result: (index === 0 && random() < 0.15 ? "AMOUNT_MISMATCH" : "MATCHED") as never,
        createdAt: windowEnd,
        updatedAt: windowEnd,
      }));
      if (items.length > 0) {
        await client.reconciliationItem.createMany({ data: items, skipDuplicates: true });
        reconciliationItems += items.length;
      }
    }
  }
  counts.reconciliationRuns = reconciliationRuns;
  counts.reconciliationItems = reconciliationItems;

  // AML history.
  let amlScreenings = 0;
  let amlCases = 0;
  let regulatoryReports = 0;
  for (const merchant of merchants.slice(0, Math.max(1, Math.ceil(merchants.length * 0.2)))) {
    const screeningId = nextId("scr");
    const requestedAt = new Date(merchant.activatedAt.getTime() - 3 * DAY);
    await client.amlScreening.create({
      data: {
        id: screeningId,
        subjectType: "MERCHANT",
        subjectId: merchant.id,
        trigger: "ONBOARDING",
        providerCode: "internal-watchlist",
        listVersionsJson: json({ version: "internal-v1" }),
        inputHash: sha(`${merchant.id}:screen`),
        result: random() < 0.15 ? "POTENTIAL_MATCH" : "CLEAR",
        matchCount: random() < 0.15 ? 1 : 0,
        highestScore: random() < 0.15 ? dec(82.5) : null,
        requestedAt,
        completedAt: new Date(requestedAt.getTime() + 5000),
        createdAt: requestedAt,
        updatedAt: requestedAt,
      },
    });
    amlScreenings += 1;
    if (random() < 0.35) {
      const caseId = nextId("amlc");
      await client.amlCase.create({
        data: {
          id: caseId,
          subjectType: "MERCHANT",
          subjectId: merchant.id,
          triggerReason: "Synthetic periodic review",
          severity: pick(random, ["LOW", "MEDIUM", "HIGH"]),
          severityInputsJson: json({ synthetic: true }),
          screeningId,
          status: pick(random, ["OPEN", "IN_REVIEW", "RELEASED"]),
          slaDueAt: new Date(requestedAt.getTime() + 5 * DAY),
          assignedReviewerId: pick(random, catalog.adminIds),
          reviewerNotes: "Synthetic AML case",
          createdAt: requestedAt,
          updatedAt: requestedAt,
        },
      });
      amlCases += 1;
      if (random() < 0.25) {
        const payload = JSON.stringify({ caseId, synthetic: true, amount: "0.0000" });
        await client.regulatoryReport.create({
          data: {
            id: nextId("rep"),
            reportType: pick(random, ["LARGE_TRANSACTION", "SUSPICIOUS_ACTIVITY", "PERIODIC_RETURN"]),
            authority: "CBL",
            subjectType: "AML_CASE",
            subjectId: caseId,
            amlCaseId: caseId,
            periodStart: new Date(requestedAt.getTime() - 30 * DAY),
            periodEnd: requestedAt,
            status: pick(random, ["DRAFT", "SUBMITTED", "ACKNOWLEDGED"]),
            payloadCiphertext: await reportingCipher.encrypt(payload),
            payloadSha256: sha(payload),
            submissionRef: `SYNTH-REP-${caseId}`,
            submittedAt: requestedAt,
            confidential: true,
            createdAt: requestedAt,
            updatedAt: requestedAt,
          },
        });
        regulatoryReports += 1;
      }
    }
  }
  counts.amlScreenings = amlScreenings;
  counts.amlCases = amlCases;
  counts.regulatoryReports = regulatoryReports;

  // Audit, change log, approvals and notifications.
  const actorId = catalog.adminIds[0]!;
  let auditLogs = 0;
  let detailChanges = 0;
  let notifications = 0;
  let approvals = 0;
  for (const attempt of attempts.slice(-500)) {
    await client.auditLog.create({
      data: {
        id: nextId("aud"),
        actorId,
        role: "SYSTEM",
        action: "SYNTHETIC_PAYMENT",
        entityType: "PAYMENT_ATTEMPT",
        entityId: String(attempt.id),
        beforeJson: json({ status: "CREATED" }),
        afterJson: json({ status: attempt.status }),
        createdAt: attempt.createdAt as Date,
        updatedAt: attempt.createdAt as Date,
      },
    });
    auditLogs += 1;
  }
  for (const merchant of merchants.slice(0, Math.min(50, merchants.length))) {
    const date = new Date(end - Math.floor(random() * 365) * DAY);
    await client.detailChangeLog.create({
      data: {
        id: nextId("dcl"),
        actorId,
        merchantId: merchant.id,
        entityType: "MERCHANT",
        entityId: merchant.id,
        fieldName: "tradeName",
        oldValue: merchant.tradeName,
        newValue: `${merchant.tradeName} Updated`,
        source: "ADMIN",
        requestId: `SYNTH-REQ-${merchant.id}`,
        createdAt: date,
        updatedAt: date,
      },
    });
    detailChanges += 1;
    if (random() < 0.3) {
      await client.notification.create({
        data: {
          id: nextId("ntf"),
          eventId: `SYNTH-EVT-${merchant.id}-${date.getTime()}`,
          recipientMerchantId: merchant.id,
          addressMasked: merchant.email.slice(-8),
          addressCiphertext: await vault.encryptSecret(merchant.email, "notification"),
          templateCode: "PAYMENT_SUCCEEDED",
          channel: "EMAIL",
          lang: pick(random, ["AR", "EN"]),
          payloadJson: json({ synthetic: true, amount: "100.0000" }),
          status: pick(random, ["SENT", "DELIVERED", "FAILED"]),
          attempts: 1,
          nextAttemptAt: null,
          createdAt: date,
          updatedAt: date,
        },
      });
      notifications += 1;
    }
    if (random() < 0.2) {
      await client.approvalRequest.create({
        data: {
          id: nextId("apr"),
          subjectType: "MERCHANT",
          subjectId: merchant.id,
          payloadDiffJson: json([{ op: "replace", path: "/tradeName", value: `${merchant.tradeName} Proposed` }]),
          mode: "STANDARD",
          makerUserId: actorId,
          state: pick(random, ["PENDING_REVIEW", "APPROVED", "REJECTED"]),
          expiresAt: new Date(date.getTime() + 7 * DAY),
          createdAt: date,
          updatedAt: date,
        },
      });
      approvals += 1;
    }
  }
  counts.auditLogs = auditLogs;
  counts.detailChanges = detailChanges;
  counts.notifications = notifications;
  counts.approvals = approvals;

  // Gateway health samples for the latest 30 days.
  let healthSamples = 0;
  for (const route of catalog.routes) {
    for (let day = 0; day < 30; day += 1) {
      const windowStart = new Date(end - day * DAY);
      await client.gatewayHealthSample.create({
        data: {
          id: nextId("gh"),
          routeId: route.routeId,
          windowStart,
          definitiveFailures: Math.floor(random() * 4),
          ambiguousUnknowns: Math.floor(random() * 2),
          rateLimits429: Math.floor(random() * 2),
          successes: 50 + Math.floor(random() * 500),
          p50Ms: 120 + Math.floor(random() * 80),
          p95Ms: 400 + Math.floor(random() * 300),
          p99Ms: 800 + Math.floor(random() * 700),
          createdAt: windowStart,
          updatedAt: windowStart,
        },
      });
      healthSamples += 1;
    }
  }
  counts.gatewayHealthSamples = healthSamples;

  const invariant = await new InvariantVerifier(client as never).verify();
  if (!invariant.ok) {
    await writeManifest({
      generatorVersion: GENERATOR_VERSION,
      profile: config.profile,
      namespace: config.namespace,
      seed: config.seed,
      years: config.years,
      endDate: config.endDate,
      status: "FAILED",
      lastCompletedBucket: null,
      counts,
      ledgerDrift: invariant.drift.toFixed(4),
      startedAt,
      completedAt: new Date().toISOString(),
    });
    throw new Error(`synthetic dataset failed the ledger invariant: drift ${invariant.drift}`);
  }

  await writeManifest({
    generatorVersion: GENERATOR_VERSION,
    profile: config.profile,
    namespace: config.namespace,
    seed: config.seed,
    years: config.years,
    endDate: config.endDate,
    status: "COMPLETE",
    lastCompletedBucket: config.endDate.slice(0, 7),
    counts,
    ledgerDrift: invariant.drift.toFixed(4),
    startedAt,
    completedAt: new Date().toISOString(),
  });
  console.log(`Synthetic dataset '${config.namespace}' complete.`);
  console.log(JSON.stringify({ counts, ledgerDrift: invariant.drift }, null, 2));
};

const main = async (): Promise<void> => {
  const parsed = parseSyntheticConfig(process.argv.slice(2));
  if (!parsed.ok) {
    if (parsed.error === "help") {
      console.log(USAGE);
      return;
    }
    console.error(`seed-synthetic: ${parsed.error}\n\n${USAGE}`);
    process.exit(1);
  }
  if ((process.env.SYNTHETIC_DATA_ENABLED ?? "false").toLowerCase() !== "true" && !parsed.config.verify) {
    throw new Error("SYNTHETIC_DATA_ENABLED is not true; set it to opt in");
  }
  const guard = syntheticGuardError(process.env.NODE_ENV, parsed.config.allowProduction);
  if (guard) throw new Error(guard);
  await run(parsed.config);
};

if (import.meta.main) {
  main()
    .catch((error: unknown) => {
      console.error(`seed-synthetic failed: ${(error as Error).message}`);
      process.exit(1);
    })
    .finally(() => client.$disconnect().catch(() => undefined));
}
