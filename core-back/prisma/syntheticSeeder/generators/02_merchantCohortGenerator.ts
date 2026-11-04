import type { MerchantInfo, SeederContext } from "../context";
import { metaOf } from "../context";
import {
  addDays, addMinutes, allocateVolume, between, shuffle, createWalletAccount, maxDate, randomAddress, randomBank,
  randomBusinessName, randomCategory, randomName, randomTaxId, sha256Like,
} from "../builders";
import { pickIban, pickPhone, NATIONALITIES } from "../libyanDataCatalog";
import { D } from "../money";
import { businessHour, iterateDays, tripoliDateTime } from "../timelineClock";
import {
  JOIN_REQUEST_CHECKLIST_KEYS,
  nationalIdHash,
  payoutAccountHash,
  requiredDocumentsFromSetting,
} from "../../../lib/joinRequestOnboarding";

const MERCHANT_STATUS_WEIGHTS = { ACTIVE: 62, PENDING: 12, SUSPENDED: 11, REJECTED: 9, CLOSED: 6 } as const;
const PENDING_JOIN_WEIGHTS = { SUBMITTED: 18, IN_REVIEW: 30, INFO_REQUESTED: 22, PENDING_CHECKER: 20, DRAFT: 10 } as const;
const PRIOR_JOIN_OUTCOMES = { REJECTED: 45, EXPIRED: 35, WITHDRAWN: 20 } as const;
const OPTIONAL_DOC_TYPES = ["ARTICLES_OF_ASSOCIATION", "SIGNATORY_ID", "SECTOR_LICENSE", "OWNER_ID", "OTHER"] as const;
const OWNER_ROLES = ["DIRECTOR", "SIGNATORY", "CONTROLLER", "OWNER"] as const;
const SUSPENSION_REASONS = ["AML", "FRAUD", "KYB_EXPIRED", "COMMISSION_CEILING", "MERCHANT_REQUEST", "OTHER"] as const;
const REJECTION_REASONS = ["UNVERIFIABLE_BUSINESS", "INCOMPLETE_DOCUMENTS", "PROHIBITED_ACTIVITY", "POLICY"] as const;
const CITY_CODES: Record<string, string> = {
  Tripoli: "TR", Benghazi: "BE", Misrata: "MI", Zawiya: "ZA", Sabha: "SB", Tobruk: "TB",
};

/** Users of the platform staff (generator 01) by role. */
const staffBy = (ctx: SeederContext, roles: readonly string[]) =>
  ctx.dataset.users.filter((user) => user.merchantId === null && user.status === "ACTIVE" && roles.includes(user.role));

const slug = (value: string): string => value.toLowerCase().replaceAll(/[^a-z0-9]+/g, ".").replace(/^\.+|\.+$/g, "");

/**
 * Merchants with their whole onboarding history: join requests (including
 * rejected/expired/withdrawn earlier attempts and resubmissions), KYB
 * documents, beneficial owners, wallets + GL accounts, applications, users,
 * access tokens, POS terminals, merchant-owned credential sets and negotiated
 * commission profiles.
 *
 * Every per-merchant collection is sized by its profile volume
 * (`joinRequests`, `kybDocuments`, `beneficialOwners`, `users`, `wallets`,
 * `applications`) through `allocateVolume`, and every timestamp follows the
 * real onboarding order: request -> submission -> review -> decision ->
 * activation -> (suspension | closure), never after the simulation clock.
 */
export const generateMerchantCohort = (ctx: SeederContext): void => {
  const meta = metaOf(ctx);
  const volumes = ctx.config.volumes;
  const total = volumes.merchants;
  const end = ctx.timeline.end;
  const days = iterateDays(ctx.timeline);
  const onboardingDays = days.slice(0, Math.max(1, days.length - 45));
  const cumulative: number[] = [];
  let running = 0;
  for (const day of onboardingDays) {
    running += 1 + day.monthIndex / 6; // onboarding follows the adoption curve, more gently than payments
    cumulative.push(running);
  }
  const sampleOnboardingDay = (): Date => {
    const roll = ctx.rng.next() * running;
    let low = 0;
    let high = cumulative.length - 1;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (cumulative[mid]! < roll) low = mid + 1;
      else high = mid;
    }
    return onboardingDays[low]!.date;
  };
  const atBusinessTime = (day: Date): Date =>
    tripoliDateTime(day, Math.min(20, Math.max(8, businessHour(ctx.rng, day))), ctx.rng.int(0, 59), ctx.rng.int(0, 59));

  const reviewers = staffBy(ctx, ["OPERATOR"]);
  const kybReviewers = staffBy(ctx, ["COMPLIANCE", "OPERATOR"]);
  const assistants = staffBy(ctx, ["OPERATOR", "SUPPORT"]);
  const requiredDocsFor = (categoryCode: string): string[] =>
    requiredDocumentsFromSetting(ctx.refs.requiredDocumentsSetting, categoryCode);

  // ---------------------------------------------------------- statuses first
  const statuses = Array.from({ length: total }, () => ctx.rng.weighted(MERCHANT_STATUS_WEIGHTS) as string);
  const operating = (index: number) => ["ACTIVE", "SUSPENDED", "CLOSED"].includes(statuses[index]!);
  const staffSeats = ctx.dataset.users.filter((user) => user.merchantId === null).length;
  const joinCounts = allocateVolume(ctx, volumes.joinRequests, total, 1, 3, (index) => (statuses[index] === "PENDING" ? 0.5 : 1));
  const walletCounts = allocateVolume(ctx, volumes.wallets, total, 1, 3, (index) => (operating(index) ? 1 : 0));
  const appCounts = allocateVolume(ctx, volumes.applications, total, 1, 5, (index) => (operating(index) ? 1 : 0.15));
  const userCounts = allocateVolume(ctx, Math.max(total, volumes.users - staffSeats), total, 1, 8, (index) => (operating(index) ? 1 : 0.2));
  const ownerCounts = allocateVolume(ctx, volumes.beneficialOwners, total, 1, 6);
  const categories = Array.from({ length: total }, () => randomCategory(ctx));
  const requiredCounts = categories.map((category) => requiredDocsFor(category.code).length);
  const docMin = Math.max(...requiredCounts, 1);
  const docCounts = allocateVolume(ctx, volumes.kybDocuments, total, docMin, docMin + 6);

  // Deliberate duplicate showcase: the same document hash and payout account
  // under two different merchants (the compliance duplicate alert).
  const duplicatePairs: Array<[number, number]> = ([[3, 11], [23, 31], [40, 47]] as Array<[number, number]>)
    .filter(([left, right]) => left < total && right < total);
  const duplicateOf = new Map<number, number>();
  for (const [left, right] of duplicatePairs) duplicateOf.set(right, left);
  const pairHash = new Map<number, string>();
  const pairAccount = new Map<number, { bank: string; account: string }>();

  const usedPhones = new Set<string>();
  const uniquePhone = (): string => {
    for (let tries = 0; tries < 50; tries += 1) {
      const phone = pickPhone(ctx.rng);
      if (!usedPhones.has(phone)) {
        usedPhones.add(phone);
        return phone;
      }
    }
    throw new Error("Could not allocate a unique synthetic phone number");
  };

  for (let index = 0; index < total; index += 1) {
    let status = statuses[index]!;
    const category = categories[index]!;
    const business = randomBusinessName(ctx);
    const address = randomAddress(ctx);
    const city = ctx.rng.pick(Object.keys(CITY_CODES));
    const merchantId = ctx.nextId("merchant");
    const riskTier = ctx.rng.weighted({ LOW: 25, STANDARD: 60, HIGH: 15 }) as string;
    const onboardingChannel = ctx.rng.chance(65) ? "SELF_SERVICE" : "ADMIN_ASSISTED";
    const taxId = randomTaxId(ctx);
    const registrationNo = `${ctx.rng.int(100000, 999999)}-${CITY_CODES[city]}`;
    const contactEmail = `${slug(business.en)}.${index}@${ctx.config.namespace}.ly`;
    const contactPhone = uniquePhone();

    // ------------------------------------------------ final join request
    let finalCreated: Date;
    let joinStatus: string;
    if (status === "PENDING") {
      joinStatus = ctx.rng.weighted(PENDING_JOIN_WEIGHTS) as string;
      finalCreated = atBusinessTime(addDays(end, -ctx.rng.int(6, 30)));
    } else {
      joinStatus = status === "REJECTED" ? "REJECTED" : "APPROVED";
      finalCreated = atBusinessTime(sampleOnboardingDay());
    }
    const submittedAt = joinStatus === "DRAFT" ? null : addMinutes(finalCreated, ctx.rng.int(20, 2 * 24 * 60));
    const reviewStart = submittedAt ? addMinutes(submittedAt, ctx.rng.int(60, 2 * 24 * 60)) : null;
    const infoRequestedAt = joinStatus === "INFO_REQUESTED" && reviewStart ? addMinutes(reviewStart, ctx.rng.int(60, 24 * 60)) : null;
    const proposedAt = ["PENDING_CHECKER", "APPROVED", "REJECTED"].includes(joinStatus) && reviewStart
      ? addMinutes(reviewStart, ctx.rng.int(12 * 60, 6 * 24 * 60))
      : null;
    const decidedAt = ["APPROVED", "REJECTED"].includes(joinStatus) && proposedAt
      ? addMinutes(proposedAt, ctx.rng.int(30, 3 * 24 * 60))
      : null;
    const activatedAt = joinStatus === "APPROVED" && decidedAt ? addMinutes(decidedAt, ctx.rng.int(5, 18 * 60)) : null;
    // A suspension/closure needs at least a month of trading first.
    let stoppedAt: Date | null = null;
    if ((status === "SUSPENDED" || status === "CLOSED") && activatedAt) {
      const earliest = addDays(activatedAt, status === "CLOSED" ? 60 : 30);
      if (earliest.getTime() < addDays(end, -2).getTime()) {
        stoppedAt = between(ctx, earliest, addDays(end, -1));
      } else {
        status = "ACTIVE";
      }
    }
    const suspensionReason = status === "SUSPENDED" ? ctx.rng.pick(SUSPENSION_REASONS) : null;
    const kybStatus = joinStatus === "APPROVED" ? "VERIFIED" : joinStatus === "REJECTED" ? "REJECTED" : joinStatus === "DRAFT" ? "UNVERIFIED" : "PENDING";

    // ------------------------------------------------ earlier join requests
    const priorCount = joinCounts[index]! - 1;
    const priors: Array<{ createdAt: Date; submittedAt: Date; decidedAt: Date; outcome: string }> = [];
    let cursor = finalCreated;
    for (let prior = 0; prior < priorCount; prior += 1) {
      const decided = addDays(cursor, -ctx.rng.int(2, 30));
      const submitted = addDays(decided, -ctx.rng.int(3, 20));
      const created = addMinutes(submitted, -ctx.rng.int(30, 2 * 24 * 60));
      if (created.getTime() <= ctx.timeline.start.getTime()) break;
      priors.unshift({ createdAt: created, submittedAt: submitted, decidedAt: decided, outcome: ctx.rng.weighted(PRIOR_JOIN_OUTCOMES) as string });
      cursor = created;
    }
    const merchantCreatedAt = priors[0]?.createdAt ?? finalCreated;
    const lastEventAt = maxDate(merchantCreatedAt, submittedAt, infoRequestedAt, proposedAt, decidedAt, activatedAt, stoppedAt);

    const bank = randomBank(ctx);
    const duplicateSource = duplicateOf.get(index);
    const payout = duplicateSource !== undefined && pairAccount.has(duplicateSource)
      ? pairAccount.get(duplicateSource)!
      : { bank: bank.en, account: pickIban(ctx.rng, bank.ibanCode) };
    pairAccount.set(index, payout);
    const payoutBankDetails = { bank: payout.bank, account: payout.account, holder: business.en, address: address.en };
    const negativeBalanceCeiling = status === "ACTIVE" && ctx.rng.chance(12) ? `${ctx.rng.int(1, 5) * 100}.0000` : "0.0000";

    ctx.dataset.merchants.push({
      id: merchantId,
      version: 1,
      createdAt: merchantCreatedAt,
      updatedAt: lastEventAt,
      legalName: business.en,
      tradeName: business.ar,
      displayName: business.ar,
      logoUrl: null,
      supportEmail: contactEmail,
      supportPhone: contactPhone,
      taxId,
      registrationNo,
      businessCategory: category.en,
      status,
      kybStatus,
      riskTier,
      onboardingChannel,
      country: "LY",
      contactPhone,
      contactEmail,
      activatedAt,
      suspendedAt: status === "SUSPENDED" ? stoppedAt : null,
      suspensionReasonCode: suspensionReason,
      suspensionNotes: status === "SUSPENDED" ? `Suspended (${suspensionReason}) after the documented lifecycle review.` : null,
      closedAt: status === "CLOSED" ? stoppedAt : null,
      closedReasonCode: status === "CLOSED" ? ctx.rng.pick(["BUSINESS_CLOSED", "MERCHANT_REQUEST", "INACTIVITY"]) : null,
      closedNotes: status === "CLOSED" ? "Relationship ended; wallet settled and closed." : null,
      commissionReceivableCeiling: ctx.rng.chance(10) ? `${ctx.rng.int(5, 50) * 100}.0000` : null,
      negativeBalanceCeiling,
      payoutBankDetailsJson: payoutBankDetails,
      payoutAccountHash: payoutAccountHash(payoutBankDetails),
      nextKybReviewAt: null,
    });

    // ---------------------------------------------------------------- users
    const userIds: string[] = [];
    let adminUserId: string | null = null;
    for (let userIndex = 0; userIndex < userCounts[index]!; userIndex += 1) {
      const userId = ctx.nextId("user");
      const role = userIndex === 0 ? "MERCHANT_ADMIN" : ctx.rng.chance(65) ? "MERCHANT_STAFF" : "MERCHANT_CASHIER";
      const email = userIndex === 0 ? contactEmail.replace("@", ".admin@") : `merchant.${index}.${userIndex}@${ctx.config.namespace}.ly`;
      const createdAt = userIndex === 0 ? merchantCreatedAt : between(ctx, activatedAt ?? merchantCreatedAt, addDays(stoppedAt ?? end, 0));
      const invited = userIndex > 0 && ctx.rng.chance(8);
      const userStatus = status === "CLOSED" ? "DISABLED" : invited ? "INVITED" : status === "SUSPENDED" && userIndex > 0 && ctx.rng.chance(30) ? "SUSPENDED" : "ACTIVE";
      const phone = uniquePhone();
      ctx.dataset.users.push({
        id: userId,
        createdAt,
        updatedAt: createdAt,
        merchantId,
        email,
        phone,
        passwordHash: null,
        role,
        authoritiesMap: role === "MERCHANT_ADMIN"
          ? ["link:write", "merchant:read", "merchant:write", "payment:read"]
          : role === "MERCHANT_STAFF" ? ["link:write", "merchant:read", "payment:read"] : ["link:write", "payment:read"],
        appScopeIds: null,
        isMaker: false,
        isChecker: false,
        mfaRequired: role === "MERCHANT_ADMIN",
        mfaSecretCiphertext: null,
        invitationTokenHash: invited ? sha256Like(ctx, `invite:${userId}`) : null,
        invitationExpiresAt: invited ? addDays(createdAt, 7) : null,
        invitedById: userIndex > 0 ? adminUserId : null,
        status: userStatus,
        academyProgressJson: null,
      });
      userIds.push(userId);
      if (userIndex === 0) adminUserId = userId;
      // Identity rows: the e-mail identity always matches the account e-mail;
      // a phone identity (unique number) is added for verified users.
      const verified = userStatus !== "INVITED";
      ctx.dataset.userIdentities.push({
        id: ctx.nextId("identity"),
        createdAt,
        updatedAt: createdAt,
        userId,
        kind: "EMAIL",
        identifierNormalized: email,
        providerSubject: null,
        verifiedAt: verified ? createdAt : null,
        isPrimary: true,
        lastUsedAt: verified && userStatus === "ACTIVE" ? between(ctx, createdAt, end) : null,
      });
      if (verified && ctx.rng.chance(60)) {
        ctx.dataset.userIdentities.push({
          id: ctx.nextId("identity"),
          createdAt,
          updatedAt: createdAt,
          userId,
          kind: "PHONE",
          identifierNormalized: phone,
          providerSubject: null,
          verifiedAt: createdAt,
          isPrimary: false,
          lastUsedAt: null,
        });
      }
    }

    // -------------------------------------------------------- join requests
    const assistant = onboardingChannel === "ADMIN_ASSISTED" ? ctx.rng.pick(assistants)?.id ?? null : null;
    const profileJson = {
      legalName: business.en,
      tradeName: business.ar,
      country: "LY",
      businessCategory: category.code,
      registrationNumber: registrationNo,
      taxId,
      registeredAddress: address.en,
      websiteUrl: `https://${slug(business.en).replaceAll(".", "-")}.${ctx.config.namespace}.ly`,
      contactPhone,
      contactEmail,
      expectedMonthlyVolume: `${Math.round(category.max * ctx.rng.int(40, 400))}.0000`,
      currency: "LYD",
      businessUseDescription: `${business.en} collects ${category.en.toLowerCase()} payments online${category.pos ? " and at the counter" : ""}.`,
      payoutAccount: payout.account,
      ...(assistant ? { adminAssistedByUserId: assistant } : {}),
    };
    const submitter = adminUserId ?? assistant ?? ctx.dataset.users[0]?.id;
    let previousRequestId: string | null = null;
    const priorIds: string[] = [];
    for (const prior of priors) {
      const id = ctx.nextId("join");
      priorIds.push(id);
      ctx.dataset.joinRequests.push({
        id,
        createdAt: prior.createdAt,
        updatedAt: prior.decidedAt,
        merchantId,
        submittedByUserId: submitter,
        status: prior.outcome,
        onboardingChannel,
        submittedAt: prior.submittedAt,
        assignedReviewerId: prior.outcome === "REJECTED" ? ctx.rng.pick(reviewers)?.id ?? null : null,
        slaDueAt: addDays(prior.submittedAt, 5),
        screeningId: null,
        proposedRiskTier: riskTier,
        fourEyesRequired: false,
        fourEyesReasons: null,
        decision: prior.outcome === "REJECTED" ? "REJECTED" : null,
        decisionReasonCode: prior.outcome === "REJECTED" ? "INCOMPLETE_DOCUMENTS" : prior.outcome === "EXPIRED" ? "INFO_NOT_PROVIDED" : "APPLICANT_WITHDREW",
        decisionNotes: prior.outcome === "REJECTED" ? "The registry extract was missing; please re-apply with the full set." : null,
        infoRequestJson: prior.outcome === "EXPIRED" ? [{ field: "tax_certificate", message: "Please upload the current tax certificate." }] : null,
        profileJson,
        reviewChecklistJson: prior.outcome === "REJECTED" ? Object.fromEntries(JOIN_REQUEST_CHECKLIST_KEYS.map((key, i) => [key, i < 2])) : null,
        duplicateFlagsJson: [],
        slaPausedAt: null,
        slaRemainingSeconds: null,
        lastScreenedAt: null,
        resubmissionOfId: previousRequestId,
        approvalRequestId: null,
      });
      previousRequestId = id;
    }
    const fourEyes = riskTier === "HIGH" || (["APPROVED", "PENDING_CHECKER"].includes(joinStatus) && ctx.rng.chance(20));
    const joinRequestId = ctx.nextId("join");
    const reviewerId = reviewStart ? ctx.rng.pick(reviewers)?.id ?? null : null;
    ctx.dataset.joinRequests.push({
      id: joinRequestId,
      createdAt: finalCreated,
      updatedAt: maxDate(finalCreated, submittedAt, infoRequestedAt, proposedAt, decidedAt),
      merchantId,
      submittedByUserId: submitter,
      status: joinStatus,
      onboardingChannel,
      submittedAt,
      assignedReviewerId: reviewerId,
      slaDueAt: addDays(submittedAt ?? finalCreated, 5),
      screeningId: null,
      proposedRiskTier: riskTier,
      fourEyesRequired: fourEyes,
      fourEyesReasons: fourEyes ? (riskTier === "HIGH" ? ["HIGH_RISK"] : ["RISK_BASED"]) : null,
      decision: joinStatus === "APPROVED" ? "APPROVED" : joinStatus === "REJECTED" ? "REJECTED" : null,
      decisionReasonCode: joinStatus === "REJECTED" ? ctx.rng.pick(REJECTION_REASONS) : null,
      decisionNotes: joinStatus === "INFO_REQUESTED"
        ? "Please re-upload a clearer tax certificate."
        : joinStatus === "REJECTED" ? "Rejected after document and screening review." : null,
      infoRequestJson: joinStatus === "INFO_REQUESTED"
        ? [
            { field: "tax_certificate", message: "Please re-upload a clearer tax certificate." },
            { field: "payout_account", message: "Confirm the account holder matches the legal entity." },
          ]
        : null,
      profileJson,
      reviewChecklistJson: ["IN_REVIEW", "INFO_REQUESTED", "PENDING_CHECKER"].includes(joinStatus)
        ? Object.fromEntries(JOIN_REQUEST_CHECKLIST_KEYS.map((key, i) => [key, joinStatus === "PENDING_CHECKER" || i < 4]))
        : ["APPROVED", "REJECTED"].includes(joinStatus)
          ? Object.fromEntries(JOIN_REQUEST_CHECKLIST_KEYS.map((key) => [key, joinStatus === "APPROVED" || ctx.rng.chance(60)]))
          : null,
      duplicateFlagsJson: duplicateSource !== undefined
        ? [{ type: "DUPLICATE_OR_RELATED", field: "payoutAccount" }, { type: "DUPLICATE_OR_RELATED", field: "kybDocumentHash" }]
        : priors.length > 0 ? [{ type: "RESUBMISSION", field: "merchant" }] : [],
      slaPausedAt: infoRequestedAt,
      slaRemainingSeconds: infoRequestedAt && submittedAt
        ? Math.max(0, Math.round((addDays(submittedAt, 5).getTime() - infoRequestedAt.getTime()) / 1000))
        : null,
      lastScreenedAt: null,
      resubmissionOfId: previousRequestId,
      approvalRequestId: null,
    });

    // ------------------------------------------------------- KYB documents
    // Each document type is a chain of copies: earlier copies were rejected
    // or expired and replaced, the last copy is the current one. Every copy
    // is uploaded and reviewed inside the onboarding window, in order.
    const requiredDocs = requiredDocsFor(category.code);
    const docTypes: string[] = [...requiredDocs];
    while (docTypes.length < docCounts[index]!) {
      const optional = OPTIONAL_DOC_TYPES.find((type) => !docTypes.includes(type));
      docTypes.push(optional ?? ctx.rng.pick(requiredDocs));
    }
    const copiesByType = new Map<string, number>();
    for (const docType of docTypes) copiesByType.set(docType, (copiesByType.get(docType) ?? 0) + 1);
    const windowStart = merchantCreatedAt;
    const windowEndRaw = decidedAt ?? proposedAt ?? infoRequestedAt ?? reviewStart ?? submittedAt ?? addMinutes(finalCreated, 120);
    const windowEnd = windowEndRaw.getTime() > end.getTime() ? end : windowEndRaw;
    let docIndex = 0;
    for (const [docType, copies] of copiesByType) {
      const points = Array.from({ length: copies * 2 }, () => between(ctx, windowStart, windowEnd).getTime()).sort((a, b) => a - b);
      for (let copy = 0; copy < copies; copy += 1) {
        const superseded = copy < copies - 1;
        const uploadedAt = new Date(points[copy * 2]!);
        const reviewPoint = new Date(points[copy * 2 + 1]!);
        const required = requiredDocs.includes(docType);
        let docStatus: string;
        let avStatus = "CLEAN";
        if (superseded) {
          docStatus = ctx.rng.chance(60) ? "REJECTED" : "EXPIRED";
        } else if (kybStatus === "VERIFIED") {
          docStatus = "ACCEPTED";
        } else if (kybStatus === "REJECTED") {
          docStatus = required && ctx.rng.chance(40) ? "REJECTED" : "ACCEPTED";
        } else if (joinStatus === "DRAFT" || joinStatus === "SUBMITTED") {
          docStatus = "UPLOADED";
          avStatus = ctx.rng.chance(15) ? "PENDING" : "CLEAN";
        } else {
          docStatus = ctx.rng.weighted({ UPLOADED: 35, ACCEPTED: 50, REJECTED: 15 }) as string;
        }
        if (docStatus === "REJECTED" && ctx.rng.chance(10)) avStatus = "INFECTED";
        const reviewedAt = docStatus === "UPLOADED" ? null : reviewPoint;
        // Registry/tax/licence documents expire yearly. An ACTIVE merchant keeps
        // valid documents (a few expire within 30 days and got the 30-day
        // notice); an EXPIRED copy lapsed before its replacement was uploaded.
        const yearly = ["COMMERCIAL_REGISTRY", "TAX_CERTIFICATE", "SECTOR_LICENSE"].includes(docType);
        let expiresOn: Date | null = null;
        let expiredAt: Date | null = null;
        let notice30: Date | null = null;
        if (docStatus === "EXPIRED") {
          const replacementAt = new Date(points[copy * 2 + 2] ?? reviewPoint.getTime());
          expiredAt = between(ctx, reviewPoint, replacementAt);
          expiresOn = expiredAt;
        } else if (yearly && docStatus === "ACCEPTED") {
          const soon = status === "ACTIVE" && ctx.rng.chance(6);
          expiresOn = soon ? addDays(end, ctx.rng.int(3, 29)) : addDays(end, ctx.rng.int(45, 330));
          if (soon) notice30 = maxDate(addDays(expiresOn, -30), reviewedAt);
        }
        const sharedHash = duplicateSource !== undefined && docIndex === 0 ? pairHash.get(duplicateSource) : undefined;
        const sha = sharedHash ?? sha256Like(ctx, `${merchantId}:${docType}:${copy}`);
        if (docIndex === 0) pairHash.set(index, sha);
        ctx.dataset.kybDocuments.push({
          id: ctx.nextId("kyb-doc"),
          createdAt: uploadedAt,
          updatedAt: maxDate(uploadedAt, reviewedAt, expiredAt, notice30 && notice30 <= end ? notice30 : null),
          merchantId,
          joinRequestId: superseded && priorIds.length > 0 ? priorIds[priorIds.length - 1] : joinRequestId,
          subjectType: "MERCHANT",
          subjectId: merchantId,
          docType,
          storageKey: `synthetic/${ctx.config.namespace}/merchants/${merchantId}/${docType.toLowerCase()}-${copy}.pdf`,
          originalFileName: `${docType.toLowerCase()}${superseded ? `-v${copy + 1}` : ""}.pdf`,
          contentCiphertext: null,
          sha256: sha,
          mime: "application/pdf",
          sizeBytes: ctx.rng.int(80_000, 3_500_000),
          avStatus,
          status: docStatus,
          uploadedById: onboardingChannel === "ADMIN_ASSISTED" ? assistant : adminUserId,
          reviewedById: reviewedAt ? ctx.rng.pick(kybReviewers)?.id ?? null : null,
          reviewedAt,
          expiresOn,
          rejectionReasonCode: docStatus === "REJECTED" ? (avStatus === "INFECTED" ? "MALWARE_DETECTED" : "BLURRY_OR_EXPIRED") : null,
          reviewNotes: docStatus === "REJECTED" ? "The scan is not readable; request a fresh copy." : null,
          duplicateJustification: sharedHash ? "Group companies share the same registry extract." : null,
          statusChangedAt: expiredAt ?? reviewedAt,
          expiryNotice30SentAt: notice30,
          expiryNotice7SentAt: null,
          expiredAt,
        });
        docIndex += 1;
      }
    }

    // ---------------------------------------------------- beneficial owners
    let remainingShare = 100;
    for (let ownerIndex = 0; ownerIndex < ownerCounts[index]!; ownerIndex += 1) {
      const ownerName = randomName(ctx);
      const isLast = ownerIndex === ownerCounts[index]! - 1;
      const share = ownerIndex === 0
        ? Math.min(remainingShare, ctx.rng.int(35, 90))
        : isLast ? remainingShare : Math.min(remainingShare, ctx.rng.int(0, Math.max(0, Math.floor(remainingShare / 2))));
      remainingShare -= share;
      const formerOwner = ownerIndex > 0 && ctx.rng.chance(15) && activatedAt !== null;
      const validTo = formerOwner ? between(ctx, addDays(activatedAt!, 10), stoppedAt ?? end) : null;
      const rawNationalId = `${ctx.rng.int(1, 2)}${String(ctx.rng.int(1950, 2003))}${String(ctx.rng.int(0, 9_999_999)).padStart(7, "0")}`;
      const owner: Record<string, unknown> = {
        id: ctx.nextId("owner"),
        createdAt: finalCreated,
        updatedAt: validTo ?? finalCreated,
        merchantId,
        fullNameAr: ownerName.ar,
        fullNameEn: ownerName.en,
        nationalIdCiphertext: "",
        nationalIdHash: nationalIdHash(rawNationalId),
        dateOfBirth: addDays(end, -ctx.rng.int(21 * 365, 70 * 365)),
        nationality: ctx.rng.chance(88) ? "LY" : ctx.rng.pick(NATIONALITIES.filter((code) => code !== "LY")),
        ownershipPercent: share > 0 ? share.toFixed(2) : null,
        role: ownerIndex === 0 ? "OWNER" : share >= 25 ? "OWNER" : ctx.rng.pick(OWNER_ROLES),
        pepDeclared: ctx.rng.chance(3),
        screeningStatus: joinStatus === "DRAFT" ? "NOT_SCREENED" : ctx.rng.chance(93) ? "CLEAR" : "POTENTIAL_MATCH",
        active: !formerOwner,
        validFrom: finalCreated,
        validTo,
      };
      ctx.dataset.beneficialOwners.push(owner);
      meta.pendingSecrets.push({ row: owner, field: "nationalIdCiphertext", plaintext: rawNationalId, keyId: "kyb-national-id", mode: "secret" });
    }

    // ---------------------------------------------------- wallets + GL
    const walletInfos: MerchantInfo["wallets"] = [];
    for (let walletIndex = 0; walletIndex < walletCounts[index]!; walletIndex += 1) {
      const walletAt = walletIndex === 0 ? merchantCreatedAt : between(ctx, activatedAt ?? merchantCreatedAt, stoppedAt ?? end);
      const glAccountId = createWalletAccount(ctx, merchantId, walletAt, walletIndex);
      const walletId = ctx.nextId("wallet");
      const walletStatus = status === "PENDING" ? "PENDING"
        : status === "REJECTED" || status === "CLOSED" ? "CLOSED"
          : status === "SUSPENDED" && (suspensionReason === "AML" || suspensionReason === "FRAUD") ? "FROZEN"
            : "ACTIVE";
      ctx.dataset.wallets.push({
        id: walletId,
        createdAt: walletAt,
        updatedAt: maxDate(walletAt, activatedAt, stoppedAt),
        merchantId,
        glAccountId,
        currency: "LYD",
        status: walletStatus,
      });
      walletInfos.push({ id: walletId, glAccountId, createdAt: walletAt, status: walletStatus });
    }

    // --------------------------------------------------------- applications
    const appIds: string[] = [];
    for (let appIndex = 0; appIndex < appCounts[index]!; appIndex += 1) {
      const wallet = walletInfos[appIndex % walletInfos.length]!;
      const createdAt = appIndex === 0 ? maxDate(finalCreated, wallet.createdAt) : between(ctx, maxDate(activatedAt ?? finalCreated, wallet.createdAt), stoppedAt ?? end);
      const appStatus = status === "ACTIVE" ? (appIndex === 0 || ctx.rng.chance(85) ? "ACTIVE" : ctx.rng.chance(50) ? "PENDING" : "DRAFT")
        : status === "SUSPENDED" ? "SUSPENDED"
          : status === "CLOSED" ? "CLOSED"
            : status === "PENDING" ? (appIndex === 0 ? "PENDING" : "DRAFT")
              : "DRAFT";
      const applicationId = ctx.nextId("application");
      appIds.push(applicationId);
      ctx.dataset.applications.push({
        id: applicationId,
        createdAt,
        updatedAt: maxDate(createdAt, stoppedAt && stoppedAt > createdAt ? stoppedAt : null),
        merchantId,
        name: appIndex === 0 ? `${business.en} checkout` : `${business.en} ${["mobile app", "branch", "e-shop", "invoices"][appIndex - 1] ?? appIndex}`,
        businessUseDescription: `${category.en} payments collected by ${business.en}.`,
        expectedMonthlyVolume: `${Math.round(category.max * ctx.rng.int(20, 200))}.0000`,
        assignedWalletId: wallet.id,
        railWhitelist: null,
        redirectDomainAllowlist: [`https://${slug(business.en).replaceAll(".", "-")}.${ctx.config.namespace}.ly`],
        status: appStatus,
      });

      // Server keys and IP allow lists for live applications.
      if (appStatus !== "DRAFT" && ctx.rng.chance(40)) {
        const tokenId = ctx.nextId("token");
        const tokenHash = sha256Like(ctx, `token:${applicationId}`);
        const tokenAt = between(ctx, createdAt, stoppedAt ?? end);
        const revokedAt = status === "CLOSED" ? stoppedAt : ctx.rng.chance(10) ? between(ctx, tokenAt, end) : null;
        ctx.dataset.accessTokens.push({
          id: tokenId,
          createdAt: tokenAt,
          updatedAt: revokedAt ?? tokenAt,
          merchantId,
          applicationId,
          name: "Default server key",
          tokenHash,
          lastFour: tokenHash.slice(-4),
          scopes: ["payments:write", "payments:read", "refunds:write"],
          ipWhitelistEnabled: ctx.rng.chance(40),
          revokedAt,
          lastUsedAt: ctx.rng.chance(70) ? between(ctx, tokenAt, revokedAt ?? stoppedAt ?? end) : null,
        });
        if (ctx.rng.chance(40)) {
          ctx.dataset.accessTokenIps.push({
            id: ctx.nextId("token-ip"),
            createdAt: tokenAt,
            updatedAt: tokenAt,
            tokenId,
            cidr: `203.0.113.${ctx.rng.int(1, 250)}/32`,
          });
        }
      }
      // Counter terminals only for counter-trading categories.
      if (category.pos && appStatus !== "DRAFT" && ctx.rng.chance(45)) {
        const posId = ctx.nextId("pos");
        const posAt = between(ctx, createdAt, stoppedAt ?? end);
        ctx.dataset.posTerminals.push({
          id: posId,
          createdAt: posAt,
          updatedAt: posAt,
          applicationId,
          name: `POS ${business.en.slice(0, 18)}`,
          location: address.en,
          status: status === "CLOSED" ? "INACTIVE" : ctx.rng.weighted({ ACTIVE: 80, INACTIVE: 15, BLOCKED: 5 }),
        });
        const screenCount = ctx.rng.int(1, 3);
        for (let screenIndex = 0; screenIndex < screenCount; screenIndex += 1) {
          const screenCode = `SCR-${ctx.config.namespace}-${posId.slice(-8)}-${screenIndex}`;
          ctx.dataset.posScreens.push({
            id: ctx.nextId("pos-screen"),
            createdAt: posAt,
            updatedAt: posAt,
            posId,
            screenCode,
            authTokenHash: sha256Like(ctx, `screen:${screenCode}`),
            realtimeRoomId: `room-${screenCode}`,
            lastActiveAt: ctx.rng.chance(50) ? between(ctx, posAt, stoppedAt ?? end) : null,
          });
        }
      }
    }

    // ------------------------------------------- merchant-owned credentials
    if ((status === "ACTIVE" || status === "SUSPENDED") && activatedAt && ctx.rng.chance(15)) {
      const directRoutes = ctx.refs.routes.filter((route) =>
        route.credentialPolicy === "MERCHANT_REQUIRED" || route.credentialPolicy === "MERCHANT_OR_PLATFORM");
      const route = directRoutes.length > 0 ? ctx.rng.pick(directRoutes) : null;
      if (route) {
        const credentialAt = between(ctx, activatedAt, addDays(activatedAt, 30));
        const credentialStatus = ctx.rng.weighted({ VERIFIED: 75, UNTESTED: 10, FAILING: 10, REVOKED: 5 }) as string;
        const credentialId = ctx.nextId("credential");
        ctx.dataset.credentialSets.push({
          id: credentialId,
          createdAt: credentialAt,
          updatedAt: credentialAt,
          gatewayId: route.gatewayId,
          env: "LIVE",
          ownerType: "MERCHANT",
          ownerMerchantId: merchantId,
          externalMerchantId: `MERCH-${ctx.config.namespace}-${merchantId.slice(-12)}`,
          settlementTarget: "MERCHANT_DIRECT",
          entriesCiphertext: [],
          mtlsCertCiphertext: null,
          status: credentialStatus,
          lastVerifiedAt: credentialStatus === "VERIFIED" ? between(ctx, credentialAt, end) : null,
          expiresAt: null,
        });
        ctx.refs.credentials.push({
          id: credentialId,
          gatewayId: route.gatewayId,
          gatewayCode: route.gatewayCode,
          env: "LIVE",
          ownerType: "MERCHANT",
          settlementTarget: "MERCHANT_DIRECT",
          ownerMerchantId: merchantId,
          status: credentialStatus,
        });
      }
    }

    // ---------------------------------------- negotiated commission profiles
    if (activatedAt) {
      const railCount = ctx.rng.int(0, 3);
      const rails = shuffle(ctx, ctx.refs.rails).slice(0, railCount);
      for (const rail of rails) {
        const calcType = ctx.rng.weighted({ PERCENTAGE: 70, HYBRID: 20, TIERED: 10 }) as string;
        ctx.dataset.commissionProfiles.push({
          id: ctx.nextId("commission"),
          createdAt: activatedAt,
          updatedAt: activatedAt,
          merchantId,
          applicationId: null,
          railCode: rail.code,
          calcType,
          // percentage_rate is a FRACTION (0.025000 = 2.5 %), DECIMAL(8,6):
          // the old generator stored 0.5-3.5 (50-350 %).
          flatFee: calcType === "HYBRID" ? D(ctx.rng.int(1, 4)).mul("0.25").toFixed(4) : "0.0000",
          percentageRate: calcType === "TIERED" ? "0.000000" : `0.0${ctx.rng.int(10, 30)}000`,
          tiersJson: calcType === "TIERED"
            ? [{ upTo: "100", percent: "0.030" }, { upTo: "1000", percent: "0.025" }, { percent: "0.018" }]
            : null,
          minFee: "0.2500",
          maxFee: ctx.rng.chance(30) ? `${ctx.rng.int(10, 60)}.0000` : null,
          feeBearerDefault: "MERCHANT_ABSORBS",
          roundingMode: "HALF_UP",
          effectiveFrom: activatedAt,
          effectiveTo: null,
          version: 1,
          approvalRequestId: null,
          seedKey: `synthetic:${ctx.config.namespace}:${ctx.config.seedKey}:commission:${merchantId}:${rail.code}`,
        });
      }
    }

    meta.merchants.set(merchantId, {
      id: merchantId,
      status,
      categoryCode: category.code,
      ticketMin: category.min,
      ticketMax: category.max,
      pos: category.pos,
      createdAt: merchantCreatedAt,
      activatedAt,
      stoppedAt,
      suspensionReason,
      adminUserId,
      wallets: walletInfos,
      applicationIds: appIds,
      negativeBalanceCeiling,
      join: {
        requestId: joinRequestId,
        status: joinStatus,
        reviewerId,
        proposedAt,
        decidedAt,
        fourEyes,
      },
    });
    void userIds;
  }

  ensureHistoricalDefaultProfile(ctx);
};

/**
 * The baseline seed creates the platform `default` commission profile with
 * `effective_from = 2026-01-01`. Attempts dated before that would have had no
 * effective profile (no visible rail), so the history gets the predecessor
 * profile that was in force until then.
 */
export const ensureHistoricalDefaultProfile = (ctx: SeederContext): void => {
  const defaults = (ctx.refs.commissionProfiles ?? []).filter((profile) => profile.railCode === "default");
  const earliest = defaults.reduce<Date | null>((min, profile) =>
    !min || profile.effectiveFrom < min ? profile.effectiveFrom : min, null);
  if (earliest && earliest.getTime() <= ctx.timeline.start.getTime()) return;
  const row = {
    id: ctx.nextId("commission"),
    createdAt: ctx.timeline.start,
    updatedAt: earliest ?? ctx.timeline.start,
    merchantId: null,
    applicationId: null,
    railCode: "default",
    calcType: "PERCENTAGE",
    flatFee: "0.0000",
    percentageRate: "0.025000",
    tiersJson: null,
    minFee: "0.2500",
    maxFee: null,
    feeBearerDefault: "MERCHANT_ABSORBS",
    roundingMode: "HALF_UP",
    effectiveFrom: ctx.timeline.start,
    effectiveTo: earliest,
    version: 0,
    approvalRequestId: null,
    seedKey: `synthetic:${ctx.config.namespace}:${ctx.config.seedKey}:platform-default-historical`,
  };
  ctx.dataset.commissionProfiles.push(row);
  ctx.refs.commissionProfiles = [
    ...(ctx.refs.commissionProfiles ?? []),
    {
      id: row.id,
      merchantId: null,
      applicationId: null,
      railCode: "default",
      calcType: row.calcType,
      flatFee: row.flatFee,
      percentageRate: row.percentageRate,
      tiersJson: null,
      minFee: row.minFee,
      maxFee: null,
      effectiveFrom: row.effectiveFrom,
      effectiveTo: row.effectiveTo,
    },
  ];
};
