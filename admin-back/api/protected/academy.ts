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

export const academyProgressSchema = z
  .object({
    progress: z
      .object({
        completedModules: z.array(z.string().max(40)).max(40).optional(),
        quizScores: z.record(z.string().max(40), z.number().min(0).max(100)).optional(),
        completedLabs: z.array(z.string().max(60)).max(100).optional(),
        badges: z.array(z.string().max(60)).max(20).optional(),
        lastModuleId: z.string().max(40).optional(),
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

export const academyRouter = router;
