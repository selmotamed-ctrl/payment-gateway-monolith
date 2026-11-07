import { Decimal } from "decimal.js";
import {
  buildLedgerTemplate,
  buildPaymentConfirmationTemplate,
  decimal,
  type LedgerPostContext,
} from "../../../engine/ledger/LedgerPoster";
import { clampShardWidth, initialShardWidth, routeLine, shardKey } from "../../../lib/storageEngine/shardRouting";
import { metaOf, type SeederContext } from "../context";
import { addMinutes, ensureSystemAccounts, postTemplate } from "../builders";

/** Resolves the posting context the engine builds for an attempt (`ledgerContext`). */
const contextOf = (attempt: Record<string, unknown>, walletGlAccountId: string): LedgerPostContext => ({
  merchantId: String(attempt.merchantId),
  credentialSetId: String(attempt.credentialSetId),
  env: String(attempt.env),
  currency: String(attempt.currency),
  accounts: { MERCHANT_WALLET: walletGlAccountId },
});

const SLA_HOURS: Record<string, number> = { CRITICAL: 4, HIGH: 24, MEDIUM: 72, LOW: 120 };

/**
 * Posts every ledger movement of the generated attempts through the ENGINE's
 * own journal templates (`buildPaymentConfirmationTemplate` /
 * `buildLedgerTemplate`) and creates the AML hold cases that own the
 * escrowed payments. Refunds, chargebacks and cash-outs are posted by
 * generator 07; the monthly checkpoints are taken last (`generateCheckpoints`).
 */
export const generateLedger = (ctx: SeederContext): void => {
  const meta = metaOf(ctx);
  ensureSystemAccounts(ctx);
  const compliance = ctx.dataset.users.filter((user) => user.merchantId === null && user.status === "ACTIVE" && ["COMPLIANCE", "MLRO"].includes(user.role));
  const amlRule = ctx.dataset.amlRules.find((rule) => rule.ruleType === "SINGLE_AMOUNT");

  for (const attempt of ctx.dataset.paymentAttempts) {
    const info = meta.attempts.get(String(attempt.id));
    if (!info) continue;
    const accountsContext = contextOf(attempt, info.walletGlAccountId);
    const requested = decimal(String(attempt.requestedAmount));
    const total = decimal(String(attempt.totalChargedAmount));
    const commission = decimal(String(attempt.platformCommissionAmount));
    const net = decimal(String(attempt.netMerchantAmount));
    const fee = attempt.gatewayFeeAmount === null ? undefined : decimal(String(attempt.gatewayFeeAmount));
    const createdAt = new Date(attempt.createdAt as Date);
    const terminalAt = attempt.terminalAt ? new Date(attempt.terminalAt as Date) : null;

    const confirm = (at: Date): string =>
      postTemplate(ctx, {
        ...buildPaymentConfirmationTemplate({
          ownershipMode: info.ownershipMode,
          feeBearer: attempt.feeBearer as "MERCHANT_ABSORBS" | "PAYER_SURCHARGE" | "SPLIT",
          feeAccrual: info.feeAccrual,
          amount: requested,
          surchargeAmount: decimal(String(attempt.surchargeAmount)),
          commissionAmount: commission,
          merchantAmount: net,
          ...(fee === undefined ? {} : { gatewayFeeAmount: fee, providerFeeAmount: fee }),
        }),
        refId: String(attempt.id),
      }, accountsContext, at);

    const isAml = info.kind === "AML_HELD" || info.kind === "AML_RELEASED" || info.kind === "AML_VOIDED";
    if (isAml) {
      // Guard pipeline: Dr GATEWAY_CLEARING / Cr AML_HOLD at attempt creation.
      const hold = { ...buildLedgerTemplate("AML_HOLD_AND_RELEASE", { amount: total, commissionAmount: 0, merchantAmount: 0 }), refId: String(attempt.id) };
      const holdEntryId = postTemplate(ctx, hold, accountsContext, createdAt);
      info.holdEntryId = holdEntryId;
      const severity = amlRule ? String(amlRule.baseSeverity) : "HIGH";
      const resolvedAt = terminalAt;
      let status = info.kind === "AML_RELEASED" ? "RELEASED" : info.kind === "AML_VOIDED" ? "REJECTED_VOID" : ctx.rng.weighted({ OPEN: 30, IN_REVIEW: 25, PENDING_CHECKER: 20, FROZEN: 8, ESCALATED_STR: 17 }) as string;
      const assignee = status === "OPEN" && ctx.rng.chance(40) ? null : compliance[Math.floor(ctx.rng.next() * compliance.length)] ?? null;
      const caseUpdated = resolvedAt ?? addMinutes(createdAt, ctx.rng.int(5, 600));
      info.amlCaseStatus = status;
      info.amlSeverity = severity;
      if (info.kind === "AML_RELEASED") {
        // AML_HOLD_AND_RELEASE (RELEASE): Dr AML_HOLD / Cr wallet + income. The
        // attempt's ledger entry is the release posting (finalizeAmlAttempt).
        const release = {
          ...buildLedgerTemplate("AML_HOLD_AND_RELEASE", { amount: total, commissionAmount: commission, merchantAmount: total.minus(commission), stage: "RELEASE" }),
          refId: String(attempt.id),
        };
        attempt.ledgerEntryId = postTemplate(ctx, release, accountsContext, resolvedAt!);
      } else if (info.kind === "AML_VOIDED") {
        const voided = { ...buildLedgerTemplate("AML_VOID", { amount: total }), refId: String(attempt.id) };
        postTemplate(ctx, voided, accountsContext, resolvedAt!);
      }
      ctx.dataset.amlCases.push({
        id: ctx.nextId("aml-case"),
        createdAt,
        updatedAt: caseUpdated,
        subjectType: "PAYMENT_ATTEMPT",
        subjectId: attempt.id,
        triggerReason: `AML_RULE:${amlRule?.code ?? "AML-SINGLE-LARGE"}`,
        severity,
        severityInputsJson: [{ rule: amlRule?.code ?? "AML-SINGLE-LARGE", amount: total.toFixed(4), currency: "LYD" }],
        screeningId: null,
        ruleId: amlRule?.id ?? null,
        ruleVersion: amlRule ? 1 : null,
        holdJournalEntryId: holdEntryId,
        status,
        slaDueAt: addMinutes(createdAt, (SLA_HOURS[severity] ?? 24) * 60),
        assignedReviewerId: assignee?.id ?? null,
        regulatoryReportId: null,
        confidential: true,
        reviewerNotes: status === "RELEASED" ? "Source of funds verified; released." : status === "REJECTED_VOID" ? "Could not verify the source of funds; voided." : status === "PENDING_CHECKER" ? "Proposed release; awaiting MLRO." : null,
      });
      status = "";
      continue;
    }

    if (info.kind === "SUSPENSE") {
      // Slot already used by the winner: the money is parked in SUSPENSE.
      const template = {
        ...buildLedgerTemplate("SUSPENSE_SETTLEMENT", { amount: total, ownershipMode: info.ownershipMode }),
        refId: String(attempt.id),
      };
      attempt.ledgerEntryId = postTemplate(ctx, template, accountsContext, terminalAt!);
      const suspense = ctx.refs.glAccounts.find((account) => account.accountType === "SUSPENSE" && !account.gatewayId)!;
      ctx.dataset.adjustments.push({
        id: ctx.nextId("adjustment"),
        createdAt: terminalAt,
        updatedAt: terminalAt,
        type: "REFUND",
        targetGlAccountId: suspense.id,
        sourceAttemptId: attempt.id,
        disputeId: null,
        draftedBySystem: true,
        amount: total.toFixed(4),
        reverseCommission: false,
        reason: `Automatic refund draft: the settlement of attempt ${attempt.id} was routed to SUSPENSE because the payment link slot was already used.`,
        externalDisputeRef: null,
        providerRefundRef: null,
        state: "PENDING_REVIEW",
        journalEntryId: null,
      });
      continue;
    }

    if (String(attempt.status) === "SUCCEEDED" && terminalAt) {
      attempt.ledgerEntryId = confirm(terminalAt);
    }
  }
};

/**
 * Sequences the ledger per shard and takes the month-end shard checkpoints. Runs AFTER every posting of
 * every generator, so the sequence is final.
 *
 *  1. Every line is routed with the engine's own `routeLine(accountType, direction, refId, width)` using the
 *     account's routing width (`shardCount`; wallets are 1 wide, system accounts 16).
 *  2. Lines are put in POSTING ORDER: ascending `createdAt`, ties broken by their position in
 *     `dataset.journalLines` (generation order). That order is deterministic because the seeder is.
 *     Within a shard the j-th line in that order gets `shardSeq = j` (gapless, from 1), and the shard's
 *     `lineSeq` is its line count; its `currentBalance` is the signed (debit-positive) sum.
 *  3. The checkpoint cut is the end of the last COMPLETE UTC month. Because the sequence follows `createdAt`,
 *     the lines of a shard with `createdAt <= cut` are a PREFIX of its sequence: `checkpoint_seq` is their count,
 *     `checkpoint_balance` their signed sum, `checkpoint_at` the cut. Every shard (also an empty one) gets a
 *     checkpoint, so the proof `balance == checkpoint + SUM(lines after seq)` can be run for all of them.
 */
export const generateCheckpoints = (ctx: SeederContext): void => {
  const accountTypeById = new Map<string, string>();
  const widthById = new Map<string, number>();
  for (const account of ctx.refs.glAccounts) {
    accountTypeById.set(String(account.id), String(account.accountType));
    widthById.set(String(account.id), clampShardWidth(account.shardCount ?? initialShardWidth(String(account.accountType))));
  }
  for (const account of ctx.dataset.glAccounts) {
    const type = String(account.accountType);
    accountTypeById.set(String(account.id), type);
    widthById.set(String(account.id), clampShardWidth(Number(account.shardCount ?? initialShardWidth(type))));
  }
  const refIdByEntry = new Map<string, string>();
  for (const entry of ctx.dataset.journalEntries) refIdByEntry.set(String(entry.id), String(entry.refId));

  // Posting order: createdAt, then generation order (the stable index tie-break).
  const lines = ctx.dataset.journalLines;
  const order = lines.map((_line, index) => index);
  order.sort((left, right) => {
    const delta = (lines[left]!.createdAt as Date).getTime() - (lines[right]!.createdAt as Date).getTime();
    return delta !== 0 ? delta : left - right;
  });

  // Checkpoint = end of the last complete month (UTC), the same instant for every shard.
  const end = ctx.timeline.end;
  const checkpointAt = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1) - 1);
  const cutMs = checkpointAt.getTime();

  interface ShardState { glAccountId: string; shardId: number; balance: Decimal; seq: number; cpBalance: Decimal; cpSeq: number }
  const shards = new Map<string, ShardState>();
  const shardOf = (glAccountId: string, shardId: number): ShardState => {
    const key = shardKey(glAccountId, shardId);
    let state = shards.get(key);
    if (!state) {
      state = { glAccountId, shardId, balance: new Decimal(0), seq: 0, cpBalance: new Decimal(0), cpSeq: 0 };
      shards.set(key, state);
    }
    return state;
  };
  // Every shard of every account exists (the DB creates 0..width-1), also when it has no line.
  for (const [glAccountId, width] of widthById) for (let shardId = 0; shardId < width; shardId += 1) shardOf(glAccountId, shardId);

  for (const index of order) {
    const line = lines[index]!;
    const glAccountId = String(line.glAccountId);
    const accountType = accountTypeById.get(glAccountId);
    if (!accountType) throw new Error(`Synthetic journal line ${line.id} points to an unknown GL account ${glAccountId}`);
    const refId = refIdByEntry.get(String(line.entryId)) ?? String(line.entryId);
    const shardId = routeLine(accountType, line.direction as "DEBIT" | "CREDIT", refId, widthById.get(glAccountId)!);
    const state = shardOf(glAccountId, shardId);
    const amount = decimal(String(line.amount));
    const signed = line.direction === "DEBIT" ? amount : amount.neg();
    state.seq += 1;
    state.balance = state.balance.plus(signed);
    line.shardId = shardId;
    line.shardSeq = state.seq;
    if ((line.createdAt as Date).getTime() <= cutMs) {
      state.cpSeq = state.seq;
      state.cpBalance = state.cpBalance.plus(signed);
    }
  }

  ctx.dataset.glAccountShards.length = 0;
  ctx.checkpoints.clear();
  const sorted = [...shards.values()].sort((a, b) => (a.glAccountId < b.glAccountId ? -1 : a.glAccountId > b.glAccountId ? 1 : a.shardId - b.shardId));
  for (const shard of sorted) {
    ctx.dataset.glAccountShards.push({
      glAccountId: shard.glAccountId,
      shardId: shard.shardId,
      currentBalance: shard.balance.toFixed(4),
      lineSeq: shard.seq,
      updatedAt: ctx.timeline.end,
    });
    ctx.checkpoints.set(shardKey(shard.glAccountId, shard.shardId), {
      glAccountId: shard.glAccountId,
      shardId: shard.shardId,
      balance: shard.cpBalance.toFixed(4),
      seq: shard.cpSeq,
      at: checkpointAt,
    });
  }
};

/** Kept for callers of the old name. */
export const generateLedgerAndCheckpoints = (ctx: SeederContext): void => {
  generateLedger(ctx);
  generateCheckpoints(ctx);
};
