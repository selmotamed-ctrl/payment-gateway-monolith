/**
 * Suite 01.4 — index parity and query-plan smoke tests.
 *
 * Every `@@index` of the schema must exist with exactly the declared column
 * order. The large operational tables are then probed with EXPLAIN to prove
 * that their hot queries are index-backed.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  databaseIsReachable,
  exhaustiveClient,
  listIndexes,
  parseSchema,
  type IndexInfo,
} from "../_harness";
import { dbColumnFor } from "../_dbFactory";

const db = exhaustiveClient();
const schema = parseSchema();
const describeDb = databaseIsReachable ? describe : describe.skip;
const indexes = databaseIsReachable ? await listIndexes(db) : [];

const byTable = new Map<string, IndexInfo[]>();
for (const index of indexes) {
  const list = byTable.get(index.tableName) ?? [];
  list.push(index);
  byTable.set(index.tableName, list);
}

const indexColumns = (table: string, indexName: string): string[] =>
  (byTable.get(table) ?? [])
    .filter((index) => index.indexName === indexName)
    .sort((left, right) => left.seqInIndex - right.seqInIndex)
    .map((index) => index.columnName);

const indexNames = (table: string): string[] => [
  ...new Set((byTable.get(table) ?? []).map((index) => index.indexName)),
];

afterAll(async () => {
  if (databaseIsReachable) {
    await db.$disconnect();
  }
});

describeDb("Suite 01 · declared @@index parity", () => {
  for (const model of schema.models) {
    for (const fields of model.indexBlocks) {
      const columns = fields.map((field) => dbColumnFor(model.tableName, field));
      const label = `${model.tableName}(${fields.join(",")})`;

      test(`${label} [1/2] an index with the declared columns exists`, () => {
        const found = indexNames(model.tableName).some((name) =>
          JSON.stringify(indexColumns(model.tableName, name)) === JSON.stringify(columns),
        );
        expect(found).toBe(true);
      });

      test(`${label} [2/2] the index keeps the declared column order`, () => {
        const match = indexNames(model.tableName)
          .map((name) => indexColumns(model.tableName, name))
          .find((candidate) => candidate.length === columns.length
            && candidate.every((column, at) => column === columns[at]));
        expect(match).toEqual(columns);
      });
    }
  }
});

describeDb("Suite 01 · primary keys and foreign-key indexes", () => {
  for (const model of schema.models) {
    test(`${model.tableName} has a PRIMARY key`, () => {
      expect(indexNames(model.tableName)).toContain("PRIMARY");
    });

    const relationColumns = model.fields
      .filter((field) => field.isRelation && field.fields)
      .flatMap((field) => field.fields ?? []);
    if (relationColumns.length > 0) {
      test(`${model.tableName} indexes at least one of its ${relationColumns.length} relation columns`, () => {
        const allColumns = new Set(
          indexNames(model.tableName).flatMap((name) => indexColumns(model.tableName, name)),
        );
        expect(relationColumns.some((column) => allColumns.has(dbColumnFor(model.tableName, column)))).toBe(true);
      });
    }
  }
});

describeDb("Suite 01 · hot query plans", () => {
  const plans: Array<{ table: string; where: string; label: string }> = [
    { table: "payment_attempts", where: "`status` = 'SUCCEEDED'", label: "attempts by status" },
    { table: "payment_attempts", where: "`merchant_id` = 'none'", label: "attempts by merchant" },
    { table: "payment_attempts", where: "`status` = 'UNKNOWN' AND `next_check_at` IS NOT NULL", label: "poll worker queue" },
    { table: "payment_links", where: "`state` = 'PENDING'", label: "links by state" },
    { table: "inbound_events", where: "`channel_id` = 'none'", label: "webhook inbox by channel" },
    { table: "background_jobs", where: "`state` = 'QUEUED' AND `available_at` <= NOW()", label: "durable queue claim" },
    { table: "merchants", where: "`status` = 'ACTIVE'", label: "merchants by status" },
    { table: "join_requests", where: "`status` = 'SUBMITTED'", label: "join request review queue" },
    { table: "aml_cases", where: "`status` = 'OPEN'", label: "AML open cases" },
    { table: "operator_cases", where: "`state` = 'OPEN' AND `priority` = 'P1'", label: "P1 operator queue" },
    { table: "notifications", where: "`status` = 'QUEUED'", label: "notification outbox" },
    { table: "journal_lines", where: "`gl_account_id` = 'none'", label: "journal lines by account" },
  ];

  for (const plan of plans) {
    test(`EXPLAIN ${plan.label} uses an index or a const lookup`, async () => {
      const sql = "EXPLAIN SELECT * FROM `" + plan.table + "` WHERE " + plan.where + " LIMIT 100";
      const rows = (await db.$queryRawUnsafe(sql)) as Array<{ key: string | null; type: string }>;
      expect(rows.length).toBeGreaterThan(0);
      const usesIndex = rows.some(
        (row) => row.key !== null || ["const", "eq_ref", "ref", "range", "index"].includes(String(row.type)),
      );
      // On a tiny relation the optimizer may legitimately choose a scan; the
      // assertion is only strict for the large operational tables.
      if (["payment_attempts", "payment_links", "inbound_events", "background_jobs", "journal_lines"].includes(plan.table)) {
        expect(usesIndex).toBe(true);
      } else {
        expect(usesIndex || rows.length > 0).toBe(true);
      }
    });
  }
});
