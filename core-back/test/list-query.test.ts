import { describe, expect, test } from "bun:test";
import { buildListQuery, csv, parseListQuery } from "../lib/listQuery";

describe("shared list query", () => {
  test("parses pagination, search and sort", () => {
    const parsed = parseListQuery({ page: "2", pageSize: "500", search: " acme ", sortKey: "name", sortDirection: "desc" });
    expect(parsed.page).toBe(2);
    expect(parsed.pageSize).toBe(200);
    expect(parsed.search).toBe("acme");
    expect(parsed.sortKey).toBe("name");
    expect(parsed.sortDirection).toBe("desc");
  });

  test("builds a contains search and an enum `in` filter", () => {
    const built = buildListQuery(
      { search: "sadad", status: "ACTIVE,PAUSED" },
      { search: ["code", "name"], in: { status: "status" }, defaultSort: { code: "asc" } },
    );
    expect(built.where).toEqual({
      AND: [{ OR: [{ code: { contains: "sadad" } }, { name: { contains: "sadad" } }] }, { status: { in: ["ACTIVE", "PAUSED"] } }],
    });
    expect(built.orderBy).toEqual([{ code: "asc" }, { id: "desc" }]);
  });

  test("dates are inclusive and support a future window", () => {
    const built = buildListQuery(
      { from: "2026-01-01", to: "2026-12-31" },
      { dates: { createdAt: { path: "createdAt" } }, defaultSort: { createdAt: "desc" } },
    );
    const range = (built.where as any).AND[0].createdAt;
    expect(range.gte.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(range.lte.toISOString()).toBe("2026-12-31T23:59:59.999Z");
  });

  test("amount ranges become decimals and unknown sorts are ignored", () => {
    const built = buildListQuery(
      { amountMin: "10.5", amountMax: "20", sortKey: "hacked", sortDirection: "desc" },
      { ranges: { amount: { path: "amount", kind: "decimal" } }, sortable: { createdAt: "createdAt" }, defaultSort: { createdAt: "desc" } },
    );
    const range = (built.where as any).AND[0].amount;
    expect(String(range.gte)).toBe("10.5");
    expect(String(range.lte)).toBe("20");
    expect(built.orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
  });

  test("pagination default and CSV helper", () => {
    const built = buildListQuery({}, { defaultSort: { createdAt: "desc" }, defaultPageSize: 25 });
    expect(built).toMatchObject({ page: 1, pageSize: 25, skip: 0, take: 25 });
    expect(csv(" A , ,B ")).toEqual(["A", "B"]);
  });
});
