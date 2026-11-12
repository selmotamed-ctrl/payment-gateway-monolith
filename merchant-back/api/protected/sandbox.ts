import express from "express";
import { z } from "zod";
import { zIdentifier } from "../../lib/zReady";
import { coreForward } from "../forward";

const router = express.Router();

const accountParamsSchema = z.object({ accountId: zIdentifier }).strict();

router.get(
  "/accounts",
  coreForward({
    method: "GET",
    path: () => "/internal/merchant/sandbox/accounts",
    querySchema: z.object({ railCode: z.string().min(1).max(64).optional() }).passthrough(),
  }),
);

router.get(
  "/accounts/:accountId/movements",
  coreForward({
    method: "GET",
    path: (context) => `/internal/merchant/sandbox/accounts/${encodeURIComponent(context.params.accountId ?? "")}/movements`,
    paramsSchema: accountParamsSchema,
  }),
);

router.patch(
  "/accounts/:accountId",
  coreForward({
    method: "PATCH",
    path: (context) => `/internal/merchant/sandbox/accounts/${encodeURIComponent(context.params.accountId ?? "")}`,
    paramsSchema: accountParamsSchema,
  }),
);

router.post(
  "/reset",
  coreForward({
    method: "POST",
    path: () => "/internal/merchant/sandbox/reset",
  }),
);

router.post(
  "/seed-links",
  coreForward({
    method: "POST",
    path: () => "/internal/merchant/sandbox/seed-links",
    status: 201,
    relayStatus: true,
  }),
);

router.get(
  "/clearing-pools",
  coreForward({
    method: "GET",
    path: () => "/internal/merchant/sandbox/clearing-pools",
  }),
);

export const sandboxRouter = router;
