import { isTrackId, labIdSet, lessonIdSet, labOf } from "./catalog";
import type { AcademyBadge, AcademyProgress, Catalog, ExamAttemptSummary, ProgressPatch, ServerState, StoredProgress } from "./types";

/**
 * Progress record handling: defensive parsing of the stored JSON (null, legacy, hand-edited),
 * the client-patch merge rules and the `publicProgress()` sanitiser (the ONLY way stored JSON may
 * leave core-back).
 */

export const PROGRESS_MAX_BYTES = 64 * 1024;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown, max: number): string | undefined =>
  typeof value === "string" && value.length <= max ? value : undefined;
const time = (iso: string | undefined): number => {
  const value = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(value) ? 0 : value;
};
const num = (value: unknown, min: number, max: number): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : undefined;

export const emptyServerState = (): ServerState => ({ open: {}, lastQids: {}, attemptCount: {}, used: {} });

export const emptyProgress = (now: Date, contentVersion: string): StoredProgress => ({
  schema: 1,
  rev: 0,
  startedAt: now.toISOString(),
  updatedAt: now.toISOString(),
  contentVersion,
  guideRead: {},
  lessons: {},
  labs: {},
  exams: {},
  badges: [],
  _server: emptyServerState(),
});

// ---- Entry sanitisers (shared by stored-JSON parsing) ------------------------------------

const guideEntry = (value: unknown): { v: string; at: string } | undefined => {
  if (!isObject(value)) return undefined;
  const v = str(value.v, 20);
  const at = str(value.at, 40);
  return v !== undefined && at !== undefined && !Number.isNaN(Date.parse(at)) ? { v, at } : undefined;
};

const lessonEntry = (value: unknown): AcademyProgress["lessons"][string] | undefined => {
  if (!isObject(value)) return undefined;
  const at = str(value.at, 40);
  const v = str(value.v, 20);
  const score = value.checkScore;
  if (at === undefined || v === undefined || Number.isNaN(Date.parse(at))) return undefined;
  if (score !== 0 && score !== 1 && score !== 2) return undefined;
  return { at, v, checkScore: score };
};

const labEntry = (value: unknown): AcademyProgress["labs"][string] | undefined => {
  if (!isObject(value)) return undefined;
  const bestScore = num(value.bestScore, 0, 100);
  const attempts = num(value.attempts, 0, 100_000);
  const criticalErrors = num(value.criticalErrors, 0, 10_000);
  const v = str(value.v, 20);
  if (bestScore === undefined || attempts === undefined || criticalErrors === undefined || v === undefined) return undefined;
  const passedAt = str(value.passedAt, 40);
  return {
    bestScore,
    attempts: Math.trunc(attempts),
    criticalErrors: Math.trunc(criticalErrors),
    v,
    ...(passedAt && !Number.isNaN(Date.parse(passedAt)) ? { passedAt } : {}),
  };
};

const attemptEntry = (value: unknown): ExamAttemptSummary | undefined => {
  if (!isObject(value)) return undefined;
  const at = str(value.at, 40);
  const scorePercent = num(value.scorePercent, 0, 100);
  const criticalMissed = num(value.criticalMissed, 0, 10_000);
  const durationSeconds = num(value.durationSeconds, 0, 10_000_000);
  if (at === undefined || scorePercent === undefined || criticalMissed === undefined || durationSeconds === undefined) return undefined;
  const moduleScores: Record<string, number> = {};
  if (isObject(value.moduleScores)) {
    for (const [id, score] of Object.entries(value.moduleScores)) {
      const parsed = num(score, 0, 100);
      if (parsed !== undefined && id.length <= 120) moduleScores[id] = parsed;
    }
  }
  return { at, scorePercent, passed: value.passed === true, criticalMissed, moduleScores, durationSeconds };
};

const badgeEntry = (value: unknown, catalog: Catalog): AcademyBadge | undefined => {
  if (!isObject(value)) return undefined;
  const id = str(value.id, 120);
  const earnedAt = str(value.earnedAt, 40);
  const expiresAt = str(value.expiresAt, 40);
  const v = str(value.v, 20);
  if (!id || !earnedAt || !expiresAt || v === undefined || !isTrackId(catalog, value.track)) return undefined;
  return { id, track: value.track, earnedAt, expiresAt, v };
};

const recordOf = <T>(value: unknown, parse: (entry: unknown) => T | undefined, keyOk: (key: string) => boolean = () => true): Record<string, T> => {
  const out: Record<string, T> = {};
  if (!isObject(value)) return out;
  for (const [key, entry] of Object.entries(value)) {
    if (key.length > 120 || !keyOk(key)) continue;
    const parsed = parse(entry);
    if (parsed !== undefined) out[key] = parsed;
  }
  return out;
};

const stringList = (value: unknown, maxItems: number, maxLen = 120): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.length <= maxLen).slice(0, maxItems) : [];

const parseServerState = (value: unknown): ServerState => {
  const out = emptyServerState();
  if (!isObject(value)) return out;
  if (isObject(value.open)) {
    for (const [examId, raw] of Object.entries(value.open)) {
      if (!isObject(raw) || !Array.isArray(raw.questions)) continue;
      const sessionId = str(raw.sessionId, 80);
      const startedAt = str(raw.startedAt, 40);
      const expiresAt = str(raw.expiresAt, 40);
      const attemptNumber = num(raw.attemptNumber, 1, 1_000_000);
      if (!sessionId || !startedAt || !expiresAt || attemptNumber === undefined) continue;
      const questions = raw.questions.flatMap((entry) => {
        if (!isObject(entry) || typeof entry.qid !== "string" || !Array.isArray(entry.opts)) return [];
        const opts = entry.opts.flatMap((opt) =>
          isObject(opt) && typeof opt.oid === "string" && typeof opt.id === "string" ? [{ oid: opt.oid, id: opt.id }] : [],
        );
        return [{ qid: entry.qid, opts }];
      });
      out.open[examId] = { sessionId, attemptNumber: Math.trunc(attemptNumber), startedAt, expiresAt, questions };
    }
  }
  if (isObject(value.lastQids)) for (const [examId, list] of Object.entries(value.lastQids)) out.lastQids[examId] = stringList(list, 200);
  if (isObject(value.attemptCount)) {
    for (const [examId, count] of Object.entries(value.attemptCount)) {
      const parsed = num(count, 0, 1_000_000);
      if (parsed !== undefined) out.attemptCount[examId] = Math.trunc(parsed);
    }
  }
  if (isObject(value.used)) for (const [examId, list] of Object.entries(value.used)) out.used[examId] = stringList(list, 5, 80);
  return out;
};

/**
 * Turns whatever is stored in `users.academy_progress_json` into a valid record.
 * Legacy rows (no `schema: 1`) become a fresh record that keeps only `guideRead`.
 */
export const parseStoredProgress = (raw: unknown, catalog: Catalog, now: Date): { progress: StoredProgress; isNew: boolean } => {
  if (!isObject(raw) || raw.schema !== 1) {
    const fresh = emptyProgress(now, catalog.contentVersion);
    if (isObject(raw)) fresh.guideRead = recordOf(raw.guideRead, guideEntry);
    return { progress: fresh, isNew: true };
  }
  const startedAt = str(raw.startedAt, 40) ?? now.toISOString();
  const exams: AcademyProgress["exams"] = {};
  if (isObject(raw.exams)) {
    for (const [examId, entry] of Object.entries(raw.exams)) {
      if (!isObject(entry) || examId.length > 120) continue;
      const open = isObject(entry.open) ? entry.open : undefined;
      const sessionId = open ? str(open.sessionId, 80) : undefined;
      const openStartedAt = open ? str(open.startedAt, 40) : undefined;
      const openExpiresAt = open ? str(open.expiresAt, 40) : undefined;
      const passedAt = str(entry.passedAt, 40);
      exams[examId] = {
        attempts: (Array.isArray(entry.attempts) ? entry.attempts : []).map(attemptEntry).filter((a): a is ExamAttemptSummary => a !== undefined).slice(-20),
        v: str(entry.v, 20) ?? catalog.contentVersion,
        ...(sessionId && openStartedAt && openExpiresAt ? { open: { sessionId, startedAt: openStartedAt, expiresAt: openExpiresAt } } : {}),
        ...(passedAt ? { passedAt } : {}),
      };
    }
  }
  const activeTrack = isTrackId(catalog, raw.activeTrack) ? raw.activeTrack : undefined;
  const integrityAcceptedAt = str(raw.integrityAcceptedAt, 40);
  return {
    isNew: false,
    progress: {
      schema: 1,
      rev: Math.trunc(num(raw.rev, 0, Number.MAX_SAFE_INTEGER) ?? 0),
      startedAt,
      updatedAt: str(raw.updatedAt, 40) ?? startedAt,
      contentVersion: str(raw.contentVersion, 20) ?? catalog.contentVersion,
      ...(activeTrack ? { activeTrack } : {}),
      ...(integrityAcceptedAt ? { integrityAcceptedAt } : {}),
      guideRead: recordOf(raw.guideRead, guideEntry),
      lessons: recordOf(raw.lessons, lessonEntry),
      labs: recordOf(raw.labs, labEntry),
      exams,
      badges: (Array.isArray(raw.badges) ? raw.badges : []).map((b) => badgeEntry(b, catalog)).filter((b): b is AcademyBadge => b !== undefined),
      _server: parseServerState(raw._server),
    },
  };
};

/**
 * The only serialiser for anything that leaves core-back: drops `_server` and any open session
 * that has already expired.
 */
export const publicProgress = (raw: unknown, catalog: Catalog, now: Date): AcademyProgress => {
  const { progress } = parseStoredProgress(raw, catalog, now);
  const { _server, ...rest } = progress;
  void _server;
  const exams: AcademyProgress["exams"] = {};
  for (const [examId, entry] of Object.entries(rest.exams)) {
    const { open, ...others } = entry;
    exams[examId] = open && Date.parse(open.expiresAt) > now.getTime() ? { ...others, open } : others;
  }
  return { ...rest, exams };
};

// ---- Patch merge (decisions 3 and 4) ------------------------------------------------------

export const mergeGuideRead = (current: AcademyProgress["guideRead"], incoming: AcademyProgress["guideRead"]): AcademyProgress["guideRead"] => {
  const out = { ...current };
  for (const [id, entry] of Object.entries(incoming)) {
    const existing = out[id];
    if (!existing || time(entry.at) >= time(existing.at)) out[id] = entry;
  }
  return out;
};

export const mergeLessons = (current: AcademyProgress["lessons"], incoming: AcademyProgress["lessons"]): AcademyProgress["lessons"] => {
  const out = { ...current };
  for (const [id, entry] of Object.entries(incoming)) {
    const existing = out[id];
    if (!existing) {
      out[id] = entry;
      continue;
    }
    const later = time(entry.at) > time(existing.at) || (time(entry.at) === time(existing.at) && entry.checkScore > existing.checkScore);
    if (later) out[id] = entry;
  }
  return out;
};

export const mergeLabs = (current: AcademyProgress["labs"], incoming: AcademyProgress["labs"]): AcademyProgress["labs"] => {
  const out = { ...current };
  for (const [id, entry] of Object.entries(incoming)) {
    const existing = out[id];
    if (!existing) {
      out[id] = entry;
      continue;
    }
    const bestIsNew = entry.bestScore > existing.bestScore || (entry.bestScore === existing.bestScore && entry.criticalErrors < existing.criticalErrors);
    const best = bestIsNew ? entry : existing;
    const passedAt = [existing.passedAt, entry.passedAt].filter((value): value is string => Boolean(value)).sort((a, b) => time(a) - time(b))[0];
    out[id] = {
      bestScore: Math.max(entry.bestScore, existing.bestScore),
      attempts: Math.max(entry.attempts, existing.attempts),
      criticalErrors: best.criticalErrors,
      v: best.v,
      ...(passedAt ? { passedAt } : {}),
    };
  }
  return out;
};

/**
 * Applies an ALREADY SHAPE-VALIDATED client patch. Only `activeTrack`, `guideRead`, `lessons` and
 * `labs` are read; unknown lesson/lab ids are dropped. Never deletes keys. Does not touch `rev`.
 */
export const applyClientPatch = (stored: StoredProgress, patch: ProgressPatch, catalog: Catalog): StoredProgress => {
  const lessonIds = lessonIdSet(catalog);
  const labIds = labIdSet(catalog);
  const lessons = Object.fromEntries(Object.entries(patch.lessons ?? {}).filter(([id]) => lessonIds.has(id)));
  const labs = Object.fromEntries(
    Object.entries(patch.labs ?? {})
      .filter(([id]) => labIds.has(id))
      .map(([id, entry]) => [id, entry]),
  );
  return {
    ...stored,
    ...(patch.activeTrack && isTrackId(catalog, patch.activeTrack) ? { activeTrack: patch.activeTrack } : {}),
    guideRead: mergeGuideRead(stored.guideRead, patch.guideRead ?? {}),
    lessons: mergeLessons(stored.lessons, lessons),
    labs: mergeLabs(stored.labs, labs),
  };
};

export const patchKeyCounts = (patch: ProgressPatch): Record<string, number> => ({
  activeTrack: patch.activeTrack ? 1 : 0,
  guideRead: Object.keys(patch.guideRead ?? {}).length,
  lessons: Object.keys(patch.lessons ?? {}).length,
  labs: Object.keys(patch.labs ?? {}).length,
});

export const isLabPassed = (lab: AcademyProgress["labs"][string] | undefined, catalog: Catalog, labId: string): boolean => {
  if (!lab) return false;
  const passPercent = labOf(catalog, labId)?.passPercent ?? 80;
  return lab.bestScore >= passPercent && lab.criticalErrors === 0;
};

export const storedSizeBytes = (json: unknown): number => Buffer.byteLength(JSON.stringify(json), "utf8");
export const exceedsLimit = (json: unknown): boolean => storedSizeBytes(json) > PROGRESS_MAX_BYTES;
