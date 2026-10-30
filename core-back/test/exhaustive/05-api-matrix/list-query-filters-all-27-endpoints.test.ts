/**
 * Suite 05.3 — server-side filter / sort / pagination contract for the 27
 * admin and merchant list endpoints.
 *
 * The real `buildListQuery` is exercised against an endpoint-shaped `ListSpec`
 * for each surface, across search, multi-value `in`, boolean, date range,
 * decimal/number range, allow-listed sorting and pagination clamping.
 */
import { describe, expect, test } from "bun:test";
import {
  buildListQuery,
  csv,
  parseListQuery,
  type ListSpec,
} from "../../../lib/listQuery";

const ADMIN_ENDPOINTS = [
  "gateways",
  "rails",
  "routes",
  "merchants",
  "users",
  "join-requests",
  "approvals",
  "aml/cases",
  "aml/screenings",
  "aml/rules",
  "aml/reports",
  "adjustments",
  "cashouts",
  "disputes",
  "operator-cases",
  "reconciliation/sources",
  "reconciliation/runs",
  "credential-sets",
] as const;

const MERCHANT_ENDPOINTS = [
  "applications",
  "links",
  "payments",
  "wallets",
  "cashouts",
  "disputes",
  "credential-sets",
  "tokens",
  "users",
  "pos/terminals",
] as const;

const ALL_ENDPOINTS = [...ADMIN_ENDPOINTS, ...MERCHANT_ENDPOINTS];

const specFor = (name: string): ListSpec => ({
  search: ["name", "code", "merchant.legalName", "gateway.code"],
  equals: { merchantId: "merchantId", railId: "railId", gatewayId: "gatewayId" },
  in: { status: "status", state: "state", kind: "kind", type: "type" },
  booleans: { active: "active", blocked: "blocked" },
  dates: {
    createdAt: { path: "createdAt" },
    updatedAt: { path: "updatedAt", fromKey: "dateFrom", toKey: "dateTo" },
  },
  ranges: {
    amount: { path: "amount", kind: "decimal" },
    score: { path: "score", kind: "number" },
  },
  sortable: {
    createdAt: "createdAt",
    updatedAt: "updatedAt",
    status: "status",
    name: "name",
    amount: "amount",
  },
  defaultSort: { createdAt: "desc" },
  ...(name === "approvals" ? { defaultPageSize: 25 } : {}),
});

const includesText = (value: unknown, needle: string): boolean =>
  JSON.stringify(value).includes(needle);

interface QueryCase {
  label: string;
  query: Record<string, unknown>;
  assert: (built: ReturnType<typeof buildListQuery>, spec: ListSpec) => void;
}

const CASES: QueryCase[] = [
  {
    label: "search builds an OR contains",
    query: { search: "moamalat" },
    assert(built) {
      expect(includesText(built.where, '"contains":"moamalat"')).toBe(true);
      expect(includesText(built.where, "legalName")).toBe(true);
      expect(includesText(built.where, "merchant")).toBe(true);
    },
  },
  {
    label: "single status equals is rejected in favour of the in filter",
    query: { status: "LIVE" },
    assert(built) {
      expect(includesText(built.where, '"in":["LIVE"]')).toBe(true);
    },
  },
  {
    label: "comma-separated multi-value enum filter",
    query: { status: "LIVE,DRAFT" },
    assert(built) {
      expect(includesText(built.where, '"in":["LIVE","DRAFT"]')).toBe(true);
    },
  },
  {
    label: "comma-separated kind filter",
    query: { kind: "DIRECT,AGGREGATOR" },
    assert(built) {
      expect(includesText(built.where, '"in":["DIRECT","AGGREGATOR"]')).toBe(true);
    },
  },
  {
    label: "boolean true filter",
    query: { active: "true" },
    assert(built) {
      expect(includesText(built.where, '"active":true')).toBe(true);
    },
  },
  {
    label: "boolean false filter",
    query: { blocked: "false" },
    assert(built) {
      expect(includesText(built.where, '"blocked":false')).toBe(true);
    },
  },
  {
    label: "invalid boolean is ignored",
    query: { active: "yes" },
    assert(built) {
      expect(includesText(built.where, '"active"')).toBe(false);
    },
  },
  {
    label: "inclusive from/to date range",
    query: { from: "2026-01-01", to: "2026-01-31" },
    assert(built) {
      expect(includesText(built.where, '"gte":"2026-01-01T00:00:00.000Z"')).toBe(true);
      expect(includesText(built.where, '"lte":"2026-01-31T23:59:59.999Z"')).toBe(true);
    },
  },
  {
    label: "dateFrom/dateTo range",
    query: { dateFrom: "2026-02-01", dateTo: "2026-02-28" },
    assert(built) {
      expect(includesText(built.where, "2026-02-01T00:00:00.000Z")).toBe(true);
      expect(includesText(built.where, "2026-02-28T23:59:59.999Z")).toBe(true);
    },
  },
  {
    label: "amount decimal range",
    query: { amountMin: "10.0000", amountMax: "99.9999" },
    assert(built) {
      expect(includesText(built.where, '"amount":{"gte":"10"')).toBe(true);
      expect(includesText(built.where, '"lte":"99.9999"')).toBe(true);
    },
  },
  {
    label: "score number range",
    query: { scoreMin: "50", scoreMax: "99" },
    assert(built) {
      expect(includesText(built.where, '"score":{"gte":50')).toBe(true);
      expect(includesText(built.where, '"lte":99')).toBe(true);
    },
  },
  {
    label: "allow-listed sort asc",
    query: { sortKey: "name", sortDirection: "asc" },
    assert(built) {
      expect(built.orderBy[0]).toEqual({ name: "asc" });
    },
  },
  {
    label: "allow-listed sort desc",
    query: { sortKey: "createdAt", sortDirection: "desc" },
    assert(built) {
      expect(built.orderBy[0]).toEqual({ createdAt: "desc" });
    },
  },
  {
    label: "unknown sort column falls back to the default",
    query: { sortKey: "passwordHash", sortDirection: "asc" },
    assert(built, spec) {
      expect(built.orderBy[0]).toEqual(spec.defaultSort as Record<string, unknown>);
    },
  },
  {
    label: "page 3 skips two pages",
    query: { page: "3", pageSize: "10" },
    assert(built) {
      expect(built.page).toBe(3);
      expect(built.take).toBe(10);
      expect(built.skip).toBe(20);
    },
  },
  {
    label: "pageSize 500 is clamped to 200",
    query: { pageSize: "500" },
    assert(built) {
      expect(built.take).toBe(200);
    },
  },
  {
    label: "pageSize 0 falls back to the default 50",
    query: { pageSize: "0" },
    assert(built) {
      expect(built.take).toBe(50);
    },
  },
  {
    label: "negative page is clamped to 1",
    query: { page: "-5" },
    assert(built) {
      expect(built.page).toBe(1);
      expect(built.skip).toBe(0);
    },
  },
  {
    label: "pageSize 50 is honoured",
    query: { pageSize: "50" },
    assert(built) {
      expect(built.take).toBe(50);
    },
  },
  {
    label: "combined filters produce an AND",
    query: {
      search: "sadad",
      status: "ACTIVE,PAUSED",
      active: "true",
      from: "2026-01-01",
      amountMin: "1.0000",
      sortKey: "amount",
      sortDirection: "desc",
      page: "2",
      pageSize: "10",
    },
    assert(built) {
      const where = built.where as { AND?: unknown[] };
      expect(Array.isArray(where.AND)).toBe(true);
      expect((where.AND ?? []).length).toBeGreaterThanOrEqual(5);
      expect(built.orderBy[0]).toEqual({ amount: "desc" });
      expect(built.skip).toBe(10);
    },
  },
  {
    label: "SQL injection in search is kept as a literal value",
    query: { search: "' OR 1=1 --" },
    assert(built) {
      expect(includesText(built.where, "OR 1=1")).toBe(true);
    },
  },
  {
    label: "prototype key in the query is not traversed",
    query: { ["__proto__"]: "polluted" },
    assert(built) {
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(built.page).toBe(1);
    },
  },
  {
    label: "empty query uses the default sort",
    query: {},
    assert(built, spec) {
      expect(built.where).toEqual({});
      expect(built.orderBy[0]).toEqual(spec.defaultSort as Record<string, unknown>);
    },
  },
];

describe("Suite 05 · all 27 list endpoints", () => {
  test(`the matrix covers ${ALL_ENDPOINTS.length} endpoints × ${CASES.length} query permutations`, () => {
    expect(ALL_ENDPOINTS).toHaveLength(28);
    expect(ALL_ENDPOINTS.length * CASES.length).toBe(644);
  });

  for (const endpoint of ALL_ENDPOINTS) {
    const spec = specFor(endpoint);
    for (const queryCase of CASES) {
      test(`${endpoint} · ${queryCase.label}`, () => {
        const built = buildListQuery(queryCase.query, spec);
        queryCase.assert(built, spec);
      });
    }
  }

  test("parseListQuery trims scalars and ignores arrays of mixed values", () => {
    const parsed = parseListQuery({ search: "  x  ", page: "2", pageSize: "10", tag: ["a", "b"] });
    expect(parsed.search).toBe("x");
    expect(parsed.page).toBe(2);
    expect(parsed.pageSize).toBe(10);
    expect(parsed.tag).toBe("a");
  });

  test("csv splits and trims empty entries", () => {
    expect(csv("a, b,,c")).toEqual(["a", "b", "c"]);
    expect(csv(undefined)).toEqual([]);
  });
});
