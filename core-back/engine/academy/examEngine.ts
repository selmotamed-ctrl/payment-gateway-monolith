import { createHash } from "node:crypto";
import type { BankQuestion, ExamBlueprint, OpenQuestionState } from "./types";

/**
 * Deterministic exam-set builder (spec II-9).
 *
 * PRNG: `seed = first 32 bits of sha256(userId + ":" + examId + ":" + attemptNumber)` feeding
 * mulberry32 (a small, well-known 32-bit generator). Shuffles are Fisher-Yates driven by it. The
 * same inputs therefore always give the same question set and order. Option ids (`oid`) are NOT
 * derived from the seed: they are opaque and random per session (injected `randomId`).
 */

export const seedFor = (userId: string, examId: string, attemptNumber: number): number =>
  createHash("sha256").update(`${userId}:${examId}:${attemptNumber}`).digest().readUInt32BE(0);

export const mulberry32 = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export const seededShuffle = <T>(items: readonly T[], rng: () => number): T[] => {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
};

/** Picks the questions of an exam: per module, seeded, preferring unseen, then the critical floor. */
export const pickQuestions = (
  blueprint: ExamBlueprint,
  bank: readonly BankQuestion[],
  rng: () => number,
  previousQids: readonly string[],
): BankQuestion[] => {
  const seen = new Set(previousQids);
  const picked = new Map<string, { picks: BankQuestion[]; pool: BankQuestion[] }>();
  for (const { module, count } of blueprint.composition) {
    const pool = bank.filter((q) => q.module === module && (q.tracks.includes(blueprint.track) || q.tracks.includes("ALL")));
    const shuffled = seededShuffle(pool, rng);
    const ordered = [...shuffled.filter((q) => !seen.has(q.id)), ...shuffled.filter((q) => seen.has(q.id))];
    const entry = picked.get(module) ?? { picks: [], pool: [] };
    entry.pool = pool;
    entry.picks.push(...ordered.slice(0, count));
    picked.set(module, entry);
  }
  let critical = [...picked.values()].reduce((sum, { picks }) => sum + picks.filter((q) => q.critical).length, 0);
  for (const entry of picked.values()) {
    while (critical < blueprint.criticalPick) {
      const chosen = new Set(entry.picks.map((q) => q.id));
      const candidate = entry.pool.find((q) => q.critical && !chosen.has(q.id));
      const victim = [...entry.picks].reverse().find((q) => !q.critical);
      if (!candidate || !victim) break;
      entry.picks[entry.picks.indexOf(victim)] = candidate;
      critical += 1;
    }
  }
  const all = [...picked.values()].flatMap(({ picks }) => picks);
  const unique = [...new Map(all.map((q) => [q.id, q])).values()];
  return seededShuffle(unique, rng);
};

/** Builds the ordered question state (with opaque option ids) for an open session. */
export const buildQuestionState = (questions: readonly BankQuestion[], rng: () => number, randomId: () => string): OpenQuestionState[] =>
  questions.map((question) => {
    if (question.type === "number") return { qid: question.id, opts: [] };
    const used = new Set<string>();
    const fresh = (): string => {
      let oid = randomId();
      while (used.has(oid)) oid = randomId();
      used.add(oid);
      return oid;
    };
    return { qid: question.id, opts: seededShuffle(question.options, rng).map((option) => ({ oid: fresh(), id: option.id })) };
  });
