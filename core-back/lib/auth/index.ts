import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { compare, hash } from "bcryptjs";
import { sign, verify, type JwtPayload, type SignOptions } from "jsonwebtoken";
import { env } from "../env";

const SESSION_ISSUER = "payment-gateway-core";
const SESSION_AUDIENCE = "payment-gateway-edge";
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

export const signSession = (claims: Omit<SessionClaims, "typ">): string =>
  sign(
    { ...claims, typ: "session" },
    sessionKey,
    {
      algorithm: "HS256",
      issuer: SESSION_ISSUER,
      audience: SESSION_AUDIENCE,
      expiresIn: SESSION_TTL_SECONDS,
    } satisfies SignOptions,
  );

export const verifySessionToken = (token: string): SessionClaims => {
  const payload = verify(token, sessionKey, {
    algorithms: ["HS256"],
    issuer: SESSION_ISSUER,
    audience: SESSION_AUDIENCE,
  }) as JwtPayload;
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
