import fs from "node:fs";
import https from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import type { ClientRequest } from "node:http";
import { Readable } from "node:stream";
import type { Request, Response } from "express";
import { coreBackUrls, env } from "./env";
import { ApiError } from "./error";
import { isValidIp } from "./net";

export const CORE_SERVICE_NAME = "merchant-back";
export const CORE_CHANNEL_PREFIX = "/internal/merchant";
export const CORE_FAILURE_COOLDOWN_MS = 5000;

const DEFAULT_MAX_ATTEMPTS = 2;
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

const createCoreAgent = (): https.Agent =>
  new https.Agent({
    cert: readMaterial(env.MTLS_CLIENT_CERT_PATH, "client certificate"),
    key: readMaterial(env.MTLS_CLIENT_KEY_PATH, "client private key"),
    ca: [readMaterial(env.MTLS_CA_CERT_PATH, "internal CA certificate")],
    minVersion: "TLSv1.3",
    maxVersion: "TLSv1.3",
    rejectUnauthorized: true,
    keepAlive: true,
    keepAliveMsecs: 30000,
    maxSockets: 64,
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
  for (const node of nodes) node.agent.destroy();
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
  node.healthy = false;
  node.failures += 1;
  node.lastFailureAt = now;
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
  return headers;
};

export const consistencyHeader = (lsn?: string): Record<string, string> =>
  lsn !== undefined && lsn.trim().length > 0 ? { "x-pg-min-lsn": lsn } : {};

export const buildCoreHeaders = (options: CoreCallOptions): Record<string, string> => {
  const headers: Record<string, string> = {
    "x-request-id": options.requestId,
    "x-real-client-ip": options.clientIp,
    "x-client-user-agent": options.userAgent ?? "",
    "x-edge-service": CORE_SERVICE_NAME,
    accept: "application/json",
  };
  if (options.authorization) headers.authorization = options.authorization;
  if (options.rawContentType) headers["content-type"] = options.rawContentType;
  else if (options.body !== undefined) headers["content-type"] = "application/json";
  for (const [key, value] of Object.entries(options.headers ?? {})) {
    headers[key.toLowerCase()] = value;
  }
  const lsn = options.minLsn ?? options.consistencyLsn;
  if (lsn !== undefined && lsn.trim().length > 0) headers["x-pg-min-lsn"] = lsn;
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
): ClientRequest => {
  const url = resolveCoreUrlAgainst(node.url, options.path, options.query);
  return https.request({
    agent: node.agent,
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
    let clientRequest: ClientRequest;
    const cleanup = () => {
      if (options.signal) options.signal.removeEventListener("abort", onAbort);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => clientRequest.destroy(abortError());
    try {
      clientRequest = createNodeRequest(node, options, headers);
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
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
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
      if (response.statusCode === 502 || response.statusCode === 503) {
        markNodeFailure(node);
        lastResponse = response;
        lastError = undefined;
        continue;
      }
      markNodeHealthy(node);
      return response;
    } catch (error) {
      markNodeFailure(node);
      lastError = error;
      lastResponse = undefined;
    } finally {
      node.inFlight -= 1;
    }
  }
  if (lastResponse) return lastResponse;
  if (lastError !== undefined) {
    if (!hasSelectableNode(new Set())) throw coreUnavailable();
    throw mapCoreTransportError(lastError);
  }
  throw coreUnavailable();
};

export const callCoreRaw = (options: CoreCallOptions): Promise<CoreResponse> =>
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
      if (stream.statusCode === 502 || stream.statusCode === 503) {
        markNodeFailure(node);
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
      markNodeHealthy(node);
      return stream;
    } catch (error) {
      markNodeFailure(node);
      lastError = error;
    }
  }
  if (lastStream) return lastStream;
  if (lastError !== undefined) {
    if (!hasSelectableNode(new Set())) throw coreUnavailable();
    throw mapCoreTransportError(lastError);
  }
  throw coreUnavailable();
};

export const proxyCoreStream = async (
  req: Request,
  res: Response,
  options: CoreCallOptions,
): Promise<void> => {
  const upstream = await openCoreStream(options);
  if (upstream.statusCode >= 400) {
    const payload = parseJsonBuffer(await drainStream(upstream.stream));
    upstream.abort();
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
  req.on("close", () => upstream.abort());
  upstream.stream.pipe(res);
};
