import fs from "node:fs";
import https from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import type { ClientRequest } from "node:http";
import type { TLSSocket } from "node:tls";
import { Readable } from "node:stream";
import type { Request, Response } from "express";
import { coreBackUrls, env } from "./env";
import { ApiError } from "./error";
import { isValidIp } from "./net";

export const CORE_SERVICE_NAME = "merchant-back";
export const CORE_CHANNEL_PREFIX = "/internal/merchant";
export const CORE_FAILURE_COOLDOWN_MS = 5000;
/** Consecutive node failures required before a node leaves rotation (GAP-021). */
export const CORE_FAILURE_THRESHOLD = 3;

const DEFAULT_MAX_ATTEMPTS = 2;
const MAX_STREAM_SOCKETS = 128;
/**
 * Methods whose replay after the request reached the wire cannot duplicate an effect. `PUT` and
 * `DELETE` are deliberately absent: they are idempotent in HTTP theory, but core's `PUT` routes
 * create a new version per call, so a replay after a send would double-apply. They are still
 * retried when the connection failed before anything was sent (see `IDEMPOTENT_METHODS`).
 */
const REPLAY_SAFE_METHODS = new Set<CoreHttpMethod>(["GET", "HEAD", "OPTIONS"]);
/** Methods that are retried on the next node after a connect-phase failure. */
const IDEMPOTENT_METHODS = new Set<CoreHttpMethod>([
  "GET",
  "HEAD",
  "PUT",
  "DELETE",
  "OPTIONS",
]);

export type CoreHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

export interface CoreRequestOptions {
  method: CoreHttpMethod;
  path: string;
  headers?: Record<string, string>;
  body?: Buffer | string;
  query?: Record<string, string | number | boolean | null | undefined>;
  timeoutMs?: number;
  retryIdempotent?: boolean;
  retryIfUnavailable?: boolean;
  maxAttempts?: number;
  signal?: AbortSignal;
  minLsn?: string;
  consistencyLsn?: string;
}

export interface CoreCallOptions {
  method: CoreHttpMethod;
  path: string;
  body?: unknown;
  rawBody?: Buffer;
  rawContentType?: string;
  headers?: Record<string, string>;
  requestId: string;
  clientIp: string;
  userAgent?: string;
  authorization?: string;
  query?: Record<string, string | number | boolean | null | undefined>;
  timeoutMs?: number;
  signal?: AbortSignal;
  retryIdempotent?: boolean;
  retryIfUnavailable?: boolean;
  maxAttempts?: number;
  minLsn?: string;
  consistencyLsn?: string;
}

export interface CoreResponse {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

export interface CoreStream {
  statusCode: number;
  headers: IncomingHttpHeaders;
  stream: Readable;
  abort: () => void;
}

export interface CoreNodeState {
  url: string;
  agent: https.Agent;
  /** Dedicated pool for long-lived SSE streams so they cannot starve request/response traffic. */
  streamAgent: https.Agent;
  healthy: boolean;
  inFlight: number;
  failures: number;
  lastFailureAt?: number;
  cooldownUntil: number;
}

const STATUS_FALLBACKS: Record<number, { code: string; message: string }> = {
  400: { code: "CORE_BAD_REQUEST", message: "Core rejected the request payload" },
  401: { code: "CORE_UNAUTHORIZED", message: "Core rejected the supplied credentials" },
  403: { code: "CORE_FORBIDDEN", message: "Core denied the operation for this principal" },
  404: { code: "CORE_NOT_FOUND", message: "Core resource was not found" },
  405: { code: "CORE_METHOD_NOT_ALLOWED", message: "Core does not allow this method" },
  408: { code: "CORE_TIMEOUT", message: "Core request timed out" },
  409: { code: "CORE_CONFLICT", message: "Core reported a state conflict" },
  410: { code: "CORE_GONE", message: "Core resource is no longer available" },
  413: { code: "CORE_PAYLOAD_TOO_LARGE", message: "Core rejected the payload size" },
  415: { code: "CORE_UNSUPPORTED_MEDIA_TYPE", message: "Core rejected the media type" },
  422: { code: "CORE_VALIDATION_FAILED", message: "Core failed payload validation" },
  429: { code: "CORE_RATE_LIMITED", message: "Core rate limited the request" },
  500: { code: "CORE_INTERNAL_ERROR", message: "Core service failed internally" },
  502: { code: "CORE_BAD_GATEWAY", message: "Core service returned an invalid response" },
  503: { code: "CORE_UNAVAILABLE", message: "Core service is temporarily unavailable" },
  504: { code: "CORE_GATEWAY_TIMEOUT", message: "Core service did not respond in time" },
};

const TLS_ERROR_CODES = new Set([
  "EPROTO",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_TLS_HANDSHAKE_TIMEOUT",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_SIGNATURE_FAILURE",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_SSL_WRONG_VERSION_NUMBER",
  "ERR_SSL_PACKET_LENGTH_TOO_LONG",
]);

const errorCodeOf = (error: unknown): string =>
  typeof error === "object" && error !== null ? String((error as { code?: unknown }).code ?? "") : "";

const NODE_FAILURE_CODES = new Set([
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  ...TLS_ERROR_CODES,
]);

/**
 * Only connect/transport failures may take a core node out of rotation. Local pre-flight
 * exceptions (invalid header characters, oversized responses) and client aborts say nothing
 * about the health of the node and must never trip the circuit breaker.
 */
export const isNodeFailure = (error: unknown): boolean => NODE_FAILURE_CODES.has(errorCodeOf(error));

const isClientAbort = (error: unknown): boolean => errorCodeOf(error) === "ABORT_ERR";

const isLocalRequestError = (error: unknown): boolean =>
  (error as { localRequestError?: boolean } | null)?.localRequestError === true;

/**
 * Message-framing and hop-by-hop headers are never taken from a caller. The edge writes the body
 * itself (often re-serialised or decompressed), so a forwarded `content-length` that describes the
 * ORIGINAL inbound body would not match the bytes written on the pooled keep-alive connection to
 * core: the surplus would be parsed as the next request (request smuggling) and a shortfall would
 * swallow the start of the next one. The real length is computed from the body in `buildRequestHeaders`.
 */
const FRAMING_HEADERS = ["content-length", "transfer-encoding", "content-encoding", "connection", "keep-alive", "upgrade", "te", "trailer", "host", "expect"];

const stripFramingHeaders = (headers: Record<string, string>): void => {
  for (const name of FRAMING_HEADERS) delete headers[name];
};

const HEADER_NAME_PATTERN = /^[a-z0-9!#$%&'*+.^_`|~-]+$/;
const HEADER_VALUE_PATTERN = /^[\t\x20-\x7e]*$/;

/** Rejects header names/values that are not printable ASCII before anything is dispatched. */
export const assertHeaderSafe = (headers: Record<string, string>): void => {
  for (const [name, value] of Object.entries(headers)) {
    if (!HEADER_NAME_PATTERN.test(name) || typeof value !== "string" || !HEADER_VALUE_PATTERN.test(value)) {
      throw new ApiError(400, "CORE_HEADER_INVALID", "A forwarded header contains invalid characters");
    }
  }
};

const sanitizeUserAgent = (value: string | undefined): string =>
  (value ?? "").replace(/[^\x20-\x7e]/g, "").slice(0, 512);

const parseCoreEnvelope = (
  payload: unknown,
): { code?: string; message?: string; details?: unknown; reference?: string } | null => {
  if (typeof payload !== "object" || payload === null) return null;
  const candidate = payload as Record<string, unknown>;
  const code = typeof candidate.code === "string" ? candidate.code : undefined;
  const message = typeof candidate.message === "string" ? candidate.message : undefined;
  const reference = typeof candidate.reference === "string" ? candidate.reference : undefined;
  const details = candidate.details;
  if (code === undefined && message === undefined && details === undefined && reference === undefined) {
    return null;
  }
  return { code, message, details, reference };
};

export const mapCoreHttpError = (statusCode: number, payload: unknown): ApiError => {
  const envelope = parseCoreEnvelope(payload);
  const fallback = STATUS_FALLBACKS[statusCode] ?? {
    code: "CORE_ERROR",
    message: `Core service returned status ${statusCode}`,
  };
  return new ApiError(
    statusCode,
    envelope?.code ?? fallback.code,
    envelope?.message ?? fallback.message,
    envelope?.details,
    envelope?.reference,
  );
};

const isApiErrorLike = (error: unknown): error is ApiError =>
  error instanceof ApiError ||
  (typeof error === "object" &&
    error !== null &&
    typeof (error as { statusCode?: unknown }).statusCode === "number" &&
    typeof (error as { code?: unknown }).code === "string");

export const mapCoreTransportError = (error: unknown): ApiError => {
  if (isApiErrorLike(error)) return error;
  const code =
    typeof error === "object" && error !== null ? String((error as { code?: unknown }).code ?? "") : "";
  if (code === "ABORT_ERR") {
    return new ApiError(499, "CLIENT_CLOSED_REQUEST", "The request was aborted before core answered");
  }
  if (code === "CORE_RESPONSE_TOO_LARGE") {
    return new ApiError(502, "CORE_RESPONSE_TOO_LARGE", "Core response exceeded the edge size limit");
  }
  if (code === "ERR_INVALID_CHAR" || code === "ERR_HTTP_INVALID_HEADER_VALUE" || code === "ERR_INVALID_HTTP_TOKEN") {
    return new ApiError(400, "CORE_HEADER_INVALID", "A forwarded header contains invalid characters");
  }
  if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT") {
    return new ApiError(504, "CORE_TIMEOUT", "Core service did not respond before the deadline");
  }
  if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EPIPE" || code === "EHOSTUNREACH") {
    return new ApiError(502, "CORE_UNREACHABLE", "Core service is unreachable");
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return new ApiError(502, "CORE_DNS_FAILURE", "Core service hostname could not be resolved");
  }
  if (TLS_ERROR_CODES.has(code)) {
    return new ApiError(502, "CORE_TLS_ERROR", "Mutual TLS handshake with core service failed");
  }
  return new ApiError(502, "CORE_CONNECTION_ERROR", "Failed to reach core service");
};

export const assertCorePath = (path: string): string => {
  if (typeof path !== "string" || path.length === 0) {
    throw new ApiError(500, "CORE_PATH_INVALID", "A core path is required");
  }
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("://") ||
    path.includes("\\")
  ) {
    throw new ApiError(500, "CORE_PATH_INVALID", "Core path must be a rooted absolute path");
  }
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    throw new ApiError(500, "CORE_PATH_INVALID", "Core path contains invalid escaping");
  }
  if (decoded.includes("\\")) {
    throw new ApiError(500, "CORE_PATH_INVALID", "Core path must not contain backslashes");
  }
  const segments = decoded.split("/");
  if (segments.includes("..") || segments.includes(".")) {
    throw new ApiError(500, "CORE_PATH_INVALID", "Core path must not contain traversal segments");
  }
  if (path !== CORE_CHANNEL_PREFIX && !path.startsWith(`${CORE_CHANNEL_PREFIX}/`)) {
    throw new ApiError(
      403,
      "CORE_CHANNEL_VIOLATION",
      `Path is outside the ${CORE_CHANNEL_PREFIX} channel bound to ${CORE_SERVICE_NAME}`,
    );
  }
  return path;
};

const resolveCoreUrlAgainst = (
  baseUrl: string,
  path: string,
  query?: Record<string, string | number | boolean | null | undefined>,
): URL => {
  const safePath = assertCorePath(path);
  const base = new URL(baseUrl);
  const target = new URL(base.toString());
  target.pathname = `${base.pathname.replace(/\/+$/, "")}${safePath}`;
  target.hash = "";
  if (query) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      params.append(key, String(value));
    }
    const serialized = params.toString();
    if (serialized.length > 0) target.search = serialized;
  }
  return target;
};

export const resolveCoreUrl = (
  path: string,
  query?: Record<string, string | number | boolean | null | undefined>,
  baseUrl: string = env.CORE_BACK_URL,
): URL => resolveCoreUrlAgainst(baseUrl, path, query);

const readMaterial = (path: string, label: string): Buffer => {
  try {
    return fs.readFileSync(path);
  } catch {
    throw new ApiError(500, "MTLS_MATERIAL_UNAVAILABLE", `Unable to load ${label} material`);
  }
};

const createCoreAgent = (maxSockets = 64): https.Agent =>
  new https.Agent({
    cert: readMaterial(env.MTLS_CLIENT_CERT_PATH, "client certificate"),
    key: readMaterial(env.MTLS_CLIENT_KEY_PATH, "client private key"),
    ca: [readMaterial(env.MTLS_CA_CERT_PATH, "internal CA certificate")],
    minVersion: "TLSv1.3",
    maxVersion: "TLSv1.3",
    rejectUnauthorized: true,
    keepAlive: true,
    keepAliveMsecs: 30000,
    maxSockets,
    timeout: env.CORE_REQUEST_TIMEOUT_MS,
  });

let nodes: CoreNodeState[] = [];
let poolSignature = "";
let roundRobinCursor = 0;
let clock: () => number = () => Date.now();

export const setCoreClock = (source: (() => number) | number): void => {
  clock = typeof source === "function" ? source : () => source;
};

export const resetCoreClock = (): void => {
  clock = () => Date.now();
};

export const setCoreClockForTests = setCoreClock;
export const resetCoreClockForTests = resetCoreClock;

const destroyNodes = (): void => {
  for (const node of nodes) {
    node.agent.destroy();
    node.streamAgent.destroy();
  }
  nodes = [];
  poolSignature = "";
  roundRobinCursor = 0;
};

export const resetCoreAgent = (): void => {
  destroyNodes();
};

export const resetCorePool = resetCoreAgent;

const ensureNodes = (): CoreNodeState[] => {
  const configured = coreBackUrls();
  const signature = configured.join("\n");
  if (signature !== poolSignature) {
    destroyNodes();
    poolSignature = signature;
    nodes = configured.map((url) => ({
      url,
      agent: createCoreAgent(),
      streamAgent: createCoreAgent(MAX_STREAM_SOCKETS),
      healthy: true,
      inFlight: 0,
      failures: 0,
      cooldownUntil: 0,
    }));
  }
  return nodes;
};

export const getCoreAgent = (): https.Agent => {
  const pool = ensureNodes();
  const primary = pool[0];
  if (!primary) {
    throw new ApiError(503, "CORE_UNAVAILABLE", "Core service is temporarily unavailable");
  }
  return primary.agent;
};

const eligiblePool = (excluded: Set<string>): CoreNodeState[] => {
  const now = clock();
  const halfOpen = nodes.filter(
    (node) => !excluded.has(node.url) && !node.healthy && node.inFlight === 0 && now >= node.cooldownUntil,
  );
  if (halfOpen.length > 0) return halfOpen;
  return nodes.filter((node) => !excluded.has(node.url) && node.healthy);
};

const selectNode = (excluded: Set<string>): CoreNodeState | undefined => {
  const pool = eligiblePool(excluded);
  if (pool.length === 0) return undefined;
  const leastInFlight = Math.min(...pool.map((node) => node.inFlight));
  const tied = pool.filter((node) => node.inFlight === leastInFlight);
  const node = tied[roundRobinCursor % tied.length];
  roundRobinCursor = (roundRobinCursor + 1) % Number.MAX_SAFE_INTEGER;
  return node;
};

const hasSelectableNode = (excluded: Set<string>): boolean => eligiblePool(excluded).length > 0;

const markNodeFailure = (node: CoreNodeState): void => {
  const now = clock();
  node.failures += 1;
  node.lastFailureAt = now;
  if (node.failures < CORE_FAILURE_THRESHOLD) return;
  node.healthy = false;
  node.cooldownUntil = now + CORE_FAILURE_COOLDOWN_MS;
};

const markNodeHealthy = (node: CoreNodeState): void => {
  node.healthy = true;
  node.failures = 0;
  node.cooldownUntil = 0;
};

const coreUnavailable = (): ApiError =>
  new ApiError(503, "CORE_UNAVAILABLE", "Core service is temporarily unavailable");

const normalizeMaxAttempts = (value: number | undefined): number => {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_ATTEMPTS;
  return Math.max(1, Math.floor(value));
};

/**
 * A 502/503/504 that core (or the proxy in front of it) answered is an application decision, not a
 * transport failure: it proves the node is reachable over mTLS. It may justify trying another node
 * for a replay-safe request, but it must never take the node out of rotation. Core itself answers
 * 503 for business conditions (for example "screening unavailable"), and counting those would let a
 * provider outage take a single-core edge offline in repeating cooldown windows.
 */
const isUnavailableStatus = (status: number): boolean => status === 502 || status === 503 || status === 504;

/**
 * A request that already reached the wire is only replayed when that cannot duplicate an
 * effect: read-only methods, an explicit caller opt-in, or a request carrying an idempotency key.
 * Connect-phase failures (nothing was sent) are always safe to retry.
 */
const mayReplayAfterSend = (
  method: CoreHttpMethod,
  headers: Record<string, string>,
  options: { retryIdempotent?: boolean; retryIfUnavailable?: boolean },
): boolean =>
  REPLAY_SAFE_METHODS.has(method) ||
  options.retryIdempotent === true ||
  options.retryIfUnavailable === true ||
  typeof headers["idempotency-key"] === "string";

const retryAttemptsFor = (
  method: CoreHttpMethod,
  retryIdempotent: boolean | undefined,
  retryIfUnavailable: boolean | undefined,
  maxAttempts: number | undefined,
): number => {
  const retryEnabled = retryIdempotent ?? IDEMPOTENT_METHODS.has(method);
  if (!retryEnabled && retryIfUnavailable !== true) return 1;
  return normalizeMaxAttempts(maxAttempts);
};

const buildRequestHeaders = (options: CoreRequestOptions): Record<string, string> => {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.headers ?? {})) {
    headers[key.toLowerCase()] = value;
  }
  const lsn = options.minLsn ?? options.consistencyLsn;
  if (lsn !== undefined && lsn.trim().length > 0) headers["x-pg-min-lsn"] = lsn;
  stripFramingHeaders(headers);
  if (options.body !== undefined) headers["content-length"] = String(Buffer.byteLength(options.body));
  assertHeaderSafe(headers);
  return headers;
};

export const consistencyHeader = (lsn?: string): Record<string, string> =>
  lsn !== undefined && lsn.trim().length > 0 ? { "x-pg-min-lsn": lsn } : {};

export const buildCoreHeaders = (options: CoreCallOptions): Record<string, string> => {
  // Caller supplied headers go in first; every edge-owned header is applied afterwards so a
  // caller can never override the service identity, the resolved client ip or the credential.
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.headers ?? {})) {
    headers[key.toLowerCase()] = value;
  }
  stripFramingHeaders(headers);
  headers.accept = "application/json";
  headers["x-request-id"] = options.requestId;
  headers["x-real-client-ip"] = options.clientIp;
  headers["x-client-user-agent"] = sanitizeUserAgent(options.userAgent);
  headers["x-edge-service"] = CORE_SERVICE_NAME;
  if (options.authorization) headers.authorization = options.authorization;
  else delete headers.authorization;
  if (options.rawContentType) headers["content-type"] = options.rawContentType;
  else if (options.body !== undefined) headers["content-type"] = "application/json";
  else delete headers["content-type"];
  const lsn = options.minLsn ?? options.consistencyLsn;
  if (lsn !== undefined && lsn.trim().length > 0) headers["x-pg-min-lsn"] = lsn;
  assertHeaderSafe(headers);
  return headers;
};

const serializeBody = (options: CoreCallOptions): Buffer | undefined => {
  if (options.rawBody) return options.rawBody;
  if (options.body !== undefined) return Buffer.from(JSON.stringify(options.body), "utf8");
  return undefined;
};

const createNodeRequest = (
  node: CoreNodeState,
  options: CoreRequestOptions,
  headers: Record<string, string>,
  agent: https.Agent = node.agent,
): ClientRequest => {
  try {
    const url = resolveCoreUrlAgainst(node.url, options.path, options.query);
    return https.request({
      agent,
      method: options.method,
      protocol: "https:",
      hostname: url.hostname,
      port: Number(url.port || 443),
      path: `${url.pathname}${url.search}`,
      headers,
      ...(isValidIp(url.hostname) ? {} : { servername: url.hostname }),
      rejectUnauthorized: true,
      timeout: options.timeoutMs ?? env.CORE_REQUEST_TIMEOUT_MS,
    });
  } catch (error) {
    // Raised before anything touched the network: never a statement about node health.
    if (typeof error === "object" && error !== null) {
      (error as { localRequestError?: boolean }).localRequestError = true;
    }
    throw error;
  }
};

const markWireStarted = (clientRequest: ClientRequest, onStarted: () => void): void => {
  clientRequest.on("socket", (socket) => {
    const tls = socket as TLSSocket;
    if (tls.connecting || (tls as unknown as { _secureEstablished?: boolean })._secureEstablished === false) {
      tls.once("secureConnect", onStarted);
    } else {
      onStarted();
    }
  });
};

const timeoutError = () => Object.assign(new Error("core request timeout"), { code: "ETIMEDOUT" });

const abortError = () =>
  Object.assign(new Error("core request aborted"), { name: "AbortError", code: "ABORT_ERR" });

const performRequest = (
  node: CoreNodeState,
  options: CoreRequestOptions,
  headers: Record<string, string>,
): Promise<CoreResponse> =>
  new Promise<CoreResponse>((resolve, reject) => {
    let settled = false;
    let wireStarted = false;
    let received = 0;
    let clientRequest: ClientRequest | undefined;
    const maxBytes = env.CORE_MAX_RESPONSE_BYTES;
    const deadlineMs = Math.max(env.CORE_TOTAL_DEADLINE_MS, options.timeoutMs ?? 0);
    const deadline = setTimeout(() => clientRequest?.destroy(timeoutError()), deadlineMs);
    const cleanup = () => {
      clearTimeout(deadline);
      if (options.signal) options.signal.removeEventListener("abort", onAbort);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (typeof error === "object" && error !== null && !wireStarted) {
        (error as { connectPhase?: boolean }).connectPhase = true;
      }
      reject(error);
    };
    const onAbort = () => clientRequest?.destroy(abortError());
    try {
      clientRequest = createNodeRequest(node, options, headers);
    } catch (error) {
      fail(error);
      return;
    }
    markWireStarted(clientRequest, () => {
      wireStarted = true;
    });
    if (options.signal) {
      if (options.signal.aborted) {
        clientRequest.destroy(abortError());
      } else {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
    }
    clientRequest.on("timeout", () => clientRequest.destroy(timeoutError()));
    clientRequest.on("error", fail);
    clientRequest.on("response", (response) => {
      wireStarted = true;
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer | string) => {
        const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        received += piece.length;
        if (received > maxBytes) {
          // Settle first so a trailing `end` can never resolve with a truncated body.
          fail(Object.assign(new Error("core response too large"), { code: "CORE_RESPONSE_TOO_LARGE" }));
          clientRequest?.destroy();
          return;
        }
        chunks.push(piece);
      });
      response.on("end", () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({
          statusCode: response.statusCode ?? 502,
          headers: response.headers,
          body: Buffer.concat(chunks),
        });
      });
      response.on("error", fail);
    });
    try {
      if (options.body !== undefined) clientRequest.write(options.body);
      clientRequest.end();
    } catch (error) {
      clientRequest.destroy();
      fail(error);
    }
  });

export const request = async (options: CoreRequestOptions): Promise<CoreResponse> => {
  const pool = ensureNodes();
  if (pool.length === 0) throw coreUnavailable();
  const maxAttempts = retryAttemptsFor(
    options.method,
    options.retryIdempotent,
    options.retryIfUnavailable,
    options.maxAttempts,
  );
  const headers = buildRequestHeaders(options);
  const replayAfterSend = mayReplayAfterSend(options.method, headers, options);
  const attempted = new Set<string>();
  let lastError: unknown;
  let lastResponse: CoreResponse | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const node = selectNode(attempted);
    if (!node) break;
    attempted.add(node.url);
    node.inFlight += 1;
    try {
      const response = await performRequest(node, options, headers);
      // Any complete HTTP response proves the transport to this node works.
      markNodeHealthy(node);
      if (isUnavailableStatus(response.statusCode) && replayAfterSend) {
        lastResponse = response;
        lastError = undefined;
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      lastResponse = undefined;
      if (isLocalRequestError(error) || isClientAbort(error) || !isNodeFailure(error)) break;
      markNodeFailure(node);
      if (!replayAfterSend && (error as { connectPhase?: boolean }).connectPhase !== true) break;
    } finally {
      node.inFlight -= 1;
    }
  }
  if (lastResponse) return lastResponse;
  if (lastError !== undefined) {
    if (isNodeFailure(lastError) && !hasSelectableNode(new Set())) throw coreUnavailable();
    throw mapCoreTransportError(lastError);
  }
  throw coreUnavailable();
};

export const callCoreRaw = async (options: CoreCallOptions): Promise<CoreResponse> =>
  request({
    method: options.method,
    path: options.path,
    query: options.query,
    headers: buildCoreHeaders(options),
    body: serializeBody(options),
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    retryIdempotent: options.retryIdempotent,
    retryIfUnavailable: options.retryIfUnavailable,
    maxAttempts: options.maxAttempts,
    minLsn: options.minLsn,
    consistencyLsn: options.consistencyLsn,
  });

export const parseJsonBuffer = (buffer: Buffer): unknown => {
  const text = buffer.toString("utf8").trim();
  if (text.length === 0) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
};

export interface CoreResponsePayload<T = unknown> {
  status: number;
  body: T;
  headers: IncomingHttpHeaders;
}

/**
 * Calls core and returns the parsed body TOGETHER with the status code the
 * core answered. A route whose outcome became asynchronous (a queued job) is
 * relayed with the core's own status instead of a hard coded one.
 */
export const callCoreResponse = async <T = unknown>(
  options: CoreCallOptions,
): Promise<CoreResponsePayload<T>> => {
  const response = await callCoreRaw(options);
  const payload = parseJsonBuffer(response.body);
  if (response.statusCode >= 400) {
    throw mapCoreHttpError(response.statusCode, payload);
  }
  return { status: response.statusCode, body: payload as T, headers: response.headers };
};

export const callCore = async <T = unknown>(options: CoreCallOptions): Promise<T> => {
  const response = await callCoreResponse<T>(options);
  return response.body;
};

const performStreamRequest = (
  node: CoreNodeState,
  options: CoreCallOptions,
  headers: Record<string, string>,
): Promise<CoreStream> =>
  new Promise<CoreStream>((resolve, reject) => {
    let settled = false;
    let released = false;
    let clientRequest: ClientRequest;
    const release = () => {
      if (released) return;
      released = true;
      node.inFlight -= 1;
    };
    const cleanup = () => {
      if (options.signal) options.signal.removeEventListener("abort", onAbort);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      release();
      reject(error);
    };
    const onAbort = () => clientRequest.destroy(abortError());
    try {
      clientRequest = createNodeRequest(
        node,
        {
          method: options.method,
          path: options.path,
          query: options.query,
          timeoutMs: options.timeoutMs,
          minLsn: options.minLsn,
          consistencyLsn: options.consistencyLsn,
        },
        headers,
        node.streamAgent,
      );
    } catch (error) {
      fail(error);
      return;
    }
    if (options.signal) {
      if (options.signal.aborted) {
        clientRequest.destroy(abortError());
      } else {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
    }
    clientRequest.on("timeout", () => clientRequest.destroy(timeoutError()));
    clientRequest.on("error", fail);
    clientRequest.on("response", (response) => {
      if (settled) return;
      settled = true;
      cleanup();
      const stream = response as unknown as Readable;
      stream.once("end", release);
      stream.once("close", release);
      stream.once("error", release);
      resolve({
        statusCode: response.statusCode ?? 502,
        headers: response.headers,
        stream,
        abort: () => {
          clientRequest.destroy();
          release();
        },
      });
    });
    try {
      const payload = serializeBody(options);
      if (payload !== undefined) clientRequest.write(payload);
      clientRequest.end();
    } catch (error) {
      clientRequest.destroy();
      fail(error);
    }
  });

const drainStream = async (stream: Readable): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks);
};

const bufferedStream = (
  statusCode: number,
  headers: IncomingHttpHeaders,
  body: Buffer,
): CoreStream => {
  const stream = Readable.from(body);
  return {
    statusCode,
    headers,
    stream,
    abort: () => stream.destroy(),
  };
};

export const openCoreStream = async (options: CoreCallOptions): Promise<CoreStream> => {
  const pool = ensureNodes();
  if (pool.length === 0) throw coreUnavailable();
  const maxAttempts = retryAttemptsFor(
    options.method,
    options.retryIdempotent,
    options.retryIfUnavailable,
    options.maxAttempts,
  );
  const headers = buildCoreHeaders(options);
  headers.accept = "text/event-stream";
  headers["cache-control"] = "no-cache";
  const attempted = new Set<string>();
  let lastError: unknown;
  let lastStream: CoreStream | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const node = selectNode(attempted);
    if (!node) break;
    attempted.add(node.url);
    node.inFlight += 1;
    try {
      const stream = await performStreamRequest(node, options, headers);
      // Any complete HTTP response proves the transport to this node works.
      markNodeHealthy(node);
      if (isUnavailableStatus(stream.statusCode)) {
        const canRetry =
          attempt + 1 < maxAttempts && hasSelectableNode(attempted);
        if (canRetry) {
          const body = await drainStream(stream.stream).catch(() => Buffer.alloc(0));
          lastStream = bufferedStream(stream.statusCode, stream.headers, body);
          lastError = undefined;
          continue;
        }
        return stream;
      }
      return stream;
    } catch (error) {
      lastError = error;
      if (isLocalRequestError(error) || isClientAbort(error) || !isNodeFailure(error)) break;
      markNodeFailure(node);
    }
  }
  if (lastStream) return lastStream;
  if (lastError !== undefined) {
    if (isNodeFailure(lastError) && !hasSelectableNode(new Set())) throw coreUnavailable();
    throw mapCoreTransportError(lastError);
  }
  throw coreUnavailable();
};

const activeStreamsByIp = new Map<string, number>();

/** Test hook: number of SSE streams currently open for an address. */
export const activeCoreStreamsFor = (ip: string): number => activeStreamsByIp.get(ip) ?? 0;

export const proxyCoreStream = async (
  req: Request,
  res: Response,
  options: CoreCallOptions,
): Promise<void> => {
  const key = options.clientIp || "unknown";
  const open = activeStreamsByIp.get(key) ?? 0;
  if (open >= env.MAX_STREAMS_PER_IP) {
    throw new ApiError(429, "STREAM_LIMIT_REACHED", "Too many concurrent event streams for this client");
  }
  activeStreamsByIp.set(key, open + 1);
  let released = false;
  const releaseSlot = () => {
    if (released) return;
    released = true;
    const current = activeStreamsByIp.get(key) ?? 1;
    if (current <= 1) activeStreamsByIp.delete(key);
    else activeStreamsByIp.set(key, current - 1);
  };

  // Listen for the client going away BEFORE awaiting core so an early disconnect aborts the
  // upstream request instead of leaking it. `res` 'close' is the reliable signal for that:
  // it fires when the connection drops, while `req` 'close' fires once the request is read.
  const controller = new AbortController();
  let upstream: CoreStream | undefined;
  const onClientGone = () => {
    if (res.writableFinished) return;
    controller.abort();
    upstream?.abort();
  };
  res.once("close", () => {
    onClientGone();
    releaseSlot();
  });
  req.once("aborted", onClientGone);
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  try {
    upstream = await openCoreStream({ ...options, signal: controller.signal });
  } catch (error) {
    releaseSlot();
    if (controller.signal.aborted) return;
    throw error;
  }
  if (controller.signal.aborted) {
    upstream.abort();
    releaseSlot();
    return;
  }
  if (upstream.statusCode >= 400) {
    const payload = parseJsonBuffer(await drainStream(upstream.stream));
    upstream.abort();
    releaseSlot();
    throw mapCoreHttpError(upstream.statusCode, payload);
  }
  res.status(upstream.statusCode);
  res.setHeader("content-type", upstream.headers["content-type"] ?? "text/event-stream");
  res.setHeader("cache-control", "no-cache, no-transform");
  res.setHeader("connection", "keep-alive");
  res.setHeader("x-accel-buffering", "no");
  res.flushHeaders?.();
  upstream.stream.on("error", () => {
    res.end();
  });
  upstream.stream.pipe(res);
};
