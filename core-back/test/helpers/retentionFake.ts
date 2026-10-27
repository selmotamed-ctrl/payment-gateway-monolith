import type { PrismaLike } from "../../engine/db/ports";

/**
 * An in-memory stand-in for the Prisma client.
 *
 * It follows the pattern of `test/helpers/fakePrisma.ts` and
 * `test/helpers/governanceFake.ts`, but it speaks the raw SQL dialect of the
 * retention worker: the statements are parsed into a small grammar and
 * evaluated against the in-memory tables, so the test exercises the real
 * statements of the worker instead of a hand written imitation of them.
 *
 * The grammar covers what the worker needs:
 *
 *   SELECT <column> | COUNT(*) FROM <table> [WHERE <condition>]
 *          [ORDER BY <column> [ASC|DESC]] [LIMIT ?]
 *   DELETE FROM <table> [WHERE <condition>] [LIMIT ?]
 *
 * with the conditions `<column> <op> <operand>`, where the operator is one
 * of `<`, `<=`, `>`, `>=`, `=`, `!=`, `IS NULL`, `IS NOT NULL`, `IN` and
 * `NOT IN`, and the operand is a bound value, a list of bound values or a
 * subquery.
 */

export type FakeRow = Record<string, unknown>;

type Token = string;

type Operand =
  | { kind: "param"; index: number }
  | { kind: "list"; start: number; length: number }
  | { kind: "subquery"; statement: SelectStatement };

type Condition =
  | { kind: "compare"; column: string; operator: string; operand: Operand }
  | { kind: "and"; left: Condition; right: Condition }
  | { kind: "or"; left: Condition; right: Condition };

interface SelectStatement {
  kind: "select";
  count: boolean;
  columns: string[];
  table: string;
  where?: Condition;
  orderBy?: { column: string; descending: boolean };
  limit?: number;
}

interface DeleteStatement {
  kind: "delete";
  table: string;
  where?: Condition;
  limit?: number;
}

type Statement = SelectStatement | DeleteStatement;

const tokenize = (sql: string): Token[] => {
  const tokens: Token[] = [];
  let current = "";
  const flush = (): void => {
    if (current.length > 0) {
      tokens.push(current);
      current = "";
    }
  };
  for (const character of sql) {
    if (character === "`") {
      continue;
    }
    if (/\s/.test(character)) {
      flush();
      continue;
    }
    if (character === "(" || character === ")" || character === ",") {
      flush();
      tokens.push(character);
      continue;
    }
    current += character;
  }
  flush();
  return tokens;
};

class StatementParser {
  private index = 0;
  private paramIndex = 0;

  constructor(private readonly tokens: Token[]) {}

  private peek(offset = 0): string | undefined {
    return this.tokens[this.index + offset];
  }

  private next(): string {
    const token = this.tokens[this.index];
    this.index += 1;
    if (token === undefined) {
      throw new Error("The statement ended too early");
    }
    return token;
  }

  private expect(token: string): void {
    const actual = this.next();
    if (actual !== token) {
      throw new Error(`Expected '${token}' but found '${actual}'`);
    }
  }

  parse(): Statement {
    const keyword = this.peek();
    if (keyword === "SELECT") {
      return this.parseSelect();
    }
    if (keyword === "DELETE") {
      return this.parseDelete();
    }
    throw new Error(`Unsupported statement: ${keyword ?? ""}`);
  }

  private parseSelect(): SelectStatement {
    this.expect("SELECT");
    let count = false;
    const columns: string[] = [];
    if (this.peek() === "COUNT") {
      this.next();
      this.expect("(");
      this.expect("*");
      this.expect(")");
      if (this.peek() === "AS") {
        this.next();
        this.next();
      }
      count = true;
    } else {
      columns.push(this.next());
      while (this.peek() === ",") {
        this.next();
        columns.push(this.next());
      }
    }
    this.expect("FROM");
    const table = this.next();
    let where: Condition | undefined;
    if (this.peek() === "WHERE") {
      this.next();
      where = this.parseCondition();
    }
    let orderBy: { column: string; descending: boolean } | undefined;
    if (this.peek() === "ORDER") {
      this.next();
      this.expect("BY");
      const column = this.next();
      let descending = false;
      if (this.peek() === "DESC") {
        this.next();
        descending = true;
      } else if (this.peek() === "ASC") {
        this.next();
      }
      orderBy = { column, descending };
    }
    const limit = this.parseLimit();
    return { kind: "select", count, columns, table, where, orderBy, limit };
  }

  private parseDelete(): DeleteStatement {
    this.expect("DELETE");
    this.expect("FROM");
    const table = this.next();
    let where: Condition | undefined;
    if (this.peek() === "WHERE") {
      this.next();
      where = this.parseCondition();
    }
    const limit = this.parseLimit();
    return { kind: "delete", table, where, limit };
  }

  private parseLimit(): number | undefined {
    if (this.peek() !== "LIMIT") {
      return undefined;
    }
    this.next();
    const token = this.next();
    if (token === "?") {
      this.paramIndex += 1;
      return this.paramIndex - 1;
    }
    return Number(token);
  }

  private parseCondition(): Condition {
    let left = this.parseTerm();
    while (this.peek() === "OR") {
      this.next();
      const right = this.parseTerm();
      left = { kind: "or", left, right };
    }
    return left;
  }

  private parseTerm(): Condition {
    let left = this.parseFactor();
    while (this.peek() === "AND") {
      this.next();
      const right = this.parseFactor();
      left = { kind: "and", left, right };
    }
    return left;
  }

  private parseFactor(): Condition {
    if (this.peek() === "(") {
      this.next();
      const condition = this.parseCondition();
      this.expect(")");
      return condition;
    }
    const column = this.next();
    let operator = this.next();
    if (operator === "NOT" && this.peek() === "IN") {
      this.next();
      operator = "NOT IN";
    }
    if (operator === "IS") {
      const second = this.next();
      if (second === "NOT") {
        this.expect("NULL");
        operator = "IS NOT NULL";
      } else {
        operator = "IS NULL";
      }
      return { kind: "compare", column, operator, operand: { kind: "list", start: -1, length: 0 } };
    }
    return { kind: "compare", column, operator, operand: this.parseOperand() };
  }

  private parseOperand(): Operand {
    const token = this.next();
    if (token === "?") {
      this.paramIndex += 1;
      return { kind: "param", index: this.paramIndex - 1 };
    }
    if (token === "(") {
      if (this.peek() === "SELECT") {
        const statement = this.parseSelect();
        this.expect(")");
        return { kind: "subquery", statement };
      }
      const start = this.paramIndex;
      let length = 0;
      while (this.peek() !== ")") {
        this.expect("?");
        this.paramIndex += 1;
        length += 1;
        if (this.peek() === ",") {
          this.next();
        }
      }
      this.expect(")");
      return { kind: "list", start, length };
    }
    throw new Error(`Unsupported operand: ${token}`);
  }
}

interface EvaluationContext {
  params: unknown[];
  tables: Map<string, FakeRow[]>;
}

const comparable = (value: unknown): unknown =>
  value instanceof Date ? value.getTime() : value;

const equals = (left: unknown, right: unknown): boolean =>
  comparable(left) === comparable(right);

const ordered = (left: unknown, right: unknown): number => {
  const a = comparable(left);
  const b = comparable(right);
  if (typeof a === "number" && typeof b === "number") {
    return a === b ? 0 : a < b ? -1 : 1;
  }
  if (typeof a === "string" && typeof b === "string") {
    return a === b ? 0 : a < b ? -1 : 1;
  }
  return 0;
};

const runSelect = (statement: SelectStatement, context: EvaluationContext): FakeRow[] => {
  const table = context.tables.get(statement.table) ?? [];
  const matching = table.filter(
    (row) => !statement.where || evaluateCondition(statement.where, row, context),
  );
  const sorted = statement.orderBy
    ? [...matching].sort((left, right) => {
        const result = ordered(
          left[statement.orderBy?.column ?? ""],
          right[statement.orderBy?.column ?? ""],
        );
        return statement.orderBy?.descending ? -result : result;
      })
    : matching;
  const limited =
    statement.limit === undefined
      ? sorted
      : sorted.slice(0, Number(context.params[statement.limit] ?? sorted.length));
  if (statement.count) {
    return [{ total: limited.length }];
  }
  return limited.map((row) => {
    const projected: FakeRow = {};
    for (const column of statement.columns) {
      projected[column] = row[column];
    }
    return projected;
  });
};

const operandValues = (
  operand: Operand,
  context: EvaluationContext,
): unknown[] => {
  if (operand.kind === "param") {
    return [context.params[operand.index]];
  }
  if (operand.kind === "list") {
    return context.params.slice(operand.start, operand.start + operand.length);
  }
  const rows = runSelect(operand.statement, context);
  const column = operand.statement.columns[0] ?? "id";
  return rows.map((row) => row[column]);
};

const evaluateCondition = (
  condition: Condition,
  row: FakeRow,
  context: EvaluationContext,
): boolean => {
  if (condition.kind === "and") {
    return (
      evaluateCondition(condition.left, row, context) &&
      evaluateCondition(condition.right, row, context)
    );
  }
  if (condition.kind === "or") {
    return (
      evaluateCondition(condition.left, row, context) ||
      evaluateCondition(condition.right, row, context)
    );
  }
  const value = row[condition.column];
  const values = operandValues(condition.operand, context);
  switch (condition.operator) {
    case "IS NULL":
      return value === null || value === undefined;
    case "IS NOT NULL":
      return value !== null && value !== undefined;
    case "=":
      return equals(value, values[0]);
    case "!=":
      return !equals(value, values[0]);
    case "<":
      return ordered(value, values[0]) < 0;
    case "<=":
      return ordered(value, values[0]) <= 0;
    case ">":
      return ordered(value, values[0]) > 0;
    case ">=":
      return ordered(value, values[0]) >= 0;
    case "IN":
      return values.some((candidate) => equals(value, candidate));
    case "NOT IN":
      return !values.some((candidate) => equals(value, candidate));
    default:
      throw new Error(`Unsupported operator: ${condition.operator}`);
  }
};

const runDelete = (statement: DeleteStatement, context: EvaluationContext): number => {
  const table = context.tables.get(statement.table);
  if (!table) {
    return 0;
  }
  const doomed = table.filter(
    (row) => !statement.where || evaluateCondition(statement.where, row, context),
  );
  const limited =
    statement.limit === undefined
      ? doomed
      : doomed.slice(0, Number(context.params[statement.limit] ?? doomed.length));
  const removed = new Set(limited);
  context.tables.set(
    statement.table,
    table.filter((row) => !removed.has(row)),
  );
  return limited.length;
};

export interface RetentionFake {
  /** The Prisma client the worker talks to. */
  db: PrismaLike;
  /** The rows of a table. */
  rows(table: string): FakeRow[];
  /** Puts rows into a table. */
  seed(table: string, rows: FakeRow[]): void;
  /** Empties every table. */
  reset(): void;
}

/**
 * Builds the in-memory client of the retention tests.
 */
export const createRetentionFake = (): RetentionFake => {
  const tables = new Map<string, FakeRow[]>();
  const table = (name: string): FakeRow[] => {
    const existing = tables.get(name);
    if (existing) {
      return existing;
    }
    const created: FakeRow[] = [];
    tables.set(name, created);
    return created;
  };

  const context = (params: unknown[]): EvaluationContext => ({ params, tables });

  const platformSetting = {
    async findFirst(args: { where?: { key?: string }; orderBy?: { version?: string } }) {
      const key = args?.where?.key;
      const rows = table("platformSetting").filter(
        (row) => key === undefined || row.key === key,
      );
      const ordered = [...rows].sort(
        (left, right) => Number(right.version ?? 0) - Number(left.version ?? 0),
      );
      return ordered[0] ?? null;
    },
    async findMany() {
      return [...table("platformSetting")];
    },
  };

  const db = {
    platformSetting,
    $queryRawUnsafe: async (sql: string, ...params: unknown[]) => {
      const statement = new StatementParser(tokenize(sql)).parse();
      if (statement.kind !== "select") {
        throw new Error("A query has to be a SELECT");
      }
      return runSelect(statement, context(params));
    },
    $executeRawUnsafe: async (sql: string, ...params: unknown[]) => {
      const statement = new StatementParser(tokenize(sql)).parse();
      if (statement.kind !== "delete") {
        throw new Error("An execution has to be a DELETE");
      }
      return runDelete(statement, context(params));
    },
    $queryRaw: async () => [],
    $executeRaw: async () => 0,
    $transaction: async (callback: (tx: PrismaLike) => Promise<unknown>) => {
      const snapshot = new Map(
        [...tables.entries()].map(([name, rows]) => [name, [...rows]]),
      );
      try {
        return await callback(db as unknown as PrismaLike);
      } catch (error) {
        for (const name of tables.keys()) {
          tables.delete(name);
        }
        for (const [name, rows] of snapshot.entries()) {
          tables.set(name, rows);
        }
        throw error;
      }
    },
  } as unknown as PrismaLike;

  return {
    db: db as PrismaLike,
    rows: (name: string) => table(name),
    seed: (name: string, rows: FakeRow[]) => {
      table(name).push(...rows);
    },
    reset: () => {
      tables.clear();
    },
  };
};
