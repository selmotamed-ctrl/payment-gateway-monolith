import { GlAccountType, Prisma } from "../generated/prisma/client";

/**
 * The currencies the platform settles in.
 *
 * The domestic currency of the Libyan rails is LYD (design v5 §5.1: every
 * local gateway settles in LYD, `rails.currency` defaults to `LYD` and the
 * negative balance ceiling of OD-8 is expressed in LYD). The card rails are
 * the multi currency ones: design v5 §5.1 lists Google Pay and MPGS / 3DS2
 * with the explicit settlement currencies `LYD`, `USD` and `EUR`.
 *
 * The list is explicit on purpose: a posting resolves its GL account by
 * (account type, owner, gateway, credential set, env, currency), so a
 * posting in a currency without a seeded account fails with
 * `GL_ACCOUNT_NOT_FOUND`.
 */
export const SUPPORTED_CURRENCIES = ["LYD", "USD", "EUR"] as const;

export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

/**
 * The domestic currency of the platform. It keeps the historical seed key of
 * the system accounts so a database that was seeded before the multi currency
 * support is adopted instead of duplicated.
 */
export const DEFAULT_CURRENCY: SupportedCurrency = "LYD";

/**
 * The system GL accounts that are scoped by currency.
 *
 * Every one of them is a platform account of the ledger (design v5 §11.3), so
 * each of them exists once per supported currency.
 */
export const CURRENCY_SCOPED_GL_ACCOUNT_TYPES = [
  GlAccountType.TREASURY,
  GlAccountType.GATEWAY_CLEARING,
  GlAccountType.MERCHANT_WALLET,
  GlAccountType.PLATFORM_INCOME,
  GlAccountType.PROVIDER_FEE_EXPENSE,
  GlAccountType.GATEWAY_FEE_EXPENSE,
  GlAccountType.GATEWAY_FEE_ACCRUAL,
  GlAccountType.COMMISSION_RECEIVABLE,
  GlAccountType.AML_HOLD,
  GlAccountType.CHARGEBACK_RESERVE,
  GlAccountType.SUSPENSE,
] as const;

export type CurrencyScopedGlAccountType = (typeof CURRENCY_SCOPED_GL_ACCOUNT_TYPES)[number];

/**
 * The seed key of a system GL account.
 *
 * The key is unique per (account type, currency), which keeps the seed
 * idempotent: a second run of the seed updates the existing rows instead of
 * creating duplicates.
 */
export const systemGlAccountSeedKey = (accountType: string, currency: string): string =>
  currency === DEFAULT_CURRENCY
    ? `system:${accountType}`
    : `system:${accountType}:${currency}`;

export interface GlAccountSeedClient {
  glAccount: {
    upsert(args: {
      where: { seedKey: string };
      update: Record<string, never>;
      create: {
        accountType: GlAccountType;
        currency: string;
        checkpointBalance: Prisma.Decimal;
        seedKey: string;
      };
    }): Promise<unknown>;
  };
}

/**
 * Seeds the system GL accounts of every supported currency.
 *
 * The balances stay at zero: the balance of an account is derived from the
 * journal lines, the checkpoint balance is only the anchor of the periodic
 * invariant check.
 */
export const seedSystemGlAccounts = async (
  client: GlAccountSeedClient,
  currencies: readonly string[] = SUPPORTED_CURRENCIES,
): Promise<void> => {
  for (const accountType of CURRENCY_SCOPED_GL_ACCOUNT_TYPES) {
    for (const currency of currencies) {
      const seedKey = systemGlAccountSeedKey(accountType, currency);
      await client.glAccount.upsert({
        where: { seedKey },
        update: {},
        create: {
          accountType,
          currency,
          checkpointBalance: new Prisma.Decimal(0),
          seedKey,
        },
      });
    }
  }
};
