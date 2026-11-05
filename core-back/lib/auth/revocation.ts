import { getAuthStateStore } from "./sharedState";

/**
 * Server-side session revoke list (GAP-019). A revoked session id (`jti`) is kept until the
 * token would have expired anyway, so the list stays bounded by the 12h session lifetime.
 * Enforced on every verification in `api/middleware/authDoubleCheck.ts`.
 */
const key = (jti: string): string => `revoked:${jti}`;

export const revokeSession = async (jti: string, expiresAtSeconds: number, nowMs = Date.now()): Promise<void> => {
  const ttlMs = Math.max(1000, expiresAtSeconds * 1000 - nowMs);
  await getAuthStateStore().setFlag(key(jti), ttlMs);
};

export const isSessionRevoked = async (jti: string | null | undefined): Promise<boolean> => {
  if (!jti) return false;
  return (await getAuthStateStore().flagRemainingMs(key(jti))) > 0;
};
