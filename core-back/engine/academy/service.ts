import { ApiError } from "../../lib/error";
import {
  addMonthsUtc,
  blueprintOf,
  isBadgeValid,
  labOf,
  lessonTitle,
  loadCatalog,
  loadExamBank,
  moduleTitle,
  questionIndex,
  trackOf,
} from "./catalog";
import { buildQuestionState, mulberry32, pickQuestions, seedFor } from "./examEngine";
import { gradeExam, REVIEW_BELOW_PERCENT } from "./grading";
import {
  applyClientPatch,
  exceedsLimit,
  isLabPassed,
  parseStoredProgress,
  patchKeyCounts,
  publicProgress,
} from "./progress";
import type {
  AcademyBadge,
  AcademyContext,
  AcademyEvent,
  AcademyStore,
  Catalog,
  Eligibility,
  EligibilityMissing,
  ExamBank,
  ExamBlueprint,
  ExamQuestionPublic,
  ExamResult,
  ExamStartResponse,
  ExamSubmitBody,
  Outcome,
  ProgressEnvelope,
  ProgressPatch,
  StoredProgress,
} from "./types";

/** Grace after `expiresAt` within which a submission is still graded. */
export const SUBMIT_GRACE_MS = 2 * 60 * 1000;
const MAX_WRITE_ATTEMPTS = 4;
const CONSECUTIVE_FAILS_FOR_REVIEW = 3;
const MAX_STORED_ATTEMPTS = 20;

export interface AcademyDeps {
  store: AcademyStore;
  ctx: AcademyContext;
  catalog?: Catalog;
  bank?: ExamBank;
}

const resolve = (deps: AcademyDeps) => ({
  catalog: deps.catalog ?? loadCatalog(),
  bank: deps.bank ?? loadExamBank(),
});

interface MutationResult<T> {
  /** `null` = nothing to persist. */
  next: StoredProgress | null;
  /** Bump `rev`/`updatedAt` (every write except the very first empty-record creation). */
  bump?: boolean;
  value: T;
  events?: AcademyEvent[];
}

/** Load → mutate → compare-and-swap save, retried when another request won the race. */
const mutate = async <T>(
  deps: AcademyDeps,
  userId: string,
  fn: (progress: StoredProgress, isNew: boolean, now: Date) => MutationResult<T>,
): Promise<Outcome<T>> => {
  const { catalog } = resolve(deps);
  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
    const record = await deps.store.load(userId);
    if (!record) throw new ApiError(404, "USER_NOT_FOUND", "The user does not exist");
    const now = deps.ctx.now();
    const { progress, isNew } = parseStoredProgress(record.json, catalog, now);
    const result = fn(progress, isNew, now);
    if (!result.next) return { value: result.value, events: result.events ?? [] };
    const next: StoredProgress = result.bump === false
      ? result.next
      : { ...result.next, rev: progress.rev + 1, updatedAt: now.toISOString(), contentVersion: catalog.contentVersion };
    if (exceedsLimit(next)) {
      throw new ApiError(413, "ACADEMY_PROGRESS_TOO_LARGE", "The academy progress record is too large");
    }
    if (await deps.store.save(userId, next, record.version)) {
      return { value: result.value, events: result.events ?? [] };
    }
  }
  throw new ApiError(409, "ACADEMY_BUSY", "The academy record is being updated, please retry");
};

const envelope = (stored: StoredProgress, catalog: Catalog, now: Date): ProgressEnvelope => {
  const progress = publicProgress(stored, catalog, now);
  return { progress, rev: progress.rev };
};

// ---- Progress ---------------------------------------------------------------------------

export const getProgress = async (deps: AcademyDeps, userId: string): Promise<Outcome<ProgressEnvelope>> => {
  const { catalog } = resolve(deps);
  return mutate(deps, userId, (progress, isNew, now) => ({
    next: isNew ? progress : null,
    bump: false,
    value: envelope(progress, catalog, now),
  }));
};

export const putProgress = async (
  deps: AcademyDeps,
  userId: string,
  baseRev: number,
  patch: ProgressPatch,
): Promise<Outcome<ProgressEnvelope>> => {
  const { catalog } = resolve(deps);
  return mutate(deps, userId, (progress, _isNew, now) => {
    if (baseRev !== progress.rev) {
      throw new ApiError(409, "ACADEMY_REV_CONFLICT", "The progress record changed; merge and retry", envelope(progress, catalog, now));
    }
    const next = applyClientPatch(progress, patch, catalog);
    // The returned record must carry the bumped rev, so compute the public view from the final state.
    const bumped = { ...next, rev: progress.rev + 1, updatedAt: now.toISOString(), contentVersion: catalog.contentVersion };
    return {
      next,
      value: envelope(bumped, catalog, now),
      events: [{ action: "ACADEMY_PROGRESS", afterJson: { keys: patchKeyCounts(patch), rev: bumped.rev } }],
    };
  });
};

// ---- Eligibility ------------------------------------------------------------------------

const validBadgeFor = (progress: StoredProgress, track: string, catalog: Catalog, now: Date) => {
  const badges = progress.badges.filter((badge) => badge.track === track);
  return {
    present: badges.length > 0,
    valid: badges.some((badge) => isBadgeValid(badge, catalog, now)),
  };
};

export const computeEligibility = (
  progress: StoredProgress,
  blueprint: ExamBlueprint,
  catalog: Catalog,
  now: Date,
): Eligibility => {
  const track = trackOf(catalog, blueprint.track);
  const missing: EligibilityMissing[] = [];
  if (!track) return { eligible: false, missing: [{ kind: "lesson", id: blueprint.track, text: "This exam is not available." }] };

  for (const required of track.requires) {
    const badge = validBadgeFor(progress, required, catalog, now);
    if (!badge.present) {
      missing.push({ kind: "foundation_badge", id: required, text: `Earn the ${required === "FOUNDATION" ? "Foundation" : required} certification first by passing its exam.` });
    } else if (!badge.valid) {
      missing.push({ kind: "foundation_expired", id: required, text: `Your ${required === "FOUNDATION" ? "Foundation" : required} certification has expired or is out of date. Retake its exam first.` });
    }
  }
  for (const lessonId of track.lessonIds) {
    if (!progress.lessons[lessonId]) {
      missing.push({ kind: "lesson", id: lessonId, text: `Complete the lesson "${lessonTitle(catalog, lessonId)}"` });
    }
  }
  for (const labId of track.labIds) {
    const lab = progress.labs[labId];
    if (isLabPassed(lab, catalog, labId)) continue;
    const title = labOf(catalog, labId)?.title ?? labId;
    const passPercent = labOf(catalog, labId)?.passPercent ?? 80;
    if (lab && lab.bestScore >= passPercent && lab.criticalErrors > 0) {
      missing.push({ kind: "lab_critical", id: labId, text: `Repeat the lab "${title}": your best attempt had a critical error` });
    } else {
      missing.push({ kind: "lab", id: labId, text: `Pass the lab "${title}" with at least ${passPercent}% and no critical error` });
    }
  }

  const attempts = progress.exams[blueprint.id]?.attempts ?? [];
  const last = attempts[attempts.length - 1];
  let cooldownUntil: string | undefined;
  if (last && !last.passed) {
    const until = Date.parse(last.at) + blueprint.cooldownMinutes * 60_000;
    if (until > now.getTime()) {
      cooldownUntil = new Date(until).toISOString();
      missing.push({ kind: "cooldown", id: blueprint.id, text: `You can try this exam again after ${cooldownUntil} (UTC).` });
    }
  }

  let reviewRequired: string[] | undefined;
  let trailingFails = 0;
  for (let i = attempts.length - 1; i >= 0 && !attempts[i]!.passed; i -= 1) trailingFails += 1;
  if (last && trailingFails >= CONSECUTIVE_FAILS_FOR_REVIEW) {
    const modules = Object.entries(last.moduleScores).filter(([, score]) => score < REVIEW_BELOW_PERCENT).map(([module]) => module);
    const pending = modules.filter((module) => {
      const lessons = catalog.lessons.filter((lesson) => lesson.module === module);
      return !lessons.some((lesson) => Date.parse(progress.lessons[lesson.id]?.at ?? "") > Date.parse(last.at));
    });
    if (pending.length > 0) {
      reviewRequired = pending;
      for (const module of pending) {
        missing.push({ kind: "review_lesson", id: module, text: `Re-open at least one lesson of the module "${moduleTitle(catalog, module)}" to review it before the next attempt` });
      }
    }
  }

  return {
    eligible: missing.length === 0,
    missing,
    ...(cooldownUntil ? { cooldownUntil } : {}),
    ...(reviewRequired ? { reviewRequired } : {}),
  };
};

const requireBlueprint = (bank: ExamBank, examId: string): ExamBlueprint => {
  const blueprint = blueprintOf(bank, examId);
  if (!blueprint) throw new ApiError(404, "ACADEMY_EXAM_NOT_FOUND", "The exam does not exist");
  return blueprint;
};

const hasLiveSession = (progress: StoredProgress, examId: string, now: Date): boolean => {
  const open = progress._server.open[examId];
  return Boolean(open && Date.parse(open.expiresAt) > now.getTime());
};

export const getEligibility = async (deps: AcademyDeps, userId: string, examId: string): Promise<Eligibility> => {
  const { catalog, bank } = resolve(deps);
  const blueprint = requireBlueprint(bank, examId);
  const record = await deps.store.load(userId);
  if (!record) throw new ApiError(404, "USER_NOT_FOUND", "The user does not exist");
  const now = deps.ctx.now();
  const { progress } = parseStoredProgress(record.json, catalog, now);
  // A live session can always be resumed.
  if (hasLiveSession(progress, examId, now)) return { eligible: true, missing: [] };
  return computeEligibility(progress, blueprint, catalog, now);
};

// ---- Exam start / submit ----------------------------------------------------------------

const startResponse = (
  progress: StoredProgress,
  blueprint: ExamBlueprint,
  bank: ExamBank,
  resumed: boolean,
): ExamStartResponse => {
  const open = progress._server.open[blueprint.id]!;
  const index = questionIndex(bank);
  const questions: ExamQuestionPublic[] = [];
  for (const state of open.questions) {
    const question = index.get(state.qid);
    if (!question) continue;
    const text = new Map(question.options.map((option) => [option.id, option.text]));
    questions.push({
      qid: question.id,
      type: question.type,
      stem: question.stem,
      options: state.opts.map((opt) => ({ oid: opt.oid, text: text.get(opt.id) ?? "" })),
    });
  }
  return {
    examId: blueprint.id,
    sessionId: open.sessionId,
    startedAt: open.startedAt,
    expiresAt: open.expiresAt,
    questionCount: questions.length,
    resumed,
    questions,
  };
};

export const startExam = async (
  deps: AcademyDeps,
  userId: string,
  examId: string,
  integrityAccepted: boolean,
): Promise<Outcome<ExamStartResponse>> => {
  const { catalog, bank } = resolve(deps);
  const blueprint = requireBlueprint(bank, examId);
  return mutate(deps, userId, (progress, _isNew, now) => {
    if (hasLiveSession(progress, examId, now)) {
      return { next: null, value: startResponse(progress, blueprint, bank, true) };
    }
    if (!integrityAccepted) {
      throw new ApiError(422, "ACADEMY_INTEGRITY_REQUIRED", "The integrity statement must be accepted before an exam can start");
    }
    // A stale, never-submitted session is simply discarded (no penalty, no recorded attempt).
    const server = { ...progress._server, open: { ...progress._server.open } };
    delete server.open[examId];
    const eligibility = computeEligibility({ ...progress, _server: server }, blueprint, catalog, now);
    if (!eligibility.eligible) {
      throw new ApiError(422, "ACADEMY_NOT_ELIGIBLE", "You are not eligible to start this exam yet", eligibility);
    }

    const existing = progress.exams[examId];
    const attemptNumber = (server.attemptCount[examId] ?? existing?.attempts.length ?? 0) + 1;
    const rng = mulberry32(seedFor(userId, examId, attemptNumber));
    const picked = pickQuestions(blueprint, bank.questions, rng, server.lastQids[examId] ?? []);
    const questions = buildQuestionState(picked, rng, deps.ctx.randomId);
    const startedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + blueprint.timeLimitMinutes * 60_000).toISOString();
    const sessionId = deps.ctx.sessionId();
    server.open[examId] = { sessionId, attemptNumber, startedAt, expiresAt, questions };
    // Starting consumes the attempt number and remembers the set, even if the session is never
    // submitted: otherwise abandoning a session would replay the identical questions next time.
    server.attemptCount = { ...server.attemptCount, [examId]: attemptNumber };
    server.lastQids = { ...server.lastQids, [examId]: questions.map((q) => q.qid) };
    const next: StoredProgress = {
      ...progress,
      integrityAcceptedAt: progress.integrityAcceptedAt ?? startedAt,
      exams: {
        ...progress.exams,
        [examId]: {
          attempts: existing?.attempts ?? [],
          ...(existing?.passedAt ? { passedAt: existing.passedAt } : {}),
          v: catalog.contentVersion,
          open: { sessionId, startedAt, expiresAt },
        },
      },
      _server: server,
    };
    return {
      next,
      value: startResponse(next, blueprint, bank, false),
      events: [{ action: "ACADEMY_EXAM_STARTED", afterJson: { examId, attemptNumber, questionCount: questions.length } }],
    };
  });
};

export const submitExam = async (
  deps: AcademyDeps,
  userId: string,
  examId: string,
  body: ExamSubmitBody,
): Promise<Outcome<ExamResult>> => {
  const { catalog, bank } = resolve(deps);
  const blueprint = requireBlueprint(bank, examId);
  const track = trackOf(catalog, blueprint.track);
  return mutate(deps, userId, (progress, _isNew, now) => {
    const open = progress._server.open[examId];
    if (!open || open.sessionId !== body.sessionId) {
      if ((progress._server.used[examId] ?? []).includes(body.sessionId)) {
        throw new ApiError(422, "ACADEMY_SESSION_USED", "This exam session was already submitted");
      }
      throw new ApiError(422, "ACADEMY_SESSION_EXPIRED", "This exam session is no longer open");
    }
    const expired = now.getTime() > Date.parse(open.expiresAt) + SUBMIT_GRACE_MS;
    const index = questionIndex(bank);
    const questions = open.questions.flatMap((state) => (index.has(state.qid) ? [index.get(state.qid)!] : []));
    const graded = gradeExam(questions, open.questions, body.answers, { zeroOut: expired });
    const passed = !expired && graded.scorePercent >= blueprint.passPercent && graded.criticalMissed === 0;
    const startedMs = Date.parse(open.startedAt);
    const durationSeconds = Math.round(Math.min(Math.max(0, now.getTime() - startedMs), blueprint.timeLimitMinutes * 60_000) / 1000);
    const at = now.toISOString();
    const previous = progress.exams[examId];
    const attempts = [
      ...(previous?.attempts ?? []),
      { at, scorePercent: graded.scorePercent, passed, criticalMissed: graded.criticalMissed, moduleScores: graded.moduleScores, durationSeconds },
    ].slice(-MAX_STORED_ATTEMPTS);

    const server = {
      ...progress._server,
      open: { ...progress._server.open },
      lastQids: { ...progress._server.lastQids, [examId]: open.questions.map((q) => q.qid) },
      attemptCount: { ...progress._server.attemptCount, [examId]: open.attemptNumber },
      used: { ...progress._server.used, [examId]: [...(progress._server.used[examId] ?? []), open.sessionId].slice(-5) },
    };
    delete server.open[examId];

    let badges = progress.badges;
    let badge: AcademyBadge | undefined;
    const events: AcademyEvent[] = [
      { action: "ACADEMY_EXAM_SUBMITTED", afterJson: { examId, attemptNumber: open.attemptNumber, scorePercent: graded.scorePercent, passed, criticalMissed: graded.criticalMissed } },
    ];
    if (passed && track) {
      badge = { id: track.badge, track: track.id, earnedAt: at, expiresAt: addMonthsUtc(now, 12).toISOString(), v: catalog.contentVersion };
      badges = [...progress.badges.filter((existing) => existing.track !== track.id), badge];
      events.push({ action: "ACADEMY_BADGE_ISSUED", afterJson: { examId, track: track.id, badgeId: badge.id, expiresAt: badge.expiresAt } });
    }
    const cooldownUntil = passed ? undefined : new Date(now.getTime() + blueprint.cooldownMinutes * 60_000).toISOString();

    const next: StoredProgress = {
      ...progress,
      badges,
      exams: {
        ...progress.exams,
        [examId]: {
          attempts,
          v: catalog.contentVersion,
          ...(passed ? { passedAt: at } : previous?.passedAt ? { passedAt: previous.passedAt } : {}),
        },
      },
      _server: server,
    };
    const value: ExamResult = {
      examId,
      track: blueprint.track,
      attemptNumber: open.attemptNumber,
      passed,
      scorePercent: graded.scorePercent,
      passPercent: blueprint.passPercent,
      criticalMissed: graded.criticalMissed,
      moduleScores: graded.moduleScores,
      durationSeconds,
      expired,
      items: graded.items,
      reviewRequired: graded.reviewRequired,
      ...(badge ? { badge } : {}),
      ...(cooldownUntil ? { cooldownUntil } : {}),
    };
    return { next, value, events };
  });
};
