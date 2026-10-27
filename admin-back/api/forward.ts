import type { Request, Response } from "express";
import { z } from "zod";
import { env } from "../lib/env";
import { parseOrThrow } from "../lib/error";
import { callCoreResponse, type CoreHttpMethod } from "../lib/mtlsClient";
import { parseCidrList, resolveClientIp } from "../lib/net";
import { resolveRequestId } from "../lib/requestLogger";

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
        headers: options.headers,
        requestId: resolveRequestId(req),
        clientIp: resolveClientIp(req, parseCidrList(env.TRUSTED_PROXY_CIDRS)),
        userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : "",
        authorization,
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
    res.status(options.relayStatus === true ? response.status : options.status ?? 200).json(response.body);
  };
