/**
 * Suite 01.4 — index parity and query-plan smoke tests for PostgreSQL 18.
 *
 * Every `@@index` of the schema must exist with exactly the declared column
 * order. The storage-engine indexes (partial, BRIN, covering, GIN) are then
 * asserted by name, and the large operational tables are probed with EXPLAIN
 * to prove that their hot queries are index-backed.
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

const findIndex = (table: string, name: string): IndexInfo | undefined =>
  (byTable.get(table) ?? []).find((index) => index.indexName === name);

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
    test(`${model.tableName} has a primary key`, () => {
      expect((byTable.get(model.tableName) ?? []).some((index) => index.isPrimary)).toBe(true);
    });

    const declaredIndexColumns = new Set(
      model.indexBlocks.flat().map((field) => dbColumnFor(model.tableName, field)),
    );
    const indexedRelations = model.fields
      .filter((field) => field.isRelation && field.fields)
      .flatMap((field) => field.fields ?? [])
      .filter((column) => declaredIndexColumns.has(dbColumnFor(model.tableName, column)));
    if (indexedRelations.length > 0) {
      test(`${model.tableName} indexes its ${indexedRelations.length} declared relation columns`, () => {
        const allColumns = new Set(
          indexNames(model.tableName).flatMap((name) => indexColumns(model.tableName, name)),
        );
        expect(indexedRelations.every((column) => allColumns.has(dbColumnFor(model.tableName, column)))).toBe(true);
      });
    }
  }
});

describeDb("Suite 01 · storage-engine index inventory", () => {
  const expected: Array<{ table: string; name: string; type: string; partial?: boolean }> = [
    { table: "outbox_events", name: "outbox_events_unprocessed_idx", type: "btree", partial: true },
    { table: "outbox_events", name: "outbox_events_created_brin_idx", type: "brin" },
    { table: "audit_outbox", name: "audit_outbox_unshipped_idx", type: "btree", partial: true },
    { table: "audit_outbox", name: "audit_outbox_shipped_idx", type: "btree", partial: true },
    { table: "journal_lines", name: "journal_lines_account_id_cov_idx", type: "btree" },
    { table: "journal_lines", name: "journal_lines_created_brin_idx", type: "brin" },
    { table: "payment_attempts", name: "payment_attempts_active_expiry_partial_idx", type: "btree", partial: true },
    { table: "payment_attempts", name: "payment_attempts_active_poll_partial_idx", type: "btree", partial: true },
    { table: "payment_attempts", name: "payment_attempts_merchant_keyset_cov_idx", type: "btree" },
    { table: "payment_attempts", name: "payment_attempts_created_brin_idx", type: "brin" },
    { table: "inbound_events", name: "inbound_events_unprocessed_partial_idx", type: "btree", partial: true },
    { table: "background_jobs", name: "background_jobs_queued_partial_idx", type: "btree", partial: true },
    { table: "notifications", name: "notifications_queued_partial_idx", type: "btree", partial: true },
    { table: "merchants", name: "merchants_trgm_search_idx", type: "gin" },
    { table: "join_requests", name: "join_requests_trgm_search_idx", type: "gin" },
    { table: "users", name: "users_trgm_search_idx", type: "gin" },
    { table: "payment_attempts", name: "payment_attempts_trgm_search_idx", type: "gin" },
    { table: "journal_entries", name: "journal_entries_trgm_search_idx", type: "gin" },
  ];

  for (const index of expected) {
    test(`${index.table}.${index.name} is a ${index.type}${index.partial ? " partial" : ""} index`, () => {
      const found = findIndex(index.table, index.name);
      expect(found).toBeDefined();
      expect(found?.indexType).toBe(index.type);
      if (index.partial) {
        expect(found?.isPartial).toBe(true);
      }
    });
  }
});

describeDb("Suite 01 · hot query plans", () => {
  const plans: Array<{ table: string; where: string; label: string }> = [
    { table: "payment_attempts", where: "\"status\" = 'SUCCEEDED'", label: "attempts by status" },
    { table: "payment_attempts", where: "\"merchant_id\" = '00000000-0000-0000-0000-000000000000'::uuid", label: "attempts by merchant" },
    { table: "payment_attempts", where: "\"status\" = 'UNKNOWN' AND \"next_check_at\" IS NOT NULL", label: "poll worker queue" },
    { table: "payment_links", where: "\"state\" = 'PENDING'", label: "links by state" },
    { table: "inbound_events", where: "\"channel_id\" = '00000000-0000-0000-0000-000000000000'::uuid", label: "webhook inbox by channel" },
    { table: "background_jobs", where: "\"state\" = 'QUEUED' AND \"available_at\" <= now()", label: "durable queue claim" },
    { table: "merchants", where: "\"status\" = 'ACTIVE'", label: "merchants by status" },
    { table: "join_requests", where: "\"status\" = 'SUBMITTED'", label: "join request review queue" },
    { table: "aml_cases", where: "\"status\" = 'OPEN'", label: "AML open cases" },
    { table: "operator_cases", where: "\"state\" = 'OPEN' AND \"priority\" = 'P1'", label: "P1 operator queue" },
    { table: "notifications", where: "\"status\" = 'QUEUED'", label: "notification outbox" },
    { table: "journal_lines", where: "\"gl_account_id\" = '00000000-0000-0000-0000-000000000000'::uuid", label: "journal lines by account" },
    { table: "journal_entries", where: "\"created_at\" >= now() - interval '1 day'", label: "journal entries by created_at" },
  ];

  for (const plan of plans) {
    test(`EXPLAIN ${plan.label} uses an index`, async () => {
      const sql = `EXPLAIN (COSTS OFF) SELECT * FROM "${plan.table}" WHERE ${plan.where} LIMIT 100`;
      const rows = await db.$transaction(async (tx) => {
        // The shared test database starts nearly empty, so the planner would
        // legitimately prefer a sequential scan on a tiny relation. Disabling
        // it proves that a usable index exists for the hot predicate.
        await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off");
        return (await tx.$queryRawUnsafe(sql)) as Array<Record<string, unknown>>;
      });
      expect(rows.length).toBeGreaterThan(0);
      const text = rows.map((row) => Object.values(row).map(String).join(" ")).join("\n");
      expect(text).not.toContain("Seq Scan");
      expect(text).toMatch(/Index Scan|Index Only Scan|Bitmap Index Scan|Bitmap Heap Scan/);
    });
  }
});
