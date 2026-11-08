import { client } from "../../prisma/client";
import { getAuthStateStore } from "./sharedState";

/**
 * Server-side session revoke list (GAP-019). A revoked session id (`jti`) is kept until the
 * token would have expired anyway, so the list stays bounded by the 12h session lifetime.
 * Enforced on every verification in `api/middleware/authDoubleCheck.ts`.
 *
 * Two copies: the shared auth state store (Redis when configured) is the fast path every node checks first; a
 * `session_revocations` row is the durable copy. Redis runs with a size limit and an eviction policy, and a restart
 * loses what was not yet persisted, so on a Redis miss the table is consulted (and the flag re-warmed): a revoked
 * session can no longer come back because its key was evicted or Redis restarted. The table is best effort in one
 * direction only: if it cannot be reached the Redis answer stands (the design is fail-open for availability).
 */
const key = (jti: string): string => `revoked:${jti}`;

/** About one revocation in this many also prunes the rows of tokens that expired anyway. */
const PRUNE_ONE_IN = 50;

export const revokeSession = async (jti: string, expiresAtSeconds: number, nowMs = Date.now()): Promise<void> => {
  const ttlMs = Math.max(1000, expiresAtSeconds * 1000 - nowMs);
  await getAuthStateStore().setFlag(key(jti), ttlMs);
  try {
    const expiresAt = new Date(nowMs + ttlMs);
    await client.sessionRevocation.upsert({ where: { jti }, create: { jti, expiresAt }, update: { expiresAt } });
    if (Math.floor(Math.random() * PRUNE_ONE_IN) === 0) {
      await client.sessionRevocation.deleteMany({ where: { expiresAt: { lt: new Date(nowMs) } } });
    }
  } catch {
    // The Redis flag is already set: logout still succeeds, only the durable copy is missing.
  }
};

export const isSessionRevoked = async (jti: string | null | undefined, nowMs = Date.now()): Promise<boolean> => {
  if (!jti) return false;
  const store = getAuthStateStore();
  if ((await store.flagRemainingMs(key(jti))) > 0) return true;
  try {
    const row = await client.sessionRevocation.findUnique({ where: { jti }, select: { expiresAt: true } });
    if (!row || row.expiresAt.getTime() <= nowMs) return false;
    // Redis lost the flag (eviction or restart): put it back for the rest of the token's life.
    await store.setFlag(key(jti), Math.max(1000, row.expiresAt.getTime() - nowMs)).catch(() => undefined);
    return true;
  } catch {
    return false;
  }
};
