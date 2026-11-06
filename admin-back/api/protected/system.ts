import express from "express";
import { zListQuery } from "../../lib/zReady";
import { coreForward } from "../forward";
import { encode, reasonOnlySchema, uuidParamsSchema } from "./mutationSchemas";

/** Background jobs, outbox, audit outbox and failed notification monitor (core: `security:*`). */
const router = express.Router();

router.get(
  "/jobs-outbox/summary",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/system/jobs-outbox/summary",
  }),
);

router.get(
  "/jobs",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/system/jobs",
    querySchema: zListQuery,
  }),
);

router.post(
  "/jobs/:id/requeue",
  coreForward({
    method: "POST",
    path: (context) => `/internal/admin/system/jobs/${encode(context.params.id)}/requeue`,
    paramsSchema: uuidParamsSchema,
    schema: reasonOnlySchema,
    relayStatus: true,
  }),
);

// The outbox is a monitor only: the worker republishes, there is no retry endpoint.
router.get(
  "/outbox",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/system/outbox",
    querySchema: zListQuery,
  }),
);

router.get(
  "/audit-outbox",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/system/audit-outbox",
    querySchema: zListQuery,
  }),
);

router.get(
  "/notifications",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/system/notifications",
    querySchema: zListQuery,
  }),
);

router.post(
  "/notifications/:id/retry",
  coreForward({
    method: "POST",
    path: (context) => `/internal/admin/system/notifications/${encode(context.params.id)}/retry`,
    paramsSchema: uuidParamsSchema,
    schema: reasonOnlySchema,
    relayStatus: true,
  }),
);

export const systemRouter = router;
