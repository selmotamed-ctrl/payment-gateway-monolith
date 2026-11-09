import type {
  CatalogModelDef,
  ExplainPlanSummary,
  ReadOnlyDatabasePort,
  ReadOnlyQueryResult,
  ReportActorContext,
  ReportEngineHostConfig,
} from "../../lib/reportEngineSdk/types/hostConfig";
import type { ReportChromeSpec } from "../../lib/reportEngineSdk/types/chromeSpec";
import type { ReportDescriptorSpec } from "../../lib/reportEngineSdk/types/reportSpec";

const model = (input: CatalogModelDef): CatalogModelDef => input;

const ledgerRule = {
  mandatoryFilterColumns: [
    {
      column: "created_at",
      allowedOperators: ["between", "gte_lte"] as const,
      maxDateRangeDays: 366,
      rationale: "journal_lines is monthly range-partitioned by created_at.",
      aiFixHint: "Add a bounded created_at predicate bound to a daterange input with max_range_days <= 366.",
    },
  ],
  requireIndexedFilter: true,
  maxRowsReturned: 10_000,
  transcriptOptimizationNote: "Always bound journal_lines.created_at.",
};

const simpleRule = {
  requireIndexedFilter: false,
  maxRowsReturned: 10_000,
  transcriptOptimizationNote: "Prefer indexed filters.",
};

export function createTestHostConfig(overrides: Partial<ReportEngineHostConfig> = {}): ReportEngineHostConfig {
  const models: Record<string, CatalogModelDef> = {
    journal_lines: model({
      modelName: "journal_lines",
      tableName: "journal_lines",
      domain: "LEDGER",
      description: "Partitioned ledger lines",
      partitionedBy: "created_at",
      requiredAuthorities: ["finance:read"],
      naturalRoles: ["FINANCE"],
      merchantScopable: { merchantIdColumn: "merchant_id" },
      optimizationRule: ledgerRule,
      relations: {
        gl_account: {
          name: "gl_account",
          targetModel: "gl_accounts",
          cardinality: "MANY_TO_ONE",
          sourceKey: "gl_account_id",
          targetKey: "id",
        },
        merchant: {
          name: "merchant",
          targetModel: "merchants",
          cardinality: "MANY_TO_ONE",
          sourceKey: "merchant_id",
          targetKey: "id",
        },
      },
      columns: {
        id: { name: "id", dbColumnName: "id", type: "uuid", nullable: false, indexed: true, sensitivity: "INTERNAL", description: "Line id" },
        journal_entry_id: { name: "journal_entry_id", dbColumnName: "journal_entry_id", type: "uuid", nullable: false, indexed: true, sensitivity: "INTERNAL", description: "Entry id" },
        gl_account_id: { name: "gl_account_id", dbColumnName: "gl_account_id", type: "uuid", nullable: false, indexed: true, sensitivity: "INTERNAL", description: "Account id" },
        merchant_id: { name: "merchant_id", dbColumnName: "merchant_id", type: "uuid", nullable: true, indexed: true, sensitivity: "INTERNAL", description: "Merchant id" },
        direction: { name: "direction", dbColumnName: "direction", type: "enum", enumName: "JournalDirection", nullable: false, indexed: false, sensitivity: "PUBLIC", description: "DEBIT/CREDIT" },
        amount_minor: { name: "amount_minor", dbColumnName: "amount_minor", type: "bigint", nullable: false, indexed: false, sensitivity: "INTERNAL", description: "Minor amount" },
        currency: { name: "currency", dbColumnName: "currency", type: "string", nullable: false, indexed: true, sensitivity: "PUBLIC", description: "Currency" },
        created_at: { name: "created_at", dbColumnName: "created_at", type: "datetime", nullable: false, indexed: true, sensitivity: "PUBLIC", description: "Created at" },
      },
    }),
    gl_accounts: model({
      modelName: "gl_accounts",
      tableName: "gl_accounts",
      domain: "LEDGER",
      description: "Chart of accounts",
      requiredAuthorities: ["finance:read"],
      naturalRoles: ["FINANCE"],
      optimizationRule: simpleRule,
      relations: {},
      columns: {
        id: { name: "id", dbColumnName: "id", type: "uuid", nullable: false, indexed: true, sensitivity: "INTERNAL", description: "Account id" },
        account_type: { name: "account_type", dbColumnName: "account_type", type: "enum", nullable: false, indexed: true, sensitivity: "PUBLIC", description: "Account type" },
        currency: { name: "currency", dbColumnName: "currency", type: "string", nullable: false, indexed: true, sensitivity: "PUBLIC", description: "Currency" },
      },
    }),
    gl_account_shards: model({
      modelName: "gl_account_shards",
      tableName: "gl_account_shards",
      domain: "LEDGER",
      description: "Live shard balances",
      requiredAuthorities: ["finance:read"],
      naturalRoles: ["FINANCE"],
      optimizationRule: simpleRule,
      relations: {},
      columns: {
        gl_account_id: { name: "gl_account_id", dbColumnName: "gl_account_id", type: "uuid", nullable: false, indexed: true, sensitivity: "INTERNAL", description: "Account id" },
        shard_no: { name: "shard_no", dbColumnName: "shard_no", type: "int", nullable: false, indexed: true, sensitivity: "INTERNAL", description: "Shard" },
        balance_minor: { name: "balance_minor", dbColumnName: "balance_minor", type: "bigint", nullable: false, indexed: false, sensitivity: "INTERNAL", description: "Balance" },
      },
    }),
    payment_attempts: model({
      modelName: "payment_attempts",
      tableName: "payment_attempts",
      domain: "PAYMENTS",
      description: "Payment attempts",
      requiredAuthorities: ["merchant:read"],
      naturalRoles: ["OPERATOR", "FINANCE", "SUPPORT"],
      merchantScopable: { merchantIdColumn: "merchant_id" },
      optimizationRule: {
        mandatoryFilterColumns: [
          {
            column: "created_at",
            allowedOperators: ["between", "gte_lte"] as const,
            maxDateRangeDays: 180,
            rationale: "payment_attempts is a large history table.",
            aiFixHint: "Bound created_at with max_range_days <= 180.",
          },
        ],
        requireIndexedFilter: true,
        maxRowsReturned: 10_000,
        transcriptOptimizationNote: "Bound payment_attempts.created_at.",
      },
      relations: {
        merchant: {
          name: "merchant",
          targetModel: "merchants",
          cardinality: "MANY_TO_ONE",
          sourceKey: "merchant_id",
          targetKey: "id",
        },
      },
      columns: {
        id: { name: "id", dbColumnName: "id", type: "uuid", nullable: false, indexed: true, sensitivity: "INTERNAL", description: "Attempt id" },
        merchant_id: { name: "merchant_id", dbColumnName: "merchant_id", type: "uuid", nullable: false, indexed: true, sensitivity: "INTERNAL", description: "Merchant id" },
        status: { name: "status", dbColumnName: "status", type: "enum", nullable: false, indexed: true, sensitivity: "PUBLIC", description: "Status" },
        total_charged_amount_minor: { name: "total_charged_amount_minor", dbColumnName: "total_charged_amount_minor", type: "bigint", nullable: false, indexed: false, sensitivity: "INTERNAL", description: "Amount" },
        created_at: { name: "created_at", dbColumnName: "created_at", type: "datetime", nullable: false, indexed: true, sensitivity: "PUBLIC", description: "Created at" },
      },
    }),
    merchants: model({
      modelName: "merchants",
      tableName: "merchants",
      domain: "MERCHANTS",
      description: "Merchants",
      requiredAuthorities: ["merchant:read"],
      naturalRoles: ["OPERATOR", "FINANCE", "SUPPORT"],
      merchantScopable: { merchantIdColumn: "id" },
      optimizationRule: simpleRule,
      relations: {},
      columns: {
        id: { name: "id", dbColumnName: "id", type: "uuid", nullable: false, indexed: true, sensitivity: "INTERNAL", description: "Merchant id" },
        trade_name: { name: "trade_name", dbColumnName: "trade_name", type: "string", nullable: false, indexed: true, sensitivity: "INTERNAL", description: "Trade name" },
        status: { name: "status", dbColumnName: "status", type: "enum", nullable: false, indexed: true, sensitivity: "PUBLIC", description: "Status" },
      },
    }),
    aml_cases: model({
      modelName: "aml_cases",
      tableName: "aml_cases",
      domain: "COMPLIANCE_AML",
      description: "Confidential AML cases",
      requiredAuthorities: ["aml:read", "compliance:read"],
      naturalRoles: ["COMPLIANCE", "MLRO"],
      confidentialAmlOnly: true,
      optimizationRule: simpleRule,
      relations: {},
      columns: {
        id: { name: "id", dbColumnName: "id", type: "uuid", nullable: false, indexed: true, sensitivity: "CONFIDENTIAL_AML", description: "Case id" },
        severity: { name: "severity", dbColumnName: "severity", type: "enum", nullable: false, indexed: true, sensitivity: "CONFIDENTIAL_AML", description: "Severity" },
        status: { name: "status", dbColumnName: "status", type: "enum", nullable: false, indexed: true, sensitivity: "CONFIDENTIAL_AML", description: "Status" },
      },
    }),
    gateway_versions: model({
      modelName: "gateway_versions",
      tableName: "gateway_versions",
      domain: "GATEWAYS",
      description: "Gateway versions",
      requiredAuthorities: ["gateway:read"],
      naturalRoles: ["GATEWAY_ADMIN"],
      optimizationRule: simpleRule,
      relations: {},
      columns: {
        id: { name: "id", dbColumnName: "id", type: "uuid", nullable: false, indexed: true, sensitivity: "INTERNAL", description: "Version id" },
        status: { name: "status", dbColumnName: "status", type: "enum", nullable: false, indexed: true, sensitivity: "PUBLIC", description: "Status" },
      },
    }),
    credential_sets: model({
      modelName: "credential_sets",
      tableName: "credential_sets",
      domain: "GATEWAYS",
      description: "Gateway credentials",
      requiredAuthorities: ["gateway:read"],
      naturalRoles: ["GATEWAY_ADMIN"],
      optimizationRule: simpleRule,
      relations: {},
      columns: {
        id: { name: "id", dbColumnName: "id", type: "uuid", nullable: false, indexed: true, sensitivity: "INTERNAL", description: "Credential id" },
        entries_ciphertext: { name: "entries_ciphertext", dbColumnName: "entries_ciphertext", type: "json", nullable: false, indexed: false, sensitivity: "FORBIDDEN_SECRET", description: "Sealed secrets" },
      },
    }),
    users: model({
      modelName: "users",
      tableName: "users",
      domain: "SECURITY_AUDIT",
      description: "Users",
      requiredAuthorities: ["security:read"],
      naturalRoles: ["SECURITY_ADMIN"],
      optimizationRule: simpleRule,
      relations: {},
      columns: {
        id: { name: "id", dbColumnName: "id", type: "uuid", nullable: false, indexed: true, sensitivity: "INTERNAL", description: "User id" },
        email: { name: "email", dbColumnName: "email", type: "string", nullable: false, indexed: true, sensitivity: "PII_MASKED", description: "Email" },
        password_hash: { name: "password_hash", dbColumnName: "password_hash", type: "string", nullable: true, indexed: false, sensitivity: "FORBIDDEN_SECRET", description: "Password hash" },
      },
    }),
  };

  return {
    engineVersion: "1.0-test",
    institutionName: "Test Institution",
    defaultCurrency: "LYD",
    defaultTimezone: "Africa/Tripoli",
    supportedLocales: ["en", "ar", "fr"],
    mandatoryDefaultLocales: ["en", "ar"],
    models,
    enums: { JournalDirection: ["DEBIT", "CREDIT"] },
    rolesCatalog: ["SECURITY_ADMIN", "FINANCE", "OPERATOR", "COMPLIANCE", "MLRO", "SUPPORT", "GATEWAY_ADMIN"],
    authoritiesCatalog: ["finance:read", "merchant:read", "aml:read", "compliance:read", "gateway:read", "security:read", "security:write", "report:review", "report:approve"],
    authorityConflictMatrix: [
      {
        domainA: "COMPLIANCE_AML",
        domainB: "GATEWAYS",
        conflictCode: "AML_CONFIDENTIAL_WITH_GATEWAY_OPS",
        description: "Confidential AML with gateway operations leaves zero default roles.",
        resolutionHint: "Split the report or use a Security Admin override.",
      },
    ],
    securityOverrideAuthority: "security:write",
    securityOverrideRoles: ["SECURITY_ADMIN"],
    autocompleteProviders: {
      merchants: {
        sourceKey: "merchants",
        description: "Merchants",
        valueType: "uuid",
        requiredAuthority: "merchant:read",
        search: async () => [],
      },
      applications: {
        sourceKey: "applications",
        description: "Applications",
        valueType: "uuid",
        requiredAuthority: "merchant:read",
        search: async () => [],
      },
      currencies: {
        sourceKey: "currencies",
        description: "Currencies",
        valueType: "string",
        requiredAuthority: "finance:read",
        search: async () => [],
      },
    },
    dbReadOnlyPort: new FakeReadOnlyPort(),
    assetStoragePort: {
      storeAssetBundle: async () => ({ bundleStorageKey: "test" }),
      getAssetBuffer: async () => null,
    },
    globalLimits: {
      maxDatasetsPerReport: 10,
      maxJoinsPerDataset: 6,
      maxRowsPerDataset: 10_000,
      maxQueryTimeoutMs: 15_000,
      maxExplainCost: 150_000,
      maxAssetZipBytes: 15 * 1024 * 1024,
      maxSingleAssetBytes: 5 * 1024 * 1024,
    },
    ...overrides,
  };
}

export class FakeReadOnlyPort implements ReadOnlyDatabasePort {
  public explain: ExplainPlanSummary = {
    totalCost: 100,
    planRows: 10,
    hasSeqScanOnLargeTable: false,
    seqScanTables: [],
    partitionsScanned: 1,
    rawPlanJson: {},
  };
  public rows: Array<Record<string, unknown>> = [];
  public queries: Array<{ sql: string; values: unknown[] }> = [];

  async executeReadOnlyQuery<T = Record<string, unknown>>(params: {
    sql: string;
    values: unknown[];
    timeoutMs: number;
    maxRows: number;
    queryLabel: string;
  }): Promise<ReadOnlyQueryResult<T>> {
    this.queries.push({ sql: params.sql, values: params.values });
    return {
      rows: this.rows as T[],
      rowCount: this.rows.length,
      durationMs: 1,
      servedBy: "fake",
    };
  }

  async explainReadOnlyQuery(): Promise<ExplainPlanSummary> {
    return this.explain;
  }
}

const translations = {
  en: {
    "report.title": "Merchant Settlement Summary",
    "input.merchant": "Target Merchant",
    "input.period": "Statement Period",
    "kpi.title": "Settlement Summary",
    "kpi.total": "Total Movement",
    "table.title": "Daily Turnover",
    "table.day": "Day",
    "table.amount": "Amount",
    "chart.title": "Daily Volume",
    "chart.credit": "Credits",
    "draw.title": "Settlement Flow",
    "draw.gross": "Gross",
  },
  ar: {
    "report.title": "ملخص تسويات التاجر",
    "input.merchant": "التاجر المستهدف",
    "input.period": "فترة الكشف",
    "kpi.title": "ملخص التسوية",
    "kpi.total": "إجمالي الحركة",
    "table.title": "الحركة اليومية",
    "table.day": "اليوم",
    "table.amount": "المبلغ",
    "chart.title": "الحجم اليومي",
    "chart.credit": "الدائن",
    "draw.title": "تدفق التسوية",
    "draw.gross": "الإجمالي",
  },
};

export function baseReportSpec(): ReportDescriptorSpec {
  return {
    spec_kind: "REPORT_DESCRIPTOR",
    spec_version: "1.0",
    report: {
      code: "merchant-settlement-summary",
      version: 1,
      category: "MERCHANT_SETTLEMENT",
      audience_scope: "BOTH",
      merchant_scope_input_key: "merchantId",
      classification: "MERCHANT_CONFIDENTIAL",
    },
    page_layout: {
      paper_size: "A4",
      orientation: "PORTRAIT",
      margins_mm: { top: 26, right: 14, bottom: 24, left: 14 },
      header_mode: "GLOBAL_DEFAULT",
      footer_mode: "GLOBAL_DEFAULT",
      allow_runtime_chrome_selection: true,
      global_scoped_css: "",
    },
    required_assets: [],
    i18n: {
      default_locale: "en",
      prompt_user_when_multi_locale: true,
      locales: structuredClone(translations),
    },
    inputs: [
      {
        key: "merchantId",
        label_i18n_key: "input.merchant",
        type: "entity_autocomplete",
        required: true,
        autocomplete: { source: "merchants" },
        layout_col_span: 6,
      },
      {
        key: "periodRange",
        label_i18n_key: "input.period",
        type: "daterange",
        required: true,
        validation: { max_range_days: 366 },
        layout_col_span: 6,
      },
    ],
    datasets: [
      {
        dataset_id: "totals",
        description: "Period totals",
        from_model: "journal_lines",
        from_alias: "jl",
        joins: [],
        select: [
          { alias: "currency", column: "currency", expression: "COLUMN", format_hint: "RAW" },
          { alias: "total", column: "amount_minor", expression: "COLUMN", aggregate: "SUM", format_hint: "CURRENCY_MINOR" },
        ],
        where: {
          kind: "GROUP",
          logic: "AND",
          conditions: [
            {
              kind: "PREDICATE",
              column: "merchant_id",
              op: "eq",
              binding: { source: "INPUT", input_key: "merchantId", omit_if_empty: false },
            },
            {
              kind: "PREDICATE",
              column: "created_at",
              op: "between",
              binding: { source: "INPUT", input_key: "periodRange", range_bound: "BOTH", omit_if_empty: false },
            },
          ],
        },
        group_by: ["currency"],
        having: [],
        window_fields: [],
        order_by: [],
        limit: 10,
      },
    ],
    transforms: [],
    sections: [
      {
        section_type: "KPI_GRID",
        section_id: "kpis",
        title_i18n_key: "kpi.title",
        columns: 2,
        cards: [
          {
            label_i18n_key: "kpi.total",
            dataset_id: "totals",
            value_field: "total",
            row_index: 0,
            format_hint: "CURRENCY_MINOR",
            tone: "PRIMARY",
          },
        ],
      },
    ],
  };
}

export function baseChromeSpec(type: "HEADER" | "FOOTER" = "HEADER", code = "institutional-header-v1"): ReportChromeSpec {
  return {
    spec_kind: "REPORT_CHROME",
    spec_version: "1.0",
    chrome: {
      code,
      name: `Institutional ${type}`,
      chrome_type: type,
      height_mm: 22,
      show_on_first_page: true,
      border_style: "THIN_RULE",
    },
    required_assets: [],
    i18n: {
      default_locale: "en",
      locales: {
        en: { "chrome.division": "Financial Operations", "chrome.page": "Page", "chrome.of": "of" },
        ar: { "chrome.division": "العمليات المالية", "chrome.page": "صفحة", "chrome.of": "من" },
      },
    },
    template: {
      html: "<div><strong>{{institutionName}}</strong> — {{$t.chrome.division}} — {{reportTitle}} — {{$t.chrome.page}} <span class=\"report-page-number\"></span> {{$t.chrome.of}} <span class=\"report-total-pages\"></span></div>",
      scoped_css: "",
      used_variables: ["institutionName", "reportTitle", "pageNumber", "totalPages"],
    },
  };
}

export const financeActor: ReportActorContext = {
  userId: "00000000-0000-0000-0000-000000000001",
  email: "finance@example.test",
  role: "FINANCE",
  authorities: ["finance:read", "report:review"],
};

export const securityAdminActor: ReportActorContext = {
  userId: "00000000-0000-0000-0000-000000000002",
  email: "security@example.test",
  role: "SECURITY_ADMIN",
  authorities: ["security:write", "report:approve", "report:review"],
};

export function addAmlDataset(spec: ReportDescriptorSpec): ReportDescriptorSpec {
  return {
    ...spec,
    datasets: [
      ...spec.datasets,
      {
        dataset_id: "aml_cases",
        description: "AML cases",
        from_model: "aml_cases",
        from_alias: "ac",
        joins: [],
        select: [
          { alias: "case_id", column: "id", expression: "COLUMN", format_hint: "RAW" },
          { alias: "severity", column: "severity", expression: "COLUMN", format_hint: "ENUM_TRANSLATED" },
        ],
        group_by: [],
        having: [],
        window_fields: [],
        order_by: [],
        limit: 10,
      },
    ],
  };
}

export function addGatewayDataset(spec: ReportDescriptorSpec): ReportDescriptorSpec {
  return {
    ...spec,
    datasets: [
      ...spec.datasets,
      {
        dataset_id: "gateway_versions",
        description: "Gateway versions",
        from_model: "gateway_versions",
        from_alias: "gv",
        joins: [],
        select: [{ alias: "version_id", column: "id", expression: "COLUMN", format_hint: "RAW" }],
        group_by: [],
        having: [],
        window_fields: [],
        order_by: [],
        limit: 10,
      },
    ],
  };
}
