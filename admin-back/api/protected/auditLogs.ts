import express from "express";
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

export const auditLogsRouter = router;
