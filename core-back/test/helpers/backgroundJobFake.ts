import type { PrismaClient } from "../../generated/prisma/client";

/**
 * An in-memory stand-in for the Prisma client of the background job queue.
 *
 * It follows the pattern of `test/helpers/governanceFake.ts` and adds the two
 * features the durable queue needs:
 *
 *  - the raw statements of the worker (`SELECT ... FOR UPDATE SKIP LOCKED`
 *    and the conditional `UPDATE` statements), and
 *  - `null` matching, so a conditional update (`ingested_at IS NULL`) can be
 *    expressed with the Prisma filter syntax.
 *
 * No database connection is involved.
 */

export type FakeRow = Record<string, unknown>;

type Any = Record<string, any>;

const TABLES = new Map<string, FakeRow[]>();

const table = (name: string): FakeRow[] => {
  const existing = TABLES.get(name);
  if (existing) {
    return existing;
  }
  const created: FakeRow[] = [];
  TABLES.set(name, created);
  return created;
};

export const resetFakeDatabase = (): void => {
  TABLES.clear();
};

export const fakeTable = (name: string): FakeRow[] => table(name);

let sequence = 0;
const nextId = (prefix: string): string => {
  sequence += 1;
  return `${prefix}-${sequence}`;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const snakeToCamel = (key: string): string =>
  key.replace(/_([a-zA-Z0-9])/g, (_match, character: string) => character.toUpperCase());

const cellValue = (row: FakeRow, key: string): unknown => {
  const value = row[key];
  return value === undefined ? null : value;
};

const matchesValue = (row: FakeRow, key: string, expected: unknown): boolean => {
  if (isPlainObject(expected)) {
    if (Array.isArray(expected.in)) {
      return (expected.in as unknown[]).includes(cellValue(row, key));
    }
    if ("not" in expected) {
      return !matchesValue(row, key, expected.not);
    }
  }
  return cellValue(row, key) === expected;
};

const matchesWhere = (row: FakeRow, where: Record<string, unknown>): boolean => {
  for (const [key, expected] of Object.entries(where ?? {})) {
    if (expected === undefined) {
      continue;
    }
    if (key === "OR" && Array.isArray(expected)) {
      if (!(expected as Any[]).some((alternative) => matchesWhere(row, alternative))) {
        return false;
      }
      continue;
    }
    if (key === "AND" && Array.isArray(expected)) {
      if (!(expected as Any[]).every((alternative) => matchesWhere(row, alternative))) {
        return false;
      }
      continue;
    }
    if (!matchesValue(row, key, expected)) {
      return false;
    }
  }
  return true;
};

const findRow = (model: string, where: Record<string, unknown>): FakeRow | undefined =>
  table(model).find((row) => matchesWhere(row, where));

const clean = (data: FakeRow): FakeRow => {
  const output: FakeRow = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) {
      output[key] = value;
    }
  }
  return output;
};

const model = (name: string) => {
  const rows = () => table(name);

  return {
    async findUnique(args: Any): Promise<FakeRow | null> {
      return findRow(name, args?.where ?? {}) ?? null;
    },
    async findUniqueOrThrow(args: Any): Promise<FakeRow> {
      const row = findRow(name, args?.where ?? {});
      if (!row) {
        throw new Error(`Fake '${name}' row not found`);
      }
      return row;
    },
    async findFirst(args: Any): Promise<FakeRow | null> {
      return findRow(name, args?.where ?? {}) ?? null;
    },
    async findMany(args: Any = {}): Promise<FakeRow[]> {
      if (!args.where) {
        return [...rows()];
      }
      return rows().filter((row) => matchesWhere(row, args.where ?? {}));
    },
    async create(args: Any): Promise<FakeRow> {
      const created: FakeRow = { id: nextId(name), ...clean(args.data ?? {}) };
      rows().push(created);
      return created;
    },
    async update(args: Any): Promise<FakeRow> {
      const row = findRow(name, args?.where ?? {});
      if (!row) {
        throw new Error(`Fake '${name}' row not found`);
      }
      Object.assign(row, clean(args.data ?? {}));
      return row;
    },
    async updateMany(args: Any): Promise<{ count: number }> {
      let count = 0;
      for (const row of rows()) {
        if (matchesWhere(row, args?.where ?? {})) {
          Object.assign(row, clean(args.data ?? {}));
          count += 1;
        }
      }
      return { count };
    },
    async deleteMany(args: Any): Promise<{ count: number }> {
      const remaining = rows().filter((row) => !matchesWhere(row, args?.where ?? {}));
      const count = rows().length - remaining.length;
      TABLES.set(name, remaining);
      return { count };
    },
    async count(args: Any = {}): Promise<number> {
      return rows().filter((row) => matchesWhere(row, args?.where ?? {})).length;
    },
    async upsert(args: Any): Promise<FakeRow> {
      const existing = findRow(name, args?.where ?? {});
      if (existing) {
        Object.assign(existing, clean(args.update ?? {}));
        return existing;
      }
      const created: FakeRow = { id: nextId(name), ...clean(args.create ?? {}) };
      rows().push(created);
      return created;
    },
  };
};

/**
 * The tiny SQL dialect the worker speaks.
 *
 * Only the statements of the durable queue are understood: a `SELECT` of a
 * table with `=` / `<=` conditions and a `LIMIT`, and an `UPDATE` with a
 * list of assignments and a list of conditions.
 */
interface Condition {
  column: string;
  operator: "=" | "<=" | "<" | ">=" | ">" | "IS NOT NULL" | "IS NULL";
  value?: unknown;
}

const parseCondition = (raw: string, params: unknown[]): Condition | null => {
  const text = raw.trim();
  const isNotNull = /^(\w+)\s+IS\s+NOT\s+NULL$/i.exec(text);
  if (isNotNull) {
    return { column: isNotNull[1] as string, operator: "IS NOT NULL" };
  }
  const isNull = /^(\w+)\s+IS\s+NULL$/i.exec(text);
  if (isNull) {
    return { column: isNull[1] as string, operator: "IS NULL" };
  }
  const comparison = /^(\w+)\s*(<=|>=|=|<|>)\s*(.+)$/.exec(text);
  if (!comparison) {
    return null;
  }
  const column = comparison[1] as string;
  const operator = comparison[2] as Condition["operator"];
  const literal = (comparison[3] as string).trim();
  if (literal === "?") {
    return { column, operator, value: params.shift() };
  }
  const quoted = /^'(.*)'$/.exec(literal);
  return { column, operator, value: quoted ? quoted[1] : literal };
};

const parseConditions = (raw: string, params: unknown[]): Condition[] => {
  if (!raw.trim()) {
    return [];
  }
  return raw
    .split(/\s+AND\s+/i)
    .map((part) => parseCondition(part, params))
    .filter((condition): condition is Condition => condition !== null);
};

const matchesCondition = (row: FakeRow, condition: Condition): boolean => {
  const value = cellValue(row, snakeToCamel(condition.column));
  switch (condition.operator) {
    case "=":
      return value === condition.value;
    case "<=":
      return (value as Date) <= (condition.value as Date);
    case "<":
      return (value as Date) < (condition.value as Date);
    case ">=":
      return (value as Date) >= (condition.value as Date);
    case ">":
      return (value as Date) > (condition.value as Date);
    case "IS NOT NULL":
      return value !== null;
    case "IS NULL":
      return value === null;
  }
};

/**
 * The model of a table of the schema.
 *
 * The raw statements of the worker speak the name of the table in the
 * database (`background_jobs`), while the fake stores the rows under the
 * name of the Prisma model (`backgroundJob`).
 */
const TABLE_MODELS: Record<string, string> = {
  background_jobs: "backgroundJob",
};

const modelNameOf = (tableName: string): string =>
  TABLE_MODELS[tableName]
  ?? tableName.replace(/_([a-z0-9])/g, (_match, character: string) => character.toUpperCase());

const toSnakeRow = (row: FakeRow): FakeRow => {
  const output: FakeRow = {};
  for (const [key, value] of Object.entries(row)) {
    output[key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase()] = value;
  }
  return output;
};

const runRawQuery = (sql: string, params: unknown[]): unknown[] => {
  const select = /^SELECT\s+\*\s+FROM\s+`?(\w+)`?/i.exec(sql.trim());
  if (!select) {
    return [];
  }
  const name = select[1] as string;
  const whereMatch = /\bWHERE\b([\s\S]*?)(?:\bORDER BY\b|\bLIMIT\b|$)/i.exec(sql);
  const limitMatch = /\bLIMIT\s+(\?|\d+)/i.exec(sql);
  const conditions = whereMatch ? parseConditions(whereMatch[1] as string, params) : [];
  const limit = limitMatch
    ? limitMatch[1] === "?"
      ? Number(params.shift() ?? 0)
      : Number(limitMatch[1])
    : undefined;
  const rows = table(modelNameOf(name))
    .filter((row) => conditions.every((condition) => matchesCondition(row, condition)))
    .map(toSnakeRow);
  const orderMatch = /\bORDER BY\s+(\w+)/i.exec(sql);
  const ordered = orderMatch
    ? [...rows].sort((left, right) => {
        const column = orderMatch[1] as string;
        return Number(left[column] ?? 0) - Number(right[column] ?? 0);
      })
    : rows;
  return typeof limit === "number" ? ordered.slice(0, limit) : ordered;
};

const runRawExecute = (sql: string, params: unknown[]): number => {
  const update = /^UPDATE\s+`?(\w+)`?\s+SET\s+([\s\S]*?)(?:\bWHERE\b|$)/i.exec(sql.trim());
  if (!update) {
    return 0;
  }
  const name = update[1] as string;
  const assignments: Array<{ column: string; value: unknown }> = [];
  for (const assignment of (update[2] as string).split(",")) {
    const parsed = /^\s*(\w+)\s*=\s*(.+)$/.exec(assignment);
    if (!parsed) {
      continue;
    }
    const column = parsed[1] as string;
    const literal = (parsed[2] as string).trim();
    if (literal === "?") {
      assignments.push({ column, value: params.shift() });
      continue;
    }
    if (literal.toUpperCase() === "NULL") {
      assignments.push({ column, value: null });
      continue;
    }
    const quoted = /^'(.*)'$/.exec(literal);
    assignments.push({ column, value: quoted ? quoted[1] : literal });
  }
  const whereMatch = /\bWHERE\b([\s\S]*)$/i.exec(sql);
  const conditions = whereMatch ? parseConditions(whereMatch[1] as string, params) : [];
  let affected = 0;
  for (const row of table(modelNameOf(name))) {
    if (!conditions.every((condition) => matchesCondition(row, condition))) {
      continue;
    }
    for (const assignment of assignments) {
      row[snakeToCamel(assignment.column)] = assignment.value;
    }
    affected += 1;
  }
  return affected;
};

const snapshot = (): Map<string, FakeRow[]> =>
  new Map([...TABLES.entries()].map(([key, value]) => [key, value.map((row) => ({ ...row }))]));

const restore = (state: Map<string, FakeRow[]>): void => {
  for (const key of TABLES.keys()) {
    TABLES.delete(key);
  }
  for (const [key, value] of state.entries()) {
    TABLES.set(key, value.map((row) => ({ ...row })));
  }
};

export interface FakePrisma extends Any {
  $transaction: <R>(callback: (tx: FakePrisma) => Promise<R>) => Promise<R>;
  $queryRawUnsafe: (sql: string, ...params: unknown[]) => Promise<unknown[]>;
  $executeRawUnsafe: (sql: string, ...params: unknown[]) => Promise<number>;
}

/**
 * Builds the in-memory client used by the background job tests.
 */
export const createFakePrisma = (): FakePrisma => {
  const client: Any = {
    backgroundJob: model("backgroundJob"),
    reconciliationRun: model("reconciliationRun"),
    reconciliationItem: model("reconciliationItem"),
    statementSource: model("statementSource"),
    paymentAttempt: model("paymentAttempt"),
    journalEntry: model("journalEntry"),
    journalLine: model("journalLine"),
    glAccount: model("glAccount"),
    user: model("user"),
    merchant: model("merchant"),
    wallet: model("wallet"),
    dispute: model("dispute"),
    adjustment: model("adjustment"),
    approvalRequest: model("approvalRequest"),
    auditLog: model("auditLog"),
    operatorCase: model("operatorCase"),
  };

  client.$queryRawUnsafe = async (sql: string, ...params: unknown[]): Promise<unknown[]> =>
    runRawQuery(sql, [...params]);
  client.$executeRawUnsafe = async (sql: string, ...params: unknown[]): Promise<number> =>
    runRawExecute(sql, [...params]);
  client.$queryRaw = async (): Promise<unknown[]> => [];
  client.$executeRaw = async (): Promise<number> => 0;

  client.$transaction = async <R>(callback: (tx: FakePrisma) => Promise<R>): Promise<R> => {
    const state = snapshot();
    try {
      return await callback(client as FakePrisma);
    } catch (error) {
      restore(state);
      throw error;
    }
  };

  return client as FakePrisma;
};

export const asPrismaClient = (client: FakePrisma): PrismaClient => client as unknown as PrismaClient;
