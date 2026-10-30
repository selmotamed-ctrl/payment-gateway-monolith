import type { SeederContext } from "../context";
import { addDays, chance, ensureSystemAccounts, postLedger, sha256Like } from "../builders";

/**
 * Disputes, refund/chargeback adjustments, cash-outs and the negative-balance
 * wallets produced by post-cashout chargebacks (Journal Entry 15).
 */
export const generateDisputesCashoutsAdjustments = (ctx: SeederContext): void => {
  const system = ensureSystemAccounts(ctx);
  const routeInfo = new Map(ctx.refs.routes.map((route) => [route.id, route]));
  const walletAccountByOwner = new Map<string, string>();
  for (const account of [...ctx.dataset.glAccounts, ...ctx.refs.glAccounts]) {
    if (account.accountType === "MERCHANT_WALLET" && account.ownerId) {
      walletAccountByOwner.set(account.ownerId, account.id);
    }
  }
  const walletsByMerchant = new Map(ctx.dataset.wallets.map((wallet) => [wallet.merchantId, wallet]));
  const merchantsById = new Map(ctx.dataset.merchants.map((merchant) => [merchant.id, merchant]));

  const disputedAttempts = ctx.dataset.paymentAttempts.filter((attempt) => attempt.status === "DISPUTED");
  const succeededAttempts = ctx.dataset.paymentAttempts.filter((attempt) => attempt.status === "SUCCEEDED");
  const refundedAttempts = ctx.dataset.paymentAttempts.filter(
    (attempt) => attempt.status === "REFUNDED" || attempt.status === "PARTIALLY_REFUNDED",
  );

  // ------------------------------------------------------------- disputes
  const disputeCount = Math.min(ctx.config.volumes.disputes, disputedAttempts.length + Math.floor(succeededAttempts.length / 40));
  for (let index = 0; index < disputeCount; index += 1) {
    const attempt = index < disputedAttempts.length
      ? disputedAttempts[index]!
      : ctx.rng.pick(succeededAttempts);
    if (!attempt) break;
    const route = routeInfo.get(String(attempt.routeId));
    if (!route) continue;
    const openedAt = addDays(new Date(attempt.createdAt as Date), ctx.rng.int(2, 60));
    if (openedAt > ctx.timeline.end) continue;
    const status = ctx.rng.weighted({
      OPENED: 25,
      EVIDENCE_REQUESTED: 20,
      EVIDENCE_SUBMITTED: 15,
      WON: 15,
      LOST: 10,
      EXPIRED: 10,
      WITHDRAWN: 5,
    });
    ctx.dataset.disputes.push({
      id: ctx.nextId("dispute"),
      createdAt: openedAt,
      updatedAt: ctx.timeline.end,
      attemptId: attempt.id,
      gatewayId: route.gatewayId,
      railId: route.railId,
      externalDisputeRef: `DSP-${ctx.config.namespace}-${sha256Like(ctx, String(attempt.id)).slice(0, 12)}`,
      source: ctx.rng.weighted({ WEBHOOK: 70, STATEMENT: 20, MANUAL: 10 }),
      reasonCode: ctx.rng.pick(["FRAUD", "PRODUCT_NOT_RECEIVED", "DUPLICATE", "AUTHORIZATION_ISSUE", "OTHER"]),
      amount: Number(attempt.settledAmount ?? attempt.totalChargedAmount ?? 0).toFixed(4),
      currency: "LYD",
      status,
      openedAt,
      evidenceDueAt: addDays(openedAt, ctx.rng.int(5, 20)),
      outcomeAt: ["WON", "LOST", "EXPIRED", "WITHDRAWN"].includes(status) ? addDays(openedAt, ctx.rng.int(5, 40)) : null,
      adjustmentId: null,
      evidenceJson: ctx.rng.chance(40) ? { documents: ["receipt.pdf", "delivery-note.pdf"] } : null,
    });
  }

  // ---------------------------------------------------------- adjustments
  const adjustmentTarget = (attempt: any): string | undefined =>
    walletAccountByOwner.get(String(attempt.merchantId));
  const adjustments: any[] = [];
  for (const dispute of ctx.dataset.disputes) {
    const attempt = ctx.dataset.paymentAttempts.find((candidate) => candidate.id === dispute.attemptId);
    if (!attempt) continue;
    const target = adjustmentTarget(attempt);
    if (!target) continue;
    if (!chance(ctx, 75)) continue;
    const adjustmentId = ctx.nextId("adjustment");
    adjustments.push({
      id: adjustmentId,
      createdAt: addDays(new Date(dispute.openedAt as Date), 1),
      updatedAt: ctx.timeline.end,
      type: "CHARGEBACK",
      targetGlAccountId: target,
      sourceAttemptId: attempt.id,
      disputeId: dispute.id,
      draftedBySystem: true,
      amount: dispute.amount,
      reverseCommission: true,
      reason: `Chargeback ${dispute.externalDisputeRef}`,
      externalDisputeRef: dispute.externalDisputeRef,
      providerRefundRef: null,
      state: ctx.rng.weighted({ DRAFT: 10, PENDING_REVIEW: 20, APPROVED: 15, EXECUTING: 10, EXECUTED: 40, REJECTED: 5 }),
      journalEntryId: null,
    });
    dispute.adjustmentId = adjustmentId;
  }
  for (const attempt of refundedAttempts) {
    const target = adjustmentTarget(attempt);
    if (!target) continue;
    if (!chance(ctx, 70)) continue;
    adjustments.push({
      id: ctx.nextId("adjustment"),
      createdAt: addDays(new Date(attempt.createdAt as Date), 2),
      updatedAt: ctx.timeline.end,
      type: "REFUND",
      targetGlAccountId: target,
      sourceAttemptId: attempt.id,
      disputeId: null,
      draftedBySystem: false,
      amount: Number(attempt.settledAmount ?? attempt.totalChargedAmount ?? 0).toFixed(4),
      reverseCommission: true,
      reason: "Merchant-requested refund",
      externalDisputeRef: null,
      providerRefundRef: `RF-${ctx.config.namespace}-${String(attempt.id).slice(-8)}`,
      state: ctx.rng.weighted({ DRAFT: 5, PENDING_REVIEW: 10, APPROVED: 10, EXECUTING: 5, EXECUTED: 65, REJECTED: 5 }),
      journalEntryId: null,
    });
  }
  const manualCount = Math.max(0, ctx.config.volumes.adjustments - adjustments.length);
  for (let index = 0; index < manualCount; index += 1) {
    const attempt = ctx.rng.pick(succeededAttempts);
    if (!attempt) break;
    const target = adjustmentTarget(attempt);
    if (!target) continue;
    adjustments.push({
      id: ctx.nextId("adjustment"),
      createdAt: addDays(new Date(attempt.createdAt as Date), ctx.rng.int(1, 30)),
      updatedAt: ctx.timeline.end,
      type: ctx.rng.pick(["MANUAL_CREDIT", "MANUAL_DEBIT", "CORRECTION"]),
      targetGlAccountId: target,
      sourceAttemptId: attempt.id,
      disputeId: null,
      draftedBySystem: false,
      amount: ctx.rng.decimal(1, 500, 4),
      reverseCommission: false,
      reason: "Manual ledger correction",
      externalDisputeRef: null,
      providerRefundRef: null,
      state: ctx.rng.weighted({ DRAFT: 15, PENDING_REVIEW: 25, APPROVED: 20, EXECUTING: 5, EXECUTED: 30, REJECTED: 5 }),
      journalEntryId: null,
    });
  }
  ctx.dataset.adjustments.push(...adjustments);

  // -------------------------------------------------------------- cashouts
  const activeMerchants = ctx.dataset.merchants.filter((merchant) => merchant.status === "ACTIVE");
  for (let index = 0; index < ctx.config.volumes.cashouts; index += 1) {
    const merchant = ctx.rng.pick(activeMerchants);
    if (!merchant) break;
    const wallet = walletsByMerchant.get(merchant.id);
    if (!wallet) continue;
    const at = addDays(ctx.timeline.end, -ctx.rng.int(0, 400));
    ctx.dataset.cashoutRequests.push({
      id: ctx.nextId("cashout"),
      createdAt: at,
      updatedAt: at,
      merchantId: merchant.id,
      walletId: wallet.id,
      amount: ctx.rng.decimal(50, 25000, 4),
      destinationBankJson: merchant.payoutBankDetailsJson ?? { bank: "Jumhouria Bank", account: "LY00" },
      state: ctx.rng.weighted({ PENDING: 10, REJECTED: 5, PROCESSING: 10, COMPLETE: 45, SUBTRACTED: 30 }),
      adjustmentId: null,
    });
  }

  // ----------------------------- three negative-balance wallets (Entry 15)
  const negativeCandidates = ctx.dataset.wallets.filter((wallet) => wallet.status === "ACTIVE").slice(0, 3);
  for (const wallet of negativeCandidates) {
    const target = walletAccountByOwner.get(String(wallet.merchantId));
    if (!target) continue;
    const at = addDays(ctx.timeline.end, -ctx.rng.int(1, 20));
    postLedger(ctx, {
      refType: "ADJUSTMENT",
      refId: `negative-${wallet.id}`,
      description: "Post-cashout chargeback producing a negative wallet balance",
      at,
      lines: [
        { glAccountId: target, direction: "DEBIT", amount: "45.0000" },
        { glAccountId: system.chargebackReserve, direction: "CREDIT", amount: "45.0000" },
      ],
    });
    const merchant = merchantsById.get(wallet.merchantId);
    if (merchant) merchant.negativeBalanceCeiling = "200.0000";
  }
};
