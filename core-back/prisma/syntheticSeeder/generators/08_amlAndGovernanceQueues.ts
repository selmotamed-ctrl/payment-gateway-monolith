import type { SeederContext } from "../context";
import { addDays, addMinutes, chance, sha256Like } from "../builders";

/**
 * The 7-layer AML history and the live back-office queues: screenings, matches,
 * cases, regulatory reports, operator cases, Maker-Checker approvals,
 * notifications, audit logs and detail change logs.
 */
export const generateAmlAndGovernanceQueues = (ctx: SeederContext): void => {
  const operators = ctx.refs.adminUsers.filter((user) => ["OPERATOR", "COMPLIANCE", "MLRO", "FINANCE"].includes(user.role));
  const makers = ctx.refs.adminUsers.filter((user) => user.role === "GATEWAY_ADMIN" || user.role === "FINANCE" || user.role === "COMPLIANCE");
  const checkers = ctx.refs.adminUsers.filter((user) => user.role === "MLRO" || user.role === "COMPLIANCE" || user.role === "FINANCE");
  const pickOperator = () => ctx.rng.pick(operators.length > 0 ? operators : ctx.refs.adminUsers).id;
  const pickMaker = () => ctx.rng.pick(makers.length > 0 ? makers : ctx.refs.adminUsers).id;
  const pickChecker = () => ctx.rng.pick(checkers.length > 0 ? checkers : ctx.refs.adminUsers).id;

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

  // ------------------------------------------------------ operator cases
  const unknownAttempts = ctx.dataset.paymentAttempts.filter((attempt) => attempt.status === "UNKNOWN");
  const mismatchedItems = ctx.dataset.reconciliationItems.filter((item) => item.result !== "MATCHED");
  const caseCount = ctx.config.volumes.operatorCases;
  const usedItems = new Set<string>();
  for (let index = 0; index < caseCount; index += 1) {
    const useUnknown = unknownAttempts.length > 0 && chance(ctx, 55);
    const attempt = useUnknown ? ctx.rng.pick(unknownAttempts) : null;
    const candidateItem = !useUnknown && mismatchedItems.length > 0 ? mismatchedItems[index % mismatchedItems.length] : null;
    const item = candidateItem && !usedItems.has(String(candidateItem.id)) ? candidateItem : null;
    if (item) usedItems.add(String(item.id));
    const kind = item
      ? ctx.rng.pick(["MISMATCH", "UNMATCHED_STATEMENT", "LATE_SUCCESS"])
      : ctx.rng.weighted({ UNKNOWN: 45, HELD: 15, CONFLICT: 15, MANUAL_REVIEW: 20, LATE_SUCCESS: 5 });
    const createdAt = attempt ? addMinutes(new Date(attempt.createdAt as Date), ctx.rng.int(30, 600)) : ctx.timeline.end;
    ctx.dataset.operatorCases.push({
      id: ctx.nextId("operator-case"),
      createdAt,
      updatedAt: ctx.timeline.end,
      attemptId: attempt?.id ?? null,
      reconciliationItemId: item?.id ?? null,
      kind,
      priority: ctx.rng.weighted({ P1: 25, P2: 50, P3: 25 }),
      slaDueAt: addMinutes(createdAt, ctx.rng.int(60, 1440)),
      state: ctx.rng.weighted({ OPEN: 40, IN_PROGRESS: 25, PENDING_CHECKER: 10, RESOLVED: 25 }),
      assigneeUserId: pickOperator(),
      resolutionNotes: null,
      approvalRequestId: null,
    });
    if (item) item.operatorCaseId = ctx.dataset.operatorCases[ctx.dataset.operatorCases.length - 1]!.id;
  }

  // ---------------------------------------------------- approval requests
  const subjectsForApproval = [
    "GatewayVersion", "CommissionProfile", "VelocityRule", "AmlCase", "Adjustment",
    "CashoutRequest", "Merchant", "JoinRequest", "PlatformSetting",
  ];
  for (let index = 0; index < ctx.config.volumes.approvalRequests; index += 1) {
    const pending = index < Math.min(24, ctx.config.volumes.approvalRequests);
    const subjectType = ctx.rng.pick(subjectsForApproval);
    const subjectId = ctx.rng.pick(ctx.dataset.merchants)?.id ?? ctx.nextId("subject");
    const mode = index < 2 ? "EMERGENCY_RATIFICATION" : "STANDARD";
    const makerUserId = pickMaker();
    const checkerPool = checkers.filter((user) => user.id !== makerUserId);
    const checkerUserId = pending
      ? null
      : (checkerPool.length > 0 ? ctx.rng.pick(checkerPool) : ctx.refs.adminUsers.find((user) => user.id !== makerUserId))?.id ?? null;
    ctx.dataset.approvalRequests.push({
      id: ctx.nextId("approval"),
      createdAt: pending ? addDays(ctx.timeline.end, -ctx.rng.int(0, 2)) : addDays(ctx.timeline.start, ctx.rng.int(0, 1000)),
      updatedAt: ctx.timeline.end,
      subjectType,
      subjectId,
      payloadDiffJson: { field: "status", from: "PENDING", to: "ACTIVE" },
      mode,
      baseVersion: 1,
      expiresAt: addDays(ctx.timeline.end, 7),
      ratifyDueAt: mode === "EMERGENCY_RATIFICATION" ? addDays(ctx.timeline.end, 1) : null,
      makerUserId,
      checkerUserId,
      state: pending
        ? (mode === "EMERGENCY_RATIFICATION" ? "PENDING_REVIEW" : ctx.rng.chance(50) ? "PENDING_REVIEW" : "DRAFT")
        : ctx.rng.weighted({ APPROVED: 20, EXECUTED: 55, REJECTED: 25 }),
      rejectionReason: null,
      riskAcceptanceNote: null,
    });
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
