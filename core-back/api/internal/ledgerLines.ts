import { client } from "../../prisma/client";
import { buildListQuery, listResponse } from "../../lib/listQuery";
import { decimal } from "../../engine/ledger/LedgerPoster";
import { JournalRefType } from "../../generated/prisma/enums";
import { ApiError } from "../../lib/error";
import { andWhere, enumListFilter, money4, queryString, queryWithout } from "./adminSliceHelpers";

/**
 * Paginated posting lines of ONE gl account. It backs both the wallet statement
 * (`/wallets/:id/statement`) and the GL account drawer (`/finance/gl-accounts/:id/lines`),
 * because a wallet's statement is exactly the lines posted to its GL account.
 *
 * `journal_lines` is partitioned and append-only. Every query addresses it by
 * `gl_account_id` (indexed) and, when asked, a `created_at` range, so a page costs the
 * same whatever the account's history.
 */
const REF_TYPES = Object.values(JournalRefType) as JournalRefType[];
const DIRECTIONS = ["DEBIT", "CREDIT"] as const;

export interface AccountLineRow {
  lineId: string;
  entryId: string;
  direction: "DEBIT" | "CREDIT";
  amount: string;
  createdAt: Date;
  refType: string;
  refId: string;
  description: string | null;
}

export interface AccountLinesTotals {
  /** Lines matching the filters (not only the visible page). */
  lineCount: number;
  totalDebit: string;
  totalCredit: string;
}

/** The single value of the `direction` filter, validated (`DEBIT` or `CREDIT`). */
const directionFilter = (query: Record<string, unknown>): "DEBIT" | "CREDIT" | undefined => {
  const values = enumListFilter(query, "direction", DIRECTIONS);
  if (values === undefined) return undefined;
  if (values.length !== 1) throw new ApiError(400, "INVALID_FILTER", "The 'direction' filter is invalid", { allowed: DIRECTIONS });
  return values[0];
};

export const listAccountLines = async (
  glAccountId: string,
  rawQuery: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  const refTypes = enumListFilter(rawQuery, "refType", REF_TYPES);
  const direction = directionFilter(rawQuery);
  const built = buildListQuery(queryWithout(rawQuery, "search", "refType", "direction"), {
    dates: { createdAt: { path: "createdAt" } },
    sortable: { createdAt: "createdAt", amount: "amount" },
    defaultSort: { createdAt: "desc" },
    defaultPageSize: 25,
  });
  const text = queryString(rawQuery, "search");
  const where = andWhere(
    built.where,
    { glAccountId },
    direction ? { direction } : undefined,
    refTypes || text
      ? {
          entry: {
            ...(refTypes ? { refType: { in: refTypes } } : {}),
            ...(text ? { OR: [{ description: { contains: text, mode: "insensitive" } }, { refId: { contains: text, mode: "insensitive" } }] } : {}),
          },
        }
      : undefined,
  );

  // One covering aggregation computes the filtered line count AND the two side sums. A separate
  // journalLine.count() would scan the account index a second time for the same predicate.
  const [lines, sums] = await Promise.all([
    client.journalLine.findMany({
      where: where as never,
      orderBy: built.orderBy as never,
      skip: built.skip,
      take: built.take,
      select: {
        id: true,
        entryId: true,
        createdAt: true,
        direction: true,
        amount: true,
        entry: { select: { refType: true, refId: true, description: true } },
      },
    }),
    client.journalLine.groupBy({
      by: ["direction"],
      where: where as never,
      _count: { _all: true },
      _sum: { amount: true },
    }),
  ]);

  const total = sums.reduce((acc, row) => acc + (row._count?._all ?? 0), 0);
  const sumOf = (side: "DEBIT" | "CREDIT"): string => {
    const found = sums.find((row) => row.direction === side);
    return found?._sum.amount ? money4(found._sum.amount) : "0.0000";
  };
  const totals: AccountLinesTotals = {
    lineCount: total,
    totalDebit: sumOf("DEBIT"),
    totalCredit: sumOf("CREDIT"),
  };
  // `decimal` keeps the two sides exact; the net is derived once here so every client agrees.
  const net = decimal(totals.totalDebit).minus(decimal(totals.totalCredit)).toFixed(4);

  const rows: AccountLineRow[] = lines.map((line) => ({
    lineId: line.id,
    entryId: line.entryId,
    direction: line.direction,
    amount: money4(line.amount),
    createdAt: line.createdAt,
    refType: line.entry.refType,
    refId: line.entry.refId,
    description: line.entry.description,
  }));

  return { ...listResponse("lines", rows, total, built), totals: { ...totals, netDebit: net } };
};
