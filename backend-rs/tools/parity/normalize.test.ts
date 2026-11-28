import { describe, expect, test } from "bun:test";
import {
  diffResponses,
  formatDifferences,
  normalizeResponse,
  pathMatches,
  ruleTableLines,
  type RawResponse,
} from "./normalize";

const raw = (body: unknown, headers: Record<string, string> = {}): RawResponse => ({
  status: 200,
  headers: { "content-type": "application/json; charset=utf-8", ...headers },
  body: JSON.stringify(body),
});

describe("normalizeResponse", () => {
  test("sorts keys and removes volatile fields anywhere", () => {
    const response = normalizeResponse(
      raw({
        zeta: 1,
        requestId: "b6c1f2d0-1111-4222-8333-444455556666",
        nested: { updatedAt: "2026-11-28T10:00:00.000Z", alpha: true },
        createdAt: "2026-11-28T10:00:00.000Z",
        release: "2026.11.28",
      }),
    );
    expect(JSON.stringify(response.body)).toBe('{"nested":{"alpha":true},"zeta":1}');
  });

  test("keeps array order unless a path or key marks it as a set", () => {
    const ordered = normalizeResponse(raw({ items: [3, 1, 2] }));
    expect((ordered.body as { items: number[] }).items).toEqual([3, 1, 2]);

    const byPath = normalizeResponse(raw({ items: [3, 1, 2] }), {
      unorderedPaths: ["items"],
    });
    expect((byPath.body as { items: number[] }).items).toEqual([1, 2, 3]);

    const byKey = normalizeResponse(raw({ scopes: ["wallets:read", "links:read"] }));
    expect((byKey.body as { scopes: string[] }).scopes).toEqual(["links:read", "wallets:read"]);
  });

  test("replaces UUIDs, timestamps, JWTs and LSNs in string values", () => {
    const response = normalizeResponse(
      raw({
        id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
        at: "2026-11-28T10:00:00.123Z",
        token: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl",
        lsn: "16/B6C50",
      }),
    );
    expect(response.body).toEqual({
      at: "<timestamp>",
      id: "<uuid>",
      lsn: "<lsn>",
      token: "<jwt>",
    });
  });

  test("supports configurable generated references per route", () => {
    const response = normalizeResponse(raw({ reference: "PARITY-REF-0001", keep: "REF-1" }), {
      placeholders: [{ name: "generated-ref", pattern: "^PARITY-REF-\\d+$", placeholder: "<ref>" }],
    });
    expect(response.body).toEqual({ keep: "REF-1", reference: "<ref>" });
  });

  test("keepKeys and orderedKeys override the defaults", () => {
    const response = normalizeResponse(
      raw({ release: "2026.11.28", tags: ["zeta", "alpha"], commit: "abc" }),
      { keepKeys: ["release"], orderedKeys: ["tags"] },
    );
    expect(response.body).toEqual({ release: "2026.11.28", tags: ["zeta", "alpha"] });
  });

  test("drops details messages by default but can pin them", () => {
    const payload = { code: "X", details: [{ field: "amount", message: "must be positive" }] };
    const dropped = normalizeResponse(raw(payload));
    expect(dropped.body).toEqual({ code: "X", details: [{ field: "amount" }] });
    const pinned = normalizeResponse(raw(payload), { ignoreDetailMessages: true });
    expect(pinned.body).toEqual(payload);
  });

  test("keeps the header allowlist and normalises rate-limit counters", () => {
    const response = normalizeResponse({
      status: 429,
      headers: {
        "content-type": "application/json",
        "ratelimit-policy": "120;w=60",
        ratelimit: "limit=120, remaining=42, reset=17",
        date: "Sat, 28 Nov 2026 10:00:00 GMT",
        etag: 'W/"abc"',
        "x-pg-served-by": "core-1",
        "x-random": "noise",
      },
      body: "{}",
    });
    expect(response.headers).toEqual({
      "content-type": "application/json",
      "ratelimit": "limit=120, remaining=<n>, reset=<n>",
      "ratelimit-policy": "120;w=60",
      "x-pg-served-by": "core-1",
    });
    const pinned = normalizeResponse(
      { status: 429, headers: { ratelimit: "limit=120, remaining=42, reset=17" }, body: "{}" },
      { pinRateLimit: true },
    );
    expect(pinned.headers.ratelimit).toBe("limit=120, remaining=42, reset=17");
  });

  test("preserves non-JSON bodies as text", () => {
    const response = normalizeResponse({
      status: 200,
      headers: { "content-type": "text/plain" },
      body: "hello",
    });
    expect(response.bodyKind).toBe("text");
    expect(response.body).toBe("hello");
  });
});

describe("diffResponses", () => {
  test("zero diffs for semantically equal responses with different volatile fields", () => {
    const left = normalizeResponse(
      raw({ amount: "100.0000", requestId: "a", createdAt: "2026-01-01T00:00:00Z" }),
    );
    const right = normalizeResponse(
      raw({ amount: "100.0000", requestId: "b", createdAt: "2026-01-02T00:00:00Z" }),
    );
    expect(diffResponses(left, right).differences).toEqual([]);
  });

  test("reports status, header and body differences", () => {
    const left = normalizeResponse(raw({ amount: "100.0000", currency: "LYD" }));
    const right = normalizeResponse(raw({ amount: "100.0001", currency: "LYD" }, { "cache-control": "no-store" }));
    const diff = diffResponses(left, right);
    expect(diff.equal).toBe(false);
    const paths = diff.differences.map((entry) => entry.path);
    expect(paths).toContain("/body/amount");
    expect(paths).toContain("/headers/cache-control");
    expect(formatDifferences(diff.differences)).toHaveLength(diff.differences.length);
  });

  test("reports array length and missing values", () => {
    const left = normalizeResponse(raw({ items: [1, 2] }));
    const right = normalizeResponse(raw({ items: [1] }));
    const diff = diffResponses(left, right);
    expect(diff.differences.some((entry) => entry.kind === "length")).toBe(true);
    expect(diff.differences.some((entry) => entry.kind === "missing-right")).toBe(true);
  });
});

describe("path matching and rule table", () => {
  test("supports one-segment and recursive wildcards", () => {
    expect(pathMatches("details/*/message", ["details", "*", "message"])).toBe(true);
    expect(pathMatches("data/**/internal", ["data", "a", "b", "internal"])).toBe(true);
    expect(pathMatches("data/*/internal", ["data", "a", "b", "internal"])).toBe(false);
    expect(pathMatches("body/items", ["items"])).toBe(true);
  });

  test("every default rule is documented with an id, scope and action", () => {
    const lines = ruleTableLines();
    expect(lines.length).toBeGreaterThan(8);
    for (const line of lines) {
      const [id, scope, match, action] = line.split("\t");
      expect(id?.length).toBeGreaterThan(2);
      expect(["status", "headers", "body"]).toContain(scope!);
      expect(match?.length).toBeGreaterThan(2);
      expect(action?.length).toBeGreaterThan(1);
    }
  });
});
