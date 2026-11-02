import type { SeederContext } from "../context";
import { addDays, ensureSystemAccounts, postLedger } from "../builders";

const monthKey = (date: Date): string =>
  `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;

interface AccountLedgerState {
  total: number;
  postDelta: number;
  postLines: number;
  lineCount: number;
  lastHistoricId: string;
}

/**
 * Rebuilds the O(1) ledger fields after all journal lines have been posted.
 *
 * Journal-line ids are re-keyed in chronological order first so the
 * collision-free id cursor (`l.id > g.last_checkpoint_id`) and the historical
 * balance window (`l.created_at > g.checkpoint_at`) always describe exactly
 * the same set of lines.
 */
export const finalizeLedgerBalances = (ctx: SeederContext): void => {
  const lines = ctx.dataset.journalLines;
  lines.sort((left, right) => {
    const delta = new Date(left.createdAt as Date).getTime() - new Date(right.createdAt as Date).getTime();
    return delta !== 0 ? delta : String(left.id).localeCompare(String(right.id));
  });
  for (const line of lines) {
    line.id = ctx.nextId("journal-line");
  }

  const startMonth = monthKey(ctx.timeline.start);
  const endMonth = monthKey(ctx.timeline.end);
  const checkpointAt = startMonth < endMonth
    ? new Date(Date.UTC(ctx.timeline.end.getUTCFullYear(), ctx.timeline.end.getUTCMonth(), 0, 23, 59, 59, 0))
    : null;

  const accountIds = new Set<string>();
  for (const account of ctx.refs.glAccounts) accountIds.add(String(account.id));
  for (const account of ctx.dataset.glAccounts) accountIds.add(String(account.id));

  const states = new Map<string, AccountLedgerState>();
  for (const accountId of accountIds) {
    states.set(accountId, { total: 0, postDelta: 0, postLines: 0, lineCount: 0, lastHistoricId: "" });
  }

  for (const line of lines) {
    const accountId = String(line.glAccountId);
    const state = states.get(accountId);
    if (!state) continue;
    const at = new Date(line.createdAt as Date);
    const delta = line.direction === "DEBIT" ? Number(line.amount) : -Number(line.amount);
    state.total += delta;
    state.lineCount += 1;
    if (checkpointAt && at.getTime() > checkpointAt.getTime()) {
      state.postDelta += delta;
      state.postLines += 1;
    } else if (checkpointAt) {
      state.lastHistoricId = String(line.id);
    }
  }

  ctx.checkpoints.clear();
  if (checkpointAt) {
    for (const [accountId, state] of states) {
      ctx.checkpoints.set(accountId, {
        balance: (state.total - state.postDelta).toFixed(4),
        at: checkpointAt,
        lastCheckpointId: state.lastHistoricId,
      });
    }
  }

  const datasetAccounts = new Map(ctx.dataset.glAccounts.map((account) => [String(account.id), account]));
  for (const [accountId, state] of states) {
    const account = datasetAccounts.get(accountId);
    if (!account) continue;
    const checkpoint = checkpointAt ? ctx.checkpoints.get(accountId) : undefined;
    account.checkpointBalance = checkpoint?.balance ?? "0.0000";
    account.checkpointAt = checkpointAt;
    account.lastCheckpointId = checkpoint?.lastCheckpointId || null;
    account.currentBalance = state.total.toFixed(4);
    account.linesSinceCheckpoint = checkpointAt ? state.postLines : state.lineCount;
  }
};

/**
 * Posts every financial event through balanced double-entry templates and
 * snapshots the historical months into `gl_accounts.checkpoint_balance`.
 *
 * October 2026 (the current month) stays post-checkpoint, so the live balance
 * formula `checkpoint_balance + SUM(lines > last_checkpoint_id)` is exercised.
 */
export const generateLedgerAndCheckpoints = (ctx: SeederContext): void => {
  const system = ensureSystemAccounts(ctx);
  const walletAccountByOwner = new Map<string, string>();
  for (const account of ctx.dataset.glAccounts) {
    if (account.accountType === "MERCHANT_WALLET" && account.ownerId) {
      walletAccountByOwner.set(account.ownerId, account.id);
    }
  }
  for (const account of ctx.refs.glAccounts) {
    if (account.accountType === "MERCHANT_WALLET" && account.ownerId && !walletAccountByOwner.has(account.ownerId)) {
      walletAccountByOwner.set(account.ownerId, account.id);
    }
  }

  const routeGateway = new Map(ctx.refs.routes.map((route) => [route.id, route.gatewayId]));
  for (const attempt of ctx.dataset.paymentAttempts) {
    const status = String(attempt.status);
    if (!["SUCCEEDED", "REFUNDED", "PARTIALLY_REFUNDED", "DISPUTED"].includes(status)) continue;
    const walletAccount = walletAccountByOwner.get(String(attempt.merchantId));
    const gatewayId = routeGateway.get(String(attempt.routeId)) ?? "";
    const clearingId = system.clearing.get(`${gatewayId}:${attempt.env}`)
      ?? system.clearing.values().next().value;
    if (!walletAccount || !clearingId) continue;

    const total = Number(attempt.settledAmount ?? attempt.totalChargedAmount ?? 0);
    const commission = Number(attempt.platformCommissionAmount ?? 0);
    const gatewayFee = Number(attempt.gatewayFeeAmount ?? 0);
    const net = Number((total - commission - gatewayFee).toFixed(4));
    const at = new Date(attempt.createdAt as Date);

    if (status === "SUCCEEDED" || status === "REFUNDED" || status === "PARTIALLY_REFUNDED" || status === "DISPUTED") {
      const entryId = postLedger(ctx, {
        refType: "PAYMENT_ATTEMPT",
        refId: String(attempt.id),
        description: `Synthetic payment ${attempt.reference}`,
        at,
        lines: [
          { glAccountId: clearingId, direction: "DEBIT", amount: total.toFixed(4) },
          { glAccountId: walletAccount, direction: "CREDIT", amount: net.toFixed(4) },
          { glAccountId: system.platformIncome, direction: "CREDIT", amount: commission.toFixed(4) },
          { glAccountId: system.gatewayFeeAccrual, direction: "CREDIT", amount: gatewayFee.toFixed(4) },
        ],
      });
      attempt.ledgerEntryId = entryId;
    }

    if (status === "REFUNDED") {
      postLedger(ctx, {
        refType: "ADJUSTMENT",
        refId: `${attempt.id}-refund`,
        description: `Synthetic full refund ${attempt.reference}`,
        at: addDays(at, 2),
        lines: [
          { glAccountId: walletAccount, direction: "DEBIT", amount: total.toFixed(4) },
          { glAccountId: clearingId, direction: "CREDIT", amount: total.toFixed(4) },
        ],
      });
    } else if (status === "PARTIALLY_REFUNDED") {
      const half = Number((total / 2).toFixed(4));
      postLedger(ctx, {
        refType: "ADJUSTMENT",
        refId: `${attempt.id}-partial-refund`,
        description: `Synthetic partial refund ${attempt.reference}`,
        at: addDays(at, 2),
        lines: [
          { glAccountId: walletAccount, direction: "DEBIT", amount: half.toFixed(4) },
          { glAccountId: clearingId, direction: "CREDIT", amount: half.toFixed(4) },
        ],
      });
    } else if (status === "DISPUTED") {
      postLedger(ctx, {
        refType: "ADJUSTMENT",
        refId: `${attempt.id}-chargeback`,
        description: `Synthetic chargeback reserve ${attempt.reference}`,
        at: addDays(at, 5),
        lines: [
          { glAccountId: system.chargebackReserve, direction: "DEBIT", amount: total.toFixed(4) },
          { glAccountId: walletAccount, direction: "CREDIT", amount: total.toFixed(4) },
        ],
      });
    }
  }

  finalizeLedgerBalances(ctx);
};
