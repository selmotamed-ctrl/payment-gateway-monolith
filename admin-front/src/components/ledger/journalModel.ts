import Decimal from "decimal.js";
import type { RouteLocationRaw } from "vue-router";

/**
 * Pure ledger helpers shared by the journal entry drawer, the GL account drawer and the
 * journal explorer. Money is always a `Decimal` here, never a float.
 */

export type JournalDirection = "DEBIT" | "CREDIT";

export interface JournalLineLike {
    direction: JournalDirection;
    amount: string | number | null | undefined;
}

/** Account types whose natural balance is a debit (assets and expenses). Mirrors the core ledger. */
export const DEBIT_NATURAL_ACCOUNT_TYPES: readonly string[] = [
    "TREASURY",
    "GATEWAY_CLEARING",
    "COMMISSION_RECEIVABLE",
    "PROVIDER_FEE_EXPENSE",
    "GATEWAY_FEE_EXPENSE",
];

const dec = (value: string | number | null | undefined): Decimal => {
    if (value === null || value === undefined || value === "") return new Decimal(0);
    try {
        return new Decimal(String(value));
    } catch {
        return new Decimal(0);
    }
};

export const isDebitNatural = (accountType: string | null | undefined): boolean =>
    DEBIT_NATURAL_ACCOUNT_TYPES.includes(String(accountType ?? ""));

/**
 * Converts between the two balance conventions of the ledger. Shards and checkpoints are stored
 * debit-positive; the natural balance shows liabilities, income and reserves as positive numbers.
 * The conversion flips the sign for credit-natural accounts and is its own inverse.
 */
export const flipToNatural = (accountType: string | null | undefined, debitPositive: string | number | null | undefined): string => {
    const value = dec(debitPositive);
    const natural = isDebitNatural(accountType) ? value : value.neg();
    return natural.isZero() ? "0.0000" : natural.toFixed(4);
};

/** Effect of one posted line on the NATURAL balance of its account (positive grows the balance). */
export const naturalEffect = (accountType: string | null | undefined, direction: JournalDirection, amount: string | number | null | undefined): string => {
    const value = dec(amount);
    const sameSide = isDebitNatural(accountType) ? direction === "DEBIT" : direction === "CREDIT";
    return (sameSide ? value : value.neg()).toFixed(4);
};

export interface EntryTotals {
    lineCount: number;
    totalDebit: string;
    totalCredit: string;
    /** debit minus credit; zero for a balanced entry. */
    difference: string;
    balanced: boolean;
}

export const summarizeLines = (lines: readonly JournalLineLike[]): EntryTotals => {
    let debit = new Decimal(0);
    let credit = new Decimal(0);
    for (const line of lines) {
        const amount = dec(line.amount);
        if (line.direction === "DEBIT") debit = debit.plus(amount);
        else credit = credit.plus(amount);
    }
    const difference = debit.minus(credit);
    return {
        lineCount: lines.length,
        totalDebit: debit.toFixed(4),
        totalCredit: credit.toFixed(4),
        difference: difference.toFixed(4),
        // An entry without lines is broken, not balanced.
        balanced: lines.length > 0 && difference.isZero(),
    };
};

/** T-account columns of one line: exactly one side carries the amount. */
export const tAccountSides = (line: JournalLineLike): { debit: string | null; credit: string | null } => {
    const amount = dec(line.amount).toFixed(4);
    return line.direction === "DEBIT" ? { debit: amount, credit: null } : { debit: null, credit: amount };
};

/**
 * Prefers the server-computed totals (they use the exact stored amounts) and falls back to the
 * lines. The balanced flag is recomputed so a missing flag never reads as "balanced".
 */
export const entryTotalsOf = (entry: {
    totalDebit?: string | null;
    totalCredit?: string | null;
    balanced?: boolean | null;
    lines?: readonly JournalLineLike[];
}): EntryTotals => {
    const fromLines = summarizeLines(entry.lines ?? []);
    if (entry.totalDebit === undefined || entry.totalDebit === null || entry.totalCredit === undefined || entry.totalCredit === null) {
        return fromLines;
    }
    const debit = dec(entry.totalDebit);
    const credit = dec(entry.totalCredit);
    const difference = debit.minus(credit);
    return {
        lineCount: fromLines.lineCount,
        totalDebit: debit.toFixed(4),
        totalCredit: credit.toFixed(4),
        difference: difference.toFixed(4),
        balanced: entry.balanced === false ? false : fromLines.lineCount > 0 ? difference.isZero() : entry.balanced === true,
    };
};

export const formatTotalsLabel = (totals: Pick<EntryTotals, "totalDebit" | "totalCredit" | "balanced">): string =>
    `${totals.totalDebit} ${totals.balanced ? "=" : "≠"} ${totals.totalCredit}`;

export type JournalReference =
    | { kind: "link"; location: RouteLocationRaw }
    | { kind: "plain" };

/**
 * Where the record behind a journal entry lives. Only references that are real entity ids with an
 * existing "open by id" page are linkable; the others stay a plain reference.
 */
export const journalReferenceTarget = (reference: { route?: string | null; id?: string | null } | null | undefined): JournalReference => {
    const id = String(reference?.id ?? "").trim();
    if (!id) return { kind: "plain" };
    switch (reference?.route) {
        case "attempt":
            return { kind: "link", location: { name: "Transactions", query: { open: id } } };
        case "adjustment":
            return { kind: "link", location: { name: "Adjustments", query: { open: id } } };
        case "aml-case":
            return { kind: "link", location: { name: "AmlCases", query: { open: id } } };
        case "dispute":
            return { kind: "link", location: { name: "Disputes", query: { open: id } } };
        default:
            return { kind: "plain" };
    }
};

/**
 * Which "open by id" page shows the record a journal entry of this `refType` was posted for.
 * Mirrors `REFERENCE_ROUTES` in core-back (`adminLedger.ts`); types without a page are plain text.
 */
export const referenceRouteOfRefType = (refType: string | null | undefined): string | null => {
    switch (refType) {
        case "PAYMENT_ATTEMPT":
            return "attempt";
        case "ADJUSTMENT":
            return "adjustment";
        case "AML_RELEASE":
        case "AML_VOID":
            return "aml-case";
        case "DISPUTE_OUTCOME":
            return "dispute";
        default:
            return null;
    }
};

export const REF_TYPES = [
    "PAYMENT_ATTEMPT",
    "ADJUSTMENT",
    "AML_RELEASE",
    "AML_VOID",
    "SETTLEMENT_SWEEP",
    "FEE_VARIANCE",
    "COMMISSION_NETTING",
    "DISPUTE_OUTCOME",
] as const;

/**
 * Difference between the live (debit-positive) balance and the stored checkpoint: what was posted
 * since the last rollup and still has to be folded into the checkpoint.
 */
export const checkpointLag = (
    liveDebitPositive: string | number | null | undefined,
    checkpointDebitPositive: string | number | null | undefined,
): { lag: string; inSync: boolean } => {
    const lag = dec(liveDebitPositive).minus(dec(checkpointDebitPositive));
    return { lag: lag.toFixed(4), inSync: lag.isZero() };
};
