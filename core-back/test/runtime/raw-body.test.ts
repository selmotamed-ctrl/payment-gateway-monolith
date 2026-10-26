import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import express, { type Request, type Response } from "express";
import { rawBodyMiddleware } from "../../lib/rawBody";

const app = express();
app.use(rawBodyMiddleware);
app.use(express.json({ limit: "1mb" }));
app.post("/internal/checkout/inbound/:gateway/:env/:pathToken", (request: Request, response: Response) => {
  response.json({
    isBuffer: Buffer.isBuffer(request.body),
    length: Buffer.isBuffer(request.body) ? request.body.byteLength : 0,
    hex: Buffer.isBuffer(request.body) ? request.body.toString("hex") : "",
  });
});
app.post("/internal/other", (request: Request, response: Response) => {
  response.json({ isBuffer: Buffer.isBuffer(request.body), body: request.body });
});

let server: ReturnType<typeof app.listen>;
let baseUrl = "";

beforeAll(() => {
  server = app.listen(0);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server.close();
});

describe("core raw body capture", () => {
  test("preserves the exact bytes of an inbound gateway webhook", async () => {
    const payload = Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x7b, 0x22, 0x61, 0x22, 0x3a, 0x31, 0x7d]);
    const response = await fetch(`${baseUrl}/internal/checkout/inbound/moamalat/LIVE/token-abc`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: payload,
    });
    const body = (await response.json()) as { isBuffer: boolean; length: number; hex: string };
    expect(body.isBuffer).toBe(true);
    expect(body.length).toBe(payload.byteLength);
    expect(body.hex).toBe(payload.toString("hex"));
  });

  test("preserves a signed JSON webhook byte for byte", async () => {
    const payload = '{"reference":"PA-1","amount":"100.0000"}\n';
    const response = await fetch(`${baseUrl}/internal/checkout/inbound/moamalat/LIVE/token-abc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    });
    const body = (await response.json()) as { isBuffer: boolean; hex: string };
    expect(body.isBuffer).toBe(true);
    expect(Buffer.from(body.hex, "hex").toString("utf8")).toBe(payload);
  });

  test("still parses ordinary JSON routes", async () => {
    const response = await fetch(`${baseUrl}/internal/other`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    });
    const body = (await response.json()) as { isBuffer: boolean; body: Record<string, unknown> };
    expect(body.isBuffer).toBe(false);
    expect(body.body).toEqual({ hello: "world" });
  });
});
