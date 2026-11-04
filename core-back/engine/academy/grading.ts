import Decimal from "decimal.js";
import type { BankQuestion, ExamAnswer, ExamResultItem, OpenQuestionState } from "./types";

/** Round half up to an integer percentage. */
export const percent = (points: number, total: number): number => (total <= 0 ? 0 : Math.floor((100 * points) / total + 0.5));

const asList = (answer: ExamAnswer | undefined): string[] =>
  Array.isArray(answer) ? answer.filter((entry): entry is string => typeof entry === "string") : typeof answer === "string" ? [answer] : [];

const parseDecimal = (value: string | undefined): Decimal | undefined => {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 40) return undefined;
  try {
    const parsed = new Decimal(trimmed);
    return parsed.isFinite() ? parsed : undefined;
  } catch {
    return undefined;
  }
};

export interface GradedQuestion {
  correct: boolean;
  answered: boolean;
  item: ExamResultItem;
}

/**
 * Grades one question against the session mapping. `answer` is untrusted: option ids that are not
 * part of the session simply never match.
 */
export const gradeQuestion = (question: BankQuestion, state: OpenQuestionState, answer: ExamAnswer | undefined): GradedQuestion => {
  const byOid = new Map(state.opts.map((opt) => [opt.oid, opt.id]));
  const textOf = new Map(question.options.map((option) => [option.id, option]));
  const base = {
    qid: question.id,
    module: question.module,
    type: question.type,
    stem: question.stem,
    critical: question.critical,
    why: question.why,
    refs: question.refs,
  };

  if (question.type === "number") {
    const given = typeof answer === "string" ? answer : undefined;
    const yours = parseDecimal(given);
    const expected = parseDecimal(question.answer);
    const tolerance = parseDecimal(question.tolerance) ?? new Decimal(0);
    const correct = Boolean(yours && expected && yours.minus(expected).abs().lte(tolerance.abs()));
    return {
      correct,
      answered: given !== undefined && given.trim().length > 0,
      item: {
        ...base,
        correct,
        answered: given !== undefined && given.trim().length > 0,
        number: {
          ...(given !== undefined && given.length <= 40 ? { yourAnswer: given } : {}),
          correctAnswer: question.answer ?? "",
          ...(question.tolerance ? { tolerance: question.tolerance } : {}),
        },
      },
    };
  }

  const chosen = [...new Set(asList(answer).filter((oid) => byOid.has(oid)))];
  const chosenIds = chosen.map((oid) => byOid.get(oid)!);

  if (question.type === "order") {
    const correctOrder = question.options.map((option) => option.id);
    const sequence = asList(answer).map((oid) => byOid.get(oid));
    const correct = sequence.length === correctOrder.length && sequence.every((id, index) => id === correctOrder[index]);
    const oidOf = new Map(state.opts.map((opt) => [opt.id, opt.oid]));
    const answered = chosen.length > 0;
    return {
      correct,
      answered,
      item: {
        ...base,
        correct,
        answered,
        order: {
          items: state.opts.map((opt) => ({ oid: opt.oid, text: textOf.get(opt.id)?.text ?? "" })),
          yourOrder: chosen,
          correctOrder: correctOrder.map((id) => oidOf.get(id) ?? ""),
        },
      },
    };
  }

  const correctIds = question.options.filter((option) => option.correct).map((option) => option.id);
  const picked = new Set(chosenIds);
  // single / truefalse: exactly one selection that is the key; multi: exact set (all-or-nothing).
  const correct =
    question.type === "multi"
      ? picked.size === correctIds.length && correctIds.every((id) => picked.has(id))
      : chosenIds.length === 1 && correctIds.length === 1 && chosenIds[0] === correctIds[0];
  const answered = chosenIds.length > 0;
  return {
    correct,
    answered,
    item: {
      ...base,
      correct,
      answered,
      options: state.opts.map((opt) => {
        const option = textOf.get(opt.id);
        return {
          oid: opt.oid,
          text: option?.text ?? "",
          correct: option?.correct === true,
          selected: picked.has(opt.id),
          ...(option?.note ? { note: option.note } : {}),
        };
      }),
    },
  };
};

export interface GradedExam {
  items: ExamResultItem[];
  points: number;
  scorePercent: number;
  criticalMissed: number;
  moduleScores: Record<string, number>;
  reviewRequired: string[];
}

export const REVIEW_BELOW_PERCENT = 70;

export const gradeExam = (
  questions: readonly BankQuestion[],
  states: readonly OpenQuestionState[],
  answers: Record<string, ExamAnswer>,
  options: { zeroOut?: boolean } = {},
): GradedExam => {
  const byQid = new Map(questions.map((question) => [question.id, question]));
  const moduleTotals = new Map<string, { points: number; total: number }>();
  const items: ExamResultItem[] = [];
  let points = 0;
  let criticalMissed = 0;
  for (const state of states) {
    const question = byQid.get(state.qid);
    if (!question) continue;
    const graded = gradeQuestion(question, state, options.zeroOut ? undefined : answers[state.qid]);
    const total = moduleTotals.get(question.module) ?? { points: 0, total: 0 };
    total.total += 1;
    if (graded.correct) {
      points += 1;
      total.points += 1;
    } else if (question.critical) {
      criticalMissed += 1;
    }
    moduleTotals.set(question.module, total);
    items.push(graded.item);
  }
  const moduleScores: Record<string, number> = {};
  for (const [module, total] of [...moduleTotals.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    moduleScores[module] = percent(total.points, total.total);
  }
  const questionCount = items.length;
  return {
    items,
    points,
    scorePercent: percent(points, questionCount),
    criticalMissed,
    moduleScores,
    reviewRequired: Object.entries(moduleScores).filter(([, score]) => score < REVIEW_BELOW_PERCENT).map(([module]) => module),
  };
};
