import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";

const dbPath = `/tmp/fake-rails-v2-test-${process.pid}-${Date.now()}.sqlite`;

process.env.NODE_ENV = "test";
process.env.FAKE_RAILS_ADMIN_USER = "tester_admin";
process.env.FAKE_RAILS_ADMIN_PASSWORD = "Strong-Tester-Pass-2026!";
process.env.FAKE_RAILS_JWT_SECRET = "jwt-Rk7Qm2Xv9Lp4Zn8Bc3Wd6Th1Yg5Js0Af";
process.env.FAKE_RAILS_SEEDER_TOKEN = "seed-Hv3Tn8Yq1Dz6Mk4Pw9Xc2Lb7Rg5Fj0Ua";
process.env.FAKE_RAILS_DATA_DIR = "/tmp/fake-rails-v2-test-data";
process.env.FAKE_RAILS_DB_PATH = dbPath;
process.env.FAKE_RAILS_PUBLIC_BASE_URL = "http://127.0.0.1:8444";
process.env.CORE_INBOUND_BASE_URL = "http://core.lab.internal:4103/api/v1/inbound";
process.env.FAKE_RAILS_WEBHOOK_ALLOWED_HOSTS = "receiver.lab.internal";

type Ledger = typeof import("../engine/accounts/AccountLedgerService");
let ledger: Ledger;
let dbModule: typeof import("../engine/db");

beforeAll(async () => {
  ledger = await import("../engine/accounts/AccountLedgerService");
  dbModule = await import("../engine/db");
});

afterAll(() => {
  try {
    dbModule?.closeDb();
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
  } catch {
    // ignore
  }
});

const accountFor = (railCode: string, index: number) => {
  const accounts = ledger
    .listFakeAccounts({ railCode })
    .filter((account) => account.merchant_id === null && account.status === "ACTIVE" || account.status === "FROZEN");
  return accounts[index]!;
};

const resetDb = () => {
  const db = dbModule.getDb();
  db.exec("DELETE FROM fake_account_movements; DELETE FROM fake_account_holds; DELETE FROM fake_clearing_entries; DELETE FROM fake_transactions; DELETE FROM fake_accounts; DELETE FROM fake_merchant_clearing_pools;");
  ledger.ensureDefaultFakeAccountsSeeded();
};

const insertTx = (input: { id: string; railCode: string; gatewayCode: string; reference: string; amount: string; fee?: string }) => {
  dbModule.insertTransaction({
    id: input.id,
    gateway_code: input.gatewayCode,
    rail_code: input.railCode,
    env: "SANDBOX",
    our_reference: input.reference,
    provider_reference: `PROV-${input.reference}`,
    network_reference: null,
    idempotency_key: null,
    requested_amount_wire: input.amount,
    normalized_amount_lyd: input.amount,
    settled_amount_lyd: null,
    gateway_fee_lyd: input.fee ?? "0.0000",
    currency: "LYD",
    collection_mode: "OTP_PULL",
    customer_identifier_masked: null,
    expected_otp: "123456",
    status: "INITIATED",
    assigned_fail_phase: null,
    assigned_failure_mode: null,
    inquiry_override_status: null,
    return_url: null,
    cancel_url: null,
    webhook_url: null,
    is_seeded_historical: 0,
    created_at: dbModule.nowIso(),
    updated_at: dbModule.nowIso(),
  });
};

describe("stateful Fake Rails v2 accounts", () => {
  test("seeds five test personas for every emulated rail", () => {
    ledger.ensureDefaultFakeAccountsSeeded();
    const rails = new Set(ledger.listFakeAccounts({}).map((account) => account.rail_code));
    expect(rails.size).toBe(20);
    expect(ledger.listFakeAccounts({}).length).toBeGreaterThanOrEqual(100);
    for (const railCode of rails) {
      const personas = ledger.listFakeAccounts({ railCode });
      expect(personas).toHaveLength(5);
      expect(personas.filter((account) => account.status === "FROZEN")).toHaveLength(1);
      expect(personas.some((account) => account.available_balance_lyd === "5.0000")).toBe(true);
    }
  });

  test("a funded account reserves, captures and credits the clearing pool", () => {
    resetDb();
    const rich = ledger.listFakeAccounts({ railCode: "sadad" })[0]!;
    insertTx({ id: "TX-CAPTURE-1", railCode: "sadad", gatewayCode: "sadad", reference: "REF-CAPTURE-1", amount: "200.0000" });
    const hold = ledger.reserveAccountFundsForTransaction({
      railCode: "sadad",
      gatewayCode: "sadad",
      identifier: rich.identifier,
      transactionId: "TX-CAPTURE-1",
      amountLyd: "200.0000",
    });
    expect(hold.allowed).toBe(true);
    expect(hold.account.available_balance_lyd).toBe("49800.0000");
    expect(hold.account.reserved_balance_lyd).toBe("200.0000");

    const captured = ledger.captureAccountHoldForTransaction("TX-CAPTURE-1");
    expect(captured?.reserved_balance_lyd).toBe("0.0000");
    expect(captured?.available_balance_lyd).toBe("49800.0000");
    expect(captured?.daily_spent_lyd).toBe("200.0000");

    const pools = ledger.listClearingPools().filter((pool) => pool.rail_code === "sadad");
    expect(pools).toHaveLength(1);
    expect(pools[0]!.pending_settlement_lyd).toBe("200.0000");
    expect(pools[0]!.tx_count).toBe(1);
  });

  test("insufficient balance, daily limit and frozen status decline deterministically", () => {
    resetDb();
    const personas = ledger.listFakeAccounts({ railCode: "sadad" });
    const low = personas[2]!;
    const limited = personas[3]!;
    const frozen = personas[4]!;

    expect(
      ledger.reserveAccountFundsForTransaction({
        railCode: "sadad",
        gatewayCode: "sadad",
        identifier: low.identifier,
        transactionId: "TX-LOW",
        amountLyd: "200.0000",
      }),
    ).toMatchObject({ allowed: false, declineCode: "INSUFFICIENT_FUNDS" });

    expect(
      ledger.reserveAccountFundsForTransaction({
        railCode: "sadad",
        gatewayCode: "sadad",
        identifier: limited.identifier,
        transactionId: "TX-LIMIT",
        amountLyd: "10.0000",
      }),
    ).toMatchObject({ allowed: false, declineCode: "LIMIT_EXCEEDED" });

    expect(
      ledger.reserveAccountFundsForTransaction({
        railCode: "sadad",
        gatewayCode: "sadad",
        identifier: frozen.identifier,
        transactionId: "TX-FROZEN",
        amountLyd: "10.0000",
      }),
    ).toMatchObject({ allowed: false, declineCode: "ACCOUNT_FROZEN" });
  });

  test("a released hold returns the reserved amount", () => {
    resetDb();
    const rich = ledger.listFakeAccounts({ railCode: "mobicash" })[0]!;
    ledger.reserveAccountFundsForTransaction({
      railCode: "mobicash",
      gatewayCode: "mobicash",
      identifier: rich.identifier,
      transactionId: "TX-RELEASE-1",
      amountLyd: "125.0000",
    });
    const released = ledger.releaseAccountHoldForTransaction("TX-RELEASE-1", "customer cancelled");
    expect(released?.available_balance_lyd).toBe("50000.0000");
    expect(released?.reserved_balance_lyd).toBe("0.0000");
  });

  test("refunds are credited back and cannot exceed the captured amount", () => {
    resetDb();
    const rich = ledger.listFakeAccounts({ railCode: "onepay" })[0]!;
    dbModule.insertTransaction({
      id: "TX-REFUND-1",
      gateway_code: "onepay",
      rail_code: "onepay",
      env: "SANDBOX",
      our_reference: "REF-REFUND-1",
      provider_reference: "PROV-REFUND-1",
      network_reference: null,
      idempotency_key: null,
      requested_amount_wire: "100.0000",
      normalized_amount_lyd: "100.0000",
      settled_amount_lyd: null,
      gateway_fee_lyd: "0.0000",
      currency: "LYD",
      collection_mode: "OTP_PULL",
      customer_identifier_masked: rich.identifier,
      expected_otp: "123456",
      status: "INITIATED",
      assigned_fail_phase: null,
      assigned_failure_mode: null,
      inquiry_override_status: null,
      return_url: null,
      cancel_url: null,
      webhook_url: null,
      is_seeded_historical: 0,
      created_at: dbModule.nowIso(),
      updated_at: dbModule.nowIso(),
    });
    ledger.reserveAccountFundsForTransaction({
      railCode: "onepay",
      gatewayCode: "onepay",
      identifier: rich.identifier,
      transactionId: "TX-REFUND-1",
      amountLyd: "100.0000",
    });
    ledger.captureAccountHoldForTransaction("TX-REFUND-1");

    const first = ledger.refundAccountForTransaction("TX-REFUND-1", "40.0000");
    expect(first?.available_balance_lyd).toBe("49940.0000");
    expect(() => ledger.refundAccountForTransaction("TX-REFUND-1", "70.0000")).toThrow(
      /exceed the captured/i,
    );
    const second = ledger.refundAccountForTransaction("TX-REFUND-1", "60.0000");
    expect(second?.available_balance_lyd).toBe("50000.0000");
  });

  test("an unknown identifier is auto-enrolled with a controllable default balance", () => {
    resetDb();
    const account = ledger.findOrAutoCreateAccount({
      railCode: "sadad",
      gatewayCode: "sadad",
      identifier: "0915559999",
    });
    expect(account.available_balance_lyd).toBe("2500.0000");
    expect(account.status).toBe("ACTIVE");
    const adjusted = ledger.adjustFakeAccountBalance({
      accountId: account.id,
      availableBalanceLyd: "77.5000",
      staticOtp: "424242",
      reason: "test",
    });
    expect(adjusted.available_balance_lyd).toBe("77.5000");
    expect(adjusted.static_otp).toBe("424242");
    const movements = ledger.listAccountMovements(account.id);
    expect(movements.length).toBeGreaterThan(0);
  });

  test("merchant reset removes only that merchant's custom accounts", () => {
    resetDb();
    const merchantA = ledger.findOrAutoCreateAccount({
      railCode: "sadad",
      gatewayCode: "sadad",
      identifier: "0917770001",
      merchantId: "11111111-1111-4111-8111-111111111111",
    });
    const merchantB = ledger.findOrAutoCreateAccount({
      railCode: "sadad",
      gatewayCode: "sadad",
      identifier: "0917770002",
      merchantId: "22222222-2222-4222-8222-222222222222",
    });
    const removed = ledger.resetFakeAccounts({ merchantId: "11111111-1111-4111-8111-111111111111" });
    expect(removed).toBe(101);
    const remaining = ledger.listFakeAccounts({});
    expect(remaining.some((account) => account.id === merchantA.id)).toBe(false);
    expect(remaining.some((account) => account.id === merchantB.id)).toBe(true);
  });

  test("clearing statements total captures and refunds and settle the pools", () => {
    resetDb();
    const rich = ledger.listFakeAccounts({ railCode: "mobicash" })[0]!;
    dbModule.insertTransaction({
      id: "TX-CLEARING-1",
      gateway_code: "mobicash",
      rail_code: "mobicash",
      env: "SANDBOX",
      our_reference: "REF-CLEARING-1",
      provider_reference: "PROV-CLEARING-1",
      network_reference: null,
      idempotency_key: null,
      requested_amount_wire: "100.0000",
      normalized_amount_lyd: "100.0000",
      settled_amount_lyd: null,
      gateway_fee_lyd: "1.5000",
      currency: "LYD",
      collection_mode: "OTP_PULL",
      customer_identifier_masked: rich.identifier,
      expected_otp: "123456",
      status: "INITIATED",
      assigned_fail_phase: null,
      assigned_failure_mode: null,
      inquiry_override_status: null,
      return_url: null,
      cancel_url: null,
      webhook_url: null,
      is_seeded_historical: 0,
      created_at: dbModule.nowIso(),
      updated_at: dbModule.nowIso(),
    });
    ledger.reserveAccountFundsForTransaction({
      railCode: "mobicash",
      gatewayCode: "mobicash",
      identifier: rich.identifier,
      transactionId: "TX-CLEARING-1",
      amountLyd: "100.0000",
    });
    ledger.captureAccountHoldForTransaction("TX-CLEARING-1");
    ledger.refundAccountForTransaction("TX-CLEARING-1", "25.0000");

    const statement = ledger.generateClearingStatement({ gatewayCode: "mobicash" });
    expect(statement.totals.grossLyd).toBe("100.0000");
    expect(statement.totals.refundsLyd).toBe("25.0000");
    expect(statement.totals.netLyd).toBe("75.0000");
    expect(statement.totals.feesLyd).toBe("1.5000");
    expect(statement.csv.split("\n").length).toBe(3);

    const settled = ledger.markClearingSettled({ gatewayCode: "mobicash" });
    expect(settled).toBe(2);
    expect(ledger.generateClearingStatement({ gatewayCode: "mobicash" }).rows).toHaveLength(0);
  });
});
