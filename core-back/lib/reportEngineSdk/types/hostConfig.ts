/**
 * Host configuration for the decoupled Report Engine SDK.
 *
 * The SDK never imports Prisma models, route guards or the core application.
 * A host injects its catalog, read-only database line, authority matrix,
 * autocomplete providers and asset storage through this contract.
 */
export type ColumnSensitivity =
  | "PUBLIC"
  | "INTERNAL"
  | "CONFIDENTIAL_AML"
  | "PII_MASKED"
  | "FORBIDDEN_SECRET";

export interface CatalogColumnDef {
  name: string;
  dbColumnName: string;
  type: "uuid" | "string" | "int" | "bigint" | "decimal" | "boolean" | "datetime" | "json" | "enum";
  enumName?: string;
  nullable: boolean;
  indexed: boolean;
  sensitivity: ColumnSensitivity;
  description: string;
  /** Optional masking function applied if actor lacks unmask authority */
  redactionStrategy?: "HASH_PREFIX" | "MASK_MIDDLE" | "OMIT";
  /**
   * For a column exposed in minor units whose database column stores major
   * units (the core stores DECIMAL(18,4)), the SQL compiler multiplies by this
   * scale before aggregating (LYD: 1000 dirhams).
   */
  minorUnitScale?: number;
}

export interface CatalogRelationDef {
  name: string;
  targetModel: string;
  cardinality: "ONE_TO_ONE" | "MANY_TO_ONE" | "ONE_TO_MANY";
  /** First (or only) join column pair; kept for single-column consumers. */
  sourceKey: string;
  targetKey: string;
  /** Composite keys: every pair is ANDed in the join condition (includes the first pair). */
  keyPairs?: ReadonlyArray<{ sourceKey: string; targetKey: string }>;
}

export interface ModelOptimizationRule {
  /** Columns that MUST appear in a bounded WHERE clause (e.g., ["created_at"] on partitioned journal_lines) */
  mandatoryFilterColumns?: Array<{
    column: string;
    allowedOperators: ReadonlyArray<"between" | "gte_lte" | "eq" | "in">;
    maxDateRangeDays?: number;
    rationale: string;
    aiFixHint: string;
  }>;
  /** Disallows full-table GROUP BY without a selective indexed filter */
  requireIndexedFilter: boolean;
  /** Maximum rows a single dataset query on this model may scan or return */
  maxRowsReturned: number;
  /** Advisory hint injected into the AI Transcript */
  transcriptOptimizationNote: string;
}

export type CatalogDomain =
  | "LEDGER"
  | "PAYMENTS"
  | "MERCHANTS"
  | "COMPLIANCE_AML"
  | "GATEWAYS"
  | "RECONCILIATION"
  | "SECURITY_AUDIT"
  | "OPERATIONS";

export interface CatalogModelDef {
  modelName: string;
  tableName: string;
  domain: CatalogDomain;
  description: string;
  partitionedBy?: string;
  columns: Record<string, CatalogColumnDef>;
  relations: Record<string, CatalogRelationDef>;
  /** Authorities required to query this model (used by AuthorityInferenceEngine) */
  requiredAuthorities: readonly string[];
  /** Roles that naturally hold access to this model */
  naturalRoles: readonly string[];
  /** True if querying this model requires confidential AML clearance (MLRO / COMPLIANCE) */
  confidentialAmlOnly?: boolean;
  /** True if this model can be used in MERCHANT_FACING reports when filtered by merchant_id */
  merchantScopable?: {
    merchantIdColumn: string;
  };
  optimizationRule: ModelOptimizationRule;
}

export interface AutocompleteItem {
  value: string;
  label: string;
  sublabel?: string;
  badge?: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface AutocompleteProvider {
  sourceKey: string;
  description: string;
  valueType: "uuid" | "string";
  requiredAuthority: string;
  search: (params: {
    query: string;
    limit: number;
    actor: ReportActorContext;
    dependentValues?: Record<string, unknown>;
  }) => Promise<AutocompleteItem[]>;
}

export interface ReadOnlyQueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number;
  durationMs: number;
  /** "replica" | "primary-readonly-tx" (READ ONLY tx on the primary) | host-specific label. */
  servedBy: "replica" | "primary-readonly-tx" | (string & {});
  replicaLagMs?: number;
}

export interface ExplainPlanSummary {
  totalCost: number;
  planRows: number;
  hasSeqScanOnLargeTable: boolean;
  seqScanTables: string[];
  /** Per-node sequential scans (table, partition parent, estimated cost/rows). */
  seqScans?: Array<{
    table: string;
    parentTable: string | null;
    totalCost: number;
    planRows: number;
    /** True when the scanned table (or its partition parent) is a configured large table. */
    largeTable?: boolean;
  }>;
  partitionsScanned?: number;
  rawPlanJson: unknown;
}

export interface ReadOnlyDatabasePort {
  /** Executes a parameterized SELECT query strictly inside a READ ONLY transaction with statement_timeout */
  executeReadOnlyQuery<T = Record<string, unknown>>(params: {
    sql: string;
    values: unknown[];
    timeoutMs: number;
    maxRows: number;
    queryLabel: string;
  }): Promise<ReadOnlyQueryResult<T>>;

  /** Runs EXPLAIN (FORMAT JSON) inside a rolled-back READ ONLY transaction to verify cost & partition pruning */
  explainReadOnlyQuery(params: {
    sql: string;
    values: unknown[];
    timeoutMs: number;
  }): Promise<ExplainPlanSummary>;
}

export interface ReportAssetStoragePort {
  storeAssetBundle(params: {
    bundleId: string;
    files: Array<{
      relativePath: string;
      mimeType: string;
      sha256: string;
      buffer: Buffer;
    }>;
  }): Promise<{ bundleStorageKey: string; storageObjectId?: string }>;

  getAssetBuffer(params: {
    bundleId: string;
    relativePath: string;
  }): Promise<{ buffer: Buffer; mimeType: string; sha256: string } | null>;
}

export interface ReportActorContext {
  userId: string;
  email?: string | null;
  role: string;
  authorities: readonly string[];
  isMaker?: boolean;
  isChecker?: boolean;
}

export interface ReportEngineHostConfig {
  engineVersion: string;
  institutionName: string;
  defaultCurrency: string;
  defaultTimezone: string;
  supportedLocales: readonly string[];
  mandatoryDefaultLocales: readonly ["en", "ar"];
  models: Record<string, CatalogModelDef>;
  enums: Record<string, readonly string[]>;
  rolesCatalog: readonly string[];
  authoritiesCatalog: readonly string[];
  /** Role capability matrix mapping role -> incompatible domains or conflict rules */
  authorityConflictMatrix: Array<{
    domainA: CatalogModelDef["domain"];
    domainB: CatalogModelDef["domain"];
    conflictCode: string;
    description: string;
    resolutionHint: string;
  }>;
  securityOverrideAuthority: string; // e.g., "security:write"
  securityOverrideRoles: readonly string[]; // e.g., ["SECURITY_ADMIN"]
  /** Authorities that may see PII_MASKED values unmasked (default: security:write). */
  piiUnmaskAuthorities?: readonly string[];
  /** Minor-unit scale for the host default currency (LYD = 1000). */
  defaultCurrencyMinorUnitScale?: number;
  autocompleteProviders: Record<string, AutocompleteProvider>;
  dbReadOnlyPort: ReadOnlyDatabasePort;
  assetStoragePort: ReportAssetStoragePort;
  globalLimits: {
    maxDatasetsPerReport: number;
    maxJoinsPerDataset: number;
    maxRowsPerDataset: number;
    maxQueryTimeoutMs: number;
    maxExplainCost: number;
    maxAssetZipBytes: number;
    maxSingleAssetBytes: number;
    /** A seq scan on a large table above this estimated cost is a Layer 2 error (default 10_000). */
    maxSeqScanCost?: number;
  };
}
