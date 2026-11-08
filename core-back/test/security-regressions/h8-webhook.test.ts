import { describe, expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { PrismaCallbackVerifier } from "../../engine/runtime/callbackVerifier";

const SECRET = "regression-secret-not-real";
const nowSec = () => Math.floor(Date.now() / 1000);

const mkVerifier = (
  algorithm: string,
  extra: Record<string, unknown> = {},
  profileExtra: Record<string, unknown> = {},
) => {
  const channel = {
    pathToken: "ch", ipAllowlist: [], bodyFormat: "JSON", timestampSelector: "ts", timestampToleranceSec: 300,
    correlationSelector: "ref", verifyMethod: "SIGNATURE", signatureHeader: "x-signature",
    cryptoProfile: { algorithm, secretKeyEncoding: "UTF8", outputEncoding: "HEX_LOWER", canonicalizationMode: "RAW_BODY", ...profileExtra },
    eventMap: {}, mustInquire: false, ...extra,
  };
  const client = {
    confirmationChannel: { findUnique: async () => channel },
    paymentAttempt: { findFirst: async () => ({ id: "att1", env: "SANDBOX", credentialSetId: "cs" }) },
    credentialSet: { findUnique: async () => ({ entriesCiphertext: [{ key: "k", type: "SECRET", value: SECRET, isSecret: false }] }) },
  };
  return new PrismaCallbackVerifier(client as never, {} as never);
};
const hmac = (body: string) => createHmac("sha256", SECRET).update(body).digest("hex");
const sha = (body: string) => createHash("sha256").update(body).digest("hex");
const call = (v: PrismaCallbackVerifier, body: string, sig: string, headers: Record<string, string> = {}) =>
  v.verify("ch", { rawBody: Buffer.from(body), headers: { "x-signature": sig, ...headers }, sourceIp: "1.2.3.4" });

describe("H8 callbackVerifier", () => {
  test("(a) validly signed payload with NO status field is not derived as SUCCESS", async () => {
    const body = JSON.stringify({ ref: "PA-1", event: "ping", ts: nowSec() });
    const r = await call(mkVerifier("HMAC_SHA256"), body, hmac(body));
    expect(r.verified).toBe(true);
    expect((r.evidence as { status?: string }).status).not.toBe("SUCCESS");
  });

  test("(a-control) a mapped status is still honoured", async () => {
    const body = JSON.stringify({ ref: "PA-1", status: "00", ts: nowSec() });
    const r = await call(mkVerifier("HMAC_SHA256", { eventMap: { "00": "SUCCESS" } }), body, hmac(body));
    expect(r.verified).toBe(true);
    expect((r.evidence as { status?: string }).status).toBe("SUCCESS");
  });

  test("(b) unkeyed algorithm SHA256: an attacker without the secret does not verify", async () => {
    const body = JSON.stringify({ ref: "PA-1", status: "SUCCESS", amount: "100.0000", currency: "LYD", ts: nowSec() });
    const r = await call(mkVerifier("SHA256"), body, sha(body));
    expect(r.verified).toBe(false);
  });

  test("(b-control) HMAC_SHA256 with the attacker's plain sha256 is rejected, the real HMAC is accepted", async () => {
    const body = JSON.stringify({ ref: "PA-1", status: "SUCCESS", ts: nowSec() });
    expect((await call(mkVerifier("HMAC_SHA256"), body, sha(body))).verified).toBe(false);
    expect((await call(mkVerifier("HMAC_SHA256"), body, hmac(body))).verified).toBe(true);
  });

  test("(c1) a signed body without any timestamp is rejected when a tolerance is configured", async () => {
    const body = JSON.stringify({ ref: "PA-1", status: "SUCCESS" });
    const r = await call(mkVerifier("HMAC_SHA256"), body, hmac(body));
    expect(r.verified).toBe(false);
    expect(r.reason).toBe("INBOUND_TIMESTAMP_MISSING");
  });

  test("(c1-optout) tolerance 0 is the explicit opt-out of the replay window", async () => {
    const body = JSON.stringify({ ref: "PA-1", status: "SUCCESS" });
    const r = await call(mkVerifier("HMAC_SHA256", { timestampToleranceSec: 0 }), body, hmac(body));
    expect(r.verified).toBe(true);
  });

  test("(c2) an unsigned x-timestamp header cannot refresh a stale signed body (RAW_BODY)", async () => {
    const body = JSON.stringify({ ref: "PA-1", status: "SUCCESS" });
    const fresh = String(nowSec());
    const r = await call(mkVerifier("HMAC_SHA256", { timestampSelector: null }), body, hmac(body), { "x-timestamp": fresh });
    expect(r.verified).toBe(false);
  });

  test("(c2-control) a header timestamp IS honoured when the canonical string signs it", async () => {
    const verifier = mkVerifier("HMAC_SHA256", { timestampSelector: null }, { canonicalizationMode: "TIMESTAMP_DOT_RAW_BODY" });
    const body = JSON.stringify({ ref: "PA-1", status: "SUCCESS" });
    const ts = String(nowSec());
    const signed = createHmac("sha256", SECRET).update(`${Number(ts) * 1000}.${body}`).digest("hex");
    expect((await call(verifier, body, signed, { "x-timestamp": ts })).verified).toBe(true);
    const staleTs = String(nowSec() - 86400);
    const staleSigned = createHmac("sha256", SECRET).update(`${Number(staleTs) * 1000}.${body}`).digest("hex");
    expect((await call(verifier, body, staleSigned, { "x-timestamp": staleTs })).verified).toBe(false);
  });

  test("(c-control) a stale ts inside the signed body is rejected", async () => {
    const body = JSON.stringify({ ref: "PA-1", status: "SUCCESS", ts: nowSec() - 86400 });
    const r = await call(mkVerifier("HMAC_SHA256"), body, hmac(body));
    expect(r.verified).toBe(false);
    expect(r.reason).toBe("INBOUND_TIMESTAMP_OUTSIDE_WINDOW");
  });

  test("(d) static: the inbound route dedupes on VERIFIED events only and keeps unverified rows off the canonical key", () => {
    const src = readFileSync("api/internal/checkout.ts", "utf8");
    const start = src.indexOf("client.inboundEvent.findFirst(");
    const lookup = src.slice(start, src.indexOf(");", start) + 2);
    expect(lookup).toContain("verified: true");
    // The unverified row is stored under a unique pending key ...
    expect(src).toContain(":pending:${randomUUID()}");
    // ... claims the canonical key atomically before the engine side effects ...
    expect(src).toContain("let ownsCanonicalKey = false;");
    expect(src).toContain("data: { dedupeKey }");
    // ... and releases it when verification fails, so a genuine retry can win.
    expect(src).toContain("if (!verified && ownsCanonicalKey)");
    // The unverified body is size-capped.
    expect(src).toContain("rawBody.subarray(0, UNVERIFIED_BODY_STORAGE_CAP)");
  });
});
