import express from "express";
import { z } from "zod";
import { zAdminRole, zBaseVersion, zEmail, zIdentifier, zPassword, zPaginationQuery } from "../../lib/zReady";
import { toCoreUserCreate, toCoreUserUpdate, toCoreUserUpdates } from "../contract";
import { coreForward } from "../forward";

const router = express.Router();

const userParamsSchema = z.object({ id: zIdentifier });

export const userCreateSchema = z
  .object({
    email: zEmail,
    fullName: z.string().min(2).max(120),
    role: zAdminRole,
    phone: z.string().min(6).max(20).optional(),
    locale: z.enum(["ar", "en"]).optional(),
    temporaryPassword: zPassword.optional(),
    authorities: z.record(z.string().max(64), z.array(z.string().max(64)).max(50)).optional(),
  })
  .strict();

export const userPatchSchema = z
  .object({
    fullName: z.string().min(2).max(120).optional(),
    role: zAdminRole.optional(),
    status: z.enum(["ACTIVE", "SUSPENDED", "LOCKED"]).optional(),
    locale: z.enum(["ar", "en"]).optional(),
    authorities: z.record(z.string().max(64), z.array(z.string().max(64)).max(50)).optional(),
    baseVersion: zBaseVersion.optional(),
    reason: z.string().min(3).max(500).optional(),
  })
  .strict();

export const userBulkPatchSchema = z
  .object({
    userIds: z.array(zIdentifier).min(1).max(200),
    role: zAdminRole.optional(),
    status: z.enum(["ACTIVE", "SUSPENDED", "LOCKED"]).optional(),
    reason: z.string().min(3).max(500).optional(),
    baseVersion: zBaseVersion.optional(),
  })
  .strict();

router.get(
  "/",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/users",
    querySchema: zPaginationQuery,
  }),
);

router.post(
  "/",
  coreForward({
    method: "POST",
    path: () => "/internal/admin/users",
    schema: userCreateSchema,
    bodyFrom: (_req, body) => toCoreUserCreate(body),
    status: 201,
  }),
);

router.patch(
  "/",
  coreForward({
    method: "PATCH",
    path: () => "/internal/admin/users",
    schema: userBulkPatchSchema,
    splitBodyFrom: (_req, body) => toCoreUserUpdates(body),
  }),
);

router.patch(
  "/:id",
  coreForward({
    method: "PATCH",
    path: (context) => `/internal/admin/users/${encodeURIComponent(context.params.id ?? "")}`,
    paramsSchema: userParamsSchema,
    schema: userPatchSchema,
    bodyFrom: (_req, body) => toCoreUserUpdate(body),
  }),
);

router.get(
  "/:id",
  coreForward({
    method: "GET",
    path: (context) => `/internal/admin/users/${encodeURIComponent(context.params.id ?? "")}`,
    paramsSchema: userParamsSchema,
  }),
);

export const usersRouter = router;
