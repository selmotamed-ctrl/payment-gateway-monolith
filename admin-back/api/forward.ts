import type { Request, Response } from "express";
import { z } from "zod";
import { env } from "../lib/env";
import { ApiError, parseOrThrow } from "../lib/error";
import { callCoreResponse, callCoreRaw, mapCoreHttpError, parseJsonBuffer, type CoreHttpMethod } from "../lib/mtlsClient";
import { parseCidrList, resolveClientIp } from "../lib/net";
import { resolveRequestId } from "../lib/requestLogger";

/** A postgres LSN as exchanged in `x-pg-min-lsn` (`<hex>/<hex>`). */
const LSN_PATTERN = /^[0-9A-Fa-f]{1,16}\/[0-9A-Fa-f]{1,16}$/;

const minLsnOf = (req: Request): string | undefined => {
  const value = req.header("x-pg-min-lsn");
  if (value === undefined || value.length === 0) return undefined;
  if (!LSN_PATTERN.test(value)) {
    throw new ApiError(400, "INVALID_MIN_LSN", "x-pg-min-lsn must look like <hex>/<hex>");
  }
  return value;
};

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

/** Relays a well formed Idempotency-Key so core can recognise a replayed mutation. */
const withIdempotencyKey = (req: Request, headers: Record<string, string> | undefined) => {
  const key = req.header("idempotency-key");
  if (key === undefined || !IDEMPOTENCY_KEY_PATTERN.test(key)) return headers;
  return { ...(headers ?? {}), "idempotency-key": key };
};

export interface ForwardContext {
  params: Record<string, string>;
  body: unknown;
  query: Record<string, unknown>;
}

export interface ForwardOptions {
  method: CoreHttpMethod;
  path: (context: ForwardContext) => string;
  schema?: z.ZodType;
  paramsSchema?: z.ZodType;
  querySchema?: z.ZodType;
  status?: number;
  /**
   * Translates the validated public body into core's canonical body.
   * The public schema is always applied first, so the frontend contract stays untouched
   * and only the forwarded payload changes.
   */
  bodyFrom?: (req: Request, body: unknown) => unknown;
  /**
   * Expands the validated public body into one core request per element.
   * Used by bulk endpoints where core only accepts a single subject per request.
   */
  splitBodyFrom?: (req: Request, body: unknown) => unknown[];
  headers?: Record<string, string>;
  /**
   * Answers with the status code that core returned instead of the declared
   * one. Used by the routes whose outcome became asynchronous.
   */
  relayStatus?: boolean;
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

export const coreForwardRaw =
  (options: Omit<ForwardOptions, "status" | "relayStatus" | "splitBodyFrom">) =>
  async (req: Request, res: Response): Promise<void> => {
    const authorization = req.headers.authorization;
    const params = options.paramsSchema
      ? (parseOrThrow(options.paramsSchema, req.params) as Record<string, string>)
      : (req.params as Record<string, string>);
    const query = options.querySchema
      ? (parseOrThrow(options.querySchema, req.query) as Record<string, unknown>)
      : undefined;
    const rawBody = req.method === "GET" || req.method === "HEAD" ? undefined : (req.body ?? {});
    const publicBody = options.schema && rawBody !== undefined ? parseOrThrow(options.schema, rawBody) : rawBody;
    const body = options.bodyFrom ? options.bodyFrom(req, publicBody) : publicBody;
    const response = await callCoreRaw({
      method: options.method,
      path: options.path({ params, body, query: query ?? {} }),
      body,
      query: scalarQuery(query),
      headers: withIdempotencyKey(req, options.headers),
      requestId: resolveRequestId(req),
      clientIp: resolveClientIp(req, parseCidrList(env.TRUSTED_PROXY_CIDRS)),
      userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : "",
      authorization,
      minLsn: minLsnOf(req),
    });
    if (response.statusCode >= 400) {
      throw mapCoreHttpError(response.statusCode, parseJsonBuffer(response.body));
    }
    for (const header of ["content-type", "content-disposition", "x-content-sha256", "x-pg-served-by", "x-pg-min-lsn"]) {
      const value = response.headers[header];
      if (typeof value === "string" && value.length > 0) res.setHeader(header, value);
    }
    res.status(response.statusCode).send(response.body);
  };

export const coreForward =
  (options: ForwardOptions) =>
  async (req: Request, res: Response): Promise<void> => {
    const authorization = req.headers.authorization;
    const params = options.paramsSchema
      ? (parseOrThrow(options.paramsSchema, req.params) as Record<string, string>)
      : (req.params as Record<string, string>);
    const query = options.querySchema
      ? (parseOrThrow(options.querySchema, req.query) as Record<string, unknown>)
      : undefined;
    const rawBody =
      req.method === "GET" || req.method === "HEAD" ? undefined : (req.body ?? {});
    const publicBody =
      options.schema && rawBody !== undefined ? parseOrThrow(options.schema, rawBody) : rawBody;
    const call = (path: string, body: unknown) =>
      callCoreResponse({
        method: options.method,
        path,
        body,
        query: scalarQuery(query),
        headers: withIdempotencyKey(req, options.headers),
        requestId: resolveRequestId(req),
        clientIp: resolveClientIp(req, parseCidrList(env.TRUSTED_PROXY_CIDRS)),
        userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : "",
        authorization,
        minLsn: minLsnOf(req),
      });

    if (options.splitBodyFrom) {
      const parts = options.splitBodyFrom(req, publicBody);
      const results: unknown[] = [];
      for (const part of parts) {
        results.push(await call(options.path({ params, body: part, query: query ?? {} }), part));
      }
      res.status(options.status ?? 200).json(results);
      return;
    }

    const body = options.bodyFrom ? options.bodyFrom(req, publicBody) : publicBody;
    const response = await call(options.path({ params, body, query: query ?? {} }), body);
    for (const header of ["x-pg-served-by", "x-pg-min-lsn"]) {
      const value = response.headers[header];
      if (typeof value === "string" && value.length > 0) res.setHeader(header, value);
    }
    res.status(options.relayStatus === true ? response.status : options.status ?? 200).json(response.body);
  };
