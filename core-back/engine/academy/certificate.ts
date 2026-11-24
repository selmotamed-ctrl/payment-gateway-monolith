import { randomBytes } from "node:crypto";
import { Prisma } from "../../generated/prisma/client";
import { client } from "../../prisma/client";
import type { AcademyBadge } from "./types";

const MAX_ISSUE_ATTEMPTS = 4;

export const newCertificatePublicId = (): string => randomBytes(24).toString("base64url");
export const newCertificateDisplayId = (): string => `PG-AC-${randomBytes(4).toString("hex").toUpperCase()}`;

export interface IssueAcademyCertificateInput {
  userId: string;
  trackId: string;
  badgeCode: string;
  holderName: string;
  earnedAt: string;
  expiresAt: string;
  contentVersion: string;
}

export const issueAcademyCertificate = async (input: IssueAcademyCertificateInput) => {
  const earnedAt = new Date(input.earnedAt);
  const existing = await client.academyCertificate.findUnique({
    where: { userId_trackId_earnedAt: { userId: input.userId, trackId: input.trackId, earnedAt } },
  });
  if (existing) return existing;
  for (let attempt = 0; attempt < MAX_ISSUE_ATTEMPTS; attempt += 1) {
    try {
      return await client.$transaction(async (tx) => {
        await tx.academyCertificate.updateMany({
          where: { userId: input.userId, trackId: input.trackId, status: "ACTIVE" },
          data: { status: "SUPERSEDED" },
        });
        return tx.academyCertificate.create({
          data: {
            publicId: newCertificatePublicId(),
            displayId: newCertificateDisplayId(),
            userId: input.userId,
            trackId: input.trackId,
            badgeCode: input.badgeCode,
            holderName: input.holderName.slice(0, 120),
            earnedAt,
            expiresAt: new Date(input.expiresAt),
            contentVersion: input.contentVersion.slice(0, 20),
          },
        });
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const raced = await client.academyCertificate.findUnique({
          where: { userId_trackId_earnedAt: { userId: input.userId, trackId: input.trackId, earnedAt } },
        });
        if (raced) return raced;
        continue;
      }
      throw error;
    }
  }
  throw new Error("Could not allocate a unique Academy certificate identifier");
};

export const ensureAcademyCertificateForBadge = async (
  userId: string,
  badge: AcademyBadge,
  holderName: string,
) =>
  issueAcademyCertificate({
    userId,
    trackId: badge.track,
    badgeCode: badge.id,
    holderName,
    earnedAt: badge.earnedAt,
    expiresAt: badge.expiresAt,
    contentVersion: badge.v,
  });

export const revokeAcademyCertificate = async (input: {
  identifier: string;
  actorUserId: string;
  reason: string;
}) => {
  const certificate = await client.academyCertificate.findFirst({
    where: { OR: [{ publicId: input.identifier }, { displayId: input.identifier }] },
    select: { id: true, status: true },
  });
  if (!certificate) return false;
  if (certificate.status === "REVOKED") return true;
  await client.academyCertificate.update({
    where: { id: certificate.id },
    data: { status: "REVOKED", revokedAt: new Date(), revokedByUserId: input.actorUserId, revocationReason: input.reason.slice(0, 500) },
  });
  return true;
};

export const findAcademyCertificate = async (publicId: string) =>
  client.academyCertificate.findUnique({
    where: { publicId },
    include: { user: { select: { status: true, academyProgressJson: true } } },
  });
