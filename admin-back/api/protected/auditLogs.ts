import express from "express";
import { z } from "zod";
import { zPaginationQuery } from "../../lib/zReady";
import { coreForward } from "../forward";

const router = express.Router();

router.get(
  "/",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/audit-logs",
    querySchema: zPaginationQuery,
  }),
);

router.get(
  "/export",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/audit-logs/export",
    querySchema: zPaginationQuery,
  }),
);

router.get(
  "/summary/export",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/audit-logs/summary/export",
  }),
);

router.get(
  "/summary",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/audit-logs/summary",
  }),
);

router.get(
  "/:id",
  (request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    next();
  },
  coreForward({
    method: "GET",
    path: (context) => `/internal/admin/audit-logs/${encodeURIComponent(context.params.id ?? "")}`,
    paramsSchema: z.object({ id: z.string().min(1).max(64) }),
  }),
);

export const auditLogsRouter = router;
