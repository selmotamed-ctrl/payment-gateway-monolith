import express from "express";
import { z } from "zod";
import { zIdentifier } from "../../lib/zReady";
import { coreForward } from "../forward";

const router = express.Router();

const idParamsSchema = z.object({ id: zIdentifier });

const assetCreateSchema = z
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
    status: 201,
  }),
);

router.get(
  "/:id",
  coreForward({
    method: "GET",
    path: (context) => `/internal/admin/assets/${encodeURIComponent(context.params.id ?? "")}`,
    paramsSchema: idParamsSchema,
  }),
);

export const assetsRouter = router;
