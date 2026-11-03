import { describe, expect, test } from "bun:test";
import {
  defaultSearchRegistry,
  executeGlobalSearch,
  SearchProviderRegistry,
} from "../lib/globalSearch";
import {
  hasAuthority,
  hasConfidentialAmlAccess,
  hasMerchantSensitiveAccess,
} from "../lib/auth/confidentialAccess";
import {
  defineSearchProvider,
  parseSearchQuery,
  rankAndSliceCandidates,
} from "../lib/search/engine";

const actor = (role: string, authorities: string[]) => ({
  id: "actor-1",
  role,
  authorities,
});

describe("global search plugin engine", () => {
  test("parses type scopes and normalizes Libyan phone numbers", () => {
    const parsed = parseSearchQuery("type:merchant 091-234-5678");
    expect(parsed.scopedTypeAliases).toEqual(["merchant"]);
    expect(parsed.term).toBe("091-234-5678");
    expect(parsed.tokenKind).toBe("PHONE");
    expect(parsed.phoneVariants).toContain("+218912345678");
    expect(parsed.phoneVariants).toContain("218912345678");
  });

  test("ranks exact matches before prefix and substring matches", () => {
    const plugin = defineSearchProvider({
      type: "test_rank",
      order: 1,
      canAccess: () => true,
      fetchCandidates: async () => [],
      extractMatchSignals: (row: { id: string; title: string }) => ({
        exactFields: [row.id],
        primaryTextFields: [row.title],
        timestamp: 0,
      }),
      toResultItem: (row: { id: string; title: string }) => ({
        id: row.id,
        title: row.title,
      }),
    });
    const parsed = parseSearchQuery("acme");
    const ranked = rankAndSliceCandidates(
      [
        { id: "3", title: "My Acme Shop" },
        { id: "2", title: "Acme World" },
        { id: "acme", title: "Acme" },
      ],
      plugin,
      parsed,
      actor("SUPPORT", []),
      10,
    );
    expect(ranked.items.map((item) => item.id)).toEqual(["acme", "2", "3"]);
  });

  test("never queries unauthorized providers and never leaks their groups", async () => {
    const registry = new SearchProviderRegistry();
    let unauthorizedFetches = 0;
    registry
      .register(
        defineSearchProvider({
          type: "merchant",
          order: 10,
          canAccess: () => false,
          fetchCandidates: async () => {
            unauthorizedFetches += 1;
            return [];
          },
          extractMatchSignals: () => ({ exactFields: [] }),
          toResultItem: () => ({ id: "x", title: "X" }),
        }),
      )
      .register(
        defineSearchProvider({
          type: "approval",
          order: 20,
          canAccess: () => true,
          fetchCandidates: async ({ take }) =>
            Array.from({ length: take }, (_, index) => ({
              id: `approval-${index}`,
              title: `Approval Acme ${index}`,
            })),
          extractMatchSignals: (row) => ({
            exactFields: [row.id],
            primaryTextFields: [row.title],
          }),
          toResultItem: (row) => ({ id: row.id, title: row.title }),
        }),
      );

    const response = await executeGlobalSearch(
      { query: "acme", limit: 2 },
      { prisma: {} as never, actor: actor("SUPPORT", []), registry },
    );

    expect(unauthorizedFetches).toBe(0);
    expect(response.groups.map((group) => group.type)).toEqual(["approval"]);
    expect(response.groups[0]?.items).toHaveLength(2);
    expect(response.groups[0]?.truncated).toBe(true);
    expect(response.total).toBe(2);
  });

  test("isolates provider failures and does not log the raw query", async () => {
    const registry = new SearchProviderRegistry();
    const errors: Array<{ message: string; meta?: Record<string, unknown> }> = [];
    registry
      .register(
        defineSearchProvider({
          type: "merchant",
          order: 10,
          canAccess: () => true,
          fetchCandidates: async () => {
            throw new Error("database timeout");
          },
          extractMatchSignals: () => ({ exactFields: [] }),
          toResultItem: () => ({ id: "x", title: "X" }),
        }),
      )
      .register(
        defineSearchProvider({
          type: "approval",
          order: 20,
          canAccess: () => true,
          fetchCandidates: async () => [{ id: "approval-1", title: "Acme approval" }],
          extractMatchSignals: (row) => ({
            exactFields: [row.id],
            primaryTextFields: [row.title],
          }),
          toResultItem: (row) => ({ id: row.id, title: row.title }),
        }),
      );

    const response = await executeGlobalSearch(
      { query: "acme secret" },
      {
        prisma: {} as never,
        actor: actor("SECURITY_ADMIN", ["security:read"]),
        requestId: "req-1",
        registry,
        logger: {
          warn: () => undefined,
          error: (message, meta) => errors.push({ message, meta }),
        },
      },
    );

    expect(response.partial).toBe(true);
    expect(response.groups.map((group) => group.type)).toEqual(["approval"]);
    expect(errors).toHaveLength(1);
    expect(JSON.stringify(errors[0]?.meta)).not.toContain("acme secret");
    expect(errors[0]?.meta?.requestId).toBe("req-1");
  });

  test("rejects short queries and unknown provider types", async () => {
    await expect(
      executeGlobalSearch(
        { query: "a" },
        { prisma: {} as never, actor: actor("SUPPORT", []) },
      ),
    ).rejects.toMatchObject({ statusCode: 400 });

    await expect(
      executeGlobalSearch(
        { query: "acme", types: ["not_a_real_type"] },
        { prisma: {} as never, actor: actor("SUPPORT", []) },
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("global search authority matrix", () => {
  test("registers the six master-data providers with unique types and order", () => {
    const providers = defaultSearchRegistry.getAllOrdered();
    expect(providers.map((provider) => provider.type)).toEqual([
      "merchant",
      "payment_attempt",
      "gateway",
      "rail",
      "route",
      "user",
    ]);
    expect(new Set(providers.map((provider) => provider.type)).size).toBe(6);
    expect(new Set(providers.map((provider) => provider.order)).size).toBe(6);
  });

  const can = (type: string, role: string, authorities: string[]): boolean =>
    defaultSearchRegistry.get(type)?.canAccess(actor(role, authorities)) ?? false;

  test("support sees merchants, attempts and users but no sensitive merchant matching", () => {
    expect(can("merchant", "SUPPORT", ["merchant:read"])).toBe(true);
    expect(can("payment_attempt", "SUPPORT", ["merchant:read", "attempt:read"])).toBe(true);
    expect(can("user", "SUPPORT", ["security:read"])).toBe(true);
    expect(hasMerchantSensitiveAccess(actor("SUPPORT", ["merchant:write", "compliance:read"]))).toBe(false);
  });

  test("master-data authorities gate the gateway, rail and route groups", () => {
    expect(can("gateway", "GATEWAY_ADMIN", ["gateway:read"])).toBe(true);
    expect(can("rail", "GATEWAY_ADMIN", ["gateway:read"])).toBe(true);
    expect(can("route", "GATEWAY_ADMIN", ["gateway:read"])).toBe(true);
    expect(can("gateway", "SUPPORT", [])).toBe(false);
    expect(can("user", "SECURITY_ADMIN", ["security:read"])).toBe(true);
    expect(can("user", "OPERATOR", ["case:read"])).toBe(false);
  });

  test("wildcard authority grants access", () => {
    expect(hasAuthority(actor("GATEWAY_ADMIN", ["*"]), "merchant:read")).toBe(true);
    expect(hasAuthority(actor("GATEWAY_ADMIN", []), "merchant:read")).toBe(false);
  });
});
