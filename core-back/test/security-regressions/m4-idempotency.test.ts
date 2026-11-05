import { describe, expect, test } from "bun:test";
import { AttemptGuardPipeline } from "../../engine/guards/AttemptGuardPipeline";
import { CachedScreeningProvider, InternalWatchlistProvider } from "../../engine/guards/ScreeningProvider";
import { createPrismaGuardFixture, linkRow } from "../helpers/guardsFake";

const req = (linkKey: string, idempotencyKey: string) => ({
  linkKey, railCode: "edfali", applicationId: "application-1", merchantId: "merchant-1",
  env: "SANDBOX" as const, channel: "WEB" as const, mode: "OTP_PULL", idempotencyKey,
});

const pipelineOf = (f: ReturnType<typeof createPrismaGuardFixture>) =>
  new AttemptGuardPipeline({
    db: f.db, repositories: f.repositories,
    screening: new CachedScreeningProvider(new InternalWatchlistProvider()), clock: () => new Date("2026-03-01T12:00:00Z"),
  });

describe("M4 idempotency lookup is scoped to the link", () => {
  test("the same key on link B does not replay link A's attempt", async () => {
    const f = createPrismaGuardFixture();
    const pipe = pipelineOf(f);
    const a = await pipe.guard(req("link-key-1", "K-shared-0001"));
    f.state.link = linkRow({ id: "link-2", key: "link-key-2" });
    const b = await pipe.guard(req("link-key-2", "K-shared-0001"));
    expect(b.reasons).not.toContain("IDEMPOTENT_REPLAY");
    expect(b.attemptId).not.toBe(a.attemptId);
    expect(f.state.createdAttempts).toHaveLength(2);
  });

  test("control: the same key on the same link is still a replay", async () => {
    const f = createPrismaGuardFixture();
    const pipe = pipelineOf(f);
    const first = await pipe.guard(req("link-key-1", "K-shared-0002"));
    const second = await pipe.guard(req("link-key-1", "K-shared-0002"));
    expect(second.reasons).toContain("IDEMPOTENT_REPLAY");
    expect(second.attemptId).toBe(first.attemptId);
    expect(f.state.createdAttempts).toHaveLength(1);
  });

  test("the real repository query includes linkId", async () => {
    const f = createPrismaGuardFixture();
    const wheres: unknown[] = [];
    const tx = { paymentAttempt: { findFirst: async ({ where }: { where: unknown }) => { wheres.push(where); return null; } } };
    await f.repositories.payments.findAttemptByIdempotencyKey(tx as never, "K", "link-1");
    expect(wheres[0]).toEqual({ linkId: "link-1", idempotencyKey: "K" });
  });

  test("a unique-constraint race (P2002) on create is treated as a replay, not an error", async () => {
    const f = createPrismaGuardFixture();
    const pipe = pipelineOf(f);
    const winner = await pipe.guard(req("link-key-1", "K-race-00001"));
    // Simulate the loser: its first lookup misses (race), its insert hits P2002, the retry finds the winner.
    const payments = f.repositories.payments;
    const realFind = payments.findAttemptByIdempotencyKey;
    let calls = 0;
    payments.findAttemptByIdempotencyKey = async (tx, key, linkId) => (calls++ === 0 ? null : realFind(tx, key, linkId));
    const realCreate = payments.createAttempt;
    let created = 0;
    payments.createAttempt = async (tx, data) => {
      if (created++ === 0) throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
      return realCreate(tx, data);
    };
    const replay = await pipe.guard(req("link-key-1", "K-race-00001"));
    expect(replay.reasons).toContain("IDEMPOTENT_REPLAY");
    expect(replay.attemptId).toBe(winner.attemptId);
  });
});
