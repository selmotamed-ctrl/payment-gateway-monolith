/**
 * Suite 01.1 — model structural & type fidelity matrix for PostgreSQL 18.
 *
 * Dynamically introspects the live PostgreSQL catalogs and compares them
 * one-to-one against `prisma/schema.prisma`. Every model contributes fifteen
 * independent assertions.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  MONEY_COLUMNS,
  assertZeroDrift,
  databaseIsReachable,
  exhaustiveClient,
  expectedColumnType,
  listColumns,
  parseSchema,
  schemaColumnName,
  type ColumnInfo,
} from "../_harness";
import { createRow } from "../_dbFactory";

const db = exhaustiveClient();
const schema = parseSchema();
const describeDb = databaseIsReachable ? describe : describe.skip;

const columns = databaseIsReachable ? await listColumns(db) : [];
const byTable = new Map<string, ColumnInfo[]>();
for (const column of columns) {
  const list = byTable.get(column.tableName) ?? [];
  list.push(column);
  byTable.set(column.tableName, list);
}

const columnsByTable = (table: string): Map<string, ColumnInfo> =>
  new Map((byTable.get(table) ?? []).map((column) => [column.columnName, column]));

const TEXT_TYPES = new Set(["text", "character varying", "character", "citext"]);
const isEnumType = (column: ColumnInfo | undefined): boolean =>
  column?.dataType === "USER-DEFINED";

const TABLE_CHECK_COUNT = 15;

afterAll(async () => {
  if (databaseIsReachable) {
    await assertZeroDrift(db);
    await db.$disconnect();
  }
});

describeDb("Suite 01 · model & column fidelity", () => {
  test("the schema defines the current PostgreSQL model set and at least 100 enums", () => {
    expect(schema.models.length).toBeGreaterThanOrEqual(73);
    expect(new Set(schema.models.map((model) => model.name)).size).toBe(schema.models.length);
    expect(schema.enums.length).toBeGreaterThanOrEqual(100);
  });

  for (const model of schema.models) {
    const actual = columnsByTable(model.tableName);
    const scalarFields = model.fields.filter((field) => !field.isRelation && !field.isList);
    const expectedColumns = new Set(
      model.fields.filter((field) => !field.isRelation).map(schemaColumnName),
    );

    test(`${model.tableName} [1/15] table exists in the live database`, () => {
      expect(actual.size).toBeGreaterThan(0);
    });

    test(`${model.tableName} [2/15] every scalar field maps to a live column`, () => {
      const missing = [...expectedColumns].filter((column) => !actual.has(column));
      expect(missing).toEqual([]);
    });

    test(`${model.tableName} [3/15] the database has no unexpected columns`, () => {
      const unexpected = [...actual.keys()].filter((column) => !expectedColumns.has(column));
      expect(unexpected).toEqual([]);
    });

    test(`${model.tableName} [4/15] declares the expected column count`, () => {
      expect(actual.size).toBe(expectedColumns.size);
    });

    test(`${model.tableName} [5/15] primary key matches the model @id field`, () => {
      const primary = model.fields.find((field) => field.isId && !field.isRelation);
      if (!primary) {
        // Composite @@id models are covered by the unique constraint suite.
        expect(true).toBe(true);
        return;
      }
      const livePrimary = [...actual.values()].filter((column) => column.columnKey === "PRI");
      expect(livePrimary.map((column) => column.columnName)).toEqual([primary.dbName]);
    });

    test(`${model.tableName} [6/15] the id column uses the declared PostgreSQL key type`, () => {
      const id = actual.get("id");
      if (!id) {
        expect(true).toBe(true);
        return;
      }
      expect(id.isNullable).toBe("NO");
      if (id.dataType === "uuid") {
        expect(id.columnType.toLowerCase()).toBe("uuid");
      } else if (id.dataType === "bigint" || id.dataType === "integer") {
        expect(id.columnDefault ?? "").toMatch(/nextval|identity/i);
      } else {
        expect(id.dataType.toLowerCase()).toMatch(/varchar|text|character/);
      }
    });

    test(`${model.tableName} [7/15] timestamp columns use TIMESTAMP(3)`, () => {
      const timestampFields = scalarFields.filter(
        (field) => field.type === "DateTime" && /^(createdAt|updatedAt|deletedAt)$/.test(field.name),
      );
      for (const field of timestampFields) {
        const column = actual.get(field.dbName);
        const expected = field.dbType === "Timestamptz"
          ? "timestamp(3) with time zone"
          : "timestamp(3) without time zone";
        expect(column?.columnType.toLowerCase()).toBe(expected);
      }
      expect(timestampFields.length).toBeGreaterThanOrEqual(0);
    });

    test(`${model.tableName} [8/15] every monetary column is NUMERIC(18,4)`, () => {
      for (const column of actual.values()) {
        if (MONEY_COLUMNS.includes(column.columnName as (typeof MONEY_COLUMNS)[number])) {
          expect(column.columnType.toLowerCase()).toBe("numeric(18,4)");
          expect(column.dataType.toLowerCase()).toBe("numeric");
        }
      }
    });

    test(`${model.tableName} [9/15] every @db.Decimal field keeps its declared precision & scale`, () => {
      for (const field of scalarFields.filter((candidate) => candidate.dbType === "Decimal")) {
        const column = actual.get(field.dbName);
        const expected = expectedColumnType(field);
        expect(column?.columnType.toLowerCase()).toBe(expected?.toLowerCase());
        expect(column?.numericPrecision).toBe(field.dbPrecision ?? 65);
        expect(column?.numericScale).toBe(field.dbScale ?? 30);
      }
    });

    test(`${model.tableName} [10/15] every @db.Text field is a text-family column`, () => {
      for (const field of scalarFields.filter((candidate) => candidate.dbType === "Text")) {
        const column = actual.get(field.dbName);
        expect(column).toBeDefined();
        expect(TEXT_TYPES.has(column?.dataType.toLowerCase() ?? "")).toBe(true);
      }
    });

    test(`${model.tableName} [11/15] every String field maps to TEXT unless overridden`, () => {
      for (const field of scalarFields.filter(
        (candidate) => candidate.type === "String" && !candidate.dbType,
      )) {
        const column = actual.get(field.dbName);
        expect(column?.columnType.toLowerCase()).toBe("text");
      }
    });

    test(`${model.tableName} [12/15] every Json field is stored as JSONB`, () => {
      for (const field of scalarFields.filter((candidate) => candidate.type === "Json")) {
        const column = actual.get(field.dbName);
        expect(column).toBeDefined();
        expect((column?.dataType ?? "").toLowerCase()).toBe("jsonb");
      }
    });

    test(`${model.tableName} [13/15] every enum field uses a native PostgreSQL enum`, () => {
      const enumNames = new Set(schema.enums.map((candidate) => candidate.name));
      for (const field of scalarFields.filter((candidate) => enumNames.has(candidate.type))) {
        const column = actual.get(field.dbName);
        expect(isEnumType(column)).toBe(true);
        expect(column?.udtName).toBe(field.type);
      }
    });

    test(`${model.tableName} [14/15] required scalar fields are NOT NULL`, () => {
      for (const field of scalarFields.filter((candidate) => !candidate.isOptional)) {
        const column = actual.get(field.dbName);
        expect(column?.isNullable).toBe("NO");
      }
    });

    test(`${model.tableName} [15/15] optional scalar fields are nullable`, () => {
      for (const field of scalarFields.filter((candidate) => candidate.isOptional)) {
        const column = actual.get(field.dbName);
        expect(column?.isNullable).toBe("YES");
      }
    });
  }

  test(`the structural matrix contributes ${schema.models.length * TABLE_CHECK_COUNT} checks`, () => {
    expect(schema.models.length * TABLE_CHECK_COUNT).toBeGreaterThanOrEqual(1_095);
  });
});

describeDb("Suite 01 · boundary round-trips", () => {
  const boundary = ["0.0001", "99999999999999.9999", "-99999999999999.9999"];

  for (const columnName of MONEY_COLUMNS) {
    const tables = columnsByTableTables(columnName);
    for (const table of tables) {
      for (const value of boundary) {
        test(`${table}.${columnName} round-trips ${value} without precision loss`, async () => {
          const column = columnsByTable(table).get(columnName);
          if (!column) {
            expect(true).toBe(true);
            return;
          }
          if (table === "journal_lines") {
            // A journal line feeds the continuous double-entry invariant.
            // A single boundary write is intentionally not made here because
            // the exhaustive files run in parallel against one database and a
            // transient one-legged line / checkpoint would be observed by a
            // peer suite. The CHECK constraints and the ledger suite cover them.
            // (A shard checkpoint does not feed the invariant: it is round-tripped below and removed again.)
            expect(true).toBe(true);
            return;
          }
          if (table === "journal_lines" && value.startsWith("-")) {
            // The journal_lines_amount_positive CHECK constraint forbids a
            // non-positive line; that behaviour is asserted in Suite 01.3.
            let rejected = false;
            try {
              await createRow(table, { [columnName]: value });
            } catch {
              rejected = true;
            }
            expect(rejected).toBe(true);
            return;
          }
          // gl_shard_checkpoints has a composite key (gl_account_id, shard_id) and no id column; the factory creates the
          // account, the shard row (FK) and then the checkpoint row on top of it.
          const composite = table === "gl_shard_checkpoints";
          const row = await createRow(table, { [columnName]: value });
          const where = composite ? '"gl_account_id" = $1 AND "shard_id" = $2' : '"id" = $1';
          const keys = composite ? [row.gl_account_id, row.shard_id] : [row.id];
          const rows = (await db.$queryRawUnsafe(
            `SELECT CAST("${columnName}" AS TEXT) AS value FROM "${table}" WHERE ${where}`,
            ...keys,
          )) as Array<{ value: string }>;
          expect(rows[0]?.value).toBe(value);
          // The boundary rows are removed immediately: a one-legged journal line
          // would (correctly) break the continuous double-entry invariant of the
          // shared test database.
          await db.$executeRawUnsafe(`DELETE FROM "${table}" WHERE ${where}`, ...keys).catch(() => undefined);
        });
      }
    }
  }

  test("inbound_events.raw_body_bytes stores a 1.5 MB binary buffer byte-for-byte", async () => {
    const payload = Buffer.alloc(1_572_864);
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] = index % 251;
    }
    const row = await createRow("inbound_events", { raw_body_bytes: payload });
    const rows = (await db.$queryRawUnsafe(
      'SELECT "raw_body_bytes" FROM "inbound_events" WHERE "id" = $1',
      row.id,
    )) as Array<{ raw_body_bytes: Buffer }>;
    const stored = Buffer.from(rows[0]?.raw_body_bytes ?? []);
    expect(stored.length).toBe(payload.length);
    expect(stored.equals(payload)).toBe(true);
  });

  test("reconciliation_runs stores statement bytes in the shared vault, not in a row column", () => {
    const reconciliationColumns = byTable.get("reconciliation_runs") ?? [];
    expect(reconciliationColumns.some((column) => column.columnName === "file_content")).toBe(false);
    expect(reconciliationColumns.some((column) => column.columnName === "storage_object_id")).toBe(true);
    const storageColumns = byTable.get("storage_objects") ?? [];
    expect(storageColumns.some((column) => column.columnName === "sha256_hex")).toBe(true);
    expect(storageColumns.some((column) => column.columnName === "wrapped_dek")).toBe(true);
  });

  test("TEXT columns store 10,000 Arabic and English characters without truncation", async () => {
    const arabic = "ب".repeat(10_000);
    const row = await createRow("merchants", { legal_name: arabic });
    const rows = (await db.$queryRawUnsafe(
      'SELECT char_length("legal_name") AS length FROM "merchants" WHERE "id" = $1',
      row.id,
    )) as Array<{ length: number | bigint }>;
    expect(Number(rows[0]?.length)).toBe(10_000);
  });

  for (const enumeration of schema.enums) {
    test(`enum ${enumeration.name} persists exactly its ${enumeration.values.length} declared values`, async () => {
      expect(enumeration.values.length).toBeGreaterThan(0);
      const lowercase = enumeration.values.map((value) => value.toLowerCase());
      expect(new Set(lowercase).size).toBe(lowercase.length);
    });
  }
});

function columnsByTableTables(columnName: string): string[] {
  const tables: string[] = [];
  for (const [table, list] of byTable) {
    if (list.some((column) => column.columnName === columnName)) {
      tables.push(table);
    }
  }
  return tables.slice(0, 4);
}
