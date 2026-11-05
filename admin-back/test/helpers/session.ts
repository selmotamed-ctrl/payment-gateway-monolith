import { createHmac } from "node:crypto";

/**
 * Mints an administrative session token exactly the way core does
 * (`core-back/lib/auth/index.ts` -> `signSession`): HS256 over a jwt whose payload
 * carries `sub`, `typ`, `role`, `merchantId`, `authorities`, `appScopeIds` and `mfa`,
 * signed with the session issuer/audience.
 *
 * The edge cannot verify the signature (core owns the key), it only decodes the claims,
 * so the test key is irrelevant: what matters is the claim shape.
 */
const SESSION_ISSUER = "payment-gateway-core";
const SESSION_AUDIENCE = "payment-gateway-admin";
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const SESSION_SIGNING_KEY = "admin-back-test-session-key";

const base64url = (value: string | Buffer): string => Buffer.from(value).toString("base64url");

export interface SessionClaims {
  sub: string;
  role: string;
  merchantId?: string | null;
  authorities?: string[];
  appScopeIds?: string[];
  mfa?: boolean;
  typ?: string;
  iss?: string;
  aud?: string | string[];
}

export const signSession = (
  claims: SessionClaims,
  options: { issuedAt?: number; key?: string } = {},
): string => {
  const issuedAt = options.issuedAt ?? Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    sub: claims.sub,
    typ: claims.typ ?? "session",
    role: claims.role,
    merchantId: claims.merchantId ?? null,
    authorities: claims.authorities ?? [],
    appScopeIds: claims.appScopeIds ?? [],
    mfa: claims.mfa ?? false,
    iss: claims.iss ?? SESSION_ISSUER,
    aud: claims.aud ?? SESSION_AUDIENCE,
    iat: issuedAt,
    exp: issuedAt + SESSION_TTL_SECONDS,
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = createHmac("sha256", options.key ?? SESSION_SIGNING_KEY)
    .update(signingInput)
    .digest();
  return `${signingInput}.${base64url(signature)}`;
};

export const complianceToken = (): string =>
  signSession({
    sub: "u-compliance",
    role: "COMPLIANCE",
    authorities: ["aml:read", "aml:write", "kyb:read", "kyb:write", "compliance:read"],
  });

export const mlroToken = (): string =>
  signSession({
    sub: "u-mlro",
    role: "MLRO",
    authorities: ["aml:read", "aml:write"],
  });

/**
 * An operations user with broad back office authorities. It deliberately carries NO
 * `aml:*` and NO `security:*` authority, so the confidential and the backup write routes
 * stay closed for it.
 */
export const OPERATOR_AUTHORITIES = [
  "merchant:read",
  "merchant:write",
  "gateway:read",
  "gateway:write",
  "gateway:test",
  "credential:read",
  "credential:write",
  "user:read",
  "user:write",
  "kyb:read",
  "kyb:write",
  "approval:read",
  "approval:check",
  "approval:write",
  "case:read",
  "case:write",
  "operator:read",
  "operator:write",
  "attempt:read",
  "attempt:inquire",
  "dispute:read",
  "dispute:write",
  "finance:read",
  "finance:write",
  "cashout:read",
  "cashout:review",
  "commission:read",
  "commission:write",
  "velocity:read",
  "velocity:write",
  "reconciliation:read",
  "reconciliation:write",
  "settings:read",
  "settings:write",
];

/** Every non confidential back office authority plus the security ones (a full staff session). */
export const fullStaffToken = (): string =>
  signSession({
    sub: "u-full-staff",
    role: "SECURITY_ADMIN",
    authorities: [...OPERATOR_AUTHORITIES, "security:read", "security:write", "aml:read", "aml:write", "compliance:read", "compliance:write"],
  });

export const operatorToken = (): string =>
  signSession({
    sub: "u-operator",
    role: "OPERATOR",
    authorities: OPERATOR_AUTHORITIES,
  });

/** A session that only carries the aml authority, without a confidential role. */
export const amlAuthorityToken = (): string =>
  signSession({
    sub: "u-aml-authority",
    role: "SUPPORT",
    authorities: ["aml:read"],
  });
