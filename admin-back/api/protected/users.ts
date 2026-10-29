import express, { type Request, type Response } from "express";
import { z } from "zod";
import { env } from "../../lib/env";
import { parseOrThrow } from "../../lib/error";
import { callCoreResponse } from "../../lib/mtlsClient";
import { parseCidrList, resolveClientIp } from "../../lib/net";
import { resolveRequestId } from "../../lib/requestLogger";
import { zAdminRole, zBaseVersion, zEmail, zIdentifier, zPaginationQuery, zPassword } from "../../lib/zReady";
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

/**
 * Bulk update: core accepts a single subject per request, so the edge fans
 * the patch out and answers with `202 Accepted` when any of the parts became
 * an approval request (a role or authority change).
 */
router.patch(
  "/",
  async (req: Request, res: Response): Promise<void> => {
    const body = parseOrThrow(userBulkPatchSchema, req.body ?? {});
    const parts = toCoreUserUpdates(body);
    const results: unknown[] = [];
    let accepted = false;
    let lastStatus = 200;
    for (const part of parts) {
      const response = await callCoreResponse({
        method: "PATCH",
        path: "/internal/admin/users",
        body: part,
        requestId: resolveRequestId(req),
        clientIp: resolveClientIp(req, parseCidrList(env.TRUSTED_PROXY_CIDRS)),
        userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : "",
        authorization: req.headers.authorization,
      });
      results.push(response.body);
      if (response.status === 202) accepted = true;
      lastStatus = response.status;
    }
    res.status(accepted ? 202 : lastStatus).json(results);
  },
);

router.patch(
  "/:id",
  coreForward({
    method: "PATCH",
    path: (context) => `/internal/admin/users/${encodeURIComponent(context.params.id ?? "")}`,
    paramsSchema: userParamsSchema,
    schema: userPatchSchema,
    bodyFrom: (_req, body) => toCoreUserUpdate(body),
    relayStatus: true,
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
