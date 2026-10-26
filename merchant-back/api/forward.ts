import type { Request, Response } from "express";
import { z } from "zod";
import { env } from "../lib/env";
import { ApiError, parseOrThrow } from "../lib/error";
import { callCore, type CoreCallOptions, type CoreHttpMethod } from "../lib/mtlsClient";
import { parseCidrList, resolveClientIp } from "../lib/net";
import { resolveRequestId } from "../lib/requestLogger";
import type { PublicPayload } from "./contract";

export interface ForwardContext {
  params: Record<string, string>;
  body: unknown;
  query: Record<string, unknown>;
}

export interface ForwardOptions {
  method: CoreHttpMethod;
  path: (context: ForwardContext) => string;
  /**
   * Public (frontend) contract: validated against the incoming request body.
   */
  schema?: z.ZodType;
  /**
   * Canonical core contract: validated against the payload that is forwarded
   * to `core-back`, so a request is never sent that core would reject.
   */
  coreSchema?: z.ZodType;
  paramsSchema?: z.ZodType;
  querySchema?: z.ZodType;
  status?: number;
  requireAuth?: boolean;
  /**
   * Replaces the forwarded body entirely (raw or multipart payloads).
   */
  bodyFrom?: (req: Request) => unknown;
  /**
   * Translates the validated public payload into the canonical core payload.
   */
  bodyMapper?: (body: PublicPayload) => unknown;
  headers?: Record<string, string>;
}

const scalarQuery = (query: Record<string, unknown> | undefined) => {
  if (!query) return undefined;
  const result: Record<string, string | number | boolean | undefined> = {};
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      result[key] = value;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
};

export const requireBearer = (req: Request): string => {
  const authorization = req.headers.authorization;
  if (!authorization) {
    throw new ApiError(401, "AUTH_REQUIRED", "A bearer token is required for this endpoint");
  }
  return authorization;
};

/**
 * Shared call metadata (request id, client ip, user agent, credentials) used by
 * every call towards `core-back`.
 */
export const coreCallContext = (
  req: Request,
): Omit<CoreCallOptions, "method" | "path" | "body"> => ({
  requestId: resolveRequestId(req),
  clientIp: resolveClientIp(req, parseCidrList(env.TRUSTED_PROXY_CIDRS)),
  userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : "",
  authorization: req.headers.authorization,
});

export const coreForward =
  (options: ForwardOptions) =>
  async (req: Request, res: Response): Promise<void> => {
    const authorization = req.headers.authorization;
    if (options.requireAuth !== false && !authorization) {
      throw new ApiError(401, "AUTH_REQUIRED", "A bearer token is required for this endpoint");
    }
    const params = options.paramsSchema
      ? (parseOrThrow(options.paramsSchema, req.params) as Record<string, string>)
      : (req.params as Record<string, string>);
    const query = options.querySchema
      ? (parseOrThrow(options.querySchema, req.query) as Record<string, unknown>)
      : undefined;
    const isRead = req.method === "GET" || req.method === "HEAD";
    const rawBody = isRead ? undefined : (req.body ?? {});
    const publicBody =
      options.schema && rawBody !== undefined ? parseOrThrow(options.schema, rawBody) : rawBody;
    let body: unknown = options.bodyMapper
      ? options.bodyMapper((publicBody ?? {}) as PublicPayload)
      : publicBody;
    if (options.bodyFrom) {
      body = options.bodyFrom(req);
    }
    if (options.coreSchema && body !== undefined) {
      body = parseOrThrow(options.coreSchema, body);
    }
    const payload = await callCore({
      method: options.method,
      path: options.path({ params, body, query: query ?? {} }),
      body,
      query: scalarQuery(query),
      headers: options.headers,
      requestId: resolveRequestId(req),
      clientIp: resolveClientIp(req, parseCidrList(env.TRUSTED_PROXY_CIDRS)),
      userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : "",
      authorization,
    });
    res.status(options.status ?? 200).json(payload);
  };

export const coreProxyStream =
  (options: { method: CoreHttpMethod; path: (context: ForwardContext) => string; paramsSchema?: z.ZodType }) =>
  async (req: Request, res: Response): Promise<void> => {
    const authorization = req.headers.authorization;
    if (!authorization) {
      throw new ApiError(401, "AUTH_REQUIRED", "A bearer token is required for this endpoint");
    }
    const params = options.paramsSchema
      ? (parseOrThrow(options.paramsSchema, req.params) as Record<string, string>)
      : (req.params as Record<string, string>);
    const { proxyCoreStream } = await import("../lib/mtlsClient");
    await proxyCoreStream(req, res, {
      method: options.method,
      path: options.path({ params, body: undefined, query: {} }),
      requestId: resolveRequestId(req),
      clientIp: resolveClientIp(req, parseCidrList(env.TRUSTED_PROXY_CIDRS)),
      userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : "",
      authorization,
      timeoutMs: env.POS_STREAM_TIMEOUT_MS,
    });
  };
