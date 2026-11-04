import { createHash } from "node:crypto";
import { Decimal } from "decimal.js";
import {
  LedgerPoster,
  decimal,
  type JournalTemplate,
  type LedgerAccountSelector,
  type LedgerPostContext,
} from "../../engine/ledger/LedgerPoster";
import { metaOf, type SeederContext } from "./context";
import { CITIES, FIRST_NAMES_AR, FIRST_NAMES_EN, LAST_NAMES_AR, LAST_NAMES_EN, BUSINESS_CATEGORIES, BUSINESS_SUFFIXES, BANKS, STREETS, ADDRESSES_EN, pickPhone, pickTaxId, type BusinessCategory } from "./libyanDataCatalog";

export const addDays = (date: Date, days: number): Date => {
  const value = new Date(date);
  value.setUTCDate(value.getUTCDate() + days);
  return value;
};

export const addMinutes = (date: Date, minutes: number): Date => {
  const value = new Date(date);
  value.setUTCMinutes(value.getUTCMinutes() + minutes);
  return value;
};

export const iso = (date: Date): Date => new Date(date);

export const randomName = (ctx: SeederContext): { ar: string; en: string } => {
  const index = ctx.rng.int(0, FIRST_NAMES_AR.length - 1);
  const last = ctx.rng.int(0, LAST_NAMES_AR.length - 1);
  return {
    ar: `${FIRST_NAMES_AR[index]} ${LAST_NAMES_AR[last]}`,
    en: `${FIRST_NAMES_EN[index]} ${LAST_NAMES_EN[last]}`,
  };
};

export const randomBusinessName = (ctx: SeederContext): { ar: string; en: string } => {
  const name = randomName(ctx);
  const suffix = ctx.rng.pick(BUSINESS_SUFFIXES);
  const city = ctx.rng.pick(CITIES);
  return {
    ar: `${name.ar} ${suffix.ar} - ${city.ar}`,
    en: `${name.en} ${suffix.en} - ${city.en}`,
  };
};

export const randomAddress = (ctx: SeederContext): { ar: string; en: string } => ({
  ar: `${ctx.rng.pick(STREETS)}، ${ctx.rng.pick(CITIES).ar}`,
  en: `${ctx.rng.pick(ADDRESSES_EN)}, ${ctx.rng.pick(CITIES).en}`,
});

export const randomBank = (ctx: SeederContext) => ctx.rng.pick(BANKS);

export const randomCategory = (ctx: SeederContext): BusinessCategory => {
  const total = BUSINESS_CATEGORIES.reduce((sum, category) => sum + category.weight, 0);
  let roll = ctx.rng.next() * total;
  for (const category of BUSINESS_CATEGORIES) {
    roll -= category.weight;
    if (roll <= 0) return category;
  }
  return BUSINESS_CATEGORIES[0];
};

export const randomPhone = (ctx: SeederContext): string => pickPhone(ctx.rng);

export const randomTaxId = (ctx: SeederContext): string => pickTaxId(ctx.rng);

export const pick = <T>(ctx: SeederContext, values: readonly T[]): T => ctx.rng.pick(values);

export const chance = (ctx: SeederContext, percent: number): boolean => ctx.rng.chance(percent);

export const amount = (ctx: SeederContext, min: number, max: number): string => ctx.rng.decimal(min, max, 4);

/** A real SHA-256 hex digest, keyed by the synthetic seed. */
export const sha256Like = (ctx: SeederContext, value: string): string =>
  createHash("sha256").update(`${ctx.config.seedKey}:${value}`).digest("hex");

export interface LedgerLineInput {
  glAccountId: string;
  direction: "DEBIT" | "CREDIT";
  amount: string;
}

/** The engine's own template validator (positive amounts, debits == credits). */
const TEMPLATE_VALIDATOR = new LedgerPoster({} as never);

const pushEntry = (
  ctx: SeederContext,
  input: { refType: string; refId: string; description: string; at: Date },
  lines: Array<{ glAccountId: string; direction: "DEBIT" | "CREDIT"; amount: string }>,
): string => {
  const meta = metaOf(ctx);
  const key = `${input.refType}:${input.refId}`;
  if (meta.journalKeys.has(key)) {
    // journal_entries(ref_type, ref_id) is unique; the real poster would
    // return the existing entry, the bulk writer would silently drop it.
    throw new Error(`Duplicate synthetic journal ${key}`);
  }
  meta.journalKeys.add(key);
  const entryId = ctx.nextId("journal-entry");
  const at = new Date(input.at);
  ctx.dataset.journalEntries.push({
    id: entryId,
    createdAt: at,
    updatedAt: at,
    refType: input.refType,
    refId: input.refId,
    description: input.description,
  });
  for (const line of lines) {
    ctx.dataset.journalLines.push({
      id: ctx.nextId("journal-line"),
      createdAt: at,
      updatedAt: at,
      entryId,
      glAccountId: line.glAccountId,
      direction: line.direction,
      amount: line.amount,
    });
  }
  return entryId;
};

/**
 * Posts a balanced double-entry journal entry from explicit account ids.
 * Amounts are summed with `decimal.js`; it throws when the entry is not
 * balanced or a line is not strictly positive (journal_lines_amount_positive).
 */
export const postLedger = (
  ctx: SeederContext,
  input: {
    refType: string;
    refId: string;
    description: string;
    at: Date;
    lines: LedgerLineInput[];
  },
): string => {
  let debit = new Decimal(0);
  let credit = new Decimal(0);
  for (const line of input.lines) {
    const value = decimal(line.amount);
    if (!value.gt(0)) {
      throw new Error(`Synthetic journal ${input.refType}/${input.refId} has a non-positive line ${line.amount}`);
    }
    if (line.direction === "DEBIT") debit = debit.plus(value);
    else credit = credit.plus(value);
  }
  if (!debit.equals(credit)) {
    throw new Error(
      `Unbalanced synthetic journal ${input.refType}/${input.refId}: debit ${debit.toFixed(4)} != credit ${credit.toFixed(4)}`,
    );
  }
  return pushEntry(ctx, input, input.lines.map((line) => ({ ...line, amount: decimal(line.amount).toFixed(4) })));
};

const ACCOUNT_SCOPING: Record<string, "GLOBAL" | "MERCHANT" | "GATEWAY"> = {
  GATEWAY_CLEARING: "GATEWAY",
  MERCHANT_WALLET: "MERCHANT",
};

/**
 * In-memory mirror of `LedgerPoster.resolveAccountId`: explicit id, then the
 * context mapping, then the scoped lookup by the dimensions the account type
 * carries, then the platform-wide account of the same type and currency.
 */
export const resolveLedgerAccount = (
  ctx: SeederContext,
  selector: LedgerAccountSelector,
  context: LedgerPostContext,
): string => {
  if (selector.accountId) return selector.accountId;
  const mapped = context.accounts?.[selector.accountType];
  if (mapped) return mapped;
  const scoping = ACCOUNT_SCOPING[selector.accountType] ?? "GLOBAL";
  const ownerId = selector.ownerId ?? (scoping === "MERCHANT" ? context.merchantId : undefined);
  const gatewayId = selector.gatewayId ?? (scoping === "GATEWAY" ? context.gatewayId : undefined);
  const credentialSetId = selector.credentialSetId ?? (scoping === "GATEWAY" ? context.credentialSetId : undefined);
  const env = selector.env ?? (scoping === "GATEWAY" ? context.env : undefined);
  const currency = selector.currency ?? context.currency;
  const cacheKey = [selector.accountType, ownerId, gatewayId, credentialSetId, env, currency].join("|");
  const meta = metaOf(ctx);
  const cached = meta.accountCache.get(cacheKey);
  if (cached) return cached;
  const sameCurrency = (account: { currency?: string | null }) =>
    !currency || !account.currency || account.currency === currency;
  const scoped = ctx.refs.glAccounts.find((account) =>
    account.accountType === selector.accountType
    && (!ownerId || account.ownerId === ownerId)
    && (!gatewayId || account.gatewayId === gatewayId)
    && (!credentialSetId || account.credentialSetId === credentialSetId)
    && (!env || account.env === env)
    && sameCurrency(account));
  const resolved = scoped ?? ctx.refs.glAccounts.find((account) =>
    account.accountType === selector.accountType
    && !account.ownerId
    && !account.gatewayId
    && !account.credentialSetId
    && !account.env
    && sameCurrency(account));
  if (!resolved) {
    throw new Error(`GL_ACCOUNT_NOT_FOUND: no ${selector.accountType} account matched the synthetic posting context`);
  }
  meta.accountCache.set(cacheKey, resolved.id);
  return resolved.id;
};

/**
 * Posts an ENGINE journal template (`buildLedgerTemplate` /
 * `buildPaymentConfirmationTemplate`), validated by the engine's own
 * `LedgerPoster.validateTemplate`, with the accounts resolved exactly as the
 * live poster would. This is what keeps the synthetic ledger identical to a
 * ledger produced by the running platform.
 */
export const postTemplate = (
  ctx: SeederContext,
  template: JournalTemplate,
  context: LedgerPostContext,
  at: Date,
): string => {
  TEMPLATE_VALIDATOR.validateTemplate(template);
  if (at.getTime() > ctx.timeline.end.getTime()) {
    throw new Error(`Synthetic journal ${template.refType}/${template.refId} is dated in the future (${at.toISOString()})`);
  }
  if (!template.refId || template.refId === "scenario") {
    throw new Error(`Synthetic journal ${template.refType} has no reference id`);
  }
  const lines = template.lines.map((line) => ({
    glAccountId: resolveLedgerAccount(ctx, line.account, context),
    direction: line.direction,
    amount: decimal(line.amount).toFixed(4),
  }));
  return pushEntry(ctx, { refType: template.refType, refId: template.refId, description: template.description, at }, lines);
};

export interface SystemAccounts {
  treasury: string;
  platformIncome: string;
  gatewayFeeExpense: string;
  providerFeeExpense: string;
  gatewayFeeAccrual: string;
  commissionReceivable: string;
  amlHold: string;
  chargebackReserve: string;
  suspense: string;
  /** `${gatewayId}:${env}:${credentialSetId}` -> clearing account id. */
  clearing: Map<string, string>;
}

const newGlAccount = (
  ctx: SeederContext,
  input: { type: string; gatewayId?: string | null; env?: string | null; ownerId?: string | null; credentialSetId?: string | null; seedKey: string; at: Date },
): string => {
  const id = ctx.nextId("gl");
  ctx.dataset.glAccounts.push({
    id,
    createdAt: input.at,
    updatedAt: input.at,
    accountType: input.type,
    ownerId: input.ownerId ?? null,
    gatewayId: input.gatewayId ?? null,
    credentialSetId: input.credentialSetId ?? null,
    env: input.env ?? null,
    currency: "LYD",
    lastCheckpointId: null,
    checkpointBalance: "0.0000",
    checkpointAt: null,
    seedKey: input.seedKey,
  });
  ctx.refs.glAccounts.push({
    id,
    accountType: input.type,
    gatewayId: input.gatewayId ?? null,
    env: input.env ?? null,
    ownerId: input.ownerId ?? null,
    credentialSetId: input.credentialSetId ?? null,
    currency: "LYD",
  });
  metaOf(ctx).accountCache.clear();
  return id;
};

/**
 * Ensures the GL accounts the ledger templates need.
 *
 * The platform-wide system accounts come from `seedSystemGlAccounts`; a
 * missing one is created as a defensive fallback. Clearing accounts are
 * created per (gateway, env, platform credential set), which is the scope the
 * live resolver narrows by (design §7.1), so live postings after the seed land
 * in the same accounts as the synthetic history.
 */
export const ensureSystemAccounts = (ctx: SeederContext): SystemAccounts => {
  const platformAccount = (type: string): string => {
    const existing = ctx.refs.glAccounts.find((account) =>
      account.accountType === type && !account.gatewayId && !account.env && !account.ownerId && !account.credentialSetId
      && (!account.currency || account.currency === "LYD"));
    if (existing) return existing.id;
    return newGlAccount(ctx, {
      type,
      seedKey: `synthetic:${ctx.config.namespace}:${ctx.config.seedKey}:${type}:platform`,
      at: ctx.timeline.start,
    });
  };

  // The baseline seed only owns platform-wide system accounts; the live
  // resolver falls back to them when no scoped clearing account exists, so the
  // synthetic history does the same (no per-credential clearing accounts).
  const clearing = new Map<string, string>();
  return {
    treasury: platformAccount("TREASURY"),
    platformIncome: platformAccount("PLATFORM_INCOME"),
    gatewayFeeExpense: platformAccount("GATEWAY_FEE_EXPENSE"),
    providerFeeExpense: platformAccount("PROVIDER_FEE_EXPENSE"),
    gatewayFeeAccrual: platformAccount("GATEWAY_FEE_ACCRUAL"),
    commissionReceivable: platformAccount("COMMISSION_RECEIVABLE"),
    amlHold: platformAccount("AML_HOLD"),
    chargebackReserve: platformAccount("CHARGEBACK_RESERVE"),
    suspense: platformAccount("SUSPENSE"),
    clearing: (() => {
      platformAccount("GATEWAY_CLEARING");
      return clearing;
    })(),
  };
};

export const createWalletAccount = (
  ctx: SeederContext,
  merchantId: string,
  at: Date,
  walletIndex = 0,
): string =>
  newGlAccount(ctx, {
    type: "MERCHANT_WALLET",
    ownerId: merchantId,
    seedKey: `synthetic:${ctx.config.namespace}:${ctx.config.seedKey}:wallet:${merchantId}:${walletIndex}`,
    at,
  });

export const systemAccountId = (ctx: SeederContext, type: string): string => {
  const account = ctx.refs.glAccounts.find((candidate) => candidate.accountType === type);
  if (!account) throw new Error(`Missing system GL account ${type}`);
  return account.id;
};

/** Debit-positive balance of an account from the in-memory lines (exact decimal). */
export const accountBalance = (ctx: SeederContext, glAccountId: string): Decimal =>
  ctx.dataset.journalLines
    .filter((line) => line.glAccountId === glAccountId)
    .reduce(
      (sum: Decimal, line) => (line.direction === "DEBIT" ? sum.plus(decimal(line.amount)) : sum.minus(decimal(line.amount))),
      new Decimal(0),
    );

export const formatMoney = (value: Decimal | string): string => decimal(value).toFixed(4);

/**
 * Splits a profile volume across `count` owners: every owner gets `minEach`,
 * the remainder is spread by weight without exceeding `maxEach`. This is how
 * the per-merchant collections (wallets, applications, users, KYB documents,
 * owners, join requests) are driven by the profile volumes instead of being
 * an accident of the merchant count. Returns the per-owner counts; their sum
 * equals `total` whenever `count * minEach <= total <= count * maxEach`.
 */
export const allocateVolume = (
  ctx: SeederContext,
  total: number,
  count: number,
  minEach: number,
  maxEach: number,
  weightOf: (index: number) => number = () => 1,
): number[] => {
  const result = Array.from({ length: count }, () => minEach);
  let remaining = Math.max(0, Math.round(total) - count * minEach);
  const eligible = Array.from({ length: count }, (_, index) => index).filter((index) => weightOf(index) > 0);
  let guard = 0;
  while (remaining > 0 && eligible.length > 0 && guard < total * 20 + 1000) {
    guard += 1;
    let weightTotal = 0;
    for (const index of eligible) weightTotal += weightOf(index);
    let roll = ctx.rng.next() * weightTotal;
    let chosen = eligible[eligible.length - 1]!;
    for (const index of eligible) {
      roll -= weightOf(index);
      if (roll <= 0) {
        chosen = index;
        break;
      }
    }
    if (result[chosen]! >= maxEach) {
      eligible.splice(eligible.indexOf(chosen), 1);
      continue;
    }
    result[chosen]! += 1;
    remaining -= 1;
  }
  return result;
};

/** Uniform instant in [from, to] (to clamped to the simulation clock). */
export const between = (ctx: SeederContext, from: Date, to: Date): Date => {
  const end = Math.min(to.getTime(), ctx.timeline.end.getTime());
  const begin = Math.min(from.getTime(), end);
  return new Date(begin + Math.floor(ctx.rng.next() * (end - begin)));
};

export const maxDate = (...dates: Array<Date | null | undefined>): Date =>
  new Date(Math.max(...dates.filter((date): date is Date => date instanceof Date).map((date) => date.getTime())));

export const minDate = (...dates: Array<Date | null | undefined>): Date =>
  new Date(Math.min(...dates.filter((date): date is Date => date instanceof Date).map((date) => date.getTime())));

/** Deterministic Fisher-Yates shuffle (copy). */
export const shuffle = <T>(ctx: SeederContext, values: readonly T[]): T[] => {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(ctx.rng.next() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap]!, copy[index]!];
  }
  return copy;
};
