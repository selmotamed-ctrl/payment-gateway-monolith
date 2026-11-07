import Decimal from "decimal.js";
import type { FilterOption, TableFilter } from "@/components/Table/filters";
import { REF_TYPES, flipToNatural } from "./journalModel";

/**
 * Shared model of the paginated "posting lines of one GL account" table. It backs the wallet
 * statement and the GL account drawer: a wallet's statement IS the lines of its GL account.
 */
export interface AccountLine {
    lineId: string;
    entryId: string;
    direction: "DEBIT" | "CREDIT";
    amount: string;
    createdAt: string;
    refType: string;
    refId: string;
    description: string | null;
}

/** Totals of the WHOLE filtered set (not only the visible page). `null` when the role may not see money. */
export interface AccountLinesTotals {
    lineCount: number;
    totalDebit: string | null;
    totalCredit: string | null;
    /** debit minus credit, as stored. */
    netDebit: string | null;
}

const option = (value: string): FilterOption => ({ title: value.replaceAll("_", " "), value });

export const accountLineFilters: TableFilter[] = [
    {
        key: "direction",
        label: "Side",
        type: "data-autocomplete",
        options: [
            { title: "Debit", value: "DEBIT" },
            { title: "Credit", value: "CREDIT" },
        ],
    },
    { key: "refType", label: "Reference type", type: "data-autocomplete", options: REF_TYPES.map(option), multiple: true },
    { key: "date", label: "Posted", type: "date", queryFrom: "from", queryTo: "to" },
];

/**
 * Net effect of the filtered lines on the account's NATURAL balance (positive grows it), so a
 * wallet (a liability) reads "+100" after a payment credit instead of a confusing "-100".
 */
export const netChangeOf = (accountType: string | null | undefined, totals: Pick<AccountLinesTotals, "netDebit"> | null): string | null => {
    if (!totals || totals.netDebit === null || totals.netDebit === undefined) return null;
    try {
        return flipToNatural(accountType, new Decimal(totals.netDebit).toFixed(4));
    } catch {
        return null;
    }
};
