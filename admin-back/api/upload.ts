import { createHash } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import multer from "multer";
import rateLimiter from "express-rate-limit";
import { lazyLimiter, rateLimitKey } from "../lib/clientIp";
import { env } from "../lib/env";
import { ApiError } from "../lib/error";
import { callCore } from "../lib/mtlsClient";
import { parseCidrList, resolveClientIp } from "../lib/net";
import { resolveRequestId } from "../lib/requestLogger";
import { assertAllowedUpload } from "../lib/zReady";

let uploader: multer.Multer | undefined;

export const getUploader = (): multer.Multer => {
  uploader ??= multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: env.MAX_UPLOAD_BYTES, files: 1, fields: 32 },
  });
  return uploader;
};

/** multipart framing overhead tolerated on top of the file size limit */
const MULTIPART_OVERHEAD_BYTES = 256 * 1024;

const uploadLimiter = lazyLimiter(() =>
  rateLimiter({
    windowMs: env.ADMIN_RATE_LIMIT_WINDOW_MS,
    max: () => env.UPLOAD_RATE_LIMIT_MAX,
    keyGenerator: (req) => rateLimitKey(req, "upload"),
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({ code: "RATE_LIMITED", message: "Too many uploads, please retry later" });
    },
  }),
);

/**
 * Runs BEFORE the multipart parser. multer buffers the whole file in memory before core can look at the
 * credential, so an upload gets its own per-address budget (on top of the general admin limiter), and a
 * declared length above the limit is refused without buffering a single byte. The session was already
 * required to be shaped like a live core session by `requireSession`.
 */
export const uploadGuards: Array<(req: Request, res: Response, next: NextFunction) => void> = [
  uploadLimiter,
  (req, _res, next) => {
    const declared = Number(req.headers["content-length"]);
    // Chunked clients have no Content-Length; multer still enforces the byte limit while streaming.
    if (Number.isFinite(declared) && declared > 0 && declared > env.MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD_BYTES) {
      next(new ApiError(413, "UPLOAD_TOO_LARGE", "The uploaded file exceeds the size limit"));
      return;
    }
    next();
  },
];

export const uploadSingle = (field: string) => (req: Request, res: Response, next: NextFunction) => {
  getUploader()
    .single(field)(req, res, (error: unknown) => {
      if (!error) {
        next();
        return;
      }
      const code = (error as { code?: string })?.code;
      if (code === "LIMIT_FILE_SIZE") {
        next(new ApiError(413, "UPLOAD_TOO_LARGE", "The uploaded statement exceeds the size limit"));
        return;
      }
      if (code === "LIMIT_UNEXPECTED_FILE") {
        next(new ApiError(400, "UPLOAD_UNEXPECTED_FIELD", "Unexpected file field in the multipart payload"));
        return;
      }
      next(new ApiError(400, "UPLOAD_INVALID", "The multipart payload could not be parsed"));
    });
};

export const forwardUpload = async (
  req: Request,
  res: Response,
  options: {
    path: string;
    fileField: string;
    metadata: Record<string, unknown>;
    status?: number;
    body?: unknown;
    headers?: Record<string, string>;
  },
): Promise<void> => {
  const file = req.file as Express.Multer.File | undefined;
  if (!file) {
    throw new ApiError(400, "UPLOAD_REQUIRED", `A statement file is required in the ${options.fileField} field`);
  }
  const allowedMimes = env.UPLOAD_ALLOWED_MIME.split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);
  const detected = assertAllowedUpload(file.buffer, file.mimetype, allowedMimes, env.MAX_UPLOAD_BYTES);
  const payload = await callCore({
    method: "POST",
    path: options.path,
    rawBody: options.body === undefined ? file.buffer : undefined,
    body: options.body,
    rawContentType: options.body === undefined ? "application/octet-stream" : undefined,
    headers: {
      "x-upload-filename": encodeURIComponent(file.originalname.slice(0, 200)),
      "x-upload-content-type": detected,
      "x-upload-sha256": createHash("sha256").update(file.buffer).digest("hex"),
      "x-upload-size": String(file.buffer.byteLength),
      "x-upload-metadata": Buffer.from(JSON.stringify(options.metadata), "utf8").toString("base64url"),
      ...(options.headers ?? {}),
    },
    requestId: resolveRequestId(req),
    clientIp: resolveClientIp(req, parseCidrList(env.TRUSTED_PROXY_CIDRS)),
    userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : "",
    authorization: req.headers.authorization,
    timeoutMs: env.RECONCILIATION_TIMEOUT_MS,
  });
  res.status(options.status ?? 202).json(payload);
};
