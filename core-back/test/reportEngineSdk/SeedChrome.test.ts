import { describe, expect, test } from "bun:test";
import { seedDefaultChromeSpecs } from "../../engine/reportStudio/seedDefaultChromeSpecs";

interface Row {
  id: string;
  code: string;
  version: number;
  name: string;
  chromeType: string;
  status: string;
  isDefaultGlobal: boolean;
  supportedLocales: string[];
  specJson: unknown;
  specSha256: string;
  createdByUserId: string;
}

/** Minimal in-memory stand-in for the Prisma chrome table. */
function fakeClient(rows: Row[]) {
  let nextId = 1;
  const matches = (row: Row, where: Record<string, any>): boolean => {
    if (where.code_version && row.code !== where.code_version.code) return false;
    if (where.code_version && row.version !== where.code_version.version) return false;
    if (where.chromeType && row.chromeType !== where.chromeType) return false;
    if (where.isDefaultGlobal !== undefined && row.isDefaultGlobal !== where.isDefaultGlobal) return false;
    if (where.status && row.status !== where.status) return false;
    return true;
  };
  const tx = {
    reportChromeSpecRecord: {
      findUnique: async ({ where }: any) => rows.find((row) => matches(row, where)) ?? null,
      findFirst: async ({ where }: any) => rows.find((row) => matches(row, where)) ?? null,
      upsert: async ({ where, create, update }: any) => {
        const existing = rows.find((row) => matches(row, where));
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        const row = { id: `chrome-${nextId++}`, ...create };
        rows.push(row);
        return row;
      },
    },
  };
  return {
    rows,
    $transaction: async (fn: (transaction: typeof tx) => Promise<void>) => fn(tx),
  };
}

describe("remediation B14: chrome seed idempotence", () => {
  test("a re-run does not un-archive the seeded chrome or steal the default", async () => {
    const rows: Row[] = [
      {
        id: "operator-default",
        code: "operator-header",
        version: 1,
        name: "Operator header",
        chromeType: "HEADER",
        status: "PUBLISHED",
        isDefaultGlobal: true,
        supportedLocales: ["en", "ar"],
        specJson: {},
        specSha256: "x",
        createdByUserId: "u1",
      },
      {
        id: "seeded-header",
        code: "cbl-institutional-header-v1",
        version: 1,
        name: "Seeded header",
        chromeType: "HEADER",
        status: "ARCHIVED",
        isDefaultGlobal: false,
        supportedLocales: ["en", "ar"],
        specJson: {},
        specSha256: "x",
        createdByUserId: "u1",
      },
    ];
    const client = fakeClient(rows);
    await seedDefaultChromeSpecs(client as never, "u2");
    const seeded = rows.find((row) => row.code === "cbl-institutional-header-v1")!;
    expect(seeded.status).toBe("ARCHIVED");
    expect(seeded.isDefaultGlobal).toBe(false);
    expect(rows.find((row) => row.code === "operator-header")?.isDefaultGlobal).toBe(true);
  });

  test("a fresh database gets one published default per type", async () => {
    const rows: Row[] = [];
    const client = fakeClient(rows);
    await seedDefaultChromeSpecs(client as never, "u1");
    const headers = rows.filter((row) => row.chromeType === "HEADER");
    const footers = rows.filter((row) => row.chromeType === "FOOTER");
    expect(headers.filter((row) => row.isDefaultGlobal)).toHaveLength(1);
    expect(footers.filter((row) => row.isDefaultGlobal)).toHaveLength(1);
    expect(rows.every((row) => row.status === "PUBLISHED")).toBe(true);
  });
});
