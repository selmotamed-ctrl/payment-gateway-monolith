import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import express, { type Request, type Response } from "express";
import { adminInternalRouter } from "../api/internal/admin";
import { checkoutInternalRouter } from "../api/internal/checkout";
import { merchantInternalRouter } from "../api/internal/merchant";
import { isApiError, toErrorEnvelope } from "../lib/error";

const app = express();
app.use(express.json());
app.use("/internal/admin", adminInternalRouter);
app.use("/internal/merchant", merchantInternalRouter);
app.use("/internal/checkout", checkoutInternalRouter);
app.use((error: unknown, _request: Request, response: Response, _next: unknown) => {
  response.status(isApiError(error) ? error.statusCode : 500).json(toErrorEnvelope(error));
});

let server: ReturnType<typeof app.listen>;
let baseUrl = "";

const call = async (path: string, init: RequestInit = {}): Promise<{ status: number; body: Record<string, unknown> }> => {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    body = { raw: text };
  }
  return { status: response.status, body };
};

beforeAll(() => {
  server = app.listen(0);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server.close();
});

describe("core internal channel routers", () => {
  test("each channel exposes a health probe", async () => {
    for (const channel of ["admin", "merchant", "checkout"]) {
      const response = await call(`/internal/${channel}/health`);
      expect(response.status).toBe(200);
      expect(response.body.channel).toBe(channel);
    }
  });

  test("protected admin routes refuse an unauthenticated caller", async () => {
    const response = await call("/internal/admin/aml/cases");
    expect(response.status).toBe(401);
    expect(response.body.code).toBe("AUTH_REQUIRED");
  });

  test("protected merchant routes refuse an unauthenticated caller", async () => {
    const response = await call("/internal/merchant/links");
    expect(response.status).toBe(401);
    expect(response.body.code).toBe("AUTH_REQUIRED");
  });

  test("the admin login route validates its payload", async () => {
    const response = await call("/internal/admin/auth/login", {
      method: "POST",
      body: JSON.stringify({ identifier: "" }),
    });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe("INVALID_BODY");
  });

  test("the merchant register route validates its payload", async () => {
    const response = await call("/internal/merchant/auth/register", {
      method: "POST",
      body: JSON.stringify({ password: "short" }),
    });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe("INVALID_BODY");
  });

  test("the checkout initiate route rejects a client supplied amount or currency", async () => {
    for (const payload of [
      { railCode: "edfali", formData: {}, idempotencyKey: "idem-0001", amount: "1.0000" },
      { railCode: "edfali", formData: {}, idempotencyKey: "idem-0002", currency: "LYD" },
    ]) {
      const response = await call("/internal/checkout/pay/LINKKEY123/initiate", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      expect(response.status).toBe(400);
      expect(response.body.code).toBe("INVALID_BODY");
    }
  });

  test("the checkout confirm route rejects a client supplied amount", async () => {
    const response = await call("/internal/checkout/pay/LINKKEY123/logs/attempt-1/confirm", {
      method: "POST",
      body: JSON.stringify({ otp: "1234", idempotencyKey: "idem-0003", amount: "1.0000" }),
    });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe("INVALID_BODY");
  });

  test("the inbound webhook route requires a registered channel token", async () => {
    const response = await call("/internal/checkout/inbound/moamalat/live/unknown-token", {
      method: "POST",
      body: JSON.stringify({ ActionCode: "00" }),
    });
    expect([404, 401, 500]).toContain(response.status);
  });
});
