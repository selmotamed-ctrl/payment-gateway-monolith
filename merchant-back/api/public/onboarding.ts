import express, { type Request, type Response } from "express";
import rateLimiter from "express-rate-limit";
import { z } from "zod";
import { env } from "../../lib/env";
import { parseOrThrow } from "../../lib/error";
import { zIdentifier } from "../../lib/zReady";
import { coreForward } from "../forward";
import { forwardUpload, uploadSingle } from "../upload";

const router = express.Router();

const onboardingLimiter = rateLimiter({
  windowMs: 60_000,
  max: () => env.API_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({
      code: "RATE_LIMITED",
      message: "Too many onboarding requests, please retry later",
    });
  },
});

router.use(onboardingLimiter);

const joinRequestSchema = z
  .object({
    legalName: z.string().min(2).max(160).optional(),
    tradeName: z.string().min(2).max(160).optional(),
    country: z.string().min(2).max(2).optional(),
    businessType: z.string().min(2).max(64).optional(),
    registrationNumber: z.string().min(2).max(64).optional(),
    taxNumber: z.string().min(2).max(64).optional(),
    address: z.string().min(4).max(400).optional(),
    phone: z.string().min(6).max(20).optional(),
    email: z.string().min(3).max(160).optional(),
    website: z.string().max(200).optional(),
    locale: z.enum(["ar", "en"]).optional(),
  })
  .strict();

const beneficialOwnerSchema = z
  .object({
    fullName: z.string().min(2).max(160),
    identityType: z.enum(["NATIONAL_ID", "PASSPORT"]),
    identityNumber: z.string().min(4).max(32),
    nationality: z.string().min(2).max(64).optional(),
    dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    ownershipPercent: z.string().regex(/^\d{1,3}(\.\d{1,2})?$/).optional(),
    position: z.string().min(2).max(80).optional(),
  })
  .strict();

const beneficialOwnerParamsSchema = z.object({ id: zIdentifier });

const kybDocumentSchema = z
  .object({
    documentType: z.enum([
      "REGISTRATION_CERTIFICATE",
      "TAX_CERTIFICATE",
      "BANK_LETTER",
      "OWNERSHIP_DEED",
      "IDENTITY_DOCUMENT",
      "OTHER",
    ]),
    reference: z.string().min(1).max(128).optional(),
    issuedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    expiresAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    notes: z.string().max(1000).optional(),
  })
  .strict();

const submitSchema = z
  .object({
    idempotencyKey: z.string().min(8).max(128).optional(),
    acknowledgement: z.literal(true),
  })
  .strict();

router.get(
  "/join-request",
  coreForward({
    method: "GET",
    path: () => "/internal/merchant/onboarding/join-request",
  }),
);

router.put(
  "/join-request",
  coreForward({
    method: "PUT",
    path: () => "/internal/merchant/onboarding/join-request",
    schema: joinRequestSchema,
  }),
);

router.post(
  "/kyb-documents",
  uploadSingle("document"),
  async (req: Request, res: Response) => {
    const metadata = parseOrThrow(kybDocumentSchema, req.body ?? {});
    await forwardUpload(req, res, {
      path: "/internal/merchant/onboarding/kyb-documents",
      fileField: "document",
      metadata,
    });
  },
);

router.get(
  "/beneficial-owners",
  coreForward({
    method: "GET",
    path: () => "/internal/merchant/onboarding/beneficial-owners",
  }),
);

router.post(
  "/beneficial-owners",
  coreForward({
    method: "POST",
    path: () => "/internal/merchant/onboarding/beneficial-owners",
    schema: beneficialOwnerSchema,
    status: 201,
  }),
);

router.delete(
  "/beneficial-owners/:id",
  coreForward({
    method: "DELETE",
    path: (context) =>
      `/internal/merchant/onboarding/beneficial-owners/${encodeURIComponent(context.params.id ?? "")}`,
    paramsSchema: beneficialOwnerParamsSchema,
  }),
);

router.post(
  "/submit",
  coreForward({
    method: "POST",
    path: () => "/internal/merchant/onboarding/submit",
    schema: submitSchema,
  }),
);

export const onboardingRouter = router;
