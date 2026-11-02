import type { SeederContext } from "../context";
import {
  addDays, createWalletAccount, formatMoney, randomAddress, randomBank, randomBusinessName,
  randomCategory, randomName, randomPhone, randomTaxId, sha256Like,
} from "../builders";
import { Vault } from "../../../engine/crypto/Vault";
import { DEFAULT_KYB_REFRESH_POLICY, nextKybReviewAt, startOfUtcDay } from "../../../lib/kybReview";
import {
  JOIN_REQUEST_CHECKLIST_KEYS,
  nationalIdHash,
  payoutAccountHash,
  requiredDocumentsFromSetting,
} from "../../../lib/joinRequestOnboarding";

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

const previewPdf = (documentId: string): Buffer =>
  Buffer.from(
    `%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]>>endobj\ntrailer<</Size 4/Root 1 0 R>>\n% synthetic KYB preview ${documentId}\n%%EOF\n`,
    "utf8",
  );

export const generateMerchantCohort = async (ctx: SeederContext): Promise<void> => {
  const total = ctx.config.volumes.merchants;
  const start = ctx.timeline.start;
  const end = ctx.timeline.end;
  const spanDays = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86_400_000));
  const now = ctx.timeline.end;
  const today = startOfUtcDay(now);
  const vault = new Vault();

  let existingUploader: { id: string; createdAt: Date } | null = null;
  try {
    existingUploader = await ctx.prisma.user.findFirst({
      where: { merchantId: null },
      orderBy: { createdAt: "asc" },
      select: { id: true, createdAt: true },
    });
  } catch {
    existingUploader = null;
  }
  let uploaderId = existingUploader?.id ?? null;
  let uploaderAt = existingUploader?.createdAt?.getTime() ?? Number.POSITIVE_INFINITY;
  for (const user of ctx.dataset.users) {
    if (user.merchantId !== null) continue;
    const createdAt = new Date(user.createdAt as Date).getTime();
    if (createdAt < uploaderAt) {
      uploaderId = user.id;
      uploaderAt = createdAt;
    }
  }

  let requiredDocumentsSetting: { valueJson: unknown } | null = null;
  try {
    requiredDocumentsSetting = await ctx.prisma.platformSetting.findFirst({
      where: { key: "onboarding.required_documents" },
      orderBy: { version: "desc" },
      select: { valueJson: true },
    });
  } catch {
    requiredDocumentsSetting = null;
  }
  const requiredDocumentsFor = (businessCategory: string | null): string[] =>
    requiredDocumentsFromSetting(requiredDocumentsSetting?.valueJson, businessCategory);

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
    const address = randomAddress(ctx);
    const city = ctx.rng.pick(["Tripoli", "Benghazi", "Misrata", "Zawiya", "Sabha", "Tobruk"]);
    const merchantId = ctx.nextId("merchant");
    const kybStatus = status === "ACTIVE" || status === "SUSPENDED" || status === "CLOSED"
      ? "VERIFIED"
      : status === "REJECTED" ? "REJECTED" : "PENDING";
    const activatedAt = kybStatus === "VERIFIED" ? addDays(createdAt, ctx.rng.int(1, 20)) : null;
    const suspendedAt = status === "SUSPENDED" ? addDays(end, -ctx.rng.int(0, 400)) : null;
    const closedAt = status === "CLOSED" ? addDays(end, -ctx.rng.int(30, 300)) : null;

    const payoutBankDetails = {
      bank: randomBank(ctx).en,
      account: duplicateMerchantIndexes.includes(index)
        ? "LY8300000000000000000001"
        : `LY${ctx.rng.int(10, 99)}${ctx.rng.int(1000000000, 9999999999)}`,
      holder: business.en,
      address: address.en,
    };
    const businessCategory = randomCategory(ctx).en;
    const merchant = {
      id: merchantId,
      createdAt,
      updatedAt: suspendedAt ?? closedAt ?? activatedAt ?? createdAt,
      legalName: business.en,
      tradeName: business.ar,
      displayName: business.ar,
      logoUrl: null,
      supportEmail: `${business.en.toLowerCase().replaceAll(/[^a-z0-9]+/g, ".")}.${index}@${ctx.config.namespace}.ly`,
      supportPhone: randomPhone(ctx),
      taxId: randomTaxId(ctx),
      registrationNo: `${ctx.rng.int(100000, 999999)}-${city.slice(0, 2).toUpperCase()}`,
      businessCategory,
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
      suspensionNotes: status === "SUSPENDED" ? "Synthetic suspension awaiting the documented lifecycle review." : null,
      closedAt,
      closedReasonCode: status === "CLOSED" ? "BUSINESS_CLOSED" : null,
      closedNotes: status === "CLOSED" ? "Synthetic merchant closed after the relationship ended." : null,
      commissionReceivableCeiling: ctx.rng.chance(10) ? ctx.rng.decimal(500, 5000, 4) : null,
      negativeBalanceCeiling: ctx.rng.chance(12) ? ctx.rng.decimal(100, 500, 4) : "0.0000",
      payoutBankDetailsJson: payoutBankDetails,
      payoutAccountHash: payoutAccountHash(payoutBankDetails),
      nextKybReviewAt: null as Date | null,
    };
    ctx.dataset.merchants.push(merchant);

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
    const onboardingChannel = ctx.rng.chance(65) ? "SELF_SERVICE" : "ADMIN_ASSISTED";
    const completedChecklist = Object.fromEntries(JOIN_REQUEST_CHECKLIST_KEYS.map((key) => [key, true]));
    const partialChecklist = Object.fromEntries(
      JOIN_REQUEST_CHECKLIST_KEYS.map((key, checklistIndex) => [key, checklistIndex < 4]),
    );
    const infoRequestedAt = joinStatus === "INFO_REQUESTED" ? addDays(createdAt, 2) : null;
    ctx.dataset.joinRequests.push({
      id: joinRequestId,
      createdAt,
      updatedAt: ctx.timeline.end,
      merchantId,
      submittedByUserId: submittedBy?.id ?? ctx.refs.adminUsers[0]?.id ?? ctx.nextId("user"),
      status: joinStatus,
      onboardingChannel,
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
      infoRequestJson: joinStatus === "INFO_REQUESTED"
        ? [
            { field: "tax_certificate", message: "Please re-upload a clearer tax certificate." },
            { field: "payout_account", message: "Confirm the account holder matches the legal entity." },
          ]
        : null,
      profileJson: {
        legalName: business.en,
        tradeName: business.ar,
        country: "LY",
        businessCategory: ctx.rng.pick(["RETAIL", "ECOMMERCE", "SERVICES", "TRANSPORT", "EDUCATION"]),
        registrationNumber: `${ctx.rng.int(100000, 999999)}-${city.slice(0, 2).toUpperCase()}`,
        taxId: randomTaxId(ctx),
        registeredAddress: address.en,
        websiteUrl: `https://${business.en.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}.${ctx.config.namespace}.ly`,
        contactPhone: randomPhone(ctx),
        contactEmail: `${business.en.toLowerCase().replaceAll(/[^a-z0-9]+/g, ".")}.${index}@${ctx.config.namespace}.ly`,
        expectedMonthlyVolume: ctx.rng.decimal(5000, 400000, 4),
        currency: "LYD",
        businessUseDescription: `${business.en} collects online and in-store payments for ${randomCategory(ctx).en.toLowerCase()} customers.`,
        ...(onboardingChannel === "ADMIN_ASSISTED"
          ? { adminAssistedByUserId: ctx.rng.pick(ctx.refs.adminUsers)?.id ?? null }
          : {}),
      },
      reviewChecklistJson: ["IN_REVIEW", "INFO_REQUESTED", "PENDING_CHECKER"].includes(joinStatus)
        ? partialChecklist
        : ["APPROVED", "REJECTED"].includes(joinStatus)
          ? completedChecklist
          : null,
      duplicateFlagsJson: duplicateMerchantIndexes.includes(index)
        ? [{ type: "DUPLICATE_OR_RELATED", field: "payoutAccount" }]
        : [],
      slaPausedAt: infoRequestedAt,
      slaRemainingSeconds: infoRequestedAt ? 2 * 24 * 60 * 60 : null,
      lastScreenedAt: joinStatus === "DRAFT" ? null : addDays(createdAt, 1),
      resubmissionOfId: null,
      approvalRequestId: null,
    });

    // KYB documents (4-7) with the four statuses and expiring/duplicate cases.
    const docCount = ctx.rng.int(4, 7);
    const merchantDocuments: any[] = [];
    for (let docIndex = 0; docIndex < docCount; docIndex += 1) {
      const docType = KYB_DOC_TYPES[docIndex % KYB_DOC_TYPES.length]!;
      const isDuplicatePair = index === duplicateMerchantIndexes[0] || index === duplicateMerchantIndexes[1] || index === duplicateMerchantIndexes[2];
      const docStatus = kybStatus === "VERIFIED"
        ? (ctx.rng.chance(90) ? "ACCEPTED" : ctx.rng.chance(50) ? "EXPIRED" : "REJECTED")
        : ctx.rng.weighted({ UPLOADED: 45, ACCEPTED: 30, REJECTED: 15, EXPIRED: 10 });
      const expiresOn = addDays(ctx.timeline.end, ctx.rng.chance(6) ? ctx.rng.int(1, 30) : -ctx.rng.int(0, 900));
      const uploadedBy = ctx.rng.pick(ctx.refs.adminUsers.filter((user) => ["OPERATOR", "COMPLIANCE"].includes(user.role)));
      const documentId = ctx.nextId("kyb-doc");
      const pdf = previewPdf(documentId);
      const document = {
        id: documentId,
        createdAt: addDays(createdAt, ctx.rng.int(0, 20)),
        updatedAt: ctx.timeline.end,
        merchantId,
        joinRequestId,
        subjectType: "MERCHANT",
        subjectId: merchantId,
        docType,
        storageKey: `synthetic/${ctx.config.namespace}/merchants/${merchantId}/${docType}.pdf`,
        originalFileName: `${docType.toLowerCase()}.pdf`,
        contentCiphertext: await vault.encryptSecret(pdf.toString("base64"), "kyb-document"),
        sha256: isDuplicatePair && docIndex === 0
          ? duplicateHashes[duplicateMerchantIndexes.indexOf(index)]!
          : sha256Like(ctx, `${merchantId}:${docType}:${docIndex}`),
        mime: "application/pdf",
        sizeBytes: ctx.rng.int(80_000, 3_500_000),
        avStatus: ctx.rng.chance(2) ? "INFECTED" : ctx.rng.chance(8) ? "PENDING" : "CLEAN",
        status: docStatus,
        uploadedById: uploadedBy?.id ?? uploaderId,
        reviewedById: docStatus === "ACCEPTED" || docStatus === "REJECTED"
          ? ctx.rng.pick(ctx.refs.adminUsers.filter((user) => user.role === "COMPLIANCE" || user.role === "OPERATOR"))?.id ?? null
          : null,
        reviewedAt: docStatus === "ACCEPTED" || docStatus === "REJECTED" ? addDays(createdAt, ctx.rng.int(1, 15)) : null,
        expiresOn,
        rejectionReasonCode: docStatus === "REJECTED" ? "BLURRY_OR_EXPIRED" : null,
        reviewNotes: docStatus === "REJECTED" ? "The scan is not readable; request a fresh copy." : null,
      };
      merchantDocuments.push(document);
      ctx.dataset.kybDocuments.push(document);
    }

    if (status === "ACTIVE") {
      const validTypes = new Set(
        merchantDocuments
          .filter((document) => document.status === "ACCEPTED"
            && (!document.expiresOn || new Date(document.expiresOn as Date).getTime() >= today.getTime()))
          .map((document) => String(document.docType)),
      );
      for (const requiredType of requiredDocumentsFor(businessCategory)) {
        if (validTypes.has(requiredType)) continue;
        const documentId = ctx.nextId("kyb-doc");
        const pdf = previewPdf(documentId);
        ctx.dataset.kybDocuments.push({
          id: documentId,
          createdAt: now,
          updatedAt: now,
          merchantId,
          joinRequestId,
          subjectType: "MERCHANT",
          subjectId: merchantId,
          docType: requiredType as never,
          storageKey: `synthetic/kyb/merchants/${merchantId}/${requiredType}.pdf`,
          originalFileName: `${requiredType.toLowerCase()}.pdf`,
          contentCiphertext: await vault.encryptSecret(pdf.toString("base64"), "kyb-document"),
          sha256: `seed-valid-${merchantId}-${requiredType}`.padEnd(64, "0").slice(0, 64),
          mime: "application/pdf",
          sizeBytes: pdf.byteLength,
          avStatus: "CLEAN",
          status: "ACCEPTED",
          uploadedById: uploaderId,
          reviewedById: uploaderId,
          reviewedAt: now,
          expiresOn: addDays(now, 365),
          statusChangedAt: now,
        });
      }
      if (!merchant.nextKybReviewAt) {
        merchant.nextKybReviewAt = nextKybReviewAt(merchant.riskTier, now, DEFAULT_KYB_REFRESH_POLICY);
      }
    }

    // Beneficial owners (1-4), including historical owner changes.
    const ownerCount = ctx.rng.int(1, 4);
    for (let ownerIndex = 0; ownerIndex < ownerCount; ownerIndex += 1) {
      const ownerName = randomName(ctx);
      const active = !(ownerIndex === ownerCount - 1 && ctx.rng.chance(25));
      const rawNationalId = `NID-${merchantId}-${ownerIndex}`;
      ctx.dataset.beneficialOwners.push({
        id: ctx.nextId("owner"),
        createdAt,
        updatedAt: ctx.timeline.end,
        merchantId,
        fullNameAr: ownerName.ar,
        fullNameEn: ownerName.en,
        nationalIdCiphertext: Buffer.from(rawNationalId).toString("base64"),
        nationalIdHash: nationalIdHash(rawNationalId),
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
  }

  const joinRequestByMerchant = new Map(
    ctx.dataset.joinRequests.map((joinRequest) => [String(joinRequest.merchantId), joinRequest]),
  );
  const activeOwners = ctx.dataset.beneficialOwners.filter((owner) => owner.active).slice(0, 24);
  for (const owner of activeOwners) {
    const exists = ctx.dataset.kybDocuments.some(
      (document) => document.subjectType === "BENEFICIAL_OWNER"
        && String(document.subjectId) === String(owner.id)
        && document.docType === "OWNER_ID",
    );
    if (exists) continue;
    const joinRequest = joinRequestByMerchant.get(String(owner.merchantId));
    const documentId = ctx.nextId("kyb-doc");
    const pdf = previewPdf(documentId);
    ctx.dataset.kybDocuments.push({
      id: documentId,
      createdAt: now,
      updatedAt: now,
      merchantId: owner.merchantId,
      joinRequestId: joinRequest?.id ?? null,
      subjectType: "BENEFICIAL_OWNER",
      subjectId: owner.id,
      docType: "OWNER_ID",
      storageKey: `synthetic/kyb/owners/${owner.id}/OWNER_ID.pdf`,
      originalFileName: `${String(owner.fullNameAr).replaceAll(/\s+/g, "-")}-identity.pdf`,
      contentCiphertext: await vault.encryptSecret(pdf.toString("base64"), "kyb-document"),
      sha256: `seed-owner-${owner.id}`.padEnd(64, "0").slice(0, 64),
      mime: "application/pdf",
      sizeBytes: pdf.byteLength,
      avStatus: "CLEAN",
      status: "UPLOADED",
      uploadedById: uploaderId,
      expiresOn: addDays(now, 365),
      statusChangedAt: now,
    });
  }

  void formatMoney;
};
