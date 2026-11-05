import { createHash, createHmac, hkdfSync, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { compare, hash } from "bcryptjs";
import { sign, verify, type JwtPayload, type SignOptions } from "jsonwebtoken";
import { env } from "../env";

const SESSION_ISSUER = "payment-gateway-core";
/**
 * Distinct JWT audience per channel (GAP-020): a token minted for one edge is refused by
 * the others, and core only accepts the channel audiences (the old shared
 * `payment-gateway-edge` audience is no longer valid).
 */
export type SessionChannel = "admin" | "merchant" | "checkout";
export const SESSION_AUDIENCES: Record<SessionChannel, string> = {
  admin: "payment-gateway-admin",
  merchant: "payment-gateway-merchant",
  checkout: "payment-gateway-checkout",
};
const ALL_SESSION_AUDIENCES = Object.values(SESSION_AUDIENCES);
const SESSION_TTL_SECONDS = 12 * 60 * 60;

const deriveKey = (purpose: string): Buffer =>
  Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(env.KMS_MASTER_KEY, "utf8"),
      Buffer.from("payment-gateway-core", "utf8"),
      Buffer.from(purpose, "utf8"),
      32,
    ),
  );

const sessionKey = deriveKey("session-signing");
const mfaKey = deriveKey("mfa-challenge");

export interface SessionClaims {
  sub: string;
  typ: "session";
  role: string;
  merchantId: string | null;
  authorities: string[];
  appScopeIds: string[];
  mfa: boolean;
  /** Unique session id, the handle of the server-side revoke list. */
  jti: string | null;
  /** Expiry as epoch seconds. */
  exp: number | null;
  /** Channel the token was minted for (derived from the audience). */
  channel: SessionChannel | null;
}

export const hashPassword = async (plaintext: string): Promise<string> => hash(plaintext, 12);

export const verifyPassword = async (plaintext: string, passwordHash: string): Promise<boolean> => {
  try {
    return await compare(plaintext, passwordHash);
  } catch {
    return false;
  }
};

let dummyPasswordHash: Promise<string> | undefined;

/**
 * Verifies a password in constant time with respect to account existence: an
 * unknown user (or one without a password) is compared against a throwaway
 * bcrypt hash so the response time does not reveal whether the account exists.
 */
export const verifyPasswordOrDummy = async (
  plaintext: string,
  passwordHash: string | null | undefined,
): Promise<boolean> => {
  if (!passwordHash) {
    dummyPasswordHash ??= hash(randomBytes(16).toString("hex"), 12);
    await compare(plaintext, await dummyPasswordHash);
    return false;
  }
  return verifyPassword(plaintext, passwordHash);
};

export const hashAccessToken = (token: string): string =>
  createHash("sha256").update(token, "utf8").digest("hex");

export const generateAccessToken = (): string => `pg_live_${randomBytes(32).toString("base64url")}`;

export const hashMfaCode = (userId: string, code: string): string =>
  createHmac("sha256", mfaKey).update(`${userId}:${code}`, "utf8").digest("hex");

export const generateMfaCode = (): string => {
  const value = randomBytes(4).readUInt32BE(0) % 1_000_000;
  return value.toString().padStart(6, "0");
};

export const signSession = (
  claims: Omit<SessionClaims, "typ" | "jti" | "exp" | "channel">,
  channel: SessionChannel,
): string =>
  sign(
    { ...claims, typ: "session" },
    sessionKey,
    {
      algorithm: "HS256",
      issuer: SESSION_ISSUER,
      audience: SESSION_AUDIENCES[channel],
      expiresIn: SESSION_TTL_SECONDS,
      jwtid: randomUUID(),
    } satisfies SignOptions,
  );

/** Verifies a session token; with `channel` the audience must be exactly that channel's. */
export const verifySessionToken = (token: string, channel?: SessionChannel): SessionClaims => {
  const payload = verify(token, sessionKey, {
    algorithms: ["HS256"],
    issuer: SESSION_ISSUER,
    audience: channel ? SESSION_AUDIENCES[channel] : (ALL_SESSION_AUDIENCES as [string, ...string[]]),
  }) as JwtPayload;
  const audience = Array.isArray(payload.aud) ? payload.aud[0] : payload.aud;
  const tokenChannel = (Object.keys(SESSION_AUDIENCES) as SessionChannel[]).find(
    (name) => SESSION_AUDIENCES[name] === audience,
  ) ?? null;
  if (payload.typ !== "session" || typeof payload.sub !== "string") {
    throw new Error("Session token payload is invalid");
  }
  return {
    sub: payload.sub,
    typ: "session",
    role: typeof payload.role === "string" ? payload.role : "SUPPORT",
    merchantId: typeof payload.merchantId === "string" ? payload.merchantId : null,
    authorities: Array.isArray(payload.authorities) ? payload.authorities.map(String) : [],
    appScopeIds: Array.isArray(payload.appScopeIds) ? payload.appScopeIds.map(String) : [],
    mfa: payload.mfa === true,
    jti: typeof payload.jti === "string" ? payload.jti : null,
    exp: typeof payload.exp === "number" ? payload.exp : null,
    channel: tokenChannel,
  };
};

export const constantTimeEqual = (left: string, right: string): boolean => {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
};
