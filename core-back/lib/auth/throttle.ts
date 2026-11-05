import { createHash } from "node:crypto";
import { ApiError } from "../error";

/**
 * In-process failure throttles for login and MFA verification.
 *
 * Counters live in the memory of one core-back process (core runs behind the
 * edges on a private mTLS channel). The durable, multi-instance protection of
 * the MFA code itself is the attempt counter stored on `mfa_challenges`; this
 * module adds per-identifier and per-IP back-pressure on top of it. Keys are
 * hashed so an identifier (phone or email) is never kept in clear in memory.
 */
interface Bucket {
  failures: number;
  windowStart: number;
  lockedUntil: number;
}

export interface ThrottlePolicy {
  maxFailures: number;
  windowMs: number;
  lockMs: number;
}

export const LOGIN_IDENTIFIER_POLICY: ThrottlePolicy = { maxFailures: 5, windowMs: 15 * 60_000, lockMs: 15 * 60_000 };
export const LOGIN_IP_POLICY: ThrottlePolicy = { maxFailures: 30, windowMs: 15 * 60_000, lockMs: 15 * 60_000 };
export const MFA_IP_POLICY: ThrottlePolicy = { maxFailures: 20, windowMs: 15 * 60_000, lockMs: 15 * 60_000 };

const MAX_BUCKETS = 20_000;
const buckets = new Map<string, Bucket>();

const keyOf = (scope: string, value: string): string =>
  `${scope}:${createHash("sha256").update(value.toLowerCase(), "utf8").digest("hex")}`;

const prune = (now: number): void => {
  if (buckets.size < MAX_BUCKETS) return;
  for (const [key, bucket] of buckets) {
    if (bucket.lockedUntil <= now && now - bucket.windowStart > 15 * 60_000) buckets.delete(key);
  }
  if (buckets.size >= MAX_BUCKETS) {
    // Under a key flood, drop the oldest half rather than grow without bound.
    let toDrop = Math.floor(buckets.size / 2);
    for (const key of buckets.keys()) {
      if (toDrop-- <= 0) break;
      buckets.delete(key);
    }
  }
};

export const assertNotThrottled = (scope: string, value: string, now = Date.now()): void => {
  const bucket = buckets.get(keyOf(scope, value));
  if (bucket && bucket.lockedUntil > now) {
    throw new ApiError(429, "AUTH_THROTTLED", "Too many failed attempts. Try again later", {
      retryAfterSeconds: Math.ceil((bucket.lockedUntil - now) / 1000),
    });
  }
};

export const recordFailure = (scope: string, value: string, policy: ThrottlePolicy, now = Date.now()): void => {
  prune(now);
  const key = keyOf(scope, value);
  let bucket = buckets.get(key);
  if (!bucket || now - bucket.windowStart > policy.windowMs) {
    bucket = { failures: 0, windowStart: now, lockedUntil: 0 };
    buckets.set(key, bucket);
  }
  bucket.failures += 1;
  if (bucket.failures >= policy.maxFailures) {
    bucket.lockedUntil = now + policy.lockMs;
  }
};

export const clearFailures = (scope: string, value: string): void => {
  buckets.delete(keyOf(scope, value));
};

/** Test hook: forget every counter. */
export const resetAuthThrottles = (): void => {
  buckets.clear();
};

/** Applies the identifier and IP login throttles before the password is checked. */
export const assertLoginAllowed = (identifier: string, ip: string | null): void => {
  assertNotThrottled("login-id", identifier);
  if (ip) assertNotThrottled("login-ip", ip);
};

export const recordLoginFailure = (identifier: string, ip: string | null): void => {
  recordFailure("login-id", identifier, LOGIN_IDENTIFIER_POLICY);
  if (ip) recordFailure("login-ip", ip, LOGIN_IP_POLICY);
};

export const recordLoginSuccess = (identifier: string): void => {
  clearFailures("login-id", identifier);
};

export const assertMfaAllowed = (ip: string | null): void => {
  if (ip) assertNotThrottled("mfa-ip", ip);
};

export const recordMfaFailure = (ip: string | null): void => {
  if (ip) recordFailure("mfa-ip", ip, MFA_IP_POLICY);
};
