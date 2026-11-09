import { HOT_SYSTEM_SHARD_WIDTH, initialShardWidth } from "../lib/storageEngine/shardRouting";
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
        shardCount: number;
        seedKey: string;
      };
    }): Promise<unknown>;
    /** Widens an existing seeded account that is narrower than its provisioning width (never narrows). */
    updateMany?(args: {
      where: { seedKey: string; shardCount: { lt: number } };
      data: { shardCount: number; shardScaledAt: Date };
    }): Promise<unknown>;
    findMany?(args: {
      where: { seedKey: { not: null } };
      select: { id: true; accountType: true };
    }): Promise<Array<{ id: string; accountType: GlAccountType }>>;
  };
  glAccountShard?: {
    createMany(args: {
      data: Array<{ glAccountId: string; shardId: number }>;
      skipDuplicates: true;
    }): Promise<unknown>;
  };
}

export const GL_ACCOUNT_SHARD_COUNT = 16;

/** Provisioning width of the hot system accounts (TREASURY, GATEWAY_CLEARING, PLATFORM_INCOME), decision D6. */
export const HOT_GL_ACCOUNT_SHARD_COUNT = HOT_SYSTEM_SHARD_WIDTH;

/** The width a seeded system account is provisioned with. */
export const seededShardWidth = (accountType: string): number =>
  initialShardWidth(accountType, GL_ACCOUNT_SHARD_COUNT, HOT_GL_ACCOUNT_SHARD_COUNT);

/**
 * Seeds the system GL accounts of every supported currency.
 *
 * The balances stay at zero: the balance of an account is the sum of its
 * shards. TREASURY, GATEWAY_CLEARING and PLATFORM_INCOME start 128 shards wide
 * (every confirmation touches them; decision D6), the other system accounts 16
 * and merchant wallets one shard wide (the `gl_accounts_create_shards` trigger
 * creates the shard rows); the shard scaler widens an account that gets hot.
 * A re-run widens an existing seeded account that is narrower than that
 * (never narrows it: widening never remaps history, every line keeps its shard).
 */
export const seedSystemGlAccounts = async (
  client: GlAccountSeedClient,
  currencies: readonly string[] = SUPPORTED_CURRENCIES,
): Promise<void> => {
  for (const accountType of CURRENCY_SCOPED_GL_ACCOUNT_TYPES) {
    for (const currency of currencies) {
      const seedKey = systemGlAccountSeedKey(accountType, currency);
      const shardCount = seededShardWidth(accountType);
      await client.glAccount.upsert({
        where: { seedKey },
        update: {},
        create: {
          accountType,
          currency,
          shardCount,
          seedKey,
        },
      });
      if (shardCount > 1 && typeof client.glAccount.updateMany === "function") {
        await client.glAccount.updateMany({
          where: { seedKey, shardCount: { lt: shardCount } },
          data: { shardCount, shardScaledAt: new Date() },
        });
      }
    }
  }

  if (
    typeof client.glAccount.findMany === "function" &&
    client.glAccountShard &&
    typeof client.glAccountShard.createMany === "function"
  ) {
    const accounts = await client.glAccount.findMany({
      where: { seedKey: { not: null } },
      select: { id: true, accountType: true },
    });
    const data = accounts.flatMap((account) =>
      account.accountType === GlAccountType.MERCHANT_WALLET
        ? [{ glAccountId: account.id, shardId: 0 }]
        : Array.from({ length: seededShardWidth(account.accountType) }, (_value, shardId) => ({
            glAccountId: account.id,
            shardId,
          })),
    );
    if (data.length > 0) {
      await client.glAccountShard.createMany({ data, skipDuplicates: true });
    }
  }
};
