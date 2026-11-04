import { isBadgeValid, trackOf } from "./catalog";
import { isLabPassed, parseStoredProgress } from "./progress";
import type { AcademyBadge, Catalog, StoredProgress, TeamResponse, TeamRow, TeamStatus, TrackId } from "./types";

export interface TeamUser {
  id: string;
  email: string;
  role: string;
  isMaker: boolean;
  isChecker: boolean;
  academyProgressJson: unknown;
}

const EXPIRING_DAYS = 30;

export const nameFromEmail = (email: string): string => {
  const local = email.split("@")[0] ?? email;
  return (
    local
      .split(/[._\-+\s]+/)
      .filter(Boolean)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(" ") || email
  );
};

const lastActivity = (progress: StoredProgress, hasRecord: boolean): string | null => {
  if (!hasRecord) return null;
  const stamps = [
    ...Object.values(progress.guideRead).map((entry) => entry.at),
    ...Object.values(progress.lessons).map((entry) => entry.at),
    ...Object.values(progress.labs).map((entry) => entry.passedAt ?? ""),
    ...Object.values(progress.exams).flatMap((exam) => exam.attempts.map((attempt) => attempt.at)),
    ...progress.badges.map((badge) => badge.earnedAt),
  ]
    .map((value) => Date.parse(value))
    .filter((value) => !Number.isNaN(value));
  if (stamps.length === 0) return null;
  const updated = Date.parse(progress.updatedAt);
  return new Date(Math.max(...stamps, Number.isNaN(updated) ? 0 : updated)).toISOString();
};

/** Pure: one row per user (precedence RECERT > EXPIRING > CERTIFIED > EXAM_READY > IN_PROGRESS > NOT_STARTED). */
export const buildTeamRows = (users: readonly TeamUser[], catalog: Catalog, now: Date): TeamRow[] =>
  users.map((user) => {
    const { progress, isNew } = parseStoredProgress(user.academyProgressJson, catalog, now);
    const requiredTracks: TrackId[] = ["FOUNDATION"];
    if (user.role !== "FOUNDATION" && trackOf(catalog, user.role)) requiredTracks.push(user.role as TrackId);
    const tracks = requiredTracks.map((id) => trackOf(catalog, id)!).filter(Boolean);
    const lessonIds = [...new Set(tracks.flatMap((track) => track.lessonIds))];
    const labIds = [...new Set(tracks.flatMap((track) => track.labIds))];
    const lessonsCompleted = lessonIds.filter((id) => progress.lessons[id]).length;
    const labsPassed = labIds.filter((id) => isLabPassed(progress.labs[id], catalog, id)).length;

    const badgeOf = (track: TrackId): AcademyBadge | undefined => progress.badges.find((badge) => badge.track === track);
    const required = requiredTracks.map((track) => badgeOf(track));
    const invalid = required.some((badge) => badge && !isBadgeValid(badge, catalog, now));
    const allValid = required.every((badge) => badge && isBadgeValid(badge, catalog, now));
    const soon = required.some(
      (badge) => badge && isBadgeValid(badge, catalog, now) && Date.parse(badge.expiresAt) - now.getTime() <= EXPIRING_DAYS * 86_400_000,
    );
    const hasRecord = !isNew;
    const anything =
      Object.keys(progress.lessons).length + Object.keys(progress.labs).length + Object.keys(progress.guideRead).length + Object.keys(progress.exams).length + progress.badges.length > 0;
    const ready = lessonsCompleted === lessonIds.length && labsPassed === labIds.length;

    let status: TeamStatus;
    if (invalid) status = "RECERTIFICATION_REQUIRED";
    else if (soon) status = "EXPIRING_SOON";
    else if (allValid) status = "CERTIFIED";
    else if (ready && lessonIds.length > 0) status = "EXAM_READY";
    else if (anything) status = "IN_PROGRESS";
    else status = "NOT_STARTED";

    return {
      userId: user.id,
      email: user.email,
      name: nameFromEmail(user.email),
      role: user.role,
      isMaker: user.isMaker,
      isChecker: user.isChecker,
      requiredTracks,
      activeTrack: progress.activeTrack ?? null,
      lessonsCompleted,
      lessonsRequired: lessonIds.length,
      labsPassed,
      labsRequired: labIds.length,
      badges: progress.badges.map((badge) => ({ id: badge.id, track: badge.track, expiresAt: badge.expiresAt, expired: !isBadgeValid(badge, catalog, now) })),
      lastActivityAt: lastActivity(progress, hasRecord),
      status,
    };
  });

export const buildTeamResponse = (users: readonly TeamUser[], catalog: Catalog, now: Date): TeamResponse => ({
  generatedAt: now.toISOString(),
  contentVersion: catalog.contentVersion,
  rows: buildTeamRows(users, catalog, now).sort((a, b) => a.email.localeCompare(b.email)),
});
