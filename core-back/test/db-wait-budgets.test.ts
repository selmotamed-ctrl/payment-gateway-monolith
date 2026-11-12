import { afterEach, describe, expect, test } from "bun:test";
import { buildPostgresPoolConfig } from "../lib/db/connectionConfig";
import { poolConnectTimeoutMs, prismaTransactionOptions, transactionMaxWaitMs } from "../lib/db/waitBudgets";

/**
 * The connection-wait budgets: production defaults when the variables are unset (fail fast), the
 * override when set (the test preload raises both; see test/setup.ts).
 */
const saved = {
  connect: process.env.PG_POOL_CONNECT_TIMEOUT_MS,
  maxWait: process.env.PG_TX_MAX_WAIT_MS,
};
const restore = (name: string, value: string | undefined): void => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};
afterEach(() => {
  restore("PG_POOL_CONNECT_TIMEOUT_MS", saved.connect);
  restore("PG_TX_MAX_WAIT_MS", saved.maxWait);
});

describe("connection wait budgets", () => {
  test("unset: every call site keeps its own fail-fast default", () => {
    delete process.env.PG_POOL_CONNECT_TIMEOUT_MS;
    delete process.env.PG_TX_MAX_WAIT_MS;
    expect(poolConnectTimeoutMs()).toBe(5_000);
    expect(buildPostgresPoolConfig("postgresql://u@h:5432/db").connectionTimeoutMillis).toBe(5_000);
    expect(transactionMaxWaitMs(2_500)).toBe(2_500);
    expect(prismaTransactionOptions()).toBeUndefined();
  });

  test("set: the override applies to the pool and to every transaction", () => {
    process.env.PG_POOL_CONNECT_TIMEOUT_MS = "20000";
    process.env.PG_TX_MAX_WAIT_MS = "15000";
    expect(buildPostgresPoolConfig("postgresql://u@h:5432/db").connectionTimeoutMillis).toBe(20_000);
    expect(transactionMaxWaitMs(2_500)).toBe(15_000);
    expect(prismaTransactionOptions()).toEqual({ maxWait: 15_000 });
  });

  test("an invalid value is ignored, never turned into zero (which would mean no wait at all)", () => {
    for (const value of ["0", "-5", "abc", "1.5", " "]) {
      process.env.PG_POOL_CONNECT_TIMEOUT_MS = value;
      process.env.PG_TX_MAX_WAIT_MS = value;
      expect(poolConnectTimeoutMs()).toBe(5_000);
      expect(transactionMaxWaitMs(2_500)).toBe(2_500);
      expect(prismaTransactionOptions()).toBeUndefined();
    }
  });
});
