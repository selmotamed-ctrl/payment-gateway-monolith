import { createHmac, timingSafeEqual } from "node:crypto";

export interface JwtPayload {
  sub: string;
  role: string;
  iat: number;
  exp: number;
  [key: string]: unknown;
}

const b64url = (value: Buffer | string): string =>
  Buffer.from(value).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

const fromB64url = (value: string): Buffer =>
  Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");

const signatureFor = (data: string, secret: string): Buffer =>
  createHmac("sha256", secret).update(data).digest();

export const signJwt = (
  payload: Omit<JwtPayload, "iat" | "exp"> & { expiresInSeconds?: number },
  secret: string,
): string => {
  const now = Math.floor(Date.now() / 1000);
  const { expiresInSeconds = 12 * 3600, ...claims } = payload;
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ ...claims, iat: now, exp: now + expiresInSeconds }));
  const data = `${header}.${body}`;
  return `${data}.${b64url(signatureFor(data, secret))}`;
};

export const verifyJwt = (token: string, secret: string): JwtPayload | null => {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts as [string, string, string];
  const expected = signatureFor(`${header}.${body}`, secret);
  const provided = fromB64url(signature);
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) return null;
  try {
    const payload = JSON.parse(fromB64url(body).toString("utf8")) as JwtPayload;
    if (typeof payload.exp !== "number" || payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
};
