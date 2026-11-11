import type {
  AutocompleteProvider,
  CatalogModelDef,
  ReportEngineHostConfig,
} from "../../lib/reportEngineSdk/types/hostConfig";
import { PostgresReadOnlyReportExecutor } from "../../lib/reportEngineSdk/runtime/PostgresReadOnlyExecutor";
import { buildSchemaCatalog } from "./schemaCatalog";
import { LocalReportAssetStorage } from "./assetStorage";
import { env } from "../../lib/env";

/**
 * Explicit merchant allow-list (E02). Every model here has a direct
 * `merchant_id` column, so the merchant engine can inject
 * `<alias>.merchant_id = $merchant` on the base model AND every joined alias.
 * Models without a direct merchant key (payment links, POS terminals,
 * disputes, adjustments, reconciliation items) are deliberately absent; they
 * would need a scope path through another model, which is not trusted.
 */
const MERCHANT_MODEL_COLUMNS: Record<string, readonly string[]> = {
  merchants: [
    "id",
    "version",
    "created_at",
    "updated_at",
    "legal_name",
    "trade_name",
    "display_name",
    "business_category",
    "status",
    "kyb_status",
    "risk_tier",
    "country",
    "activated_at",
    "suspended_at",
    "next_kyb_review_at",
  ],
  applications: [
    "id",
    "created_at",
    "updated_at",
    "merchant_id",
    "name",
    "business_use_description",
    "expected_monthly_volume",
    "assigned_wallet_id",
    "status",
  ],
  wallets: ["id", "created_at", "updated_at", "merchant_id", "gl_account_id", "currency", "status"],
  payment_attempts: [
    "id",
    "created_at",
    "updated_at",
    "reference",
    "link_id",
    "application_id",
    "merchant_id",
    "rail_id",
    "status",
    "substatus",
    "requested_amount",
    "surcharge_amount",
    "total_charged_amount",
    "settled_amount",
    "gateway_fee_amount",
    "platform_commission_amount",
    "net_merchant_amount",
    "fee_bearer",
    "settlement_target",
    "currency",
    "expires_at",
    "terminal_at",
  ],
  cashout_requests: [
    "id",
    "created_at",
    "updated_at",
    "merchant_id",
    "wallet_id",
    "amount",
    "state",
    "adjustment_id",
  ],
  rm_merchant_daily_stats: [
    "merchant_id",
    "day",
    "currency",
    "attempt_count",
    "success_count",
    "failure_count",
    "gross_amount",
    "net_amount",
    "success_amount",
    "success_net_amount",
    "updated_at",
  ],
};

/** Explicit merchant autocomplete sources; staff-only sources are not exposed. */
const MERCHANT_AUTOCOMPLETE_SOURCES = ["applications", "currencies", "payment_links", "pos_terminals"] as const;

function pickMerchantModels(): Record<string, CatalogModelDef> {
  const catalog = buildSchemaCatalog();
  const models: Record<string, CatalogModelDef> = {};
  for (const [tableName, allowedColumns] of Object.entries(MERCHANT_MODEL_COLUMNS)) {
    const source = catalog.models[tableName];
    if (!source) continue;
    const allowed = new Set(allowedColumns);
    const columns = Object.fromEntries(
      Object.entries(source.columns).filter(([name, column]) => {
        if (allowed.has(name)) return true;
        if (name.endsWith("_minor")) {
          const base = Object.values(source.columns).find(
            (candidate) => candidate.dbColumnName === column.dbColumnName && !candidate.name.endsWith("_minor"),
          );
          return Boolean(base && allowed.has(base.name));
        }
        return false;
      }),
    );
    const relations = Object.fromEntries(
      Object.entries(source.relations).filter(
        ([, relation]) => MERCHANT_MODEL_COLUMNS[relation.targetModel] !== undefined,
      ),
    );
    models[tableName] = {
      ...source,
      columns,
      relations,
      requiredAuthorities: ["report_engine:run"],
      naturalRoles: ["MERCHANT_ADMIN", "MERCHANT_STAFF"],
      confidentialAmlOnly: false,
      merchantScopable:
        tableName === "merchants" ? { merchantIdColumn: "id" } : { merchantIdColumn: "merchant_id" },
    };
  }
  return models;
}

function merchantProviders(db: ReportEngineHostConfig["dbReadOnlyPort"]): Record<string, AutocompleteProvider> {
  const provider = (
    sourceKey: string,
    description: string,
    sql: string,
    mapRow: (row: Record<string, unknown>) => { value: string; label: string; sublabel?: string },
  ): AutocompleteProvider => ({
    sourceKey,
    description,
    valueType: "uuid",
    requiredAuthority: "report_engine:run",
    search: async ({ query, limit, dependentValues }) => {
      const merchantId =
        typeof dependentValues?.merchantId === "string" ? dependentValues.merchantId : null;
      if (!merchantId) return [];
      const result = await db.executeReadOnlyQuery({
        sql,
        values: [merchantId, `%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`, Math.max(1, Math.min(limit, 50))],
        timeoutMs: 3_000,
        maxRows: 50,
        queryLabel: `merchant_autocomplete_${sourceKey}`,
      });
      return result.rows.map((row) => mapRow(row));
    },
  });

  return {
    applications: provider(
      "applications",
      "Your applications",
      `SELECT id, name FROM applications WHERE merchant_id = $1 AND name ILIKE $2 ESCAPE '\\' ORDER BY name LIMIT $3`,
      (row) => ({ value: String(row.id), label: String(row.name) }),
    ),
    payment_links: provider(
      "payment_links",
      "Your payment links",
      `SELECT pl.id, pl.key FROM payment_links pl JOIN applications a ON a.id = pl.application_id
       WHERE a.merchant_id = $1 AND pl.key ILIKE $2 ESCAPE '\\' ORDER BY pl.created_at DESC LIMIT $3`,
      (row) => ({ value: String(row.id), label: String(row.key) }),
    ),
    pos_terminals: provider(
      "pos_terminals",
      "Your POS terminals",
      `SELECT pt.id, pt.name FROM pos_terminals pt JOIN applications a ON a.id = pt.application_id
       WHERE a.merchant_id = $1 AND pt.name ILIKE $2 ESCAPE '\\' ORDER BY pt.name LIMIT $3`,
      (row) => ({ value: String(row.id), label: String(row.name) }),
    ),
    currencies: {
      sourceKey: "currencies",
      description: "Supported currencies",
      valueType: "string",
      requiredAuthority: "report_engine:run",
      search: async ({ query, limit }) => {
        const codes = ["LYD", "USD", "EUR", "GBP", "AED", "TND", "EGP"];
        const q = query.trim().toUpperCase();
        return codes
          .filter((code) => !q || code.includes(q))
          .slice(0, Math.min(limit, 50))
          .map((code) => ({ value: code, label: code }));
      },
    },
  };
}

export function createMerchantReportHostConfig(deps: {
  readOnlyConnectionString?: string;
  assetStoragePort?: ReportEngineHostConfig["assetStoragePort"];
} = {}): ReportEngineHostConfig {
  const connectionString =
    deps.readOnlyConnectionString ??
    process.env.REPORT_MERCHANT_READONLY_DATABASE_URL ??
    process.env.REPORT_READONLY_DATABASE_URL ??
    env.DATABASE_URL;
  const servedBy =
    process.env.REPORT_READONLY_SERVED_BY === "replica" ? "replica" : "primary-readonly-tx";
  const dbReadOnlyPort = new PostgresReadOnlyReportExecutor({
    connectionString,
    maxPoolConnections: 4,
    defaultStatementTimeoutMs: 5_000,
    workMemMb: 16,
    servedBy,
  });
  const models = pickMerchantModels();
  const enums: Record<string, readonly string[]> = {};
  const catalog = buildSchemaCatalog();
  for (const model of Object.values(models)) {
    for (const column of Object.values(model.columns)) {
      if (column.enumName && catalog.enums[column.enumName]) {
        enums[column.enumName] = catalog.enums[column.enumName]!;
      }
    }
  }

  return {
    engineVersion: "1.0-merchant",
    institutionName: "Libyan National Payment Gateway",
    defaultCurrency: "LYD",
    defaultTimezone: "Africa/Tripoli",
    supportedLocales: ["en", "ar"],
    mandatoryDefaultLocales: ["en", "ar"],
    models,
    enums,
    rolesCatalog: ["MERCHANT_ADMIN", "MERCHANT_STAFF"],
    authoritiesCatalog: ["report_engine:run", "report_engine:author"],
    authorityConflictMatrix: [],
    securityOverrideAuthority: "report_engine:author",
    securityOverrideRoles: [],
    piiUnmaskAuthorities: [],
    defaultCurrencyMinorUnitScale: 1000,
    autocompleteProviders: merchantProviders(dbReadOnlyPort),
    dbReadOnlyPort,
    assetStoragePort: deps.assetStoragePort ?? new LocalReportAssetStorage(),
    globalLimits: {
      maxDatasetsPerReport: 6,
      maxJoinsPerDataset: 2,
      maxRowsPerDataset: 10_000,
      maxQueryTimeoutMs: 5_000,
      maxExplainCost: 60_000,
      maxAssetZipBytes: 2 * 1024 * 1024,
      maxSingleAssetBytes: 1024 * 1024,
      maxSeqScanCost: 1,
    },
  };
}

let cachedMerchantHost: ReportEngineHostConfig | null = null;

export function getMerchantReportHostConfig(): ReportEngineHostConfig {
  if (!cachedMerchantHost) cachedMerchantHost = createMerchantReportHostConfig();
  return cachedMerchantHost;
}

export function clearMerchantReportHostConfigForTests(): void {
  cachedMerchantHost = null;
}

export const MERCHANT_REPORT_MODEL_ALLOWLIST = Object.keys(MERCHANT_MODEL_COLUMNS);
export const MERCHANT_REPORT_AUTOCOMPLETE_SOURCES = MERCHANT_AUTOCOMPLETE_SOURCES;
