import express from "express";
import { z } from "zod";
import { zJsonObject } from "../../lib/zReady";
import { toCoreSettingsUpdate } from "../contract";
import { coreForward } from "../forward";

const router = express.Router();

export const settingsUpdateSchema = z
  .object({
    settings: zJsonObject,
    baseVersion: z.number().int().min(1).optional(),
    reason: z.string().min(3).max(500).optional(),
  })
  .strict();

router.get(
  "/",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/settings",
  }),
);

router.put(
  "/",
  coreForward({
    method: "PUT",
    path: () => "/internal/admin/settings",
    schema: settingsUpdateSchema,
    bodyFrom: (_req, body) => toCoreSettingsUpdate(body),
  }),
);

export const settingsRouter = router;
