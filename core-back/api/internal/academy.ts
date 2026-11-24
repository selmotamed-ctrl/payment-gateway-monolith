import { randomBytes, randomUUID } from "node:crypto";
import express, { type Request, type Response } from "express";
import { z } from "zod";
import { client } from "../../prisma/client";
import { ApiError, parseOrThrow } from "../../lib/error";
import { writeAudit } from "../../lib/audit/writeAudit";
import { principalOf } from "../middleware/authDoubleCheck";
import { loadCatalog } from "../../engine/academy/catalog";
import { getEligibility, getProgress, putProgress, startExam, submitExam, type AcademyDeps } from "../../engine/academy/service";
import { buildTeamResponse } from "../../engine/academy/team";
import { ensureAcademyCertificateForBadge, revokeAcademyCertificate } from "../../engine/academy/certificate";
import type { AcademyEvent, AcademyStore, Outcome } from "../../engine/academy/types";
import { json } from "./json";

/**
 * Employee Academy (core-back owns the data and grades exams; admin-back proxies).
 * Mounted at `/academy` under `/internal/admin`. Back-office users only (merchantId null).
 */
const router = express.Router();

/** Prisma-backed store: compare-and-swap on `updated_at` so concurrent writers never clobber each other. */
export const prismaAcademyStore: AcademyStore = {
  async load(userId) {
    const user = await client.user.findUnique({ where: { id: userId }, select: { academyProgressJson: true, updatedAt: true } });
    return user ? { json: user.academyProgressJson, version: user.updatedAt } : null;
  },
  async save(userId, value, version) {
    const result = await client.user.updateMany({
      where: { id: userId, updatedAt: version as Date },
      data: { academyProgressJson: json(value) },
    });
    return result.count === 1;
  },
};

const deps = (): AcademyDeps => ({
  store: prismaAcademyStore,
  ctx: {
    now: () => new Date(),
    randomId: () => randomBytes(4).toString("hex"),
    sessionId: () => randomUUID(),
  },
});

const academyUser = (request: Request): { userId: string; role: string } => {
  const principal = principalOf(request);
  if (principal.kind !== "session" || !principal.userId || principal.merchantId) {
    throw new ApiError(403, "ACADEMY_BACK_OFFICE_ONLY", "The Academy is available to back-office users only");
  }
  return { userId: principal.userId, role: principal.role ?? "UNKNOWN" };
};

const audit = async (userId: string, role: string, events: AcademyEvent[]): Promise<void> => {
  for (const event of events) {
    await writeAudit(client, {
      data: {
        actorId: userId,
        role,
        action: event.action,
        entityType: "USER",
        entityId: userId,
        beforeJson: {},
        afterJson: event.afterJson,
      },
    });
  }
};

const withAudit = async <T>(userId: string, role: string, outcome: Outcome<T>): Promise<T> => {
  await audit(userId, role, outcome.events);
  return outcome.value;
};

const isoDate = z
  .string()
  .max(40)
  .refine((value) => !Number.isNaN(Date.parse(value)), "must be an ISO date");
const id = z.string().min(1).max(120);

export const progressPatchSchema = z.object({
  activeTrack: z.enum(loadCatalog().tracks.map((track) => track.id) as [string, ...string[]]).optional(),
  guideRead: z.record(id, z.object({ v: z.string().max(20), at: isoDate })).optional(),
  lessons: z
    .record(
      id,
      z.object({ at: isoDate, v: z.string().max(20), checkScore: z.union([z.literal(0), z.literal(1), z.literal(2)]) }),
    )
    .optional(),
  labs: z
    .record(
      id,
      z.object({
        bestScore: z.number().min(0).max(100),
        attempts: z.number().int().min(0).max(100_000),
        passedAt: isoDate.optional(),
        criticalErrors: z.number().int().min(0).max(10_000),
        v: z.string().max(20),
      }),
    )
    .optional(),
});

// Unknown keys (exams, badges, contentVersion, _server, rev, ...) are stripped, never an error.
const putBodySchema = z.object({ baseRev: z.number().int().min(0), patch: progressPatchSchema });

const examParams = z.object({ examId: z.string().min(1).max(64) });
const startBodySchema = z.object({
  integrityAccepted: z.boolean().optional(),
  checklist: z.array(z.string().max(64)).max(10).optional(),
});
const submitBodySchema = z.object({
  sessionId: z.string().min(1).max(80),
  answers: z.record(z.string().min(1).max(40), z.union([z.string().max(40), z.array(z.string().max(40)).max(20)])),
});

router.get("/progress", async (request: Request, response: Response) => {
  const { userId, role } = academyUser(request);
  response.json(await withAudit(userId, role, await getProgress(deps(), userId)));
});

router.put("/progress", async (request: Request, response: Response) => {
  const { userId, role } = academyUser(request);
  const body = parseOrThrow(putBodySchema, request.body ?? {});
  response.json(await withAudit(userId, role, await putProgress(deps(), userId, body.baseRev, body.patch as never)));
});

router.get("/exams/:examId/eligibility", async (request: Request, response: Response) => {
  const { userId } = academyUser(request);
  const { examId } = parseOrThrow(examParams, request.params);
  response.json(await getEligibility(deps(), userId, examId));
});

router.post("/exams/:examId/start", async (request: Request, response: Response) => {
  const { userId, role } = academyUser(request);
  const { examId } = parseOrThrow(examParams, request.params);
  const body = parseOrThrow(startBodySchema, request.body ?? {});
  const value = await withAudit(userId, role, await startExam(deps(), userId, examId, body.integrityAccepted === true));
  if (body.checklist && body.checklist.length > 0) {
    await audit(userId, role, [{ action: "ACADEMY_EXAM_STARTED_WITH_CHECKLIST", afterJson: { examId, checklist: body.checklist } }]);
  }
  response.json(value);
});

router.post("/exams/:examId/submit", async (request: Request, response: Response) => {
  const { userId, role } = academyUser(request);
  const { examId } = parseOrThrow(examParams, request.params);
  const body = parseOrThrow(submitBodySchema, request.body ?? {});
  const value = await withAudit(userId, role, await submitExam(deps(), userId, examId, body));
  if (value.badge) {
    const user = await client.user.findUnique({ where: { id: userId }, select: { email: true } });
    const holderName = (user?.email?.split("@")[0] ?? "Certified operator").trim();
    try {
      const certificate = await ensureAcademyCertificateForBadge(userId, value.badge, holderName);
      await audit(userId, role, [{
        action: "ACADEMY_CERTIFICATE_ISSUED",
        afterJson: { track: certificate.trackId, certificateId: certificate.displayId, badgeCode: certificate.badgeCode, earnedAt: certificate.earnedAt.toISOString(), expiresAt: certificate.expiresAt.toISOString() },
      }]);
    } catch (error) {
      console.error("academy certificate issuance failed", error instanceof Error ? error.message : error);
    }
  }
  response.json(value);
});

router.get("/certificates/:trackId/verification", async (request: Request, response: Response) => {
  const { userId, role } = academyUser(request);
  const { trackId } = parseOrThrow(z.object({ trackId: z.string().min(1).max(64) }).strict(), request.params);
  const catalog = loadCatalog();
  if (!catalog.tracks.some((track) => track.id === trackId)) {
    throw new ApiError(404, "ACADEMY_TRACK_NOT_FOUND", "The Academy track does not exist");
  }
  const user = await client.user.findUnique({ where: { id: userId }, select: { email: true } });
  const progress = (await getProgress(deps(), userId)).value.progress;
  const badge = progress.badges.find((entry) => entry.track === trackId);
  if (!badge) {
    throw new ApiError(404, "CERTIFICATE_NOT_FOUND", "You have not earned a certificate for this track yet");
  }
  const holderName = (user?.email?.split("@")[0] ?? "Certified operator").trim();
  const certificate = await ensureAcademyCertificateForBadge(userId, badge, holderName);
  await audit(userId, role, [{
    action: "ACADEMY_CERTIFICATE_LINK_CREATED",
    afterJson: { track: certificate.trackId, certificateId: certificate.displayId },
  }]);
  response.json({
    certificateId: certificate.displayId,
    displayId: certificate.displayId,
    publicId: certificate.publicId,
    status: certificate.status,
  });
});

router.post("/certificates/:identifier/revoke", async (request: Request, response: Response) => {
  const { userId, role } = academyUser(request);
  if (role !== "SECURITY_ADMIN") {
    throw new ApiError(403, "ACADEMY_TEAM_FORBIDDEN", "Only security administrators can revoke a certificate");
  }
  const { identifier } = parseOrThrow(z.object({ identifier: z.string().trim().min(8).max(64) }).strict(), request.params);
  const { reason } = parseOrThrow(z.object({ reason: z.string().trim().min(5).max(500) }).strict(), request.body ?? {});
  const revoked = await revokeAcademyCertificate({ identifier, actorUserId: userId, reason });
  if (!revoked) throw new ApiError(404, "CERTIFICATE_NOT_FOUND", "The certificate could not be revoked");
  await audit(userId, role, [{ action: "ACADEMY_CERTIFICATE_REVOKED", afterJson: { identifier, reason } }]);
  response.json({ identifier, status: "REVOKED" });
});

router.get("/team", async (request: Request, response: Response) => {
  const { userId, role } = academyUser(request);
  if (role !== "SECURITY_ADMIN") {
    throw new ApiError(403, "ACADEMY_TEAM_FORBIDDEN", "Only security administrators can open the team view");
  }
  const users = await client.user.findMany({
    where: { merchantId: null, status: { not: "DISABLED" } },
    select: { id: true, email: true, role: true, isMaker: true, isChecker: true, academyProgressJson: true },
    orderBy: { email: "asc" },
  });
  const team = buildTeamResponse(users, loadCatalog(), new Date());
  await audit(userId, role, [{ action: "ACADEMY_TEAM_VIEWED", afterJson: { rows: team.rows.length } }]);
  response.json(team);
});

router.get("/team/export", async (request: Request, response: Response) => {
  const { userId, role } = academyUser(request);
  if (role !== "SECURITY_ADMIN") {
    throw new ApiError(403, "ACADEMY_TEAM_FORBIDDEN", "Only security administrators can export the team view");
  }
  const users = await client.user.findMany({
    where: { merchantId: null, status: { not: "DISABLED" } },
    select: { id: true, email: true, role: true, isMaker: true, isChecker: true, academyProgressJson: true },
    orderBy: { email: "asc" },
  });
  const team = buildTeamResponse(users, loadCatalog(), new Date());
  const allowedChecklist = new Set(["TEAM_SCOPE_VERIFIED", "PERSONAL_DATA_REVIEWED", "EXPORT_APPROVAL_CONFIRMED"]);
  const checklist = (typeof request.query.checklist === "string" ? request.query.checklist.split(",") : [])
    .map((entry) => entry.trim())
    .filter((entry) => allowedChecklist.has(entry));
  await audit(userId, role, [{
    action: "ACADEMY_TEAM_EXPORTED",
    afterJson: { rows: team.rows.length, contentVersion: team.contentVersion, checklist },
  }]);
  response.json({ ...team, exportedAt: new Date().toISOString(), checklist });
});

export const academyInternalRouter = router;
