import { createHash } from "node:crypto";
import { ApiError } from "../error";
import { getAuthStateStore } from "./sharedState";

/**
 * Login and MFA failure throttles (GAP-027).
 *
 * Counters live in the shared auth state store (Redis when `REDIS_URL` is set, so every
 * core instance sees the same counters; per-process memory otherwise or while Redis is
 * unreachable; see `sharedState.ts` for the policy). The durable, multi-instance protection
 * of the MFA code itself is the attempt counter stored on `mfa_challenges`. Keys are hashed
 * so an identifier (phone or email) is never kept in clear.
 */
export interface ThrottlePolicy {
  maxFailures: number;
  windowMs: number;
  lockMs: number;
}

/**
 * The tight login lock is keyed on the identifier AND the client address: five wrong passwords from
 * one address lock that identifier for that address only. Before this the lock was keyed on the
 * identifier alone, so anyone who knew a victim's email or phone could keep the account locked for
 * everybody (the check runs before the password is verified, so the owner's correct password was
 * refused too) with five requests per 15 minutes.
 */
export const LOGIN_PAIR_POLICY: ThrottlePolicy = { maxFailures: 5, windowMs: 15 * 60_000, lockMs: 15 * 60_000 };
/**
 * A much higher identifier-only ceiling still stops guessing spread over many addresses against one
 * account. Reaching it takes ten times the work of the old lock, and a successful login clears it.
 */
export const LOGIN_IDENTIFIER_POLICY: ThrottlePolicy = { maxFailures: 50, windowMs: 15 * 60_000, lockMs: 15 * 60_000 };
export const LOGIN_IP_POLICY: ThrottlePolicy = { maxFailures: 30, windowMs: 15 * 60_000, lockMs: 15 * 60_000 };
export const MFA_IP_POLICY: ThrottlePolicy = { maxFailures: 20, windowMs: 15 * 60_000, lockMs: 15 * 60_000 };

const keyOf = (scope: string, value: string): string =>
  `${scope}:${createHash("sha256").update(value.toLowerCase(), "utf8").digest("hex")}`;

export const assertNotThrottled = async (scope: string, value: string): Promise<void> => {
  const remaining = await getAuthStateStore().flagRemainingMs(`${keyOf(scope, value)}:lock`);
  if (remaining > 0) {
    throw new ApiError(429, "AUTH_THROTTLED", "Too many failed attempts. Try again later", {
      retryAfterSeconds: Math.ceil(remaining / 1000),
    });
  }
};

export const recordFailure = async (scope: string, value: string, policy: ThrottlePolicy): Promise<void> => {
  const store = getAuthStateStore();
  const key = keyOf(scope, value);
  const failures = await store.incrWindow(`${key}:count`, policy.windowMs);
  if (failures >= policy.maxFailures) {
    await store.setFlag(`${key}:lock`, policy.lockMs);
  }
};

export const clearFailures = async (scope: string, value: string): Promise<void> => {
  const key = keyOf(scope, value);
  await getAuthStateStore().del([`${key}:count`, `${key}:lock`]);
};

/** Test hook: forget every in-memory counter. */
export const resetAuthThrottles = async (): Promise<void> => {
  await getAuthStateStore().clear();
};

/** The address part of the pair key; an unresolvable address shares one bucket instead of bypassing it. */
const pairValue = (identifier: string, ip: string | null): string => `${identifier.toLowerCase()}|${ip ?? "unknown"}`;

/** Applies the identifier ceiling, the identifier+IP lock and the IP throttle before the password is checked. */
export const assertLoginAllowed = async (identifier: string, ip: string | null): Promise<void> => {
  await assertNotThrottled("login-id", identifier);
  await assertNotThrottled("login-pair", pairValue(identifier, ip));
  if (ip) await assertNotThrottled("login-ip", ip);
};

export const recordLoginFailure = async (identifier: string, ip: string | null): Promise<void> => {
  await recordFailure("login-id", identifier, LOGIN_IDENTIFIER_POLICY);
  await recordFailure("login-pair", pairValue(identifier, ip), LOGIN_PAIR_POLICY);
  if (ip) await recordFailure("login-ip", ip, LOGIN_IP_POLICY);
};

export const recordLoginSuccess = async (identifier: string, ip: string | null = null): Promise<void> => {
  await clearFailures("login-id", identifier);
  await clearFailures("login-pair", pairValue(identifier, ip));
};

export const assertMfaAllowed = async (ip: string | null): Promise<void> => {
  if (ip) await assertNotThrottled("mfa-ip", ip);
};

export const recordMfaFailure = async (ip: string | null): Promise<void> => {
  if (ip) await recordFailure("mfa-ip", ip, MFA_IP_POLICY);
};
