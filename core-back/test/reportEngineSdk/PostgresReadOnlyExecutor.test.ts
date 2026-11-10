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

import { partitionParentOf, summarizeExplainPlan } from "../../lib/reportEngineSdk/runtime/PostgresReadOnlyExecutor";

describe("remediation A10/A19: real partition names and honest serving labels", () => {
  test("A10: journal_lines_YYYY_MM and _default are recognised as journal_lines partitions", () => {
    expect(partitionParentOf("journal_lines_2026_01", ["journal_lines"])).toBe("journal_lines");
    expect(partitionParentOf("journal_lines_2026_12", ["journal_lines"])).toBe("journal_lines");
    expect(partitionParentOf("journal_lines_default", ["journal_lines"])).toBe("journal_lines");
    expect(partitionParentOf("journal_lines_archive", ["journal_lines"])).toBeNull();
  });

  test("A10: EXPLAIN summaries count partitions and flag a large-table seq scan", () => {
    const summary = summarizeExplainPlan([
      {
        Plan: {
          "Node Type": "Append",
          "Total Cost": 1200,
          "Plan Rows": 100,
          Plans: [
            {
              "Node Type": "Seq Scan",
              "Relation Name": "journal_lines_2026_01",
              "Total Cost": 600,
              "Plan Rows": 50,
            },
            {
              "Node Type": "Seq Scan",
              "Relation Name": "journal_lines_2026_02",
              "Total Cost": 600,
              "Plan Rows": 50,
            },
          ],
        },
      },
    ]);
    expect(summary.partitionsScanned).toBe(2);
    expect(summary.hasSeqScanOnLargeTable).toBe(true);
    expect(summary.seqScans?.every((scan) => scan.parentTable === "journal_lines")).toBe(true);
  });

  test("A19: the executor labels its serving node exactly as configured", async () => {
    const primary = new PostgresReadOnlyReportExecutor({ connectionString: "postgresql://invalid:1/never" });
    const replica = new PostgresReadOnlyReportExecutor({
      connectionString: "postgresql://invalid:1/never",
      servedBy: "replica",
    });
    expect((primary as unknown as { servedBy: string }).servedBy).toBe("primary-readonly-tx");
    expect((replica as unknown as { servedBy: string }).servedBy).toBe("replica");
    await primary.close();
    await replica.close();
  });
});
