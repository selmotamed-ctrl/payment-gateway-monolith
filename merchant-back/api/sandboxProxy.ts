import express, { type Request, type Response } from "express";
import { callCore, callCoreRaw, callCoreResponse, proxyCoreStream } from "../lib/mtlsClient";
import { requireSandboxCoreBackUrls } from "../lib/corePools";
import { uploadGuards, uploadSingleAny } from "./upload";
import { createHash } from "node:crypto";
import { resolveRequestId } from "../lib/requestLogger";
import { resolveClientIp, parseCidrList } from "../lib/net";
import { env } from "../lib/env";

/**
 * `/api/v1/merchant/sandbox/*` — the Sandbox Studio API namespace.
 *
 * Every call is forwarded to `pg-core-sandbox` (`payment_gateway_sandbox`).
 * It can NEVER fall back to `pg-core-back`: when the sandbox pool is not
 * configured the route answers `503 SANDBOX_NODE_UNAVAILABLE`.
 *
 * The sandbox core accepts the same signed merchant session as Live and
 * mirrors the merchant envelope into its own database on first use, so the
 * merchant does not need a second login.
 */
const router = express.Router();

const proxyPath = (subPath: string): string => {
  if (subPath.startsWith("/fake-rails/")) return `/internal/sandbox${subPath}`;
  // Studio-only control routes and the richer sandbox detail/reconciliation
  // handlers live in pg-core-sandbox's sandbox router. List/create routes keep
  // the Live merchant router (same code, separate database) so the Studio has
  // full parity with the merchant portal.
  if (
    subPath === "/overview"
    || subPath.startsWith("/studio/")
    || subPath === "/seed-demo"
    || subPath === "/seed-history"
    || subPath === "/reset"
    || subPath === "/webhooks/test-ping"
    || /^\/wallets\/[^/]+(\/|$)/.test(subPath)
    || /^\/payments\/[^/]+(\/|$)/.test(subPath)
    || /^\/disputes\/[^/]+\/resolve$/.test(subPath)
    || subPath.startsWith("/reconciliation/")
  ) {
    return `/internal/sandbox/merchant${subPath}`;
  }
  return `/internal/merchant${subPath}`;
};

router.post(
  "/mirror/disputes/:id/attachments",
  ...uploadGuards,
  uploadSingleAny(["file", "evidence"]),
  async (req: Request, res: Response) => {
    const authorization = req.headers.authorization;
    if (!authorization) {
      res.status(401).json({ code: "AUTH_REQUIRED", message: "A bearer token is required for this endpoint" });
      return;
    }
    const file = req.file;
    if (!file) {
      res.status(400).json({ code: "UPLOAD_REQUIRED", message: "An evidence file is required" });
      return;
    }
    const label = String(typeof req.body?.label === "string" ? req.body.label : file.originalname).slice(0, 255);
    const payload = await callCore({
      targetUrls: requireSandboxCoreBackUrls(),
      method: "POST",
      path: `/internal/merchant/disputes/${encodeURIComponent(String(req.params.id ?? ""))}/attachments`,
      rawBody: file.buffer,
      rawContentType: "application/octet-stream",
      headers: {
        "x-execution-plane": "SANDBOX",
        "x-sandbox-proxy": "merchant-back",
        "x-upload-filename": encodeURIComponent(file.originalname.slice(0, 200)),
        "x-upload-content-type": file.mimetype,
        "x-upload-sha256": createHash("sha256").update(file.buffer).digest("hex"),
        "x-upload-size": String(file.buffer.byteLength),
        "x-upload-metadata": Buffer.from(JSON.stringify({ label }), "utf8").toString("base64url"),
      },
      requestId: resolveRequestId(req),
      clientIp: resolveClientIp(req, parseCidrList(env.TRUSTED_PROXY_CIDRS)),
      userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : "",
      authorization,
    });
    res.status(201).json(payload);
  },
);

router.use(async (req: Request, res: Response) => {
  const targetUrls = requireSandboxCoreBackUrls();
  const authorization = req.headers.authorization;
  if (!authorization) {
    res.status(401).json({ code: "AUTH_REQUIRED", message: "A bearer token is required for this endpoint" });
    return;
  }
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : (req.body ?? {});
  const subPath = req.path === "/" ? "" : req.path;
  if (subPath === "/mirror" || subPath.startsWith("/mirror/")) {
    const mirrorPath = subPath.slice("/mirror".length) || "/";
    if (/^\/pos\/screens\/[^/]+\/stream$/.test(mirrorPath)) {
      await proxyCoreStream(req, res, {
        targetUrls,
        method: "GET",
        path: `/internal/merchant${mirrorPath}`,
        requestId: resolveRequestId(req),
        clientIp: resolveClientIp(req, parseCidrList(env.TRUSTED_PROXY_CIDRS)),
        userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : "",
        authorization,
      });
      return;
    }
    const mirrorResponse = await callCoreRaw({
      targetUrls,
      method: req.method as never,
      path: `/internal/merchant${mirrorPath}`,
      body: Buffer.isBuffer(req.body) ? undefined : body,
      rawBody: Buffer.isBuffer(req.body) ? req.body : undefined,
      rawContentType: Buffer.isBuffer(req.body) ? req.headers["content-type"] : undefined,
      query: req.query as Record<string, string | number | boolean | null | undefined>,
      headers: {
        "x-execution-plane": "SANDBOX",
        "x-sandbox-proxy": "merchant-back",
      },
      requestId: resolveRequestId(req),
      clientIp: resolveClientIp(req, parseCidrList(env.TRUSTED_PROXY_CIDRS)),
      userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : "",
      authorization,
    });
    const contentType = mirrorResponse.headers["content-type"];
    if (typeof contentType === "string") res.setHeader("content-type", contentType);
    const disposition = mirrorResponse.headers["content-disposition"];
    if (typeof disposition === "string") res.setHeader("content-disposition", disposition);
    res.status(mirrorResponse.statusCode).send(mirrorResponse.body);
    return;
  }
  const response = await callCoreResponse({
    targetUrls,
    method: req.method as never,
    path: proxyPath(subPath),
    body,
    query: req.query as Record<string, string | number | boolean | null | undefined>,
    headers: {
      "x-execution-plane": "SANDBOX",
      "x-sandbox-proxy": "merchant-back",
    },
    requestId: resolveRequestId(req),
    clientIp: resolveClientIp(req, parseCidrList(env.TRUSTED_PROXY_CIDRS)),
    userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : "",
    authorization,
  });
  for (const header of ["x-pg-served-by", "x-pg-min-lsn"]) {
    const value = response.headers[header];
    if (typeof value === "string" && value.length > 0) res.setHeader(header, value);
  }
  res.status(response.status).json(response.body);
});

export const sandboxProxyRouter = router;
