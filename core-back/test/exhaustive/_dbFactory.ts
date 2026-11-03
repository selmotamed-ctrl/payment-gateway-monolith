/**
 * A minimal, schema-driven row factory for the live exhaustive suite.
 *
 * It builds a row that satisfies every NOT NULL column of a table, recursively
 * creating the parent rows of the required foreign keys. It is used by the
 * schema suite to prove that the *real* PostgreSQL 18 constraints (unique
 * indexes, CHECK constraints, triggers) reject invalid data. It is not a
 * product module and it never stands in for one.
 */
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "../../generated/prisma/client";
import {
  exhaustiveClient,
  listColumns,
  listForeignKeys,
  parseSchema,
  type ColumnInfo,
  type ForeignKeyInfo,
} from "./_harness";

interface TableMeta {
  columns: ColumnInfo[];
  byName: Map<string, ColumnInfo>;
  foreignKeys: ForeignKeyInfo[];
}

const metaCache = new Map<string, TableMeta>();

const loadMeta = async (client: PrismaClient, table: string): Promise<TableMeta> => {
  const cached = metaCache.get(table);
  if (cached) {
    return cached;
  }
  const columns = await listColumns(client, table);
  const foreignKeys = (await listForeignKeys(client, table)).filter(
    (foreignKey) => foreignKey.tableName === table,
  );
  const meta: TableMeta = {
    columns,
    byName: new Map(columns.map((column) => [column.columnName, column])),
    foreignKeys,
  };
  metaCache.set(table, meta);
  return meta;
};

const schema = parseSchema();

/** Resolves a schema field name (camelCase) to its database column name. */
export const dbColumnName = (fieldName: string, table?: string): string => {
  if (table) {
    const model = schema.byTable.get(table);
    const field = model?.fields.find((candidate) => candidate.name === fieldName);
    if (field) {
      return field.dbName;
    }
  }
  for (const model of schema.models) {
    const field = model.fields.find((candidate) => candidate.name === fieldName);
    if (field) {
      return field.dbName;
    }
  }
  return fieldName;
};

export const dbColumnFor = (table: string, fieldName: string): string => dbColumnName(fieldName, table);

const enumColumnValues = (column: ColumnInfo, schemaType?: string): string[] => {
  const candidateNames = [
    schemaType,
    column.udtName,
    column.columnType.replace(/"/g, ""),
  ].filter((value): value is string => Boolean(value));
  for (const name of candidateNames) {
    const enumeration = schema.enums.find((entry) => entry.name === name);
    if (enumeration) {
      return enumeration.values;
    }
  }
  return [];
};

const isAuto = (column: ColumnInfo): boolean =>
  /auto_increment/i.test(column.extra) || column.isIdentity === "YES";

const isGeneratedTime = (column: ColumnInfo): boolean =>
  column.columnDefault !== null
  && /(CURRENT_TIMESTAMP|now\(\))/i.test(String(column.columnDefault));

const requiredColumns = (meta: TableMeta): ColumnInfo[] =>
  meta.columns.filter(
    (column) =>
      column.isNullable === "NO"
      && column.columnDefault === null
      && !isAuto(column)
      && !isGeneratedTime(column),
  );

/** A value that satisfies a column's type, always unique where it matters. */
const fieldTypeFor = (table: string, columnName: string): string | undefined => {
  const model = schema.byTable.get(table);
  if (!model) {
    return undefined;
  }
  const field = model.fields.find((candidate) => candidate.dbName === columnName);
  return field?.type;
};

export const valueForColumn = (
  column: ColumnInfo,
  options: { uniqueValue: string; forcePositive?: boolean; schemaType?: string } = { uniqueValue: randomUUID() },
): unknown => {
  const type = column.columnType.toLowerCase();
  const dataType = column.dataType.toLowerCase();

  if (options.schemaType === "Json") {
    return JSON.stringify({});
  }
  if (options.schemaType === "Bytes") {
    return Buffer.from(options.uniqueValue, "utf8");
  }
  if (options.schemaType === "DateTime") {
    return new Date();
  }
  if (options.schemaType === "Boolean") {
    return false;
  }

  const enumValues = enumColumnValues(column, options.schemaType);
  if (enumValues.length > 0) {
    return enumValues[0] as string;
  }

  if (dataType === "uuid") {
    return randomUUID();
  }
  if (dataType === "numeric" || dataType === "decimal") {
    return options.forcePositive ? "1.0000" : "0.0000";
  }
  if (
    ["smallint", "integer", "bigint", "int2", "int4", "int8", "serial", "bigserial", "smallserial"].includes(dataType)
  ) {
    return options.forcePositive ? 1 : 0;
  }
  if (dataType === "boolean" || dataType === "bool") {
    return false;
  }
  if (type.startsWith("character(") || type.startsWith("char(")) {
    const length = column.characterMaximumLength
      ?? Number(/char(?:acter)?\((\d+)\)/.exec(type)?.[1] ?? 1);
    if (length === 2) {
      return "LY";
    }
    if (length === 3) {
      return "LYD";
    }
    const seed = options.uniqueValue.replace(/-/g, "");
    return seed.repeat(Math.ceil(length / seed.length)).slice(0, length);
  }
  if (type.startsWith("character varying(") || type.startsWith("varchar(")) {
    const length = column.characterMaximumLength
      ?? Number(/(?:character varying|varchar)\((\d+)\)/.exec(type)?.[1] ?? 191);
    const seed = options.uniqueValue;
    return seed.slice(0, Math.min(length, seed.length));
  }
  if (dataType === "date") {
    return "1990-01-01";
  }
  if (dataType.includes("timestamp") || dataType === "datetime") {
    return new Date();
  }
  if (dataType === "json" || dataType === "jsonb") {
    return JSON.stringify({});
  }
  if (dataType === "bytea" || dataType.includes("blob")) {
    return Buffer.from(options.uniqueValue, "utf8");
  }
  if (dataType === "array" || type.endsWith("[]")) {
    return "{}";
  }
  if (
    dataType === "text"
    || dataType === "character varying"
    || dataType === "character"
    || dataType.includes("text")
    || dataType === "name"
    || dataType === "citext"
  ) {
    return options.uniqueValue;
  }
  return options.uniqueValue;
};

export interface BuildRowOptions {
  /** Schema field names (camelCase) that must be non-null even when nullable. */
  forceNonNull?: readonly string[];
  /** Already-created parent rows keyed by `${table}.${column}`. */
  parentOverride?: Record<string, unknown>;
  /** A stable unique token for this row. */
  token?: string;
}

export const buildRow = async (
  table: string,
  overrides: Record<string, unknown> = {},
  options: BuildRowOptions = {},
  client: PrismaClient = exhaustiveClient(),
  stack: string[] = [],
): Promise<Record<string, unknown>> => {
  const meta = await loadMeta(client, table);
  const token = options.token ?? randomUUID();
  const row: Record<string, unknown> = {};
  const required = requiredColumns(meta);
  const requiredNames = new Set(required.map((column) => column.columnName));
  const forced = new Set((options.forceNonNull ?? []).map((field) => dbColumnFor(table, field)));

  // Prisma generates UUID primary keys on the client. The generic required
  // column loop below supplies one for every NOT NULL column without a
  // database default (including composite primary keys).

  for (const column of meta.columns) {
    const name = column.columnName;
    if (name in overrides) {
      row[name] = overrides[name];
      continue;
    }
    if (options.parentOverride && `${table}.${name}` in options.parentOverride) {
      row[name] = options.parentOverride[`${table}.${name}`];
      continue;
    }
    const forcedValue = forced.has(name) && column.columnDefault === null && !isAuto(column);
    const isRequired = requiredNames.has(name) || forcedValue;
    if (!isRequired) {
      continue;
    }

    const foreignKey = meta.foreignKeys.find((candidate) => candidate.columnName === name);
    if (foreignKey) {
      const parentTable = foreignKey.referencedTableName;
      const parentColumn = foreignKey.referencedColumnName;
      const cycleKey = `${parentTable}:${name}`;
      if (stack.includes(cycleKey) || stack.length > 12) {
        // A cyclic required relation does not exist in this schema; a nullable
        // cycle is simply left null.
        if (column.isNullable === "YES") {
          row[name] = null;
          continue;
        }
        row[name] = valueForColumn(column, { uniqueValue: token, schemaType: fieldTypeFor(table, name) });
        continue;
      }
      const parent = await buildRow(parentTable, {}, { token: `${token}-${name}` }, client, [
        ...stack,
        cycleKey,
      ]);
      const insertedParent = await insertRowInternal(parentTable, parent, client);
      row[name] = insertedParent[parentColumn];
      continue;
    }

    row[name] = valueForColumn(column, {
      uniqueValue: `${token}-${name}`,
      forcePositive: /amount|fee|balance|ceiling|count/.test(name),
      schemaType: fieldTypeFor(table, name),
    });
  }

  // Apply overrides last so explicit values always win.
  for (const [key, value] of Object.entries(overrides)) {
    row[key] = value;
  }
  return row;
};

const coerceValue = (column: ColumnInfo | undefined, value: unknown): unknown => {
  if (value === undefined || value === null || column === undefined) {
    return value ?? null;
  }
  const dataType = column.dataType.toLowerCase();
  if (dataType === "boolean" || dataType === "bool") {
    if (value === 0 || value === "0" || value === "false") {
      return false;
    }
    if (value === 1 || value === "1" || value === "true") {
      return true;
    }
    return Boolean(value);
  }
  if (dataType === "json" || dataType === "jsonb") {
    return typeof value === "string" ? value : JSON.stringify(value);
  }
  if (dataType === "bytea") {
    return Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
  }
  if (dataType === "array" || column.columnType.toLowerCase().endsWith("[]")) {
    return Array.isArray(value) ? value : value;
  }
  return value;
};

const insertRowInternal = async (
  table: string,
  row: Record<string, unknown>,
  client: PrismaClient = exhaustiveClient(),
): Promise<Record<string, unknown>> => {
  const meta = await loadMeta(client, table);
  const columns = Object.keys(row).filter((column) => row[column] !== undefined);
  const values = columns.map((column) => coerceValue(meta.byName.get(column), row[column]));
  const quotedTable = `"${table}"`;
  const serialPrimary = meta.columns.find(
    (column) =>
      column.columnKey === "PRI"
      && /nextval\(/i.test(String(column.columnDefault ?? "")),
  );
  if (serialPrimary && row[serialPrimary.columnName] !== undefined) {
    const explicit = Number(row[serialPrimary.columnName]);
    if (Number.isFinite(explicit)) {
      // An explicit key insert does not advance a PostgreSQL sequence. Keep it
      // ahead of the explicit value so a later DEFAULT VALUES insert cannot
      // collide with a key the duplicate-key tests wrote on purpose.
      await client
        .$queryRawUnsafe(
          `SELECT setval(
             pg_get_serial_sequence($1, $2),
             GREATEST(
               (SELECT COALESCE(MAX("${serialPrimary.columnName}"), 0) FROM ${quotedTable}),
               $3
             )
           )`,
          table,
          serialPrimary.columnName,
          explicit,
        )
        .catch(() => undefined);
    }
  }
  const sql = columns.length === 0
    ? `INSERT INTO ${quotedTable} DEFAULT VALUES RETURNING *`
    : `INSERT INTO ${quotedTable} (${columns.map((column) => `"${column}"`).join(", ")}) VALUES (${columns
        .map((_column, index) => `$${index + 1}`)
        .join(", ")}) RETURNING *`;
  const inserted = (await client.$queryRawUnsafe(sql, ...values)) as Array<Record<string, unknown>>;
  return inserted[0] ? { ...row, ...inserted[0] } : row;
};

export const insertRow = insertRowInternal;

/** Builds and inserts a row, returning the actual column values. */
export const createRow = async (
  table: string,
  overrides: Record<string, unknown> = {},
  options: BuildRowOptions = {},
  client: PrismaClient = exhaustiveClient(),
): Promise<Record<string, unknown>> => {
  const row = await buildRow(table, overrides, options, client);
  return insertRowInternal(table, row, client);
};

export const deleteRowsByToken = async (
  table: string,
  token: string,
  client: PrismaClient = exhaustiveClient(),
): Promise<void> => {
  await client
    .$executeRawUnsafe(`DELETE FROM "${table}" WHERE "id"::text LIKE $1`, `%${token}%`)
    .catch(() => undefined);
};

/**
 * Returns the duplicate-key error message when the insert is refused, or null
 * when the database accepted it.
 */
export const insertExpectingDuplicate = async (
  table: string,
  row: Record<string, unknown>,
  client: PrismaClient = exhaustiveClient(),
): Promise<{ rejected: boolean; message: string }> => {
  try {
    await insertRowInternal(table, row, client);
    return { rejected: false, message: "" };
  } catch (error) {
    return { rejected: true, message: error instanceof Error ? error.message : String(error) };
  }
};

/** A field name (camelCase) -> DB column name (snake_case). */
export const columnNames = (fields: readonly string[], table?: string): string[] =>
  fields.map((field) => dbColumnName(field, table));

/** Reads the enum name of a schema field, when it is an enum field. */
export const enumForField = (modelName: string, fieldName: string): string | undefined => {
  const model = schema.byModel.get(modelName);
  const field = model?.fields.find((candidate) => candidate.name === fieldName);
  if (!field) {
    return undefined;
  }
  return schema.enums.some((candidate) => candidate.name === field.type) ? field.type : undefined;
};
