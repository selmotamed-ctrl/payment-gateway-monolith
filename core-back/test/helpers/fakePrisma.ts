import type { PrismaClient } from "../../generated/prisma/client";

/**
 * A minimal in-memory stand-in for the Prisma client.
 *
 * It implements exactly the operations the blueprint seed uses, so that the
 * seed can be executed twice against it and the resulting rows can be
 * compared. No database connection is involved.
 */

export type FakeRow = Record<string, unknown>;

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

export const fakeTableNames = (): string[] => [...TABLES.keys()].sort();

let sequence = 0;
const nextId = (prefix: string): string => {
  sequence += 1;
  return `${prefix}-${sequence}`;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const matches = (model: string, row: FakeRow, where: Record<string, unknown>): boolean => {
  for (const [key, value] of Object.entries(where)) {
    if (key === "OR" && Array.isArray(value)) {
      const alternatives = value as Array<Record<string, unknown>>;
      if (!alternatives.some((alternative) => matches(model, row, alternative))) {
        return false;
      }
      continue;
    }
    if (isPlainObject(value)) {
      if (key === "gateway" && model === "railRoute") {
        const gateway = table("gateway").find((entry) => entry.code === value.code);
        if (!gateway || row.gatewayId !== gateway.id) {
          return false;
        }
        continue;
      }
      for (const [field, expected] of Object.entries(value)) {
        if (row[field] !== expected) {
          return false;
        }
      }
      continue;
    }
    if (row[key] !== value) {
      return false;
    }
  }
  return true;
};

const findRow = (model: string, where: Record<string, unknown>): FakeRow | undefined =>
  table(model).find((row) => matches(model, row, where));

const stripNested = <T extends FakeRow>(row: T): T => {
  const copy: FakeRow = { ...row };
  delete copy.steps;
  delete copy.parameters;
  delete copy.outputs;
  return copy as T;
};

const model = (name: string) => {
  const rows = () => table(name);

  return {
    async findUnique(args: { where: Record<string, unknown> }): Promise<FakeRow | null> {
      return findRow(name, args.where) ?? null;
    },
    async findUniqueOrThrow(args: { where: Record<string, unknown> }): Promise<FakeRow> {
      const row = findRow(name, args.where);
      if (!row) {
        throw new Error(`Fake '${name}' row not found`);
      }
      return row;
    },
    async findFirst(args: { where: Record<string, unknown> }): Promise<FakeRow | null> {
      return findRow(name, args.where) ?? null;
    },
    async findMany(args: { where?: Record<string, unknown> } = {}): Promise<FakeRow[]> {
      if (!args.where) {
        return [...rows()];
      }
      return rows().filter((row) => matches(name, row, args.where ?? {}));
    },
    async upsert(args: {
      where: Record<string, unknown>;
      update: FakeRow;
      create: FakeRow;
    }): Promise<FakeRow> {
      const existing = findRow(name, args.where);
      if (existing) {
        Object.assign(existing, args.update);
        return existing;
      }
      const created: FakeRow = { id: nextId(name), ...args.create };
      rows().push(created);
      return created;
    },
    async create(args: { data: FakeRow }): Promise<FakeRow> {
      const data = args.data;
      const created: FakeRow = { id: nextId(name), ...data };
      rows().push(created);
      return created;
    },
    async update(args: { where: Record<string, unknown>; data: FakeRow }): Promise<FakeRow> {
      const row = findRow(name, args.where);
      if (!row) {
        throw new Error(`Fake '${name}' row not found`);
      }
      Object.assign(row, args.data);
      return row;
    },
    async deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }> {
      const remaining = rows().filter((row) => !matches(name, row, args.where));
      const count = rows().length - remaining.length;
      TABLES.set(name, remaining);
      return { count };
    },
  };
};

/**
 * The flow step, the step parameter and the step output are created together
 * with their flow, so the fake expands the nested writes.
 */
const flowModel = () => {
  const rows = () => table("flow");
  return {
    async findMany(args: { where?: Record<string, unknown> } = {}): Promise<FakeRow[]> {
      if (!args.where) {
        return [...rows()];
      }
      return rows().filter((row) => matches("flow", row, args.where ?? {}));
    },
    async create(args: { data: FakeRow }): Promise<FakeRow> {
      const data = args.data;
      const steps = isPlainObject(data.steps) && Array.isArray(data.steps.create)
        ? data.steps.create as FakeRow[]
        : [];
      const created: FakeRow = { id: nextId("flow"), ...stripNested(data) };
      rows().push(created);
      for (const [index, step] of steps.entries()) {
        const stepRow: FakeRow = {
          id: nextId("flowStep"),
          flowId: created.id,
          orderIndex: index,
          ...stripNested(step),
        };
        table("flowStep").push(stepRow);
        const parameters = isPlainObject(step.parameters) && Array.isArray(step.parameters.create)
          ? step.parameters.create as FakeRow[]
          : [];
        for (const parameter of parameters) {
          table("stepParameter").push({ id: nextId("stepParameter"), stepId: stepRow.id, ...parameter });
        }
        const outputs = isPlainObject(step.outputs) && Array.isArray(step.outputs.create)
          ? step.outputs.create as FakeRow[]
          : [];
        for (const output of outputs) {
          table("stepOutput").push({ id: nextId("stepOutput"), stepId: stepRow.id, ...output });
        }
      }
      return created;
    },
    async deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }> {
      const doomedFlows = rows().filter((row) => matches("flow", row, args.where)).map((row) => row.id);
      const remaining = rows().filter((row) => !doomedFlows.includes(row.id as string));
      const count = rows().length - remaining.length;
      TABLES.set("flow", remaining);
      const doomedSteps = table("flowStep")
        .filter((row) => doomedFlows.includes(row.flowId as string))
        .map((row) => row.id);
      TABLES.set(
        "flowStep",
        table("flowStep").filter((row) => !doomedSteps.includes(row.id as string)),
      );
      for (const tableName of ["stepParameter", "stepOutput"]) {
        TABLES.set(
          tableName,
          table(tableName).filter((row) => !doomedSteps.includes(row.stepId as string)),
        );
      }
      return { count };
    },
  };
};

export const createFakePrisma = (): PrismaClient => {
  const client = {
    user: model("user"),
    gateway: model("gateway"),
    gatewayVersion: model("gatewayVersion"),
    gatewayEnvironment: model("gatewayEnvironment"),
    gatewayAuth: model("gatewayAuth"),
    gatewaySetting: model("gatewaySetting"),
    cryptoProfile: model("cryptoProfile"),
    statusRule: model("statusRule"),
    rail: model("rail"),
    railField: model("railField"),
    railRoute: model("railRoute"),
    pollPolicy: model("pollPolicy"),
    widgetDefinition: model("widgetDefinition"),
    redirectDefinition: model("redirectDefinition"),
    confirmationChannel: model("confirmationChannel"),
    flow: flowModel(),
    flowStep: model("flowStep"),
    stepParameter: model("stepParameter"),
    stepOutput: model("stepOutput"),
  };
  return client as unknown as PrismaClient;
};
