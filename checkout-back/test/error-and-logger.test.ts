import { describe, expect, test } from "bun:test";
import { ApiError, isApiError, parseOrThrow } from "../lib/error";
import { redactSecrets } from "../lib/requestLogger";
import { z } from "zod";

describe("api error envelope", () => {
  test("serializes the stable platform envelope", () => {
    const error = new ApiError(400, "VALIDATION_FAILED", "Request payload failed validation", [
      { path: ["railCode"], message: "required" },
    ]);
    expect(isApiError(error)).toBe(true);
    expect(error.toEnvelope()).toEqual({
      code: "VALIDATION_FAILED",
      message: "Request payload failed validation",
      details: [{ path: ["railCode"], message: "required" }],
    });
  });

  test("keeps the reference when the core supplies one", () => {
    const error = new ApiError(409, "SLOT_EXHAUSTED", "no slot", undefined, "ref-1");
    expect(error.toEnvelope()).toEqual({
      code: "SLOT_EXHAUSTED",
      message: "no slot",
      reference: "ref-1",
    });
  });

  test("rejects unrelated errors", () => {
    expect(isApiError(new Error("boom"))).toBe(false);
    expect(isApiError(null)).toBe(false);
  });
});

describe("parseOrThrow", () => {
  test("returns the parsed payload", () => {
    const schema = z.object({ railCode: z.string().min(1) }).strict();
    expect(parseOrThrow(schema, { railCode: "MOAMALAT" })).toEqual({ railCode: "MOAMALAT" });
  });

  test("throws a 400 api error with the issue list", () => {
    const schema = z.object({ railCode: z.string().min(1) }).strict();
    try {
      parseOrThrow(schema, { railCode: "" });
      throw new Error("expected a validation failure");
    } catch (error) {
      expect(isApiError(error)).toBe(true);
      expect((error as ApiError).statusCode).toBe(400);
      expect((error as ApiError).code).toBe("VALIDATION_FAILED");
      expect(Array.isArray((error as ApiError).details)).toBe(true);
    }
  });
});

describe("request logger redaction", () => {
  test("masks secret fields at any depth", () => {
    const redacted = redactSecrets({
      email: "merchant@example.com",
      password: "super-secret",
      nested: { token: "pg_live_1", authorization: "Bearer abc", otp: "1234" },
      list: [{ apiKey: "key-1" }],
    }) as Record<string, unknown>;
    expect(redacted.email).toBe("merchant@example.com");
    expect(redacted.password).toBe("[REDACTED]");
    const nested = redacted.nested as Record<string, unknown>;
    expect(nested.token).toBe("[REDACTED]");
    expect(nested.authorization).toBe("[REDACTED]");
    expect(nested.otp).toBe("[REDACTED]");
    const list = redacted.list as Record<string, unknown>[];
    expect(list[0]?.apiKey).toBe("[REDACTED]");
  });

  test("truncates long values", () => {
    const redacted = redactSecrets({ note: "x".repeat(400) }) as Record<string, string>;
    expect(redacted.note?.length).toBeLessThan(400);
    expect(redacted.note).toContain("[truncated]");
  });
});
