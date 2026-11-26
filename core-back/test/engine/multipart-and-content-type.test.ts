import { describe, expect, test } from "bun:test";
import { ApiConsumer } from "../../engine/apiConsumer/ApiConsumer";
import { toMimeContentType } from "../../engine/runtime/flowProvider";

/**
 * Regression: the seeded OTP-pull rail of Edfali sends `multipart/form-data`. Two defects made every such
 * request arrive EMPTY at the gateway:
 *
 *  1. `flowProvider` passed the Prisma `ContentType` enum name (`MULTIPART_FORM_DATA`) to the StepExecutor,
 *     which selects the body builder by MIME substring (`multipart`), so the form was never built.
 *  2. `ApiConsumer` spread the request body (`{ ...body }`) and JSON-stringified whatever was not a string,
 *     which turns a `FormData` into `{}`.
 *
 * Fake Rails therefore saw no amount and no reference, invented its own, and the engine's trusted-success
 * check (response reference must equal the attempt reference) failed with TRUSTED_SUCCESS_FACTS_FAILED.
 */
describe("content type mapping at the flow provider boundary", () => {
  test("maps every ContentType enum name to the MIME string the StepExecutor matches on", () => {
    expect(toMimeContentType("APPLICATION_JSON")).toBe("application/json");
    expect(toMimeContentType("APPLICATION_FORM_URLENCODED")).toBe("application/x-www-form-urlencoded");
    expect(toMimeContentType("MULTIPART_FORM_DATA")).toBe("multipart/form-data");
    expect(toMimeContentType("APPLICATION_XML")).toBe("application/xml");
    expect(toMimeContentType("TEXT_XML")).toBe("text/xml");
    expect(toMimeContentType("TEXT_PLAIN")).toBe("text/plain");
  });

  test("keeps a value that already is a MIME string and leaves absent values undefined", () => {
    expect(toMimeContentType("multipart/form-data")).toBe("multipart/form-data");
    expect(toMimeContentType(undefined)).toBeUndefined();
    expect(toMimeContentType(null)).toBeUndefined();
  });

  test("the mapped values contain the substrings the StepExecutor tests for", () => {
    expect(toMimeContentType("MULTIPART_FORM_DATA")).toContain("multipart");
    expect(toMimeContentType("APPLICATION_FORM_URLENCODED")).toContain("x-www-form-urlencoded");
    expect(toMimeContentType("APPLICATION_JSON")).toContain("json");
    expect(toMimeContentType("APPLICATION_XML")).toContain("xml");
  });
});

describe("ApiConsumer multipart bodies", () => {
  const consumerWith = (capture: { body?: unknown; headers?: Headers }) =>
    new ApiConsumer({
      gatewayId: "gw-1",
      env: "SANDBOX",
      credentialSetId: "cs-1",
      allowedHosts: ["gateway.example.com"],
      auth: { method: "NONE" as const },
      dnsLookup: async () => ["93.184.216.34"],
      fetch: (async (_url: string, init: RequestInit) => {
        capture.body = init.body;
        capture.headers = new Headers(init.headers);
        return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch,
    });

  test("a FormData body reaches fetch intact (not spread into {} or JSON-stringified)", async () => {
    const capture: { body?: unknown; headers?: Headers } = {};
    const form = new FormData();
    form.append("amount", "25.00");
    form.append("invoice_no", "PA-REF-1");

    await consumerWith(capture).request({
      method: "POST",
      url: "https://gateway.example.com/verify",
      body: form,
      // the StepExecutor may have set a boundary-less content type; fetch must be left to set it
      headers: { "content-type": "multipart/form-data" },
    });

    expect(capture.body).toBeInstanceOf(FormData);
    const received = capture.body as FormData;
    expect(received.get("amount")).toBe("25.00");
    expect(received.get("invoice_no")).toBe("PA-REF-1");
    // a stale boundary-less header would make the gateway ignore the body
    expect(capture.headers?.get("content-type")).toBeNull();
  });

  test("plain object bodies are still sent as JSON", async () => {
    const capture: { body?: unknown; headers?: Headers } = {};
    await consumerWith(capture).request({
      method: "POST",
      url: "https://gateway.example.com/verify",
      body: { amount: "25.00" },
    });
    expect(capture.body).toBe(JSON.stringify({ amount: "25.00" }));
    expect(capture.headers?.get("content-type")).toBe("application/json");
  });
});
