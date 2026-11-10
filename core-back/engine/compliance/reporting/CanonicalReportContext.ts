import { toCamelRows } from "../../db/rawRows";

type Any = Record<string, any>;

export interface ReportContextReport {
  id: string;
  reportType: string;
  reportCode: string | null;
  authority: string;
  periodStart: string | null;
  periodEnd: string | null;
  periodKey: string | null;
  dueAt: string | null;
  requiredOutputFormats: readonly string[];
}

export interface CanonicalReportContext {
  institution: Record<string, unknown>;
  report: ReportContextReport;
  merchant: Record<string, unknown> | null;
  wallet: Record<string, unknown> | null;
  transactions: Array<Record<string, unknown>>;
  amlCase: Record<string, unknown> | null;
  indicators: Array<Record<string, unknown>>;
  aggregates: Record<string, unknown>;
  narrative: Record<string, unknown>;
  pending: string[];
}

export interface BuildContextReport {
  id: string;
  reportType: string;
  reportCode: string | null;
  authority: string;
  subjectType: string;
  subjectId: string;
  amlCaseId: string | null;
  periodStart: Date | null;
  periodEnd: Date | null;
  periodKey: string | null;
  dueAt: Date | null;
  requiredOutputFormats: readonly string[];
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

const iso = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const money = (value: unknown): string => {
  if (value === null || value === undefined) return "0.0000";
  const text = String(value);
  return text.includes(".") ? text : `${text}.0000`;
};

const loadSettings = async (db: Any): Promise<Record<string, unknown>> => {
  const keys = [
    "goaml.rentity_id",
    "goaml.rentity_branch",
    "goaml.submission_code",
    "goaml.local_currency_code",
    "goaml.reporting_person_name",
    "goaml.reporting_person_email",
  ];
  const rows = toCamelRows<Any>(
    await db.$queryRawUnsafe(
      `SELECT DISTINCT ON (key) key, value_json
       FROM platform_settings
       WHERE key = ANY($1::text[])
       ORDER BY key, effective_from DESC, version DESC`,
      keys,
    ),
  );
  const settings: Record<string, unknown> = {};
  for (const row of rows) {
    const raw = row.valueJson ?? row.value_json;
    settings[String(row.key)] = typeof raw === "string" ? raw : raw;
  }
  return settings;
};

const settingString = (settings: Record<string, unknown>, key: string, fallback: string): string => {
  const value = settings[key];
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object" && "value" in value) {
    const inner = (value as Record<string, unknown>).value;
    if (typeof inner === "string") return inner;
  }
  return fallback;
};

const loadAttempt = async (db: Any, attemptId: string): Promise<Any | null> => {
  const rows = toCamelRows<Any>(
    await db.$queryRawUnsafe(
      `SELECT a.id, a.reference, a.created_at, a.status::text AS status, a.substatus,
              a.requested_amount, a.total_charged_amount, a.settled_amount, a.currency,
              a.provider_reference, a.gateway_reference, a.network_reference,
              a.merchant_id, a.rail_id, a.route_id, a.gateway_version_id,
              a.customer_fields_masked, a.payer_phone, a.payer_name,
              m.legal_name, m.trade_name, m.registration_no, m.tax_id, m.business_category,
              m.country, m.status::text AS merchant_status, m.kyb_status::text AS kyb_status,
              m.risk_tier::text AS risk_tier, m.contact_phone, m.contact_email,
              r.code AS rail_code, r.name_en AS rail_name, r.collection_mode::text AS collection_mode,
              g.code AS gateway_code, g.name AS gateway_name
       FROM payment_attempts a
       JOIN merchants m ON m.id = a.merchant_id
       JOIN rails r ON r.id = a.rail_id
       JOIN rail_routes rr ON rr.id = a.route_id
       JOIN gateways g ON g.id = rr.gateway_id
       WHERE a.id = $1::uuid`,
      attemptId,
    ),
  );
  return rows[0] ?? null;
};

const loadMerchant = async (db: Any, merchantId: string): Promise<Any | null> => {
  const rows = toCamelRows<Any>(
    await db.$queryRawUnsafe(
      `SELECT id, legal_name, trade_name, registration_no, tax_id, business_category, country,
              status::text AS status, kyb_status::text AS kyb_status, risk_tier::text AS risk_tier,
              contact_phone, contact_email, payout_bank_details_json
       FROM merchants WHERE id = $1::uuid`,
      merchantId,
    ),
  );
  return rows[0] ?? null;
};

const loadWallet = async (db: Any, merchantId: string, currency: string): Promise<Any | null> => {
  const rows = toCamelRows<Any>(
    await db.$queryRawUnsafe(
      `SELECT w.id, w.currency, w.status, w.created_at
       FROM wallets w WHERE w.merchant_id = $1::uuid AND w.currency = $2
       ORDER BY w.created_at ASC LIMIT 1`,
      merchantId,
      currency,
    ),
  );
  return rows[0] ?? null;
};

const loadAmlCase = async (db: Any, caseId: string): Promise<Any | null> => {
  const rows = toCamelRows<Any>(
    await db.$queryRawUnsafe(
      `SELECT id, subject_type, subject_id, trigger_reason, severity::text AS severity, status::text AS status,
              resolution_notes, created_at, updated_at
       FROM aml_cases WHERE id = $1::uuid`,
      caseId,
    ),
  );
  return rows[0] ?? null;
};

const merchantContext = (merchant: Any | null): Record<string, unknown> | null => {
  if (!merchant) return null;
  return {
    id: String(merchant.id),
    legalName: merchant.legalName ?? null,
    tradeName: merchant.tradeName ?? null,
    registrationNo: merchant.registrationNo ?? null,
    taxId: merchant.taxId ?? null,
    businessCategory: merchant.businessCategory ?? null,
    country: merchant.country ?? null,
    status: merchant.status ?? merchant.merchantStatus ?? null,
    kybStatus: merchant.kybStatus ?? null,
    riskTier: merchant.riskTier ?? null,
    contactPhone: merchant.contactPhone ?? null,
    contactEmail: merchant.contactEmail ?? null,
    payoutBankDetails: merchant.payoutBankDetailsJson ?? merchant.payout_bank_details_json ?? null,
  };
};

const attemptContext = (attempt: Any): Record<string, unknown> => ({
  id: String(attempt.id),
  reference: attempt.reference ?? null,
  providerReference: attempt.providerReference ?? attempt.provider_reference ?? null,
  gatewayReference: attempt.gatewayReference ?? attempt.gateway_reference ?? null,
  networkReference: attempt.networkReference ?? attempt.network_reference ?? null,
  createdAt: iso(attempt.createdAt ?? attempt.created_at),
  date: iso(attempt.createdAt ?? attempt.created_at),
  status: attempt.status ?? null,
  substatus: attempt.substatus ?? null,
  amount: money(attempt.requestedAmount ?? attempt.requested_amount),
  totalChargedAmount: money(attempt.totalChargedAmount ?? attempt.total_charged_amount),
  settledAmount: money(attempt.settledAmount ?? attempt.settled_amount),
  currency: attempt.currency ?? null,
  railCode: attempt.railCode ?? attempt.rail_code ?? null,
  railName: attempt.railName ?? attempt.rail_name ?? null,
  gatewayCode: attempt.gatewayCode ?? attempt.gateway_code ?? null,
  gatewayName: attempt.gatewayName ?? attempt.gateway_name ?? null,
  collectionMode: attempt.collectionMode ?? attempt.collection_mode ?? null,
  payerPhone: attempt.payerPhone ?? attempt.payer_phone ?? null,
  payerName: attempt.payerName ?? attempt.payer_name ?? null,
});

export const buildCanonicalReportContext = async (
  db: Any,
  report: BuildContextReport,
  payload: Record<string, unknown>,
): Promise<CanonicalReportContext> => {
  const settings = await loadSettings(db);
  const attempt = report.subjectType === "PAYMENT_ATTEMPT"
    ? await loadAttempt(db, report.subjectId)
    : null;
  const merchant = attempt
    ? await loadMerchant(db, String(attempt.merchantId ?? attempt.merchant_id))
    : await (async () => {
        const merchantId = typeof payload.merchantId === "string" ? payload.merchantId : null;
        return merchantId ? await loadMerchant(db, merchantId) : null;
      })();
  const currency = String(attempt?.currency ?? payload.currency ?? "LYD");
  const wallet = merchant ? await loadWallet(db, String(merchant.id), currency) : null;
  const amlCase = report.amlCaseId ? await loadAmlCase(db, report.amlCaseId) : null;
  const payloadSections = asRecord(payload.sections);
  const mapRows = (value: unknown): Array<Record<string, unknown>> =>
    Object.entries(asRecord(value)).map(([key, entry]) => {
      const row = asRecord(entry);
      return {
        key,
        count: Number(row.count ?? 0),
        amount: row.amount !== undefined ? money(row.amount) : null,
      };
    });
  const paymentRails = Array.isArray(payloadSections.paymentsByRail)
    ? payloadSections.paymentsByRail.map(asRecord)
    : [];
  const summaryRows: Array<Record<string, unknown>> = [
    { metric: "Payment rails", value: paymentRails.length },
    { metric: "Attempts", value: paymentRails.reduce((sum, row) => sum + Number(row.attempts ?? 0), 0) },
    { metric: "Succeeded", value: paymentRails.reduce((sum, row) => sum + Number(row.succeeded ?? 0), 0) },
    { metric: "Failed", value: paymentRails.reduce((sum, row) => sum + Number(row.failed ?? 0), 0) },
    { metric: "Unknown", value: paymentRails.reduce((sum, row) => sum + Number(row.unknown ?? 0), 0) },
  ];
  const payloadTransactions = Array.isArray(payloadSections.transactions)
    ? payloadSections.transactions
    : [];
  const transactions: Array<Record<string, unknown>> = attempt
    ? [attemptContext(attempt)]
    : payloadTransactions.map((entry) => {
        const row = asRecord(entry);
        return {
          id: row.id ?? null,
          reference: row.reference ?? null,
          date: row.date ?? row.createdAt ?? null,
          amount: money(row.amount ?? row.requestedAmount),
          totalChargedAmount: money(row.totalChargedAmount ?? row.amount),
          settledAmount: money(row.settledAmount ?? row.amount),
          currency: row.currency ?? null,
          railCode: row.railCode ?? row.rail ?? null,
          gatewayCode: row.gatewayCode ?? null,
          status: row.status ?? null,
          merchantId: row.merchantId ?? null,
        };
      });
  return {
    institution: {
      rentityId: settingString(settings, "goaml.rentity_id", "PROVISIONAL-CBL-RENTITY"),
      rentityBranch: settingString(settings, "goaml.rentity_branch", "PROVISIONAL"),
      submissionCode: settingString(settings, "goaml.submission_code", "E"),
      localCurrencyCode: settingString(settings, "goaml.local_currency_code", "LYD"),
      reportingPersonName: settingString(settings, "goaml.reporting_person_name", "Compliance Officer"),
      reportingPersonEmail: settingString(settings, "goaml.reporting_person_email", "compliance@payment-gateway.internal"),
    },
    report: {
      id: report.id,
      reportType: report.reportType,
      reportCode: report.reportCode,
      authority: report.authority,
      periodStart: iso(report.periodStart),
      periodEnd: iso(report.periodEnd),
      periodKey: report.periodKey,
      dueAt: iso(report.dueAt),
      requiredOutputFormats: report.requiredOutputFormats,
    },
    merchant: merchantContext(merchant),
    wallet: wallet ? { id: String(wallet.id), currency: wallet.currency, status: wallet.status } : null,
    transactions,
    amlCase: amlCase ? {
      id: String(amlCase.id),
      subjectType: amlCase.subjectType,
      subjectId: amlCase.subjectId,
      triggerReason: amlCase.triggerReason,
      severity: amlCase.severity,
      status: amlCase.status,
      resolutionNotes: amlCase.resolutionNotes ?? null,
    } : null,
    indicators: Array.isArray(payload.indicators) ? payload.indicators.map(asRecord) : [],
    aggregates: {
      ...payloadSections,
      paymentRails,
      summaryRows,
      refundsRows: mapRows(payloadSections.refunds),
      disputesOpenedRows: mapRows(payloadSections.disputesOpened),
      disputesDecidedRows: mapRows(payloadSections.disputesDecided),
      cashoutsRows: mapRows(payloadSections.cashouts),
      merchantStatusRows: mapRows(asRecord(payloadSections.merchants).byStatusAtGeneration),
      fundsRows: Array.isArray(payloadSections.fundsPositionAtGeneration)
        ? payloadSections.fundsPositionAtGeneration.map(asRecord)
        : [],
      screeningRows: mapRows(payloadSections.screenings),
      amlCaseRows: mapRows(payloadSections.amlCasesOpenedByCurrentStatus),
      kybRows: mapRows(payloadSections.kybStatusDistributionAtGeneration),
      riskTierRows: mapRows(payloadSections.merchantRiskTiersAtGeneration),
    },
    narrative: asRecord(payload.narrative),
    pending: Array.isArray(payload.pending) ? payload.pending.map(String) : [],
  };
};
