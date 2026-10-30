import { createHash } from "node:crypto";
import type { SeederContext } from "./context";
import { CITIES, FIRST_NAMES_AR, FIRST_NAMES_EN, LAST_NAMES_AR, LAST_NAMES_EN, BUSINESS_CATEGORIES, BUSINESS_SUFFIXES, BANKS, STREETS, ADDRESSES_EN, pickPhone, pickTaxId } from "./libyanDataCatalog";

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

export const randomCategory = (ctx: SeederContext) => ctx.rng.pick(BUSINESS_CATEGORIES);

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

/**
 * Posts a balanced double-entry journal entry. It throws when the template is
 * not balanced, which is what keeps the final `0.0000 LYD` invariant honest.
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
  const debit = input.lines
    .filter((line) => line.direction === "DEBIT")
    .reduce((sum, line) => sum + Number(line.amount), 0);
  const credit = input.lines
    .filter((line) => line.direction === "CREDIT")
    .reduce((sum, line) => sum + Number(line.amount), 0);
  if (Math.abs(debit - credit) > 0.00005) {
    throw new Error(
      `Unbalanced synthetic journal ${input.refType}/${input.refId}: debit ${debit.toFixed(4)} != credit ${credit.toFixed(4)}`,
    );
  }
  const entryId = ctx.nextId("journal-entry");
  ctx.dataset.journalEntries.push({
    id: entryId,
    createdAt: input.at,
    updatedAt: input.at,
    refType: input.refType,
    refId: input.refId,
    description: input.description,
  });
  for (const line of input.lines) {
    ctx.dataset.journalLines.push({
      id: ctx.nextId("journal-line"),
      createdAt: input.at,
      updatedAt: input.at,
      entryId,
      glAccountId: line.glAccountId,
      direction: line.direction,
      amount: line.amount,
    });
  }
  return entryId;
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
  clearing: Map<string, string>;
}

/**
 * Ensures the system GL accounts the ledger templates need. The real
 * `seedGlAccounts` creates them; this is a defensive fallback for a database
 * that only ran the blueprint seed.
 */
export const ensureSystemAccounts = (ctx: SeederContext): SystemAccounts => {
  const find = (type: string, gatewayId: string | null = null, env: string | null = null): string | undefined =>
    ctx.refs.glAccounts.find(
      (account) => account.accountType === type && account.gatewayId === gatewayId && account.env === env,
    )?.id;

  const ensure = (
    type: string,
    gatewayId: string | null = null,
    env: string | null = null,
    ownerId: string | null = null,
  ): string => {
    const existing = find(type, gatewayId, env);
    if (existing) return existing;
    const id = ctx.nextId("gl");
    ctx.dataset.glAccounts.push({
      id,
      createdAt: ctx.timeline.start,
      updatedAt: ctx.timeline.end,
      accountType: type,
      ownerId,
      gatewayId,
      credentialSetId: null,
      env,
      currency: "LYD",
      lastCheckpointId: null,
      checkpointBalance: "0.0000",
      checkpointAt: null,
      seedKey: `synthetic:${ctx.config.namespace}:${type}:${gatewayId ?? "platform"}:${env ?? "all"}`,
    });
    ctx.refs.glAccounts.push({ id, accountType: type, gatewayId, env, ownerId });
    return id;
  };

  const clearing = new Map<string, string>();
  for (const gateway of ctx.refs.gateways) {
    for (const env of ["SANDBOX", "LIVE"]) {
      clearing.set(`${gateway.id}:${env}`, ensure("GATEWAY_CLEARING", gateway.id, env));
    }
  }

  return {
    treasury: ensure("TREASURY"),
    platformIncome: ensure("PLATFORM_INCOME"),
    gatewayFeeExpense: ensure("GATEWAY_FEE_EXPENSE"),
    providerFeeExpense: ensure("PROVIDER_FEE_EXPENSE"),
    gatewayFeeAccrual: ensure("GATEWAY_FEE_ACCRUAL"),
    commissionReceivable: ensure("COMMISSION_RECEIVABLE"),
    amlHold: ensure("AML_HOLD"),
    chargebackReserve: ensure("CHARGEBACK_RESERVE"),
    suspense: ensure("SUSPENSE"),
    clearing,
  };
};

export const createWalletAccount = (
  ctx: SeederContext,
  merchantId: string,
  at: Date,
): string => {
  const id = ctx.nextId("gl-wallet");
  ctx.dataset.glAccounts.push({
    id,
    createdAt: at,
    updatedAt: at,
    accountType: "MERCHANT_WALLET",
    ownerId: merchantId,
    gatewayId: null,
    credentialSetId: null,
    env: null,
    currency: "LYD",
    lastCheckpointId: null,
    checkpointBalance: "0.0000",
    checkpointAt: null,
    seedKey: `synthetic:${ctx.config.namespace}:wallet:${merchantId}`,
  });
  ctx.refs.glAccounts.push({ id, accountType: "MERCHANT_WALLET", gatewayId: null, env: null, ownerId: merchantId });
  return id;
};

export const systemAccountId = (ctx: SeederContext, type: string): string => {
  const account = ctx.refs.glAccounts.find((candidate) => candidate.accountType === type);
  if (!account) throw new Error(`Missing system GL account ${type}`);
  return account.id;
};

export const accountBalance = (ctx: SeederContext, glAccountId: string): number =>
  ctx.dataset.journalLines
    .filter((line) => line.glAccountId === glAccountId)
    .reduce(
      (sum, line) => sum + (line.direction === "DEBIT" ? Number(line.amount) : -Number(line.amount)),
      0,
    );

export const formatMoney = (value: number): string => value.toFixed(4);
