import type { SeederContext } from "../context";
import { addDays, addMinutes, chance, randomPhone, sha256Like } from "../builders";

/**
 * The 7-layer AML history and the live back-office queues: screenings, matches,
 * cases, regulatory reports, operator cases, Maker-Checker approvals,
 * notifications, audit logs and detail change logs.
 */
export const generateAmlAndGovernanceQueues = (ctx: SeederContext): void => {
  const operators = ctx.refs.adminUsers.filter((user) => ["OPERATOR", "COMPLIANCE", "MLRO", "FINANCE"].includes(user.role));
  const pickOperator = () => ctx.rng.pick(operators.length > 0 ? operators : ctx.refs.adminUsers).id;

  const merchantSubjects = ctx.dataset.merchants.map((merchant) => ({ type: "MERCHANT", id: merchant.id, at: merchant.createdAt as Date }));
  const ownerSubjects = ctx.dataset.beneficialOwners.map((owner) => ({ type: "BENEFICIAL_OWNER", id: owner.id, at: owner.createdAt as Date }));
  const attemptSubjects = ctx.dataset.paymentAttempts.slice(0, Math.max(1, Math.floor(ctx.dataset.paymentAttempts.length / 20)))
    .map((attempt) => ({ type: "PAYMENT_ATTEMPT", id: attempt.id, at: attempt.createdAt as Date }));
  const subjects = [...merchantSubjects, ...ownerSubjects, ...attemptSubjects];

  // --------------------------------------------------------- AML screenings
  const screeningCount = ctx.config.volumes.amlScreenings;
  for (let index = 0; index < screeningCount; index += 1) {
    const subject = ctx.rng.pick(subjects);
    if (!subject) break;
    const result = ctx.rng.weighted({ CLEAR: 8800, POTENTIAL_MATCH: 900, CONFIRMED_MATCH: 200, ERROR: 100 });
    const screeningId = ctx.nextId("aml-screening");
    const requestedAt = addDays(subject.at, ctx.rng.int(0, 60));
    const matchCount = result === "CLEAR" || result === "ERROR" ? 0 : ctx.rng.int(1, 3);
    ctx.dataset.amlScreenings.push({
      id: screeningId,
      createdAt: requestedAt,
      updatedAt: requestedAt,
      subjectType: subject.type,
      subjectId: subject.id,
      trigger: ctx.rng.weighted({ ONBOARDING: 45, PERIODIC: 20, LIST_UPDATE: 10, OWNER_CHANGE: 5, TRANSACTION: 15, MANUAL: 5 }),
      providerCode: "INTERNAL_WATCHLIST",
      providerRequestRef: `scr-${sha256Like(ctx, screeningId).slice(0, 12)}`,
      listVersionsJson: { sanctions: "v2026.10", pep: "v2026.10", adverse_media: "v2026.09" },
      inputHash: sha256Like(ctx, `screening-input:${screeningId}`),
      result,
      matchCount,
      highestScore: matchCount > 0 ? ctx.rng.decimal(70, 99, 2) : null,
      requestedAt,
      completedAt: result === "ERROR" ? null : addMinutes(requestedAt, ctx.rng.int(1, 30)),
    });
    for (let matchIndex = 0; matchIndex < matchCount; matchIndex += 1) {
      const disposition = ctx.rng.weighted({ UNREVIEWED: 45, FALSE_POSITIVE: 35, TRUE_MATCH: 10, ESCALATED: 10 });
      ctx.dataset.amlScreeningMatches.push({
        id: ctx.nextId("aml-match"),
        createdAt: requestedAt,
        updatedAt: requestedAt,
        screeningId,
        listType: ctx.rng.pick(["SANCTIONS", "PEP", "ADVERSE_MEDIA", "INTERNAL_WATCHLIST"]),
        listName: "Consolidated screening list",
        listEntryRef: `LST-${ctx.rng.int(10000, 99999)}`,
        matchedName: ctx.rng.pick(["Mohamed Ali", "Ahmed Salem", "Omar Khaled", "Ali Hassan"]),
        score: ctx.rng.decimal(70, 99, 2),
        attributesJson: { country: "LY", dateOfBirth: "1980-01-01" },
        disposition,
        dispositionById: disposition === "UNREVIEWED" ? null : pickOperator(),
        dispositionNotes: disposition === "FALSE_POSITIVE" ? "Reviewed and dismissed." : null,
        suppressFuture: disposition === "FALSE_POSITIVE" && ctx.rng.chance(30),
        suppressUntil: null,
      });
    }

    // AML cases for the non-clear, non-false-positive screenings.
    if ((result === "POTENTIAL_MATCH" || result === "CONFIRMED_MATCH") && chance(ctx, 35)) {
      const status = ctx.rng.weighted({
        OPEN: 25, IN_REVIEW: 20, PENDING_CHECKER: 15, RELEASED: 20, REJECTED_VOID: 10, FROZEN: 5, ESCALATED_STR: 5,
      });
      const caseId = ctx.nextId("aml-case");
      ctx.dataset.amlCases.push({
        id: caseId,
        createdAt: addDays(requestedAt, 1),
        updatedAt: ctx.timeline.end,
        subjectType: subject.type,
        subjectId: subject.id,
        triggerReason: `Screening ${result.toLowerCase().replaceAll("_", " ")}`,
        severity: ctx.rng.weighted({ LOW: 20, MEDIUM: 40, HIGH: 30, CRITICAL: 10 }),
        severityInputsJson: { score: ctx.rng.decimal(70, 99, 2), list: "SANCTIONS" },
        screeningId,
        ruleId: null,
        ruleVersion: 1,
        holdJournalEntryId: null,
        status,
        slaDueAt: addDays(requestedAt, ctx.rng.int(1, 5)),
        assignedReviewerId: pickOperator(),
        regulatoryReportId: null,
        confidential: true,
        reviewerNotes: status === "PENDING_CHECKER" ? "Proposed release; awaiting MLRO." : null,
      });

      if (status === "ESCALATED_STR" || (status === "PENDING_CHECKER" && chance(ctx, 50))) {
        const reportId = ctx.nextId("report");
        ctx.dataset.regulatoryReports.push({
          id: reportId,
          createdAt: addDays(requestedAt, 2),
          updatedAt: ctx.timeline.end,
          reportType: ctx.rng.pick(["SUSPICIOUS_ACTIVITY", "LARGE_TRANSACTION", "PERIODIC_RETURN"]),
          authority: "CBL",
          subjectType: subject.type,
          subjectId: subject.id,
          amlCaseId: caseId,
          periodStart: addDays(requestedAt, -30),
          periodEnd: requestedAt,
          status: ctx.rng.weighted({ DRAFT: 15, PENDING_CHECKER: 20, APPROVED: 20, SUBMITTED: 20, ACKNOWLEDGED: 20, REJECTED_BY_AUTHORITY: 5 }),
          payloadCiphertext: Buffer.from(`synthetic-report:${reportId}`).toString("base64"),
          payloadSha256: sha256Like(ctx, `report:${reportId}`),
          submissionRef: null,
          submittedAt: null,
          confidential: true,
          approvalRequestId: null,
        });
        const amlCase = ctx.dataset.amlCases.find((candidate) => candidate.id === caseId);
        if (amlCase) amlCase.regulatoryReportId = reportId;
      }
    }
  }

  // Every submitted join request carries its own onboarding screening. The
  // review pages link the screening through join_requests.screening_id, so an
  // approved request must never look like it skipped screening.
  for (const joinRequest of ctx.dataset.joinRequests) {
    if (["DRAFT", "WITHDRAWN", "EXPIRED"].includes(String(joinRequest.status))) continue;
    const merchant = ctx.dataset.merchants.find((row) => row.id === joinRequest.merchantId);
    if (!merchant) continue;
    const requestedAt = joinRequest.submittedAt instanceof Date
      ? joinRequest.submittedAt
      : addDays(merchant.createdAt as Date, 1);
    const result = joinRequest.decisionReasonCode === "AML_CONFIRMED_MATCH" ? "CONFIRMED_MATCH" : "CLEAR";
    const screeningId = ctx.nextId("aml-screening");
    ctx.dataset.amlScreenings.push({
      id: screeningId,
      createdAt: requestedAt,
      updatedAt: requestedAt,
      subjectType: "MERCHANT",
      subjectId: merchant.id,
      trigger: "ONBOARDING",
      providerCode: "INTERNAL_WATCHLIST",
      providerRequestRef: `scr-${sha256Like(ctx, screeningId).slice(0, 12)}`,
      listVersionsJson: { sanctions: "v2026.10", pep: "v2026.10", adverse_media: "v2026.09" },
      inputHash: sha256Like(ctx, `screening-input:${screeningId}`),
      result,
      matchCount: 0,
      highestScore: null,
      requestedAt,
      completedAt: addMinutes(requestedAt, ctx.rng.int(1, 30)),
    });
    joinRequest.screeningId = screeningId;
    joinRequest.lastScreenedAt = requestedAt;
  }

  // ---------------------------------------------------- approval requests
  // Non-operator-case approvals only. Operator-case approvals are generated by
  // the dedicated 09 generator after the cases and their evidence exist.
  const subjectPools: Record<string, any[]> = {
    GatewayVersion: ctx.dataset.gatewayVersions,
    CommissionProfile: ctx.dataset.commissionProfiles,
    VelocityRule: ctx.dataset.velocityRules,
    AmlCase: ctx.dataset.amlCases,
    Adjustment: ctx.dataset.adjustments,
    CashoutRequest: ctx.dataset.cashoutRequests,
    Merchant: ctx.dataset.merchants,
    JoinRequest: ctx.dataset.joinRequests,
    PlatformSetting: ctx.dataset.platformSettings,
  };
  const subjectTypes = Object.keys(subjectPools);
  const activeMakers = ctx.dataset.users.filter(
    (user) => user.merchantId === null
      && user.status === "ACTIVE"
      && ["GATEWAY_ADMIN", "SECURITY_ADMIN", "FINANCE", "OPERATOR", "COMPLIANCE", "MLRO"].includes(user.role),
  );
  const activeCheckers = ctx.dataset.users.filter(
    (user) => user.merchantId === null
      && user.status === "ACTIVE"
      && ["SECURITY_ADMIN", "FINANCE", "MLRO"].includes(user.role),
  );
  const genericMaker = () => ctx.rng.pick(activeMakers.length > 0 ? activeMakers : ctx.dataset.users.filter((user) => user.merchantId === null));
  const genericChecker = (makerId: string) => {
    const pool = activeCheckers.filter((user) => user.id !== makerId);
    return pool.length > 0 ? ctx.rng.pick(pool) : activeMakers.find((user) => user.id !== makerId);
  };
  for (let index = 0; index < ctx.config.volumes.approvalRequests; index += 1) {
    const pending = index < Math.min(24, ctx.config.volumes.approvalRequests);
    const subjectType = ctx.rng.pick(subjectTypes);
    const pool = subjectPools[subjectType] ?? [];
    const subject = pool.length > 0 ? ctx.rng.pick(pool) : null;
    if (!subject) continue;
    const mode = index < 2 ? "EMERGENCY_RATIFICATION" : "STANDARD";
    const maker = genericMaker();
    if (!maker) continue;
    const checker = pending ? null : genericChecker(String(maker.id));
    if (subjectType === "JoinRequest" && !["SUBMITTED", "IN_REVIEW", "INFO_REQUESTED", "PENDING_CHECKER"].includes(String(subject.status))) {
      continue;
    }
    const state = pending
      ? (mode === "EMERGENCY_RATIFICATION" ? "PENDING_REVIEW" : ctx.rng.chance(50) ? "PENDING_REVIEW" : "DRAFT")
      : ctx.rng.weighted({ APPROVED: 20, EXECUTED: 55, REJECTED: 25 });
    const createdAt = pending
      ? addDays(ctx.timeline.end, -ctx.rng.int(0, 2))
      : addDays(ctx.timeline.start, ctx.rng.int(0, 1000));
    const decidedAt = pending ? createdAt : addDays(createdAt, ctx.rng.int(1, 10));
    const approval = {
      id: ctx.nextId("approval"),
      createdAt,
      updatedAt: decidedAt > ctx.timeline.end ? ctx.timeline.end : decidedAt,
      subjectType,
      subjectId: subject.id,
      payloadDiffJson: subjectType === "MERCHANT"
        ? {
            kind: "EDIT",
            patch: [{ op: "replace", path: "/contactPhone", value: randomPhone(ctx) }],
            reason: "Synthetic merchant contact verification.",
            baseVersion: 1,
          }
        : {
            subjectType,
            subjectId: subject.id,
            field: "status",
            from: "PENDING",
            to: "ACTIVE",
          },
      makerReason: "Synthetic governance evidence for maker-checker testing.",
      mode,
      baseVersion: 1,
      expiresAt: addDays(createdAt, 7),
      ratifyDueAt: mode === "EMERGENCY_RATIFICATION" ? addDays(createdAt, 1) : null,
      makerUserId: maker.id,
      checkerUserId: pending ? null : checker?.id ?? null,
      state,
      rejectionReason: state === "REJECTED" ? "Rejected after policy review." : null,
      riskAcceptanceNote: null,
    };
    ctx.dataset.approvalRequests.push(approval);
    if (subjectType === "JoinRequest" && state === "PENDING_REVIEW") {
      subject.approvalRequestId = approval.id;
      subject.status = "PENDING_CHECKER";
    }
  }

  // -------------------------------------------------------- notifications
  for (let index = 0; index < Math.min(500, ctx.config.volumes.paymentAttempts / 20); index += 1) {
    const merchant = ctx.rng.pick(ctx.dataset.merchants);
    if (!merchant) break;
    const channel = ctx.rng.pick(["SMS", "EMAIL", "IN_APP"]);
    const at = addDays(ctx.timeline.end, -ctx.rng.int(0, 120));
    ctx.dataset.notifications.push({
      id: ctx.nextId("notification"),
      createdAt: at,
      updatedAt: at,
      eventId: sha256Like(ctx, `notification:${index}:${merchant.id}`),
      recipientUserId: null,
      recipientMerchantId: merchant.id,
      addressMasked: `*******${ctx.rng.int(1000, 9999)}`,
      addressCiphertext: Buffer.from(`address:${merchant.id}`).toString("base64"),
      templateCode: ctx.rng.pick(["PAYMENT_SUCCEEDED", "PAYMENT_FAILED", "KYB_DOC_EXPIRING", "CASHOUT_COMPLETE"]),
      channel,
      lang: ctx.rng.pick(["AR", "EN"]),
      payloadJson: { reference: `PG-${ctx.rng.int(100000, 999999)}` },
      status: ctx.rng.weighted({ QUEUED: 10, SENT: 20, DELIVERED: 55, FAILED: 10, SUPPRESSED: 5 }),
      providerMessageId: `msg-${ctx.rng.int(100000, 999999)}`,
      attempts: ctx.rng.int(0, 3),
      nextAttemptAt: null,
    });
  }

  // ----------------------------------------------- audit + detail change logs
  for (let index = 0; index < 300; index += 1) {
    const actor = ctx.rng.pick(ctx.refs.adminUsers);
    if (!actor) break;
    const merchant = ctx.rng.pick(ctx.dataset.merchants);
    const at = addDays(ctx.timeline.end, -ctx.rng.int(0, 500));
    ctx.dataset.auditLogs.push({
      id: ctx.nextId("audit"),
      createdAt: at,
      updatedAt: at,
      actorId: actor.id,
      role: actor.role,
      action: ctx.rng.pick(["MERCHANT_SUSPENDED", "GATEWAY_VERSION_PROMOTED", "REFUND_APPROVED", "AML_CASE_RELEASED", "COMMISSION_PROFILE_UPDATED"]),
      entityType: ctx.rng.pick(["Merchant", "GatewayVersion", "Adjustment", "AmlCase"]),
      entityId: merchant?.id ?? ctx.nextId("entity"),
      beforeJson: { status: "PENDING" },
      afterJson: { status: "ACTIVE" },
      approvalRequestId: null,
    });
    ctx.dataset.detailChangeLogs.push({
      id: ctx.nextId("detail-change"),
      createdAt: at,
      updatedAt: at,
      actorId: actor.id,
      merchantId: merchant?.id ?? null,
      entityType: ctx.rng.pick(["Merchant", "Application", "AccessToken"]),
      entityId: merchant?.id ?? ctx.nextId("entity"),
      fieldName: ctx.rng.pick(["contact_phone", "redirect_domain_allowlist", "assigned_wallet_id"]),
      oldValue: "old",
      newValue: "new",
      approvalRequestId: null,
      source: ctx.rng.pick(["PORTAL", "ADMIN", "API", "SYSTEM"]),
      requestId: sha256Like(ctx, `detail:${index}`).slice(0, 16),
      clientIp: `203.0.113.${ctx.rng.int(1, 250)}`,
    });
  }
};
