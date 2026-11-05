import express, { type NextFunction, type Request, type Response } from "express";
import rateLimiter from "express-rate-limit";
import { z } from "zod";
import { lazyLimiter, rateLimitKey } from "../../lib/clientIp";
import { env } from "../../lib/env";
import { ApiError } from "../../lib/error";
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

const CRON_FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day of week", min: 0, max: 7 },
] as const;

const expandCronField = (raw: string, min: number, max: number): Set<number> | null => {
  const values = new Set<number>();
  for (const part of raw.split(",")) {
    const match = /^(\*|\d{1,2}|\d{1,2}-\d{1,2})(?:\/(\d{1,2}))?$/.exec(part);
    if (!match) return null;
    const [, base = "", stepRaw] = match;
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (step < 1) return null;
    let from: number;
    let to: number;
    if (base === "*") {
      from = min;
      to = max;
    } else if (base.includes("-")) {
      [from, to] = base.split("-").map(Number) as [number, number];
    } else {
      from = Number(base);
      to = stepRaw === undefined ? from : max;
    }
    if (from < min || to > max || from > to) return null;
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return values.size > 0 ? values : null;
};

/**
 * Strict 5 field cron validator (numbers, ranges, lists and steps only) that also returns the
 * smallest gap in minutes between two runs inside a day, so a policy cannot schedule a backup
 * storm. Returns null when the expression is not valid.
 */
export const analyzeCron = (expression: string): { minGapMinutes: number } | null => {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const sets: Set<number>[] = [];
  for (const [index, field] of fields.entries()) {
    const spec = CRON_FIELDS[index];
    if (!spec) return null;
    const expanded = expandCronField(field, spec.min, spec.max);
    if (!expanded) return null;
    sets.push(expanded);
  }
  const minutes = [...(sets[0] ?? [])];
  const hours = [...(sets[1] ?? [])];
  const times = hours.flatMap((hour) => minutes.map((minute) => hour * 60 + minute)).sort((a, b) => a - b);
  let minGap = 1440;
  for (let index = 1; index < times.length; index += 1) {
    minGap = Math.min(minGap, (times[index] ?? 0) - (times[index - 1] ?? 0));
  }
  if (times.length > 1) minGap = Math.min(minGap, 1440 - (times.at(-1) ?? 0) + (times[0] ?? 0));
  return { minGapMinutes: minGap };
};

const cronField = (minGapMinutes: number) =>
  z
    .string()
    .min(1)
    .max(120)
    .superRefine((value, ctx) => {
      const analysis = analyzeCron(value);
      if (!analysis) {
        ctx.addIssue({ code: "custom", message: "must be a valid 5 field cron expression" });
      } else if (analysis.minGapMinutes < minGapMinutes) {
        ctx.addIssue({ code: "custom", message: `runs must be at least ${minGapMinutes} minutes apart` });
      }
    });

export const MIN_FULL_RETENTION_DAYS = 7;
export const MIN_WAL_RETENTION_DAYS = 3;

export const backupPolicySchema = z
  .object({
    fullCron: cronField(60),
    deltaCron: cronField(5),
    drillCron: cronField(60),
    fullRetentionDays: z.number().int().min(1).max(3650),
    walRetentionDays: z.number().int().min(1).max(3650),
    alertLagSeconds: z.number().int().min(0).max(86400),
    approvalRequestId: zIdentifier.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.approvalRequestId !== undefined) return;
    if (value.fullRetentionDays < MIN_FULL_RETENTION_DAYS) {
      ctx.addIssue({
        code: "custom",
        path: ["fullRetentionDays"],
        message: `must be at least ${MIN_FULL_RETENTION_DAYS} days unless an approvalRequestId is supplied`,
      });
    }
    if (value.walRetentionDays < MIN_WAL_RETENTION_DAYS) {
      ctx.addIssue({
        code: "custom",
        path: ["walRetentionDays"],
        message: `must be at least ${MIN_WAL_RETENTION_DAYS} days unless an approvalRequestId is supplied`,
      });
    }
  });

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

/** Trigger and drill start heavy jobs: a replayed request must be recognisable by core. */
const requireIdempotencyKey = (req: Request, _res: Response, next: NextFunction) => {
  const key = req.header("idempotency-key");
  if (key === undefined || !IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new ApiError(400, "IDEMPOTENCY_KEY_REQUIRED", "An Idempotency-Key header (8-128 url safe characters) is required");
  }
  next();
};

/** Tight per client limiter for the job starting routes. */
const jobLimiter = lazyLimiter(() =>
  rateLimiter({
    windowMs: 10 * 60_000,
    max: () => env.BACKUP_JOB_RATE_LIMIT_MAX,
    keyGenerator: (req) => rateLimitKey(req, "backup-jobs"),
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({ code: "RATE_LIMITED", message: "Too many backup jobs requested, please retry later" });
    },
  }),
);

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
  jobLimiter,
  requireIdempotencyKey,
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
  jobLimiter,
  requireIdempotencyKey,
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
