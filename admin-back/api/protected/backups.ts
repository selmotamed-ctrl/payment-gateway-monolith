import express from "express";
import { z } from "zod";
import { zIdentifier } from "../../lib/zReady";
import { requireAuthorities } from "../middleware/authorityGuard";
import { coreForward } from "../forward";

const router = express.Router();

export const backupTriggerSchema = z
  .object({
    target: z.enum(["all", "postgres_core", "audit_db", "redis"]),
    kind: z.enum(["full", "delta"]),
  })
  .strict();

export const backupDrillSchema = z.object({}).strict();

export const backupPolicySchema = z
  .object({
    fullCron: z.string().min(1).max(120),
    deltaCron: z.string().min(1).max(120),
    drillCron: z.string().min(1).max(120),
    fullRetentionDays: z.number().int().min(1).max(3650),
    walRetentionDays: z.number().int().min(1).max(3650),
    alertLagSeconds: z.number().int().min(0).max(86400),
    approvalRequestId: zIdentifier.optional(),
  })
  .strict();

const readBackups = requireAuthorities("security:read", "gateway:read");
const writeBackups = requireAuthorities("security:write");

router.get(
  "/overview",
  readBackups,
  coreForward({
    method: "GET",
    path: () => "/internal/admin/system/backups/overview",
  }),
);

router.post(
  "/trigger",
  writeBackups,
  coreForward({
    method: "POST",
    path: () => "/internal/admin/system/backups/trigger",
    schema: backupTriggerSchema,
    relayStatus: true,
  }),
);

router.post(
  "/drill",
  writeBackups,
  coreForward({
    method: "POST",
    path: () => "/internal/admin/system/backups/drill",
    schema: backupDrillSchema,
    relayStatus: true,
  }),
);

router.put(
  "/policy",
  writeBackups,
  coreForward({
    method: "PUT",
    path: () => "/internal/admin/system/backups/policy",
    schema: backupPolicySchema,
    relayStatus: true,
  }),
);

export const backupsRouter = router;
