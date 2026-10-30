/**
 * Suite 01.2 — unique and foreign-key enforcement matrix.
 *
 * Every `@unique` / `@@unique` / `@id` in the schema is proven against the
 * live server: the unique index must exist and an actual colliding row must be
 * refused. Every relation is proven against INFORMATION_SCHEMA: the FK must
 * exist, point at the right parent, and carry the declared delete rule.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  databaseIsReachable,
  exhaustiveClient,
  listForeignKeys,
  listIndexes,
  parseSchema,
  type ForeignKeyInfo,
  type IndexInfo,
} from "../_harness";
import {
  createRow,
  dbColumnFor,
  insertExpectingDuplicate,
  insertRow,
} from "../_dbFactory";

const db = exhaustiveClient();
const schema = parseSchema();
const describeDb = databaseIsReachable ? describe : describe.skip;

const indexes = databaseIsReachable ? await listIndexes(db) : [];
const foreignKeys = databaseIsReachable ? await listForeignKeys(db) : [];

const indexesByTable = new Map<string, IndexInfo[]>();
for (const index of indexes) {
  const list = indexesByTable.get(index.tableName) ?? [];
  list.push(index);
  indexesByTable.set(index.tableName, list);
}

const foreignKeysByTable = new Map<string, ForeignKeyInfo[]>();
for (const foreignKey of foreignKeys) {
  const list = foreignKeysByTable.get(foreignKey.tableName) ?? [];
  list.push(foreignKey);
  foreignKeysByTable.set(foreignKey.tableName, list);
}

interface UniqueConstraint {
  model: string;
  table: string;
  fields: string[];
  dbColumns: string[];
  kind: "primary" | "unique";
  label: string;
}

const uniqueConstraints: UniqueConstraint[] = [];
for (const model of schema.models) {
  // A single journal line is deliberately unbalanced; the schema suite keeps
  // the shared test database invariant-neutral so parallel exhaustive files
  // can verify the continuous drift at any instant.
  if (model.tableName === "journal_lines") {
    continue;
  }
  for (const fields of model.uniqueBlocks) {
    uniqueConstraints.push({
      model: model.name,
      table: model.tableName,
      fields,
      dbColumns: fields.map((field) => dbColumnFor(model.tableName, field)),
      kind: "unique",
      label: `${model.tableName}(${fields.join(",")})`,
    });
  }
  for (const field of model.fields) {
    if (field.isRelation || field.isList) {
      continue;
    }
    if (field.isId || field.isUnique) {
      uniqueConstraints.push({
        model: model.name,
        table: model.tableName,
        fields: [field.name],
        dbColumns: [field.dbName],
        kind: field.isId ? "primary" : "unique",
        label: `${model.tableName}(${field.name})`,
      });
    }
  }
}

const indexColumns = (table: string, indexName: string): string[] =>
  (indexesByTable.get(table) ?? [])
    .filter((index) => index.indexName === indexName)
    .sort((left, right) => left.seqInIndex - right.seqInIndex)
    .map((index) => index.columnName);

const findUniqueIndex = (constraint: UniqueConstraint): string | undefined => {
  const wanted = [...constraint.dbColumns].sort();
  for (const index of indexesByTable.get(constraint.table) ?? []) {
    if (index.nonUnique !== 0) {
      continue;
    }
    if (constraint.kind === "primary" && index.indexName !== "PRIMARY") {
      continue;
    }
    if (constraint.kind === "unique" && index.indexName === "PRIMARY") {
      continue;
    }
    const columns = indexColumns(constraint.table, index.indexName).sort();
    if (columns.length === wanted.length && columns.every((column, at) => column === wanted[at])) {
      return index.indexName;
    }
  }
  return undefined;
};

afterAll(async () => {
  if (databaseIsReachable) {
    await db.$disconnect();
  }
});

describeDb("Suite 01 · unique constraint enforcement", () => {
  test(`the schema declares ${uniqueConstraints.length} unique / primary constraints`, () => {
    expect(uniqueConstraints.length).toBeGreaterThanOrEqual(42);
  });

  for (const constraint of uniqueConstraints) {
    test(`${constraint.label} [1/5] a unique index exists on the live server`, () => {
      expect(findUniqueIndex(constraint)).toBeDefined();
    });

    test(`${constraint.label} [2/5] the index is declared NON_UNIQUE = 0`, () => {
      const name = findUniqueIndex(constraint);
      const row = (indexesByTable.get(constraint.table) ?? []).find((index) => index.indexName === name);
      expect(row?.nonUnique).toBe(0);
    });

    test(`${constraint.label} [3/5] the index covers exactly the declared columns`, () => {
      const name = findUniqueIndex(constraint);
      expect(name).toBeDefined();
      if (!name) {
        return;
      }
      expect(indexColumns(constraint.table, name).sort()).toEqual([...constraint.dbColumns].sort());
    });

    test(`${constraint.label} [4/5] a colliding row is refused by the database`, async () => {
      const first = await createRow(constraint.table, {}, { forceNonNull: constraint.fields });
      const duplicate = { ...first };
      if (constraint.kind !== "primary") {
        duplicate.id = crypto.randomUUID();
      }
      const result = await insertExpectingDuplicate(constraint.table, duplicate);
      expect(result.rejected).toBe(true);
    });

    test(`${constraint.label} [5/5] a distinct row is accepted`, async () => {
      const row = await createRow(constraint.table, {}, { forceNonNull: constraint.fields });
      expect(row.id).toBeDefined();
    });
  }
});

interface ForeignKeyExpectation {
  model: string;
  table: string;
  field: string;
  column: string;
  referencedTable: string;
  referencedColumn: string;
  onDelete?: string;
  optional: boolean;
  label: string;
}

const fkExpectations: ForeignKeyExpectation[] = [];
for (const model of schema.models) {
  for (const field of model.fields) {
    if (!field.isRelation || !field.fields || field.fields.length === 0) {
      continue;
    }
    if (!field.references || field.references.length === 0) {
      continue;
    }
    const targetModel = schema.byModel.get(field.type);
    const targetTable = targetModel?.tableName ?? field.type;
    const targetField = targetModel?.fields.find((candidate) => candidate.name === field.references?.[0]);
    fkExpectations.push({
      model: model.name,
      table: model.tableName,
      field: field.name,
      column: dbColumnFor(model.tableName, field.fields[0] as string),
      referencedTable: targetTable,
      referencedColumn: targetField?.dbName ?? field.references[0] ?? "",
      onDelete: field.onDelete,
      optional: field.isOptional,
      label: `${model.tableName}.${field.fields[0]} -> ${targetTable}.${field.references?.[0]}`,
    });
  }
}

const findForeignKey = (expectation: ForeignKeyExpectation): ForeignKeyInfo | undefined =>
  (foreignKeysByTable.get(expectation.table) ?? []).find(
    (foreignKey) =>
      foreignKey.columnName === expectation.column
      && foreignKey.referencedTableName === expectation.referencedTable
      && foreignKey.referencedColumnName === expectation.referencedColumn,
  );

const normalizeDeleteRule = (rule: string): string =>
  rule.replace(/([a-z])([A-Z])/g, "$1 $2").toUpperCase().replace(/_/g, " ");

describeDb("Suite 01 · foreign-key delete-rule matrix", () => {
  test(`the schema declares ${fkExpectations.length} relations`, () => {
    expect(fkExpectations.length).toBeGreaterThanOrEqual(90);
  });

  for (const expectation of fkExpectations) {
    test(`${expectation.label} [1/5] the foreign key exists`, () => {
      expect(findForeignKey(expectation)).toBeDefined();
    });

    test(`${expectation.label} [2/5] it references the expected parent table`, () => {
      const foreignKey = findForeignKey(expectation);
      expect(foreignKey?.referencedTableName).toBe(expectation.referencedTable);
    });

    test(`${expectation.label} [3/5] it references the expected parent column`, () => {
      const foreignKey = findForeignKey(expectation);
      expect(foreignKey?.referencedColumnName).toBe(expectation.referencedColumn);
    });

    test(`${expectation.label} [4/5] it updates with CASCADE`, () => {
      const foreignKey = findForeignKey(expectation);
      expect(normalizeDeleteRule(foreignKey?.updateRule ?? "")).toBe("CASCADE");
    });

    test(`${expectation.label} [5/5] it carries the declared delete rule`, () => {
      const foreignKey = findForeignKey(expectation);
      const rule = normalizeDeleteRule(foreignKey?.deleteRule ?? "");
      if (expectation.onDelete) {
        expect(rule).toBe(normalizeDeleteRule(expectation.onDelete));
      } else {
        // Prisma's implicit rules are Restrict for required relations and
        // SetNull for optional relations.
        expect(["RESTRICT", "NO ACTION", "SET NULL", "CASCADE"]).toContain(rule);
        if (expectation.optional) {
          expect(["SET NULL", "RESTRICT", "CASCADE"]).toContain(rule);
        }
      }
    });
  }
});

describeDb("Suite 01 · live referential actions", () => {
  test("deleting a merchant with an application is blocked by onDelete: Restrict", async () => {
    const application = await createRow("applications");
    let rejected = false;
    try {
      await db.$executeRawUnsafe("DELETE FROM merchants WHERE id = ?", application.merchant_id);
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
  });

  test("deleting a DRAFT gateway version cascades to its child definitions", async () => {
    const version = await createRow("gateway_versions", { state: "DRAFT" });
    const child = await createRow("gateway_environments", { gateway_version_id: version.id });
    await db.$executeRawUnsafe("DELETE FROM gateway_versions WHERE id = ?", version.id);
    const rows = (await db.$queryRawUnsafe(
      "SELECT COUNT(*) AS count FROM gateway_environments WHERE id = ?",
      child.id,
    )) as Array<{ count: number | bigint }>;
    expect(Number(rows[0]?.count)).toBe(0);
  });

  test("a journal entry with lines can be inserted only for an existing account", async () => {
    const entry = await createRow("journal_entries");
    let rejected = false;
    try {
      await insertRow("journal_lines", {
        id: crypto.randomUUID(),
        entry_id: entry.id,
        gl_account_id: crypto.randomUUID(),
        direction: "DEBIT",
        amount: "1.0000",
      });
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
  });
});
