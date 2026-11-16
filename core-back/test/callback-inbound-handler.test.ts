import { describe, expect, test } from "bun:test";
import { ApiError } from "../lib/error";
import {
  createCallbackInboundHandler,
  inboundRouteFailureOutcome,
  isTransientCallbackFailure,
  type CallbackInboundHandlerDeps,
} from "../engine/workers/callbackInboundHandler";
import { InboundInboxWorker, RetryableInboundError, type InboundEventRow } from "../engine/workers/InboundInboxWorker";
import { createFakeRepositories } from "./helpers/fakeRepositories";
import { createRecordingDb } from "./edge-cases/helpers";

/**
 * Regression: the production callback handler swallowed every error from callback verification
 * as `{ processed: false }`, which the inbox records as SKIPPED and never retries. A database blip
 * while a "payment succeeded" webhook was handled therefore dropped the confirmation for good.
 * Only a definitive rejection may be skipped; anything else must be retried.
 */

const coded = (code: string, statusCode: number): Error =>
  Object.assign(new Error(`${code} happened`), { code, statusCode });

/** Shaped like Prisma's errors: a `P####` code and no HTTP status. */
const prismaUnreachable = (): Error =>
  Object.assign(new Error("Can't reach database server at 127.0.0.1:5432"), {
    name: "PrismaClientKnownRequestError",
    code: "P1001",
  });

const event = (overrides: Partial<InboundEventRow> = {}): InboundEventRow => ({
  id: "event-1",
  channelId: "channel-1",
  gatewayId: "gateway-1",
  env: "TEST",
  rawBodyBytes: Buffer.from("{}"),
  redactedHeadersJson: { "x-signature": "abc" },
  sourceIp: "203.0.113.5",
  verified: true,
  verificationError: null,
  dedupeKey: "dedupe-1",
  attemptId: "attempt-1",
  receivedAt: new Date("2026-06-01T00:00:00.000Z"),
  processedAt: null,
  processingResult: null,
  ...overrides,
});

const deps = (overrides: Partial<CallbackInboundHandlerDeps> = {}): CallbackInboundHandlerDeps => ({
  findChannelPathToken: async () => "path-token",
  verifyCallback: async () => ({ status: "SUCCEEDED" }),
  toBuffer: (value) => Buffer.from(value as Buffer),
  ...overrides,
});

describe("isTransientCallbackFailure", () => {
  test("database, driver, network, server-state and our own 5xx failures are transient", () => {
    expect(isTransientCallbackFailure(prismaUnreachable())).toBe(true);
    expect(isTransientCallbackFailure(Object.assign(new Error("pool timeout"), { code: "P2024" }))).toBe(true);
    expect(isTransientCallbackFailure(Object.assign(new Error("DatabaseNotReachable"), { name: "DriverAdapterError" }))).toBe(true);
    expect(isTransientCallbackFailure(Object.assign(new Error("init"), { name: "PrismaClientInitializationError" }))).toBe(true);
    expect(isTransientCallbackFailure(Object.assign(new Error("Transaction API error: Unable to start a transaction in the given time."), { code: "P2028" }))).toBe(true);
    expect(isTransientCallbackFailure(Object.assign(new Error("write conflict"), { code: "P2034" }))).toBe(true);
    expect(isTransientCallbackFailure(Object.assign(new Error("refused"), { code: "ECONNREFUSED" }))).toBe(true);
    expect(isTransientCallbackFailure(Object.assign(new Error("deadlock"), { code: "40P01" }))).toBe(true);
    expect(isTransientCallbackFailure(Object.assign(new Error("statement timeout"), { code: "57014" }))).toBe(true);
    expect(isTransientCallbackFailure(coded("CORE_UNAVAILABLE", 503))).toBe(true);
    expect(isTransientCallbackFailure(new Error("Timed out fetching a new connection from the connection pool"))).toBe(true);
    // Wrapped: the cause is what matters.
    expect(isTransientCallbackFailure(new Error("finalize failed", { cause: prismaUnreachable() }))).toBe(true);
  });

  test("verdicts and unexpected errors are not: they stay rejections, as before", () => {
    expect(isTransientCallbackFailure(coded("CALLBACK_VERIFICATION_FAILED", 401))).toBe(false);
    expect(isTransientCallbackFailure(coded("ATTEMPT_TERMINAL", 409))).toBe(false);
    expect(isTransientCallbackFailure(coded("CALLBACK_ENVIRONMENT_MISMATCH", 409))).toBe(false);
    expect(isTransientCallbackFailure(new ApiError(404, "ATTEMPT_NOT_FOUND", "missing"))).toBe(false);
    // A bug tripped by a malformed body must not let anyone drive retries and operator cases.
    expect(isTransientCallbackFailure(new TypeError("cannot read properties of undefined"))).toBe(false);
    expect(isTransientCallbackFailure(Object.assign(new Error("unique"), { code: "P2002x" }))).toBe(false);
    expect(isTransientCallbackFailure(undefined)).toBe(false);
  });

  // The verifier queries by a correlation value from the UNAUTHENTICATED body before it checks the
  // signature. A database error caused by that value is deterministic: classing every Prisma error
  // as transient turned one malformed request into five retries and an operator case.
  test("deterministic database and configuration errors are not transient", () => {
    const prisma = (name: string, code?: string, message = "bad input") =>
      Object.assign(new Error(message), { name, ...(code ? { code } : {}) });
    for (const error of [
      prisma("PrismaClientKnownRequestError", "P2000", "The provided value for the column is too long"),
      prisma("PrismaClientKnownRequestError", "P2002", "Unique constraint failed"),
      prisma("PrismaClientKnownRequestError", "P2023", "Inconsistent column data"),
      prisma("PrismaClientKnownRequestError", "P2025", "Record not found"),
      prisma("PrismaClientValidationError", undefined, "Invalid value provided"),
      prisma("PrismaClientUnknownRequestError", undefined, "invalid byte sequence for encoding \"UTF8\": 0x00"),
      Object.assign(new Error("invalid byte sequence"), { code: "22021" }),
      Object.assign(new Error("x"), { name: "DriverAdapterError" }),
      coded("CALLBACK_VERIFIER_MISSING", 501),
      coded("INTERNAL", 500),
    ]) {
      expect(isTransientCallbackFailure(error), `${error.name} ${(error as { code?: string }).code ?? ""}`).toBe(false);
    }
  });

  test("the handler skips a deterministic database error instead of retrying it", async () => {
    const handler = createCallbackInboundHandler(deps({
      verifyCallback: async () => {
        throw Object.assign(new Error("invalid byte sequence for encoding \"UTF8\": 0x00"), { name: "PrismaClientUnknownRequestError" });
      },
    }));
    expect(await handler.handle(event())).toEqual({ processed: false, result: "CALLBACK_VERIFICATION_FAILED" });
  });
});

describe("createCallbackInboundHandler", () => {
  test("a verified callback is processed and passes the stored request through", async () => {
    const seen: unknown[] = [];
    const handler = createCallbackInboundHandler(deps({
      verifyCallback: async (pathToken, request) => {
        seen.push({ pathToken, headers: request.headers, sourceIp: request.sourceIp });
        return { status: "SUCCEEDED" };
      },
    }));
    expect(await handler.handle(event())).toEqual({ processed: true, result: "SUCCEEDED" });
    expect(seen).toEqual([{ pathToken: "path-token", headers: { "x-signature": "abc" }, sourceIp: "203.0.113.5" }]);
  });

  test("a definitive rejection is skipped with its code", async () => {
    const handler = createCallbackInboundHandler(deps({
      verifyCallback: async () => { throw coded("CALLBACK_VERIFICATION_FAILED", 401); },
    }));
    expect(await handler.handle(event())).toEqual({ processed: false, result: "CALLBACK_VERIFICATION_FAILED" });
  });

  test("an unknown channel is skipped", async () => {
    const handler = createCallbackInboundHandler(deps({ findChannelPathToken: async () => null }));
    expect(await handler.handle(event())).toEqual({ processed: false, result: "CHANNEL_UNKNOWN" });
  });

  test("a database error during verification is retryable, not a skip", async () => {
    const handler = createCallbackInboundHandler(deps({
      verifyCallback: async () => { throw prismaUnreachable(); },
    }));
    const error = await handler.handle(event()).catch((caught) => caught);
    expect(error).toBeInstanceOf(RetryableInboundError);
    expect((error as Error).message).toContain("Can't reach database server");
  });

  test("an unexpected error is skipped with the old default code, not retried", async () => {
    const handler = createCallbackInboundHandler(deps({
      verifyCallback: async () => { throw new TypeError("cannot read properties of undefined"); },
    }));
    expect(await handler.handle(event())).toEqual({ processed: false, result: "CALLBACK_VERIFICATION_FAILED" });
  });

  test("a database error while loading the channel is retryable", async () => {
    const handler = createCallbackInboundHandler(deps({
      findChannelPathToken: async () => { throw prismaUnreachable(); },
    }));
    expect(await handler.handle(event()).catch((caught) => caught)).toBeInstanceOf(RetryableInboundError);
  });
});

describe("inboundRouteFailureOutcome (the synchronous webhook route)", () => {
  test("a definitive rejection is REJECTED and acknowledged as before", () => {
    expect(inboundRouteFailureOutcome(coded("CALLBACK_VERIFICATION_FAILED", 401))).toEqual({
      retryLater: false,
      verificationError: "CALLBACK_VERIFICATION_FAILED",
      processingResult: "REJECTED",
    });
  });

  test("a database error leaves the event for a retry and is not acknowledged", () => {
    expect(inboundRouteFailureOutcome(prismaUnreachable())).toEqual({
      retryLater: true,
      verificationError: "RETRYABLE:P1001",
      processingResult: "RETRY_PENDING",
    });
  });

  test("an unexpected code-less error stays a rejection, as before", () => {
    expect(inboundRouteFailureOutcome(new TypeError("boom"))).toEqual({
      retryLater: false,
      verificationError: "CALLBACK_VERIFICATION_FAILED",
      processingResult: "REJECTED",
    });
  });

  test("a wrapped database error is retried and labelled by the outer error", () => {
    expect(inboundRouteFailureOutcome(new Error("finalize failed", { cause: prismaUnreachable() }))).toMatchObject({
      retryLater: true,
      verificationError: "RETRYABLE:Error",
    });
  });

  test("the route uses it: 503 without an acknowledgement and processed_at left NULL on a retry", async () => {
    const source = await Bun.file(new URL("../api/internal/checkout.ts", import.meta.url)).text();
    const route = source.slice(source.indexOf('route.post("/inbound/:gateway/:env/:pathToken"'));
    expect(route).toContain("inboundRouteFailureOutcome(error)");
    expect(route).toContain("processedAt: retryLater ? null : new Date()");
    // The final acknowledgement is the last one in the route (an earlier one answers a duplicate).
    expect(route.indexOf("if (retryLater)")).toBeGreaterThan(-1);
    expect(route.indexOf("if (retryLater)")).toBeLessThan(route.lastIndexOf("response.status(channel.ackStatus)"));
    expect(route).toContain("response.status(503)");
  });
});

describe("the inbox with the callback handler", () => {
  const runInbox = async (verifyCallback: CallbackInboundHandlerDeps["verifyCallback"], ticks: number) => {
    const row = {
      id: "event-1",
      channel_id: "channel-1",
      raw_body_bytes: Buffer.from("{}"),
      redacted_headers_json: {},
      source_ip: null,
      processing_result: null as string | null,
    };
    const { db, calls } = createRecordingDb({
      // The claim returns the event while it is still open (never processed, or waiting to retry).
      onQuery: (sql) => {
        const open = row.processing_result === null || row.processing_result.startsWith("RETRY");
        return sql.includes("FROM inbound_events") && open ? [row] : [];
      },
      onExecute: (sql, args) => {
        if (sql.includes("processing_result")) {
          // markRetry stores the counter in processing_result; the next claim reads it back.
          const result = String(sql.startsWith("UPDATE inbound_events SET processed_at") ? args[1] : args[0]);
          row.processing_result = result;
        }
        return 1;
      },
    });
    const worker = new InboundInboxWorker({
      db,
      repositories: createFakeRepositories({}),
      handler: createCallbackInboundHandler(deps({ verifyCallback })),
      maxAttempts: 5,
      workerId: "node-1",
    });
    for (let tick = 0; tick < ticks; tick += 1) {
      await worker.runOnce();
    }
    const results = calls
      .filter((call) => call.kind === "execute" && call.sql.includes("UPDATE inbound_events"))
      .map((call) => String(call.sql.startsWith("UPDATE inbound_events SET processed_at") ? call.args[1] : call.args[0]));
    return { results, final: row.processing_result };
  };

  test("a webhook that hits a database blip is retried and then processed, never skipped", async () => {
    let calls = 0;
    const { results, final } = await runInbox(async () => {
      calls += 1;
      if (calls === 1) throw prismaUnreachable();
      return { status: "SUCCEEDED" };
    }, 2);

    expect(results[0]).toStartWith("RETRY(1):");
    expect(results[1]).toBe("SUCCEEDED");
    expect(final).toBe("SUCCEEDED");
    expect(results).not.toContain("SKIPPED");
  });

  test("a definitive rejection is still recorded as SKIPPED on the first try", async () => {
    const { results } = await runInbox(async () => { throw coded("CALLBACK_VERIFICATION_FAILED", 401); }, 1);
    expect(results).toEqual(["SKIPPED"]);
  });
});
