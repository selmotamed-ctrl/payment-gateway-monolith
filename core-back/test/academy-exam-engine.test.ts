import { describe, expect, test } from "bun:test";
import { loadCatalog, loadExamBank, addMonthsUtc, questionIndex, trackOf, lessonTitle, labOf } from "../engine/academy/catalog";
import { buildQuestionState, mulberry32, pickQuestions, seedFor, seededShuffle } from "../engine/academy/examEngine";
import { gradeExam, gradeQuestion, percent } from "../engine/academy/grading";
import { emptyProgress } from "../engine/academy/progress";
import { computeEligibility, getEligibility, getProgress, putProgress, startExam, submitExam, SUBMIT_GRACE_MS, type AcademyDeps } from "../engine/academy/service";
import type { AcademyStore, BankQuestion, ExamAnswer, ExamBlueprint, OpenQuestionState, StoredProgress, TrackId } from "../engine/academy/types";

const catalog = loadCatalog();
const bank = loadExamBank();
const index = questionIndex(bank);
const NOW = Date.parse("2026-11-04T12:00:00.000Z");
const MIN = 60_000;
const DAY = 86_400_000;

// ---- Test doubles ----------------------------------------------------------------------

class FakeStore implements AcademyStore {
  rows = new Map<string, { json: unknown; version: number }>();
  add(userId: string, json: unknown = null): void {
    this.rows.set(userId, { json, version: 1 });
  }
  async load(userId: string) {
    const row = this.rows.get(userId);
    return row ? { json: structuredClone(row.json), version: row.version } : null;
  }
  async save(userId: string, json: unknown, version: unknown) {
    const row = this.rows.get(userId);
    if (!row || row.version !== version) return false;
    this.rows.set(userId, { json: structuredClone(json), version: row.version + 1 });
    return true;
  }
  raw(userId: string): StoredProgress {
    return this.rows.get(userId)!.json as StoredProgress;
  }
}

const makeDeps = (store = new FakeStore(), start = NOW) => {
  const clock = { t: start };
  let counter = 0;
  let sessions = 0;
  const deps: AcademyDeps = {
    store,
    ctx: {
      now: () => new Date(clock.t),
      randomId: () => (counter += 1).toString(16).padStart(8, "0"),
      sessionId: () => `session-${(sessions += 1)}`,
    },
  };
  return { deps, store, clock };
};

const isoAt = (ms: number) => new Date(ms).toISOString();

/** A record in which every lesson and lab of the given tracks is done, plus optional badges. */
const completed = (tracks: TrackId[], extra: Partial<StoredProgress> = {}): StoredProgress => {
  const progress = emptyProgress(new Date(NOW - 30 * DAY), catalog.contentVersion);
  for (const id of tracks) {
    const track = trackOf(catalog, id)!;
    for (const lessonId of track.lessonIds) {
      progress.lessons[lessonId] = { at: isoAt(NOW - 20 * DAY), v: catalog.contentVersion, checkScore: 2 };
    }
    for (const labId of track.labIds) {
      progress.labs[labId] = { bestScore: 100, attempts: 1, criticalErrors: 0, v: catalog.contentVersion, passedAt: isoAt(NOW - 19 * DAY) };
    }
  }
  return { ...progress, ...extra };
};

const foundationBadge = (expiresAt: string, v = "1.0.0") => ({
  id: "FOUNDATION_CERTIFIED",
  track: "FOUNDATION" as const,
  earnedAt: isoAt(NOW - 100 * DAY),
  expiresAt,
  v,
});

/** Correct answers for the open session of `examId`; `wrong`/`blank` are qid sets. */
const answersFor = (store: FakeStore, userId: string, examId: string, options: { wrong?: Set<string>; blank?: Set<string> } = {}) => {
  const open = store.raw(userId)._server.open[examId]!;
  const answers: Record<string, ExamAnswer> = {};
  for (const state of open.questions) {
    const question = index.get(state.qid)!;
    if (options.blank?.has(state.qid)) continue;
    const wrong = options.wrong?.has(state.qid) ?? false;
    if (question.type === "number") {
      answers[state.qid] = wrong ? "-12345.6789" : question.answer!;
    } else if (question.type === "order") {
      const oidOf = new Map(state.opts.map((opt) => [opt.id, opt.oid]));
      const right = question.options.map((option) => oidOf.get(option.id)!);
      answers[state.qid] = wrong ? [...right].reverse() : right;
    } else {
      const correctIds = new Set(question.options.filter((option) => option.correct).map((option) => option.id));
      const oids = state.opts.filter((opt) => (wrong ? !correctIds.has(opt.id) : correctIds.has(opt.id))).map((opt) => opt.oid);
      answers[state.qid] = question.type === "multi" ? oids : oids[0]!;
    }
  }
  return answers;
};

const openOf = (store: FakeStore, userId: string, examId: string) => store.raw(userId)._server.open[examId]!;
const errorOf = async (promise: Promise<unknown>): Promise<{ code: string; statusCode: number; details?: unknown }> => {
  try {
    await promise;
  } catch (error) {
    return error as { code: string; statusCode: number; details?: unknown };
  }
  throw new Error("expected the call to throw");
};

const FORBIDDEN_KEYS = ["correct", "critical", "why", "note", "refs", "answer"];
const scanKeys = (value: unknown, path = "$"): string[] => {
  if (Array.isArray(value)) return value.flatMap((entry, i) => scanKeys(entry, `${path}[${i}]`));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, entry]) => [
      ...(FORBIDDEN_KEYS.includes(key.toLowerCase()) ? [`${path}.${key}`] : []),
      ...scanKeys(entry, `${path}.${key}`),
    ]);
  }
  return [];
};

const startFoundation = async (userId = "u1", options: { start?: number } = {}) => {
  const env = makeDeps(new FakeStore(), options.start);
  env.store.add(userId, completed(["FOUNDATION"]));
  const outcome = await startExam(env.deps, userId, "exam-foundation", true);
  return { ...env, outcome, start: outcome.value };
};

const blueprintOf = (id: string): ExamBlueprint => bank.blueprints.find((b) => b.id === id)!;
const foundation = blueprintOf("exam-foundation");

// ---- Question-set selection -------------------------------------------------------------

describe("exam set generation", () => {
  test("a fixed seed gives the identical question set and order", () => {
    const build = () => pickQuestions(foundation, bank.questions, mulberry32(seedFor("user-a", foundation.id, 1)), []).map((q) => q.id);
    expect(build()).toEqual(build());
    expect(seedFor("user-a", foundation.id, 1)).toBe(seedFor("user-a", foundation.id, 1));
    expect(seedFor("user-a", foundation.id, 1)).not.toBe(seedFor("user-a", foundation.id, 2));
    expect(seedFor("user-a", foundation.id, 1)).not.toBe(seedFor("user-b", foundation.id, 1));
  });

  test("seededShuffle is a permutation and deterministic", () => {
    const items = Array.from({ length: 30 }, (_, i) => i);
    const a = seededShuffle(items, mulberry32(7));
    expect([...a].sort((x, y) => x - y)).toEqual(items);
    expect(seededShuffle(items, mulberry32(7))).toEqual(a);
    expect(seededShuffle(items, mulberry32(8))).not.toEqual(a);
  });

  test("the same user and attempt yield the same start payload (apart from opaque ids)", async () => {
    const a = await startFoundation("same-user");
    const b = await startFoundation("same-user");
    expect(a.start.questions.map((q) => q.qid)).toEqual(b.start.questions.map((q) => q.qid));
    expect(a.start.questions.map((q) => q.options.map((o) => o.text))).toEqual(b.start.questions.map((q) => q.options.map((o) => o.text)));
  });

  test("no question repeats inside a set, for any seed and blueprint", () => {
    for (const blueprint of bank.blueprints) {
      for (let attempt = 1; attempt <= 6; attempt += 1) {
        const ids = pickQuestions(blueprint, bank.questions, mulberry32(seedFor("u", blueprint.id, attempt)), []).map((q) => q.id);
        expect(new Set(ids).size).toBe(ids.length);
      }
    }
  });

  test("prefers questions that were not in the previous attempt", () => {
    const first = pickQuestions(foundation, bank.questions, mulberry32(seedFor("u", foundation.id, 1)), []);
    const previous = first.map((q) => q.id);
    const second = pickQuestions(foundation, bank.questions, mulberry32(seedFor("u", foundation.id, 2)), previous);
    // Every module in the foundation pool has more questions than the blueprint asks for, so the
    // unseen ones must be preferred wherever enough of them exist.
    for (const { module, count } of foundation.composition) {
      const pool = bank.questions.filter((q) => q.module === module && (q.tracks.includes("FOUNDATION") || q.tracks.includes("ALL")));
      const unseen = pool.filter((q) => !previous.includes(q.id)).length;
      const repeated = second.filter((q) => q.module === module && previous.includes(q.id)).length;
      expect(repeated).toBeLessThanOrEqual(Math.max(0, count - Math.min(count, unseen)) + 2); // +2: critical top-up swaps
    }
    const overlapSecond = second.filter((q) => previous.includes(q.id)).length;
    const overlapNaive = pickQuestions(foundation, bank.questions, mulberry32(seedFor("u", foundation.id, 2)), []).filter((q) => previous.includes(q.id)).length;
    expect(overlapSecond).toBeLessThanOrEqual(overlapNaive);
  });

  test.each(bank.blueprints.map((b) => [b.id, b] as const))("%s honours module counts, size and criticalPick", (_id, blueprint) => {
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const set = pickQuestions(blueprint, bank.questions, mulberry32(seedFor("user-x", blueprint.id, attempt)), []);
      expect(set.length).toBe(blueprint.questionCount);
      for (const { module, count } of blueprint.composition) {
        expect(set.filter((q) => q.module === module).length).toBe(count);
      }
      expect(set.filter((q) => q.critical).length).toBeGreaterThanOrEqual(blueprint.criticalPick);
      for (const q of set) expect(q.tracks.includes(blueprint.track) || q.tracks.includes("ALL")).toBe(true);
    }
  });

  test("criticalPick is also honoured when avoiding the previous set", () => {
    for (const blueprint of bank.blueprints) {
      const prev = pickQuestions(blueprint, bank.questions, mulberry32(1), []).map((q) => q.id);
      const set = pickQuestions(blueprint, bank.questions, mulberry32(2), prev);
      expect(set.filter((q) => q.critical).length).toBeGreaterThanOrEqual(blueprint.criticalPick);
    }
  });

  test("buildQuestionState gives unique opaque ids and no options for number questions", () => {
    const set = pickQuestions(blueprint("exam-finance"), bank.questions, mulberry32(3), []);
    let n = 0;
    const states = buildQuestionState(set, mulberry32(4), () => (n += 1).toString(16));
    const oids = states.flatMap((s) => s.opts.map((o) => o.oid));
    expect(new Set(oids).size).toBe(oids.length);
    for (const state of states) {
      const q = index.get(state.qid)!;
      expect(state.opts.length).toBe(q.type === "number" ? 0 : q.options.length);
    }
  });
});

function blueprint(id: string): ExamBlueprint {
  return blueprintOf(id);
}

// ---- Grading ------------------------------------------------------------------------------

const q = (partial: Partial<BankQuestion> & Pick<BankQuestion, "type" | "options">): BankQuestion => ({
  id: "q-test",
  module: "m1",
  difficulty: 1,
  critical: false,
  tracks: ["ALL"],
  refs: [],
  stem: "stem",
  why: "because",
  ...partial,
});
const stateOf = (question: BankQuestion): OpenQuestionState => ({
  qid: question.id,
  opts: question.options.map((option) => ({ oid: `x-${option.id}`, id: option.id })),
});
const opt = (id: string, correct = false) => ({ id, text: `text ${id}`, ...(correct ? { correct: true } : {}) });

describe("grading by question type", () => {
  test("single: exactly the key is correct; two selections or a foreign id are not", () => {
    const question = q({ type: "single", options: [opt("a"), opt("b", true), opt("c")] });
    const state = stateOf(question);
    expect(gradeQuestion(question, state, "x-b").correct).toBe(true);
    expect(gradeQuestion(question, state, "x-a").correct).toBe(false);
    expect(gradeQuestion(question, state, ["x-b", "x-a"]).correct).toBe(false);
    expect(gradeQuestion(question, state, "b").correct).toBe(false); // raw bank id is not an oid
    const foreign = gradeQuestion(question, state, "nope");
    expect(foreign.correct).toBe(false);
    expect(foreign.answered).toBe(false);
  });

  test("single result item reveals keys/selection only after grading", () => {
    const question = q({ type: "single", options: [opt("a"), { ...opt("b", true), note: "n" }] });
    const item = gradeQuestion(question, stateOf(question), "x-a").item;
    expect(item.options?.map((o) => [o.oid, o.correct, o.selected])).toEqual([["x-a", false, true], ["x-b", true, false]]);
    expect(item.options?.[1]?.note).toBe("n");
  });

  test("number without tolerance is exact numerically (not textually)", () => {
    const question = q({ type: "number", options: [], answer: "103.0000" });
    const state = stateOf(question);
    expect(gradeQuestion(question, state, "103").correct).toBe(true);
    expect(gradeQuestion(question, state, " 103.00 ").correct).toBe(true);
    expect(gradeQuestion(question, state, "103.0001").correct).toBe(false);
    expect(gradeQuestion(question, state, "abc").correct).toBe(false);
    expect(gradeQuestion(question, state, "").answered).toBe(false);
    expect(gradeQuestion(question, state, ["103"]).correct).toBe(false);
  });

  test("number with tolerance accepts the closed interval", () => {
    const question = q({ type: "number", options: [], answer: "10.00", tolerance: "0.05" });
    const state = stateOf(question);
    for (const good of ["10.05", "9.95", "10", "10.03"]) expect(gradeQuestion(question, state, good).correct).toBe(true);
    for (const bad of ["10.06", "9.94", "11", "NaN", "Infinity"]) expect(gradeQuestion(question, state, bad).correct).toBe(false);
    expect(gradeQuestion(question, state, "10.05").item.number?.tolerance).toBe("0.05");
  });

  test("number does not lose precision on large decimals", () => {
    const question = q({ type: "number", options: [], answer: "0.1" });
    expect(gradeQuestion(question, stateOf(question), "0.10000000000000001").correct).toBe(false);
    expect(gradeQuestion(question, stateOf(question), "0.1000").correct).toBe(true);
  });

  test("order: the full sequence must match", () => {
    const question = q({ type: "order", options: [opt("1"), opt("2"), opt("3")] });
    const state = stateOf(question);
    expect(gradeQuestion(question, state, ["x-1", "x-2", "x-3"]).correct).toBe(true);
    expect(gradeQuestion(question, state, ["x-2", "x-1", "x-3"]).correct).toBe(false);
    expect(gradeQuestion(question, state, ["x-1", "x-2"]).correct).toBe(false);
    expect(gradeQuestion(question, state, ["x-1", "x-2", "x-3", "x-3"]).correct).toBe(false);
    const wrong = gradeQuestion(question, state, ["x-3", "x-2", "x-1"]).item.order!;
    expect(wrong.correctOrder).toEqual(["x-1", "x-2", "x-3"]);
    expect(wrong.yourOrder).toEqual(["x-3", "x-2", "x-1"]);
  });

  test("multi (synthetic): all-or-nothing on the exact set", () => {
    const question = q({ type: "multi", options: [opt("a", true), opt("b"), opt("c", true), opt("d")] });
    const state = stateOf(question);
    expect(gradeQuestion(question, state, ["x-a", "x-c"]).correct).toBe(true);
    expect(gradeQuestion(question, state, ["x-c", "x-a"]).correct).toBe(true);
    expect(gradeQuestion(question, state, ["x-a", "x-a", "x-c"]).correct).toBe(true); // duplicates collapse
    expect(gradeQuestion(question, state, ["x-a"]).correct).toBe(false);
    expect(gradeQuestion(question, state, ["x-a", "x-c", "x-b"]).correct).toBe(false);
    expect(gradeQuestion(question, state, ["x-b", "x-d"]).correct).toBe(false);
    expect(gradeQuestion(question, state, []).answered).toBe(false);
  });

  test("truefalse (synthetic): one selection that is the key", () => {
    const question = q({ type: "truefalse", options: [opt("t", true), opt("f")] });
    const state = stateOf(question);
    expect(gradeQuestion(question, state, "x-t").correct).toBe(true);
    expect(gradeQuestion(question, state, "x-f").correct).toBe(false);
    expect(gradeQuestion(question, state, ["x-t", "x-f"]).correct).toBe(false);
  });

  test("unanswered counts as wrong and a missed critical question is counted", () => {
    const crit = q({ id: "c1", type: "single", critical: true, options: [opt("a", true), opt("b")] });
    const plain = q({ id: "p1", type: "single", options: [opt("a", true), opt("b")] });
    const graded = gradeExam([crit, plain], [stateOf(crit), stateOf(plain)], {});
    expect(graded.points).toBe(0);
    expect(graded.scorePercent).toBe(0);
    expect(graded.criticalMissed).toBe(1);
    expect(graded.items.every((item) => !item.answered && !item.correct)).toBe(true);
  });

  test("a wrong non-critical answer is not counted as critical missed; zeroOut ignores answers", () => {
    const crit = q({ id: "c1", type: "single", critical: true, options: [opt("a", true), opt("b")] });
    const plain = q({ id: "p1", type: "single", options: [opt("a", true), opt("b")] });
    const states = [stateOf(crit), stateOf(plain)];
    const answers = { c1: "x-a", p1: "x-b" };
    const normal = gradeExam([crit, plain], states, answers);
    expect([normal.points, normal.criticalMissed, normal.scorePercent]).toEqual([1, 0, 50]);
    const zero = gradeExam([crit, plain], states, answers, { zeroOut: true });
    expect([zero.points, zero.criticalMissed, zero.scorePercent]).toEqual([0, 1, 0]);
  });

  test("module scores and review-required modules (< 70 %)", () => {
    const qs = [
      q({ id: "a1", module: "m1", type: "single", options: [opt("a", true), opt("b")] }),
      q({ id: "a2", module: "m1", type: "single", options: [opt("a", true), opt("b")] }),
      q({ id: "b1", module: "m2", type: "single", options: [opt("a", true), opt("b")] }),
      q({ id: "b2", module: "m2", type: "single", options: [opt("a", true), opt("b")] }),
      q({ id: "b3", module: "m2", type: "single", options: [opt("a", true), opt("b")] }),
    ];
    const graded = gradeExam(qs, qs.map(stateOf), { a1: "x-a", a2: "x-a", b1: "x-a", b2: "x-b", b3: "x-b" });
    expect(graded.moduleScores).toEqual({ m1: 100, m2: 33 });
    expect(graded.reviewRequired).toEqual(["m2"]);
    expect(graded.scorePercent).toBe(60);
  });

  test("percent rounds half up and handles empty", () => {
    expect(percent(1, 8)).toBe(13); // 12.5
    expect(percent(5, 8)).toBe(63); // 62.5
    expect(percent(3, 8)).toBe(38); // 37.5
    expect(percent(1, 3)).toBe(33);
    expect(percent(2, 3)).toBe(67);
    expect(percent(24, 24)).toBe(100);
    expect(percent(0, 24)).toBe(0);
    expect(percent(0, 0)).toBe(0);
  });
});

// ---- Pass rules on every real blueprint (pure) --------------------------------------------

describe("pass rules from the blueprint", () => {
  test.each(bank.blueprints.map((b) => [b.id, b] as const))("%s: perfect minus one critical fails; minus one non-critical follows the blueprint", (_id, bp) => {
    const set = pickQuestions(bp, bank.questions, mulberry32(seedFor("rules", bp.id, 1)), []);
    const states = buildQuestionState(set, mulberry32(9), (() => { let n = 0; return () => (n += 1).toString(16); })());
    const perfect: Record<string, ExamAnswer> = {};
    const correctAnswer = (question: BankQuestion, state: OpenQuestionState): ExamAnswer => {
      if (question.type === "number") return question.answer!;
      if (question.type === "order") return question.options.map((o) => state.opts.find((s) => s.id === o.id)!.oid);
      return state.opts.find((s) => question.options.find((o) => o.id === s.id)?.correct)!.oid;
    };
    states.forEach((state, i) => (perfect[state.qid] = correctAnswer(set[i]!, state)));
    const full = gradeExam(set, states, perfect);
    expect(full.scorePercent).toBe(100);
    expect(full.criticalMissed).toBe(0);

    const critical = set.find((x) => x.critical)!;
    const missCritical = gradeExam(set, states, { ...perfect, [critical.id]: "nope" });
    expect(missCritical.criticalMissed).toBe(1);
    const decide = (graded: { scorePercent: number; criticalMissed: number }) => graded.scorePercent >= bp.passPercent && graded.criticalMissed === 0;
    expect(decide(missCritical)).toBe(false);

    const plain = set.find((x) => !x.critical)!;
    const missPlain = gradeExam(set, states, { ...perfect, [plain.id]: "nope" });
    expect(missPlain.criticalMissed).toBe(0);
    expect(missPlain.scorePercent).toBe(percent(set.length - 1, set.length));
    expect(decide(missPlain)).toBe(percent(set.length - 1, set.length) >= bp.passPercent);
  });
});

// ---- Start payload -------------------------------------------------------------------------

describe("exam start payload", () => {
  test("contains no answer-bearing key anywhere (deep scan)", async () => {
    const { start } = await startFoundation();
    expect(scanKeys(start)).toEqual([]);
    expect(start.questions.length).toBe(foundation.questionCount);
    expect(start.questionCount).toBe(foundation.questionCount);
    expect(start.resumed).toBe(false);
    for (const question of start.questions) {
      expect(Object.keys(question).sort()).toEqual(["options", "qid", "stem", "type"]);
      for (const option of question.options) expect(Object.keys(option).sort()).toEqual(["oid", "text"]);
    }
  });

  test("option ids are opaque (never the bank ids) and differ between two sessions", async () => {
    const env = makeDeps();
    env.store.add("a", completed(["FOUNDATION"]));
    env.store.add("b", completed(["FOUNDATION"]));
    const a = (await startExam(env.deps, "a", "exam-foundation", true)).value;
    const b = (await startExam(env.deps, "b", "exam-foundation", true)).value;
    const oidsA = a.questions.flatMap((x) => x.options.map((o) => o.oid));
    const oidsB = b.questions.flatMap((x) => x.options.map((o) => o.oid));
    expect(oidsA.filter((oid) => oidsB.includes(oid))).toEqual([]);
    const bankIds = new Set(bank.questions.flatMap((x) => x.options.map((o) => o.id)));
    expect(oidsA.some((oid) => bankIds.has(oid) && oid.length <= 3)).toBe(false);
    expect(new Set(oidsA).size).toBe(oidsA.length);
  });

  test("resume returns the SAME questions and option ids with resumed:true", async () => {
    const { deps, start, store } = await startFoundation();
    const again = (await startExam(deps, "u1", "exam-foundation", false)).value; // no re-acceptance needed to resume
    expect(again.resumed).toBe(true);
    expect(again.sessionId).toBe(start.sessionId);
    expect(again.expiresAt).toBe(start.expiresAt);
    expect(again.questions).toEqual(start.questions);
    expect(store.raw("u1").exams["exam-foundation"]!.attempts.length).toBe(0);
  });

  test("a live session makes the exam eligible and counts nothing as an attempt", async () => {
    const { deps } = await startFoundation();
    expect(await getEligibility(deps, "u1", "exam-foundation")).toEqual({ eligible: true, missing: [] });
  });

  test("abandon, expire, start again: new attempt number and a different set", async () => {
    const { deps, store, clock } = await startFoundation();
    const first = openOf(store, "u1", "exam-foundation");
    expect(first.attemptNumber).toBe(1);
    clock.t += foundation.timeLimitMinutes * MIN + 1000; // never submitted
    const second = (await startExam(deps, "u1", "exam-foundation", true)).value;
    const open2 = openOf(store, "u1", "exam-foundation");
    expect(second.resumed).toBe(false);
    expect(open2.attemptNumber).toBe(2);
    expect(open2.sessionId).not.toBe(first.sessionId);
    expect(open2.questions.map((x) => x.qid).sort()).not.toEqual(first.questions.map((x) => x.qid).sort());
    expect(store.raw("u1").exams["exam-foundation"]!.attempts.length).toBe(0);
    // No penalty for abandoning: no cooldown.
    clock.t += foundation.timeLimitMinutes * MIN + 1000;
    expect((await startExam(deps, "u1", "exam-foundation", true)).value.resumed).toBe(false);
    expect(openOf(store, "u1", "exam-foundation").attemptNumber).toBe(3);
  });

  test("integrity statement not accepted -> ACADEMY_INTEGRITY_REQUIRED, nothing stored", async () => {
    const env = makeDeps();
    env.store.add("u1", completed(["FOUNDATION"]));
    const error = await errorOf(startExam(env.deps, "u1", "exam-foundation", false));
    expect(error.code).toBe("ACADEMY_INTEGRITY_REQUIRED");
    expect(env.store.raw("u1")._server.open["exam-foundation"]).toBeUndefined();
  });

  test("accepting records integrityAcceptedAt", async () => {
    const { store } = await startFoundation();
    expect(store.raw("u1").integrityAcceptedAt).toBe(isoAt(NOW));
  });

  test("unknown exam and unknown user", async () => {
    const env = makeDeps();
    env.store.add("u1", null);
    expect((await errorOf(startExam(env.deps, "u1", "exam-nope", true))).code).toBe("ACADEMY_EXAM_NOT_FOUND");
    expect((await errorOf(startExam(env.deps, "ghost", "exam-foundation", true))).code).toBe("USER_NOT_FOUND");
  });

  test("not eligible -> 422 ACADEMY_NOT_ELIGIBLE carrying the missing list", async () => {
    const env = makeDeps();
    env.store.add("u1", null);
    const error = await errorOf(startExam(env.deps, "u1", "exam-foundation", true));
    expect(error.statusCode).toBe(422);
    expect(error.code).toBe("ACADEMY_NOT_ELIGIBLE");
    expect((error.details as { eligible: boolean }).eligible).toBe(false);
  });
});

// ---- Eligibility ---------------------------------------------------------------------------

describe("eligibility", () => {
  const now = new Date(NOW);
  const support = blueprintOf("exam-support");

  test("a role exam is refused without a Foundation badge and names lessons and labs by title", () => {
    const progress = emptyProgress(now, catalog.contentVersion);
    const result = computeEligibility(progress, support, catalog, now);
    expect(result.eligible).toBe(false);
    expect(result.missing[0]).toMatchObject({ kind: "foundation_badge", id: "FOUNDATION" });
    const track = trackOf(catalog, "SUPPORT")!;
    for (const lessonId of track.lessonIds) {
      const entry = result.missing.find((m) => m.kind === "lesson" && m.id === lessonId)!;
      expect(entry.text).toContain(lessonTitle(catalog, lessonId));
      expect(lessonTitle(catalog, lessonId)).not.toBe(lessonId);
    }
    for (const labId of track.labIds) {
      const entry = result.missing.find((m) => m.kind === "lab" && m.id === labId)!;
      expect(entry.text).toContain(labOf(catalog, labId)!.title);
    }
  });

  test("an expired Foundation badge -> foundation_expired (not foundation_badge)", () => {
    const progress = completed(["SUPPORT"], { badges: [foundationBadge(isoAt(NOW - DAY))] });
    const result = computeEligibility(progress, support, catalog, now);
    expect(result.missing.map((m) => m.kind)).toEqual(["foundation_expired"]);
  });

  test("a Foundation badge below recertifyFrom counts as out of date", () => {
    const strict = { ...catalog, recertifyFrom: "2.0.0" };
    const progress = completed(["SUPPORT"], { badges: [foundationBadge(isoAt(NOW + 100 * DAY), "1.4.0")] });
    expect(computeEligibility(progress, support, strict, now).missing.map((m) => m.kind)).toEqual(["foundation_expired"]);
    expect(computeEligibility(progress, support, catalog, now).eligible).toBe(true);
  });

  test("a valid Foundation badge plus everything done -> eligible", () => {
    const progress = completed(["SUPPORT"], { badges: [foundationBadge(isoAt(NOW + 100 * DAY))] });
    expect(computeEligibility(progress, support, catalog, now)).toEqual({ eligible: true, missing: [] });
  });

  test("lab with bestScore >= pass but critical errors -> lab_critical (not lab)", () => {
    const progress = completed(["FOUNDATION"]);
    const labId = trackOf(catalog, "FOUNDATION")!.labIds[0]!;
    progress.labs[labId] = { bestScore: 95, attempts: 3, criticalErrors: 1, v: "1.0.0" };
    const result = computeEligibility(progress, foundation, catalog, now);
    expect(result.missing).toHaveLength(1);
    expect(result.missing[0]).toMatchObject({ kind: "lab_critical", id: labId });
    expect(result.missing[0]!.text).toContain(labOf(catalog, labId)!.title);
  });

  test("a lab below the pass mark is a plain lab entry", () => {
    const progress = completed(["FOUNDATION"]);
    const labId = trackOf(catalog, "FOUNDATION")!.labIds[0]!;
    progress.labs[labId] = { bestScore: 79, attempts: 1, criticalErrors: 0, v: "1.0.0" };
    expect(computeEligibility(progress, foundation, catalog, now).missing.map((m) => m.kind)).toEqual(["lab"]);
  });

  test("a getEligibility call on an untouched user lists lessons and labs without writing", async () => {
    const env = makeDeps();
    env.store.add("u1", null);
    const result = await getEligibility(env.deps, "u1", "exam-foundation");
    expect(result.eligible).toBe(false);
    expect(result.missing.length).toBe(trackOf(catalog, "FOUNDATION")!.lessonIds.length + trackOf(catalog, "FOUNDATION")!.labIds.length);
    expect(env.store.rows.get("u1")!.json).toBeNull();
  });
});

// ---- Submit, badges, cooldown, review --------------------------------------------------------

describe("exam submission", () => {
  test("perfect score passes, issues a 12-month badge and records the attempt", async () => {
    const { deps, store, clock } = await startFoundation();
    clock.t += 20 * MIN;
    const { value, events } = await submitExam(deps, "u1", "exam-foundation", {
      sessionId: openOf(store, "u1", "exam-foundation").sessionId,
      answers: answersFor(store, "u1", "exam-foundation"),
    });
    expect(value).toMatchObject({ passed: true, scorePercent: 100, criticalMissed: 0, expired: false, attemptNumber: 1, passPercent: 80 });
    expect(value.durationSeconds).toBe(20 * 60);
    expect(value.cooldownUntil).toBeUndefined();
    expect(value.badge).toMatchObject({ id: "FOUNDATION_CERTIFIED", track: "FOUNDATION" });
    expect(value.badge!.earnedAt).toBe(isoAt(clock.t));
    expect(value.badge!.expiresAt).toBe("2027-11-04T12:20:00.000Z");
    expect(events.map((e) => e.action)).toEqual(["ACADEMY_EXAM_SUBMITTED", "ACADEMY_BADGE_ISSUED"]);
    const stored = store.raw("u1");
    expect(stored.badges).toHaveLength(1);
    expect(stored.exams["exam-foundation"]!.attempts).toHaveLength(1);
    expect(stored.exams["exam-foundation"]!.open).toBeUndefined();
    expect(stored._server.open["exam-foundation"]).toBeUndefined();
  });

  test("addMonthsUtc is 12 calendar months and clamps short months", () => {
    expect(addMonthsUtc(new Date("2026-11-04T12:00:00Z"), 12).toISOString()).toBe("2027-11-04T12:00:00.000Z");
    expect(addMonthsUtc(new Date("2024-02-29T08:00:00Z"), 12).toISOString()).toBe("2025-02-28T08:00:00.000Z");
    expect(addMonthsUtc(new Date("2026-01-31T00:00:00Z"), 1).toISOString()).toBe("2026-02-28T00:00:00.000Z");
  });

  test("passing replaces an expired badge of the same track and keeps other tracks", async () => {
    const env = makeDeps();
    const other = { id: "CERTIFIED_SUPPORT", track: "SUPPORT" as const, earnedAt: isoAt(NOW - 10 * DAY), expiresAt: isoAt(NOW + 300 * DAY), v: "1.0.0" };
    env.store.add("u1", completed(["FOUNDATION"], { badges: [foundationBadge(isoAt(NOW - 5 * DAY)), other] }));
    await startExam(env.deps, "u1", "exam-foundation", true);
    const { value } = await submitExam(env.deps, "u1", "exam-foundation", {
      sessionId: openOf(env.store, "u1", "exam-foundation").sessionId,
      answers: answersFor(env.store, "u1", "exam-foundation"),
    });
    expect(value.passed).toBe(true);
    const badges = env.store.raw("u1").badges;
    expect(badges.filter((b) => b.track === "FOUNDATION")).toHaveLength(1);
    expect(badges.find((b) => b.track === "FOUNDATION")!.expiresAt).toBe(value.badge!.expiresAt);
    expect(Date.parse(value.badge!.expiresAt)).toBeGreaterThan(NOW);
    expect(badges.find((b) => b.track === "SUPPORT")).toEqual(other);
  });

  test("perfect score minus ONE CRITICAL question fails", async () => {
    const { deps, store } = await startFoundation();
    const open = openOf(store, "u1", "exam-foundation");
    const critical = open.questions.find((s) => index.get(s.qid)!.critical)!;
    const { value } = await submitExam(deps, "u1", "exam-foundation", {
      sessionId: open.sessionId,
      answers: answersFor(store, "u1", "exam-foundation", { wrong: new Set([critical.qid]) }),
    });
    expect(value.criticalMissed).toBe(1);
    expect(value.scorePercent).toBe(percent(foundation.questionCount - 1, foundation.questionCount));
    expect(value.scorePercent).toBeGreaterThanOrEqual(foundation.passPercent);
    expect(value.passed).toBe(false);
    expect(value.badge).toBeUndefined();
    expect(store.raw("u1").badges).toHaveLength(0);
  });

  test("perfect score minus one NON-critical question passes exactly when the blueprint says so", async () => {
    const { deps, store } = await startFoundation();
    const open = openOf(store, "u1", "exam-foundation");
    const plain = open.questions.find((s) => !index.get(s.qid)!.critical)!;
    const { value } = await submitExam(deps, "u1", "exam-foundation", {
      sessionId: open.sessionId,
      answers: answersFor(store, "u1", "exam-foundation", { wrong: new Set([plain.qid]) }),
    });
    const expectedScore = percent(foundation.questionCount - 1, foundation.questionCount);
    expect(value.scorePercent).toBe(expectedScore);
    expect(value.criticalMissed).toBe(0);
    expect(value.passed).toBe(expectedScore >= foundation.passPercent);
  });

  test("just below the pass mark fails (non-critical misses only)", async () => {
    const { deps, store } = await startFoundation();
    const open = openOf(store, "u1", "exam-foundation");
    const plain = open.questions.filter((s) => !index.get(s.qid)!.critical).map((s) => s.qid);
    // Smallest number of misses that drops the rounded score under the pass mark.
    let misses = 1;
    while (percent(foundation.questionCount - misses, foundation.questionCount) >= foundation.passPercent) misses += 1;
    const { value } = await submitExam(deps, "u1", "exam-foundation", {
      sessionId: open.sessionId,
      answers: answersFor(store, "u1", "exam-foundation", { wrong: new Set(plain.slice(0, misses)) }),
    });
    expect(value.scorePercent).toBeLessThan(foundation.passPercent);
    expect(value.passed).toBe(false);
  });

  test("unanswered questions are wrong", async () => {
    const { deps, store } = await startFoundation();
    const open = openOf(store, "u1", "exam-foundation");
    const { value } = await submitExam(deps, "u1", "exam-foundation", { sessionId: open.sessionId, answers: {} });
    expect(value.scorePercent).toBe(0);
    expect(value.passed).toBe(false);
    expect(value.items.every((item) => !item.answered && !item.correct)).toBe(true);
    expect(value.items.length).toBe(foundation.questionCount);
    expect(value.criticalMissed).toBe(open.questions.filter((s) => index.get(s.qid)!.critical).length);
  });

  test("late beyond the 2-minute grace is failed with score 0 and expired:true", async () => {
    const { deps, store, clock } = await startFoundation();
    const open = openOf(store, "u1", "exam-foundation");
    const answers = answersFor(store, "u1", "exam-foundation");
    clock.t = Date.parse(open.expiresAt) + SUBMIT_GRACE_MS + 1;
    const { value, events } = await submitExam(deps, "u1", "exam-foundation", { sessionId: open.sessionId, answers });
    expect(value.expired).toBe(true);
    expect(value.passed).toBe(false);
    expect(value.scorePercent).toBe(0);
    expect(value.badge).toBeUndefined();
    expect(value.durationSeconds).toBe(foundation.timeLimitMinutes * 60); // capped at the limit
    expect(events.map((e) => e.action)).toEqual(["ACADEMY_EXAM_SUBMITTED"]);
    expect(store.raw("u1").exams["exam-foundation"]!.attempts[0]!.passed).toBe(false);
  });

  test("within the grace the answers are graded normally", async () => {
    const { deps, store, clock } = await startFoundation();
    const open = openOf(store, "u1", "exam-foundation");
    const answers = answersFor(store, "u1", "exam-foundation");
    clock.t = Date.parse(open.expiresAt) + SUBMIT_GRACE_MS; // exactly at the edge
    const { value } = await submitExam(deps, "u1", "exam-foundation", { sessionId: open.sessionId, answers });
    expect(value.expired).toBe(false);
    expect(value.passed).toBe(true);
    expect(value.scorePercent).toBe(100);
  });

  test("a second submit of the same session -> ACADEMY_SESSION_USED; unknown -> ACADEMY_SESSION_EXPIRED", async () => {
    const { deps, store } = await startFoundation();
    const open = openOf(store, "u1", "exam-foundation");
    const body = { sessionId: open.sessionId, answers: answersFor(store, "u1", "exam-foundation") };
    await submitExam(deps, "u1", "exam-foundation", body);
    const again = await errorOf(submitExam(deps, "u1", "exam-foundation", body));
    expect(again.code).toBe("ACADEMY_SESSION_USED");
    expect(again.statusCode).toBe(422);
    expect((await errorOf(submitExam(deps, "u1", "exam-foundation", { sessionId: "made-up", answers: {} }))).code).toBe("ACADEMY_SESSION_EXPIRED");
  });

  test("a session of another exam or user is not a valid session", async () => {
    const env = makeDeps();
    env.store.add("a", completed(["FOUNDATION"]));
    env.store.add("b", completed(["FOUNDATION"]));
    const a = (await startExam(env.deps, "a", "exam-foundation", true)).value;
    expect((await errorOf(submitExam(env.deps, "b", "exam-foundation", { sessionId: a.sessionId, answers: {} }))).code).toBe("ACADEMY_SESSION_EXPIRED");
    expect((await errorOf(submitExam(env.deps, "a", "exam-support", { sessionId: a.sessionId, answers: {} }))).code).toBe("ACADEMY_SESSION_EXPIRED");
    expect((await errorOf(submitExam(env.deps, "a", "exam-nope", { sessionId: a.sessionId, answers: {} }))).code).toBe("ACADEMY_EXAM_NOT_FOUND");
  });

  test("forged answers (bank ids, foreign oids, wrong shapes) never score", async () => {
    const { deps, store } = await startFoundation();
    const open = openOf(store, "u1", "exam-foundation");
    const answers: Record<string, ExamAnswer> = {};
    for (const state of open.questions) {
      const question = index.get(state.qid)!;
      answers[state.qid] = question.type === "number" ? "0" : question.options.filter((o) => o.correct).map((o) => o.id)[0] ?? "x"; // bank ids, not oids
    }
    const { value } = await submitExam(deps, "u1", "exam-foundation", { sessionId: open.sessionId, answers });
    expect(value.passed).toBe(false);
    expect(value.scorePercent).toBeLessThan(foundation.passPercent);
  });

  test("a failure sets the cooldown and blocks a new start until it passes", async () => {
    const { deps, store, clock } = await startFoundation();
    const open = openOf(store, "u1", "exam-foundation");
    const { value } = await submitExam(deps, "u1", "exam-foundation", { sessionId: open.sessionId, answers: {} });
    const until = isoAt(clock.t + foundation.cooldownMinutes * MIN);
    expect(value.cooldownUntil).toBe(until);
    const eligibility = await getEligibility(deps, "u1", "exam-foundation");
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.cooldownUntil).toBe(until);
    expect(eligibility.missing.map((m) => m.kind)).toEqual(["cooldown"]);
    const error = await errorOf(startExam(deps, "u1", "exam-foundation", true));
    expect(error.code).toBe("ACADEMY_NOT_ELIGIBLE");
    clock.t += foundation.cooldownMinutes * MIN + 1;
    expect((await getEligibility(deps, "u1", "exam-foundation")).eligible).toBe(true);
    const next = await startExam(deps, "u1", "exam-foundation", true);
    expect(openOf(store, "u1", "exam-foundation").attemptNumber).toBe(2);
    expect(next.value.resumed).toBe(false);
  });

  test("the next attempt prefers questions not seen in the failed one", async () => {
    const { deps, store, clock } = await startFoundation();
    const first = openOf(store, "u1", "exam-foundation").questions.map((x) => x.qid);
    await submitExam(deps, "u1", "exam-foundation", { sessionId: openOf(store, "u1", "exam-foundation").sessionId, answers: {} });
    clock.t += foundation.cooldownMinutes * MIN + 1;
    await startExam(deps, "u1", "exam-foundation", true);
    const second = openOf(store, "u1", "exam-foundation").questions.map((x) => x.qid);
    expect([...second].sort()).not.toEqual([...first].sort());
    expect(second.filter((id) => first.includes(id)).length).toBeLessThan(first.length / 2 + 4);
  });

  test("review required after 3 consecutive failures, cleared by re-opening a lesson of that module", async () => {
    const { deps, store, clock } = await startFoundation();
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      if (attempt > 1) {
        clock.t += foundation.cooldownMinutes * MIN + 1;
        await startExam(deps, "u1", "exam-foundation", true);
      }
      const { value } = await submitExam(deps, "u1", "exam-foundation", { sessionId: openOf(store, "u1", "exam-foundation").sessionId, answers: {} });
      if (attempt < 3) expect(value.reviewRequired.length).toBeGreaterThan(0); // result-level modules < 70 %
    }
    clock.t += foundation.cooldownMinutes * MIN + 1;
    const blocked = await getEligibility(deps, "u1", "exam-foundation");
    expect(blocked.eligible).toBe(false);
    const modules = foundation.composition.map((c) => c.module);
    expect([...blocked.reviewRequired!].sort()).toEqual([...modules].sort());
    expect(blocked.missing.every((m) => m.kind === "review_lesson")).toBe(true);
    const sample = blocked.missing.find((m) => m.id === modules[0])!;
    expect(sample.text).toContain(catalog.modules.find((m) => m.id === modules[0])!.title);
    expect((await errorOf(startExam(deps, "u1", "exam-foundation", true))).code).toBe("ACADEMY_NOT_ELIGIBLE");

    // Re-open one lesson of all but one module: that one stays pending.
    const reopen = (module: string) => catalog.lessons.find((lesson) => lesson.module === module)!.id;
    const patchFor = (mods: string[]) =>
      Object.fromEntries(mods.map((m) => [reopen(m), { at: isoAt(clock.t), v: catalog.contentVersion, checkScore: 2 as const }]));
    const rev = store.raw("u1").rev;
    await putProgress(deps, "u1", rev, { lessons: patchFor(modules.slice(1)) });
    const partial = await getEligibility(deps, "u1", "exam-foundation");
    expect(partial.reviewRequired).toEqual([modules[0]!]);
    await putProgress(deps, "u1", rev + 1, { lessons: patchFor([modules[0]!]) });
    const cleared = await getEligibility(deps, "u1", "exam-foundation");
    expect(cleared).toEqual({ eligible: true, missing: [] });
    expect((await startExam(deps, "u1", "exam-foundation", true)).value.resumed).toBe(false);
  });

  test("two failures are not enough for a review requirement; a pass in between resets the streak", async () => {
    const { deps, store, clock } = await startFoundation();
    await submitExam(deps, "u1", "exam-foundation", { sessionId: openOf(store, "u1", "exam-foundation").sessionId, answers: {} });
    clock.t += foundation.cooldownMinutes * MIN + 1;
    await startExam(deps, "u1", "exam-foundation", true);
    await submitExam(deps, "u1", "exam-foundation", { sessionId: openOf(store, "u1", "exam-foundation").sessionId, answers: {} });
    clock.t += foundation.cooldownMinutes * MIN + 1;
    expect((await getEligibility(deps, "u1", "exam-foundation")).reviewRequired).toBeUndefined();
    await startExam(deps, "u1", "exam-foundation", true);
    await submitExam(deps, "u1", "exam-foundation", {
      sessionId: openOf(store, "u1", "exam-foundation").sessionId,
      answers: answersFor(store, "u1", "exam-foundation"),
    });
    expect(store.raw("u1").exams["exam-foundation"]!.attempts.map((a) => a.passed)).toEqual([false, false, true]);
    expect(store.raw("u1").exams["exam-foundation"]!.passedAt).toBeDefined();
  });

  test("a role exam needs the Foundation badge earned in the same store flow", async () => {
    const env = makeDeps();
    env.store.add("u1", completed(["FOUNDATION", "SUPPORT"]));
    expect((await errorOf(startExam(env.deps, "u1", "exam-support", true))).code).toBe("ACADEMY_NOT_ELIGIBLE");
    await startExam(env.deps, "u1", "exam-foundation", true);
    await submitExam(env.deps, "u1", "exam-foundation", {
      sessionId: openOf(env.store, "u1", "exam-foundation").sessionId,
      answers: answersFor(env.store, "u1", "exam-foundation"),
    });
    const started = await startExam(env.deps, "u1", "exam-support", true);
    expect(started.value.questionCount).toBe(blueprintOf("exam-support").questionCount);
    expect(scanKeys(started.value)).toEqual([]);
  });

  test("the result of a number question carries the expected answer only after grading", async () => {
    const env = makeDeps();
    env.store.add("u1", completed(["FOUNDATION", "FINANCE"], { badges: [foundationBadge(isoAt(NOW + 100 * DAY))] }));
    const started = await startExam(env.deps, "u1", "exam-finance", true);
    expect(scanKeys(started.value)).toEqual([]);
    const withNumber = started.value.questions.filter((x) => x.type === "number");
    for (const n of withNumber) expect(n.options).toEqual([]);
    const { value } = await submitExam(env.deps, "u1", "exam-finance", {
      sessionId: openOf(env.store, "u1", "exam-finance").sessionId,
      answers: answersFor(env.store, "u1", "exam-finance"),
    });
    expect(value.passed).toBe(true);
    for (const item of value.items.filter((i) => i.type === "number")) expect(item.number?.correctAnswer).toBe(index.get(item.qid)!.answer!);
  });

  test("progress read after a start never exposes sessions' option mapping", async () => {
    const { deps, store } = await startFoundation();
    const { value } = await getProgress(deps, "u1");
    const text = JSON.stringify(value);
    expect(text).not.toContain("_server");
    expect(text).not.toContain("questions");
    const open = openOf(store, "u1", "exam-foundation");
    expect(value.progress.exams["exam-foundation"]!.open).toEqual({ sessionId: open.sessionId, startedAt: open.startedAt, expiresAt: open.expiresAt });
  });
});
