import type { SeederContext } from "../context";
import { addDays, ensureSystemAccounts, postLedger } from "../builders";

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

  // ---- monthly checkpoints -------------------------------------------------
  const monthKeys: string[] = [];
  const cursor = new Date(ctx.timeline.start);
  cursor.setUTCDate(1);
  cursor.setUTCHours(0, 0, 0, 0);
  while (cursor <= ctx.timeline.end) {
    monthKeys.push(`${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, "0")}`);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  const currentMonth = `${ctx.timeline.end.getUTCFullYear()}-${String(ctx.timeline.end.getUTCMonth() + 1).padStart(2, "0")}`;

  const balances = new Map<string, number>();
  for (const line of ctx.dataset.journalLines) {
    const at = new Date(line.createdAt as Date);
    const key = `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
    const delta = line.direction === "DEBIT" ? Number(line.amount) : -Number(line.amount);
    balances.set(`${key}:${line.glAccountId}`, (balances.get(`${key}:${line.glAccountId}`) ?? 0) + delta);
  }

  const running = new Map<string, number>();
  for (const month of monthKeys) {
    if (month === currentMonth) break;
    for (const account of ctx.refs.glAccounts) {
      const delta = balances.get(`${month}:${account.id}`) ?? 0;
      const next = (running.get(account.id) ?? 0) + delta;
      running.set(account.id, next);
      const at = new Date(`${month}-01T23:59:59.000Z`);
      at.setUTCMonth(at.getUTCMonth() + 1);
      at.setUTCDate(0);
      ctx.checkpoints.set(account.id, {
        balance: next.toFixed(4),
        at,
        lastCheckpointId: `checkpoint-${month}`,
      });
    }
  }

  for (const account of ctx.dataset.glAccounts) {
    const checkpoint = ctx.checkpoints.get(account.id);
    if (checkpoint) {
      account.checkpointBalance = checkpoint.balance;
      account.checkpointAt = checkpoint.at;
      account.lastCheckpointId = checkpoint.lastCheckpointId;
    }
  }
};
