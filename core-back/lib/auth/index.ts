import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { compare, hash } from "bcryptjs";
import { sign, verify, type JwtPayload, type SignOptions } from "jsonwebtoken";
import { env } from "../env";

const SESSION_ISSUER = "payment-gateway-core";
const SESSION_AUDIENCE = "payment-gateway-edge";
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const MFA_CHALLENGE_TTL_SECONDS = 10 * 60;

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

export interface MfaChallengeClaims {
  sub: string;
  typ: "mfa";
  codeHash: string;
  role: string;
  merchantId: string | null;
}

export const hashPassword = async (plaintext: string): Promise<string> => hash(plaintext, 12);

export const verifyPassword = async (plaintext: string, passwordHash: string): Promise<boolean> => {
  try {
    return await compare(plaintext, passwordHash);
  } catch {
    return false;
  }
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

export const signMfaChallenge = (input: {
  userId: string;
  code: string;
  role: string;
  merchantId: string | null;
}): string =>
  sign(
    {
      sub: input.userId,
      typ: "mfa",
      codeHash: hashMfaCode(input.userId, input.code),
      role: input.role,
      merchantId: input.merchantId,
    },
    mfaKey,
    {
      algorithm: "HS256",
      issuer: SESSION_ISSUER,
      audience: SESSION_AUDIENCE,
      expiresIn: MFA_CHALLENGE_TTL_SECONDS,
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

export const verifyMfaChallengeToken = (token: string): MfaChallengeClaims => {
  const payload = verify(token, mfaKey, {
    algorithms: ["HS256"],
    issuer: SESSION_ISSUER,
    audience: SESSION_AUDIENCE,
  }) as JwtPayload;
  if (payload.typ !== "mfa" || typeof payload.sub !== "string" || typeof payload.codeHash !== "string") {
    throw new Error("MFA challenge payload is invalid");
  }
  return {
    sub: payload.sub,
    typ: "mfa",
    codeHash: payload.codeHash,
    role: typeof payload.role === "string" ? payload.role : "SUPPORT",
    merchantId: typeof payload.merchantId === "string" ? payload.merchantId : null,
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
