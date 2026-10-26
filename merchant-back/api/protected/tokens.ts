import express from "express";
import { z } from "zod";
import { zCidrList, zIdentifier } from "../../lib/zReady";
import { coreForward } from "../forward";

const router = express.Router();

const tokenParamsSchema = z.object({ id: zIdentifier });

const tokenCreateSchema = z
  .object({
    name: z.string().min(2).max(120),
    scopes: z.array(z.string().min(2).max(64)).min(1).max(50),
    allowedCidrs: zCidrList.optional(),
    expiresAt: z.string().max(64).optional(),
  })
  .strict();

const tokenIpsSchema = z
  .object({
    allowedCidrs: zCidrList,
  })
  .strict();

router.get(
  "/",
  coreForward({
    method: "GET",
    path: () => "/internal/merchant/tokens",
  }),
);

router.post(
  "/",
  coreForward({
    method: "POST",
    path: () => "/internal/merchant/tokens",
    schema: tokenCreateSchema,
    status: 201,
  }),
);

router.put(
  "/:id/ips",
  coreForward({
    method: "PUT",
    path: (context) => `/internal/merchant/tokens/${encodeURIComponent(context.params.id ?? "")}/ips`,
    paramsSchema: tokenParamsSchema,
    schema: tokenIpsSchema,
  }),
);

router.delete(
  "/:id",
  coreForward({
    method: "DELETE",
    path: (context) => `/internal/merchant/tokens/${encodeURIComponent(context.params.id ?? "")}`,
    paramsSchema: tokenParamsSchema,
  }),
);

export const tokensRouter = router;
