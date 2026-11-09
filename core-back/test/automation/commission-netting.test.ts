/**
 * AUTO-21 merchant-direct commission netting (decision D8): the netting arithmetic, the daily worker, the cash-out
 * time hook and the concurrency guarantees, against live PostgreSQL (the DB suites skip without a database).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { Decimal } from "decimal.js";
import { PrismaRepositories } from "../../engine/db/repositories";
import { executeCashout, decideCommissionReceivableCeiling } from "../../engine/governance/GovernanceExecution";
import {
  computeNettingAmount,
  createCashoutCommissionNetting,
  netMerchantReceivable,
  nettingRefId,
  parseDailyCron,
  prismaCommissionNettingStore,
  zonedDayClock,
  type CommissionNettingStore,
} from "../../engine/ledger/commissionNetting";
import { CommissionNettingWorker } from "../../engine/workers/CommissionNettingWorker";
import {
  cleanupAutomationCatalog,
  createAutomationCatalog,
  type AutomationCatalog,
} from "../helpers/automationCatalog";
import { createPrisma, databaseIsReachable } from "../storage-engine/helpers/db";

const client = createPrisma({ max: 30 });
const describeDb = databaseIsReachable ? describe : describe.skip;
const catalogs: AutomationCatalog[] = [];
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

afterAll(async () => {
  await cleanupAutomationCatalog(client, catalogs);
  await client.$disconnect();
});

const newCatalog = async (options: Parameters<typeof createAutomationCatalog>[1] = {}): Promise<AutomationCatalog> => {
  const catalog = await createAutomationCatalog(client, { label: "netting", ...options });
  catalogs.push(catalog);
  return catalog;
};

const netInTx = (catalog: AutomationCatalog, runKey: string, dryRun = false, trigger: "DAILY" | "CASHOUT" = "DAILY") =>
  client.$transaction((tx) =>
    netMerchantReceivable(tx as never, { poster: catalog.poster }, {
      merchantId: catalog.merchantId,
      receivableAccountId: catalog.receivableGlId,
      currency: "LYD",
      runKey,
      trigger,
      dryRun,
    }),
  );

/** A store that only sees the merchants of this suite (the shared test database holds other receivables). */
const scopedStore = (merchantIds: readonly string[]): CommissionNettingStore => ({
  ...prismaCommissionNettingStore,
  async listReceivables(db, input) {
    const all = await prismaCommissionNettingStore.listReceivables(db, { ...input, limit: 100_000 });
    return all.filter((bucket) => merchantIds.includes(bucket.merchantId)).slice(0, input.limit);
  },
});

const auditCount = async (action: string, entityId: string): Promise<number> =>
  Number(
    (
      await client.$queryRawUnsafe<Array<{ n: string }>>(
        `SELECT count(*)::text AS n FROM audit_log WHERE action = $1 AND entity_id = $2`,
        action,
        entityId,
      )
    )[0]?.n ?? 0,
  );

describe("commission netting arithmetic", () => {
  test("nets min(receivable, wallet - open cash-outs), never below zero, truncated to 4 decimals", () => {
    const d = (value: string) => new Decimal(value);
    expect(computeNettingAmount({ receivable: d("30"), walletBalance: d("100"), openCashouts: d("0") }).toFixed(4)).toBe("30.0000");
    expect(computeNettingAmount({ receivable: d("30"), walletBalance: d("10"), openCashouts: d("0") }).toFixed(4)).toBe("10.0000");
    expect(computeNettingAmount({ receivable: d("30"), walletBalance: d("50"), openCashouts: d("40") }).toFixed(4)).toBe("10.0000");
    expect(computeNettingAmount({ receivable: d("30"), walletBalance: d("40"), openCashouts: d("40") }).toFixed(4)).toBe("0.0000");
    expect(computeNettingAmount({ receivable: d("30"), walletBalance: d("40"), openCashouts: d("90") }).toFixed(4)).toBe("0.0000");
    expect(computeNettingAmount({ receivable: d("30"), walletBalance: d("-5"), openCashouts: d("0") }).toFixed(4)).toBe("0.0000");
    expect(computeNettingAmount({ receivable: d("0"), walletBalance: d("100"), openCashouts: d("0") }).toFixed(4)).toBe("0.0000");
    expect(computeNettingAmount({ receivable: d("-3"), walletBalance: d("100"), openCashouts: d("0") }).toFixed(4)).toBe("0.0000");
    expect(computeNettingAmount({ receivable: d("10.123456"), walletBalance: d("100"), openCashouts: d("0") }).toFixed(4)).toBe("10.1234");
  });

  test("the daily cron accepts only `M H * * *` and fails loudly on anything else", () => {
    expect(parseDailyCron("30 0 * * *")).toBe(30);
    expect(parseDailyCron("0 23 * * *")).toBe(23 * 60);
    expect(parseDailyCron(" 5  1 * * * ")).toBe(65);
    for (const bad of ["*/5 * * * *", "60 0 * * *", "0 24 * * *", "0 0 1 * *", "0 0 * * 1", "x y * * *", "", "30 0 * *"]) {
      expect(() => parseDailyCron(bad)).toThrow(/Invalid daily cron/);
    }
  });

  test("the Tripoli day clock follows the local calendar (UTC+2, no daylight saving)", () => {
    expect(zonedDayClock(new Date("2030-01-01T22:45:00Z"), "Africa/Tripoli")).toEqual({ date: "2030-01-02", minutes: 45 });
    expect(zonedDayClock(new Date("2030-01-01T21:59:00Z"), "Africa/Tripoli")).toEqual({ date: "2030-01-01", minutes: 23 * 60 + 59 });
    expect(zonedDayClock(new Date("2030-07-01T22:00:00Z"), "Africa/Tripoli")).toEqual({ date: "2030-07-02", minutes: 0 });
  });

  test("a netting entry is keyed by merchant, run and receivable account", () => {
    expect(nettingRefId("m1", "daily:2030-01-02", "acc1")).toBe("netting:m1:daily:2030-01-02:acc1");
  });

  test("the PAUSE decision knows whether netting can still bring the receivable under the ceiling", () => {
    const base = { merchantId: "m", receivable: new Decimal(30), ceiling: new Decimal(10), settlementTarget: "MERCHANT_DIRECT" };
    expect(decideCommissionReceivableCeiling(base).decision).toBe("NETTING"); // unknown: as before
    expect(decideCommissionReceivableCeiling({ ...base, nettable: new Decimal(100) }).decision).toBe("NETTING");
    expect(decideCommissionReceivableCeiling({ ...base, nettable: new Decimal(25) }).decision).toBe("NETTING"); // 30 - 25 = 5 <= 10
    expect(decideCommissionReceivableCeiling({ ...base, nettable: new Decimal(5) }).decision).toBe("PAUSE"); // 30 - 5 = 25 > 10
    expect(decideCommissionReceivableCeiling({ ...base, nettable: new Decimal(0) }).decision).toBe("PAUSE");
    expect(decideCommissionReceivableCeiling({ ...base, receivable: new Decimal(8), nettable: new Decimal(0) }).decision).not.toBe("PAUSE");
  });
});

describeDb("commission netting against the ledger (live PostgreSQL)", () => {
  test("nets the whole receivable from the wallet, and the same run never nets twice", async () => {
    const catalog = await newCatalog();
    await catalog.fundWallet("100.0000");
    const attempt = await catalog.newAttempt({ commission: "30.0000" });
    await catalog.recognizeCommission(attempt.id, "30.0000");
    expect(await catalog.receivableBalance()).toBe("30.0000");

    const first = await netInTx(catalog, "daily:2030-01-02");
    expect(first.status).toBe("NETTED");
    expect(first.amount.toFixed(4)).toBe("30.0000");
    expect(first.remainder.toFixed(4)).toBe("0.0000");
    expect(await catalog.receivableBalance()).toBe("0.0000");
    expect(await catalog.walletBalance()).toBe("70.0000");
    expect(await auditCount("COMMISSION_NETTED", catalog.merchantId)).toBe(1);

    const again = await netInTx(catalog, "daily:2030-01-02");
    expect(again.status).toBe("ALREADY_NETTED");
    expect(await catalog.walletBalance()).toBe("70.0000");
    expect(await catalog.receivableBalance()).toBe("0.0000");
    // the merchant's receivable (the PAUSE guard's view) sees the netting
    expect((await prismaCommissionNettingStore.merchantReceivable(client, catalog.merchantId)).toFixed(4)).toBe("0.0000");
  });

  test("a short wallet nets what it can, the remainder is carried forward and netted once the wallet is funded", async () => {
    const catalog = await newCatalog();
    await catalog.fundWallet("10.0000");
    const attempt = await catalog.newAttempt({ commission: "30.0000" });
    await catalog.recognizeCommission(attempt.id, "30.0000");

    const day1 = await netInTx(catalog, "daily:2030-01-02");
    expect(day1.status).toBe("NETTED");
    expect(day1.amount.toFixed(4)).toBe("10.0000");
    expect(day1.remainder.toFixed(4)).toBe("20.0000");
    expect(await catalog.walletBalance()).toBe("0.0000"); // never below zero
    expect(await catalog.receivableBalance()).toBe("20.0000");

    const day2 = await netInTx(catalog, "daily:2030-01-03");
    expect(day2.status).toBe("NO_AVAILABLE_BALANCE");
    expect(await catalog.walletBalance()).toBe("0.0000");

    await catalog.fundWallet("50.0000");
    const day3 = await netInTx(catalog, "daily:2030-01-04");
    expect(day3.status).toBe("NETTED");
    expect(day3.amount.toFixed(4)).toBe("20.0000");
    expect(await catalog.receivableBalance()).toBe("0.0000");
    expect(await catalog.walletBalance()).toBe("30.0000");
  });

  test("money reserved by an open cash-out is never netted", async () => {
    const catalog = await newCatalog();
    await catalog.fundWallet("50.0000");
    const attempt = await catalog.newAttempt({ commission: "30.0000" });
    await catalog.recognizeCommission(attempt.id, "30.0000");
    await client.cashoutRequest.create({
      data: { merchantId: catalog.merchantId, walletId: catalog.walletId, amount: new Decimal("40"), destinationBankJson: {}, state: "PENDING" },
    });

    const result = await netInTx(catalog, "daily:2030-01-02");
    expect(result.status).toBe("NETTED");
    expect(result.amount.toFixed(4)).toBe("10.0000"); // 50 - 40 reserved
    expect(await catalog.walletBalance()).toBe("40.0000");
    expect(await catalog.receivableBalance()).toBe("20.0000");
  });

  test("a wallet that is not ACTIVE is left alone", async () => {
    const catalog = await newCatalog({ walletStatus: "FROZEN" });
    await catalog.fundWallet("100.0000");
    const attempt = await catalog.newAttempt({ commission: "30.0000" });
    await catalog.recognizeCommission(attempt.id, "30.0000");
    const result = await netInTx(catalog, "daily:2030-01-02");
    expect(result.status).toBe("WALLET_NOT_ACTIVE");
    expect(await catalog.walletBalance()).toBe("100.0000");
    expect(await catalog.receivableBalance()).toBe("30.0000");
  });

  test("a dry run audits what it would net and posts nothing", async () => {
    const catalog = await newCatalog();
    await catalog.fundWallet("100.0000");
    const attempt = await catalog.newAttempt({ commission: "30.0000" });
    await catalog.recognizeCommission(attempt.id, "30.0000");
    const result = await netInTx(catalog, "daily:2030-01-02", true);
    expect(result.status).toBe("PROPOSED");
    expect(result.amount.toFixed(4)).toBe("30.0000");
    expect(await catalog.walletBalance()).toBe("100.0000");
    expect(await catalog.receivableBalance()).toBe("30.0000");
    expect(await auditCount("COMMISSION_NETTING_PROPOSED", catalog.merchantId)).toBe(1);
    expect(await auditCount("COMMISSION_NETTED", catalog.merchantId)).toBe(0);
  });

  test("concurrent runs of the same key net exactly once and never overdraw the wallet", async () => {
    const catalog = await newCatalog();
    await catalog.fundWallet("100.0000");
    const attempt = await catalog.newAttempt({ commission: "30.0000" });
    await catalog.recognizeCommission(attempt.id, "30.0000");
    const outcomes = await Promise.allSettled(Array.from({ length: 6 }, () => netInTx(catalog, "daily:2030-01-09")));
    const statuses = outcomes.map((entry) => (entry.status === "fulfilled" ? entry.value.status : `ERROR:${(entry.reason as Error).message}`));
    expect(statuses.filter((status) => status === "NETTED")).toHaveLength(1);
    expect(statuses.filter((status) => status.startsWith("ERROR")).filter((status) => !/duplicate|unique|already/i.test(status))).toEqual([]);
    expect(await catalog.walletBalance()).toBe("70.0000");
    expect(await catalog.receivableBalance()).toBe("0.0000");
  });
});

describeDb("daily commission netting worker (live PostgreSQL)", () => {
  const afterDayClose = new Date("2030-01-01T22:45:00Z"); // 00:45 on 2030-01-02 in Africa/Tripoli

  const worker = (catalog: AutomationCatalog, overrides: Partial<ConstructorParameters<typeof CommissionNettingWorker>[0]> = {}) =>
    new CommissionNettingWorker({
      db: client as never,
      repositories: new PrismaRepositories(client as never),
      ledgerPoster: catalog.poster,
      store: scopedStore(catalogs.map((entry) => entry.merchantId)),
      logger: quiet,
      clock: () => afterDayClose,
      dryRun: false,
      healthRegistry: null,
      ...overrides,
    });

  test("runs once per Tripoli day, after the day close, and not before", async () => {
    const catalog = await newCatalog();
    await catalog.fundWallet("100.0000");
    const attempt = await catalog.newAttempt({ commission: "30.0000" });
    await catalog.recognizeCommission(attempt.id, "30.0000");

    const early = worker(catalog, { clock: () => new Date("2030-01-01T22:10:00Z") }); // 00:10 local
    await early.runOnce();
    expect(early.lastRunDate).toBeNull();
    expect(await catalog.receivableBalance()).toBe("30.0000");

    const live = worker(catalog);
    await live.runOnce();
    expect(live.lastRunDate).toBe("2030-01-02");
    expect(await catalog.receivableBalance()).toBe("0.0000");
    expect(await catalog.walletBalance()).toBe("70.0000");
    expect(await auditCount("COMMISSION_NETTING_RUN", "daily:2030-01-02")).toBeGreaterThan(0);

    // the same instance does not run the same day twice; a NEW instance (a restart) re-runs but nets nothing twice
    await live.runOnce();
    await worker(catalog).runOnce();
    expect(await catalog.walletBalance()).toBe("70.0000");
    expect(await auditCount("COMMISSION_NETTED", catalog.merchantId)).toBe(1);
  });

  test("the default is a dry run: it audits the proposal and moves no money", async () => {
    const catalog = await newCatalog();
    await catalog.fundWallet("100.0000");
    const attempt = await catalog.newAttempt({ commission: "30.0000" });
    await catalog.recognizeCommission(attempt.id, "30.0000");
    await worker(catalog, { dryRun: undefined }).runOnce();
    expect(await catalog.receivableBalance()).toBe("30.0000");
    expect(await catalog.walletBalance()).toBe("100.0000");
    expect(await auditCount("COMMISSION_NETTING_PROPOSED", catalog.merchantId)).toBe(1);
  });

  test("an unpayable receivable above the ceiling pauses the merchant once, notifies once and opens one aged case", async () => {
    const catalog = await newCatalog({ commissionReceivableCeiling: "5.0000" });
    const attempt = await catalog.newAttempt({ commission: "30.0000" });
    await catalog.recognizeCommission(attempt.id, "30.0000"); // the wallet is empty: nothing can be netted
    const far = new Date("2031-06-01T22:45:00Z"); // the recognition is far older than the 30 day aging window

    await worker(catalog, { clock: () => far }).runOnce();
    await worker(catalog, { clock: () => far }).runOnce(); // a restart the same day

    expect(await auditCount("COMMISSION_RECEIVABLE_OVER_CEILING", catalog.merchantId)).toBeGreaterThanOrEqual(1);
    const notices = await client.notification.findMany({ where: { recipientMerchantId: catalog.merchantId, templateCode: "COMMISSION_RECEIVABLE_SETTLEMENT_DUE" } });
    expect(notices.map((row) => row.channel).sort()).toEqual(["EMAIL", "IN_APP"]); // one per channel, never repeated
    const cases = await client.operatorCase.findMany({ where: { subjectKey: `commission.receivable.aged:${catalog.merchantId}` } });
    expect(cases).toHaveLength(1);
    expect(cases[0]!.priority).toBe("P1");
    expect(await catalog.receivableBalance()).toBe("30.0000");
  });
});

describeDb("commission netting at cash-out time (live PostgreSQL)", () => {
  const approve = (catalog: AutomationCatalog, cashoutId: string, dryRun = false) =>
    client.$transaction((tx) =>
      executeCashout(
        {
          ledgerPoster: catalog.poster,
          repositories: new PrismaRepositories(client as never),
          commissionNetting: createCashoutCommissionNetting({ poster: catalog.poster, dryRun }),
        },
        tx as never,
        { cashoutId, decision: "APPROVE", actorUserId: catalog.userId, actorRole: "FINANCE" },
      ),
    );

  const request = async (catalog: AutomationCatalog, amount: string) =>
    (
      await client.cashoutRequest.create({
        data: { merchantId: catalog.merchantId, walletId: catalog.walletId, amount: new Decimal(amount), destinationBankJson: {}, state: "PENDING" },
      })
    ).id;

  test("the receivable is netted before the cash-out is paid, and the cash-out keeps its own money", async () => {
    const catalog = await newCatalog();
    await catalog.fundWallet("100.0000");
    const attempt = await catalog.newAttempt({ commission: "30.0000" });
    await catalog.recognizeCommission(attempt.id, "30.0000");
    const cashoutId = await request(catalog, "40.0000");

    const result = await approve(catalog, cashoutId);
    expect(result.status).toBe("EXECUTED");
    expect((await client.cashoutRequest.findUniqueOrThrow({ where: { id: cashoutId } })).state).toBe("COMPLETE");
    expect(await catalog.receivableBalance()).toBe("0.0000");
    expect(await catalog.walletBalance()).toBe("30.0000"); // 100 - 30 netted - 40 paid
    expect(await auditCount("COMMISSION_NETTED", catalog.merchantId)).toBe(1);
  });

  test("another open cash-out keeps its reservation: only the free part is netted", async () => {
    const catalog = await newCatalog();
    await catalog.fundWallet("100.0000");
    const attempt = await catalog.newAttempt({ commission: "30.0000" });
    await catalog.recognizeCommission(attempt.id, "30.0000");
    const cashoutId = await request(catalog, "40.0000");
    await request(catalog, "50.0000"); // a second open cash-out reserves 50

    const result = await approve(catalog, cashoutId);
    expect(result.status).toBe("EXECUTED");
    expect(await catalog.receivableBalance()).toBe("20.0000"); // 100 - 40 - 50 = 10 free
    expect(await catalog.walletBalance()).toBe("50.0000"); // 100 - 10 netted - 40 paid; the other 50 stays reserved
  });

  test("a cash-out the wallet cannot cover is refused and nothing is netted", async () => {
    const catalog = await newCatalog();
    await catalog.fundWallet("20.0000");
    const attempt = await catalog.newAttempt({ commission: "30.0000" });
    await catalog.recognizeCommission(attempt.id, "30.0000");
    const cashoutId = await request(catalog, "40.0000");
    await expect(approve(catalog, cashoutId)).rejects.toMatchObject({ code: "CASHOUT_INSUFFICIENT_BALANCE" });
    expect(await catalog.walletBalance()).toBe("20.0000");
    expect(await catalog.receivableBalance()).toBe("30.0000");
    expect((await client.cashoutRequest.findUniqueOrThrow({ where: { id: cashoutId } })).state).toBe("PENDING");
  });

  test("in dry run the cash-out audits the proposal and pays as usual", async () => {
    const catalog = await newCatalog();
    await catalog.fundWallet("100.0000");
    const attempt = await catalog.newAttempt({ commission: "30.0000" });
    await catalog.recognizeCommission(attempt.id, "30.0000");
    const cashoutId = await request(catalog, "40.0000");
    const result = await approve(catalog, cashoutId, true);
    expect(result.status).toBe("EXECUTED");
    expect(await catalog.receivableBalance()).toBe("30.0000");
    expect(await catalog.walletBalance()).toBe("60.0000");
    expect(await auditCount("COMMISSION_NETTING_PROPOSED", catalog.merchantId)).toBe(1);
  });

  test("a cash-out racing the daily netting never overdraws the wallet", async () => {
    const catalog = await newCatalog();
    await catalog.fundWallet("100.0000");
    const attempt = await catalog.newAttempt({ commission: "30.0000" });
    await catalog.recognizeCommission(attempt.id, "30.0000");
    const cashoutId = await request(catalog, "70.0000");
    // 100 - 70 reserved = 30 free: the daily run and the cash-out compete for the same money
    const [cashout, daily] = await Promise.allSettled([approve(catalog, cashoutId), netInTx(catalog, "daily:2030-02-01")]);
    expect(cashout.status).toBe("fulfilled");
    expect(daily.status).toBe("fulfilled");
    const wallet = new Decimal(await catalog.walletBalance());
    const receivable = new Decimal(await catalog.receivableBalance());
    expect(wallet.gte(0)).toBe(true);
    // 100 - 70 paid leaves 30 free money and 30 owed: both orders end with the receivable netted and the wallet empty
    expect(receivable.toFixed(4)).toBe("0.0000");
    expect(wallet.toFixed(4)).toBe("0.0000");
    expect((await client.cashoutRequest.findUniqueOrThrow({ where: { id: cashoutId } })).state).toBe("COMPLETE");
  });
});
