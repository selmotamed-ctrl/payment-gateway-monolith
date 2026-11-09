import { toCamelRows } from "../../db/rawRows";

type Any = Record<string, any>;

/**
 * The data sections of the provisional CBL report catalogue (plan section 6.2, AUTO-16). Every query is read-only,
 * aggregates over one period `[start, end)` (index-backed by `created_at`/`opened_at`/`requested_at`), and returns plain
 * JSON. The sections the platform cannot fill from its own data yet (service availability, incident narrative, staff
 * training completion, risk-assessment inputs, narratives) are listed in `pending` so the person who completes the
 * draft sees what is still theirs to add; nothing is invented.
 */
export interface PeriodRange {
  start: Date;
  end: Date;
}

const rows = async (db: Any, sql: string, ...values: unknown[]): Promise<Array<Record<string, any>>> =>
  toCamelRows<Record<string, any>>(await db.$queryRawUnsafe(sql, ...values));

const asCounts = (result: Array<Record<string, any>>, key: string): Record<string, { count: number; amount?: string }> => {
  const out: Record<string, { count: number; amount?: string }> = {};
  for (const row of result) {
    out[String(row[key])] = { count: Number(row.n), ...(row.amount !== undefined ? { amount: String(row.amount) } : {}) };
  }
  return out;
};

const rate = (part: number, whole: number): string => (whole === 0 ? "0.0000" : (part / whole).toFixed(4));

/** `PSP-M`: the monthly payment-service return. */
export const buildMonthlyPaymentReturn = async (db: Any, range: PeriodRange): Promise<Record<string, unknown>> => {
  const attempts = await rows(
    db,
    `SELECT r.code AS rail, a.currency, a.status::text AS status, count(*)::int AS n, coalesce(sum(a.requested_amount), 0)::text AS amount
     FROM payment_attempts a JOIN rails r ON r.id = a.rail_id
     WHERE a.created_at >= $1 AND a.created_at < $2
     GROUP BY r.code, a.currency, a.status ORDER BY r.code, a.currency, a.status`,
    range.start,
    range.end,
  );
  const byRail: Record<string, { currency: string; total: number; succeeded: number; failed: number; unknown: number; valueSucceeded: string; statuses: Record<string, number> }> = {};
  const valueByRail: Record<string, bigint> = {};
  for (const row of attempts) {
    const key = `${row.rail}/${row.currency}`;
    const entry = (byRail[key] ??= { currency: String(row.currency), total: 0, succeeded: 0, failed: 0, unknown: 0, valueSucceeded: "0.0000", statuses: {} });
    const count = Number(row.n);
    entry.total += count;
    entry.statuses[String(row.status)] = count;
    if (row.status === "SUCCEEDED") {
      entry.succeeded += count;
      // exact decimal addition in 1/10000 units
      const [whole, fraction = ""] = String(row.amount).split(".");
      valueByRail[key] = (valueByRail[key] ?? 0n) + BigInt(whole!) * 10_000n + BigInt((fraction + "0000").slice(0, 4));
    }
    if (row.status === "FAILED") entry.failed += count;
    if (row.status === "UNKNOWN") entry.unknown += count;
  }
  const rails = Object.entries(byRail).map(([key, entry]) => {
    const units = valueByRail[key] ?? 0n;
    return {
      rail: key.split("/")[0],
      currency: entry.currency,
      attempts: entry.total,
      succeeded: entry.succeeded,
      failed: entry.failed,
      unknown: entry.unknown,
      successRate: rate(entry.succeeded, entry.total),
      failureRate: rate(entry.failed, entry.total),
      unknownRate: rate(entry.unknown, entry.total),
      valueSucceeded: `${units / 10_000n}.${String(units % 10_000n).padStart(4, "0")}`,
      statuses: entry.statuses,
    };
  });

  const refunds = asCounts(
    await rows(db, `SELECT state::text AS state, count(*)::int AS n, coalesce(sum(amount), 0)::text AS amount FROM adjustments WHERE type = 'REFUND' AND created_at >= $1 AND created_at < $2 GROUP BY state`, range.start, range.end),
    "state",
  );
  const disputesOpened = asCounts(
    await rows(db, `SELECT status::text AS status, count(*)::int AS n, coalesce(sum(amount), 0)::text AS amount FROM disputes WHERE opened_at >= $1 AND opened_at < $2 GROUP BY status`, range.start, range.end),
    "status",
  );
  const disputesDecided = asCounts(
    await rows(db, `SELECT status::text AS status, count(*)::int AS n, coalesce(sum(amount), 0)::text AS amount FROM disputes WHERE outcome_at >= $1 AND outcome_at < $2 GROUP BY status`, range.start, range.end),
    "status",
  );
  const cashouts = asCounts(
    await rows(db, `SELECT state::text AS state, count(*)::int AS n, coalesce(sum(amount), 0)::text AS amount FROM cashout_requests WHERE created_at >= $1 AND created_at < $2 GROUP BY state`, range.start, range.end),
    "state",
  );
  const merchantsNow = asCounts(await rows(db, `SELECT status::text AS status, count(*)::int AS n FROM merchants GROUP BY status`), "status");
  const onboarded = Number((await rows(db, `SELECT count(*)::int AS n FROM merchants WHERE created_at >= $1 AND created_at < $2`, range.start, range.end))[0]?.n ?? 0);
  const funds = await rows(
    db,
    `SELECT a.account_type::text AS account_type, a.currency, coalesce(sum(s.current_balance), 0)::text AS balance
     FROM gl_accounts a JOIN gl_account_shards s ON s.gl_account_id = a.id
     WHERE a.account_type IN ('MERCHANT_WALLET', 'TREASURY', 'GATEWAY_CLEARING', 'CHARGEBACK_RESERVE', 'AML_HOLD')
     GROUP BY a.account_type, a.currency ORDER BY a.account_type, a.currency`,
  );
  return {
    sections: {
      paymentsByRail: rails,
      refunds,
      disputesOpened,
      disputesDecided,
      cashouts,
      merchants: { byStatusAtGeneration: merchantsNow, onboardedInPeriod: onboarded },
      // Balances at the time the draft was generated (not at the period end): a point-in-time reading, labelled as such.
      fundsPositionAtGeneration: funds.map((row) => ({ accountType: String(row.accountType), currency: String(row.currency), balance: String(row.balance) })),
    },
    pending: ["serviceAvailabilityAndIncidents"],
  };
};

/** `AML-Q`: the quarterly AML return (counts only; the number of STRs is a count, never their content). */
export const buildQuarterlyAmlReturn = async (db: Any, range: PeriodRange): Promise<Record<string, unknown>> => {
  const screenings = asCounts(
    await rows(db, `SELECT result::text AS result, count(*)::int AS n FROM aml_screenings WHERE requested_at >= $1 AND requested_at < $2 GROUP BY result`, range.start, range.end),
    "result",
  );
  const casesOpened = asCounts(
    await rows(db, `SELECT status::text AS status, count(*)::int AS n FROM aml_cases WHERE created_at >= $1 AND created_at < $2 GROUP BY status`, range.start, range.end),
    "status",
  );
  const casesOverdue = Number(
    (await rows(db, `SELECT count(*)::int AS n FROM aml_cases WHERE sla_due_at < $1 AND status IN ('OPEN', 'IN_REVIEW', 'PENDING_CHECKER')`, range.end))[0]?.n ?? 0,
  );
  const reportsFiled = asCounts(
    await rows(db, `SELECT report_type::text AS report_type, count(*)::int AS n FROM regulatory_reports WHERE report_type = 'SUSPICIOUS_ACTIVITY' AND status IN ('SUBMITTED', 'ACKNOWLEDGED', 'REJECTED_BY_AUTHORITY') AND submitted_at >= $1 AND submitted_at < $2 GROUP BY report_type`, range.start, range.end),
    "reportType",
  );
  const kyb = asCounts(await rows(db, `SELECT kyb_status::text AS kyb_status, count(*)::int AS n FROM merchants GROUP BY kyb_status`), "kybStatus");
  const reverifications = Number(
    (await rows(db, `SELECT count(*)::int AS n FROM kyb_revalidation_requests WHERE created_at >= $1 AND created_at < $2`, range.start, range.end))[0]?.n ?? 0,
  );
  return {
    sections: {
      screenings,
      amlCasesOpenedByCurrentStatus: casesOpened,
      amlCasesOverdueAtPeriodEnd: casesOverdue,
      // A count only: the content of a suspicious-activity report is never part of a periodic return.
      suspiciousActivityReportsFiled: Number(reportsFiled.SUSPICIOUS_ACTIVITY?.count ?? 0),
      kybStatusDistributionAtGeneration: kyb,
      kybReverificationsRequested: reverifications,
    },
    pending: ["staffAmlTrainingCompletion"],
  };
};

/** `AML-A`: the annual AML return; the figures of the year, the rest is the MLRO's narrative. */
export const buildAnnualAmlReturn = async (db: Any, range: PeriodRange): Promise<Record<string, unknown>> => {
  const quarterly = await buildQuarterlyAmlReturn(db, range);
  const tiers = asCounts(await rows(db, `SELECT risk_tier::text AS risk_tier, count(*)::int AS n FROM merchants GROUP BY risk_tier`), "riskTier").valueOf();
  return {
    sections: {
      ...(quarterly.sections as Record<string, unknown>),
      merchantRiskTiersAtGeneration: tiers,
    },
    pending: ["staffAmlTrainingCompletion", "riskAssessmentNarrative", "policyAndControlChanges", "auditFindings"],
  };
};

/** `LTR`: one line per successful attempt at or above the threshold in the batch (reference, date, amount, rail, merchant, status). */
export const buildLargeTransactionBatch = async (
  db: Any,
  range: PeriodRange,
  threshold: string,
  currency: string,
  limit: number,
): Promise<Record<string, unknown>> => {
  const lines = await rows(
    db,
    `SELECT a.reference, a.created_at AS date, a.requested_amount::text AS amount, a.currency, r.code AS rail, a.merchant_id::text AS merchant_id, a.status::text AS status
     FROM payment_attempts a JOIN rails r ON r.id = a.rail_id
     WHERE a.created_at >= $1 AND a.created_at < $2 AND a.currency = $3 AND a.requested_amount >= $4::numeric
       AND a.status IN ('SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'DISPUTED')
     ORDER BY a.created_at ASC, a.id ASC LIMIT $5`,
    range.start,
    range.end,
    currency,
    threshold,
    limit + 1,
  );
  const truncated = lines.length > limit;
  const kept = lines.slice(0, limit);
  return {
    sections: {
      threshold,
      currency,
      transactions: kept.map((row) => ({
        reference: String(row.reference),
        date: (row.date instanceof Date ? row.date : new Date(String(row.date))).toISOString(),
        amount: String(row.amount),
        currency: String(row.currency),
        rail: String(row.rail),
        merchantId: String(row.merchantId),
        status: String(row.status),
      })),
      transactionCount: kept.length,
      truncated,
    },
    pending: truncated ? ["batchTruncatedAtLimit"] : [],
  };
};
