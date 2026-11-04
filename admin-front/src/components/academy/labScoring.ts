/**
 * Lab scoring (spec II-10). PURE: no Vue, no I/O, no randomness. All money maths uses decimal.js.
 * Scores are returned as plain numbers rounded to 4 decimals (e.g. 8.3333) for display and tests.
 */
import Decimal from "decimal.js";
import type {
    ChecklistTask,
    ChoiceTask,
    LabTask,
    LedgerTask,
    MultiTask,
    NumericTask,
    OrderTask,
} from "@/content/academy";

/* ------------------------------------------------------------------ answer shapes */
export interface HintFlag {
    hintUsed?: boolean;
}
export interface ChoiceAnswer extends HintFlag {
    selected: string | null;
}
export interface MultiAnswer extends HintFlag {
    selected: string[];
}
/** `cells[account].DR` / `.CR` hold the learner's raw decimal strings ("" or missing = empty). */
export interface LedgerAnswer extends HintFlag {
    cells: Record<string, { DR?: string; CR?: string }>;
}
export interface OrderAnswer extends HintFlag {
    order: string[];
}
export interface ChecklistAnswer extends HintFlag {
    ticked: string[];
}
export interface NumericAnswer extends HintFlag {
    value: string;
}
export type TaskAnswer = ChoiceAnswer | MultiAnswer | LedgerAnswer | OrderAnswer | ChecklistAnswer | NumericAnswer;

export interface ScoreDetail {
    /** ledger */
    matchedLines?: number;
    expectedLines?: number;
    extraCells?: number;
    /** order */
    correctPositions?: number;
    total?: number;
    /** multi */
    correctSelected?: number;
    wrongSelected?: number;
    totalCorrect?: number;
    /** checklist */
    rightItems?: number;
    totalItems?: number;
    /** ids that triggered the critical error */
    criticalIds?: string[];
}

export interface TaskScore {
    score: number;
    maxScore: number;
    criticalError: boolean;
    /** full marks before the hint penalty */
    correct: boolean;
    hintPenalty: number;
    detail?: ScoreDetail;
}

/* ------------------------------------------------------------------ helpers */
const D0 = new Decimal(0);
const NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)$/;

/** Parse a learner-entered decimal; `null` when it is not a plain decimal number. Empty string → null. */
export const parseDecimal = (raw: unknown): Decimal | null => {
    if (typeof raw === "number") return Number.isFinite(raw) ? new Decimal(raw) : null;
    if (typeof raw !== "string") return null;
    const text = raw.trim();
    if (!NUMBER_RE.test(text)) return null;
    try {
        return new Decimal(text);
    } catch {
        return null;
    }
};

const toNumber = (value: Decimal): number => value.toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toNumber();

const ratioScore = (points: number, numerator: number, denominator: number): Decimal => {
    if (denominator <= 0) return D0;
    const raw = new Decimal(points).mul(numerator).div(denominator);
    return raw.lt(0) ? D0 : raw;
};

const hintWasUsed = (answer: unknown, opts?: { hintUsed?: boolean }): boolean =>
    Boolean(opts?.hintUsed) || Boolean(answer && typeof answer === "object" && (answer as HintFlag).hintUsed);

const finish = (
    task: LabTask,
    raw: Decimal,
    criticalError: boolean,
    hint: boolean,
    detail?: ScoreDetail,
): TaskScore => {
    const max = new Decimal(task.points);
    const capped = raw.gt(max) ? max : raw;
    const correct = capped.gte(max);
    const penalty = hint ? 1 : 0;
    let final = capped.minus(penalty);
    if (final.lt(0)) final = D0;
    return {
        score: toNumber(final),
        maxScore: task.points,
        criticalError,
        correct,
        hintPenalty: penalty,
        detail,
    };
};

/* ------------------------------------------------------------------ ledger helpers */
const cellValue = (cells: LedgerAnswer["cells"], account: string, side: "DR" | "CR"): string =>
    (cells?.[account]?.[side] ?? "").toString().trim();

/** Σ debit and Σ credit of the grid (non-numeric cells are ignored). */
export const ledgerTotals = (cells: LedgerAnswer["cells"]): { debit: Decimal; credit: Decimal } => {
    let debit = D0;
    let credit = D0;
    for (const sides of Object.values(cells ?? {})) {
        const dr = parseDecimal(sides?.DR);
        const cr = parseDecimal(sides?.CR);
        if (dr) debit = debit.plus(dr);
        if (cr) credit = credit.plus(cr);
    }
    return { debit, credit };
};

/** Live badge helper: Σ debit = Σ credit, and something has been entered. */
export const isBalanced = (cells: LedgerAnswer["cells"]): boolean => {
    const { debit, credit } = ledgerTotals(cells);
    return debit.eq(credit);
};

/* ------------------------------------------------------------------ per-kind scoring */
const scoreChoice = (task: ChoiceTask, answer: ChoiceAnswer | undefined, hint: boolean): TaskScore => {
    const chosen = task.options.find((option) => option.id === answer?.selected);
    const critical = Boolean(chosen?.critical);
    const raw = chosen?.correct ? new Decimal(task.points) : D0;
    return finish(task, raw, critical, hint, critical && chosen ? { criticalIds: [chosen.id] } : undefined);
};

const scoreMulti = (task: MultiTask, answer: MultiAnswer | undefined, hint: boolean): TaskScore => {
    const selected = new Set(answer?.selected ?? []);
    const totalCorrect = task.options.filter((option) => option.correct).length;
    let correctSelected = 0;
    let wrongSelected = 0;
    for (const option of task.options) {
        if (!selected.has(option.id)) continue;
        if (option.correct) correctSelected += 1;
        else wrongSelected += 1;
    }
    const criticalIds = (task.criticalWrong ?? []).filter((id) => selected.has(id));
    const raw = ratioScore(task.points, correctSelected - wrongSelected, totalCorrect);
    return finish(task, raw, criticalIds.length > 0, hint, {
        correctSelected,
        wrongSelected,
        totalCorrect,
        criticalIds: criticalIds.length ? criticalIds : undefined,
    });
};

const scoreLedger = (task: LedgerTask, answer: LedgerAnswer | undefined, hint: boolean): TaskScore => {
    const cells = answer?.cells ?? {};
    const expectedAccounts = new Set(task.expected.map((line) => line.account));
    let matched = 0;
    for (const line of task.expected) {
        const entered = parseDecimal(cellValue(cells, line.account, line.side));
        if (entered && entered.eq(new Decimal(line.amount))) matched += 1;
    }
    let extra = 0;
    for (const account of task.accounts) {
        if (expectedAccounts.has(account)) continue;
        for (const side of ["DR", "CR"] as const) {
            const text = cellValue(cells, account, side);
            if (text === "") continue;
            const parsed = parseDecimal(text);
            if (parsed === null || !parsed.isZero()) extra += 1;
        }
    }
    const raw = ratioScore(task.points, matched - extra, task.expected.length);
    return finish(task, raw, false, hint, { matchedLines: matched, expectedLines: task.expected.length, extraCells: extra });
};

const scoreOrder = (task: OrderTask, answer: OrderAnswer | undefined, hint: boolean): TaskScore => {
    const order = answer?.order ?? [];
    const n = task.correctOrder.length;
    let rightPositions = 0;
    for (let i = 0; i < n; i += 1) if (order[i] === task.correctOrder[i]) rightPositions += 1;
    const exact = rightPositions === n && order.length === n;
    // Items beyond the expected length are wrong placements: a non-exact sequence must never earn full marks.
    if (order.length > n) rightPositions = Math.max(0, rightPositions - (order.length - n));
    const raw = exact
        ? new Decimal(task.points)
        : n > 0
          ? new Decimal(task.points).mul(rightPositions).div(n).toDecimalPlaces(1, Decimal.ROUND_DOWN)
          : D0;
    return finish(task, raw, false, hint, { correctPositions: rightPositions, total: n });
};

const scoreChecklist = (task: ChecklistTask, answer: ChecklistAnswer | undefined, hint: boolean): TaskScore => {
    const ticked = new Set(answer?.ticked ?? []);
    let right = 0;
    for (const item of task.items) if (ticked.has(item.id) === item.shouldTick) right += 1;
    const criticalIds = (task.criticalWrong ?? []).filter((id) => {
        const item = task.items.find((entry) => entry.id === id);
        return Boolean(item) && ticked.has(id) && !item!.shouldTick;
    });
    const raw = ratioScore(task.points, right, task.items.length);
    return finish(task, raw, criticalIds.length > 0, hint, {
        rightItems: right,
        totalItems: task.items.length,
        criticalIds: criticalIds.length ? criticalIds : undefined,
    });
};

const scoreNumeric = (task: NumericTask, answer: NumericAnswer | undefined, hint: boolean): TaskScore => {
    const entered = parseDecimal(answer?.value);
    let ok = false;
    if (entered) {
        const tolerance = parseDecimal(task.tolerance) ?? D0;
        ok = entered.minus(new Decimal(task.answer)).abs().lte(tolerance.abs());
    }
    return finish(task, ok ? new Decimal(task.points) : D0, false, hint);
};

/** Score one task. `answer` may be undefined (unanswered → 0). A used hint costs 1 point (floor 0). */
export const scoreTask = (task: LabTask, answer: TaskAnswer | undefined, opts?: { hintUsed?: boolean }): TaskScore => {
    const hint = hintWasUsed(answer, opts);
    switch (task.kind) {
        case "choice":
            return scoreChoice(task, answer as ChoiceAnswer | undefined, hint);
        case "multi":
            return scoreMulti(task, answer as MultiAnswer | undefined, hint);
        case "ledger":
            return scoreLedger(task, answer as LedgerAnswer | undefined, hint);
        case "order":
            return scoreOrder(task, answer as OrderAnswer | undefined, hint);
        case "checklist":
            return scoreChecklist(task, answer as ChecklistAnswer | undefined, hint);
        case "numeric":
            return scoreNumeric(task, answer as NumericAnswer | undefined, hint);
    }
};

/* ------------------------------------------------------------------ lab level */
export interface LabOutcome {
    /** integer 0-100, round half up */
    score: number;
    earned: number;
    possible: number;
    passed: boolean;
    criticalErrors: number;
}

/** Lab-level arithmetic from per-task scores (vectors LV16-LV18). Scores/points may be numbers or decimal strings. */
export const computeLabResult = (
    tasks: { points: number | string; score: number | string }[],
    criticalErrors: number,
    passPercent = 80,
): LabOutcome => {
    const earned = tasks.reduce((sum, task) => sum.plus(new Decimal(task.score)), D0);
    const possible = tasks.reduce((sum, task) => sum.plus(new Decimal(task.points)), D0);
    const score = possible.gt(0)
        ? earned.mul(100).div(possible).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber()
        : 0;
    return {
        score,
        earned: toNumber(earned),
        possible: toNumber(possible),
        passed: score >= passPercent && criticalErrors === 0,
        criticalErrors,
    };
};

export interface LabScore extends LabOutcome {
    tasks: ({ taskId: string } & TaskScore)[];
}

/** Score a whole lab. `answers` keyed by task id; `hintsUsed` keyed by task id (or a list of ids). */
export const scoreLab = (
    lab: { passPercent: number; tasks: LabTask[] },
    answers: Record<string, TaskAnswer | undefined>,
    hintsUsed: Record<string, boolean> | string[] = {},
): LabScore => {
    const hinted = (id: string): boolean => (Array.isArray(hintsUsed) ? hintsUsed.includes(id) : Boolean(hintsUsed[id]));
    const tasks = lab.tasks.map((task) => ({
        taskId: task.id,
        ...scoreTask(task, answers[task.id], { hintUsed: hinted(task.id) }),
    }));
    const criticalErrors = tasks.filter((task) => task.criticalError).length;
    const outcome = computeLabResult(
        tasks.map((task) => ({ points: task.maxScore, score: task.score })),
        criticalErrors,
        lab.passPercent,
    );
    return { ...outcome, tasks };
};
