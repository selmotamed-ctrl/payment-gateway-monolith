import express from "express";
import { z } from "zod";
import { coreForward } from "../forward";

/**
 * The Employee Academy progress of the authenticated admin.
 *
 * It lives on the user row so management can see who completed the curriculum
 * before granting production authorities.
 */
const router = express.Router();

const labResultSchema = z
  .object({
    passed: z.boolean(),
    attempts: z.number().int().min(0).max(10000),
    mistakesMade: z.array(z.string().max(240)).max(100),
    completedAt: z.string().max(60),
  })
  .strict();

const quizResultSchema = z
  .object({
    scorePercent: z.number().min(0).max(100),
    passed: z.boolean(),
    completedAt: z.string().max(60),
    answers: z.record(z.string().max(80), z.number().int().min(0).max(20)).optional(),
  })
  .strict();

export const academyProgressSchema = z
  .object({
    progress: z
      .object({
        // Legacy shape kept for backwards compatibility with older clients.
        completedModules: z.array(z.string().max(40)).max(40).optional(),
        completedLabs: z.array(z.string().max(60)).max(100).optional(),
        badges: z.array(z.string().max(60)).max(20).optional(),
        // Zero-to-Hero academy shape.
        completedLessonIds: z.array(z.string().max(80)).max(400).optional(),
        completedLabIds: z.record(z.string().max(80), labResultSchema).optional(),
        earnedBadges: z.array(z.string().max(60)).max(20).optional(),
        quizScores: z
          .record(z.string().max(80), z.union([z.number().min(0).max(100), quizResultSchema]))
          .optional(),
        lastModuleId: z.string().max(40).optional(),
        guideRead: z
          .record(
            z.string().max(120),
            z.object({ v: z.string().max(20), at: z.string().max(60) }).strict(),
          )
          .optional(),
      })
      .strict(),
  })
  .strict();

router.get(
  "/progress",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/academy/progress",
  }),
);

router.put(
  "/progress",
  coreForward({
    method: "PUT",
    path: () => "/internal/admin/academy/progress",
    schema: academyProgressSchema,
  }),
);

router.get(
  "/progress/overview",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/academy/progress/overview",
  }),
);

router.get(
  "/progress/overview/summary",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/academy/progress/overview/summary",
  }),
);

router.get(
  "/progress/overview/summary/export",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/academy/progress/overview/summary/export",
  }),
);

router.get(
  "/progress/overview/export",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/academy/progress/overview/export",
  }),
);

export const academyRouter = router;
