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

/**
 * The checkout help & support configuration (read by the checkout help center).
 * Kept on the same router as the platform settings it belongs to.
 */
export const checkoutSupportSchema = z
  .object({
    enabled: z.boolean(),
    show_platform_contact: z.boolean().optional(),
    show_merchant_contact: z.boolean().optional(),
    support_phone: z.string().max(40).optional(),
    support_whatsapp: z.string().max(40).optional(),
    support_email: z.string().max(160).optional(),
    working_hours_ar: z.string().max(300).optional(),
    working_hours_en: z.string().max(300).optional(),
    faq_items: z
      .array(
        z
          .object({
            q_ar: z.string().max(1000),
            a_ar: z.string().max(4000),
            q_en: z.string().max(1000),
            a_en: z.string().max(4000),
          })
          .strict(),
      )
      .max(50)
      .optional(),
  })
  .strict();

router.get(
  "/checkout-support",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/settings/checkout-support",
  }),
);

router.put(
  "/checkout-support",
  coreForward({
    method: "PUT",
    path: () => "/internal/admin/settings/checkout-support",
    schema: checkoutSupportSchema,
    bodyFrom: (_req, body) => ({ value: body }),
  }),
);

export const settingsRouter = router;
