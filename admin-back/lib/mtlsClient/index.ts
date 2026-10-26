import fs from "node:fs";
import https from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import type { ClientRequest } from "node:http";
import type { Readable } from "node:stream";
import type { Request, Response } from "express";
import { env } from "../env";
import { ApiError } from "../error";
import { isValidIp } from "../net";

export const CORE_SERVICE_NAME = "admin-back";
export const CORE_CHANNEL_PREFIX = "/internal/admin";

export type CoreHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

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
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("://") || path.includes("\\")) {
    throw new ApiError(500, "CORE_PATH_INVALID", "Core path must be a rooted absolute path");
  }
  const segments = path.split("/");
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

export const resolveCoreUrl = (
  path: string,
  query?: Record<string, string | number | boolean | null | undefined>,
): URL => {
  const safePath = assertCorePath(path);
  const base = new URL(env.CORE_BACK_URL);
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

const readMaterial = (path: string, label: string): Buffer => {
  try {
    return fs.readFileSync(path);
  } catch {
    throw new ApiError(500, "MTLS_MATERIAL_UNAVAILABLE", `Unable to load ${label} material`);
  }
};

let agent: https.Agent | undefined;

export const getCoreAgent = (): https.Agent => {
  if (!agent) {
    agent = new https.Agent({
      cert: readMaterial(env.MTLS_CLIENT_CERT_PATH, "client certificate"),
      key: readMaterial(env.MTLS_CLIENT_KEY_PATH, "client private key"),
      ca: [readMaterial(env.MTLS_CA_CERT_PATH, "internal CA certificate")],
      minVersion: "TLSv1.3",
      maxVersion: "TLSv1.3",
      rejectUnauthorized: true,
      keepAlive: true,
      keepAliveMsecs: 30000,
      maxSockets: 64,
    });
  }
  return agent;
};

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
  return headers;
};

const serializeBody = (options: CoreCallOptions): Buffer | undefined => {
  if (options.rawBody) return options.rawBody;
  if (options.body !== undefined) return Buffer.from(JSON.stringify(options.body), "utf8");
  return undefined;
};

const createCoreRequest = (
  options: CoreCallOptions,
  headers: Record<string, string>,
): ClientRequest => {
  const url = resolveCoreUrl(options.path, options.query);
  return https.request({
    agent: getCoreAgent(),
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

const timeoutError = () =>
  Object.assign(new Error("core request timeout"), { code: "ETIMEDOUT" });

export const callCoreRaw = (options: CoreCallOptions): Promise<CoreResponse> =>
  new Promise<CoreResponse>((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(mapCoreTransportError(error));
    };
    let clientRequest: ClientRequest;
    try {
      clientRequest = createCoreRequest(options, buildCoreHeaders(options));
    } catch (error) {
      fail(error);
      return;
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
        resolve({
          statusCode: response.statusCode ?? 502,
          headers: response.headers,
          body: Buffer.concat(chunks),
        });
      });
      response.on("error", fail);
    });
    const payload = serializeBody(options);
    if (payload) clientRequest.write(payload);
    clientRequest.end();
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

export const callCore = async <T = unknown>(options: CoreCallOptions): Promise<T> => {
  const response = await callCoreRaw(options);
  const payload = parseJsonBuffer(response.body);
  if (response.statusCode >= 400) {
    throw mapCoreHttpError(response.statusCode, payload);
  }
  return payload as T;
};

export const openCoreStream = (options: CoreCallOptions): Promise<CoreStream> =>
  new Promise<CoreStream>((resolve, reject) => {
    let settled = false;
    let clientRequest: ClientRequest;
    const headers = buildCoreHeaders(options);
    headers.accept = "text/event-stream";
    headers["cache-control"] = "no-cache";
    try {
      clientRequest = createCoreRequest(options, headers);
    } catch (error) {
      reject(mapCoreTransportError(error));
      return;
    }
    clientRequest.on("timeout", () => clientRequest.destroy(timeoutError()));
    clientRequest.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(mapCoreTransportError(error));
    });
    clientRequest.on("response", (response) => {
      if (settled) return;
      settled = true;
      resolve({
        statusCode: response.statusCode ?? 502,
        headers: response.headers,
        stream: response as unknown as Readable,
        abort: () => clientRequest.destroy(),
      });
    });
    clientRequest.end();
  });

const drainStream = async (stream: Readable): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks);
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
