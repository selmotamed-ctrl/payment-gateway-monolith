import type { SeederContext } from "../context";
import {
  addDays, chance, createWalletAccount, formatMoney, randomAddress, randomBank, randomBusinessName,
  randomCategory, randomName, randomPhone, randomTaxId, sha256Like,
} from "../builders";

const MERCHANT_STATUS_WEIGHTS = {
  ACTIVE: 62,
  PENDING: 12,
  SUSPENDED: 11,
  REJECTED: 9,
  CLOSED: 6,
} as const;

const JOIN_STATUS_WEIGHTS = {
  APPROVED: 58,
  REJECTED: 11,
  IN_REVIEW: 8,
  INFO_REQUESTED: 6,
  PENDING_CHECKER: 5,
  SUBMITTED: 4,
  DRAFT: 3,
  WITHDRAWN: 2,
  EXPIRED: 3,
} as const;

const KYB_DOC_TYPES = [
  "COMMERCIAL_REGISTRY", "TAX_CERTIFICATE", "ARTICLES_OF_ASSOCIATION", "OWNER_ID",
  "SIGNATORY_ID", "PROOF_OF_ADDRESS", "BANK_LETTER", "SECTOR_LICENSE",
] as const;

const OWNER_ROLES = ["OWNER", "DIRECTOR", "SIGNATORY", "CONTROLLER"] as const;

const SUSPENSION_REASONS = ["AML", "FRAUD", "KYB_EXPIRED", "COMMISSION_CEILING", "MERCHANT_REQUEST", "OTHER"] as const;
const REJECTION_REASONS = ["UNVERIFIABLE_BUSINESS", "INCOMPLETE_DOCUMENTS", "PROHIBITED_ACTIVITY", "POLICY"] as const;

export const generateMerchantCohort = (ctx: SeederContext): void => {
  const total = ctx.config.volumes.merchants;
  const start = ctx.timeline.start;
  const end = ctx.timeline.end;
  const spanDays = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86_400_000));

  // The three deliberate duplicate-document pairs (compliance alert showcase).
  const duplicateHashes = Array.from({ length: 3 }, (_, index) => sha256Like(ctx, `duplicate-doc-${index}`));
  const duplicateMerchantIndexes = [3, 11, 23];

  for (let index = 0; index < total; index += 1) {
    const status = ctx.rng.weighted(MERCHANT_STATUS_WEIGHTS);
    const recent = status === "PENDING";
    const createdAt = recent
      ? addDays(end, -ctx.rng.int(0, 20))
      : addDays(start, ctx.rng.int(0, Math.max(1, spanDays - 20)));
    const business = randomBusinessName(ctx);
    const name = randomName(ctx);
    const address = randomAddress(ctx);
    const city = ctx.rng.pick(["Tripoli", "Benghazi", "Misrata", "Zawiya", "Sabha", "Tobruk"]);
    const merchantId = ctx.nextId("merchant");
    const kybStatus = status === "ACTIVE" || status === "SUSPENDED" || status === "CLOSED"
      ? "VERIFIED"
      : status === "REJECTED" ? "REJECTED" : "PENDING";
    const activatedAt = kybStatus === "VERIFIED" ? addDays(createdAt, ctx.rng.int(1, 20)) : null;
    const suspendedAt = status === "SUSPENDED" ? addDays(end, -ctx.rng.int(0, 400)) : null;
    const closedAt = status === "CLOSED" ? addDays(end, -ctx.rng.int(30, 300)) : null;

    ctx.dataset.merchants.push({
      id: merchantId,
      createdAt,
      updatedAt: suspendedAt ?? closedAt ?? activatedAt ?? createdAt,
      legalName: business.en,
      tradeName: business.ar,
      taxId: randomTaxId(ctx),
      registrationNo: `${ctx.rng.int(100000, 999999)}-${city.slice(0, 2).toUpperCase()}`,
      businessCategory: randomCategory(ctx).en,
      status,
      kybStatus,
      riskTier: ctx.rng.weighted({ LOW: 25, STANDARD: 60, HIGH: 15 }),
      onboardingChannel: ctx.rng.chance(65) ? "SELF_SERVICE" : "ADMIN_ASSISTED",
      country: "LY",
      contactPhone: randomPhone(ctx),
      contactEmail: `${business.en.toLowerCase().replaceAll(/[^a-z0-9]+/g, ".")}.${index}@${ctx.config.namespace}.ly`,
      activatedAt,
      suspendedAt,
      suspensionReasonCode: status === "SUSPENDED" ? ctx.rng.pick(SUSPENSION_REASONS) : null,
      closedAt,
      commissionReceivableCeiling: ctx.rng.chance(10) ? ctx.rng.decimal(500, 5000, 4) : null,
      negativeBalanceCeiling: ctx.rng.chance(12) ? ctx.rng.decimal(100, 500, 4) : "0.0000",
      payoutBankDetailsJson: {
        bank: randomBank(ctx).en,
        account: `LY${ctx.rng.int(10, 99)}${ctx.rng.int(1000000000, 9999999999)}`,
        holder: business.en,
        address: address.en,
      },
    });

    // Wallet + GL account for every merchant that reached onboarding.
    const walletAt = activatedAt ?? createdAt;
    const walletGlId = createWalletAccount(ctx, merchantId, walletAt);
    const walletId = ctx.nextId("wallet");
    ctx.dataset.wallets.push({
      id: walletId,
      createdAt: walletAt,
      updatedAt: closedAt ?? walletAt,
      merchantId,
      glAccountId: walletGlId,
      currency: "LYD",
      status: status === "SUSPENDED" && ctx.rng.chance(45) ? "FROZEN" : status === "CLOSED" ? "CLOSED" : status === "PENDING" ? "PENDING" : "ACTIVE",
    });

    // Applications (1-3) and their merchant users.
    const appCount = ctx.rng.int(1, 3);
    const appIds: string[] = [];
    for (let appIndex = 0; appIndex < appCount; appIndex += 1) {
      const applicationId = ctx.nextId("application");
      appIds.push(applicationId);
      ctx.dataset.applications.push({
        id: applicationId,
        createdAt: addDays(walletAt, ctx.rng.int(0, 30)),
        updatedAt: walletAt,
        merchantId,
        name: `${business.en} ${appIndex + 1}`,
        businessUseDescription: `${randomCategory(ctx).en} online checkout and in-store collection.`,
        expectedMonthlyVolume: ctx.rng.decimal(2000, 250000, 4),
        assignedWalletId: walletId,
        railWhitelist: null,
        redirectDomainAllowlist: [`https://${business.en.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}.${ctx.config.namespace}.ly`],
        status: status === "ACTIVE" ? (ctx.rng.chance(78) ? "ACTIVE" : ctx.rng.chance(50) ? "PENDING" : "DRAFT")
          : status === "SUSPENDED" ? (ctx.rng.chance(60) ? "SUSPENDED" : "ACTIVE")
            : status === "CLOSED" ? "CLOSED" : "DRAFT",
      });
    }

    const userCount = ctx.rng.int(1, 4);
    for (let userIndex = 0; userIndex < userCount; userIndex += 1) {
      const userId = ctx.nextId("user");
      const role = userIndex === 0 ? "MERCHANT_ADMIN" : ctx.rng.chance(60) ? "MERCHANT_STAFF" : "MERCHANT_CASHIER";
      const email = `merchant.${index}.${userIndex}@${ctx.config.namespace}.ly`;
      ctx.dataset.users.push({
        id: userId,
        createdAt: addDays(createdAt, ctx.rng.int(0, 10)),
        updatedAt: ctx.timeline.end,
        merchantId,
        email,
        phone: randomPhone(ctx),
        passwordHash: null,
        role,
        authoritiesMap: role === "MERCHANT_ADMIN" ? { app: ["read", "write"], payment: ["read", "refund"] } : { payment: ["read"] },
        appScopeIds: role === "MERCHANT_STAFF" ? appIds : null,
        isMaker: false,
        isChecker: false,
        mfaRequired: role === "MERCHANT_ADMIN",
        mfaSecretCiphertext: null,
        status: ctx.rng.chance(6) ? "INVITED" : ctx.rng.chance(3) ? "SUSPENDED" : "ACTIVE",
        academyProgressJson: null,
      });
      ctx.dataset.userIdentities.push({
        id: ctx.nextId("identity"),
        createdAt,
        updatedAt: createdAt,
        userId,
        kind: ctx.rng.chance(70) ? "EMAIL" : "PHONE",
        identifierNormalized: ctx.rng.chance(70) ? email : randomPhone(ctx),
        providerSubject: null,
        verifiedAt: ctx.rng.chance(85) ? createdAt : null,
        isPrimary: true,
        lastUsedAt: ctx.timeline.end,
      });
    }

    // Join request (one per merchant) with the full status range.
    const joinStatus = status === "ACTIVE" || status === "SUSPENDED" || status === "CLOSED"
      ? "APPROVED"
      : status === "REJECTED"
        ? "REJECTED"
        : ctx.rng.weighted(JOIN_STATUS_WEIGHTS);
    const joinRequestId = ctx.nextId("join");
    const submittedBy = ctx.dataset.users.find((user) => user.merchantId === merchantId && user.role === "MERCHANT_ADMIN");
    ctx.dataset.joinRequests.push({
      id: joinRequestId,
      createdAt,
      updatedAt: ctx.timeline.end,
      merchantId,
      submittedByUserId: submittedBy?.id ?? ctx.refs.adminUsers[0]?.id ?? ctx.nextId("user"),
      status: joinStatus,
      onboardingChannel: ctx.rng.chance(65) ? "SELF_SERVICE" : "ADMIN_ASSISTED",
      submittedAt: joinStatus === "DRAFT" ? null : addDays(createdAt, 1),
      assignedReviewerId: ["IN_REVIEW", "INFO_REQUESTED", "PENDING_CHECKER", "APPROVED", "REJECTED"].includes(joinStatus)
        ? ctx.rng.pick(ctx.refs.adminUsers.filter((user) => user.role === "OPERATOR" || user.role === "COMPLIANCE"))?.id ?? null
        : null,
      slaDueAt: addDays(createdAt, ctx.rng.int(3, 14)),
      screeningId: null,
      proposedRiskTier: ctx.rng.weighted({ LOW: 30, STANDARD: 55, HIGH: 15 }),
      fourEyesRequired: ctx.rng.chance(40),
      fourEyesReasons: ctx.rng.chance(40) ? ["HIGH_RISK", "PEP_MATCH"] : null,
      decision: joinStatus === "APPROVED" ? "APPROVED" : joinStatus === "REJECTED" ? "REJECTED" : null,
      decisionReasonCode: joinStatus === "REJECTED" ? ctx.rng.pick(REJECTION_REASONS) : null,
      decisionNotes: joinStatus === "INFO_REQUESTED" ? "Please re-upload a clearer tax certificate." : null,
      infoRequestJson: joinStatus === "INFO_REQUESTED" ? { fields: ["tax_certificate"] } : null,
      resubmissionOfId: null,
      approvalRequestId: null,
    });

    // KYB documents (4-7) with the four statuses and expiring/duplicate cases.
    const docCount = ctx.rng.int(4, 7);
    for (let docIndex = 0; docIndex < docCount; docIndex += 1) {
      const docType = KYB_DOC_TYPES[docIndex % KYB_DOC_TYPES.length]!;
      const isDuplicatePair = index === duplicateMerchantIndexes[0] || index === duplicateMerchantIndexes[1] || index === duplicateMerchantIndexes[2];
      const docStatus = kybStatus === "VERIFIED"
        ? (ctx.rng.chance(90) ? "ACCEPTED" : ctx.rng.chance(50) ? "EXPIRED" : "REJECTED")
        : ctx.rng.weighted({ UPLOADED: 45, ACCEPTED: 30, REJECTED: 15, EXPIRED: 10 });
      const expiresOn = addDays(ctx.timeline.end, ctx.rng.chance(6) ? ctx.rng.int(1, 30) : -ctx.rng.int(0, 900));
      ctx.dataset.kybDocuments.push({
        id: ctx.nextId("kyb-doc"),
        createdAt: addDays(createdAt, ctx.rng.int(0, 20)),
        updatedAt: ctx.timeline.end,
        merchantId,
        joinRequestId,
        subjectType: "MERCHANT",
        subjectId: merchantId,
        docType,
        storageKey: `synthetic/${ctx.config.namespace}/merchants/${merchantId}/${docType}.pdf`,
        sha256: isDuplicatePair && docIndex === 0
          ? duplicateHashes[duplicateMerchantIndexes.indexOf(index)]!
          : sha256Like(ctx, `${merchantId}:${docType}:${docIndex}`),
        mime: "application/pdf",
        sizeBytes: ctx.rng.int(80_000, 3_500_000),
        avStatus: ctx.rng.chance(2) ? "INFECTED" : ctx.rng.chance(8) ? "PENDING" : "CLEAN",
        status: docStatus,
        reviewedById: docStatus === "ACCEPTED" || docStatus === "REJECTED"
          ? ctx.rng.pick(ctx.refs.adminUsers.filter((user) => user.role === "COMPLIANCE" || user.role === "OPERATOR"))?.id ?? null
          : null,
        reviewedAt: docStatus === "ACCEPTED" || docStatus === "REJECTED" ? addDays(createdAt, ctx.rng.int(1, 15)) : null,
        expiresOn,
        rejectionReasonCode: docStatus === "REJECTED" ? "BLURRY_OR_EXPIRED" : null,
      });
    }

    // Beneficial owners (1-4), including historical owner changes.
    const ownerCount = ctx.rng.int(1, 4);
    for (let ownerIndex = 0; ownerIndex < ownerCount; ownerIndex += 1) {
      const ownerName = randomName(ctx);
      const active = !(ownerIndex === ownerCount - 1 && ctx.rng.chance(25));
      ctx.dataset.beneficialOwners.push({
        id: ctx.nextId("owner"),
        createdAt,
        updatedAt: ctx.timeline.end,
        merchantId,
        fullNameAr: ownerName.ar,
        fullNameEn: ownerName.en,
        nationalIdCiphertext: Buffer.from(`NID-${merchantId}-${ownerIndex}`).toString("base64"),
        dateOfBirth: addDays(ctx.timeline.start, -ctx.rng.int(9000, 18000)),
        nationality: ctx.rng.chance(88) ? "LY" : ctx.rng.pick(["EG", "TN", "TR"]),
        ownershipPercent: ownerIndex === 0 ? ctx.rng.int(35, 90).toFixed(2) : ctx.rng.int(1, 30).toFixed(2),
        role: ownerIndex === 0 ? "OWNER" : ctx.rng.pick(OWNER_ROLES),
        pepDeclared: ctx.rng.chance(4),
        screeningStatus: ctx.rng.chance(88) ? "CLEAR" : ctx.rng.chance(50) ? "POTENTIAL_MATCH" : "NOT_SCREENED",
        active,
        validFrom: createdAt,
        validTo: active ? null : addDays(ctx.timeline.end, -ctx.rng.int(30, 300)),
      });
    }

    // Commission profile (one per merchant).
    ctx.dataset.commissionProfiles.push({
      id: ctx.nextId("commission"),
      createdAt,
      updatedAt: createdAt,
      merchantId,
      applicationId: null,
      railCode: ctx.rng.pick(ctx.refs.rails).code,
      calcType: ctx.rng.chance(70) ? "PERCENTAGE" : ctx.rng.chance(50) ? "HYBRID" : "TIERED",
      flatFee: ctx.rng.decimal(0, 1, 4),
      percentageRate: ctx.rng.decimal(0.5, 3.5, 6),
      tiersJson: null,
      minFee: "0.0000",
      maxFee: ctx.rng.chance(30) ? ctx.rng.decimal(5, 50, 4) : null,
      feeBearerDefault: ctx.rng.weighted({ MERCHANT_ABSORBS: 70, PAYER_SURCHARGE: 20, SPLIT: 10 }),
      roundingMode: "NEAREST",
      effectiveFrom: createdAt,
      effectiveTo: null,
      version: 1,
      approvalRequestId: null,
      seedKey: `synthetic:${ctx.config.namespace}:commission:${merchantId}`,
    });

    // Merchant-owned credential sets for direct settlement.
    if ((status === "ACTIVE" || status === "SUSPENDED") && ctx.rng.chance(18)) {
      const gateway = ctx.rng.pick(ctx.refs.gateways);
      const env = ctx.rng.chance(70) ? "LIVE" : "SANDBOX";
      ctx.dataset.credentialSets.push({
        id: ctx.nextId("credential"),
        createdAt,
        updatedAt: ctx.timeline.end,
        gatewayId: gateway.id,
        env,
        ownerType: "MERCHANT",
        ownerMerchantId: merchantId,
        externalMerchantId: `MERCH-${merchantId}`,
        settlementTarget: "MERCHANT_DIRECT",
        entriesCiphertext: [],
        mtlsCertCiphertext: null,
        status: ctx.rng.weighted({ VERIFIED: 45, UNTESTED: 30, FAILING: 15, REVOKED: 10 }),
        lastVerifiedAt: ctx.rng.chance(60) ? addDays(ctx.timeline.end, -ctx.rng.int(1, 120)) : null,
        expiresAt: null,
      });
    }

    // Access tokens and POS terminals for a subset of applications.
    for (const applicationId of appIds) {
      if (ctx.rng.chance(35)) {
        const tokenId = ctx.nextId("token");
        const tokenHash = sha256Like(ctx, `token:${applicationId}`);
        ctx.dataset.accessTokens.push({
          id: tokenId,
          createdAt: addDays(createdAt, ctx.rng.int(0, 20)),
          updatedAt: ctx.timeline.end,
          merchantId,
          applicationId,
          name: "Default server key",
          tokenHash,
          lastFour: tokenHash.slice(-4),
          scopes: ["payments:write", "payments:read", "refunds:write"],
          ipWhitelistEnabled: ctx.rng.chance(40),
          revokedAt: ctx.rng.chance(10) ? addDays(ctx.timeline.end, -ctx.rng.int(1, 100)) : null,
          lastUsedAt: ctx.rng.chance(70) ? addDays(ctx.timeline.end, -ctx.rng.int(0, 10)) : null,
        });
        if (ctx.rng.chance(40)) {
          ctx.dataset.accessTokenIps.push({
            id: ctx.nextId("token-ip"),
            createdAt,
            updatedAt: createdAt,
            tokenId,
            cidr: `203.0.113.${ctx.rng.int(1, 250)}/32`,
          });
        }
      }
      if (ctx.rng.chance(22)) {
        const posId = ctx.nextId("pos");
        ctx.dataset.posTerminals.push({
          id: posId,
          createdAt: addDays(createdAt, ctx.rng.int(0, 30)),
          updatedAt: ctx.timeline.end,
          applicationId,
          name: `POS ${business.en.slice(0, 18)}`,
          location: address.en,
          status: ctx.rng.weighted({ ACTIVE: 70, INACTIVE: 20, BLOCKED: 10 }),
        });
        const screenCount = ctx.rng.int(1, 3);
        for (let screenIndex = 0; screenIndex < screenCount; screenIndex += 1) {
          const screenCode = `SCR-${ctx.config.namespace}-${posId.slice(-6)}-${screenIndex}`;
          ctx.dataset.posScreens.push({
            id: ctx.nextId("pos-screen"),
            createdAt,
            updatedAt: ctx.timeline.end,
            posId,
            screenCode,
            authTokenHash: sha256Like(ctx, `screen:${screenCode}`),
            realtimeRoomId: `room-${screenCode}`,
            lastActiveAt: ctx.rng.chance(50) ? addDays(ctx.timeline.end, -ctx.rng.int(0, 30)) : null,
          });
        }
      }
    }

    void name;
    void formatMoney;
  }
};
