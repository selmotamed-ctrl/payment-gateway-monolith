import { Decimal } from "decimal.js";
import { lockWalletLedgerBalance, openCashoutTotal } from "../../lib/cashoutBalance";
import { buildLedgerTemplate, type JournalTemplate, type LedgerPostContext, type LedgerPoster } from "./LedgerPoster";
import { writeSystemAudit } from "./ledgerAlerts";

type Any = Record<string, any>;

/**
 * Merchant-direct commission netting (AUTO-21, decision D8).
 *
 * A MERCHANT_DIRECT payment settles on the merchant's own gateway account: the platform never holds the cash, so its
 * commission is booked as a receivable (`Dr COMMISSION_RECEIVABLE / Cr PLATFORM_INCOME`). The receivable is collected
 * from the merchant's wallet balance with the existing NETTING stage of the MERCHANT_DIRECT_CONFIRMATION template
 * (`Dr MERCHANT_WALLET / Cr COMMISSION_RECEIVABLE`):
 *
 *   netted = min(receivable, max(0, wallet balance - open cash-outs))
 *
 * never below zero, partial when the wallet does not cover it; the remainder stays receivable and is carried forward.
 * It runs daily after the Tripoli day close (CommissionNettingWorker) and before a cash-out is approved
 * (`executeCashout`). A netting entry is keyed `netting:<merchantId>:<runKey>:<receivableAccountId>`, so a repeated
 * run of the same day (or the same cash-out) never nets twice; the merchant's receivable query attributes these
 * entries to the merchant by that prefix.
 *
 * The wallet is read under its debit lock (`lockWalletLedgerBalance`) with the netting posting's shard rows locked in
 * the global order first, exactly like a cash-out, so a concurrent cash-out or chargeback cannot spend the same money.
 */

export type NettingTrigger = "DAILY" | "CASHOUT";

export const nettingRefPrefix = (merchantId: string): string => `netting:${merchantId}:`;

export const nettingRefId = (merchantId: string, runKey: string, receivableAccountId: string): string =>
  `${nettingRefPrefix(merchantId)}${runKey}:${receivableAccountId}`;

const ZERO = new Decimal(0);

/** min(receivable, max(0, wallet - open cash-outs)), truncated to 4 decimals, never negative. */
export const computeNettingAmount = (input: { receivable: Decimal; walletBalance: Decimal; openCashouts: Decimal }): Decimal => {
  if (!input.receivable.gt(0)) return ZERO;
  const available = Decimal.max(ZERO, input.walletBalance.minus(input.openCashouts));
  return Decimal.min(input.receivable, available).toDecimalPlaces(4, Decimal.ROUND_DOWN);
};

/** The receivable of one merchant on one COMMISSION_RECEIVABLE account. */
export interface ReceivableBucket {
  merchantId: string;
  receivableAccountId: string;
  currency: string;
  receivable: Decimal;
  /** Receivable recognised (commission booked) on or after the aging cutoff. Anything above it is older (FIFO). */
  recentRecognised: Decimal;
}

export interface NettingWallet {
  walletId: string;
  glAccountId: string;
  status: string;
}

/** Everything the netting needs from the database. The Prisma implementation is `prismaCommissionNettingStore`. */
export interface CommissionNettingStore {
  /** All merchants with a positive receivable, grouped by receivable account, merchant id order. */
  listReceivables(db: Any, input: { agingCutoff: Date; limit: number }): Promise<ReceivableBucket[]>;
  /** The receivable of one merchant on one receivable account, or on every account of `currency`. */
  receivablesOf(tx: Any, merchantId: string, filter: { receivableAccountId?: string; currency?: string }): Promise<Array<{ receivableAccountId: string; currency: string; receivable: Decimal }>>;
  /** The merchant's total receivable (what the PAUSE guard compares with the ceiling). */
  merchantReceivable(db: Any, merchantId: string): Promise<Decimal>;
  merchantCeiling(db: Any, merchantId: string): Promise<{ ceiling: Decimal | null; status: string } | null>;
  /** The merchant's wallet in `currency` (the oldest one when several exist). */
  findWallet(tx: Any, merchantId: string, currency: string): Promise<NettingWallet | null>;
  /** Takes the wallet's debit lock (after `lockShards`) and returns its balance, credit positive. */
  lockWalletBalance(tx: Any, glAccountId: string, lockShards: () => Promise<void>): Promise<Decimal>;
  openCashouts(tx: Any, walletId: string): Promise<Decimal>;
  entryExists(tx: Any, refId: string): Promise<boolean>;
}

export type NettingAuditFn = (db: Any, input: { action: string; entityType: string; entityId: string; before?: unknown; after?: unknown }) => Promise<void>;

export interface NetReceivableInput {
  merchantId: string;
  receivableAccountId: string;
  currency: string;
  runKey: string;
  trigger: NettingTrigger;
  dryRun: boolean;
}

export type NetReceivableStatus =
  | "NETTED"
  | "PROPOSED"
  | "ALREADY_NETTED"
  | "NOTHING_OWED"
  | "NO_WALLET"
  | "WALLET_NOT_ACTIVE"
  | "NO_AVAILABLE_BALANCE";

export interface NetReceivableResult {
  status: NetReceivableStatus;
  receivable: Decimal;
  amount: Decimal;
  /** What stays receivable after this netting (after the PROPOSED amount in a dry run). */
  remainder: Decimal;
  journalEntryId?: string;
}

const nettingTemplate = (refId: string, amount: Decimal): JournalTemplate => {
  const template = buildLedgerTemplate("MERCHANT_DIRECT_CONFIRMATION", { amount, commissionAmount: amount, stage: "NETTING" });
  template.refId = refId;
  return template;
};

const nettingContext = (input: { merchantId: string; currency: string; walletGlAccountId: string; receivableAccountId: string }): LedgerPostContext => ({
  merchantId: input.merchantId,
  currency: input.currency,
  accounts: { MERCHANT_WALLET: input.walletGlAccountId, COMMISSION_RECEIVABLE: input.receivableAccountId },
});

export interface CommissionNettingServiceOptions {
  poster: Pick<LedgerPoster, "post" | "lockShardsFor">;
  store?: CommissionNettingStore;
  audit?: NettingAuditFn;
}

/**
 * Nets one merchant's receivable on one receivable account against its wallet of the same currency. Must run inside
 * a transaction (`tx`): the wallet lock, the balance read and the posting commit together.
 */
export const netMerchantReceivable = async (
  tx: Any,
  options: CommissionNettingServiceOptions,
  input: NetReceivableInput,
): Promise<NetReceivableResult> => {
  const store = options.store ?? prismaCommissionNettingStore;
  const audit = options.audit ?? writeSystemAudit;
  const refId = nettingRefId(input.merchantId, input.runKey, input.receivableAccountId);
  const none = (status: NetReceivableStatus, receivable: Decimal): NetReceivableResult => ({ status, receivable, amount: ZERO, remainder: receivable });

  if (await store.entryExists(tx, refId)) return none("ALREADY_NETTED", ZERO);
  const [bucket] = await store.receivablesOf(tx, input.merchantId, { receivableAccountId: input.receivableAccountId });
  const receivable = bucket?.receivable ?? ZERO;
  if (!receivable.gt(0)) return none("NOTHING_OWED", receivable);
  const wallet = await store.findWallet(tx, input.merchantId, input.currency);
  if (!wallet) return none("NO_WALLET", receivable);
  if (wallet.status !== "ACTIVE") return none("WALLET_NOT_ACTIVE", receivable);

  const context = nettingContext({ ...input, walletGlAccountId: wallet.glAccountId });
  // The rows the posting will touch are locked in the global order BEFORE the wallet balance is read (the amount
  // does not change which rows: the wallet debit always goes to shard 0, the receivable shard follows the refId).
  const walletBalance = await store.lockWalletBalance(tx, wallet.glAccountId, () =>
    options.poster.lockShardsFor(nettingTemplate(refId, receivable), context, tx as never),
  );
  const openCashouts = await store.openCashouts(tx, wallet.walletId);
  const amount = computeNettingAmount({ receivable, walletBalance, openCashouts });
  const details = {
    trigger: input.trigger,
    runKey: input.runKey,
    currency: input.currency,
    receivableAccountId: input.receivableAccountId,
    walletId: wallet.walletId,
    receivable: receivable.toFixed(4),
    walletBalance: walletBalance.toFixed(4),
    openCashouts: openCashouts.toFixed(4),
  };
  if (!amount.gt(0)) return none("NO_AVAILABLE_BALANCE", receivable);
  const remainder = receivable.minus(amount);

  if (input.dryRun) {
    await audit(tx, {
      action: "COMMISSION_NETTING_PROPOSED",
      entityType: "MERCHANT",
      entityId: input.merchantId,
      after: { ...details, amount: amount.toFixed(4), remainder: remainder.toFixed(4), dryRun: true },
    });
    return { status: "PROPOSED", receivable, amount, remainder };
  }

  const posted = await options.poster.post(nettingTemplate(refId, amount), context, tx as never);
  if (!posted.created) return none("ALREADY_NETTED", ZERO);
  await audit(tx, {
    action: "COMMISSION_NETTED",
    entityType: "MERCHANT",
    entityId: input.merchantId,
    before: { receivable: receivable.toFixed(4) },
    after: { ...details, amount: amount.toFixed(4), remainder: remainder.toFixed(4), journalEntryId: posted.entry.id },
  });
  return { status: "NETTED", receivable, amount, remainder, journalEntryId: posted.entry.id };
};

// ---------------------------------------------------------------------------------------------
// Cash-out time netting (hooked into executeCashout)
// ---------------------------------------------------------------------------------------------

export interface CashoutNettingInput {
  merchantId: string;
  walletId: string;
  walletGlAccountId: string;
  currency: string;
  cashoutId: string;
}

export interface PreparedCashoutNetting {
  /** The netting postings whose shard rows must be locked together with the cash-out's, in one statement. */
  lockTemplates: Array<{ template: JournalTemplate; context: LedgerPostContext }>;
  /**
   * Nets with the wallet balance read under those locks. The cash-out being approved is already PROCESSING, so it
   * counts among the open cash-outs: netting never takes money a cash-out reserved. Returns the amount netted.
   */
  apply(tx: Any, walletBalance: Decimal): Promise<Decimal>;
}

/** What `executeCashout` calls; `GovernanceExecutionContext.commissionNetting`. */
export interface CashoutCommissionNetting {
  prepare(tx: Any, input: CashoutNettingInput): Promise<PreparedCashoutNetting | null>;
}

export const createCashoutCommissionNetting = (
  options: CommissionNettingServiceOptions & { dryRun?: boolean },
): CashoutCommissionNetting => {
  const store = options.store ?? prismaCommissionNettingStore;
  const audit = options.audit ?? writeSystemAudit;
  const dryRun = options.dryRun ?? true;
  return {
    async prepare(tx, input) {
      const runKey = `cashout:${input.cashoutId}`;
      const buckets = (await store.receivablesOf(tx, input.merchantId, { currency: input.currency })).filter((bucket) => bucket.receivable.gt(0));
      const pending: Array<{ refId: string; receivableAccountId: string; receivable: Decimal; context: LedgerPostContext }> = [];
      for (const bucket of buckets) {
        const refId = nettingRefId(input.merchantId, runKey, bucket.receivableAccountId);
        if (await store.entryExists(tx, refId)) continue;
        pending.push({
          refId,
          receivableAccountId: bucket.receivableAccountId,
          receivable: bucket.receivable,
          context: nettingContext({ ...input, receivableAccountId: bucket.receivableAccountId }),
        });
      }
      if (pending.length === 0) return null;
      return {
        lockTemplates: pending.map((item) => ({ template: nettingTemplate(item.refId, item.receivable), context: item.context })),
        async apply(applyTx, walletBalance) {
          const openCashouts = await store.openCashouts(applyTx, input.walletId);
          let available = Decimal.max(ZERO, walletBalance.minus(openCashouts));
          let netted = ZERO;
          for (const item of pending) {
            const amount = computeNettingAmount({ receivable: item.receivable, walletBalance: available, openCashouts: ZERO });
            if (!amount.gt(0)) break;
            const details = {
              trigger: "CASHOUT",
              runKey,
              cashoutId: input.cashoutId,
              currency: input.currency,
              receivableAccountId: item.receivableAccountId,
              walletId: input.walletId,
              receivable: item.receivable.toFixed(4),
              walletBalance: walletBalance.toFixed(4),
              openCashouts: openCashouts.toFixed(4),
              amount: amount.toFixed(4),
              remainder: item.receivable.minus(amount).toFixed(4),
            };
            if (dryRun) {
              await audit(applyTx, { action: "COMMISSION_NETTING_PROPOSED", entityType: "MERCHANT", entityId: input.merchantId, after: { ...details, dryRun: true } });
              available = available.minus(amount); // what the next receivable account could still take
              continue;
            }
            const posted = await options.poster.post(nettingTemplate(item.refId, amount), item.context, applyTx as never);
            if (!posted.created) continue;
            await audit(applyTx, {
              action: "COMMISSION_NETTED",
              entityType: "MERCHANT",
              entityId: input.merchantId,
              before: { receivable: item.receivable.toFixed(4) },
              after: { ...details, journalEntryId: posted.entry.id },
            });
            available = available.minus(amount);
            netted = netted.plus(amount);
          }
          return netted;
        },
      };
    },
  };
};

// ---------------------------------------------------------------------------------------------
// Prisma store
// ---------------------------------------------------------------------------------------------

/**
 * Every movement of COMMISSION_RECEIVABLE attributed to a merchant: recognitions and attempt-keyed netting (by the
 * attempt), refund reversals (by the adjustment's source attempt) and merchant-level netting (by the ref prefix).
 * `$merchant` filters to one merchant when the placeholder is given, otherwise every merchant is returned.
 */
const movementSql = (merchantParam: string | null): string => {
  const byAttempt = merchantParam ? `AND pa.merchant_id = ${merchantParam}::uuid` : "";
  const byPrefix = merchantParam ? `AND starts_with(je.ref_id, 'netting:' || ${merchantParam}::text || ':')` : "AND je.ref_id LIKE 'netting:%'";
  return `
    SELECT pa.merchant_id::text AS merchant_id, jl.gl_account_id::text AS account_id, a.currency::text AS currency,
           je.created_at, je.ref_type::text AS ref_type,
           CASE WHEN jl.direction = 'DEBIT' THEN jl.amount ELSE -jl.amount END AS delta
    FROM journal_lines jl
    INNER JOIN gl_accounts a ON a.id = jl.gl_account_id
    INNER JOIN journal_entries je ON je.id = jl.entry_id
    INNER JOIN payment_attempts pa ON je.ref_id = pa.id::text
    WHERE a.account_type = 'COMMISSION_RECEIVABLE' AND je.ref_type IN ('PAYMENT_ATTEMPT', 'COMMISSION_NETTING') ${byAttempt}
    UNION ALL
    SELECT pa.merchant_id::text, jl.gl_account_id::text, a.currency::text, je.created_at, je.ref_type::text,
           CASE WHEN jl.direction = 'DEBIT' THEN jl.amount ELSE -jl.amount END
    FROM journal_lines jl
    INNER JOIN gl_accounts a ON a.id = jl.gl_account_id
    INNER JOIN journal_entries je ON je.id = jl.entry_id AND je.ref_type = 'ADJUSTMENT'
    INNER JOIN adjustments adj ON je.ref_id = adj.id::text
    INNER JOIN payment_attempts pa ON pa.id = adj.source_attempt_id
    WHERE a.account_type = 'COMMISSION_RECEIVABLE' ${byAttempt}
    UNION ALL
    SELECT split_part(je.ref_id, ':', 2), jl.gl_account_id::text, a.currency::text, je.created_at, je.ref_type::text,
           CASE WHEN jl.direction = 'DEBIT' THEN jl.amount ELSE -jl.amount END
    FROM journal_entries je
    INNER JOIN journal_lines jl ON jl.entry_id = je.id
    INNER JOIN gl_accounts a ON a.id = jl.gl_account_id
    WHERE je.ref_type = 'COMMISSION_NETTING' AND a.account_type = 'COMMISSION_RECEIVABLE' ${byPrefix}`;
};

const dec = (value: unknown): Decimal => new Decimal(value === null || value === undefined ? 0 : String(value));

export const prismaCommissionNettingStore: CommissionNettingStore = {
  async listReceivables(db, input) {
    const rows = (await db.$queryRawUnsafe(
      `WITH movement AS (${movementSql(null)})
       SELECT merchant_id, account_id, currency, SUM(delta)::text AS receivable,
              COALESCE(SUM(delta) FILTER (WHERE ref_type = 'PAYMENT_ATTEMPT' AND delta > 0 AND created_at >= $1::timestamptz), 0)::text AS recent
       FROM movement
       GROUP BY merchant_id, account_id, currency
       HAVING SUM(delta) > 0
       ORDER BY merchant_id, account_id
       LIMIT $2::int`,
      input.agingCutoff,
      input.limit,
    )) as Array<{ merchant_id: string; account_id: string; currency: string; receivable: string; recent: string }>;
    return rows.map((row) => ({
      merchantId: row.merchant_id,
      receivableAccountId: row.account_id,
      currency: String(row.currency).trim(),
      receivable: dec(row.receivable),
      recentRecognised: dec(row.recent),
    }));
  },

  async receivablesOf(tx, merchantId, filter) {
    const rows = (await tx.$queryRawUnsafe(
      `WITH movement AS (${movementSql("$1")})
       SELECT account_id, currency, SUM(delta)::text AS receivable
       FROM movement
       WHERE ($2::text IS NULL OR account_id = $2::text) AND ($3::text IS NULL OR trim(currency) = $3::text)
       GROUP BY account_id, currency
       ORDER BY account_id`,
      merchantId,
      filter.receivableAccountId ?? null,
      filter.currency ?? null,
    )) as Array<{ account_id: string; currency: string; receivable: string }>;
    return rows.map((row) => ({ receivableAccountId: row.account_id, currency: String(row.currency).trim(), receivable: dec(row.receivable) }));
  },

  async merchantReceivable(db, merchantId) {
    const rows = (await db.$queryRawUnsafe(
      `WITH movement AS (${movementSql("$1")}) SELECT COALESCE(SUM(delta), 0)::text AS receivable FROM movement`,
      merchantId,
    )) as Array<{ receivable: string }>;
    return dec(rows[0]?.receivable);
  },

  async merchantCeiling(db, merchantId) {
    const merchant = await db.merchant.findUnique({
      where: { id: merchantId },
      select: { status: true, commissionReceivableCeiling: true },
    });
    if (!merchant) return null;
    const raw = merchant.commissionReceivableCeiling;
    return { status: String(merchant.status), ceiling: raw === null || raw === undefined ? null : dec(raw) };
  },

  async findWallet(tx, merchantId, currency) {
    const wallet = await tx.wallet.findFirst({
      where: { merchantId, currency },
      orderBy: { createdAt: "asc" },
      select: { id: true, glAccountId: true, status: true },
    });
    return wallet ? { walletId: String(wallet.id), glAccountId: String(wallet.glAccountId), status: String(wallet.status) } : null;
  },

  lockWalletBalance: (tx, glAccountId, lockShards) => lockWalletLedgerBalance(tx, glAccountId, { lockShards }),

  openCashouts: (tx, walletId) => openCashoutTotal(tx, walletId),

  async entryExists(tx, refId) {
    const entry = await tx.journalEntry.findFirst({ where: { refType: "COMMISSION_NETTING", refId }, select: { id: true } });
    return Boolean(entry);
  },
};

// ---------------------------------------------------------------------------------------------
// Schedule helpers (Africa/Tripoli day close)
// ---------------------------------------------------------------------------------------------

/**
 * Parses a daily cron expression `M H * * *` (the only form the netting schedule accepts) into minutes after
 * midnight. Throws on anything else so a misconfiguration fails at start-up instead of silently never running.
 */
export const parseDailyCron = (expression: string): number => {
  const parts = expression.trim().split(/\s+/);
  const valid = parts.length === 5 && parts.slice(2).every((part) => part === "*") && /^\d{1,2}$/.test(parts[0]!) && /^\d{1,2}$/.test(parts[1]!);
  const minute = valid ? Number(parts[0]) : Number.NaN;
  const hour = valid ? Number(parts[1]) : Number.NaN;
  if (!valid || minute > 59 || hour > 23) {
    throw new Error(`Invalid daily cron '${expression}': expected 'M H * * *' (minute 0-59, hour 0-23)`);
  }
  return hour * 60 + minute;
};

/** The local calendar date (YYYY-MM-DD) and minutes after local midnight of `now` in `timeZone`. */
export const zonedDayClock = (now: Date, timeZone: string): { date: string; minutes: number } => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? "00";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
};
