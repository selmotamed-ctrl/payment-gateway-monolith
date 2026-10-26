import type { Request, Response } from "express";
import { z } from "zod";
import { env } from "../lib/env";
import { parseOrThrow } from "../lib/error";
import { callCore, type CoreHttpMethod } from "../lib/mtlsClient";
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
  bodyFrom?: (req: Request) => unknown;
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
    let body: unknown = options.bodyFrom
      ? options.bodyFrom(req)
      : req.method === "GET" || req.method === "HEAD"
        ? undefined
        : (req.body ?? {});
    if (options.schema && body !== undefined) {
      body = parseOrThrow(options.schema, body);
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
