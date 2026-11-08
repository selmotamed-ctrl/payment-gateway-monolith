import { createHmac } from "node:crypto";

/**
 * A credential SHAPED like a live merchant session (HS256, `typ: session`, merchant audience, unexpired).
 * The edge only checks the shape before it buffers an upload; core verifies the signature, so any secret does.
 */
export const merchantSessionJwt = (overrides: Record<string, unknown> = {}, header: Record<string, unknown> = { alg: "HS256", typ: "JWT" }): string => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const payload = {
    typ: "session",
    iss: "payment-gateway-core",
    aud: "payment-gateway-merchant",
    sub: "00000000-0000-4000-8000-000000000001",
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
  const signingInput = `${encode(header)}.${encode(payload)}`;
  return `${signingInput}.${createHmac("sha256", "test-secret").update(signingInput).digest("base64url")}`;
};

/** The bearer header the upload tests send. */
export const SESSION_BEARER = `Bearer ${merchantSessionJwt()}`;
