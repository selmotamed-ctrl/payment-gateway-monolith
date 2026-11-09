import { describe, expect, test } from "bun:test";
import { client } from "../../prisma/client";
import { PostgresReadOnlyReportExecutor } from "../../lib/reportEngineSdk/runtime/PostgresReadOnlyExecutor";

const connectionString =
  process.env.DATABASE_URL ?? "postgresql://postgres@127.0.0.1:55432/payment_gateway_monolith_test";
const dbAvailable = await client
  .$queryRaw`SELECT 1`
  .then(() => true)
  .catch(() => false);

describe("RE-T12 / RE-T13: read-only executor safety", () => {
  test("RE-T12: mutation SQL is rejected before a connection is acquired", async () => {
    const executor = new PostgresReadOnlyReportExecutor({ connectionString: "postgresql://invalid:1/never" });
    await expect(
      executor.executeReadOnlyQuery({
        sql: "UPDATE merchants SET status = 'ACTIVE'",
        values: [],
        timeoutMs: 1000,
        maxRows: 10,
        queryLabel: "mutation",
      }),
    ).rejects.toThrow(/REPORT_READONLY_VIOLATION/);
    await expect(
      executor.executeReadOnlyQuery({
        sql: "SELECT 1; COPY merchants TO '/tmp/leak'",
        values: [],
        timeoutMs: 1000,
        maxRows: 10,
        queryLabel: "multi",
      }),
    ).rejects.toThrow(/REPORT_READONLY_VIOLATION/);
    await expect(
      executor.executeReadOnlyQuery({
        sql: "SELECT pg_sleep(10)",
        values: [],
        timeoutMs: 1000,
        maxRows: 10,
        queryLabel: "sleep",
      }),
    ).rejects.toThrow(/REPORT_READONLY_VIOLATION/);
    await executor.close();
  });

  test.skipIf(!dbAvailable)("RE-T13: a query over statement_timeout is cancelled and the pool recovers", async () => {
    const executor = new PostgresReadOnlyReportExecutor({ connectionString, maxPoolConnections: 1 });
    await expect(
      executor.executeReadOnlyQuery({
        sql: "SELECT count(*) FROM generate_series(1, 1000000000)",
        values: [],
        timeoutMs: 100,
        maxRows: 10,
        queryLabel: "timeout",
      }),
    ).rejects.toThrow();
    const recovered = await executor.executeReadOnlyQuery<{ ok: number }>({
      sql: "SELECT 1 AS ok",
      values: [],
      timeoutMs: 1000,
      maxRows: 1,
      queryLabel: "recover",
    });
    expect(Number(recovered.rows[0]?.ok)).toBe(1);
    await executor.close();
  });
});
