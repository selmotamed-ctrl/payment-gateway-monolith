import { describe, expect, test } from "bun:test";
import { loadCatalog, trackOf } from "../engine/academy/catalog";
import { emptyProgress } from "../engine/academy/progress";
import { buildTeamResponse, buildTeamRows, nameFromEmail, type TeamUser } from "../engine/academy/team";
import type { AcademyBadge, StoredProgress, TeamStatus, TrackId } from "../engine/academy/types";

const catalog = loadCatalog();
const NOW = new Date("2026-11-04T12:00:00.000Z");
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const at = (days: number) => iso(NOW.getTime() + days * DAY);

const badge = (track: TrackId, expiresInDays: number, v = "1.0.0"): AcademyBadge => ({
  id: trackOf(catalog, track)!.badge,
  track,
  earnedAt: at(-300),
  expiresAt: at(expiresInDays),
  v,
});

/** Everything done for the given tracks. */
const done = (tracks: TrackId[], badges: AcademyBadge[] = [], extra: Partial<StoredProgress> = {}): StoredProgress => {
  const progress = emptyProgress(new Date(at(-60)), catalog.contentVersion);
  for (const id of tracks) {
    const track = trackOf(catalog, id)!;
    for (const lessonId of track.lessonIds) progress.lessons[lessonId] = { at: at(-40), v: "1.0.0", checkScore: 2 };
    for (const labId of track.labIds) progress.labs[labId] = { bestScore: 100, attempts: 1, criticalErrors: 0, v: "1.0.0", passedAt: at(-39) };
  }
  return { ...progress, badges, ...extra };
};

const user = (over: Partial<TeamUser> & { academyProgressJson: unknown }): TeamUser => ({
  id: "u1",
  email: "jane.doe@example.com",
  role: "SUPPORT",
  isMaker: false,
  isChecker: false,
  ...over,
});
const rowOf = (u: TeamUser, cat = catalog) => buildTeamRows([u], cat, NOW)[0]!;
const statusOf = (json: unknown, role = "SUPPORT", cat = catalog): TeamStatus => rowOf(user({ role, academyProgressJson: json }), cat).status;

describe("team status", () => {
  test("NOT_STARTED: no record at all, and an empty record", () => {
    expect(statusOf(null)).toBe("NOT_STARTED");
    expect(statusOf(undefined)).toBe("NOT_STARTED");
    expect(statusOf(emptyProgress(NOW, catalog.contentVersion))).toBe("NOT_STARTED");
    expect(rowOf(user({ academyProgressJson: null })).lastActivityAt).toBeNull();
  });

  test("IN_PROGRESS: any recorded activity short of ready", () => {
    const one = emptyProgress(NOW, catalog.contentVersion);
    one.lessons[trackOf(catalog, "FOUNDATION")!.lessonIds[0]!] = { at: at(-1), v: "1", checkScore: 1 };
    expect(statusOf(one)).toBe("IN_PROGRESS");
    const read = emptyProgress(NOW, catalog.contentVersion);
    read.guideRead.g = { v: "1.0.0", at: at(-2) };
    expect(statusOf(read)).toBe("IN_PROGRESS");
  });

  test("a legacy row that only has guideRead is IN_PROGRESS with no activity time", () => {
    const row = rowOf(user({ academyProgressJson: { completedLessonIds: ["x"], guideRead: { g: { v: "1", at: at(-1) } } } }));
    expect(row.status).toBe("IN_PROGRESS");
    expect(row.lessonsCompleted).toBe(0);
    expect(row.lastActivityAt).toBeNull();
  });

  test("EXAM_READY: all required lessons and labs, no valid badge yet", () => {
    expect(statusOf(done(["FOUNDATION", "SUPPORT"]))).toBe("EXAM_READY");
  });

  test("one missing lesson or one failed lab keeps it IN_PROGRESS", () => {
    const missingLesson = done(["FOUNDATION", "SUPPORT"]);
    delete missingLesson.lessons[trackOf(catalog, "SUPPORT")!.lessonIds[0]!];
    expect(statusOf(missingLesson)).toBe("IN_PROGRESS");
    const critical = done(["FOUNDATION", "SUPPORT"]);
    const labId = trackOf(catalog, "SUPPORT")!.labIds[0]!;
    critical.labs[labId] = { bestScore: 100, attempts: 2, criticalErrors: 1, v: "1.0.0" };
    expect(statusOf(critical)).toBe("IN_PROGRESS");
    const low = done(["FOUNDATION", "SUPPORT"]);
    low.labs[labId] = { bestScore: 79, attempts: 2, criticalErrors: 0, v: "1.0.0" };
    expect(statusOf(low)).toBe("IN_PROGRESS");
  });

  test("only the Foundation work done is not EXAM_READY for a role user", () => {
    expect(statusOf(done(["FOUNDATION"]))).toBe("IN_PROGRESS");
  });

  test("CERTIFIED: valid badges for FOUNDATION and the role track", () => {
    expect(statusOf(done(["FOUNDATION", "SUPPORT"], [badge("FOUNDATION", 200), badge("SUPPORT", 200)]))).toBe("CERTIFIED");
  });

  test("CERTIFIED needs only badges, even if lesson records are sparse", () => {
    expect(statusOf(done([], [badge("FOUNDATION", 200), badge("SUPPORT", 200)]))).toBe("CERTIFIED");
  });

  test("a missing role badge is not CERTIFIED (Foundation alone)", () => {
    expect(statusOf(done(["FOUNDATION", "SUPPORT"], [badge("FOUNDATION", 200)]))).toBe("EXAM_READY");
    expect(statusOf(done(["FOUNDATION"], [badge("FOUNDATION", 200)]))).toBe("IN_PROGRESS");
  });

  test("EXPIRING_SOON: a required badge expires within 30 days (boundary inclusive)", () => {
    expect(statusOf(done([], [badge("FOUNDATION", 200), badge("SUPPORT", 10)]))).toBe("EXPIRING_SOON");
    expect(statusOf(done([], [badge("FOUNDATION", 30), badge("SUPPORT", 200)]))).toBe("EXPIRING_SOON");
    expect(statusOf(done([], [badge("FOUNDATION", 31), badge("SUPPORT", 200)]))).toBe("CERTIFIED");
  });

  test("RECERTIFICATION_REQUIRED: a required badge expired", () => {
    expect(statusOf(done([], [badge("FOUNDATION", -1), badge("SUPPORT", 200)]))).toBe("RECERTIFICATION_REQUIRED");
  });

  test("RECERTIFICATION_REQUIRED: major version below recertifyFrom", () => {
    const strict = { ...catalog, recertifyFrom: "2.0.0" };
    const json = done([], [badge("FOUNDATION", 200, "1.9.0"), badge("SUPPORT", 200, "2.0.0")]);
    expect(statusOf(json, "SUPPORT", strict)).toBe("RECERTIFICATION_REQUIRED");
    expect(statusOf(json, "SUPPORT", catalog)).toBe("CERTIFIED");
  });

  test("precedence: RECERTIFICATION_REQUIRED beats EXPIRING_SOON", () => {
    expect(statusOf(done([], [badge("FOUNDATION", -5), badge("SUPPORT", 5)]))).toBe("RECERTIFICATION_REQUIRED");
  });

  test("precedence: EXPIRING_SOON beats CERTIFIED", () => {
    expect(statusOf(done([], [badge("FOUNDATION", 365), badge("SUPPORT", 29)]))).toBe("EXPIRING_SOON");
  });

  test("precedence: CERTIFIED beats EXAM_READY (all work done and all badges valid)", () => {
    expect(statusOf(done(["FOUNDATION", "SUPPORT"], [badge("FOUNDATION", 100), badge("SUPPORT", 100)]))).toBe("CERTIFIED");
  });

  test("precedence: an expired badge wins over being exam-ready", () => {
    expect(statusOf(done(["FOUNDATION", "SUPPORT"], [badge("SUPPORT", -2)]))).toBe("RECERTIFICATION_REQUIRED");
  });

  test("an expired badge of a track the user does not need does not change the status", () => {
    const json = done([], [badge("FOUNDATION", 100), badge("SUPPORT", 100), badge("FINANCE", -50)]);
    const row = rowOf(user({ academyProgressJson: json }));
    expect(row.status).toBe("CERTIFIED");
    expect(row.badges.find((b) => b.track === "FINANCE")!.expired).toBe(true);
  });

  test("all six statuses are reachable", () => {
    const seen = new Set<TeamStatus>([
      statusOf(null),
      statusOf(done(["FOUNDATION"])),
      statusOf(done(["FOUNDATION", "SUPPORT"])),
      statusOf(done([], [badge("FOUNDATION", 100), badge("SUPPORT", 100)])),
      statusOf(done([], [badge("FOUNDATION", 100), badge("SUPPORT", 3)])),
      statusOf(done([], [badge("FOUNDATION", -1), badge("SUPPORT", 3)])),
    ]);
    expect([...seen].sort()).toEqual(["CERTIFIED", "EXAM_READY", "EXPIRING_SOON", "IN_PROGRESS", "NOT_STARTED", "RECERTIFICATION_REQUIRED"]);
  });
});

describe("team row content", () => {
  test("required tracks = FOUNDATION + the role track", () => {
    for (const role of ["OPERATOR", "SUPPORT", "FINANCE", "COMPLIANCE", "MLRO", "GATEWAY_ADMIN", "SECURITY_ADMIN"]) {
      expect(rowOf(user({ role, academyProgressJson: null })).requiredTracks).toEqual(["FOUNDATION", role as TrackId]);
    }
  });

  test("a role without a track only requires FOUNDATION", () => {
    const row = rowOf(user({ role: "SOMETHING_ELSE", academyProgressJson: null }));
    expect(row.requiredTracks).toEqual(["FOUNDATION"]);
    expect(row.lessonsRequired).toBe(trackOf(catalog, "FOUNDATION")!.lessonIds.length);
  });

  test("lesson and lab counts (required and done) use the union of required tracks", () => {
    const foundation = trackOf(catalog, "FOUNDATION")!;
    const support = trackOf(catalog, "SUPPORT")!;
    const json = emptyProgress(NOW, catalog.contentVersion);
    for (const id of [...foundation.lessonIds.slice(0, 4), ...support.lessonIds.slice(0, 2), "not-in-catalog-lesson"]) json.lessons[id] = { at: at(-1), v: "1", checkScore: 1 };
    json.labs[foundation.labIds[0]!] = { bestScore: 90, attempts: 1, criticalErrors: 0, v: "1" }; // passed
    json.labs[foundation.labIds[1]!] = { bestScore: 90, attempts: 1, criticalErrors: 2, v: "1" }; // critical: not passed
    json.labs[support.labIds[0]!] = { bestScore: 50, attempts: 1, criticalErrors: 0, v: "1" }; // below mark
    const row = rowOf(user({ academyProgressJson: json }));
    expect(row.lessonsRequired).toBe(foundation.lessonIds.length + support.lessonIds.length);
    expect(row.labsRequired).toBe(foundation.labIds.length + support.labIds.length);
    expect(row.lessonsCompleted).toBe(6);
    expect(row.labsPassed).toBe(1);
  });

  test("full completion counts equal the requirements", () => {
    const row = rowOf(user({ academyProgressJson: done(["FOUNDATION", "SUPPORT"]) }));
    expect(row.lessonsCompleted).toBe(row.lessonsRequired);
    expect(row.labsPassed).toBe(row.labsRequired);
    expect(row.lessonsRequired).toBeGreaterThan(0);
  });

  test("badges list carries `expired` per badge", () => {
    const row = rowOf(user({ academyProgressJson: done([], [badge("FOUNDATION", 100), badge("SUPPORT", -1)]) }));
    expect(row.badges.map((b) => [b.track, b.expired])).toEqual([["FOUNDATION", false], ["SUPPORT", true]]);
    expect(Object.keys(row.badges[0]!).sort()).toEqual(["expired", "expiresAt", "id", "track"]);
  });

  test("an old-major badge is flagged expired even before its date", () => {
    const strict = { ...catalog, recertifyFrom: "3.0.0" };
    const row = rowOf(user({ academyProgressJson: done([], [badge("FOUNDATION", 100, "2.4.1")]) }), strict);
    expect(row.badges[0]!.expired).toBe(true);
  });

  test("name comes from the email local part", () => {
    expect(nameFromEmail("jane.doe@example.com")).toBe("Jane Doe");
    expect(nameFromEmail("ALI_hassan-ops+tag@x.ly")).toBe("Ali Hassan Ops Tag");
    expect(nameFromEmail("single@x.ly")).toBe("Single");
    expect(nameFromEmail("@x.ly")).toBe("@x.ly");
    expect(rowOf(user({ email: "omar.k@corp.ly", academyProgressJson: null })).name).toBe("Omar K");
  });

  test("identity fields, maker/checker flags and the active track are copied", () => {
    const json = done([], [], { activeTrack: "FINANCE" });
    const row = rowOf(user({ id: "abc", email: "x@y.z", role: "FINANCE", isMaker: true, isChecker: false, academyProgressJson: json }));
    expect(row).toMatchObject({ userId: "abc", email: "x@y.z", role: "FINANCE", isMaker: true, isChecker: false, activeTrack: "FINANCE" });
    expect(rowOf(user({ academyProgressJson: null })).activeTrack).toBeNull();
  });

  test("lastActivityAt is the newest recorded timestamp", () => {
    const json = emptyProgress(new Date(at(-60)), catalog.contentVersion);
    json.updatedAt = at(-50);
    json.guideRead.g = { v: "1", at: at(-20) };
    json.lessons[trackOf(catalog, "FOUNDATION")!.lessonIds[0]!] = { at: at(-3), v: "1", checkScore: 1 };
    json.exams["exam-foundation"] = { v: "1", attempts: [{ at: at(-7), scorePercent: 10, passed: false, criticalMissed: 1, moduleScores: {}, durationSeconds: 5 }] };
    expect(rowOf(user({ academyProgressJson: json })).lastActivityAt).toBe(at(-3));
  });

  test("rows contain no question, answer or session data", () => {
    const json = done(["FOUNDATION", "SUPPORT"], [badge("FOUNDATION", 100)], {
      exams: { "exam-foundation": { v: "1", attempts: [{ at: at(-1), scorePercent: 50, passed: false, criticalMissed: 1, moduleScores: { m1: 20 }, durationSeconds: 9 }], open: { sessionId: "S3CR3T", startedAt: at(-1), expiresAt: at(1) } } },
    });
    (json as unknown as { _server: unknown })._server = {
      open: { "exam-foundation": { sessionId: "S3CR3T", attemptNumber: 1, startedAt: at(-1), expiresAt: at(1), questions: [{ qid: "q-m1-001", opts: [{ oid: "deadbeef", id: "o1" }] }] } },
      lastQids: { "exam-foundation": ["q-m1-001"] },
      attemptCount: {},
      used: {},
    };
    const row = rowOf(user({ academyProgressJson: json }));
    expect(Object.keys(row).sort()).toEqual(
      ["activeTrack", "badges", "email", "isChecker", "isMaker", "labsPassed", "labsRequired", "lastActivityAt", "lessonsCompleted", "lessonsRequired", "name", "requiredTracks", "role", "status", "userId"],
    );
    const text = JSON.stringify(row);
    for (const leak of ["q-m1-001", "deadbeef", "S3CR3T", "moduleScores", "scorePercent", "_server", "questions", "answers", "criticalMissed", "m1-l", "attempts"]) expect(text).not.toContain(leak);
  });

  test("hostile or corrupt stored JSON never throws", () => {
    for (const raw of [null, "x", 5, [], { schema: 1, lessons: "nope", labs: 5, badges: "x", exams: [] }, { schema: 1, badges: [{}] }]) {
      expect(() => rowOf(user({ academyProgressJson: raw }))).not.toThrow();
    }
  });
});

describe("buildTeamResponse", () => {
  test("is stamped with generatedAt/contentVersion and sorted by email", () => {
    const response = buildTeamResponse(
      [
        user({ id: "3", email: "zed@x.ly", academyProgressJson: null }),
        user({ id: "1", email: "amy@x.ly", academyProgressJson: null }),
        user({ id: "2", email: "mo@x.ly", academyProgressJson: null }),
      ],
      catalog,
      NOW,
    );
    expect(response.generatedAt).toBe(NOW.toISOString());
    expect(response.contentVersion).toBe(catalog.contentVersion);
    expect(response.rows.map((r) => r.email)).toEqual(["amy@x.ly", "mo@x.ly", "zed@x.ly"]);
  });

  test("no users -> no rows", () => {
    expect(buildTeamResponse([], catalog, NOW).rows).toEqual([]);
  });
});
