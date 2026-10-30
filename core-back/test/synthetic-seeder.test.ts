import { describe, expect, test } from "bun:test";
import { emptyDataset } from "../prisma/syntheticSeeder/dataset";
import { Prng } from "../prisma/syntheticSeeder/prng";
import { buildTimeline, dayVolumeMultiplier, iterateDays } from "../prisma/syntheticSeeder/timelineClock";
import { auditInMemory } from "../prisma/syntheticSeeder/verify/postSeedAudit";
import { postLedger } from "../prisma/syntheticSeeder/builders";
import type { SeederContext } from "../prisma/syntheticSeeder/context";

const fakeContext = (): SeederContext => {
  let counter = 0;
  const now = new Date("2026-10-30T15:00:00.000Z");
  return {
    prisma: {} as never,
    config: {
      profile: "COMPACT",
      seedKey: "test",
      namespace: "test",
      now,
      volumes: {
        merchants: 1, joinRequests: 1, kybDocuments: 1, beneficialOwners: 1, users: 1,
        wallets: 1, applications: 1, paymentLinks: 1, paymentAttempts: 1,
        reconciliationRuns: 1, reconciliationItems: 1, disputes: 1, adjustments: 1,
        cashouts: 1, amlScreenings: 1, amlCases: 1, operatorCases: 1,
        approvalRequests: 1, yearsSpan: 3.5,
      },
    },
    rng: new Prng("test"),
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

describe("deterministic synthetic seeder primitives", () => {
  test("xoshiro128** is reproducible", () => {
    const a = new Prng("libya-pg");
    const b = new Prng("libya-pg");
    expect([a.next(), a.next(), a.next(), a.next()]).toEqual([b.next(), b.next(), b.next(), b.next()]);
    expect(new Prng("other").next()).not.toBe(new Prng("libya-pg").next());
  });

  test("the 3.5-year S-curve grows adoption and keeps the Friday dip", () => {
    expect(dayVolumeMultiplier(new Date("2023-05-04T10:00:00Z"), 0, 42))
      .toBeLessThan(dayVolumeMultiplier(new Date("2026-09-04T10:00:00Z"), 40, 42));
    const friday = new Date("2024-03-01T10:00:00Z"); // Friday
    const saturday = new Date("2024-03-02T10:00:00Z");
    expect(dayVolumeMultiplier(friday, 10, 42)).toBeLessThan(dayVolumeMultiplier(saturday, 10, 42));
  });

  test("the timeline covers 42 months", () => {
    const days = iterateDays(buildTimeline(new Date("2026-10-30T15:00:00Z"), 3.5));
    expect(days.length).toBeGreaterThan(1200);
    expect(days.length).toBeLessThan(1300);
  });
});

describe("ledger templates and the post-seed audit", () => {
  test("postLedger rejects an unbalanced entry", () => {
    const ctx = fakeContext();
    expect(() =>
      postLedger(ctx, {
        refType: "PAYMENT_ATTEMPT",
        refId: "x",
        description: "bad",
        at: new Date(),
        lines: [
          { glAccountId: "a", direction: "DEBIT", amount: "10.0000" },
          { glAccountId: "b", direction: "CREDIT", amount: "9.0000" },
        ],
      }),
    ).toThrow(/Unbalanced/);
  });

  test("a balanced ledger passes the invariant audit", () => {
    const ctx = fakeContext();
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

  test("the audit detects drift and slot violations", () => {
    const ctx = fakeContext();
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
