import { createHash } from "node:crypto";
import express, { type Request, type Response } from "express";
import { z } from "zod";
import { env } from "../../lib/env";
import { ApiError, parseOrThrow } from "../../lib/error";
import { zIdentifier } from "../../lib/zReady";
import { callCore, callCoreRaw, mapCoreHttpError, parseJsonBuffer } from "../../lib/mtlsClient";
import { parseCidrList, resolveClientIp } from "../../lib/net";
import { resolveRequestId } from "../../lib/requestLogger";
import { toCoreAssetCreate } from "../contract";
import { coreForward } from "../forward";
import { uploadGuards, uploadSingle } from "../upload";

const router = express.Router();

const idParamsSchema = z.object({ id: zIdentifier });

export const assetCreateSchema = z
  .object({
    kind: z.enum(["LOGO", "ICON", "DOCUMENT", "QR_TEMPLATE", "STATIC_FILE"]),
    name: z.string().min(1).max(160),
    contentType: z.string().min(3).max(120),
    storageKey: z.string().min(1).max(400),
    sizeBytes: z.number().int().min(0).max(104857600).optional(),
    checksumSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    metadata: z.record(z.string().max(64), z.unknown()).optional(),
  })
  .strict();

router.get(
  "/",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/assets",
  }),
);

router.post(
  "/",
  coreForward({
    method: "POST",
    path: () => "/internal/admin/assets",
    schema: assetCreateSchema,
    bodyFrom: (_req, body) => toCoreAssetCreate(body),
    status: 201,
  }),
);

const ASSET_CONTENT_TYPES = new Set(["image/png", "image/svg+xml"]);

/** PNG magic or a text SVG container; anything else is refused before it reaches core. */
const detectBrandAssetMime = (buffer: Buffer): "image/png" | "image/svg+xml" => {
  if (buffer.byteLength === 0) throw new ApiError(400, "UPLOAD_EMPTY", "The uploaded asset is empty");
  if (buffer.byteLength > 5 * 1024 * 1024) {
    throw new ApiError(413, "UPLOAD_TOO_LARGE", "Brand assets must be 5 MiB or smaller");
  }
  if (
    buffer.byteLength >= 8
    && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47
    && buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a
  ) {
    return "image/png";
  }
  const text = buffer.subarray(0, Math.min(buffer.byteLength, 4096)).toString("utf8").trimStart();
  if (text.startsWith("<svg") || (text.startsWith("<?xml") && text.includes("<svg"))) {
    return "image/svg+xml";
  }
  throw new ApiError(415, "UNSUPPORTED_UPLOAD_TYPE", "Brand assets must be a PNG or SVG image");
};

router.post(
  "/upload",
  ...uploadGuards,
  uploadSingle("file"),
  async (req: Request, res: Response): Promise<void> => {
    const file = req.file;
    if (!file) throw new ApiError(400, "UPLOAD_REQUIRED", "An asset file is required");
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    if (name.length < 1 || name.length > 120) {
      throw new ApiError(400, "ASSET_NAME_INVALID", "The asset name must be 1-120 characters");
    }
    // Brand assets are only PNG or SVG, and the SVG active-content check runs in core.
    const detected = detectBrandAssetMime(file.buffer);
    const payload = await callCore({
      method: "POST",
      path: "/internal/admin/assets/upload",
      rawBody: file.buffer,
      rawContentType: "application/octet-stream",
      headers: {
        "x-upload-filename": encodeURIComponent(file.originalname.slice(0, 200)),
        "x-upload-content-type": detected,
        "x-upload-sha256": createHash("sha256").update(file.buffer).digest("hex"),
        "x-upload-size": String(file.buffer.byteLength),
        "x-upload-metadata": Buffer.from(JSON.stringify({ name }), "utf8").toString("base64url"),
      },
      requestId: resolveRequestId(req),
      clientIp: resolveClientIp(req, parseCidrList(env.TRUSTED_PROXY_CIDRS)),
      userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : "",
      authorization: req.headers.authorization,
    });
    res.status(201).json(payload);
  },
);

router.get("/:id/content", async (req: Request, res: Response): Promise<void> => {
  const { id } = parseOrThrow(idParamsSchema, req.params);
  const upstream = await callCoreRaw({
    method: "GET",
    path: `/internal/admin/assets/${encodeURIComponent(id)}/content`,
    requestId: resolveRequestId(req),
    clientIp: resolveClientIp(req, parseCidrList(env.TRUSTED_PROXY_CIDRS)),
    userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : "",
    authorization: req.headers.authorization,
  });
  if (upstream.statusCode >= 400) {
    throw mapCoreHttpError(upstream.statusCode, parseJsonBuffer(upstream.body));
  }
  const contentType = upstream.headers["content-type"];
  const baseType = typeof contentType === "string" ? (contentType.split(";")[0] ?? "").trim().toLowerCase() : "";
  res.setHeader("Content-Type", ASSET_CONTENT_TYPES.has(baseType) ? baseType : "application/octet-stream");
  res.setHeader("Content-Disposition", "inline");
  res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
  res.setHeader("Cache-Control", "private, max-age=300");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.status(upstream.statusCode).send(upstream.body);
});

router.get(
  "/:id",
  coreForward({
    method: "GET",
    path: (context) => `/internal/admin/assets/${encodeURIComponent(context.params.id ?? "")}`,
    paramsSchema: idParamsSchema,
  }),
);

export const assetsRouter = router;
