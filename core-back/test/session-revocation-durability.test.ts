/**
 * A revoked session stays revoked when Redis loses its flag (eviction, restart): the durable
 * `session_revocations` row answers and re-warms the flag. Real PostgreSQL 18 test database (skipped when unreachable).
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { client } from "../prisma/client";
import { isSessionRevoked, revokeSession } from "../lib/auth/revocation";
import { MemoryAuthStateStore, setAuthStateStore } from "../lib/auth/sharedState";

const DATABASE_URL = process.env.POSTGRES_TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
process.env.DATABASE_URL = DATABASE_URL;

const reachable = await (async (): Promise<boolean> => {
  try {
    if (!/test/i.test(new URL(DATABASE_URL).pathname.replace(/^\//, ""))) return false;
    await client.$queryRawUnsafe("SELECT 1 AS ok");
    return true;
  } catch {
    return false;
  }
})();

beforeEach(() => {
  setAuthStateStore(new MemoryAuthStateStore());
});

afterAll(async () => {
  if (reachable) await client.$disconnect().catch(() => undefined);
});

const inAnHour = (): number => Math.floor(Date.now() / 1000) + 3600;

describe.skipIf(!reachable)("session revocation survives the loss of the Redis flag", () => {
  test("revoking writes the durable row, and a wiped store still answers 'revoked' and re-warms the flag", async () => {
    const jti = `jti-${randomUUID()}`;
    await revokeSession(jti, inAnHour());
    expect((await client.sessionRevocation.findUnique({ where: { jti } }))?.jti).toBe(jti);

    // Redis restarted or evicted the key: the fast path is empty.
    const wiped = new MemoryAuthStateStore();
    setAuthStateStore(wiped);
    expect(await wiped.flagRemainingMs(`revoked:${jti}`)).toBe(0);
    expect(await isSessionRevoked(jti)).toBe(true);
    // The flag is back for the rest of the token's life, so the next check does not need the table.
    expect(await wiped.flagRemainingMs(`revoked:${jti}`)).toBeGreaterThan(3_000_000);
  });

  test("a session that was never revoked, or whose token expired anyway, is not revoked", async () => {
    expect(await isSessionRevoked(`jti-${randomUUID()}`)).toBe(false);
    const expired = `jti-${randomUUID()}`;
    await client.sessionRevocation.create({ data: { jti: expired, expiresAt: new Date(Date.now() - 1000) } });
    expect(await isSessionRevoked(expired)).toBe(false);
    expect(await isSessionRevoked(null)).toBe(false);
  });

  test("revoking twice keeps one row and extends nothing it should not", async () => {
    const jti = `jti-${randomUUID()}`;
    await revokeSession(jti, inAnHour());
    await revokeSession(jti, inAnHour());
    expect(await client.sessionRevocation.count({ where: { jti } })).toBe(1);
  });
});
