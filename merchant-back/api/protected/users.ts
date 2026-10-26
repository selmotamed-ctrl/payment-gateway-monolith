import express from "express";
import { z } from "zod";
import { zEmail, zIdentifier, zPhone } from "../../lib/zReady";
import { coreForward } from "../forward";

const router = express.Router();

const userParamsSchema = z.object({ id: zIdentifier });

const userCreateSchema = z
  .object({
    email: zEmail,
    phone: zPhone.optional(),
    fullName: z.string().min(2).max(120),
    role: z.enum(["MERCHANT_ADMIN", "MERCHANT_STAFF", "MERCHANT_CASHIER"]),
    locale: z.enum(["ar", "en"]).optional(),
  })
  .strict();

const userPatchSchema = z
  .object({
    fullName: z.string().min(2).max(120).optional(),
    role: z.enum(["MERCHANT_ADMIN", "MERCHANT_STAFF", "MERCHANT_CASHIER"]).optional(),
    status: z.enum(["ACTIVE", "SUSPENDED"]).optional(),
    locale: z.enum(["ar", "en"]).optional(),
    baseVersion: z.number().int().min(1).optional(),
  })
  .strict();

router.get(
  "/",
  coreForward({
    method: "GET",
    path: () => "/internal/merchant/users",
  }),
);

router.post(
  "/",
  coreForward({
    method: "POST",
    path: () => "/internal/merchant/users",
    schema: userCreateSchema,
    status: 201,
  }),
);

router.patch(
  "/",
  coreForward({
    method: "PATCH",
    path: () => "/internal/merchant/users",
    schema: z
      .object({
        userIds: z.array(zIdentifier).min(1).max(200),
        role: z.enum(["MERCHANT_ADMIN", "MERCHANT_STAFF", "MERCHANT_CASHIER"]).optional(),
        status: z.enum(["ACTIVE", "SUSPENDED"]).optional(),
        reason: z.string().min(3).max(500).optional(),
      })
      .strict(),
  }),
);

router.patch(
  "/:id",
  coreForward({
    method: "PATCH",
    path: (context) => `/internal/merchant/users/${encodeURIComponent(context.params.id ?? "")}`,
    paramsSchema: userParamsSchema,
    schema: userPatchSchema,
  }),
);

export const usersRouter = router;
