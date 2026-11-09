/**
 * `GET|POST /return/:attemptToken` is unauthenticated. It must only accept OUR attempt reference and must not
 * call the gateway more than once per attempt per cooldown, whoever hits it. Real PostgreSQL 18 test database
 * (skipped when unreachable); the engine's `inquire` is replaced by a counter.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import express, { type Request, type Response } from "express";
import { Prisma } from "../generated/prisma/client";
import { client } from "../prisma/client";
import { checkoutInternalRouter } from "../api/internal/checkout";
import { getPlatformRuntime } from "../engine/runtime";
import { MemoryAuthStateStore, setAuthStateStore } from "../lib/auth/sharedState";
import { isApiError, toErrorEnvelope } from "../lib/error";

const DATABASE_URL = process.env.POSTGRES_TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
process.env.DATABASE_URL = DATABASE_URL;
const RUN = randomUUID().replace(/-/g, "").slice(0, 10);

const reachable = await (async (): Promise<boolean> => {
  try {
    if (!/test/i.test(new URL(DATABASE_URL).pathname.replace(/^\//, ""))) return false;
    await client.$queryRawUnsafe("SELECT 1 AS ok");
    return true;
  } catch {
    return false;
  }
})();

const app = express();
app.use(express.json());
app.use("/internal/checkout", checkoutInternalRouter);
app.use((error: unknown, _request: Request, response: Response, _next: unknown) => {
  response.status(isApiError(error) ? error.statusCode : 500).json(toErrorEnvelope(error));
});
let server: ReturnType<typeof app.listen>;
let base = "";
let inquiries: string[] = [];
let originalInquire: (attempt: { id: string }) => Promise<unknown>;

const attemptWithRefs = async (reference: string, gatewayReference: string): Promise<string> => {
  const id = randomUUID();
  await client.$transaction(async (tx) => {
    // Arbitrary foreign keys: the FK triggers are disabled for this transaction only.
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
    await tx.paymentAttempt.create({
      data: {
        id, reference, gatewayReference, linkId: randomUUID(), attemptGroupId: randomUUID(), applicationId: randomUUID(),
        merchantId: randomUUID(), railId: randomUUID(), routeId: randomUUID(), credentialSetId: randomUUID(),
        gatewayVersionId: randomUUID(), commissionProfileId: randomUUID(), env: "LIVE", mode: "OTP_PULL",
        status: "AWAITING_CUSTOMER", requestedAmount: new Prisma.Decimal("10.0000"),
        totalChargedAmount: new Prisma.Decimal("10.0000"), feeBearer: "MERCHANT_ABSORBS", currency: "LYD",
        customerFieldsMasked: {}, contextCiphertext: "x", expiresAt: new Date(Date.now() + 3_600_000),
        graceExpiresAt: new Date(Date.now() + 7_200_000),
      },
    });
  });
  return id;
};

const ret = async (token: string, method: "GET" | "POST" = "GET") => {
  const response = await fetch(`${base}/internal/checkout/return/${token}`, { method });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
};

beforeAll(() => {
  if (!reachable) return;
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const platform = getPlatformRuntime(client as never);
  originalInquire = platform.engine.inquire.bind(platform.engine) as never;
  platform.engine.inquire = (async (attempt: { id: string }) => {
    inquiries.push(attempt.id);
    return { status: "VERIFYING" };
  }) as never;
});

beforeEach(() => {
  inquiries = [];
  if (reachable) setAuthStateStore(new MemoryAuthStateStore());
});

afterAll(() => {
  if (reachable) getPlatformRuntime(client as never).engine.inquire = originalInquire as never;
  server?.close();
});

describe.skipIf(!reachable)("the browser return route", () => {
  test("only our attempt reference is a token; the provider's reference is not", async () => {
    const reference = `PA-RET-${RUN}-a`;
    const gatewayReference = `GW-${RUN}-a`;
    const id = await attemptWithRefs(reference, gatewayReference);
    expect((await ret(gatewayReference)).status).toBe(404);
    expect((await ret("PA-UNKNOWN-0000")).status).toBe(404);
    expect(inquiries).toEqual([]);

    const ok = await ret(reference);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ attemptId: id, reference, redirect: `/pay/${reference}/status` });
  });

  test("repeated hits inside the cooldown call the gateway once, from GET and POST alike", async () => {
    const reference = `PA-RET-${RUN}-b`;
    const id = await attemptWithRefs(reference, `GW-${RUN}-b`);
    for (const method of ["GET", "POST", "GET", "POST", "GET"] as const) {
      const response = await ret(reference, method);
      expect(response.status).toBe(200);
      expect(response.body.reference).toBe(reference);
    }
    expect(inquiries).toEqual([id]);
  });

  test("the cooldown is per attempt, and it expires", async () => {
    const first = await attemptWithRefs(`PA-RET-${RUN}-c`, `GW-${RUN}-c`);
    const second = await attemptWithRefs(`PA-RET-${RUN}-d`, `GW-${RUN}-d`);
    await ret(`PA-RET-${RUN}-c`);
    await ret(`PA-RET-${RUN}-d`);
    expect(inquiries.sort()).toEqual([first, second].sort());

    // Once the window has passed the next hit inquires again.
    setAuthStateStore(new MemoryAuthStateStore());
    await ret(`PA-RET-${RUN}-c`);
    expect(inquiries.filter((attemptId) => attemptId === first)).toHaveLength(2);
  });
});
