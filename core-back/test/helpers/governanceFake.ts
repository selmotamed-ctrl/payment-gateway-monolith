import type { PrismaClient } from "../../generated/prisma/client";

/**
 * An in-memory stand-in for the Prisma client.
 *
 * It follows the pattern of `test/helpers/fakePrisma.ts` and extends it with
 * the two features the governance execution needs:
 *
 *  - a real `$transaction` that ROLLS BACK when the callback throws, so the
 *    atomicity of a governance execution can be asserted, and
 *  - `in` / `not` filters, which the ledger lookups rely on.
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

const clean = (data: FakeRow): FakeRow => {
  const output: FakeRow = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) {
      output[key] = value;
    }
  }
  return output;
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
    if (isPlainObject(expected)) {
      if (Array.isArray(expected.in)) {
        if (!(expected.in as unknown[]).includes(row[key])) {
          return false;
        }
        continue;
      }
      if ("not" in expected) {
        if (matchesValue(row, key, expected.not)) {
          return false;
        }
        continue;
      }
      if (!matchesWhere(row, expected)) {
        return false;
      }
      continue;
    }
    if (row[key] !== expected) {
      return false;
    }
  }
  return true;
};

const matchesValue = (row: FakeRow, key: string, expected: unknown): boolean => {
  if (isPlainObject(expected)) {
    if (Array.isArray(expected.in)) {
      return (expected.in as unknown[]).includes(row[key]);
    }
    if ("not" in expected) {
      return !matchesValue(row, key, expected.not);
    }
  }
  return row[key] === expected;
};

const findRow = (model: string, where: Record<string, unknown>): FakeRow | undefined =>
  table(model).find((row) => matchesWhere(row, where));

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
}

/**
 * Builds the in-memory client used by the governance execution tests.
 */
export const createFakePrisma = (): FakePrisma => {
  const client: Any = {
    user: model("user"),
    merchant: model("merchant"),
    wallet: model("wallet"),
    glAccount: model("glAccount"),
    journalEntry: model("journalEntry"),
    journalLine: model("journalLine"),
    amlCase: model("amlCase"),
    approvalRequest: model("approvalRequest"),
    dispute: model("dispute"),
    adjustment: model("adjustment"),
    cashoutRequest: model("cashoutRequest"),
    operatorCase: model("operatorCase"),
    auditLog: model("auditLog"),
    paymentAttempt: model("paymentAttempt"),
    gatewayVersion: model("gatewayVersion"),
    gateway: model("gateway"),
  };

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
