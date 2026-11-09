import { RetryableInboundError, type InboundEventHandler, type InboundEventRow } from "./InboundInboxWorker";

/**
 * Gateway callbacks (webhooks): the inbound-inbox handler, and the failure classification shared
 * with the synchronous inbound route.
 *
 * A failure is retried only when it is TRANSIENT and ours: the database or its driver, the
 * network, a lock or statement timeout, or a 5xx we raised ourselves. Retrying can then succeed,
 * and the webhook is not lost. Every other failure keeps the previous behaviour and is treated as
 * a rejection of the callback: verification failures are coded 4xx verdicts, and an unexpected
 * error on a malformed body must not let anyone on the internet drive retries and operator cases.
 *
 * Before this split every error was a rejection: a database blip while a "payment succeeded"
 * webhook was handled was recorded as rejected (the route even acknowledged it, so the gateway
 * never redelivered) and the confirmation was lost; only polling or reconciliation could find it.
 */

export interface CallbackRequest {
  rawBody: Buffer;
  headers: Record<string, string>;
  sourceIp: string | null;
}

export interface CallbackInboundHandlerDeps {
  /** The channel's path token, or null when the channel does not exist. */
  findChannelPathToken(channelId: string): Promise<string | null>;
  verifyCallback(pathToken: string, request: CallbackRequest): Promise<{ status: string }>;
  toBuffer(value: unknown): Buffer;
}

/** Prisma's own error codes (`P1001` unreachable, `P2024` pool timeout, `P2034` write conflict, ...). */
const PRISMA_ERROR_CODE = /^P\d{4}$/;
const PRISMA_ERROR_NAME = /^(PrismaClient\w*Error|DriverAdapterError)$/;
const NETWORK_ERROR_CODES = new Set([
  "ECONNREFUSED", "ECONNRESET", "ECONNABORTED", "ETIMEDOUT", "EPIPE", "EHOSTUNREACH",
  "ENETUNREACH", "EAI_AGAIN", "ENOTFOUND", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET",
]);
/**
 * PostgreSQL SQLSTATE classes and codes that describe the server, not the data:
 * 08 connection, 53 insufficient resources, 57 operator intervention (timeouts, shutdown),
 * 40001 serialization failure, 40P01 deadlock, 55P03 lock not available.
 */
const TRANSIENT_SQLSTATE = /^(08|53|57)[0-9A-Z]{3}$|^(40001|40P01|55P03)$/;
const TRANSIENT_MESSAGE = /can't reach database server|timed out fetching a new connection|connection terminated|connection refused|server closed the connection|too many clients|DatabaseNotReachable|SocketTimeout|TransactionWriteConflict/i;

const isTransientOne = (error: unknown): boolean => {
  if (!error || typeof error !== "object") return false;
  const { code, name, statusCode, message, kind } = error as {
    code?: unknown; name?: unknown; statusCode?: unknown; message?: unknown; kind?: unknown;
  };
  if (typeof name === "string" && PRISMA_ERROR_NAME.test(name)) return true;
  if (typeof code === "string") {
    if (PRISMA_ERROR_CODE.test(code) || NETWORK_ERROR_CODES.has(code) || TRANSIENT_SQLSTATE.test(code)) {
      return true;
    }
  }
  if (typeof kind === "string" && TRANSIENT_MESSAGE.test(kind)) return true;
  const status = Number(statusCode);
  if (Number.isInteger(status) && status >= 500 && status < 600) return true;
  return typeof message === "string" && TRANSIENT_MESSAGE.test(message);
};

/** True for a failure that retrying can fix (see the module comment). Follows `cause` a few levels. */
export const isTransientCallbackFailure = (error: unknown): boolean => {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (isTransientOne(current)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
};

/** The code recorded for a rejection, as the route and the handler always did. */
const rejectionCode = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code ? code : "CALLBACK_VERIFICATION_FAILED";
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * What the synchronous inbound webhook route records when verification throws. A rejection is
 * REJECTED and acknowledged as before. A transient failure is not a verdict: the route leaves the
 * event unprocessed (the inbox worker claims and retries it) and answers 503 so the gateway
 * redelivers, instead of acknowledging a webhook it never processed.
 */
export const inboundRouteFailureOutcome = (
  error: unknown,
): { retryLater: boolean; verificationError: string; processingResult: string } => {
  if (!isTransientCallbackFailure(error)) {
    return { retryLater: false, verificationError: rejectionCode(error), processingResult: "REJECTED" };
  }
  const { code, name } = (error ?? {}) as { code?: unknown; name?: unknown };
  const label = typeof code === "string" && code ? code : typeof name === "string" && name ? name : "ERROR";
  return {
    retryLater: true,
    verificationError: `RETRYABLE:${label}`.slice(0, 200),
    processingResult: "RETRY_PENDING",
  };
};

export const createCallbackInboundHandler = (deps: CallbackInboundHandlerDeps): InboundEventHandler => ({
  handle: async (event: InboundEventRow) => {
    let pathToken: string | null;
    try {
      pathToken = await deps.findChannelPathToken(event.channelId);
    } catch (error) {
      if (isTransientCallbackFailure(error)) {
        throw new RetryableInboundError(`Confirmation channel lookup failed: ${messageOf(error)}`);
      }
      throw error;
    }
    if (!pathToken) {
      return { processed: false, result: "CHANNEL_UNKNOWN" };
    }
    try {
      const result = await deps.verifyCallback(pathToken, {
        rawBody: deps.toBuffer(event.rawBodyBytes),
        headers: (event.redactedHeadersJson ?? {}) as Record<string, string>,
        sourceIp: event.sourceIp,
      });
      return { processed: true, result: result.status };
    } catch (error) {
      if (isTransientCallbackFailure(error)) {
        throw new RetryableInboundError(`Callback processing failed: ${messageOf(error)}`);
      }
      return { processed: false, result: rejectionCode(error) };
    }
  },
});
