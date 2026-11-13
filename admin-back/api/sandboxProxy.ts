import express, { type Request, type Response } from "express";
import { z } from "zod";
import { callCoreRaw, callCoreResponse } from "../lib/mtlsClient";
import { requireSandboxCoreBackUrls } from "../lib/corePools";
import { parseOrThrow } from "../lib/error";
import { resolveRequestId } from "../lib/requestLogger";
import { resolveClientIp, parseCidrList } from "../lib/net";
import { env } from "../lib/env";

const router = express.Router();

const merchantParams = z.object({ merchantId: z.string().uuid() });

export const targetPath = (request: Request): string => {
  if (request.path === "/mirror" || request.path.startsWith("/mirror/")) {
    return `/internal/admin${request.path.slice("/mirror".length) || "/"}`;
  }
  if (request.path === "/overview") return "/internal/sandbox/admin/overview";
  if (request.path === "/global-reset") return "/internal/sandbox/admin/reset";
  if (/^\/merchants\/[^/]+\/overview$/.test(request.path)) {
    const merchantId = request.path.split("/")[2] ?? "";
    const { merchantId: parsed } = parseOrThrow(merchantParams, { merchantId });
    return `/internal/sandbox/admin/merchants/${encodeURIComponent(parsed)}/overview`;
  }
  if (request.path === "/reset") {
    const { merchantId } = parseOrThrow(merchantParams, request.body ?? {});
    return `/internal/sandbox/merchant/reset?merchantId=${encodeURIComponent(merchantId)}`;
  }
  if (/^\/wallet-balance\/[^/]+$/.test(request.path)) {
    const walletId = request.path.split("/").pop()!;
    return `/internal/sandbox/merchant/wallets/${encodeURIComponent(walletId)}/balance`;
  }
  if (request.path.startsWith("/fake-rails/")) return `/internal/sandbox${request.path}`;
  if (/^\/merchants\/[^/]+\/seed$/.test(request.path)) {
    const merchantId = request.path.split("/")[2] ?? "";
    const { merchantId: parsed } = parseOrThrow(merchantParams, { merchantId });
    return `/internal/sandbox/merchant/seed-demo?merchantId=${encodeURIComponent(parsed)}`;
  }
  if (/^\/merchants\/[^/]+\/seed-history$/.test(request.path)) {
    const merchantId = request.path.split("/")[2] ?? "";
    const { merchantId: parsed } = parseOrThrow(merchantParams, { merchantId });
    return `/internal/sandbox/merchant/seed-history?merchantId=${encodeURIComponent(parsed)}`;
  }
  if (request.path === "/global-reset") return "/internal/sandbox/admin/reset";
  if (request.path === "/audits" || request.path.startsWith("/audits/")) {
    return `/internal/sandbox/admin${request.path}`;
  }
  if (request.path.startsWith("/merchants")) return `/internal/sandbox/admin${request.path}`;
  return `/internal/sandbox/admin${request.path}`;
};

/**
 * `/api/v1/admin/sandbox/*` — staff inspection and control of the isolated
 * Sandbox plane. It always targets `pg-core-sandbox`; there is no Live
 * fallback. The admin session is mirrored into the sandbox database by core.
 */
router.use(async (req: Request, res: Response) => {
  const authorization = req.headers.authorization;
  if (!authorization) {
    res.status(401).json({ code: "AUTH_REQUIRED", message: "A bearer token is required for this endpoint" });
    return;
  }
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : (req.body ?? {});
  if (req.path === "/mirror" || req.path.startsWith("/mirror/")) {
    const response = await callCoreRaw({
      targetUrls: requireSandboxCoreBackUrls(),
      method: req.method as never,
      path: targetPath(req),
      body: Buffer.isBuffer(req.body) ? undefined : body,
      rawBody: Buffer.isBuffer(req.body) ? req.body : undefined,
      rawContentType: Buffer.isBuffer(req.body) ? req.headers["content-type"] : undefined,
      query: req.query as Record<string, string | number | boolean | null | undefined>,
      headers: {
        "x-execution-plane": "SANDBOX",
        "x-sandbox-proxy": "admin-back",
      },
      requestId: resolveRequestId(req),
      clientIp: resolveClientIp(req, parseCidrList(env.TRUSTED_PROXY_CIDRS)),
      userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : "",
      authorization,
    });
    const contentType = response.headers["content-type"];
    if (typeof contentType === "string") res.setHeader("content-type", contentType);
    const disposition = response.headers["content-disposition"];
    if (typeof disposition === "string") res.setHeader("content-disposition", disposition);
    res.status(response.statusCode).send(response.body);
    return;
  }
  // Merchant reset identifies the merchant in the query; the sandbox router
  // rejects unknown body fields, so do not forward the admin-only selector.
  const forwardBody = req.path === "/reset" && req.method === "POST" ? {} : body;
  const response = await callCoreResponse({
    targetUrls: requireSandboxCoreBackUrls(),
    method: req.method as never,
    path: targetPath(req),
    body: forwardBody,
    query: req.query as Record<string, string | number | boolean | null | undefined>,
    headers: {
      "x-execution-plane": "SANDBOX",
      "x-sandbox-proxy": "admin-back",
      ...(typeof req.body?.merchantId === "string" ? { "x-sandbox-merchant-id": req.body.merchantId } : {}),
      ...(typeof req.query.merchantId === "string" ? { "x-sandbox-merchant-id": req.query.merchantId } : {}),
      ...(typeof req.header("x-sandbox-merchant-id") === "string"
        ? { "x-sandbox-merchant-id": req.header("x-sandbox-merchant-id")! }
        : {}),
    },
    requestId: resolveRequestId(req),
    clientIp: resolveClientIp(req, parseCidrList(env.TRUSTED_PROXY_CIDRS)),
    userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : "",
    authorization,
  });
  res.status(response.status).json(response.body);
});

export const sandboxProxyRouter = router;
