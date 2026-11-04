import { describe, expect, test } from "bun:test";
import { loadCatalog, trackOf } from "../engine/academy/catalog";
import {
  PROGRESS_MAX_BYTES,
  applyClientPatch,
  emptyProgress,
  exceedsLimit,
  mergeGuideRead,
  mergeLabs,
  mergeLessons,
  parseStoredProgress,
  publicProgress,
} from "../engine/academy/progress";
import { getProgress, putProgress, type AcademyDeps } from "../engine/academy/service";
import type { AcademyProgress, AcademyStore, ProgressPatch, StoredProgress } from "../engine/academy/types";

const catalog = loadCatalog();
const NOW = new Date("2026-11-04T12:00:00.000Z");
const T = (n: number) => new Date(Date.parse("2026-11-01T00:00:00.000Z") + n * 60_000).toISOString();
const lessonId = trackOf(catalog, "FOUNDATION")!.lessonIds[0]!;
const lessonId2 = trackOf(catalog, "FOUNDATION")!.lessonIds[1]!;
const labId = trackOf(catalog, "FOUNDATION")!.labIds[0]!;
const V = catalog.contentVersion;

class FakeStore implements AcademyStore {
  rows = new Map<string, { json: unknown; version: number }>();
  saves = 0;
  add(id: string, json: unknown = null) {
    this.rows.set(id, { json, version: 1 });
  }
  async load(id: string) {
    const row = this.rows.get(id);
    return row ? { json: structuredClone(row.json), version: row.version } : null;
  }
  async save(id: string, json: unknown, version: unknown) {
    const row = this.rows.get(id);
    if (!row || row.version !== version) return false;
    this.saves += 1;
    this.rows.set(id, { json: structuredClone(json), version: row.version + 1 });
    return true;
  }
  raw(id: string) {
    return this.rows.get(id)!.json as StoredProgress;
  }
}
const makeDeps = (store: AcademyStore): AcademyDeps => ({
  store,
  ctx: { now: () => NOW, randomId: () => "00000000", sessionId: () => "s" },
});
const errorOf = async (promise: Promise<unknown>): Promise<{ code: string; statusCode: number; details?: any }> => {
  try {
    await promise;
  } catch (error) {
    return error as never;
  }
  throw new Error("expected the call to throw");
};

describe("merge rules", () => {
  test("lessons: the later `at` wins, an older write is ignored, ties go to the higher checkScore", () => {
    const current = { a: { at: T(10), v: "1.0.0", checkScore: 1 as const }, b: { at: T(10), v: "1.0.0", checkScore: 1 as const }, c: { at: T(10), v: "1.0.0", checkScore: 2 as const } };
    const merged = mergeLessons(current, {
      a: { at: T(20), v: "1.1.0", checkScore: 0 }, // later wins even with a lower score
      b: { at: T(5), v: "0.9.0", checkScore: 2 }, // older loses
      c: { at: T(10), v: "1.0.0", checkScore: 1 }, // tie, lower score loses
      d: { at: T(1), v: "1.0.0", checkScore: 2 }, // new id
    });
    expect(merged.a).toEqual({ at: T(20), v: "1.1.0", checkScore: 0 });
    expect(merged.b.checkScore).toBe(1);
    expect(merged.c.checkScore).toBe(2);
    expect(merged.d).toBeDefined();
    expect(mergeLessons({ x: { at: T(10), v: "1", checkScore: 0 } }, { x: { at: T(10), v: "1", checkScore: 2 } }).x.checkScore).toBe(2);
  });

  test("labs: bestScore max, attempts max, passedAt earliest, critical/v from the best entry", () => {
    const existing = { bestScore: 70, attempts: 3, criticalErrors: 2, v: "1.0.0", passedAt: T(50) };
    const merged = mergeLabs({ l: existing }, { l: { bestScore: 90, attempts: 2, criticalErrors: 0, v: "1.1.0", passedAt: T(40) } }).l;
    expect(merged).toEqual({ bestScore: 90, attempts: 3, criticalErrors: 0, v: "1.1.0", passedAt: T(40) });
  });

  test("labs: a lower incoming score never overrides critical errors / version of the best", () => {
    const existing = { bestScore: 95, attempts: 1, criticalErrors: 1, v: "1.0.0" };
    const merged = mergeLabs({ l: existing }, { l: { bestScore: 60, attempts: 4, criticalErrors: 0, v: "1.2.0" } }).l;
    expect(merged).toEqual({ bestScore: 95, attempts: 4, criticalErrors: 1, v: "1.0.0" });
  });

  test("labs: equal bestScore -> the entry with fewer critical errors", () => {
    const merged = mergeLabs(
      { l: { bestScore: 85, attempts: 1, criticalErrors: 2, v: "1.0.0" } },
      { l: { bestScore: 85, attempts: 1, criticalErrors: 0, v: "1.1.0" } },
    ).l;
    expect(merged.criticalErrors).toBe(0);
    expect(merged.v).toBe("1.1.0");
    const kept = mergeLabs(
      { l: { bestScore: 85, attempts: 1, criticalErrors: 0, v: "1.0.0" } },
      { l: { bestScore: 85, attempts: 1, criticalErrors: 3, v: "1.1.0" } },
    ).l;
    expect(kept.criticalErrors).toBe(0);
    expect(kept.v).toBe("1.0.0");
  });

  test("labs: passedAt is kept when only one side has it; merging never deletes a lab", () => {
    const merged = mergeLabs({ a: { bestScore: 80, attempts: 1, criticalErrors: 0, v: "1", passedAt: T(3) } }, { a: { bestScore: 40, attempts: 1, criticalErrors: 0, v: "1" } });
    expect(merged.a.passedAt).toBe(T(3));
    expect(Object.keys(mergeLabs({ a: merged.a }, {}))).toEqual(["a"]);
  });

  test("guideRead: later `at` wins, an older entry cannot resurrect", () => {
    const merged = mergeGuideRead({ g: { v: "1.0.0", at: T(10) } }, { g: { v: "1.0.1", at: T(5) }, h: { v: "1.0.0", at: T(1) } });
    expect(merged.g).toEqual({ v: "1.0.0", at: T(10) });
    expect(merged.h).toBeDefined();
    expect(mergeGuideRead({ g: { v: "1.0.0", at: T(10) } }, { g: { v: "1.0.2", at: T(11) } }).g.v).toBe("1.0.2");
  });

  test("guideRead tombstone (v:'') un-reads, and a later read overrides the tombstone", () => {
    const unread = mergeGuideRead({ g: { v: "1.0.0", at: T(10) } }, { g: { v: "", at: T(20) } });
    expect(unread.g).toEqual({ v: "", at: T(20) });
    expect(Object.keys(unread)).toEqual(["g"]); // tombstone, not a delete
    expect(mergeGuideRead(unread, { g: { v: "1.0.0", at: T(30) } }).g.v).toBe("1.0.0");
    expect(mergeGuideRead(unread, { g: { v: "1.0.0", at: T(15) } }).g.v).toBe(""); // older read loses to tombstone
  });

  test("merges are idempotent", () => {
    const patch: ProgressPatch = {
      guideRead: { g: { v: "1", at: T(1) } },
      lessons: { [lessonId]: { at: T(2), v: V, checkScore: 1 } },
      labs: { [labId]: { bestScore: 90, attempts: 2, criticalErrors: 0, v: V, passedAt: T(3) } },
    };
    const base = emptyProgress(NOW, V);
    const once = applyClientPatch(base, patch, catalog);
    expect(applyClientPatch(once, patch, catalog)).toEqual(once);
  });
});

describe("applyClientPatch", () => {
  const base = (): StoredProgress => ({
    ...emptyProgress(NOW, V),
    exams: { "exam-foundation": { attempts: [], v: V, passedAt: T(1) } },
    badges: [{ id: "FOUNDATION_CERTIFIED", track: "FOUNDATION", earnedAt: T(1), expiresAt: T(99999), v: V }],
    integrityAcceptedAt: T(2),
  });

  test("unknown lesson and lab ids are dropped", () => {
    const next = applyClientPatch(
      base(),
      {
        lessons: { [lessonId]: { at: T(1), v: V, checkScore: 2 }, "not-a-lesson": { at: T(1), v: V, checkScore: 2 } },
        labs: { [labId]: { bestScore: 80, attempts: 1, criticalErrors: 0, v: V }, "not-a-lab": { bestScore: 80, attempts: 1, criticalErrors: 0, v: V } },
      },
      catalog,
    );
    expect(Object.keys(next.lessons)).toEqual([lessonId]);
    expect(Object.keys(next.labs)).toEqual([labId]);
  });

  test("a lesson id given under labs (or the other way round) is dropped", () => {
    const next = applyClientPatch(base(), { labs: { [lessonId]: { bestScore: 100, attempts: 1, criticalErrors: 0, v: V } }, lessons: { [labId]: { at: T(1), v: V, checkScore: 2 } } }, catalog);
    expect(next.labs).toEqual({});
    expect(next.lessons).toEqual({});
  });

  test("server-owned keys in a patch are ignored", () => {
    const hostile = {
      activeTrack: "OPERATOR",
      exams: { "exam-foundation": { attempts: [], v: "9", passedAt: "2000-01-01T00:00:00.000Z" }, forged: { attempts: [], v: "1" } },
      badges: [{ id: "X", track: "MLRO", earnedAt: T(1), expiresAt: T(99999), v: V }],
      contentVersion: "9.9.9",
      _server: { open: { x: 1 } },
      rev: 777,
      schema: 2,
      integrityAcceptedAt: "2000-01-01T00:00:00.000Z",
    } as unknown as ProgressPatch;
    const before = base();
    const next = applyClientPatch(before, hostile, catalog);
    expect(next.activeTrack).toBe("OPERATOR");
    expect(next.exams).toEqual(before.exams);
    expect(next.badges).toEqual(before.badges);
    expect(next.contentVersion).toBe(before.contentVersion);
    expect(next._server).toEqual(before._server);
    expect(next.rev).toBe(before.rev);
    expect(next.schema).toBe(1);
    expect(next.integrityAcceptedAt).toBe(T(2));
  });

  test("activeTrack: last write wins; an unknown track is ignored", () => {
    const first = applyClientPatch(base(), { activeTrack: "FINANCE" }, catalog);
    expect(first.activeTrack).toBe("FINANCE");
    expect(applyClientPatch(first, { activeTrack: "MLRO" }, catalog).activeTrack).toBe("MLRO");
    expect(applyClientPatch(first, { activeTrack: "NOPE" as never }, catalog).activeTrack).toBe("FINANCE");
    expect(applyClientPatch(first, {}, catalog).activeTrack).toBe("FINANCE");
  });

  test("the input record is not mutated", () => {
    const before = base();
    const snapshot = structuredClone(before);
    applyClientPatch(before, { lessons: { [lessonId]: { at: T(1), v: V, checkScore: 2 } }, guideRead: { g: { v: "1", at: T(1) } } }, catalog);
    expect(before).toEqual(snapshot);
  });
});

describe("putProgress", () => {
  test("PUT ignores server-owned keys end to end and increments rev", async () => {
    const store = new FakeStore();
    store.add("u1", null);
    const deps = makeDeps(store);
    const { value } = await putProgress(deps, "u1", 0, {
      lessons: { [lessonId]: { at: T(1), v: V, checkScore: 2 } },
      ...({ exams: { x: { attempts: [], v: "1" } }, badges: [{ id: "x" }], contentVersion: "9", _server: { open: { a: 1 } }, rev: 50, schema: 7, integrityAcceptedAt: T(1) } as object),
    } as ProgressPatch);
    expect(value.rev).toBe(1);
    expect(value.progress.rev).toBe(1);
    const stored = store.raw("u1");
    expect(stored.rev).toBe(1);
    expect(stored.schema).toBe(1);
    expect(stored.exams).toEqual({});
    expect(stored.badges).toEqual([]);
    expect(stored.contentVersion).toBe(V);
    expect(stored.integrityAcceptedAt).toBeUndefined();
    expect(stored._server.open).toEqual({});
    expect(stored.lessons[lessonId]).toBeDefined();
    expect(stored.updatedAt).toBe(NOW.toISOString());
  });

  test("rev increments on every successful write and the response is the public view", async () => {
    const store = new FakeStore();
    store.add("u1", null);
    const deps = makeDeps(store);
    let rev = 0;
    for (let i = 1; i <= 3; i += 1) {
      const { value, events } = await putProgress(deps, "u1", rev, { guideRead: { [`g${i}`]: { v: "1", at: T(i) } } });
      rev = value.rev;
      expect(rev).toBe(i);
      expect(JSON.stringify(value)).not.toContain("_server");
      expect(events[0]).toMatchObject({ action: "ACADEMY_PROGRESS" });
      expect(events[0]!.afterJson).toEqual({ keys: { activeTrack: 0, guideRead: 1, lessons: 0, labs: 0 }, rev: i });
    }
    expect(Object.keys(store.raw("u1").guideRead)).toEqual(["g1", "g2", "g3"]);
  });

  test("baseRev mismatch -> 409 ACADEMY_REV_CONFLICT with {progress, rev} in details, nothing written", async () => {
    const store = new FakeStore();
    store.add("u1", null);
    const deps = makeDeps(store);
    await putProgress(deps, "u1", 0, { lessons: { [lessonId]: { at: T(1), v: V, checkScore: 1 } } });
    const saves = store.saves;
    const error = await errorOf(putProgress(deps, "u1", 0, { lessons: { [lessonId2]: { at: T(2), v: V, checkScore: 2 } } }));
    expect(error.statusCode).toBe(409);
    expect(error.code).toBe("ACADEMY_REV_CONFLICT");
    expect(Object.keys(error.details).sort()).toEqual(["progress", "rev"]);
    expect(error.details.rev).toBe(1);
    expect(error.details.progress.rev).toBe(1);
    expect(Object.keys(error.details.progress.lessons)).toEqual([lessonId]);
    expect(JSON.stringify(error.details)).not.toContain("_server");
    expect(store.saves).toBe(saves);
    // A baseRev from the future conflicts too.
    expect((await errorOf(putProgress(deps, "u1", 5, {}))).code).toBe("ACADEMY_REV_CONFLICT");
  });

  test("the client can retry with the returned rev and succeed", async () => {
    const store = new FakeStore();
    store.add("u1", null);
    const deps = makeDeps(store);
    await putProgress(deps, "u1", 0, { activeTrack: "FINANCE" });
    const conflict = await errorOf(putProgress(deps, "u1", 0, { activeTrack: "MLRO" }));
    const retried = await putProgress(deps, "u1", conflict.details.rev, { activeTrack: "MLRO" });
    expect(retried.value.progress.activeTrack).toBe("MLRO");
  });

  test("an unknown user -> 404 USER_NOT_FOUND", async () => {
    const error = await errorOf(putProgress(makeDeps(new FakeStore()), "ghost", 0, {}));
    expect([error.statusCode, error.code]).toEqual([404, "USER_NOT_FOUND"]);
  });

  test("a record over 64 KB -> 413 ACADEMY_PROGRESS_TOO_LARGE and nothing is written", async () => {
    const store = new FakeStore();
    store.add("u1", null);
    const deps = makeDeps(store);
    const guideRead: AcademyProgress["guideRead"] = {};
    for (let i = 0; i < 800; i += 1) guideRead[`${String(i).padStart(4, "0")}-${"k".repeat(100)}`] = { v: "1.0.0", at: T(1) };
    const error = await errorOf(putProgress(deps, "u1", 0, { guideRead }));
    expect([error.statusCode, error.code]).toEqual([413, "ACADEMY_PROGRESS_TOO_LARGE"]);
    expect(store.rows.get("u1")!.json).toBeNull();
    expect(store.saves).toBe(0);
  });

  test("exceedsLimit boundary is 64 KiB of serialised JSON", () => {
    const sized = (bytes: number) => ({ pad: "x".repeat(bytes - JSON.stringify({ pad: "" }).length) });
    expect(PROGRESS_MAX_BYTES).toBe(65_536);
    expect(exceedsLimit(sized(PROGRESS_MAX_BYTES))).toBe(false);
    expect(exceedsLimit(sized(PROGRESS_MAX_BYTES + 1))).toBe(true);
    expect(exceedsLimit({ pad: "é".repeat(33_000) })).toBe(true); // bytes, not characters
  });
});

describe("compare-and-swap retry", () => {
  class FlakyStore extends FakeStore {
    constructor(private losses: number) {
      super();
    }
    attempts = 0;
    override async save(id: string, json: unknown, version: unknown) {
      this.attempts += 1;
      if (this.losses > 0) {
        this.losses -= 1;
        return false;
      }
      return super.save(id, json, version);
    }
  }

  test("a lost swap is retried and succeeds on the 4th try", async () => {
    const store = new FlakyStore(3);
    store.add("u1", null);
    const { value } = await putProgress(makeDeps(store), "u1", 0, { activeTrack: "SUPPORT" });
    expect(store.attempts).toBe(4);
    expect(value.rev).toBe(1);
    expect(store.raw("u1").activeTrack).toBe("SUPPORT");
  });

  test("4 lost swaps -> 409 ACADEMY_BUSY and nothing is written", async () => {
    const store = new FlakyStore(4);
    store.add("u1", null);
    const error = await errorOf(putProgress(makeDeps(store), "u1", 0, { activeTrack: "SUPPORT" }));
    expect([error.statusCode, error.code]).toEqual([409, "ACADEMY_BUSY"]);
    expect(store.attempts).toBe(4);
    expect(store.rows.get("u1")!.json).toBeNull();
  });

  test("a genuine concurrent writer between load and save is merged on retry, not clobbered", async () => {
    const store = new FakeStore();
    store.add("u1", null);
    await putProgress(makeDeps(store), "u1", 0, { guideRead: { g0: { v: "1", at: T(0) } } });
    let interfered = false;
    const racing: AcademyStore = {
      load: (id) => store.load(id),
      async save(id, json, version) {
        if (!interfered) {
          interfered = true;
          // Another request commits first (same rev base) and wins the swap.
          const other = structuredClone(store.raw(id));
          other.guideRead = { ...other.guideRead, winner: { v: "1", at: T(1) } };
          other.rev += 1;
          await store.save(id, other, version);
        }
        return store.save(id, json, version);
      },
    };
    // The loser's baseRev (1) is stale after the winner bumps it, so the retry sees a conflict.
    const error = await errorOf(putProgress(makeDeps(racing), "u1", 1, { guideRead: { loser: { v: "1", at: T(2) } } }));
    expect(error.code).toBe("ACADEMY_REV_CONFLICT");
    expect(error.details.progress.guideRead.winner).toBeDefined();
    expect(Object.keys(store.raw("u1").guideRead).sort()).toEqual(["g0", "winner"]);
  });

  test("getProgress on a missing record that loses the swap also retries", async () => {
    const store = new FlakyStore(2);
    store.add("u1", null);
    const { value } = await getProgress(makeDeps(store), "u1");
    expect(store.attempts).toBe(3);
    expect(value.rev).toBe(0);
  });
});

describe("stored shapes", () => {
  test("a null row becomes a fresh persisted record on first GET, rev 0, no bump on later GETs", async () => {
    const store = new FakeStore();
    store.add("u1", null);
    const deps = makeDeps(store);
    const first = await getProgress(deps, "u1");
    expect(first.value.rev).toBe(0);
    expect(first.value.progress).toMatchObject({ schema: 1, rev: 0, contentVersion: V, lessons: {}, labs: {}, exams: {}, badges: [], guideRead: {} });
    expect(store.raw("u1").schema).toBe(1);
    const saves = store.saves;
    await getProgress(deps, "u1");
    expect(store.saves).toBe(saves);
  });

  test("a legacy-shape row is converted keeping only valid guideRead entries", async () => {
    const legacy = {
      completedLessonIds: ["M1-L1", "M1-L2"],
      completedLabIds: { "LAB-01": { passed: true, attempts: 2 } },
      quizScores: { "QUIZ-M1": { scorePercent: 100, passed: true } },
      earnedBadges: ["CERTIFIED_SUPPORT_SPECIALIST"],
      lastModuleId: "M1",
      guideRead: { good: { v: "1.0.0", at: T(5) }, tombstone: { v: "", at: T(6) }, badAt: { v: "1", at: "nope" }, badShape: "x", longV: { v: "v".repeat(21), at: T(1) } },
    };
    const store = new FakeStore();
    store.add("u1", legacy);
    const { value } = await getProgress(makeDeps(store), "u1");
    expect(Object.keys(value.progress).sort()).toEqual(
      ["badges", "contentVersion", "exams", "guideRead", "labs", "lessons", "rev", "schema", "startedAt", "updatedAt"],
    );
    expect(value.progress.guideRead).toEqual({ good: { v: "1.0.0", at: T(5) }, tombstone: { v: "", at: T(6) } });
    expect(value.progress.lessons).toEqual({});
    const stored = JSON.stringify(store.raw("u1"));
    for (const dropped of ["completedLessonIds", "quizScores", "earnedBadges", "lastModuleId", "completedLabIds"]) expect(stored).not.toContain(dropped);
    expect(store.raw("u1").schema).toBe(1);
  });

  test("garbage rows (string, number, array) are replaced by a fresh record", () => {
    for (const raw of ["text", 42, [1, 2], true]) {
      const { progress, isNew } = parseStoredProgress(raw, catalog, NOW);
      expect(isNew).toBe(true);
      expect(progress.guideRead).toEqual({});
    }
  });

  test("a schema:1 row is sanitised entry by entry", () => {
    const raw = {
      schema: 1,
      rev: 4,
      startedAt: T(0),
      updatedAt: T(1),
      contentVersion: "1.0.0",
      activeTrack: "NOT_A_TRACK",
      guideRead: {},
      lessons: { ok: { at: T(1), v: "1", checkScore: 2 }, badScore: { at: T(1), v: "1", checkScore: 5 }, badAt: { at: "x", v: "1", checkScore: 1 } },
      labs: { ok: { bestScore: 90, attempts: 1, criticalErrors: 0, v: "1" }, over: { bestScore: 101, attempts: 1, criticalErrors: 0, v: "1" }, neg: { bestScore: 5, attempts: 1, criticalErrors: -1, v: "1" } },
      exams: {},
      badges: [{ id: "A", track: "FOUNDATION", earnedAt: T(1), expiresAt: T(2), v: "1.0.0" }, { id: "B", track: "BOGUS", earnedAt: T(1), expiresAt: T(2), v: "1" }, "junk"],
    };
    const { progress, isNew } = parseStoredProgress(raw, catalog, NOW);
    expect(isNew).toBe(false);
    expect(progress.rev).toBe(4);
    expect(progress.activeTrack).toBeUndefined();
    expect(Object.keys(progress.lessons)).toEqual(["ok"]);
    expect(Object.keys(progress.labs)).toEqual(["ok"]);
    expect(progress.badges.map((b) => b.id)).toEqual(["A"]);
    expect(progress._server).toEqual({ open: {}, lastQids: {}, attemptCount: {}, used: {} });
  });
});

describe("publicProgress", () => {
  const withServer = (): StoredProgress => ({
    ...emptyProgress(NOW, V),
    exams: {
      live: { attempts: [], v: V, open: { sessionId: "s1", startedAt: T(0), expiresAt: new Date(NOW.getTime() + 60_000).toISOString() } },
      stale: { attempts: [], v: V, open: { sessionId: "s2", startedAt: T(0), expiresAt: new Date(NOW.getTime() - 1000).toISOString() } },
    },
    _server: {
      open: { live: { sessionId: "s1", attemptNumber: 1, startedAt: T(0), expiresAt: new Date(NOW.getTime() + 60_000).toISOString(), questions: [{ qid: "q1", opts: [{ oid: "aa", id: "o1" }] }] } },
      lastQids: { live: ["q1"] },
      attemptCount: { live: 1 },
      used: { live: ["old"] },
    },
  });

  test("never returns _server or its content", () => {
    const view = publicProgress(withServer(), catalog, NOW);
    expect("_server" in view).toBe(false);
    const text = JSON.stringify(view);
    for (const secret of ["_server", "lastQids", "attemptCount", "opts", "oid", '"questions"', '"used"']) expect(text).not.toContain(secret);
  });

  test("keeps a live open session and drops an expired one", () => {
    const view = publicProgress(withServer(), catalog, NOW);
    expect(view.exams.live!.open?.sessionId).toBe("s1");
    expect(view.exams.stale!.open).toBeUndefined();
    expect(Object.keys(view.exams.live!.open!).sort()).toEqual(["expiresAt", "sessionId", "startedAt"]);
  });

  test("works on null, legacy and garbage input without leaking", () => {
    for (const raw of [null, undefined, {}, { _server: { open: { x: 1 } }, guideRead: {} }, "str"]) {
      const view = publicProgress(raw, catalog, NOW);
      expect(view.schema).toBe(1);
      expect("_server" in view).toBe(false);
    }
  });

  test("a client-forged `_server` inside a legacy row never survives", () => {
    const view = publicProgress({ _server: { open: { a: { questions: [] } } }, guideRead: { g: { v: "1", at: T(1) } } }, catalog, NOW);
    expect(JSON.stringify(view)).not.toContain("_server");
    expect(view.guideRead.g).toBeDefined();
  });
});
