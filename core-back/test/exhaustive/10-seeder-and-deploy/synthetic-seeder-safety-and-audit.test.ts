/**
 * Suite 10.2 — the five-layer synthetic seeder safety gate and the post-seed
 * audit / 3.5-year timeline.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  assertSafeToSeedSyntheticData,
} from "../../../prisma/syntheticSeeder/SeederSafetyGate";
import { auditInMemory } from "../../../prisma/syntheticSeeder/verify/postSeedAudit";
import { buildTimeline, dayVolumeMultiplier, iterateDays } from "../../../prisma/syntheticSeeder/timelineClock";
import { emptyDataset } from "../../../prisma/syntheticSeeder/dataset";
import { Prng } from "../../../prisma/syntheticSeeder/prng";
import { postLedger } from "../../../prisma/syntheticSeeder/builders";
import type { SeederContext } from "../../../prisma/syntheticSeeder/context";

const ENV_KEYS = [
  "IS_TEST_SERVER",
  "FAKE_RAILS_ENABLED",
  "FAKE_RAILS_PUBLIC_BASE_URL",
  "FAKE_RAILS_ALLOWED_HOSTS",
  "FAKE_RAILS_ALLOW_IN_PRODUCTION",
  "FAKE_RAILS_SEEDER_TOKEN",
  "NODE_ENV",
];

const original = new Map<string, string | undefined>();
const originalFetch = globalThis.fetch;

const resetEnv = () => {
  for (const key of ENV_KEYS) {
    if (original.has(key)) {
      const value = original.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    } else {
      delete process.env[key];
    }
  }
  globalThis.fetch = originalFetch;
};

for (const key of ENV_KEYS) {
  original.set(key, process.env[key]);
}

const safeEnv = () => {
  process.env.IS_TEST_SERVER = "true";
  process.env.FAKE_RAILS_ENABLED = "true";
  process.env.FAKE_RAILS_PUBLIC_BASE_URL = "http://127.0.0.1:8444";
  process.env.FAKE_RAILS_ALLOWED_HOSTS = "127.0.0.1,localhost";
  process.env.FAKE_RAILS_SEEDER_TOKEN = "0123456789abcdef0123456789abcdef";
  process.env.NODE_ENV = "test";
};

const prismaWith = (environments: Array<{ code: string; baseUrls: Record<string, string> }>) => ({
  gatewayEnvironment: {
    async findMany() {
      return environments.map((environment) => ({
        baseUrls: environment.baseUrls,
        gatewayVersion: { gateway: { code: environment.code } },
      }));
    },
  },
}) as never;

const baseEnvironments = [{ code: "moamalat", baseUrls: { api: "http://127.0.0.1:8444/rails/moamalat" } }];

const expectMessage = async (promise: Promise<unknown>, fragment: string) => {
  try {
    await promise;
  } catch (error) {
    expect(String((error as Error).message)).toContain(fragment);
    return;
  }
  throw new Error(`Expected the seeder to fail with '${fragment}'`);
};

afterEach(() => {
  resetEnv();
});

describe("Suite 10 · seeder safety gates", () => {
  test("gate 1 refuses when IS_TEST_SERVER is not 'true'", async () => {
    safeEnv();
    process.env.IS_TEST_SERVER = "false";
    await expectMessage(assertSafeToSeedSyntheticData(prismaWith(baseEnvironments)), "SEEDER_BLOCKED_NOT_TEST_SERVER");
  });

  test("gate 2 refuses when Fake Rails is disabled", async () => {
    safeEnv();
    process.env.FAKE_RAILS_ENABLED = "false";
    await expectMessage(assertSafeToSeedSyntheticData(prismaWith(baseEnvironments)), "SEEDER_BLOCKED_FAKE_RAILS_DISABLED");
  });

  test("gate 2 refuses without a public base URL", async () => {
    safeEnv();
    delete process.env.FAKE_RAILS_PUBLIC_BASE_URL;
    await expectMessage(assertSafeToSeedSyntheticData(prismaWith(baseEnvironments)), "SEEDER_BLOCKED_FAKE_RAILS_DISABLED");
  });

  test("gate 3 refuses production without the explicit production flag", async () => {
    safeEnv();
    process.env.NODE_ENV = "production";
    await expectMessage(assertSafeToSeedSyntheticData(prismaWith(baseEnvironments)), "SEEDER_BLOCKED_PROD_GUARD");
  });

  test("gate 3 accepts production with the explicit flag", async () => {
    safeEnv();
    process.env.NODE_ENV = "production";
    process.env.FAKE_RAILS_ALLOW_IN_PRODUCTION = "true";
    globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch;
    await expect(assertSafeToSeedSyntheticData(prismaWith(baseEnvironments))).resolves.toBeDefined();
  });

  test("gate 4 refuses an empty allowed-host list", async () => {
    safeEnv();
    process.env.FAKE_RAILS_ALLOWED_HOSTS = "";
    await expectMessage(assertSafeToSeedSyntheticData(prismaWith(baseEnvironments)), "SEEDER_BLOCKED_NO_ALLOWED_HOSTS");
  });

  test("gate 4 refuses when no fake gateway is seeded", async () => {
    safeEnv();
    await expectMessage(assertSafeToSeedSyntheticData(prismaWith([])), "SEEDER_BLOCKED_NO_FAKE_RAILS_SEEDED");
  });

  test("gate 4 refuses an invalid gateway URL", async () => {
    safeEnv();
    await expectMessage(
      assertSafeToSeedSyntheticData(prismaWith([{ code: "bad", baseUrls: { api: "not-a-url" } }])),
      "SEEDER_BLOCKED_INVALID_GATEWAY_URL",
    );
  });

  test("gate 4 refuses a gateway pointing at an external host", async () => {
    safeEnv();
    await expectMessage(
      assertSafeToSeedSyntheticData(prismaWith([{ code: "evil", baseUrls: { api: "https://evil.example.com/pay" } }])),
      "SEEDER_BLOCKED_EXTERNAL_HOST_DETECTED",
    );
  });

  test("gate 4 refuses the cloud metadata address", async () => {
    safeEnv();
    await expectMessage(
      assertSafeToSeedSyntheticData(prismaWith([{ code: "metadata", baseUrls: { api: "http://169.254.169.254/latest" } }])),
      "SEEDER_BLOCKED_EXTERNAL_HOST_DETECTED",
    );
  });

  test("gate 5 refuses an unreachable Fake Rails service", async () => {
    safeEnv();
    globalThis.fetch = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    await expectMessage(assertSafeToSeedSyntheticData(prismaWith(baseEnvironments)), "SEEDER_BLOCKED_FAKE_RAILS_UNREACHABLE");
  });

  test("gate 5 refuses a non-ok handshake", async () => {
    safeEnv();
    globalThis.fetch = (async () => new Response("{}", { status: 503 })) as unknown as typeof fetch;
    await expectMessage(assertSafeToSeedSyntheticData(prismaWith(baseEnvironments)), "SEEDER_BLOCKED_FAKE_RAILS_UNREACHABLE");
  });

  test("all five gates pass and return the handshake report", async () => {
    safeEnv();
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: true, service: "fake-rails-back", rails: 20 }), { status: 200 })) as unknown as typeof fetch;
    const report = await assertSafeToSeedSyntheticData(prismaWith(baseEnvironments));
    expect(report.ok).toBe(true);
    expect(report.rails).toBe(20);
  });

  test("the gate checks every configured environment", async () => {
    safeEnv();
    globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch;
    await expectMessage(
      assertSafeToSeedSyntheticData(prismaWith([
        { code: "first", baseUrls: { api: "http://127.0.0.1:8444/rails/first" } },
        { code: "second", baseUrls: { api: "https://gateway.example.com/pay" } },
      ])),
      "second",
    );
  });
});

const context = (): SeederContext => {
  let counter = 0;
  const now = new Date("2026-10-30T15:00:00.000Z");
  return {
    prisma: {} as never,
    config: {
      profile: "COMPACT",
      seedKey: "exhaustive",
      namespace: "exhaustive",
      now,
      volumes: {
        merchants: 1, joinRequests: 1, kybDocuments: 1, beneficialOwners: 1, users: 1,
        wallets: 1, applications: 1, paymentLinks: 1, paymentAttempts: 1,
        reconciliationRuns: 1, reconciliationItems: 1, disputes: 1, adjustments: 1,
        cashouts: 1, amlScreenings: 1, amlCases: 1, operatorCases: 1,
        approvalRequests: 1, yearsSpan: 3.5,
      },
    },
    rng: new Prng("exhaustive"),
    timeline: buildTimeline(now, 3.5),
    dataset: emptyDataset(),
    refs: {
      gateways: [], versions: [], rails: [], routes: [], credentials: [],
      glAccounts: [], adminUsers: [], statementSources: [],
    },
    checkpoints: new Map(),
    nextId: () => `00000000-0000-7000-8000-${(counter += 1).toString(16).padStart(12, "0")}`,
  };
};

describe("Suite 10 · synthetic seeder audit & timeline", () => {
  test("the PRNG is deterministic", () => {
    expect([new Prng("seed").next(), new Prng("seed").next()]).toEqual([new Prng("seed").next(), new Prng("seed").next()]);
  });

  test("the timeline spans 3.5 years", () => {
    const days = iterateDays(buildTimeline(new Date("2026-10-30T15:00:00Z"), 3.5));
    expect(days.length).toBeGreaterThan(1200);
    expect(days.length).toBeLessThan(1300);
  });

  test("adoption grows over the timeline", () => {
    expect(dayVolumeMultiplier(new Date("2023-05-04T10:00:00Z"), 0, 42))
      .toBeLessThan(dayVolumeMultiplier(new Date("2026-09-04T10:00:00Z"), 40, 42));
  });

  test("Friday traffic is lower than Saturday traffic", () => {
    const friday = new Date("2024-03-01T10:00:00Z");
    const saturday = new Date("2024-03-02T10:00:00Z");
    expect(dayVolumeMultiplier(friday, 10, 42)).toBeLessThan(dayVolumeMultiplier(saturday, 10, 42));
  });

  test("postLedger refuses an unbalanced entry", () => {
    expect(() => postLedger(context(), {
      refType: "PAYMENT_ATTEMPT",
      refId: "x",
      description: "bad",
      at: new Date(),
      lines: [
        { glAccountId: "a", direction: "DEBIT", amount: "10.0000" },
        { glAccountId: "b", direction: "CREDIT", amount: "9.0000" },
      ],
    })).toThrow(/Unbalanced/);
  });

  test("a balanced ledger passes the audit with zero drift", () => {
    const ctx = context();
    postLedger(ctx, {
      refType: "PAYMENT_ATTEMPT",
      refId: "x",
      description: "ok",
      at: new Date(),
      lines: [
        { glAccountId: "a", direction: "DEBIT", amount: "10.0000" },
        { glAccountId: "b", direction: "CREDIT", amount: "10.0000" },
      ],
    });
    ctx.dataset.paymentLinks.push({ id: "link-1", activeLockedCount: 0 });
    ctx.dataset.paymentAttempts.push({ id: "att-1", linkId: "link-1", status: "SUCCEEDED", ledgerEntryId: "entry" });
    const report = auditInMemory(ctx);
    expect(report.ok).toBe(true);
    expect(report.ledgerDrift).toBe("0.0000");
  });

  test("the audit detects an unbalanced entry", () => {
    const ctx = context();
    ctx.dataset.journalLines.push(
      { id: "l1", entryId: "e1", glAccountId: "a", direction: "DEBIT", amount: "10.0000" },
      { id: "l2", entryId: "e1", glAccountId: "b", direction: "CREDIT", amount: "5.0000" },
    );
    ctx.dataset.paymentLinks.push({ id: "link-1", activeLockedCount: 1 });
    ctx.dataset.paymentAttempts.push({ id: "att-1", linkId: "link-1", status: "UNKNOWN", ledgerEntryId: null });
    const report = auditInMemory(ctx);
    expect(report.ok).toBe(false);
    expect(report.unbalancedEntries).toBe(1);
  });
});
