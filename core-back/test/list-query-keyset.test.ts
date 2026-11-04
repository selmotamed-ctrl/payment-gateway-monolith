import { describe, expect, test } from "bun:test";
import { Prisma } from "../generated/prisma/client";
import { buildListQuery, countUnlessSkipped, encodeListCursor, keysetWhere, listResponse } from "../lib/listQuery";

describe("keyset (cursor) pagination", () => {
  const spec = {
    sortable: { createdAt: "createdAt", amount: "totalChargedAmount", merchant: "merchant.legalName" },
    defaultSort: { createdAt: "desc" as const },
    keysetFields: ["totalChargedAmount"],
  };

  test("the default sort is keyset-capable and the first page is unchanged", () => {
    const built = buildListQuery({ pageSize: "2" }, spec);
    expect(built.keyset).toEqual({ fields: [{ path: "createdAt", direction: "desc" }, { path: "id", direction: "desc" }] });
    expect(built.cursorApplied).toBe(false);
    expect(built.skip).toBe(0);
    expect(built.includeTotal).toBe(true);
  });

  test("a cursor replaces OFFSET with a strict-after predicate", () => {
    const first = buildListQuery({ pageSize: "2" }, spec);
    const lastRow = { id: "019a0000-0000-7000-8000-000000000002", createdAt: new Date("2026-11-04T10:00:00.000Z") };
    const page = listResponse("rows", [{ id: "x" }, lastRow], 10, first);
    expect(typeof page.nextCursor).toBe("string");

    const next = buildListQuery({ pageSize: "2", page: "7", cursor: page.nextCursor as string }, spec);
    expect(next.cursorApplied).toBe(true);
    expect(next.skip).toBe(0);
    expect(next.where).toEqual({
      AND: [
        {
          OR: [
            { createdAt: { lt: new Date("2026-11-04T10:00:00.000Z") } },
            { AND: [{ createdAt: new Date("2026-11-04T10:00:00.000Z") }, { id: { lt: lastRow.id } }] },
          ],
        },
      ],
    });
  });

  test("mixed directions and decimal sort values keep exact decimals", () => {
    const built = buildListQuery({ sortKey: "amount", sortDirection: "asc" }, spec);
    expect(built.keyset?.fields).toEqual([
      { path: "totalChargedAmount", direction: "asc" },
      { path: "id", direction: "desc" },
    ]);
    const cursor = encodeListCursor(built.keyset!, { totalChargedAmount: new Prisma.Decimal("12345678901234.1234"), id: "b" });
    const next = buildListQuery({ sortKey: "amount", sortDirection: "asc", cursor }, spec);
    const branches = ((next.where as any).AND[0] as any).OR;
    expect(String(branches[0].totalChargedAmount.gt)).toBe("12345678901234.1234");
    expect(branches[1].AND[1]).toEqual({ id: { lt: "b" } });
  });

  test("relation and non-keyset sorts fall back to offset; bad cursors are ignored", () => {
    const relation = buildListQuery({ sortKey: "merchant", page: "3", cursor: "abc" }, spec);
    expect(relation.keyset).toBeUndefined();
    expect(relation.cursorApplied).toBe(false);
    expect(relation.skip).toBe(100);

    const garbage = buildListQuery({ cursor: "not-base64-json", page: "2", pageSize: "10" }, spec);
    expect(garbage.cursorApplied).toBe(false);
    expect(garbage.skip).toBe(10);

    const wrongShape = buildListQuery(
      { cursor: Buffer.from(JSON.stringify([{ evil: "x" }, "id"])).toString("base64url") },
      spec,
    );
    expect(wrongShape.cursorApplied).toBe(false);
  });

  test("nextCursor is only emitted for a full page", () => {
    const built = buildListQuery({ pageSize: "5" }, spec);
    const partial = listResponse("rows", [{ id: "a", createdAt: new Date() }], 1, built);
    expect(partial.nextCursor).toBeUndefined();
  });

  test("includeTotal=false skips the COUNT", async () => {
    let counted = 0;
    const skipped = buildListQuery({ includeTotal: "false" }, spec);
    expect(await countUnlessSkipped(skipped, async () => ++counted)).toBeNull();
    const kept = buildListQuery({}, spec);
    expect(await countUnlessSkipped(kept, async () => ++counted)).toBe(1);
  });

  test("keysetWhere with a single field is a plain comparison", () => {
    expect(keysetWhere({ fields: [{ path: "id", direction: "asc" }] }, ["k"])).toEqual({ id: { gt: "k" } });
  });
});
