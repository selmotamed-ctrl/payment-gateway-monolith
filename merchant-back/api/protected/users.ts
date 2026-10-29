import { zEmail, zIdentifier, zListQuery, zPassword, zPhone } from "../../lib/zReady";
import express, { type Request, type Response } from "express";
import { z } from "zod";
import { parseOrThrow } from "../../lib/error";
import { callCore } from "../../lib/mtlsClient";
import {
  coreUserCreateSchema,
  coreUserPatchByIdSchema,
  coreUserPatchSchema,
  toCoreUserCreate,
  toCoreUserPatch,
  toCoreUserPatchById,
} from "../contract";
import { coreCallContext, coreForward, requireBearer } from "../forward";

const router = express.Router();

const userParamsSchema = z.object({ id: zIdentifier });

/** Authorities are accepted either as the canonical list or as a portal map. */
const authoritiesSchema = z.union([
  z.array(z.string().min(2).max(64)).max(50),
  z.record(z.string().max(64), z.boolean()),
]);

export const userCreateSchema = z
  .object({
    email: zEmail,
    phone: zPhone.optional(),
    fullName: z.string().min(2).max(120),
    password: zPassword.optional(),
    role: z.enum(["MERCHANT_ADMIN", "MERCHANT_STAFF", "MERCHANT_CASHIER"]),
    authoritiesMap: authoritiesSchema.optional(),
    locale: z.enum(["ar", "en"]).optional(),
  })
  .strict();

export const userPatchSchema = z
  .object({
    fullName: z.string().min(2).max(120).optional(),
    role: z.enum(["MERCHANT_ADMIN", "MERCHANT_STAFF", "MERCHANT_CASHIER"]).optional(),
    status: z.enum(["ACTIVE", "SUSPENDED"]).optional(),
    authoritiesMap: authoritiesSchema.optional(),
    locale: z.enum(["ar", "en"]).optional(),
    baseVersion: z.number().int().min(1).optional(),
  })
  .strict();

export const userBulkPatchSchema = z
  .object({
    userIds: z.array(zIdentifier).min(1).max(200),
    role: z.enum(["MERCHANT_ADMIN", "MERCHANT_STAFF", "MERCHANT_CASHIER"]).optional(),
    status: z.enum(["ACTIVE", "SUSPENDED"]).optional(),
    authoritiesMap: authoritiesSchema.optional(),
    reason: z.string().min(3).max(500).optional(),
  })
  .strict();

router.get(
  "/",
  coreForward({
    method: "GET",
    path: () => "/internal/merchant/users",
    querySchema: zListQuery,
  }),
);

router.post(
  "/",
  coreForward({
    method: "POST",
    path: () => "/internal/merchant/users",
    schema: userCreateSchema,
    bodyMapper: toCoreUserCreate,
    coreSchema: coreUserCreateSchema,
    status: 201,
  }),
);

/**
 * Bulk update: `core-back` patches a single user per call (the target user is
 * carried in the body), so the portal request is fanned out one user at a time.
 */
router.patch(
  "/",
  async (req: Request, res: Response): Promise<void> => {
    requireBearer(req);
    const body = parseOrThrow(userBulkPatchSchema, req.body ?? {});
    const context = coreCallContext(req);
    const users: unknown[] = [];
    for (const id of body.userIds) {
      const payload = await callCore({
        ...context,
        method: "PATCH",
        path: "/internal/merchant/users",
        body: parseOrThrow(coreUserPatchSchema, toCoreUserPatch({ ...body, id })),
      });
      users.push(payload);
    }
    res.status(200).json({ updated: users.length, users });
  },
);

router.patch(
  "/:id",
  coreForward({
    method: "PATCH",
    path: (context) => `/internal/merchant/users/${encodeURIComponent(context.params.id ?? "")}`,
    paramsSchema: userParamsSchema,
    schema: userPatchSchema,
    bodyMapper: toCoreUserPatchById,
    coreSchema: coreUserPatchByIdSchema,
  }),
);

export const usersRouter = router;
