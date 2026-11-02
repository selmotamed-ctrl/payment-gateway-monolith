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
    checklist: z
      .array(
        z.enum([
          "KEY_SCOPE_VERIFIED",
          "VALUE_SCHEMA_REVIEWED",
          "EFFECTIVE_DATE_REVIEWED",
          "IMMUTABLE_VERSION_ACKNOWLEDGED",
        ]),
      )
      .max(10)
      .optional(),
  })
  .strict();

router.get(
  "/",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/settings",
  }),
);

export const restorePreviewSchema = z.object({ backup: z.unknown() }).strict();

router.post(
  "/restore-preview",
  coreForward({
    method: "POST",
    path: () => "/internal/admin/settings/restore-preview",
    schema: restorePreviewSchema,
  }),
);

export const restoreApplySchema = z
  .object({
    confirm: z.literal(true),
    reason: z.string().min(3).max(500),
    checklist: z
      .array(
        z.enum([
          "BACKUP_REVIEWED",
          "INVALID_ENTRIES_CLEARED",
          "VERSION_CONFLICTS_REVIEWED",
          "RESTORE_SCOPE_CONFIRMED",
        ]),
      )
      .max(10)
      .optional(),
    backup: z
      .object({
        settings: z
          .array(
            z
              .object({
                key: z.string().min(1).max(120),
                scope: z.string().max(40).optional(),
                valueJson: z.record(z.string().max(64), z.unknown()),
                expectedCurrentVersion: z.number().int().min(0),
                effectiveFrom: z.string().max(64).optional(),
              })
              .strict(),
          )
          .min(1)
          .max(100),
      })
      .strict(),
  })
  .strict();

router.post(
  "/restore-apply",
  coreForward({
    method: "POST",
    path: () => "/internal/admin/settings/restore-apply",
    schema: restoreApplySchema,
  }),
);

router.get(
  "/export",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/settings/export",
  }),
);

router.get(
  "/summary",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/settings/summary",
  }),
);

router.get(
  "/summary/export",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/settings/summary/export",
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
    checklist: z
      .array(
        z.enum([
          "SUPPORT_CHANNELS_VERIFIED",
          "FAQ_CONTENT_REVIEWED",
          "WORKING_HOURS_VERIFIED",
          "PAYER_VISIBILITY_REVIEWED",
        ]),
      )
      .max(10)
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

router.get(
  "/checkout-support/history",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/settings/checkout-support/history",
  }),
);

router.get(
  "/checkout-support/summary",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/settings/checkout-support/summary",
  }),
);

router.get(
  "/checkout-support/summary/export",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/settings/checkout-support/summary/export",
  }),
);

router.put(
  "/checkout-support",
  coreForward({
    method: "PUT",
    path: () => "/internal/admin/settings/checkout-support",
    schema: checkoutSupportSchema,
    bodyFrom: (_req, body) => {
      const { checklist, ...value } = body as Record<string, unknown>;
      return checklist === undefined ? { value } : { value, checklist };
    },
  }),
);

export const settingsRouter = router;
