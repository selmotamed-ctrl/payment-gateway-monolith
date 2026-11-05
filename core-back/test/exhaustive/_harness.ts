/**
 * Shared infrastructure for the exhaustive verification suites.
 *
 * The suites in `test/exhaustive/**` are deliberately NOT mock-against-mock:
 * they drive the real production modules and, where the design demands it,
 * the live PostgreSQL 18 schema. This harness provides:
 *
 *  - an isolated Prisma client against the dedicated test database,
 *  - a deterministic `xoshiro128**` seeded PRNG (seed "pg-exhaustive-2026"),
 *  - the continuous double-entry invariant hook,
 *  - a parser for `prisma/schema.prisma` used by the schema suite,
 *  - PostgreSQL catalog readers for the live database,
 *  - small id / money / decimal helpers.
 *
 * Nothing here is a stand-in for production behaviour: it only provisions
 * fixtures and reads metadata.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Decimal } from "decimal.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client";
import { buildPostgresPoolConfig } from "../../lib/db/connectionConfig";
import { pinUtcInConnectionUrl } from "../../lib/storageEngine/utcSession";
import { InvariantVerifier } from "../../engine/ledger/InvariantVerifier";

export const EXHAUSTIVE_SEED = "pg-exhaustive-2026";

export const EXHAUSTIVE_DATABASE_URL =
  process.env.EXHAUSTIVE_DATABASE_URL
  ?? process.env.POSTGRES_TEST_DATABASE_URL
  ?? "postgresql://postgres@127.0.0.1:55432/payment_gateway_monolith_test";

let clientInstance: PrismaClient | undefined;

/** A dedicated client so the exhaustive suites never share the cached app client. */
export const exhaustiveClient = (): PrismaClient => {
  if (!clientInstance) {
    clientInstance = new PrismaClient({
      adapter: new PrismaPg(buildPostgresPoolConfig(pinUtcInConnectionUrl(EXHAUSTIVE_DATABASE_URL))),
      log: [],
    });
  }
  return clientInstance;
};

/** A fresh client, for tests that model independent worker nodes. */
export const createExhaustiveClient = (): PrismaClient =>
  new PrismaClient({
    adapter: new PrismaPg(
      buildPostgresPoolConfig(pinUtcInConnectionUrl(EXHAUSTIVE_DATABASE_URL), {
        applicationName: `pg-core-back-exhaustive-${randomUUID().slice(0, 8)}`,
      }),
    ),
    log: [],
  });

export const disconnectExhaustiveClient = async (): Promise<void> => {
  if (clientInstance) {
    await clientInstance.$disconnect();
    clientInstance = undefined;
  }
};

let reachablePromise: Promise<boolean> | undefined;

export const probeDatabase = async (): Promise<boolean> => {
  if (!reachablePromise) {
    reachablePromise = (async () => {
      try {
        await exhaustiveClient().$queryRawUnsafe("SELECT 1 AS ok");
        return true;
      } catch {
        return false;
      }
    })();
  }
  return reachablePromise;
};

export const databaseIsReachable = await probeDatabase();

/** A short unique suffix that keeps every run repeatable and collision free. */
export const runId = (): string => randomUUID().replace(/-/g, "").slice(0, 16);

export const unique = (prefix: string): string => `${prefix}-${runId()}`;

/** A per-file suffix, computed once. */
export const FILE_RUN = runId();

export const sha256 = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

export const dec = (value: unknown): Decimal => new Decimal(String(value ?? "0"));

export const decString = (value: unknown, places = 4): string => dec(value).toFixed(places);

/* -------------------------------------------------------------------------- */
/* Deterministic PRNG: xoshiro128**                                           */
/* -------------------------------------------------------------------------- */

export class Xoshiro128StarStar {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  constructor(seed: string = EXHAUSTIVE_SEED) {
    const digest = createHash("sha256").update(seed).digest();
    this.s0 = digest.readUInt32LE(0) || 1;
    this.s1 = digest.readUInt32LE(4) || 2;
    this.s2 = digest.readUInt32LE(8) || 3;
    this.s3 = digest.readUInt32LE(12) || 4;
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) {
      this.s0 = 1;
    }
  }

  private rotl(x: number, k: number): number {
    return ((x << k) | (x >>> (32 - k))) >>> 0;
  }

  nextUint32(): number {
    const result = Math.imul(this.rotl(Math.imul(this.s1, 5) >>> 0, 7) >>> 0, 9) >>> 0;
    const t = (this.s1 << 9) >>> 0;
    this.s2 ^= this.s0;
    this.s3 ^= this.s1;
    this.s1 ^= this.s2;
    this.s0 ^= this.s3;
    this.s2 ^= t;
    this.s3 = this.rotl(this.s3, 11);
    return result >>> 0;
  }

  /** A float in [0, 1). */
  next(): number {
    return this.nextUint32() / 0x1_0000_0000;
  }

  /** An integer in [min, max]. */
  int(min: number, max: number): number {
    return min + (this.nextUint32() % (max - min + 1));
  }

  pick<T>(values: readonly T[]): T {
    if (values.length === 0) {
      throw new Error("Cannot pick from an empty collection");
    }
    return values[this.int(0, values.length - 1)] as T;
  }

  /** A fixed-scale decimal string in [min, max] with `places` decimals. */
  decimalString(min: number, max: number, places = 4): string {
    const factor = 10 ** places;
    const low = Math.round(min * factor);
    const high = Math.round(max * factor);
    const raw = this.int(low, high);
    return (raw / factor).toFixed(places);
  }
}

/* -------------------------------------------------------------------------- */
/* Money helpers                                                              */
/* -------------------------------------------------------------------------- */

export const money = {
  of: (value: unknown): Decimal => dec(value),
  sum: (values: readonly unknown[]): Decimal => values.reduce<Decimal>((acc, value) => acc.plus(dec(value)), new Decimal(0)),
  isZero: (value: unknown): boolean => dec(value).isZero(),
  eq: (a: unknown, b: unknown): boolean => dec(a).equals(dec(b)),
  gt0: (value: unknown): boolean => dec(value).gt(0),
};

export const summarizeLines = (
  lines: ReadonlyArray<{ direction: string; amount: unknown }>,
): { debit: Decimal; credit: Decimal; balanced: boolean; allPositive: boolean } => {
  const debit = lines
    .filter((line) => line.direction === "DEBIT")
    .reduce<Decimal>((acc, line) => acc.plus(dec(line.amount)), new Decimal(0));
  const credit = lines
    .filter((line) => line.direction === "CREDIT")
    .reduce<Decimal>((acc, line) => acc.plus(dec(line.amount)), new Decimal(0));
  return {
    debit,
    credit,
    balanced: debit.equals(credit) && debit.gt(0),
    allPositive: lines.every((line) => dec(line.amount).gt(0)),
  };
};

/* -------------------------------------------------------------------------- */
/* Continuous double-entry invariant hook                                     */
/* -------------------------------------------------------------------------- */

export interface AccountBalanceLike {
  accountId: string;
  accountType:
    | "TREASURY"
    | "GATEWAY_CLEARING"
    | "MERCHANT_WALLET"
    | "PLATFORM_INCOME"
    | "PROVIDER_FEE_EXPENSE"
    | "GATEWAY_FEE_EXPENSE"
    | "GATEWAY_FEE_ACCRUAL"
    | "COMMISSION_RECEIVABLE"
    | "AML_HOLD"
    | "CHARGEBACK_RESERVE"
    | "SUSPENSE";
  checkpointBalance: Decimal;
  delta: Decimal;
  liveBalance: Decimal;
  checkpointAt?: Date;
}

export interface InvariantSnapshot {
  ok: boolean;
  drift: string;
  leftSide: string;
  rightSide: string;
}

export const verifyInvariant = async (client: PrismaClient = exhaustiveClient()): Promise<InvariantSnapshot> => {
  const result = await new InvariantVerifier(client as never).verify();
  return {
    ok: result.ok,
    drift: result.drift.toFixed(4),
    leftSide: result.leftSide.toFixed(4),
    rightSide: result.rightSide.toFixed(4),
  };
};

/** Asserts a zero drift; every DB suite runs this in its afterEach/afterAll. */
export const assertZeroDrift = async (client: PrismaClient = exhaustiveClient()): Promise<InvariantSnapshot> => {
  const snapshot = await verifyInvariant(client);
  if (!snapshot.ok) {
    throw new Error(
      `Continuous double-entry invariant failed: drift=${snapshot.drift} left=${snapshot.leftSide} right=${snapshot.rightSide}`,
    );
  }
  return snapshot;
};

/* -------------------------------------------------------------------------- */
/* Raw database helpers                                                       */
/* -------------------------------------------------------------------------- */

export const currentDatabase = async (client: PrismaClient = exhaustiveClient()): Promise<string> => {
  const rows = (await client.$queryRawUnsafe("SELECT current_database() AS db")) as Array<{ db: string }>;
  return String(rows[0]?.db ?? "");
};

export interface ColumnInfo {
  tableName: string;
  columnName: string;
  columnType: string;
  dataType: string;
  udtName: string;
  isNullable: string;
  columnDefault: string | null;
  columnKey: string;
  extra: string;
  numericPrecision: number | null;
  numericScale: number | null;
  characterMaximumLength: number | null;
  isIdentity: string;
}

export const listColumns = async (
  client: PrismaClient = exhaustiveClient(),
  table?: string,
): Promise<ColumnInfo[]> => {
  const rows = (await client.$queryRawUnsafe(
    `SELECT c.table_name::text AS "tableName",
            c.column_name::text AS "columnName",
            pg_catalog.format_type(a.atttypid, a.atttypmod) AS "columnType",
            c.data_type::text AS "dataType",
            c.udt_name::text AS "udtName",
            c.is_nullable::text AS "isNullable",
            c.column_default AS "columnDefault",
            CASE WHEN EXISTS (
              SELECT 1
                FROM information_schema.table_constraints tc
                JOIN information_schema.key_column_usage kcu
                  ON kcu.constraint_name = tc.constraint_name
                 AND kcu.constraint_schema = tc.constraint_schema
                 AND kcu.table_name = tc.table_name
               WHERE tc.constraint_type = 'PRIMARY KEY'
                 AND tc.table_schema = c.table_schema
                 AND tc.table_name = c.table_name
                 AND kcu.column_name = c.column_name
            ) THEN 'PRI' ELSE '' END AS "columnKey",
            '' AS extra,
            c.numeric_precision AS "numericPrecision",
            c.numeric_scale AS "numericScale",
            c.character_maximum_length AS "characterMaximumLength",
            c.is_identity::text AS "isIdentity"
       FROM information_schema.columns c
       JOIN pg_catalog.pg_namespace n ON n.nspname = c.table_schema
       JOIN pg_catalog.pg_class cl ON cl.relname = c.table_name AND cl.relnamespace = n.oid
       JOIN pg_catalog.pg_attribute a
         ON a.attrelid = cl.oid AND a.attname = c.column_name AND a.attnum > 0 AND NOT a.attisdropped
      WHERE c.table_schema = 'public' ${table ? "AND c.table_name = $1" : ""}
      ORDER BY c.table_name, c.ordinal_position`,
    ...(table ? [table] : []),
  )) as ColumnInfo[];
  return rows.map((row) => ({
    ...row,
    numericPrecision: row.numericPrecision === null ? null : Number(row.numericPrecision),
    numericScale: row.numericScale === null ? null : Number(row.numericScale),
    characterMaximumLength:
      row.characterMaximumLength === null ? null : Number(row.characterMaximumLength),
  }));
};

export interface IndexInfo {
  tableName: string;
  indexName: string;
  nonUnique: number;
  seqInIndex: number;
  columnName: string;
  indexType: string;
  isPrimary: boolean;
  isPartial: boolean;
}

export const listIndexes = async (
  client: PrismaClient = exhaustiveClient(),
  table?: string,
): Promise<IndexInfo[]> => {
  const rows = (await client.$queryRawUnsafe(
    `SELECT t.relname::text AS "tableName",
            i.relname::text AS "indexName",
            CASE WHEN ix.indisunique THEN 0 ELSE 1 END AS "nonUnique",
            k.ord AS "seqInIndex",
            a.attname::text AS "columnName",
            am.amname::text AS "indexType",
            ix.indisprimary AS "isPrimary",
            (ix.indpred IS NOT NULL) AS "isPartial"
       FROM pg_catalog.pg_index ix
       JOIN pg_catalog.pg_class t ON t.oid = ix.indrelid
       JOIN pg_catalog.pg_class i ON i.oid = ix.indexrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
       JOIN pg_catalog.pg_am am ON am.oid = i.relam
       CROSS JOIN LATERAL generate_series(1, ix.indnkeyatts) AS k(ord)
       JOIN pg_catalog.pg_attribute a
         ON a.attrelid = t.oid AND a.attnum = ix.indkey[k.ord - 1]
      WHERE n.nspname = 'public' ${table ? "AND t.relname = $1" : ""}
      ORDER BY t.relname, i.relname, k.ord`,
    ...(table ? [table] : []),
  )) as Array<Omit<IndexInfo, "nonUnique" | "seqInIndex" | "isPrimary" | "isPartial"> & {
    nonUnique: number | bigint | boolean;
    seqInIndex: number | bigint;
    isPrimary: boolean;
    isPartial: boolean;
  }>;
  return rows.map((row) => ({
    ...row,
    nonUnique: Number(row.nonUnique),
    seqInIndex: Number(row.seqInIndex),
    isPrimary: Boolean(row.isPrimary),
    isPartial: Boolean(row.isPartial),
  }));
};

export interface ForeignKeyInfo {
  constraintName: string;
  tableName: string;
  columnName: string;
  referencedTableName: string;
  referencedColumnName: string;
  deleteRule: string;
  updateRule: string;
  ordinalPosition: number;
}

const referentialAction = (code: string): string => {
  switch (code) {
    case "a":
      return "NO ACTION";
    case "r":
      return "RESTRICT";
    case "c":
      return "CASCADE";
    case "n":
      return "SET NULL";
    case "d":
      return "SET DEFAULT";
    default:
      return "NO ACTION";
  }
};

export const listForeignKeys = async (
  client: PrismaClient = exhaustiveClient(),
  table?: string,
): Promise<ForeignKeyInfo[]> => {
  const rows = (await client.$queryRawUnsafe(
    `SELECT con.conname::text AS "constraintName",
            src.relname::text AS "tableName",
            sa.attname::text AS "columnName",
            tgt.relname::text AS "referencedTableName",
            ta.attname::text AS "referencedColumnName",
            con.confdeltype::text AS "deleteActionCode",
            con.confupdtype::text AS "updateActionCode",
            k.ord AS "ordinalPosition"
       FROM pg_catalog.pg_constraint con
       JOIN pg_catalog.pg_class src ON src.oid = con.conrelid
       JOIN pg_catalog.pg_class tgt ON tgt.oid = con.confrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = src.relnamespace
       CROSS JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(srcatt, tgtatt, ord)
       JOIN pg_catalog.pg_attribute sa ON sa.attrelid = con.conrelid AND sa.attnum = k.srcatt
       JOIN pg_catalog.pg_attribute ta ON ta.attrelid = con.confrelid AND ta.attnum = k.tgtatt
      WHERE con.contype = 'f'
        AND n.nspname = 'public' ${table ? "AND src.relname = $1" : ""}
      ORDER BY src.relname, con.conname, k.ord`,
    ...(table ? [table] : []),
  )) as Array<Omit<ForeignKeyInfo, "deleteRule" | "updateRule"> & {
    deleteActionCode: string;
    updateActionCode: string;
  }>;
  return rows.map((row) => ({
    constraintName: row.constraintName,
    tableName: row.tableName,
    columnName: row.columnName,
    referencedTableName: row.referencedTableName,
    referencedColumnName: row.referencedColumnName,
    deleteRule: referentialAction(row.deleteActionCode),
    updateRule: referentialAction(row.updateActionCode),
    ordinalPosition: Number(row.ordinalPosition),
  }));
};

export interface CheckConstraintInfo {
  constraintName: string;
  tableName: string;
  checkClause: string;
}

export const listCheckConstraints = async (
  client: PrismaClient = exhaustiveClient(),
): Promise<CheckConstraintInfo[]> => {
  const rows = (await client.$queryRawUnsafe(
    `SELECT con.conname::text AS "constraintName",
            rel.relname::text AS "tableName",
            pg_catalog.pg_get_constraintdef(con.oid) AS "checkClause"
       FROM pg_catalog.pg_constraint con
       JOIN pg_catalog.pg_class rel ON rel.oid = con.conrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = rel.relnamespace
      WHERE con.contype = 'c' AND n.nspname = 'public'
      ORDER BY rel.relname, con.conname`,
  )) as CheckConstraintInfo[];
  return rows;
};

export interface TriggerInfo {
  triggerName: string;
  eventObjectTable: string;
  actionTiming: string;
  eventManipulation: string;
  actionStatement: string;
}

export const listTriggers = async (
  client: PrismaClient = exhaustiveClient(),
): Promise<TriggerInfo[]> => {
  const rows = (await client.$queryRawUnsafe(
    `SELECT trigger_name AS "triggerName",
            event_object_table AS "eventObjectTable",
            action_timing AS "actionTiming",
            event_manipulation AS "eventManipulation",
            action_statement AS "actionStatement"
       FROM information_schema.triggers
      WHERE trigger_schema = 'public'
      ORDER BY event_object_table, action_timing, event_manipulation`,
  )) as TriggerInfo[];
  return rows;
};

/* -------------------------------------------------------------------------- */
/* prisma/schema.prisma parser                                                */
/* -------------------------------------------------------------------------- */

export interface SchemaField {
  name: string;
  dbName: string;
  rawType: string;
  type: string;
  isList: boolean;
  isOptional: boolean;
  attributes: string;
  isRelation: boolean;
  relationName?: string;
  onDelete?: string;
  references?: string[];
  fields?: string[];
  isId: boolean;
  isUnique: boolean;
  dbType?: string;
  dbLength?: number;
  dbPrecision?: number;
  dbScale?: number;
}

export interface SchemaModel {
  name: string;
  tableName: string;
  fields: SchemaField[];
  block: string;
  uniqueBlocks: string[][];
  idBlocks: string[][];
  indexBlocks: string[][];
}

export interface SchemaEnum {
  name: string;
  values: string[];
}

export interface ParsedSchema {
  models: SchemaModel[];
  enums: SchemaEnum[];
  byModel: Map<string, SchemaModel>;
  byTable: Map<string, SchemaModel>;
}

const camelToSnake = (value: string): string =>
  value.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/^_/, "").toLowerCase();

const parseList = (value: string): string[] =>
  value
    .replace(/[\[\]]/g, "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

const parseArgsMap = (attributes: string): Record<string, string> => {
  const result: Record<string, string> = {};
  const relationIndex = attributes.indexOf("@relation(");
  if (relationIndex < 0) {
    return result;
  }
  let depth = 0;
  let start = -1;
  for (let index = relationIndex + "@relation".length; index < attributes.length; index += 1) {
    const char = attributes[index];
    if (char === "(") {
      depth += 1;
      if (depth === 1) {
        start = index + 1;
      }
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const body = attributes.slice(start, index);
        let key = "";
        let buffer = "";
        let bracketDepth = 0;
        let inQuotes = false;
        for (let cursor = 0; cursor < body.length; cursor += 1) {
          const current = body[cursor] as string;
          if (current === '"') {
            inQuotes = !inQuotes;
          }
          if (!inQuotes) {
            if (current === "[") {
              bracketDepth += 1;
            } else if (current === "]") {
              bracketDepth -= 1;
            } else if (current === ":" && bracketDepth === 0) {
              key = buffer.trim();
              buffer = "";
              continue;
            } else if (current === "," && bracketDepth === 0) {
              if (key) {
                result[key] = buffer.trim();
              }
              key = "";
              buffer = "";
              continue;
            }
          }
          buffer += current;
        }
        if (key) {
          result[key] = buffer.trim();
        }
        break;
      }
    }
  }
  return result;
};

let cachedSchema: ParsedSchema | undefined;

export const parseSchema = (): ParsedSchema => {
  if (cachedSchema) {
    return cachedSchema;
  }
  const path = join(import.meta.dir, "../../prisma/schema.prisma");
  const source = readFileSync(path, "utf8");
  const models: SchemaModel[] = [];
  const enums: SchemaEnum[] = [];

  const lines = source.split(/\r?\n/);
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] as string;
    const modelMatch = /^model\s+(\w+)\s*\{/.exec(line);
    if (modelMatch) {
      const name = modelMatch[1] as string;
      const blockLines: string[] = [];
      index += 1;
      while (index < lines.length && !/^\}/.test(lines[index] as string)) {
        blockLines.push(lines[index] as string);
        index += 1;
      }
      const block = blockLines.join("\n");
      const fields: SchemaField[] = [];
      const uniqueBlocks: string[][] = [];
      const idBlocks: string[][] = [];
      const indexBlocks: string[][] = [];
      let tableName = name;

      // Join continuation lines of multi-line field definitions.
      const joined: string[] = [];
      let pending = "";
      for (const rawLine of blockLines) {
        const trimmed = rawLine.trim();
        if (trimmed.startsWith("///") || trimmed.startsWith("//")) {
          continue;
        }
        if (pending) {
          pending += ` ${trimmed}`;
        } else {
          pending = trimmed;
        }
        if (pending.includes("@db.") && pending.includes("(") && !pending.includes(")")) {
          continue;
        }
        joined.push(pending);
        pending = "";
      }
      if (pending) {
        joined.push(pending);
      }

      for (const entry of joined) {
        if (entry.startsWith("@@map(")) {
          const match = /@@map\("([^"]+)"\)/.exec(entry);
          if (match) {
            tableName = match[1] as string;
          }
          continue;
        }
        if (entry.startsWith("@@unique(")) {
          const match = /@@unique\(\[([^\]]+)\]\)/.exec(entry);
          if (match) {
            uniqueBlocks.push(parseList(match[1] as string));
          }
          continue;
        }
        if (entry.startsWith("@@index(")) {
          const match = /@@index\(\[([^\]]+)\]\)/.exec(entry);
          if (match) {
            indexBlocks.push(parseList(match[1] as string));
          }
          continue;
        }
        if (entry.startsWith("@@id(")) {
          const match = /@@id\(\[([^\]]+)\]\)/.exec(entry);
          if (match) {
            idBlocks.push(parseList(match[1] as string));
          }
          continue;
        }
        if (entry.startsWith("@@")) {
          continue;
        }
        const fieldMatch = /^(\w+)\s+(\w+)(\[\])?(\?)?\s*(.*)$/.exec(entry);
        if (!fieldMatch) {
          continue;
        }
        const fieldName = fieldMatch[1] as string;
        const typeName = fieldMatch[2] as string;
        const isList = Boolean(fieldMatch[3]);
        const isOptional = Boolean(fieldMatch[4]);
        const attributes = fieldMatch[5] ?? "";
        const relationArgs = parseArgsMap(attributes);
        const mapMatch = /@map\("([^"]+)"\)/.exec(attributes);
        const dbName = mapMatch?.[1] ?? fieldName;
        const dbMatch = /@db\.(\w+)(?:\(([^)]*)\))?/.exec(attributes);
        const dbArgs = dbMatch?.[2]
          ? dbMatch[2].split(",").map((item) => Number(item.trim()))
          : [];
        fields.push({
          name: fieldName,
          dbName,
          rawType: `${typeName}${isList ? "[]" : ""}${isOptional ? "?" : ""}`,
          type: typeName,
          isList,
          isOptional,
          attributes,
          isRelation: attributes.includes("@relation"),
          relationName: relationArgs.name,
          onDelete: relationArgs.onDelete,
          references: relationArgs.references ? parseList(relationArgs.references) : undefined,
          fields: relationArgs.fields ? parseList(relationArgs.fields) : undefined,
          isId: /@id\b/.test(attributes),
          isUnique: /@unique\b/.test(attributes),
          dbType: dbMatch?.[1],
          dbLength: dbArgs[0],
          dbPrecision: dbArgs[0],
          dbScale: dbArgs[1],
        });
      }
      models.push({ name, tableName, fields, block, uniqueBlocks, idBlocks, indexBlocks });
      continue;
    }

    const enumMatch = /^enum\s+(\w+)\s*\{/.exec(line);
    if (enumMatch) {
      const name = enumMatch[1] as string;
      const values: string[] = [];
      index += 1;
      while (index < lines.length && !/^\}/.test(lines[index] as string)) {
        const trimmed = (lines[index] as string).trim();
        if (trimmed && !trimmed.startsWith("//") && !trimmed.startsWith("///")) {
          values.push(trimmed.split(/[\s@]/)[0] as string);
        }
        index += 1;
      }
      enums.push({ name, values });
      continue;
    }
    index += 1;
  }

  const modelNames = new Set(models.map((model) => model.name));
  for (const model of models) {
    for (const field of model.fields) {
      if (modelNames.has(field.type)) {
        field.isRelation = true;
      }
    }
  }

  const parsed: ParsedSchema = {
    models,
    enums,
    byModel: new Map(models.map((model) => [model.name, model])),
    byTable: new Map(models.map((model) => [model.tableName, model])),
  };
  cachedSchema = parsed;
  return parsed;
};

/** Expected native column type for a scalar Prisma field. */
/** The database column name of a schema field (explicit `@map` or the field name). */
export const schemaColumnName = (field: SchemaField): string => field.dbName;

export const expectedColumnType = (field: SchemaField): string | null => {
  if (field.isRelation || field.isList) {
    return null;
  }
  if (field.dbType) {
    switch (field.dbType) {
      case "Uuid":
        return "uuid";
      case "Decimal":
        return `numeric(${field.dbPrecision ?? 65},${field.dbScale ?? 30})`;
      case "Char":
        return `character(${field.dbLength ?? 1})`;
      case "VarChar":
        return `character varying(${field.dbLength ?? 191})`;
      case "Text":
        return "text";
      case "ByteA":
        return "bytea";
      case "Date":
        return "date";
      case "DateTime":
        return "timestamp(3) without time zone";
      case "Timestamptz":
        return "timestamp(3) with time zone";
      case "Json":
        return "jsonb";
      case "SmallInt":
        return "smallint";
      default:
        return field.dbType.toLowerCase();
    }
  }
  switch (field.type) {
    case "String":
      return "text";
    case "Int":
      return "integer";
    case "BigInt":
      return "bigint";
    case "Float":
      return "double precision";
    case "Boolean":
      return "boolean";
    case "DateTime":
      return "timestamp(3) without time zone";
    case "Json":
      return "jsonb";
    case "Bytes":
      return "bytea";
    default:
      return "USER-DEFINED";
  }
};

export const MONEY_COLUMNS = [
  "amount",
  "requested_amount",
  "surcharge_amount",
  "total_charged_amount",
  "settled_amount",
  "gateway_fee_amount",
  "platform_commission_amount",
  "net_merchant_amount",
  "checkpoint_balance",
  "flat_fee",
  "min_fee",
  "max_fee",
  "min_amount",
  "max_amount",
  "daily_cap_amount",
  "commission_receivable_ceiling",
  "negative_balance_ceiling",
  "threshold_amount",
  "statement_amount",
  "statement_fee",
] as const;

export const ALL_GATEWAY_CODES = [
  "moamalat",
  "lypay",
  "numo_pay",
  "sadad",
  "libyana",
  "edfali",
  "mobicash",
  "tlync",
  "onepay",
  "yussor_pay",
  "sahara_pay",
  "masrefy_pay",
  "hawelli",
  "gpay_libya",
  "google_pay",
  "mpgs",
  "evopay",
  "dpay",
  "plutu",
  "mypay",
  "neompay",
] as const;

export const ALL_CURRENCIES = ["LYD", "USD", "EUR"] as const;

export const FEE_BEARERS = ["MERCHANT_ABSORBS", "PAYER_SURCHARGE", "SPLIT"] as const;

export const COMMISSION_CALC_TYPES = ["FLAT", "PERCENTAGE", "TIERED", "HYBRID"] as const;

export const ROUNDING_MODES = ["HALF_UP", "HALF_EVEN", "DOWN", "UP"] as const;

export const USER_ROLES = [
  "GATEWAY_ADMIN",
  "SECURITY_ADMIN",
  "FINANCE",
  "OPERATOR",
  "COMPLIANCE",
  "MLRO",
  "SUPPORT",
  "MERCHANT_ADMIN",
  "MERCHANT_STAFF",
  "MERCHANT_CASHIER",
] as const;

export const ATTEMPT_STATUSES = [
  "CREATED",
  "INITIATING",
  "AWAITING_CUSTOMER",
  "AUTHORIZING",
  "VERIFYING",
  "UNKNOWN",
  "SUCCEEDED",
  "FAILED",
  "EXPIRED",
  "CANCELLED",
  "BLOCKED",
  "PARTIALLY_REFUNDED",
  "REFUNDED",
  "DISPUTED",
] as const;

export const CHANNELS = ["WEB", "API", "POS"] as const;

/** Error code carried by ApiError / engine errors. */
export const errorCode = (error: unknown): string | undefined => {
  if (error && typeof error === "object" && "code" in error) {
    return String((error as { code?: unknown }).code);
  }
  return undefined;
};

export const errorStatus = (error: unknown): number | undefined => {
  if (error && typeof error === "object") {
    const candidate = error as { status?: unknown; statusCode?: unknown };
    if (typeof candidate.status === "number") {
      return candidate.status;
    }
    if (typeof candidate.statusCode === "number") {
      return candidate.statusCode;
    }
  }
  return undefined;
};

export const expectErrorCode = async (
  fn: () => unknown | Promise<unknown>,
  code: string,
): Promise<unknown> => {
  try {
    await fn();
  } catch (error) {
    const actual = errorCode(error);
    if (actual !== code) {
      throw new Error(`Expected error code ${code} but received ${actual ?? "<none>"}: ${String(error)}`);
    }
    return error;
  }
  throw new Error(`Expected failure with code ${code} but the operation succeeded`);
};
