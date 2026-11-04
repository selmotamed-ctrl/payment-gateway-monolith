import { createHash } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { ApiError } from "../../lib/error";
import { coreForward } from "../forward";
import { extractAuthorityHints } from "../middleware/authorityGuard";

/**
 * Employee Academy proxy. Core owns the data, the exam bank and the grading; this router only
 * validates shapes, rate-limits per user (60 requests/minute) and forwards. The team view is
 * additionally gated to SECURITY_ADMIN here (core re-checks: Double-Check Rule).
 */
const router = express.Router();

const WINDOW_MS = 60_000;
const MAX_REQUESTS = 60;
const buckets = new Map<string, number[]>();

const userKey = (request: Request): string => {
    const authorization = typeof request.headers.authorization === "string" ? request.headers.authorization : "";
    const token = authorization.split(" ")[1] ?? "";
    try {
        const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { sub?: unknown };
        if (typeof payload.sub === "string" && payload.sub.length > 0) return `u:${payload.sub}`;
    } catch {
        // fall through to the token hash
    }
    return `t:${createHash("sha256").update(token || request.ip || "anonymous").digest("hex").slice(0, 32)}`;
};

/** Sliding window: at most 60 requests in any 60 s per signed-in user. */
const rateLimit = (request: Request, response: Response, next: NextFunction): void => {
    const now = Date.now();
    if (buckets.size > 2_000) {
        for (const [key, stamps] of buckets) {
            if (stamps.every((stamp) => stamp <= now - WINDOW_MS)) buckets.delete(key);
        }
    }
    const key = userKey(request);
    const recent = (buckets.get(key) ?? []).filter((stamp) => stamp > now - WINDOW_MS);
    if (recent.length >= MAX_REQUESTS) {
        const retryAfterSec = Math.max(1, Math.ceil(((recent[0] ?? now) + WINDOW_MS - now) / 1000));
        buckets.set(key, recent);
        response.setHeader("Retry-After", String(retryAfterSec));
        response.status(429).json({
            code: "ACADEMY_RATE_LIMITED",
            message: "Too many academy requests. Please wait a moment and try again.",
            retryAfterSec,
        });
        return;
    }
    recent.push(now);
    buckets.set(key, recent);
    next();
};

export const resetAcademyRateLimiterForTests = (): void => {
    buckets.clear();
};

const noStore = (_request: Request, response: Response, next: NextFunction): void => {
    response.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    next();
};

const requireSecurityAdmin = (request: Request, _response: Response, next: NextFunction): void => {
    const hints = extractAuthorityHints(request.headers.authorization);
    if (!hints || !hints.roles.some((role) => role.trim().toUpperCase() === "SECURITY_ADMIN")) {
        throw new ApiError(403, "ACADEMY_TEAM_FORBIDDEN", "Only security administrators can open the team view");
    }
    next();
};

const idKey = z.string().min(1).max(120);
const isoDate = z
    .string()
    .max(40)
    .refine((value) => !Number.isNaN(Date.parse(value)), "must be an ISO date");

// The browser may write only these keys; any other key (exams, badges, contentVersion, ...) is dropped.
const progressPutSchema = z.object({
    baseRev: z.number().int().min(0),
    patch: z.object({
        activeTrack: z.string().min(1).max(40).optional(),
        guideRead: z.record(idKey, z.object({ v: z.string().max(20), at: isoDate })).optional(),
        lessons: z
            .record(idKey, z.object({ at: isoDate, v: z.string().max(20), checkScore: z.union([z.literal(0), z.literal(1), z.literal(2)]) }))
            .optional(),
        labs: z
            .record(
                idKey,
                z.object({
                    bestScore: z.number().min(0).max(100),
                    attempts: z.number().int().min(0).max(100_000),
                    passedAt: isoDate.optional(),
                    criticalErrors: z.number().int().min(0).max(10_000),
                    v: z.string().max(20),
                }),
            )
            .optional(),
    }),
});

const examParams = z.object({ examId: z.string().min(1).max(64) });
const startSchema = z.object({ integrityAccepted: z.boolean().optional() });
const submitSchema = z.object({
    sessionId: z.string().min(1).max(80),
    answers: z.record(z.string().min(1).max(40), z.union([z.string().max(40), z.array(z.string().max(40)).max(20)])),
});

router.use(noStore, rateLimit);

router.get("/progress", coreForward({ method: "GET", path: () => "/internal/admin/academy/progress" }));

router.put(
    "/progress",
    coreForward({ method: "PUT", path: () => "/internal/admin/academy/progress", schema: progressPutSchema }),
);

router.get(
    "/exams/:examId/eligibility",
    coreForward({
        method: "GET",
        paramsSchema: examParams,
        path: ({ params }) => `/internal/admin/academy/exams/${encodeURIComponent(params.examId ?? "")}/eligibility`,
    }),
);

router.post(
    "/exams/:examId/start",
    coreForward({
        method: "POST",
        paramsSchema: examParams,
        schema: startSchema,
        path: ({ params }) => `/internal/admin/academy/exams/${encodeURIComponent(params.examId ?? "")}/start`,
    }),
);

router.post(
    "/exams/:examId/submit",
    coreForward({
        method: "POST",
        paramsSchema: examParams,
        schema: submitSchema,
        path: ({ params }) => `/internal/admin/academy/exams/${encodeURIComponent(params.examId ?? "")}/submit`,
    }),
);

router.get("/team", requireSecurityAdmin, coreForward({ method: "GET", path: () => "/internal/admin/academy/team" }));

export const academyRouter = router;
