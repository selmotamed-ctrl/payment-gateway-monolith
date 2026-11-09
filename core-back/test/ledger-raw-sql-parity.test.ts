/**
 * The raw-SQL posting path (`LedgerPosterOptions.rawSql`, on in production) must produce exactly the rows the ORM
 * path produces: same entry, same lines, same shard bookkeeping, same idempotency, same atomicity, and an account
 * cache that never outlives the facts it caches. Real PostgreSQL 18 test database (skipped when it is unreachable).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Decimal } from "decimal.js";
import { PrismaClient } from "../generated/prisma/client";
import {
  LedgerPoster,
  buildLedgerTemplate,
  buildPaymentConfirmationTemplate,
  type JournalTemplate,
  type LedgerPrismaClient,
} from "../engine/ledger/LedgerPoster";
import { createLedgerShardWriter } from "../lib/storageEngine/ledgerShardWriter";
import { createPrisma, describeDatabase, uniqueId } from "./storage-engine/helpers/db";

/** Created on first use, so the file loads (and its suites skip) when no test database is configured. */
let real: PrismaClient | undefined;
const client: PrismaClient = new Proxy({} as PrismaClient, {
  get: (_target, property) => {
    real ??= createPrisma({ max: 6 });
    const value = (real as unknown as Record<string | symbol, unknown>)[property];
    return typeof value === "function" ? value.bind(real) : value;
  },
});
afterAll(async () => {
  await real?.$disconnect().catch(() => undefined);
});

const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const randomCurrency = (): string => [0, 1, 2].map(() => letters[Math.floor(Math.random() * 26)]).join("");
/** A currency no account in the (persistent) test database uses yet, so balances can be summed per currency. */
const newCurrency = async (): Promise<string> => {
  for (;;) {
    const candidate = randomCurrency();
    if ((await client.glAccount.count({ where: { currency: candidate } })) === 0) return candidate;
  }
};

interface World { currency: string; merchantId: string; walletId: string }

/** A self-contained chart of accounts in its own currency, so two worlds never touch each other's balances. */
const makeWorld = async (): Promise<World> => {
  const currency = await newCurrency();
  const merchantId = randomUUID();
  const make = (accountType: string, ownerId: string | null = null) =>
    client.glAccount.create({ data: { id: randomUUID(), accountType: accountType as never, currency, ownerId, shardCount: 4 } });
  for (const type of ["TREASURY", "GATEWAY_CLEARING", "PROVIDER_FEE_EXPENSE", "PLATFORM_INCOME", "COMMISSION_RECEIVABLE", "CHARGEBACK_RESERVE", "AML_HOLD"]) {
    await make(type);
  }
  const wallet = await make("MERCHANT_WALLET", merchantId);
  return { currency, merchantId, walletId: wallet.id };
};

const poster = (rawSql: boolean, options: { ttl?: number } = {}) =>
  new LedgerPoster(client as unknown as LedgerPrismaClient, undefined, createLedgerShardWriter(), undefined, {
    rawSql,
    ...(options.ttl === undefined ? {} : { accountCacheTtlMs: options.ttl }),
  });

const templates = (): Array<{ name: string; build: () => JournalTemplate }> => [
  {
    name: "platform-held confirmation",
    build: () => buildPaymentConfirmationTemplate({ ownershipMode: "PLATFORM_CLEARING", amount: "100.0000", commissionAmount: "3.0000", providerFeeAmount: "1.0000", feeBearer: "MERCHANT_ABSORBS" } as never),
  },
  { name: "full refund", build: () => buildLedgerTemplate("FULL_REFUND", { amount: "40.0000", commissionAmount: "1.2000", merchantAmount: "38.8000" }) },
  { name: "merchant-direct commission reversal", build: () => buildLedgerTemplate("MERCHANT_DIRECT_CONFIRMATION", { amount: "50.0000", commissionAmount: "1.5000", stage: "REFUND" }) },
  { name: "chargeback reserve", build: () => buildLedgerTemplate("CHARGEBACK_RESERVE_AND_LOST", { amount: "20.0000", commissionAmount: "0.6000", merchantAmount: "19.4000", stage: "RESERVE" }) },
  { name: "AML hold", build: () => buildLedgerTemplate("AML_HOLD_AND_RELEASE", { amount: "75.5000", commissionAmount: "2.2650" }) },
];

/** Everything about a posting that is not a generated id or timestamp. */
const snapshot = async (world: World, refPrefix: string) => {
  const entries = await client.journalEntry.findMany({ where: { refId: { startsWith: refPrefix } }, orderBy: { refId: "asc" } });
  const lines = await client.$queryRawUnsafe<Array<{ ref_id: string; account_type: string; owner: string | null; direction: string; amount: string }>>(
    `SELECT je.ref_id, a.account_type::text AS account_type, a.owner_id AS owner, jl.direction::text AS direction, jl.amount::text AS amount
     FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id JOIN gl_accounts a ON a.id = jl.gl_account_id
     WHERE je.ref_id LIKE $1 AND a.currency = $2 ORDER BY je.ref_id, a.account_type::text, jl.direction::text, jl.amount`,
    `${refPrefix}%`,
    world.currency,
  );
  const balances = await client.$queryRawUnsafe<Array<{ account_type: string; balance: string; line_seq: string }>>(
    `SELECT a.account_type::text AS account_type, sum(s.current_balance)::text AS balance, sum(s.line_seq)::text AS line_seq
     FROM gl_account_shards s JOIN gl_accounts a ON a.id = s.gl_account_id WHERE a.currency = $1
     GROUP BY a.account_type ORDER BY a.account_type::text`,
    world.currency,
  );
  const shardSeqGapless = await client.$queryRawUnsafe<Array<{ ok: boolean }>>(
    `SELECT bool_and(seqs.max_seq = seqs.n) AS ok FROM (
       SELECT jl.gl_account_id, jl.shard_id, max(jl.shard_seq) AS max_seq, count(*) AS n
       FROM journal_lines jl JOIN gl_accounts a ON a.id = jl.gl_account_id WHERE a.currency = $1 GROUP BY 1, 2) seqs`,
    world.currency,
  );
  return {
    entries: entries.map((entry) => ({ refType: entry.refType, description: entry.description, refId: entry.refId.replace(refPrefix, "") })),
    lines,
    balances,
    shardSeqGapless: shardSeqGapless[0]?.ok,
  };
};

describeDatabase("raw-SQL posting parity with the ORM path", () => {
  test("every template stores the same entries, lines, balances and gapless shard sequences", async () => {
    const [ormWorld, rawWorld] = [await makeWorld(), await makeWorld()];
    for (const [mode, world, rawSql] of [["orm", ormWorld, false], ["raw", rawWorld, true]] as const) {
      const poster_ = poster(rawSql);
      for (const [index, template] of templates().entries()) {
        const built = template.build();
        built.refId = `parity-${mode}-${world.currency}-${index}`;
        const result = await poster_.post(built, { merchantId: world.merchantId, currency: world.currency });
        expect(result.created).toBe(true);
        expect(result.idempotent).toBe(false);
        expect(result.lines).toHaveLength(built.lines.length);
      }
    }
    // The reference ids differ only by the mode and currency; normalise them to the template index.
    const normalise = async (mode: string, world: World) => {
      const snap = await snapshot(world, `parity-${mode}-${world.currency}-`);
      return snap;
    };
    const orm = await normalise("orm", ormWorld);
    const raw = await normalise("raw", rawWorld);
    expect(raw.entries).toEqual(orm.entries);
    // Lines carry the ref id too; compare by (ref index, account type, direction, amount).
    const strip = (rows: typeof orm.lines, prefix: string) => rows.map((row) => ({ ...row, ref_id: row.ref_id.replace(prefix, ""), owner: row.owner ? "merchant" : null }));
    expect(strip(raw.lines, `parity-raw-${rawWorld.currency}-`)).toEqual(strip(orm.lines, `parity-orm-${ormWorld.currency}-`));
    expect(raw.balances).toEqual(orm.balances);
    expect(orm.shardSeqGapless).toBe(true);
    expect(raw.shardSeqGapless).toBe(true);
  });

  test("the returned records describe what was stored", async () => {
    const world = await makeWorld();
    const template = templates()[0]!.build();
    template.refId = `parity-record-${world.currency}`;
    const result = await poster(true).post(template, { merchantId: world.merchantId, currency: world.currency });
    const stored = await client.journalLine.findMany({ where: { entryId: result.entry.id } });
    expect(stored).toHaveLength(result.lines.length);
    for (const line of result.lines) {
      const row = stored.find((candidate) => candidate.id === line.id)!;
      expect(row).toBeDefined();
      expect({ account: row.glAccountId, direction: row.direction, amount: new Decimal(row.amount as never).toFixed(4), shardId: row.shardId, shardSeq: row.shardSeq })
        .toEqual({ account: line.glAccountId, direction: line.direction, amount: new Decimal(line.amount as never).toFixed(4), shardId: line.shardId!, shardSeq: line.shardSeq! });
      expect(line.shardSeq).toBeGreaterThan(0n);
    }
    expect(result.entry.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(result.lines.every((line) => /^[0-9a-f]{8}-[0-9a-f]{4}-7/.test(line.id))).toBe(true);
  });

  test("posting the same reference twice is idempotent and moves nothing, in both modes", async () => {
    for (const rawSql of [false, true]) {
      const world = await makeWorld();
      const template = templates()[0]!.build();
      template.refId = `parity-idem-${rawSql}-${world.currency}`;
      const first = await poster(rawSql).post(template, { merchantId: world.merchantId, currency: world.currency });
      const before = await snapshot(world, "parity-idem-");
      const rebuilt = templates()[0]!.build();
      rebuilt.refId = template.refId;
      const again = await poster(rawSql).post(rebuilt, { merchantId: world.merchantId, currency: world.currency });
      expect(again).toMatchObject({ created: false, idempotent: true, lines: [] });
      expect(again.entry.id).toBe(first.entry.id);
      expect(await snapshot(world, "parity-idem-")).toEqual(before);
    }
  });

  test("a failure after the entry insert rolls the whole posting back (no entry, no shard movement)", async () => {
    const world = await makeWorld();
    const failing = new LedgerPoster(
      client as unknown as LedgerPrismaClient,
      undefined,
      async () => {
        throw new Error("shard writer failed");
      },
      undefined,
      { rawSql: true },
    );
    const template = templates()[0]!.build();
    template.refId = `parity-rollback-${world.currency}`;
    await expect(failing.post(template, { merchantId: world.merchantId, currency: world.currency })).rejects.toThrow("shard writer failed");
    expect(await client.journalEntry.count({ where: { refId: template.refId } })).toBe(0);
    const moved = await client.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM gl_account_shards s JOIN gl_accounts a ON a.id = s.gl_account_id WHERE a.currency = $1 AND (s.line_seq <> 0 OR s.current_balance <> 0)`,
      world.currency,
    );
    expect(moved[0]!.n).toBe(0);
  });
});

describeDatabase("the account cache only remembers facts that cannot change", () => {
  const spy = () => {
    const calls: string[] = [];
    const proxy = new Proxy(client, {
      get(target, property, receiver) {
        if (property === "$transaction") {
          return (callback: (tx: unknown) => unknown, ...rest: unknown[]) =>
            (target.$transaction as (cb: (tx: unknown) => unknown, ...r: unknown[]) => unknown)(
              (tx) => callback(new Proxy(tx as object, {
                get(txTarget, txProperty, txReceiver) {
                  const value = Reflect.get(txTarget, txProperty, txReceiver);
                  if (txProperty !== "$queryRawUnsafe") return value;
                  return (sql: string, ...values: unknown[]) => {
                    if (/credential_set_id.*FROM gl_accounts WHERE/s.test(sql)) calls.push("accounts");
                    return (value as (s: string, ...v: unknown[]) => unknown).call(txTarget, sql, ...values);
                  };
                },
              })),
              ...rest,
            );
        }
        return Reflect.get(target, property, receiver);
      },
    });
    return { proxy: proxy as unknown as LedgerPrismaClient, calls };
  };
  const post = (p: LedgerPoster, world: World, merchantId: string, tag: string) => {
    const template = buildLedgerTemplate("CASHOUT", { amount: "10.0000" });
    template.refId = `cache-${tag}-${randomUUID()}`;
    return p.post(template, { merchantId, currency: world.currency });
  };

  test("a most-specific match is looked up once, then remembered", async () => {
    const world = await makeWorld();
    const { proxy, calls } = spy();
    const p = new LedgerPoster(proxy, undefined, createLedgerShardWriter(), undefined, { rawSql: true });
    const first = await post(p, world, world.merchantId, "hit");
    expect(calls).toHaveLength(1);
    await post(p, world, world.merchantId, "hit");
    await post(p, world, world.merchantId, "hit");
    expect(calls).toHaveLength(1);
    expect(first.lines.some((line) => line.glAccountId === world.walletId)).toBe(true);
  });

  test("a platform-wide FALLBACK is never remembered: a wallet created later takes over at once", async () => {
    const world = await makeWorld();
    const newcomer = randomUUID();
    const p = new LedgerPoster(client as unknown as LedgerPrismaClient, undefined, createLedgerShardWriter(), undefined, { rawSql: true });
    // The platform has a wallet account WITHOUT an owner (the fallback) in this currency.
    const fallback = await client.glAccount.create({ data: { id: randomUUID(), accountType: "MERCHANT_WALLET", currency: world.currency, ownerId: null, shardCount: 4 } });
    const before = await post(p, world, newcomer, "fallback");
    expect(before.lines.some((line) => line.glAccountId === fallback.id)).toBe(true);
    const dedicated = await client.glAccount.create({ data: { id: randomUUID(), accountType: "MERCHANT_WALLET", currency: world.currency, ownerId: newcomer, shardCount: 4 } });
    const after = await post(p, world, newcomer, "fallback");
    expect(after.lines.some((line) => line.glAccountId === dedicated.id)).toBe(true);
    expect(after.lines.some((line) => line.glAccountId === fallback.id)).toBe(false);
  });

  test("the cache expires, can be cleared, and is off with a zero TTL", async () => {
    const world = await makeWorld();
    const { proxy, calls } = spy();
    const expiring = new LedgerPoster(proxy, undefined, createLedgerShardWriter(), undefined, { rawSql: true, accountCacheTtlMs: 40 });
    await post(expiring, world, world.merchantId, "ttl");
    await new Promise((resolve) => setTimeout(resolve, 80));
    await post(expiring, world, world.merchantId, "ttl");
    expect(calls).toHaveLength(2);
    expiring.clearAccountCache();
    await post(expiring, world, world.merchantId, "ttl");
    expect(calls).toHaveLength(3);

    const disabled = spy();
    const noCache = new LedgerPoster(disabled.proxy, undefined, createLedgerShardWriter(), undefined, { rawSql: true, accountCacheTtlMs: 0 });
    await post(noCache, world, world.merchantId, "off");
    await post(noCache, world, world.merchantId, "off");
    expect(disabled.calls).toHaveLength(2);
  });

  test("an unresolvable account still fails the same way and the failed posting leaves nothing behind", async () => {
    const world = await makeWorld();
    const p = new LedgerPoster(client as unknown as LedgerPrismaClient, undefined, createLedgerShardWriter(), undefined, { rawSql: true });
    const template = buildLedgerTemplate("CASHOUT", { amount: "5.0000" });
    template.refId = `cache-missing-${uniqueId("x")}`;
    // No such currency: neither a scoped nor a platform-wide account exists.
    await expect(p.post(template, { merchantId: randomUUID(), currency: "ZQQ" })).rejects.toMatchObject({ code: "GL_ACCOUNT_NOT_FOUND" });
    expect(await client.journalEntry.count({ where: { refId: template.refId } })).toBe(0);
    expect(world.currency).toBeTruthy();
  });
});
