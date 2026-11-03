import type { SeederContext } from "../context";
import { addDays, ensureSystemAccounts, postLedger } from "../builders";

/**
 * Posts every financial event through balanced double-entry templates. The
 * writer rebuilds the materialized account balances and shards after the bulk
 * journal-line insert; this generator only produces the append-only ledger.
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

  // Balances are materialized after the bulk journal-line insert by the
  // writer. The generator only keeps the append-only ledger rows here.

};
