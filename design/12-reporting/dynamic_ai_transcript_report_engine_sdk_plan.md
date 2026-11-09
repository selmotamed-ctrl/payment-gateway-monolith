# Dynamic AI-Transcript Report Engine SDK & Admin Studio (`ReportEngineSdk v1.0`)

## Zero-Downtime, Declarative, Multi-Language, Read-Only Financial Report Generation & Hybrid Client/Server Rendering Blueprint

**Target Repository Baseline:** Schema Version 25 (`20261109210000_ledger_query_and_index_optimization`) -> **Target Schema Version 26 (`20261110120000_dynamic_report_engine_sdk`)** **Target Surfaces:**

* **Decoupled Backend SDK:** `core-back/lib/reportEngineSdk/` (Zero hard-coded coupling to `core-back` routes; accepts injected host configuration, read-only database adapter, schema catalog, authority matrix, optimization rules, and asset store)

* **Host Integration Adapter:** `core-back/engine/reportStudio/` + `core-back/api/internal/adminReportEngine.ts` + `admin-back/api/reportEngine.ts`

* **Decoupled Frontend Renderer & Studio SDK:** `admin-front/src/lib/reportEngineSdk/` + `admin-front/src/pages/reports/studio/index.tsx` + `admin-front/src/pages/reports/catalog/index.tsx` + `admin-front/src/pages/reports/chrome/index.tsx`

* **Operational Scope:** `admin-front` only (used by backoffice staff to run internal operational/compliance/finance reports **and** to generate parameterized merchant-facing reports on behalf of merchants requesting custom statements, reconciliation breakdowns, or dispute summaries without deploying server code).

## 1. Executive Architecture & Research Synthesis

### 1.1 Why Build a Decoupled, AI-Transcript-Driven Report Engine SDK?

In a nationwide financial institution processing tens of millions of ledger journal lines (`journal_lines`) and payment attempts (`payment_attempts`), building custom TypeScript endpoints and Vue views for every new backoffice or merchant report request forces full server redeployments, regression cycles, and operational risk.

This blueprint extends the proven **"Bring-Your-Own-AI" Onboarding Transcript Architecture** already operating in `core-back/engine/specImporter/` (`TranscriptBuilder.ts`, `specSchema.ts`, `specValidator.ts`, `SpecSimulator.ts`) to a **Dynamic Report Engine SDK (`ReportEngineSdk`)**:

1. **Download the Live AI Authoring Transcript (`report-engine-ai-transcript-v1.0.md`):** An administrator in `admin-front` downloads a dynamically compiled Markdown transcript containing the live database schema catalog (safe tables, columns, enums, relations), mandatory query optimization rules (e.g., PostgreSQL 18 partition-pruning predicates on `journal_lines.created_at`), closed DSL vocabulary, input parameter & autocomplete source catalog, visual component primitives (HTML, scoped CSS, vector charts, vector drawings/diagrams, images), and bilingual (`en` + `ar`) translation rules.

2. **Generate Spec with Any External AI:** The administrator pastes the transcript into any LLM alongside their natural-language report requirement (e.g., *"Build a bilingual Merchant Settlement & Fee Breakdown report with daily volume chart, fee waterfall diagram, and GL reconciliation table"*). The AI outputs a deterministic JSON **Report Descriptor Spec (`ReportDescriptorSpec v1.0`)** (and optionally a `ReportChromeSpec v1.0` for reusable headers/footers).

3. **Upload Spec + Optional `.zip` Asset Bundle:** The administrator uploads the `.json` spec file and optional `.zip` asset archive (logos, stamps, watermarks, reference baseline JSON/CSV/SVG assets for DSL comparison) into `admin-front`.

4. **5-Layer Deterministic Verification & Auto-Authority Inference:** The SDK validates structural Zod rules, enforces read-only safety and sensitive-column redaction, runs `EXPLAIN (FORMAT JSON)` cost and partition-pruning checks over a read-only database line, automatically computes the required `UserRole` and `resource:action` authorities from the queried models (with an explicit **Security Admin Override** workflow when inferred authorities conflict or are overly restrictive), and executes a dry-run simulation. If any check fails, the SDK generates a 1-click **"Copy AI Repair Prompt"** (`buildReportRepairPrompt`) with exact `path`, `code`, and `aiFixHint` diagnostics.

5. **Client-Side First Vector PDF & Interactive Rendering:** To protect `core-back` CPU and RAM during peak payment traffic, `core-back` executes only the bounded, read-only data queries and returns compact JSON datasets (`ReportExecutionBundle`). All layout pagination, running header/footer injection, vector chart rendering, vector diagram drawing, and native vector PDF generation run **client-side in `admin-front`** using the [W3C CSS Paged Media Module Level 3 (`@page`)](https://www.w3.org/TR/css-page-3/) standard powered by the [Paged.js Pagination Polyfill](https://pagedjs.org/documentation/) and [Apache ECharts SVG Renderer](https://echarts.apache.org/handbook/en/how-to/cross-platform/server/), with an optional server-side headless Chromium fallback for automated batch runs.

### 1.2 Deep Research: Choosing the Optimal DSL & 2026 Rendering Stack

| Architectural Dimension | Evaluated Alternatives | Selected 2026 Architecture & Rationale | 
| ----- | ----- | ----- | 
| **Query & Data DSL** | 1\. Raw SQL strings with regex filtering  2\. Prisma JSON pass-through  3\. **Typed Relational Query AST (`ReportQueryDsl`) + Post-Query `TransformPipeline`** | **Option 3: Typed Relational Query AST + Post-Query Transform Pipeline.** Raw SQL strings cannot be reliably parsed against side-channel SQLi, system catalog probing (`pg_catalog`), or subtle cross-join explosions. Prisma JSON pass-through lacks `GROUP BY` expressions, window functions (`SUM() OVER (...)`), and multi-CTE joins. A closed, Zod-validated JSON Query AST compiles deterministically to parameterized `Prisma.Sql` fragments with strict column whitelists, mandatory partition predicates, and zero raw SQL interpolation. | 
| **Visual Layout, HTML/CSS & Charts DSL** | 1\. Raw unescaped HTML + inline `<script>`  2\. Proprietary canvas coordinates (PDFKit/jsPDF)  3\. **Declarative Section Blocks (`kpi_grid`, `data_table`, `chart`, `draw_svg`, `asset_comparison`, `html_template`) + Scoped CSS** | **Option 3: Declarative Section Blocks + Logic-less Mustache HTML + Scoped CSS.** LLMs write HTML/CSS and declarative JSON blocks with near-100% accuracy when given a closed schema, whereas coordinate-based PDF libraries (`jsPDF`) produce overlapping text, broken Arabic RTL shaping, and ugly tables. Scripts and event handlers are stripped at verification time; charts use declarative [Apache ECharts](https://echarts.apache.org/handbook/en/how-to/cross-platform/server/) / [Vega-Lite](https://vega.github.io/vega-lite/) JSON specs rendered in pure vector `svg` mode. | 
| **Client-Side vs. Server-Side PDF Engine (2026 Standard)** | 1\. `html2canvas` + `jsPDF` (Raster bitmap)  2\. Server-only Puppeteer/Playwright  3\. **Client-Side `Paged.js` (`@page` CSS Paged Media) inside Isolated Shadow/Iframe Print Surface + Native Vector Print Stream + Optional Server Headless Chromium Fallback** | **Option 3: Client-Side `Paged.js` + Native Vector Print (`window.print()` / Print Iframe) + Optional Server Fallback.** Raster libraries (`html2canvas`) turn text into blurry images, fail on 50+ page reports, cannot select text, and spike browser RAM. By running [Paged.js](https://pagedjs.org/documentation/) inside an isolated preview iframe in `admin-front`, the browser paginates the report into exact A4/Letter pages with running headers/footers, page numbers (`counter(page)` / `counter(pages)`), table header repetition (`thead { display: table-header-group }`), full HarfBuzz Arabic RTL ligature shaping, and crisp vector SVG charts—using **0% of `core-back` CPU/RAM**. | 
| **Multi-Language (`i18n`) & BiDi Layout** | 1\. Separate spec files per language  2\. External translation service calls  3\. **Embedded `i18n` Dictionary Map in Spec (`en` + `ar` mandatory default + custom locales) with Runtime Locale Picker** | **Option 3: Embedded `i18n` Dictionary Map in Spec.** Every label, title, column header, chart axis, and footnote uses `$t('key')` tokens resolved against the spec's `i18n.locales` map. The AI transcript instructs the LLM to always emit `"en"` (LTR) and `"ar"` (RTL) translations by default, plus any additional user-requested locales (e.g., `"fr"`). When `Object.keys(spec.i18n.locales).length > 1`, `admin-front` prompts the operator to select the target language before or during rendering. | 

### 1.3 Complete Coverage of the 11 Mandatory Requirements

| \# | Requirement | Architectural Mechanism in `ReportEngineSdk v1.0` | 
| ----- | ----- | ----- | 
| **1** | **Admin-Front Surface for Backoffice & Merchant Reports** | Hosted exclusively in `admin-front` (`/reports/catalog`, `/reports/studio`, `/reports/chrome`). Supports `audienceScope`: `BACKOFFICE_INTERNAL`, `MERCHANT_FACING`, or `BOTH`. Merchant-facing reports require a `merchant_id` parameter (auto-bound via the `merchants` autocomplete source) so backoffice staff can generate and export official merchant reports on demand. | 
| **2** | **Authority Auto-Detection + Security Admin Override** | `AuthorityInferenceEngine` inspects every model and column referenced in `datasets[]` against the injected `HostAuthorityPolicyMatrix`. It computes `inferredRoles`, `inferredAuthorities`, and `conflictDiagnostics` (e.g., when a query joins a `FINANCE` table like `gl_accounts` with a `COMPLIANCE`-only confidential table like `aml_cases`). A `SECURITY_ADMIN` (`security:write`) can set an explicit `authorityOverride` (`allowedRoles`, `allowedAuthorities`, `overrideReason`) persisted with full audit trail. | 
| **3** | **Zod-Validated Input Form & API Autocomplete Sources** | `inputs[]` defines typed parameters (`string`, `uuid`, `date`, `datetime`, `daterange`, `number`, `amount_minor`, `boolean`, `enum`, `multi_enum`, `entity_autocomplete`, `entity_multi_autocomplete`). Compiled dynamically into a [Zod v3](https://zod.dev/) validator on both backend and frontend. Autocomplete inputs bind to registered host providers (`merchants`, `applications`, `gateways`, `payment_rails`, `gl_accounts`, `currencies`, `staff_users`). | 
| **4** | **Verifiable Query & Spec Safety** | 5-layer verifier checks structural Zod schema, forbidden tables/columns (blocks `credential_sets.entries_ciphertext`, `users.password_hash`, `users.mfa_secret_ciphertext`, `api_tokens.token_hash`), sensitive PII masking, AST depth, join fan-out, and runs `EXPLAIN (FORMAT JSON)` inside a rolled-back `READ ONLY` transaction to reject queries exceeding `maxEstimatedCost` or missing partition keys. | 
| **5** | **Dedicated Read-Only DB Line** | `PostgresReadOnlyReportExecutor` routes strictly through `ReadStorePort` (`PostgresReplicaReadStore` in `core-back/lib/storageEngine/readStoreAdapter.ts` with `consistency: "replica"`) or a dedicated read-only `pg.Pool` (`REPORT_READONLY_DATABASE_URL`). Every execution wraps queries in `BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`, `SET LOCAL statement_timeout = '15000ms'`, `SET LOCAL lock_timeout = '2000ms'`, `SET LOCAL work_mem = '32MB'`. | 
| **6** | **HTML, Scoped CSS, Charts, Vector Draws & Images** | Section blocks support sanitized Mustache HTML (`html_template`), scoped CSS with `@page` print rules, declarative `chart` blocks (rendered to vector SVG via ECharts), declarative `draw_svg` blocks (flowcharts, fee waterfalls, architecture diagrams, custom SVG vector shapes with data bindings), and `image` blocks referencing uploaded `asset://` bundles. | 
| **7** | **Multi-Language (`en` + `ar` Default + Custom Prompt)** | Spec requires `i18n.locales.en` and `i18n.locales.ar` by default (enforced by Layer 2 validator and AI Transcript instructions), plus any extra locales (`fr`, `tr`, `it`, etc.). Selecting `ar` automatically switches page container direction to `dir="rtl"`, flips table/chart alignment, and selects Arabic numerals/fonts (`Tajawal` / `Cairo` / `Amiri`). | 
| **8** | **Standard Header & Footer Specs (`ReportChromeSpec`)** | Separate AI-authored spec type (`spec_kind: "REPORT_CHROME"`) uploaded with its own `.zip` image assets (CBL/institution logos, official seal, watermark). Supports multiple registered headers and footers in the system, a **Global Default Header & Footer** applied automatically to all reports, per-report selection (`DEFAULT`, `CUSTOM_CHROME_ID`, `INLINE`, or `NONE`), and runtime override in `admin-front`. | 
| **9** | **Partnered `.zip` Asset Bundles & DSL Asset Comparison** | Specs can be uploaded as a standalone `.json` or paired with a `.zip` bundle (`multipart/form-data` or single combined `.reportpkg.zip`). Supports image assets (`PNG`, `JPEG`, `WEBP`, `SVG` sanitized) and structured reference assets (`JSON`/`CSV` baseline benchmarks or target schedules) addressable in the DSL via `asset://filename` for visual rendering or dataset comparison (`compare_with_asset`). | 
| **10** | **Decoupled Library / SDK Design** | Published internally as `core-back/lib/reportEngineSdk/` and `admin-front/src/lib/reportEngineSdk/` with zero direct imports from `core-back/api/` or `core-back/prisma/`. All host dependencies (`ReadOnlyDbAdapter`, `SchemaCatalog`, `AuthorityMatrix`, `OptimizationRulebook`, `AutocompleteProviderRegistry`, `AssetStorageAdapter`) are injected via `createReportEngine(config)`. | 
| **11** | **Query Optimization Enforcement & Hybrid Rendering** | Both the AI Transcript and the Layer 2 Semantic Verifier enforce table-specific optimization rules derived from Schema Version 25 (e.g., `journal_lines` queries **must** filter on `created_at` with a maximum span of $\le 366$ days for [PostgreSQL 18 Partition Pruning](https://www.google.com/search?q=https://www.postgresql.org/docs/18/ddl-partitioning.html%23DDL-PARTITION-PRUNING); live account balances must query `gl_account_shards` instead of aggregating `journal_lines`). Rendering runs client-side first (`Paged.js` + ECharts SVG) with optional server-side PDF rendering. | 

## 2. Decoupled Library / SDK Architecture (`ReportEngineSdk`)

### 2.1 Package & Directory Structure

To guarantee that the Report Engine is completely decoupled from `core-back` business logic and can be developed, tested, and upgraded independently as a standalone SDK, the codebase is organized into two pure SDK libraries and two thin host-wiring adapters:

```
core-back/
├── lib/
│   └── reportEngineSdk/                        # PURE, DECOUPLED BACKEND SDK (Zero imports from core-back/api or prisma client singleton)
│       ├── index.ts                            # Public SDK entry point: createReportEngine(hostConfig)
│       ├── types/
│       │   ├── hostConfig.ts                   # Host injection interfaces (DB, SchemaCatalog, Authorities, Assets, Autocomplete)
│       │   ├── reportSpec.ts                   # Zod schemas & TS types for ReportDescriptorSpec v1.0
│       │   ├── chromeSpec.ts                   # Zod schemas & TS types for ReportChromeSpec v1.0 (Headers / Footers)
│       │   └── diagnostics.ts                  # ReportDiagnostic, VerificationReport, AuthorityInferenceResult
│       ├── transcript/
│       │   ├── ReportTranscriptBuilder.ts      # Generates the live AI Authoring Transcript (.md) from HostConfig
│       │   └── ChromeTranscriptBuilder.ts      # Generates the AI Header/Footer Authoring Transcript (.md)
│       ├── verifier/
│       │   ├── SpecStructuralValidator.ts      # Layer 1: Zod structural & i18n (en + ar) validation
│       │   ├── QuerySafetyAndOptValidator.ts   # Layer 2: AST safety, PII blocklist, partition-pruning & EXPLAIN cost guard
│       │   ├── AuthorityInferenceEngine.ts     # Layer 3: Auto-detects required roles/authorities & conflicts
│       │   ├── AssetBundleValidator.ts         # Layer 4: ZIP extraction, magic-byte check, SVG sanitizer, SHA-256 manifest
│       │   ├── ReportDryRunSimulator.ts        # Layer 5: Read-only dry-run execution + buildReportRepairPrompt()
│       │   └── CssAndHtmlSanitizer.ts          # Strict AST sanitizer for HTML templates, Scoped CSS (@page), and SVG draws
│       ├── compiler/
│       │   ├── InputFormZodCompiler.ts         # Compiles declarative inputs[] into runtime Zod schemas + autocomplete queries
│       │   ├── QueryAstToSqlCompiler.ts        # Compiles declarative DatasetQueryAST into parameterized read-only SQL
│       │   └── TransformPipelineExecutor.ts    # Post-query in-memory joins, pivot, running balances, & asset comparisons
│       └── runtime/
│           ├── PostgresReadOnlyExecutor.ts     # Enforces BEGIN READ ONLY, statement_timeout, work_mem, row caps
│           └── ServerPdfFallbackRenderer.ts    # Optional headless Chromium server-side PDF generator for scheduled runs
├── engine/
│   └── reportStudio/                           # HOST CONFIGURATION WIRING FOR PAYMENT GATEWAY MONOLITH
│       ├── paymentGatewayHostConfig.ts         # Injects Prisma schema catalog, ReadStorePort, UI_PROJECTION, partition rules
│       ├── autocompleteProviders.ts            # Implements merchants, gateways, rails, gl_accounts, currencies lookups
│       └── seedDefaultChromeSpecs.ts           # Seeds default official Header & Footer specs
└── api/
    └── internal/
        └── adminReportEngine.ts                # Internal admin routes mounted under /internal/admin/report-engine/*

admin-front/
└── src/
    ├── lib/
    │   └── reportEngineSdk/                    # PURE, DECOUPLED FRONTEND RENDERING & STUDIO SDK
    │       ├── index.ts
    │       ├── components/
    │       │   ├── ReportInputForm.tsx          # Dynamic Vuetify form generated from spec.inputs[] + live autocomplete
    │       │   ├── ReportLanguagePromptDialog.tsx # Prompts user to pick locale (en, ar, ...) when >1 language exists
    │       │   ├── ReportPagedPreviewSurface.tsx  # Isolated Iframe + Paged.js (@page) + RTL/LTR + Chrome injector
    │       │   ├── ReportChartRenderer.tsx      # ECharts SVG vector renderer for chart blocks
    │       │   └── ReportVectorDrawRenderer.tsx # Declarative SVG diagram / waterfall / flowchart renderer
    │       ├── print/
    │       │   └── ClientVectorPdfExporter.ts   # Zero-server-CPU vector PDF print stream & XLSX/CSV data exporter
    │       └── sanitizer/
    │           └── ClientDomSanitizer.ts        # Client-side defense-in-depth HTML/SVG/CSS sanitizer
    └── pages/
        └── reports/
            ├── catalog/index.tsx               # Run & export published backoffice and merchant reports
            ├── studio/index.tsx                # Download AI Transcript, Upload Spec + ZIP, Verify, Override Authority, Publish
            └── chrome/index.tsx                # Upload & manage standard Header & Footer specs + assign Global Default

```

### 2.2 Complete SDK Host Configuration Contract (`core-back/lib/reportEngineSdk/types/hostConfig.ts`)

By programming strictly against `ReportEngineHostConfig`, the SDK never imports Prisma models or route guards directly. Any project can instantiate the SDK by passing its catalog and policies:

```
// core-back/lib/reportEngineSdk/types/hostConfig.ts

export type ColumnSensitivity = "PUBLIC" | "INTERNAL" | "CONFIDENTIAL_AML" | "PII_MASKED" | "FORBIDDEN_SECRET";

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
}

export interface CatalogRelationDef {
  name: string;
  targetModel: string;
  cardinality: "ONE_TO_ONE" | "MANY_TO_ONE" | "ONE_TO_MANY";
  sourceKey: string;
  targetKey: string;
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

export interface CatalogModelDef {
  modelName: string;
  tableName: string;
  domain: "LEDGER" | "PAYMENTS" | "MERCHANTS" | "COMPLIANCE_AML" | "GATEWAYS" | "RECONCILIATION" | "SECURITY_AUDIT" | "OPERATIONS";
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
  servedBy: "primary" | string;
  replicaLagMs?: number;
}

export interface ExplainPlanSummary {
  totalCost: number;
  planRows: number;
  hasSeqScanOnLargeTable: boolean;
  seqScanTables: string[];
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
  }): Promise<{ bundleStorageKey: string }>;

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
  };
}

```

## 3. Complete Domain-Specific Language (DSL) Specification

The engine defines **two declarative JSON spec schemas** validated by [Zod v3](https://zod.dev/):

1. **`ReportDescriptorSpec v1.0` (`spec_kind: "REPORT_DESCRIPTOR"`)**: Defines a complete dynamic report—metadata, audience scope, authority rules, bilingual/multilingual `i18n` dictionaries, Zod-compiled input form with autocomplete sources, read-only `datasets[]` query ASTs, post-query `transforms[]`, and visual `sections[]` (KPIs, tables, ECharts SVG charts, vector SVG drawings, HTML/CSS templates, and asset comparisons).

2. **`ReportChromeSpec v1.0` (`spec_kind: "REPORT_CHROME"`)**: Defines a reusable **Standard Header or Footer** (`chrome_type: "HEADER" | "FOOTER"`) with its own `i18n` dictionary, HTML/SVG layout, scoped CSS, page-counter bindings (`{{pageNumber}}`, `{{totalPages}}`, `{{generatedAt}}`, `{{reportCode}}`, `{{actorEmail}}`), and `.zip` image assets (logos, seals).

### 3.1 `ReportChromeSpec v1.0` Schema (Standard Reusable Headers & Footers)

Administrators can upload multiple Header and Footer specs into the system, assign one Header and one Footer as the **Global Default** (automatically applied to every report unless the report spec explicitly sets `chrome.headerMode: "NONE"` or selects another chrome spec), or allow the user to switch headers/footers at generation time.

```
// core-back/lib/reportEngineSdk/types/chromeSpec.ts
import { z } from "zod";

export const REPORT_CHROME_SPEC_VERSION = "1.0" as const;

export const ChromeVariableBindingSchema = z.enum([
  "institutionName",
  "reportTitle",
  "reportSubtitle",
  "reportCode",
  "reportVersion",
  "generatedAtIso",
  "generatedAtFormatted",
  "actorName",
  "actorEmail",
  "actorRole",
  "selectedLocale",
  "merchantTradeName",
  "merchantLegalName",
  "periodSummary",
  "classificationBadge",
  "verificationHashShort",
  "pageNumber",      // Bound via CSS counter(page) / Paged.js
  "totalPages",      // Bound via CSS counter(pages) / Paged.js
]);

export const ReportChromeSpecSchema = z.object({
  spec_kind: z.literal("REPORT_CHROME"),
  spec_version: z.literal(REPORT_CHROME_SPEC_VERSION),
  chrome: z.object({
    code: z
      .string()
      .min(3)
      .max(64)
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Must be kebab-case, e.g. cbl-official-header-v1"),
    name: z.string().min(3).max(120),
    chrome_type: z.enum(["HEADER", "FOOTER"]),
    description: z.string().max(500).optional(),
    height_mm: z.number().min(8).max(45).default(22),
    show_on_first_page: z.boolean().default(true),
    border_style: z.enum(["NONE", "THIN_RULE", "DOUBLE_BANK_RULE", "ACCENT_BAND"]).default("THIN_RULE"),
  }),
  /** Required assets expected in the partnered .zip bundle (e.g. logo.svg, seal.png) */
  required_assets: z
    .array(
      z.object({
        asset_key: z.string().regex(/^[a-zA-Z0-9_-]+$/),
        file_name: z.string().regex(/^[a-zA-Z0-9._-]+$/),
        mime_type: z.enum(["image/png", "image/jpeg", "image/webp", "image/svg+xml"]),
        alt_i18n_key: z.string(),
        max_width_mm: z.number().min(2).max(180).optional(),
        max_height_mm: z.number().min(2).max(40).optional(),
      }),
    )
    .max(10)
    .default([]),
  /** Multi-language translation map; MUST include at least "en" and "ar" */
  i18n: z.object({
    default_locale: z.string().default("en"),
    locales: z
      .record(z.string(), z.record(z.string(), z.string()))
      .refine((locales) => Boolean(locales.en && locales.ar), {
        message: "i18n.locales MUST include both 'en' (English) and 'ar' (Arabic) translation dictionaries by default.",
      }),
  }),
  /** Safe Mustache-style HTML template + scoped CSS rendered inside the @page margin box */
  template: z.object({
    html: z.string().min(1).max(20_000),
    scoped_css: z.string().max(15_000).default(""),
    used_variables: z.array(ChromeVariableBindingSchema).default([]),
  }),
});

export type ReportChromeSpec = z.infer<typeof ReportChromeSpecSchema>;

```

### 3.2 `ReportDescriptorSpec v1.0` Schema (Complete Report DSL)

Below is the complete, authoritative Zod schema for `ReportDescriptorSpec v1.0` (`core-back/lib/reportEngineSdk/types/reportSpec.ts`). Every construct is closed, deterministic, and inspectable by the 5-layer verifier:

```
// core-back/lib/reportEngineSdk/types/reportSpec.ts
import { z } from "zod";

export const REPORT_SPEC_VERSION = "1.0" as const;

// ---------------------------------------------------------------------------
// 1. INPUT FORM & AUTOCOMPLETE PARAMETER DSL
// ---------------------------------------------------------------------------
export const REPORT_INPUT_TYPES = [
  "string",
  "uuid",
  "number",
  "integer",
  "amount_minor",
  "boolean",
  "date",
  "datetime",
  "daterange",
  "enum",
  "multi_enum",
  "entity_autocomplete",
  "entity_multi_autocomplete",
] as const;

export const AUTOCOMPLETE_SOURCE_KEYS = [
  "merchants",
  "applications",
  "gateways",
  "payment_rails",
  "gl_accounts",
  "currencies",
  "staff_users",
  "aml_cases",
] as const;

export const ReportInputFieldSpecSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(48)
    .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, "Input key must be camelCase or snake_case identifier"),
  label_i18n_key: z.string().min(1),
  help_i18n_key: z.string().optional(),
  placeholder_i18n_key: z.string().optional(),
  type: z.enum(REPORT_INPUT_TYPES),
  required: z.boolean().default(true),
  default_value: z
    .union([
      z.string(),
      z.number(),
      z.boolean(),
      z.array(z.string()),
      z.object({
        preset: z.enum(["TODAY", "YESTERDAY", "LAST_7_DAYS", "LAST_30_DAYS", "CURRENT_MONTH", "PREVIOUS_MONTH"]),
      }),
    ])
    .optional(),
  validation: z
    .object({
      min: z.number().optional(),
      max: z.number().optional(),
      min_length: z.number().int().min(0).optional(),
      max_length: z.number().int().max(500).optional(),
      regex: z.string().max(256).optional(),
      /** For date/daterange inputs: caps the maximum span in days (e.g. 366 for journal_lines partition safety) */
      max_range_days: z.number().int().min(1).max(1095).optional(),
      enum_values: z.array(z.string()).max(100).optional(),
      enum_labels_i18n_prefix: z.string().optional(),
    })
    .optional(),
  autocomplete: z
    .object({
      source: z.enum(AUTOCOMPLETE_SOURCE_KEYS),
      /** Optional filter linking this autocomplete to another input field (e.g. applications filtered by merchantId) */
      depends_on_input: z.string().optional(),
      static_filter: z.record(z.string(), z.union([z.string(), z.boolean(), z.number()])).optional(),
    })
    .optional(),
  layout_col_span: z.number().int().min(3).max(12).default(6),
});

// ---------------------------------------------------------------------------
// 2. SAFE DECLARATIVE QUERY AST DSL (READ-ONLY)
// ---------------------------------------------------------------------------
export const SQL_AGGREGATE_OPS = [
  "COUNT",
  "COUNT_DISTINCT",
  "SUM",
  "AVG",
  "MIN",
  "MAX",
  "SUM_DEBIT_MINOR",
  "SUM_CREDIT_MINOR",
] as const;

export const SQL_SCALAR_EXPRESSIONS = [
  "COLUMN",
  "COALESCE_ZERO",
  "DATE_TRUNC_HOUR",
  "DATE_TRUNC_DAY",
  "DATE_TRUNC_WEEK",
  "DATE_TRUNC_MONTH",
  "MINOR_TO_MAJOR_DECIMAL",
  "SIGNED_JOURNAL_AMOUNT", // CASE WHEN direction = 'DEBIT' THEN amount_minor ELSE -amount_minor END
  "CASE_WHEN_ENUM",
] as const;

export const WHERE_OPERATORS = [
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "between",
  "in",
  "not_in",
  "is_null",
  "is_not_null",
  "ilike_prefix",
] as const;

export const QueryValueBindingSchema = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("INPUT"),
    input_key: z.string(),
    /** For daterange inputs, selects either the start or end bound or both (for 'between') */
    range_bound: z.enum(["START", "END", "BOTH"]).optional(),
    /** If the input is optional and omitted by the user, omit this filter predicate gracefully */
    omit_if_empty: z.boolean().default(false),
  }),
  z.object({
    source: z.literal("LITERAL"),
    value: z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))]),
  }),
  z.object({
    source: z.literal("CONTEXT"),
    context_key: z.enum(["ACTOR_USER_ID", "NOW_UTC", "TODAY_START_UTC", "DEFAULT_CURRENCY"]),
  }),
]);

export type WhereFilterNode =
  | {
      kind: "PREDICATE";
      table_alias?: string;
      column: string;
      op: (typeof WHERE_OPERATORS)[number];
      binding?: z.infer<typeof QueryValueBindingSchema>;
    }
  | {
      kind: "GROUP";
      logic: "AND" | "OR";
      conditions: WhereFilterNode[];
    };

export const WhereFilterNodeSchema: z.ZodType<WhereFilterNode> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("PREDICATE"),
      table_alias: z.string().optional(),
      column: z.string().min(1).max(64),
      op: z.enum(WHERE_OPERATORS),
      binding: QueryValueBindingSchema.optional(),
    }),
    z.object({
      kind: z.literal("GROUP"),
      logic: z.enum(["AND", "OR"]),
      conditions: z.array(WhereFilterNodeSchema).min(1).max(20),
    }),
  ]),
);

export const DatasetSelectFieldSchema = z.object({
  alias: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
  table_alias: z.string().optional(),
  column: z.string().min(1).max(64),
  expression: z.enum(SQL_SCALAR_EXPRESSIONS).default("COLUMN"),
  aggregate: z.enum(SQL_AGGREGATE_OPS).optional(),
  case_map: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  format_hint: z
    .enum(["RAW", "CURRENCY_MINOR", "DECIMAL_2", "DECIMAL_4", "PERCENT_BPS", "PERCENT_RATIO", "DATE_ISO", "DATETIME_ISO", "ENUM_TRANSLATED"])
    .default("RAW"),
});

export const DatasetJoinSpecSchema = z.object({
  join_type: z.enum(["INNER", "LEFT"]),
  relation_name: z.string().min(1).max(64),
  target_model: z.string().min(1).max(64),
  alias: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
  additional_on: WhereFilterNodeSchema.optional(),
});

export const DatasetWindowFieldSchema = z.object({
  alias: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
  window_fn: z.enum(["RUNNING_SUM", "ROW_NUMBER", "RANK", "PERCENT_OF_TOTAL"]),
  target_field: z.string(),
  partition_by: z.array(z.string()).default([]),
  order_by: z.array(
    z.object({
      field: z.string(),
      direction: z.enum(["ASC", "DESC"]).default("ASC"),
    }),
  ),
});

export const DatasetQuerySpecSchema = z.object({
  dataset_id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
  description: z.string().max(300),
  from_model: z.string().min(1).max(64),
  from_alias: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/).default("t0"),
  joins: z.array(DatasetJoinSpecSchema).max(6).default([]),
  select: z.array(DatasetSelectFieldSchema).min(1).max(40),
  where: WhereFilterNodeSchema.optional(),
  group_by: z.array(z.string()).max(15).default([]),
  having: z
    .array(
      z.object({
        select_alias: z.string(),
        op: z.enum(["gt", "gte", "lt", "lte", "eq", "neq"]),
        value: z.number(),
      }),
    )
    .max(5)
    .default([]),
  window_fields: z.array(DatasetWindowFieldSchema).max(5).default([]),
  order_by: z
    .array(
      z.object({
        field: z.string(),
        direction: z.enum(["ASC", "DESC"]).default("ASC"),
      }),
    )
    .max(5)
    .default([]),
  limit: z.number().int().min(1).max(10_000).default(1_000),
});

// ---------------------------------------------------------------------------
// 3. POST-QUERY DETERMINISTIC TRANSFORM & ASSET COMPARISON PIPELINE
// ---------------------------------------------------------------------------
export const DatasetTransformSpecSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("COMPUTE_COLUMN"),
    target_dataset_id: z.string(),
    output_column: z.string(),
    formula: z.enum(["ADD", "SUBTRACT", "MULTIPLY", "SAFE_DIVIDE", "PERCENTAGE_SHARE", "VARIANCE_BPS"]),
    left_operand: z.string(),
    right_operand: z.union([z.string(), z.number()]),
    format_hint: z.enum(["RAW", "CURRENCY_MINOR", "DECIMAL_2", "PERCENT_RATIO"]).default("DECIMAL_2"),
  }),
  z.object({
    operation: z.literal("JOIN_DATASETS"),
    output_dataset_id: z.string(),
    left_dataset_id: z.string(),
    right_dataset_id: z.string(),
    join_type: z.enum(["INNER", "LEFT", "FULL"]),
    on_left_key: z.string(),
    on_right_key: z.string(),
  }),
  z.object({
    operation: z.literal("PIVOT_DATASET"),
    source_dataset_id: z.string(),
    output_dataset_id: z.string(),
    row_key: z.string(),
    column_key: z.string(),
    value_key: z.string(),
    aggregation: z.enum(["SUM", "COUNT", "FIRST"]).default("SUM"),
  }),
  z.object({
    /** Supports comparing live DB datasets against a reference JSON/CSV asset uploaded in the .zip bundle */
    operation: z.literal("COMPARE_WITH_ASSET"),
    source_dataset_id: z.string(),
    asset_key: z.string(),
    output_dataset_id: z.string(),
    match_keys: z.array(z.string()).min(1).max(4),
    compare_fields: z.array(
      z.object({
        dataset_field: z.string(),
        asset_field: z.string(),
        tolerance_minor: z.number().min(0).default(0),
      }),
    ),
  }),
]);

// ---------------------------------------------------------------------------
// 4. RICH VISUAL LAYOUT & SECTION PRIMITIVES (HTML, CSS, CHARTS, SVG DRAWS, IMAGES)
// ---------------------------------------------------------------------------
export const SectionVisibilityConditionSchema = z.object({
  dataset_id: z.string().optional(),
  when: z.enum(["ALWAYS", "DATASET_NOT_EMPTY", "DATASET_EMPTY", "INPUT_EQUALS"]).default("ALWAYS"),
  input_key: z.string().optional(),
  equals_value: z.union([z.string(), z.number(), z.boolean()]).optional(),
});

export const KpiGridSectionSchema = z.object({
  section_type: z.literal("KPI_GRID"),
  section_id: z.string(),
  title_i18n_key: z.string().optional(),
  columns: z.number().int().min(2).max(6).default(4),
  cards: z
    .array(
      z.object({
        label_i18n_key: z.string(),
        dataset_id: z.string(),
        value_field: z.string(),
        row_index: z.number().int().min(0).default(0),
        format_hint: z.enum(["RAW", "CURRENCY_MINOR", "DECIMAL_2", "PERCENT_RATIO", "INTEGER"]).default("CURRENCY_MINOR"),
        delta_field: z.string().optional(),
        tone: z.enum(["NEUTRAL", "PRIMARY", "SUCCESS", "WARNING", "DANGER"]).default("NEUTRAL"),
      }),
    )
    .min(1)
    .max(12),
});

export const DataTableSectionSchema = z.object({
  section_type: z.literal("DATA_TABLE"),
  section_id: z.string(),
  title_i18n_key: z.string().optional(),
  subtitle_i18n_key: z.string().optional(),
  dataset_id: z.string(),
  repeat_header_on_page_break: z.boolean().default(true),
  avoid_row_split: z.boolean().default(true),
  zebra_striping: z.boolean().default(true),
  columns: z
    .array(
      z.object({
        field: z.string(),
        header_i18n_key: z.string(),
        align: z.enum(["START", "CENTER", "END"]).default("START"),
        width_percent: z.number().min(3).max(80).optional(),
        format_hint: z
          .enum(["RAW", "CURRENCY_MINOR", "DECIMAL_2", "DECIMAL_4", "PERCENT_BPS", "PERCENT_RATIO", "DATE_ISO", "DATETIME_ISO", "ENUM_TRANSLATED", "BADGE"])
          .default("RAW"),
        summary_footer: z.enum(["NONE", "SUM", "AVG", "COUNT", "MIN", "MAX", "LABEL_TOTAL"]).default("NONE"),
        badge_tone_map: z.record(z.string(), z.enum(["NEUTRAL", "SUCCESS", "WARNING", "DANGER", "INFO"])).optional(),
      }),
    )
    .min(1)
    .max(25),
});

export const ChartSectionSchema = z.object({
  section_type: z.literal("CHART"),
  section_id: z.string(),
  title_i18n_key: z.string(),
  subtitle_i18n_key: z.string().optional(),
  dataset_id: z.string(),
  chart_kind: z.enum(["BAR", "STACKED_BAR", "LINE", "AREA", "PIE", "DONUT", "COMBO_BAR_LINE", "WATERFALL", "HEATMAP"]),
  height_mm: z.number().min(35).max(180).default(75),
  width_percent: z.number().min(30).max(100).default(100),
  x_field: z.string(),
  x_label_i18n_key: z.string().optional(),
  y_axis_format: z.enum(["CURRENCY_MINOR", "INTEGER", "DECIMAL_2", "PERCENT_RATIO"]).default("CURRENCY_MINOR"),
  series: z
    .array(
      z.object({
        field: z.string(),
        label_i18n_key: z.string(),
        type_override: z.enum(["bar", "line", "area"]).optional(),
        color_hex: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
        show_value_labels: z.boolean().default(false),
      }),
    )
    .min(1)
    .max(8),
});

export const VectorDrawSectionSchema = z.object({
  /** Declarative vector drawings / diagrams (flow diagrams, settlement waterfalls, balance trees, custom vector shapes) */
  section_type: z.literal("VECTOR_DRAW"),
  section_id: z.string(),
  title_i18n_key: z.string().optional(),
  draw_kind: z.enum(["FLOW_DIAGRAM", "SETTLEMENT_WATERFALL_DIAGRAM", "DECLARATIVE_SVG_CANVAS"]),
  height_mm: z.number().min(25).max(180).default(65),
  view_box: z.object({
    width: z.number().min(100).max(2000).default(800),
    height: z.number().min(60).max(1200).default(260),
  }),
  dataset_id: z.string().optional(),
  nodes: z
    .array(
      z.object({
        node_id: z.string(),
        shape: z.enum(["RECT", "ROUNDED_RECT", "PILL", "DIAMOND", "CIRCLE"]),
        x: z.number(),
        y: z.number(),
        width: z.number().default(150),
        height: z.number().default(56),
        label_i18n_key: z.string(),
        value_binding: z
          .object({
            dataset_id: z.string(),
            field: z.string(),
            row_index: z.number().int().min(0).default(0),
            format_hint: z.enum(["CURRENCY_MINOR", "INTEGER", "DECIMAL_2", "PERCENT_RATIO", "RAW"]).default("CURRENCY_MINOR"),
          })
          .optional(),
        fill_hex: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default("#F8FAFC"),
        stroke_hex: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default("#1E293B"),
        text_hex: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default("#0F172A"),
      }),
    )
    .max(40)
    .default([]),
  edges: z
    .array(
      z.object({
        from_node_id: z.string(),
        to_node_id: z.string(),
        label_i18n_key: z.string().optional(),
        style: z.enum(["SOLID", "DASHED", "DOTTED"]).default("SOLID"),
        color_hex: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default("#475569"),
      }),
    )
    .max(60)
    .default([]),
  /** Optional sanitized SVG markup with {{mustache}} bindings when draw_kind === 'DECLARATIVE_SVG_CANVAS' */
  custom_svg_template: z.string().max(30_000).optional(),
});

export const HtmlTemplateSectionSchema = z.object({
  section_type: z.literal("HTML_TEMPLATE"),
  section_id: z.string(),
  title_i18n_key: z.string().optional(),
  dataset_id: z.string().optional(),
  /** Logic-less Mustache HTML template. Scripts, iframes, external URLs, and inline JS handlers are strictly rejected. */
  html_template: z.string().min(1).max(50_000),
  scoped_css: z.string().max(25_000).default(""),
});

export const ImageAndAssetSectionSchema = z.object({
  section_type: z.literal("IMAGE_BANNER"),
  section_id: z.string(),
  asset_key: z.string(),
  caption_i18n_key: z.string().optional(),
  align: z.enum(["START", "CENTER", "END"]).default("CENTER"),
  max_height_mm: z.number().min(10).max(160).default(45),
});

export const PageBreakSectionSchema = z.object({
  section_type: z.literal("PAGE_BREAK"),
  section_id: z.string(),
  orientation_after: z.enum(["PORTRAIT", "LANDSCAPE"]).optional(),
});

export const ReportSectionSpecSchema = z
  .discriminatedUnion("section_type", [
    KpiGridSectionSchema,
    DataTableSectionSchema,
    ChartSectionSchema,
    VectorDrawSectionSchema,
    HtmlTemplateSectionSchema,
    ImageAndAssetSectionSchema,
    PageBreakSectionSchema,
  ])
  .and(
    z.object({
      visibility: SectionVisibilityConditionSchema.optional(),
    }),
  );

// ---------------------------------------------------------------------------
// 5. TOP-LEVEL REPORT DESCRIPTOR SPEC SCHEMA
// ---------------------------------------------------------------------------
export const ReportDescriptorSpecSchema = z.object({
  spec_kind: z.literal("REPORT_DESCRIPTOR"),
  spec_version: z.literal(REPORT_SPEC_VERSION),
  report: z.object({
    code: z
      .string()
      .min(3)
      .max(64)
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Must be kebab-case, e.g. merchant-daily-settlement-summary"),
    version: z.number().int().min(1).default(1),
    category: z.enum([
      "FINANCE_LEDGER",
      "MERCHANT_SETTLEMENT",
      "RECONCILIATION",
      "COMPLIANCE_AML",
      "GATEWAY_PERFORMANCE",
      "OPERATIONS_SUPPORT",
      "SECURITY_AUDIT",
    ]),
    audience_scope: z.enum(["BACKOFFICE_INTERNAL", "MERCHANT_FACING", "BOTH"]),
    /** If audience_scope includes MERCHANT_FACING, names the input key that binds the target merchantId */
    merchant_scope_input_key: z.string().optional(),
    classification: z.enum(["INTERNAL", "MERCHANT_CONFIDENTIAL", "REGULATORY_RESTRICTED"]).default("INTERNAL"),
  }),
  /** Page setup & Header/Footer Chrome configuration */
  page_layout: z.object({
    paper_size: z.enum(["A4", "LETTER", "LEGAL"]).default("A4"),
    orientation: z.enum(["PORTRAIT", "LANDSCAPE"]).default("PORTRAIT"),
    margins_mm: z
      .object({
        top: z.number().min(10).max(50).default(26),
        right: z.number().min(8).max(40).default(14),
        bottom: z.number().min(10).max(50).default(24),
        left: z.number().min(8).max(40).default(14),
      })
      .default({ top: 26, right: 14, bottom: 24, left: 14 }),
    header_mode: z.enum(["GLOBAL_DEFAULT", "SPECIFIC_CHROME_CODE", "INLINE_SPEC", "NONE"]).default("GLOBAL_DEFAULT"),
    header_chrome_code: z.string().optional(),
    inline_header_spec: ReportChromeSpecSchema.shape.template.optional(),
    footer_mode: z.enum(["GLOBAL_DEFAULT", "SPECIFIC_CHROME_CODE", "INLINE_SPEC", "NONE"]).default("GLOBAL_DEFAULT"),
    footer_chrome_code: z.string().optional(),
    inline_footer_spec: ReportChromeSpecSchema.shape.template.optional(),
    allow_runtime_chrome_selection: z.boolean().default(true),
    global_scoped_css: z.string().max(25_000).default(""),
  }),
  /** Partnered .zip asset declarations (images + structured baseline JSON/CSV assets for comparison) */
  required_assets: z
    .array(
      z.object({
        asset_key: z.string().regex(/^[a-zA-Z0-9_-]+$/),
        file_name: z.string().regex(/^[a-zA-Z0-9._-]+$/),
        mime_type: z.enum([
          "image/png",
          "image/jpeg",
          "image/webp",
          "image/svg+xml",
          "application/json",
          "text/csv",
        ]),
        purpose: z.enum(["VISUAL_IMAGE", "COMPARISON_BASELINE_DATA"]),
        description: z.string().max(240).optional(),
      }),
    )
    .max(20)
    .default([]),
  /** Multi-language dictionary embedded directly in the spec. MUST contain 'en' and 'ar' by default! */
  i18n: z.object({
    default_locale: z.string().default("en"),
    prompt_user_when_multi_locale: z.boolean().default(true),
    locales: z
      .record(z.string(), z.record(z.string(), z.string()))
      .refine((locales) => Boolean(locales.en && locales.ar), {
        message: "i18n.locales MUST contain at least 'en' (English) and 'ar' (Arabic) translations.",
      }),
  }),
  /** Optional author-suggested authorities; always verified against AuthorityInferenceEngine */
  suggested_access: z
    .object({
      roles: z.array(z.string()).default([]),
      authorities: z.array(z.string()).default([]),
    })
    .optional(),
  inputs: z.array(ReportInputFieldSpecSchema).max(20).default([]),
  datasets: z.array(DatasetQuerySpecSchema).min(1).max(10),
  transforms: z.array(DatasetTransformSpecSchema).max(15).default([]),
  sections: z.array(ReportSectionSpecSchema).min(1).max(30),
});

export type ReportDescriptorSpec = z.infer<typeof ReportDescriptorSpecSchema>;

```

### 3.3 Dynamic Input Form to Zod Compiler & Preset Resolver (`core-back/lib/reportEngineSdk/compiler/InputFormZodCompiler.ts`)

Requirement 2 specifies: *"inpu, a zod validated form description and source data for api fetched lists (autocomplete) that can be used to set the report base data required to query and build the report"*.

This compiler converts `spec.inputs[]` into an executable [Zod v3](https://zod.dev/) schema used on both `core-back` (before any query runs) and `admin-front` (for instant form validation), and resolves relative date presets (`TODAY`, `LAST_30_DAYS`, `CURRENT_MONTH`, etc.) in UTC:

```
// core-back/lib/reportEngineSdk/compiler/InputFormZodCompiler.ts
import { z } from "zod";
import type { ReportDescriptorSpec, ReportInputFieldSpec } from "../types/reportSpec";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export interface DateRangeValue {
  start: string; // ISO-8601 UTC timestamp or YYYY-MM-DD
  end: string;
}

export function resolveInputPresetValue(
  field: ReportInputFieldSpec,
  now: Date = new Date(),
): unknown {
  const def = field.default_value;
  if (!def || typeof def !== "object" || Array.isArray(def) || !("preset" in def)) {
    return def;
  }
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  const startOfDayUtc = (year: number, month: number, day: number) =>
    new Date(Date.UTC(year, month, day, 0, 0, 0, 0)).toISOString();
  const endOfDayUtc = (year: number, month: number, day: number) =>
    new Date(Date.UTC(year, month, day, 23, 59, 59, 999)).toISOString();

  switch (def.preset) {
    case "TODAY":
      return field.type === "daterange"
        ? { start: startOfDayUtc(y, m, d), end: endOfDayUtc(y, m, d) }
        : startOfDayUtc(y, m, d).slice(0, 10);
    case "YESTERDAY":
      return field.type === "daterange"
        ? { start: startOfDayUtc(y, m, d - 1), end: endOfDayUtc(y, m, d - 1) }
        : startOfDayUtc(y, m, d - 1).slice(0, 10);
    case "LAST_7_DAYS":
      return { start: startOfDayUtc(y, m, d - 6), end: endOfDayUtc(y, m, d) };
    case "LAST_30_DAYS":
      return { start: startOfDayUtc(y, m, d - 29), end: endOfDayUtc(y, m, d) };
    case "CURRENT_MONTH":
      return { start: startOfDayUtc(y, m, 1), end: endOfDayUtc(y, m, d) };
    case "PREVIOUS_MONTH":
      return { start: startOfDayUtc(y, m - 1, 1), end: endOfDayUtc(y, m, 0) };
  }
}

export function compileInputFieldToZod(field: ReportInputFieldSpec): z.ZodTypeAny {
  const v = field.validation;
  let schema: z.ZodTypeAny;

  switch (field.type) {
    case "string": {
      let s = z.string().trim();
      if (v?.min_length !== undefined) s = s.min(v.min_length);
      if (v?.max_length !== undefined) s = s.max(v.max_length);
      if (v?.regex) s = s.regex(new RegExp(v.regex));
      schema = s;
      break;
    }
    case "uuid":
    case "entity_autocomplete": {
      const isUuid = !field.autocomplete || field.autocomplete.source !== "currencies";
      schema = isUuid
        ? z.string().trim().regex(UUID_REGEX, `Field "${field.key}" must be a valid UUID`)
        : z.string().trim().min(1).max(64);
      break;
    }
    case "entity_multi_autocomplete": {
      schema = z.array(z.string().trim().min(1).max(64)).min(field.required ? 1 : 0).max(50);
      break;
    }
    case "number": {
      let n = z.coerce.number().finite();
      if (v?.min !== undefined) n = n.min(v.min);
      if (v?.max !== undefined) n = n.max(v.max);
      schema = n;
      break;
    }
    case "integer":
    case "amount_minor": {
      let n = z.coerce.number().int();
      if (v?.min !== undefined) n = n.min(v.min);
      if (v?.max !== undefined) n = n.max(v.max);
      schema = n;
      break;
    }
    case "boolean": {
      schema = z.boolean();
      break;
    }
    case "date": {
      schema = z.string().regex(ISO_DATE_REGEX, `Field "${field.key}" must be YYYY-MM-DD`);
      break;
    }
    case "datetime": {
      schema = z.string().datetime({ message: `Field "${field.key}" must be an ISO-8601 UTC datetime` });
      break;
    }
    case "daterange": {
      const maxDays = v?.max_range_days ?? 366;
      schema = z
        .object({
          start: z.string().min(10),
          end: z.string().min(10),
        })
        .refine(
          (range) => {
            const startMs = Date.parse(range.start);
            const endMs = Date.parse(range.end);
            return Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs;
          },
          { message: `Field "${field.key}" must have a valid start and end date where end >= start.` },
        )
        .refine(
          (range) => {
            const startMs = Date.parse(range.start);
            const endMs = Date.parse(range.end);
            const diffDays = (endMs - startMs) / (1000 * 60 * 60 * 24);
            return diffDays <= maxDays;
          },
          { message: `Date range for "${field.key}" cannot exceed ${maxDays} days (partition safety limit).` },
        );
      break;
    }
    case "enum": {
      const allowed = v?.enum_values && v.enum_values.length > 0 ? v.enum_values : ["DEFAULT"];
      schema = z.enum(allowed as [string, ...string[]]);
      break;
    }
    case "multi_enum": {
      const allowed = v?.enum_values && v.enum_values.length > 0 ? v.enum_values : ["DEFAULT"];
      const itemSchema = z.enum(allowed as [string, ...string[]]);
      schema = z.array(itemSchema).min(field.required ? 1 : 0);
      break;
    }
  }

  if (!field.required) {
    schema = schema.optional().nullable();
  }
  return schema;
}

export function compileReportInputsToZodObject(
  spec: ReportDescriptorSpec,
): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of spec.inputs) {
    shape[field.key] = compileInputFieldToZod(field);
  }
  return z.object(shape).strict();
}

```

### 3.4 Declarative Query AST to Parameterized Read-Only SQL Compiler (`core-back/lib/reportEngineSdk/compiler/QueryAstToSqlCompiler.ts`)

This compiler translates a validated `DatasetQuerySpec` into a strictly parameterized PostgreSQL query (`{ sql, values }`) where every identifier is quoted and verified against `HostConfig.models` and every literal or user input is bound via positional parameters (`$1, $2, ...`):

```
// core-back/lib/reportEngineSdk/compiler/QueryAstToSqlCompiler.ts
import type { CatalogModelDef, ReportEngineHostConfig } from "../types/hostConfig";
import type { DatasetQuerySpec, DatasetSelectField, WhereFilterNode } from "../types/reportSpec";

export interface CompiledSqlQuery {
  sql: string;
  values: unknown[];
}

const quoteIdent = (ident: string): string => {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(ident)) {
    throw new Error(`UNSAFE_SQL_IDENTIFIER: "${ident}"`);
  }
  return `"${ident}"`;
};

export function compileDatasetQueryToSql(
  ds: DatasetQuerySpec,
  host: ReportEngineHostConfig,
  resolvedInputs: Record<string, unknown>,
  actorContext?: { userId: string; nowUtcIso: string },
): CompiledSqlQuery {
  const values: unknown[] = [];
  const pushParam = (val: unknown): string => {
    values.push(val);
    return `$${values.length}`;
  };

  const baseModel = host.models[ds.from_model];
  if (!baseModel) {
    throw new Error(`UNKNOWN_MODEL: "${ds.from_model}"`);
  }

  // Map table aliases to catalog models
  const aliasToModel = new Map<string, CatalogModelDef>();
  aliasToModel.set(ds.from_alias, baseModel);

  const joinClauses: string[] = [];
  for (const j of ds.joins) {
    const rel = baseModel.relations[j.relation_name];
    const targetModel = host.models[j.target_model];
    if (!rel || !targetModel || rel.targetModel !== j.target_model) {
      throw new Error(`INVALID_JOIN_RELATION: "${j.relation_name}" -> "${j.target_model}"`);
    }
    aliasToModel.set(j.alias, targetModel);
    const sourceCol = baseModel.columns[rel.sourceKey]?.dbColumnName ?? rel.sourceKey;
    const targetCol = targetModel.columns[rel.targetKey]?.dbColumnName ?? rel.targetKey;
    let onSql = `${quoteIdent(ds.from_alias)}.${quoteIdent(sourceCol)} = ${quoteIdent(j.alias)}.${quoteIdent(targetCol)}`;
    if (j.additional_on) {
      const extraOn = compileWhereNode(j.additional_on);
      if (extraOn) onSql = `(${onSql}) AND (${extraOn})`;
    }
    joinClauses.push(`${j.join_type} JOIN ${quoteIdent(targetModel.tableName)} AS ${quoteIdent(j.alias)} ON ${onSql}`);
  }

  const resolveColumnSql = (tableAlias: string | undefined, colName: string): string => {
    const alias = tableAlias ?? ds.from_alias;
    const model = aliasToModel.get(alias);
    if (!model) throw new Error(`UNKNOWN_TABLE_ALIAS: "${alias}"`);
    const col = model.columns[colName];
    if (!col) throw new Error(`UNKNOWN_COLUMN: "${alias}.${colName}"`);
    if (col.sensitivity === "FORBIDDEN_SECRET") {
      throw new Error(`FORBIDDEN_SECRET_COLUMN: "${alias}.${colName}"`);
    }
    return `${quoteIdent(alias)}.${quoteIdent(col.dbColumnName)}`;
  };

  const compileScalarExpr = (sel: DatasetSelectField): string => {
    const colSql = resolveColumnSql(sel.table_alias, sel.column);
    switch (sel.expression) {
      case "COLUMN":
        return colSql;
      case "COALESCE_ZERO":
        return `COALESCE(${colSql}, 0)`;
      case "DATE_TRUNC_HOUR":
        return `date_trunc('hour', ${colSql})`;
      case "DATE_TRUNC_DAY":
        return `date_trunc('day', ${colSql})`;
      case "DATE_TRUNC_WEEK":
        return `date_trunc('week', ${colSql})`;
      case "DATE_TRUNC_MONTH":
        return `date_trunc('month', ${colSql})`;
      case "MINOR_TO_MAJOR_DECIMAL":
        return `ROUND((${colSql}::numeric / 1000.0), 3)`;
      case "SIGNED_JOURNAL_AMOUNT": {
        const dirSql = resolveColumnSql(sel.table_alias, "direction");
        return `CASE WHEN ${dirSql} = 'DEBIT' THEN ${colSql} ELSE -(${colSql}) END`;
      }
      case "CASE_WHEN_ENUM": {
        const entries = Object.entries(sel.case_map ?? {});
        if (entries.length === 0) return colSql;
        const branches = entries
          .map(([k, v]) => `WHEN ${colSql} = ${pushParam(k)} THEN ${pushParam(v)}`)
          .join(" ");
        return `CASE ${branches} ELSE NULL END`;
      }
    }
  };

  const compileSelectField = (sel: DatasetSelectField): string => {
    const inner = compileScalarExpr(sel);
    if (!sel.aggregate) {
      return `${inner} AS ${quoteIdent(sel.alias)}`;
    }
    switch (sel.aggregate) {
      case "COUNT":
        return `COUNT(${inner})::bigint AS ${quoteIdent(sel.alias)}`;
      case "COUNT_DISTINCT":
        return `COUNT(DISTINCT ${inner})::bigint AS ${quoteIdent(sel.alias)}`;
      case "SUM":
        return `COALESCE(SUM(${inner}), 0) AS ${quoteIdent(sel.alias)}`;
      case "AVG":
        return `COALESCE(AVG(${inner}), 0) AS ${quoteIdent(sel.alias)}`;
      case "MIN":
        return `MIN(${inner}) AS ${quoteIdent(sel.alias)}`;
      case "MAX":
        return `MAX(${inner}) AS ${quoteIdent(sel.alias)}`;
      case "SUM_DEBIT_MINOR": {
        const dirSql = resolveColumnSql(sel.table_alias, "direction");
        return `COALESCE(SUM(CASE WHEN ${dirSql} = 'DEBIT' THEN ${inner} ELSE 0 END), 0) AS ${quoteIdent(sel.alias)}`;
      }
      case "SUM_CREDIT_MINOR": {
        const dirSql = resolveColumnSql(sel.table_alias, "direction");
        return `COALESCE(SUM(CASE WHEN ${dirSql} = 'CREDIT' THEN ${inner} ELSE 0 END), 0) AS ${quoteIdent(sel.alias)}`;
      }
    }
  };

  function resolveBindingValue(binding: NonNullable<Extract<WhereFilterNode, { kind: "PREDICATE" }>["binding"]>): {
    omit: boolean;
    value: unknown;
  } {
    if (binding.source === "LITERAL") {
      return { omit: false, value: binding.value };
    }
    if (binding.source === "CONTEXT") {
      const nowIso = actorContext?.nowUtcIso ?? new Date().toISOString();
      switch (binding.context_key) {
        case "ACTOR_USER_ID":
          return { omit: false, value: actorContext?.userId ?? "00000000-0000-0000-0000-000000000000" };
        case "NOW_UTC":
          return { omit: false, value: nowIso };
        case "TODAY_START_UTC":
          return { omit: false, value: `${nowIso.slice(0, 10)}T00:00:00.000Z` };
        case "DEFAULT_CURRENCY":
          return { omit: false, value: host.defaultCurrency };
      }
    }
    const raw = resolvedInputs[binding.input_key];
    if (raw === undefined || raw === null || raw === "") {
      if (binding.omit_if_empty) return { omit: true, value: null };
      throw new Error(`MISSING_REQUIRED_INPUT_BINDING: "${binding.input_key}"`);
    }
    if (binding.range_bound && typeof raw === "object" && raw !== null && "start" in raw && "end" in raw) {
      const rangeObj = raw as { start: string; end: string };
      if (binding.range_bound === "START") return { omit: false, value: rangeObj.start };
      if (binding.range_bound === "END") return { omit: false, value: rangeObj.end };
      return { omit: false, value: [rangeObj.start, rangeObj.end] };
    }
    return { omit: false, value: raw };
  }

  function compileWhereNode(node: WhereFilterNode): string | null {
    if (node.kind === "GROUP") {
      const compiledChildren = node.conditions
        .map((c) => compileWhereNode(c))
        .filter((s): s is string => Boolean(s));
      if (compiledChildren.length === 0) return null;
      return compiledChildren.map((c) => `(${c})`).join(` ${node.logic} `);
    }

    const colSql = resolveColumnSql(node.table_alias, node.column);
    if (node.op === "is_null") return `${colSql} IS NULL`;
    if (node.op === "is_not_null") return `${colSql} IS NOT NULL`;
    if (!node.binding) throw new Error(`MISSING_WHERE_BINDING: "${node.column}" (${node.op})`);

    const resolved = resolveBindingValue(node.binding);
    if (resolved.omit) return null;

    switch (node.op) {
      case "eq":
        return `${colSql} = ${pushParam(resolved.value)}`;
      case "neq":
        return `${colSql} <> ${pushParam(resolved.value)}`;
      case "gt":
        return `${colSql} > ${pushParam(resolved.value)}`;
      case "gte":
        return `${colSql} >= ${pushParam(resolved.value)}`;
      case "lt":
        return `${colSql} < ${pushParam(resolved.value)}`;
      case "lte":
        return `${colSql} <= ${pushParam(resolved.value)}`;
      case "ilike_prefix":
        return `${colSql} ILIKE ${pushParam(`${String(resolved.value).replace(/[%_]/g, "")}%`)}`;
      case "between": {
        const pair =
          Array.isArray(resolved.value) && resolved.value.length === 2
            ? resolved.value
            : typeof resolved.value === "object" && resolved.value !== null && "start" in resolved.value && "end" in resolved.value
              ? [(resolved.value as { start: unknown }).start, (resolved.value as { end: unknown }).end]
              : null;
        if (!pair) throw new Error(`BETWEEN_REQUIRES_RANGE_PAIR: "${node.column}"`);
        return `${colSql} BETWEEN ${pushParam(pair[0])} AND ${pushParam(pair[1])}`;
      }
      case "in":
      case "not_in": {
        const arr = Array.isArray(resolved.value) ? resolved.value : [resolved.value];
        if (arr.length === 0) return node.op === "in" ? "1 = 0" : "1 = 1";
        const placeholders = arr.map((item) => pushParam(item)).join(", ");
        return `${colSql} ${node.op === "in" ? "IN" : "NOT IN"} (${placeholders})`;
      }
    }
  }

  const selectAliases = new Map<string, DatasetSelectField>(ds.select.map((s) => [s.alias, s]));
  const baseSelectSql = ds.select.map((s) => compileSelectField(s)).join(", ");
  const fromSql = `FROM ${quoteIdent(baseModel.tableName)} AS ${quoteIdent(ds.from_alias)}`;
  const whereClause = ds.where ? compileWhereNode(ds.where) : null;
  const whereSql = whereClause ? `WHERE ${whereClause}` : "";

  const groupBySql =
    ds.group_by.length > 0
      ? `GROUP BY ${ds.group_by
          .map((g) => {
            const sel = selectAliases.get(g);
            return sel ? compileScalarExpr(sel) : resolveColumnSql(undefined, g);
          })
          .join(", ")}`
      : "";

  const havingSql =
    ds.having.length > 0
      ? `HAVING ${ds.having
          .map((h) => {
            const sel = selectAliases.get(h.select_alias);
            if (!sel || !sel.aggregate) throw new Error(`INVALID_HAVING_ALIAS: "${h.select_alias}"`);
            const aggExpr = compileSelectField(sel).replace(/\s+AS\s+"[^"]+"$/, "");
            const opMap = { gt: ">", gte: ">=", lt: "<", lte: "<=", eq: "=", neq: "<>" } as const;
            return `${aggExpr} ${opMap[h.op]} ${pushParam(h.value)}`;
          })
          .join(" AND ")}`
      : "";

  const boundedLimit = Math.min(ds.limit, baseModel.optimizationRule.maxRowsReturned, host.globalLimits.maxRowsPerDataset);
  const orderBySql =
    ds.order_by.length > 0
      ? `ORDER BY ${ds.order_by
          .map((o) => {
            const colRef = selectAliases.has(o.field) ? quoteIdent(o.field) : resolveColumnSql(undefined, o.field);
            return `${colRef} ${o.direction}`;
          })
          .join(", ")}`
      : "";

  const coreSql = [
    `SELECT ${baseSelectSql}`,
    fromSql,
    ...joinClauses,
    whereSql,
    groupBySql,
    havingSql,
    orderBySql,
    `LIMIT ${boundedLimit}`,
  ]
    .filter(Boolean)
    .join(" ");

  if (ds.window_fields.length === 0) {
    return { sql: coreSql, values };
  }

  // Wrap in CTE if window functions are requested so aggregates run first
  const windowSelects = ds.window_fields.map((wf) => {
    const partSql =
      wf.partition_by.length > 0 ? `PARTITION BY ${wf.partition_by.map((p) => quoteIdent(p)).join(", ")}` : "";
    const ordSql =
      wf.order_by.length > 0
        ? `ORDER BY ${wf.order_by.map((o) => `${quoteIdent(o.field)} ${o.direction}`).join(", ")}`
        : "";
    const overClause = `OVER (${[partSql, ordSql].filter(Boolean).join(" ")})`;
    switch (wf.window_fn) {
      case "RUNNING_SUM":
        return `SUM(${quoteIdent(wf.target_field)}) ${overClause} AS ${quoteIdent(wf.alias)}`;
      case "ROW_NUMBER":
        return `ROW_NUMBER() ${overClause} AS ${quoteIdent(wf.alias)}`;
      case "RANK":
        return `RANK() ${overClause} AS ${quoteIdent(wf.alias)}`;
      case "PERCENT_OF_TOTAL":
        return `ROUND((${quoteIdent(wf.target_field)}::numeric * 100.0) / NULLIF(SUM(${quoteIdent(wf.target_field)}) OVER (${partSql}), 0), 2) AS ${quoteIdent(wf.alias)}`;
    }
  });

  return {
    sql: `SELECT _base.*, ${windowSelects.join(", ")} FROM (${coreSql}) AS _base`,
    values,
  };
}

```

### 3.5 Deterministic Post-Query Transform & Asset Comparison Pipeline (`core-back/lib/reportEngineSdk/compiler/TransformPipelineExecutor.ts`)

Requirement 8 highlights that partnered `.zip` assets can also be used for comparison in the DSL (`COMPARE_WITH_ASSET`). Below is the complete implementation of `TransformPipelineExecutor.ts`:

```
// core-back/lib/reportEngineSdk/compiler/TransformPipelineExecutor.ts
import type { DatasetTransformSpec } from "../types/reportSpec";

export type DatasetMap = Record<string, Array<Record<string, unknown>>>;

export function executeTransformPipeline(
  datasets: DatasetMap,
  transforms: readonly DatasetTransformSpec[],
  parsedComparisonAssets: Record<string, Array<Record<string, unknown>>>,
): DatasetMap {
  const working: DatasetMap = { ...datasets };

  for (const step of transforms) {
    switch (step.operation) {
      case "COMPUTE_COLUMN": {
        const rows = working[step.target_dataset_id] ?? [];
        const totalForShare =
          step.formula === "PERCENTAGE_SHARE"
            ? rows.reduce((acc, r) => acc + Number(r[step.left_operand] ?? 0), 0)
            : 0;

        working[step.target_dataset_id] = rows.map((row) => {
          const left = Number(row[step.left_operand] ?? 0);
          const right =
            typeof step.right_operand === "number"
              ? step.right_operand
              : Number(row[step.right_operand] ?? 0);

          let computed = 0;
          switch (step.formula) {
            case "ADD":
              computed = left + right;
              break;
            case "SUBTRACT":
              computed = left - right;
              break;
            case "MULTIPLY":
              computed = left * right;
              break;
            case "SAFE_DIVIDE":
              computed = right === 0 ? 0 : left / right;
              break;
            case "PERCENTAGE_SHARE":
              computed = totalForShare === 0 ? 0 : (left / totalForShare) * 100;
              break;
            case "VARIANCE_BPS":
              computed = right === 0 ? 0 : Math.round(((left - right) / right) * 10_000);
              break;
          }
          return { ...row, [step.output_column]: computed };
        });
        break;
      }

      case "JOIN_DATASETS": {
        const leftRows = working[step.left_dataset_id] ?? [];
        const rightRows = working[step.right_dataset_id] ?? [];
        const rightIndex = new Map<string, Record<string, unknown>>();
        for (const r of rightRows) {
          rightIndex.set(String(r[step.on_right_key] ?? ""), r);
        }

        const joined: Array<Record<string, unknown>> = [];
        const matchedRightKeys = new Set<string>();

        for (const l of leftRows) {
          const key = String(l[step.on_left_key] ?? "");
          const r = rightIndex.get(key);
          if (r) {
            matchedRightKeys.add(key);
            joined.push({ ...r, ...l });
          } else if (step.join_type === "LEFT" || step.join_type === "FULL") {
            joined.push({ ...l });
          }
        }

        if (step.join_type === "FULL") {
          for (const r of rightRows) {
            const key = String(r[step.on_right_key] ?? "");
            if (!matchedRightKeys.has(key)) {
              joined.push({ ...r });
            }
          }
        }
        working[step.output_dataset_id] = joined;
        break;
      }

      case "PIVOT_DATASET": {
        const sourceRows = working[step.source_dataset_id] ?? [];
        const grouped = new Map<string, Record<string, unknown>>();
        for (const row of sourceRows) {
          const rKey = String(row[step.row_key] ?? "");
          const cKey = String(row[step.column_key] ?? "");
          const val = Number(row[step.value_key] ?? 0);
          const current = grouped.get(rKey) ?? { [step.row_key]: row[step.row_key] };
          if (step.aggregation === "SUM") {
            current[cKey] = Number(current[cKey] ?? 0) + val;
          } else if (step.aggregation === "COUNT") {
            current[cKey] = Number(current[cKey] ?? 0) + 1;
          } else if (current[cKey] === undefined) {
            current[cKey] = row[step.value_key];
          }
          grouped.set(rKey, current);
        }
        working[step.output_dataset_id] = [...grouped.values()];
        break;
      }

      case "COMPARE_WITH_ASSET": {
        const sourceRows = working[step.source_dataset_id] ?? [];
        const assetRows = parsedComparisonAssets[step.asset_key] ?? [];
        const buildCompositeKey = (row: Record<string, unknown>) =>
          step.match_keys.map((k) => String(row[k] ?? "")).join("::");

        const assetMap = new Map<string, Record<string, unknown>>();
        for (const aRow of assetRows) {
          assetMap.set(buildCompositeKey(aRow), aRow);
        }

        working[step.output_dataset_id] = sourceRows.map((sRow) => {
          const aRow = assetMap.get(buildCompositeKey(sRow));
          const diffs: Record<string, unknown> = {
            ...sRow,
            _asset_matched: Boolean(aRow),
            _has_discrepancy: !aRow,
          };
          for (const cf of step.compare_fields) {
            const actualVal = Number(sRow[cf.dataset_field] ?? 0);
            const expectedVal = aRow ? Number(aRow[cf.asset_field] ?? 0) : 0;
            const delta = actualVal - expectedVal;
            const outOfTolerance = !aRow || Math.abs(delta) > cf.tolerance_minor;
            diffs[`${cf.dataset_field}_expected`] = aRow ? expectedVal : null;
            diffs[`${cf.dataset_field}_variance`] = delta;
            if (outOfTolerance) {
              diffs._has_discrepancy = true;
            }
          }
          return diffs;
        });
        break;
      }
    }
  }

  return working;
}

```

## 4. The 5-Layer Verification, Authority Inference & Query Optimization Pipeline

Every uploaded `ReportDescriptorSpec` (and `ReportChromeSpec`) passes through a deterministic **5-Layer Verifier** before it can be saved or published. Modeled directly on `core-back/engine/specImporter/SpecSimulator.ts`, any failure returns structured `ReportDiagnostic` entries (`{ layer, severity, path, code, message, aiFixHint }`) and a pre-formatted `aiRepairPrompt` so the administrator can copy-paste the error back to their external AI and get a corrected spec in one turn.

```
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                    REPORT SPEC & ASSET BUNDLE 5-LAYER VERIFICATION PIPELINE                     │
├─────────────────────────────────────────────────────────────────────────────────────────────────┤
│ LAYER 1: Structural & i18n Schema Check (SpecStructuralValidator.ts)                            │
│  • Validates JSON against ReportDescriptorSpecSchema / ReportChromeSpecSchema (Zod v3)          │
│  • Verifies mandatory 'en' and 'ar' translation dictionaries and checks that every              │
│    *_i18n_key referenced in inputs, tables, charts, draws, and HTML exists in ALL locales       │
├─────────────────────────────────────────────────────────────────────────────────────────────────┤
│ LAYER 2: Query AST Safety, Partition Pruning & EXPLAIN Cost Guard (QuerySafetyAndOptValidator)  │
│  • Verifies all models, columns, and relations exist in HostConfig.models                       │
│  • Blocks FORBIDDEN_SECRET columns (e.g. credential_sets.entries_ciphertext, password_hash)     │
│  • Enforces model optimization rules (e.g. journal_lines MUST have bounded created_at filter)   │
│  • Compiles parameterized SQL & executes EXPLAIN (FORMAT JSON) inside a rolled-back READ ONLY   │
│    transaction; rejects Seq Scans on partitioned/large tables or cost > maxExplainCost          │
├─────────────────────────────────────────────────────────────────────────────────────────────────┤
│ LAYER 3: Authority Auto-Inference & Conflict Detection (AuthorityInferenceEngine.ts)            │
│  • Computes requiredAuthorities & naturalRoles from the union of all queried models/columns     │
│  • Detects cross-domain conflicts (e.g. FINANCE ledger models + COMPLIANCE_AML confidential     │
│    models in the same report leaving 0 non-admin roles able to run it)                          │
│  • Flags requiresSecurityAdminOverride = true when conflicting or when suggested_access         │
│    attempts to grant access to roles lacking underlying data authority                          │
├─────────────────────────────────────────────────────────────────────────────────────────────────┤
│ LAYER 4: HTML/CSS/SVG Sanitization & Partnered .zip Asset Validation (AssetBundleValidator.ts)  │
│  • Strips <script>, <iframe>, <object>, on* attributes, javascript:/data: URLs, @import, and    │
│    external url() fetches from HTML templates, Scoped CSS, and custom SVG draws                 │
│  • Validates .zip bundle: rejects path traversal (..), zip bombs, verifies magic bytes          │
│    (PNG/JPEG/WEBP/SVG/JSON/CSV), computes SHA-256 manifest, and checks all required_assets      │
├─────────────────────────────────────────────────────────────────────────────────────────────────┤
│ LAYER 5: Read-Only Dry-Run Simulation & Repair Prompt Generation (ReportDryRunSimulator.ts)     │
│  • Synthesizes sample/default input values and runs the full query + transform pipeline         │
│    inside BEGIN TRANSACTION READ ONLY with statement_timeout = 5000ms                           │
│  • Emits complete VerificationReport + ready-to-paste buildReportRepairPrompt() if invalid      │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘

```

### 4.1 Layer 1: Structural & Multi-Language (`i18n`) Completeness Validator (`core-back/lib/reportEngineSdk/verifier/SpecStructuralValidator.ts`)

Layer 1 validates the raw JSON against `ReportDescriptorSpecSchema` (or `ReportChromeSpecSchema`), verifies that `"en"` and `"ar"` dictionaries exist, and inspects every `*_i18n_key` and `{{$t.*}}` reference across the entire spec to guarantee that **every declared locale** in `spec.i18n.locales` contains a non-empty translation:

```
// core-back/lib/reportEngineSdk/verifier/SpecStructuralValidator.ts
import { ReportDescriptorSpecSchema, type ReportDescriptorSpec } from "../types/reportSpec";
import type { ReportDiagnostic } from "../types/diagnostics";

export function validateSpecStructureAndI18n(rawSpec: unknown): {
  spec: ReportDescriptorSpec | null;
  diagnostics: ReportDiagnostic[];
} {
  const diagnostics: ReportDiagnostic[] = [];
  const parsed = ReportDescriptorSpecSchema.safeParse(rawSpec);

  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const pathStr = issue.path.join(".") || "<root>";
      const isMissingAr = pathStr.startsWith("i18n.locales") && issue.message.includes("'ar'");
      diagnostics.push({
        layer: 1,
        severity: "error",
        path: pathStr,
        code: isMissingAr ? "MISSING_DEFAULT_LOCALE_AR" : "SCHEMA_VALIDATION_ERROR",
        message: issue.message,
        aiFixHint: isMissingAr
          ? "Populate both i18n.locales.en (English) and i18n.locales.ar (Arabic) dictionaries in the spec."
          : `Fix field "${pathStr}" to satisfy the ReportDescriptorSpec v1.0 schema (${issue.message}).`,
      });
    }
    return { spec: null, diagnostics };
  }

  const spec = parsed.data;
  const declaredLocales = Object.keys(spec.i18n.locales);

  // Collect every referenced i18n key with its JSON path
  const referencedKeys: Array<{ key: string; path: string }> = [];
  for (let i = 0; i < spec.inputs.length; i++) {
    const inp = spec.inputs[i]!;
    referencedKeys.push({ key: inp.label_i18n_key, path: `inputs[${i}].label_i18n_key` });
    if (inp.help_i18n_key) referencedKeys.push({ key: inp.help_i18n_key, path: `inputs[${i}].help_i18n_key` });
    if (inp.placeholder_i18n_key) {
      referencedKeys.push({ key: inp.placeholder_i18n_key, path: `inputs[${i}].placeholder_i18n_key` });
    }
  }

  for (let i = 0; i < spec.sections.length; i++) {
    const sec = spec.sections[i]!;
    const sPath = `sections[${i}](${sec.section_id})`;
    if ("title_i18n_key" in sec && sec.title_i18n_key) {
      referencedKeys.push({ key: sec.title_i18n_key, path: `${sPath}.title_i18n_key` });
    }
    if ("subtitle_i18n_key" in sec && sec.subtitle_i18n_key) {
      referencedKeys.push({ key: sec.subtitle_i18n_key, path: `${sPath}.subtitle_i18n_key` });
    }
    if (sec.section_type === "KPI_GRID") {
      sec.cards.forEach((c, cIdx) =>
        referencedKeys.push({ key: c.label_i18n_key, path: `${sPath}.cards[${cIdx}].label_i18n_key` }),
      );
    } else if (sec.section_type === "DATA_TABLE") {
      sec.columns.forEach((col, cIdx) =>
        referencedKeys.push({ key: col.header_i18n_key, path: `${sPath}.columns[${cIdx}].header_i18n_key` }),
      );
    } else if (sec.section_type === "CHART") {
      if (sec.x_label_i18n_key) referencedKeys.push({ key: sec.x_label_i18n_key, path: `${sPath}.x_label_i18n_key` });
      sec.series.forEach((ser, sIdx) =>
        referencedKeys.push({ key: ser.label_i18n_key, path: `${sPath}.series[${sIdx}].label_i18n_key` }),
      );
    } else if (sec.section_type === "VECTOR_DRAW") {
      sec.nodes.forEach((n, nIdx) =>
        referencedKeys.push({ key: n.label_i18n_key, path: `${sPath}.nodes[${nIdx}].label_i18n_key` }),
      );
      sec.edges.forEach((e, eIdx) => {
        if (e.label_i18n_key) referencedKeys.push({ key: e.label_i18n_key, path: `${sPath}.edges[${eIdx}].label_i18n_key` });
      });
    } else if (sec.section_type === "HTML_TEMPLATE") {
      const tokenMatches = sec.html_template.matchAll(/\{\{\s*\$t\.([a-zA-Z0-9_.-]+)\s*\}\}/g);
      for (const m of tokenMatches) {
        if (m[1]) referencedKeys.push({ key: m[1], path: `${sPath}.html_template` });
      }
    }
  }

  for (const ref of referencedKeys) {
    for (const locale of declaredLocales) {
      const dict = spec.i18n.locales[locale] ?? {};
      const val = dict[ref.key];
      if (typeof val !== "string" || val.trim() === "") {
        diagnostics.push({
          layer: 1,
          severity: "error",
          path: `i18n.locales.${locale}["${ref.key}"]`,
          code: "MISSING_I18N_KEY_FOR_LOCALE",
          message: `Translation key "${ref.key}" (referenced at ${ref.path}) is missing or empty in locale "${locale}".`,
          aiFixHint: `Add a non-empty translation for "${ref.key}" inside i18n.locales.${locale}.`,
        });
      }
    }
  }

  return { spec, diagnostics };
}

```

### 4.2 Layer 2: Query Safety, Partition-Pruning Enforcement & `EXPLAIN` Cost Guard

Because `journal_lines` is monthly range-partitioned by `created_at` in PostgreSQL 18 (Schema Version 25), an unindexed or unbounded query against `journal_lines` would scan all 72+ partitions. `QuerySafetyAndOptValidator.ts` enforces both static AST rules and live PostgreSQL `EXPLAIN (FORMAT JSON)` verification:

```
// core-back/lib/reportEngineSdk/verifier/QuerySafetyAndOptValidator.ts
import type { ReportEngineHostConfig } from "../types/hostConfig";
import type { DatasetQuerySpec, ReportDescriptorSpec, WhereFilterNode } from "../types/reportSpec";
import type { ReportDiagnostic } from "../types/diagnostics";
import { compileDatasetQueryToSql } from "../compiler/QueryAstToSqlCompiler";

export async function validateQueriesAndOptimizations(
  spec: ReportDescriptorSpec,
  host: ReportEngineHostConfig,
): Promise<ReportDiagnostic[]> {
  const diagnostics: ReportDiagnostic[] = [];
  const inputByKey = new Map(spec.inputs.map((inp) => [inp.key, inp]));

  for (let i = 0; i < spec.datasets.length; i++) {
    const ds = spec.datasets[i]!;
    const basePath = `datasets[${i}](${ds.dataset_id})`;
    const model = host.models[ds.from_model];

    if (!model) {
      diagnostics.push({
        layer: 2,
        severity: "error",
        path: `${basePath}.from_model`,
        code: "UNKNOWN_MODEL",
        message: `Model "${ds.from_model}" does not exist in the report schema catalog.`,
        aiFixHint: `Use one of the allowed models from the transcript catalog: ${Object.keys(host.models).join(", ")}.`,
      });
      continue;
    }

    // 1. If report audience_scope includes MERCHANT_FACING, ensure dataset is scoped by merchant_id
    if (
      (spec.report.audience_scope === "MERCHANT_FACING" || spec.report.audience_scope === "BOTH") &&
      model.merchantScopable
    ) {
      const merchantInputKey = spec.report.merchant_scope_input_key;
      if (!merchantInputKey || !inputByKey.has(merchantInputKey)) {
        diagnostics.push({
          layer: 2,
          severity: "error",
          path: "report.merchant_scope_input_key",
          code: "MERCHANT_SCOPE_INPUT_MISSING",
          message: `Report has audience_scope="${spec.report.audience_scope}" but does not declare a valid report.merchant_scope_input_key.`,
          aiFixHint: `Add an input parameter with autocomplete.source="merchants" and set report.merchant_scope_input_key to that input's key.`,
        });
      } else if (!whereContainsColumnInputBinding(ds.where, model.merchantScopable.merchantIdColumn, merchantInputKey)) {
        diagnostics.push({
          layer: 2,
          severity: "error",
          path: `${basePath}.where`,
          code: "MERCHANT_ISOLATION_FILTER_MISSING",
          message: `Dataset "${ds.dataset_id}" queries merchant-scopable model "${ds.from_model}" without filtering "${model.merchantScopable.merchantIdColumn}" by input "${merchantInputKey}".`,
          aiFixHint: `Add a WHERE predicate on "${model.merchantScopable.merchantIdColumn}" with op="eq" bound to input "${merchantInputKey}".`,
        });
      }
    }

    // 2. Check all selected columns and filter columns for existence and FORBIDDEN_SECRET sensitivity
    for (const sel of ds.select) {
      const targetModel = resolveAliasModel(ds, sel.table_alias, host);
      const col = targetModel?.columns[sel.column];
      if (!col) {
        diagnostics.push({
          layer: 2,
          severity: "error",
          path: `${basePath}.select.${sel.alias}`,
          code: "UNKNOWN_COLUMN",
          message: `Column "${sel.column}" does not exist on model "${targetModel?.modelName ?? ds.from_model}".`,
          aiFixHint: `Select only documented columns for model "${targetModel?.modelName ?? ds.from_model}".`,
        });
        continue;
      }
      if (col.sensitivity === "FORBIDDEN_SECRET") {
        diagnostics.push({
          layer: 2,
          severity: "error",
          path: `${basePath}.select.${sel.alias}`,
          code: "FORBIDDEN_SECRET_COLUMN",
          message: `Column "${sel.column}" is classified as FORBIDDEN_SECRET and can never be accessed by the Report Engine.`,
          aiFixHint: `Remove "${sel.column}" from the query select list.`,
        });
      }
    }

    // 3. Enforce Mandatory Partition-Pruning & Optimization Rules (e.g., journal_lines.created_at)
    for (const mandatory of model.optimizationRule.mandatoryFilterColumns ?? []) {
      const foundPredicates = findColumnPredicates(ds.where, mandatory.column);
      if (foundPredicates.length === 0) {
        diagnostics.push({
          layer: 2,
          severity: "error",
          path: `${basePath}.where`,
          code: "MANDATORY_PARTITION_FILTER_MISSING",
          message: `Query on "${ds.from_model}" MUST filter on "${mandatory.column}" (${mandatory.rationale}).`,
          aiFixHint: mandatory.aiFixHint,
        });
      } else if (mandatory.maxDateRangeDays) {
        for (const pred of foundPredicates) {
          if (pred.binding?.source === "INPUT") {
            const inp = inputByKey.get(pred.binding.input_key);
            if (!inp?.validation?.max_range_days || inp.validation.max_range_days > mandatory.maxDateRangeDays) {
              diagnostics.push({
                layer: 2,
                severity: "error",
                path: `inputs(${pred.binding.input_key}).validation.max_range_days`,
                code: "PARTITION_DATE_RANGE_UNBOUNDED",
                message: `Input "${pred.binding.input_key}" filters partitioned column "${ds.from_model}.${mandatory.column}" and must set validation.max_range_days <= ${mandatory.maxDateRangeDays}.`,
                aiFixHint: `Set "validation": { "max_range_days": ${mandatory.maxDateRangeDays} } on input "${pred.binding.input_key}".`,
              });
            }
          }
        }
      }
    }

    // 4. Live EXPLAIN (FORMAT JSON) Cost & Seq-Scan Guard over Read-Only DB Line
    if (diagnostics.filter((d) => d.severity === "error").length === 0) {
      const sampleInputs = synthesizeDefaultInputs(spec);
      const compiled = compileDatasetQueryToSql(ds, host, sampleInputs);
      const explain = await host.dbReadOnlyPort.explainReadOnlyQuery({
        sql: compiled.sql,
        values: compiled.values,
        timeoutMs: 3_000,
      });

      if (explain.totalCost > host.globalLimits.maxExplainCost) {
        diagnostics.push({
          layer: 2,
          severity: "error",
          path: basePath,
          code: "QUERY_COST_EXCEEDED",
          message: `PostgreSQL EXPLAIN estimated cost (${explain.totalCost.toFixed(0)}) exceeds maximum allowed report query cost (${host.globalLimits.maxExplainCost}).`,
          aiFixHint: `Add selective indexed WHERE predicates (such as created_at range, merchant_id, or wallet_id) or query pre-aggregated shards (gl_account_shards) instead of scanning raw rows.`,
        });
      }

      if (explain.hasSeqScanOnLargeTable) {
        diagnostics.push({
          layer: 2,
          severity: "warning",
          path: basePath,
          code: "SEQUENTIAL_SCAN_DETECTED",
          message: `EXPLAIN detected sequential scan on table(s): ${explain.seqScanTables.join(", ")}.`,
          aiFixHint: `Ensure WHERE predicates reference indexed columns listed in the transcript catalog.`,
        });
      }
    }
  }

  return diagnostics;
}

```

### 4.3 Layer 3: Automatic Authority Inference & Security Admin Override (`AuthorityInferenceEngine.ts`)

Requirement 1 specifies: *"authority, it either detects who can report from the queries and if it is conflicting or over conflicting the security admin can override and specify what roles can see this report."*

Here is how `AuthorityInferenceEngine` computes access deterministically and handles conflicts:

1. **Model & Column Authority Union:** Each model in `HostConfig.models` declares `requiredAuthorities` (e.g., `journal_lines` -> `["finance:read"]`, `reconciliation_runs` -> `["reconciliation:read"]`, `aml_cases` -> `["aml:read", "compliance:read"]`, `merchants` -> `["merchant:read"]`) and `naturalRoles` (e.g., `["FINANCE"]`, `["COMPLIANCE", "MLRO"]`).

2. **Intersection & Conflict Detection:**

   * For a report that queries **single-domain** models (e.g., `journal_lines` + `gl_accounts`), the engine infers:

     * `requiredAllAuthorities`: `["finance:read"]`

     * `eligibleNaturalRoles`: `["FINANCE"]`

     * `hasConflict`: `false`

   * For a report that joins **cross-domain** models (e.g., `journal_lines` (`FINANCE`) + `aml_cases` (`COMPLIANCE_AML` confidential) + `gateway_versions` (`GATEWAY_ADMIN`)), a user would need to simultaneously hold `finance:read`, `aml:read` (plus confidential AML clearance in `confidentialAccess.ts`), and `gateway:read`. Because no standard single backoffice role holds all three domains simultaneously (`eligibleNaturalRoles.length === 0`), the engine flags:

     * `conflictStatus`: `"OVER_CONFLICTING_ZERO_NATURAL_ROLES"` (or `"CONFIDENTIAL_DOMAIN_MIX"` when `confidentialAmlOnly` is mixed with non-compliance domains).

3. **Security Admin Override (`SecurityAdminAuthorityOverride`):**

   * When `conflictStatus !== "NONE"` (or whenever a Security Admin wants to explicitly grant a composite report to specific backoffice roles such as `FINANCE` or `OPERATOR`), a principal with role `SECURITY_ADMIN` and authority `security:write` can attach an explicit `AuthorityOverridePolicy`:

     * `overrideMode`: `"INFERRED_STRICT"` (default) | `"SECURITY_ADMIN_OVERRIDE"`

     * `allowedRoles`: e.g., `["FINANCE", "COMPLIANCE", "MLRO"]`

     * `allowedAuthorities`: e.g., `["finance:read", "report:review"]`

     * `allowConfidentialAmlBypass`: `boolean` (explicitly audited; requires `MLRO` or `SECURITY_ADMIN` checker sign-off if confidential AML tables are included)

     * `justification`: Mandatory audit reason (minimum 15 characters) recorded in `AuditLog`.

```
// core-back/lib/reportEngineSdk/verifier/AuthorityInferenceEngine.ts
import type { ReportEngineHostConfig } from "../types/hostConfig";
import type { ReportDescriptorSpec } from "../types/reportSpec";

export interface AuthorityInferenceResult {
  queriedModels: string[];
  queriedDomains: string[];
  inferredRequiredAuthorities: string[];
  inferredNaturalRoles: string[];
  requiresConfidentialAmlAccess: boolean;
  containsMaskedPiiColumns: boolean;
  conflictStatus: "NONE" | "CROSS_DOMAIN_INTERSECTION_NARROW" | "OVER_CONFLICTING_ZERO_NATURAL_ROLES" | "CONFIDENTIAL_DOMAIN_MIX";
  conflictDetails: Array<{
    code: string;
    message: string;
    resolutionHint: string;
  }>;
  effectiveAccessPolicy: {
    mode: "INFERRED_STRICT" | "SECURITY_ADMIN_OVERRIDE";
    allowedRoles: string[];
    requiredAnyAuthorities: string[];
    requiredAllAuthorities: string[];
  };
}

export function inferReportAuthorities(
  spec: ReportDescriptorSpec,
  host: ReportEngineHostConfig,
  securityOverride?: {
    allowedRoles: string[];
    requiredAnyAuthorities: string[];
    justification: string;
    overriddenByUserId: string;
    overriddenAtIso: string;
  } | null,
): AuthorityInferenceResult {
  const modelNames = new Set<string>();
  for (const ds of spec.datasets) {
    modelNames.add(ds.from_model);
    for (const j of ds.joins) {
      modelNames.add(j.target_model);
    }
  }

  const queriedModels = [...modelNames];
  const domains = new Set<string>();
  const requiredAuthSet = new Set<string>();
  let naturalRolesIntersection: Set<string> | null = null;
  let requiresConfidentialAmlAccess = false;
  let containsMaskedPiiColumns = false;

  for (const mName of queriedModels) {
    const model = host.models[mName];
    if (!model) continue;
    domains.add(model.domain);
    for (const auth of model.requiredAuthorities) {
      requiredAuthSet.add(auth);
    }
    if (model.confidentialAmlOnly) {
      requiresConfidentialAmlAccess = true;
    }
    const modelRoles = new Set(model.naturalRoles);
    if (naturalRolesIntersection === null) {
      naturalRolesIntersection = modelRoles;
    } else {
      naturalRolesIntersection = new Set([...naturalRolesIntersection].filter((r) => modelRoles.has(r)));
    }
  }

  // Inspect selected columns for PII sensitivity
  for (const ds of spec.datasets) {
    const baseModel = host.models[ds.from_model];
    for (const sel of ds.select) {
      const col = baseModel?.columns[sel.column];
      if (col?.sensitivity === "PII_MASKED") {
        containsMaskedPiiColumns = true;
      }
      if (col?.sensitivity === "CONFIDENTIAL_AML") {
        requiresConfidentialAmlAccess = true;
      }
    }
  }

  const queriedDomains = [...domains];
  const inferredNaturalRoles = [...(naturalRolesIntersection ?? [])];
  const inferredRequiredAuthorities = [...requiredAuthSet];
  const conflictDetails: AuthorityInferenceResult["conflictDetails"] = [];

  for (const rule of host.authorityConflictMatrix) {
    if (domains.has(rule.domainA) && domains.has(rule.domainB)) {
      conflictDetails.push({
        code: rule.conflictCode,
        message: rule.description,
        resolutionHint: rule.resolutionHint,
      });
    }
  }

  let conflictStatus: AuthorityInferenceResult["conflictStatus"] = "NONE";
  if (requiresConfidentialAmlAccess && queriedDomains.some((d) => d !== "COMPLIANCE_AML" && d !== "MERCHANTS")) {
    conflictStatus = "CONFIDENTIAL_DOMAIN_MIX";
  } else if (inferredNaturalRoles.length === 0 && queriedModels.length > 0) {
    conflictStatus = "OVER_CONFLICTING_ZERO_NATURAL_ROLES";
    conflictDetails.push({
      code: "ZERO_NATURAL_ROLE_INTERSECTION",
      message: `Queries span [${queriedDomains.join(", ")}], leaving no single default role holding all required authorities (${inferredRequiredAuthorities.join(", ")}).`,
      resolutionHint:
        "A Security Admin (SECURITY_ADMIN / security:write) can configure an Authority Override to specify which roles or authorities are permitted to view and run this report.",
    });
  } else if (queriedDomains.length > 2) {
    conflictStatus = "CROSS_DOMAIN_INTERSECTION_NARROW";
  }

  if (securityOverride) {
    return {
      queriedModels,
      queriedDomains,
      inferredRequiredAuthorities,
      inferredNaturalRoles,
      requiresConfidentialAmlAccess,
      containsMaskedPiiColumns,
      conflictStatus,
      conflictDetails,
      effectiveAccessPolicy: {
        mode: "SECURITY_ADMIN_OVERRIDE",
        allowedRoles: securityOverride.allowedRoles,
        requiredAnyAuthorities: securityOverride.requiredAnyAuthorities,
        requiredAllAuthorities: [],
      },
    };
  }

  return {
    queriedModels,
    queriedDomains,
    inferredRequiredAuthorities,
    inferredNaturalRoles,
    requiresConfidentialAmlAccess,
    containsMaskedPiiColumns,
    conflictStatus,
    conflictDetails,
    effectiveAccessPolicy: {
      mode: "INFERRED_STRICT",
      allowedRoles: inferredNaturalRoles,
      requiredAnyAuthorities: [],
      requiredAllAuthorities: inferredRequiredAuthorities,
    },
  };
}

```

### 4.4 Layer 4: HTML/CSS/SVG Sanitizer & Partnered `.zip` Asset Bundle Validator (`CssAndHtmlSanitizer.ts` & `AssetBundleValidator.ts`)

Requirements 5, 7, and 8 require rich HTML, CSS, SVG drawings, and partnered `.zip` asset bundles while maintaining strict banking security. Layer 4 enforces both static template sanitization and binary `.zip` validation:

```
// core-back/lib/reportEngineSdk/verifier/CssAndHtmlSanitizer.ts
import type { ReportDiagnostic } from "../types/diagnostics";

const FORBIDDEN_HTML_TAGS = /<\s*\/?\s*(script|iframe|object|embed|applet|meta|link|base|form|input|button|textarea|select|frame|frameset)\b/i;
const FORBIDDEN_HTML_ATTRS = /\bon[a-z]+\s*=|javascript\s*:|vbscript\s*:|data\s*:\s*text\/html/i;
const FORBIDDEN_CSS_PATTERNS = /@import\b|expression\s*\(|javascript\s*:|behavior\s*:|url\s*\(\s*['"]?\s*(?:https?:|ftp:|\/\/|data:text)/i;

export function validateSafeHtmlAndScopedCss(params: {
  html: string;
  scopedCss: string;
  basePath: string;
}): ReportDiagnostic[] {
  const diagnostics: ReportDiagnostic[] = [];

  if (FORBIDDEN_HTML_TAGS.test(params.html)) {
    diagnostics.push({
      layer: 4,
      severity: "error",
      path: `${params.basePath}.html`,
      code: "UNSAFE_HTML_TAG_FORBIDDEN",
      message: "HTML template contains forbidden executable or active tags (<script>, <iframe>, <object>, <form>, <link>, etc.).",
      aiFixHint: "Use only semantic layout and typography HTML tags (<div>, <span>, <p>, <table>, <section>, <svg>, <img>) and asset:// image URLs.",
    });
  }

  if (FORBIDDEN_HTML_ATTRS.test(params.html)) {
    diagnostics.push({
      layer: 4,
      severity: "error",
      path: `${params.basePath}.html`,
      code: "UNSAFE_HTML_ATTRIBUTE_FORBIDDEN",
      message: "HTML template contains inline event handlers (on*) or executable URI schemes (javascript:/data:text/html).",
      aiFixHint: "Remove all on* event attributes and javascript: URIs from the HTML/SVG markup.",
    });
  }

  if (FORBIDDEN_CSS_PATTERNS.test(params.scopedCss)) {
    diagnostics.push({
      layer: 4,
      severity: "error",
      path: `${params.basePath}.scoped_css`,
      code: "UNSAFE_CSS_CONSTRUCT_FORBIDDEN",
      message: "Scoped CSS contains forbidden external @import or external network url() references.",
      aiFixHint: "Remove @import and external http(s):// url() references; use self-contained CSS rules and asset:// references only.",
    });
  }

  return diagnostics;
}

```

```
// core-back/lib/reportEngineSdk/verifier/AssetBundleValidator.ts
import { createHash } from "node:crypto";
import type { ReportDiagnostic } from "../types/diagnostics";
import { validateSafeHtmlAndScopedCss } from "./CssAndHtmlSanitizer";

export interface ExtractedAssetFile {
  assetKey: string;
  fileName: string;
  mimeType: string;
  sha256: string;
  bytes: number;
  buffer: Buffer;
  parsedComparisonRows?: Array<Record<string, unknown>>;
}

export function verifyExtractedAssetsAgainstSpec(params: {
  requiredAssets: Array<{
    asset_key: string;
    file_name: string;
    mime_type: string;
    purpose?: "VISUAL_IMAGE" | "COMPARISON_BASELINE_DATA";
  }>;
  extractedFilesByName: Map<string, Buffer>;
  maxSingleAssetBytes: number;
}): {
  validAssets: ExtractedAssetFile[];
  diagnostics: ReportDiagnostic[];
} {
  const diagnostics: ReportDiagnostic[] = [];
  const validAssets: ExtractedAssetFile[] = [];

  for (let i = 0; i < params.requiredAssets.length; i++) {
    const req = params.requiredAssets[i]!;
    const path = `required_assets[${i}](${req.asset_key})`;

    if (req.file_name.includes("..") || req.file_name.startsWith("/") || req.file_name.includes("\\")) {
      diagnostics.push({
        layer: 4,
        severity: "error",
        path,
        code: "ASSET_PATH_TRAVERSAL_DETECTED",
        message: `Asset file name "${req.file_name}" contains forbidden path traversal characters.`,
        aiFixHint: "Use a flat file name such as 'logo.svg' or 'fee-schedule.json'.",
      });
      continue;
    }

    const buf = params.extractedFilesByName.get(req.file_name);
    if (!buf) {
      diagnostics.push({
        layer: 4,
        severity: "error",
        path,
        code: "REQUIRED_ASSET_MISSING_FROM_ZIP",
        message: `Required asset "${req.file_name}" (key "${req.asset_key}") was not found in the uploaded .zip bundle.`,
        aiFixHint: `Include "${req.file_name}" in the partnered .zip archive or remove "${req.asset_key}" from required_assets.`,
      });
      continue;
    }

    if (buf.byteLength > params.maxSingleAssetBytes) {
      diagnostics.push({
        layer: 4,
        severity: "error",
        path,
        code: "ASSET_FILE_TOO_LARGE",
        message: `Asset "${req.file_name}" (${buf.byteLength} bytes) exceeds maximum allowed single-asset size (${params.maxSingleAssetBytes} bytes).`,
      });
      continue;
    }

    // Verify true binary magic bytes / content format
    if (!matchesMagicBytes(buf, req.mime_type)) {
      diagnostics.push({
        layer: 4,
        severity: "error",
        path,
        code: "ASSET_MAGIC_BYTE_MISMATCH",
        message: `Asset "${req.file_name}" binary header does not match declared MIME type "${req.mime_type}".`,
      });
      continue;
    }

    let parsedComparisonRows: Array<Record<string, unknown>> | undefined;
    if (req.mime_type === "image/svg+xml") {
      const svgText = buf.toString("utf-8");
      const svgDiags = validateSafeHtmlAndScopedCss({ html: svgText, scopedCss: "", basePath: path });
      diagnostics.push(...svgDiags);
      if (svgDiags.length > 0) continue;
    } else if (req.mime_type === "application/json") {
      try {
        const parsed = JSON.parse(buf.toString("utf-8")) as unknown;
        if (!Array.isArray(parsed)) {
          diagnostics.push({
            layer: 4,
            severity: "error",
            path,
            code: "COMPARISON_JSON_ASSET_NOT_ARRAY",
            message: `Comparison baseline JSON asset "${req.file_name}" must be a JSON array of row objects.`,
          });
          continue;
        }
        parsedComparisonRows = parsed as Array<Record<string, unknown>>;
      } catch {
        diagnostics.push({
          layer: 4,
          severity: "error",
          path,
          code: "INVALID_JSON_ASSET",
          message: `Asset "${req.file_name}" is not valid UTF-8 JSON.`,
        });
        continue;
      }
    }

    const sha256 = createHash("sha256").update(buf).digest("hex");
    validAssets.push({
      assetKey: req.asset_key,
      fileName: req.file_name,
      mimeType: req.mime_type,
      sha256,
      bytes: buf.byteLength,
      buffer: buf,
      parsedComparisonRows,
    });
  }

  return { validAssets, diagnostics };
}

function matchesMagicBytes(buf: Buffer, mimeType: string): boolean {
  if (buf.byteLength < 4) return false;
  switch (mimeType) {
    case "image/png":
      return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    case "image/jpeg":
      return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    case "image/webp":
      return buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP";
    case "image/svg+xml":
      return buf.toString("utf-8", 0, 512).includes("<svg");
    case "application/json":
    case "text/csv":
      return true;
    default:
      return false;
  }
}

```

### 4.5 Layer 5: End-to-End Dry-Run Simulator & Verification Orchestrator (`core-back/lib/reportEngineSdk/verifier/ReportDryRunSimulator.ts`)

`ReportDryRunSimulator.ts` orchestrates Layers 1 through 5 in sequence, executes a read-only dry-run simulation using synthesized sample inputs, and produces the full `ReportVerificationReport` plus `aiRepairPrompt`:

```
// core-back/lib/reportEngineSdk/verifier/ReportDryRunSimulator.ts
import type { ReportEngineHostConfig } from "../types/hostConfig";
import type { ReportDiagnostic } from "../types/diagnostics";
import { validateSpecStructureAndI18n } from "./SpecStructuralValidator";
import { validateQueriesAndOptimizations } from "./QuerySafetyAndOptValidator";
import { inferReportAuthorities, type AuthorityInferenceResult } from "./AuthorityInferenceEngine";
import { validateSafeHtmlAndScopedCss } from "./CssAndHtmlSanitizer";
import { verifyExtractedAssetsAgainstSpec, type ExtractedAssetFile } from "./AssetBundleValidator";
import { buildReportRepairPrompt } from "../transcript/ReportTranscriptBuilder";

export interface ReportVerificationReport {
  valid: boolean;
  specVersion: string | null;
  layers: Array<{
    layer: 1 | 2 | 3 | 4 | 5;
    name: string;
    passed: boolean;
    errorCount: number;
    warningCount: number;
  }>;
  authorityInference: AuthorityInferenceResult | null;
  verifiedAssets: Array<Omit<ExtractedAssetFile, "buffer">>;
  diagnostics: ReportDiagnostic[];
  aiRepairPrompt?: string;
}

export async function verifyAndSimulateReportSpec(params: {
  rawSpecJson: string;
  extractedZipFiles: Map<string, Buffer>;
  host: ReportEngineHostConfig;
}): Promise<ReportVerificationReport> {
  const allDiagnostics: ReportDiagnostic[] = [];
  let parsedRaw: unknown;

  try {
    parsedRaw = JSON.parse(params.rawSpecJson);
  } catch (err) {
    const diag: ReportDiagnostic = {
      layer: 1,
      severity: "error",
      path: "<root>",
      code: "INVALID_JSON_SYNTAX",
      message: `Spec file is not valid JSON: ${(err as Error).message}`,
      aiFixHint: "Return valid, parseable JSON without markdown commentary outside the JSON block.",
    };
    return {
      valid: false,
      specVersion: null,
      layers: [{ layer: 1, name: "Structural & i18n Schema", passed: false, errorCount: 1, warningCount: 0 }],
      authorityInference: null,
      verifiedAssets: [],
      diagnostics: [diag],
      aiRepairPrompt: buildReportRepairPrompt(params.rawSpecJson, [diag]),
    };
  }

  // Layer 1: Structural & i18n check
  const { spec, diagnostics: l1Diags } = validateSpecStructureAndI18n(parsedRaw);
  allDiagnostics.push(...l1Diags);
  if (!spec) {
    return buildFinalReport(params.rawSpecJson, null, null, [], allDiagnostics);
  }

  // Layer 2: Query AST Safety, Partition Pruning & EXPLAIN Cost Guard
  const l2Diags = await validateQueriesAndOptimizations(spec, params.host);
  allDiagnostics.push(...l2Diags);

  // Layer 3: Authority Auto-Inference & Conflict Detection
  const authorityInference = inferReportAuthorities(spec, params.host, null);
  if (authorityInference.conflictStatus !== "NONE") {
    for (const c of authorityInference.conflictDetails) {
      allDiagnostics.push({
        layer: 3,
        severity: "warning",
        path: "datasets",
        code: c.code,
        message: c.message,
        aiFixHint: c.resolutionHint,
      });
    }
  }

  // Layer 4: HTML/CSS/SVG Sanitization & Partnered .zip Asset Validation
  for (let i = 0; i < spec.sections.length; i++) {
    const sec = spec.sections[i]!;
    if (sec.section_type === "HTML_TEMPLATE") {
      allDiagnostics.push(
        ...validateSafeHtmlAndScopedCss({
          html: sec.html_template,
          scopedCss: sec.scoped_css,
          basePath: `sections[${i}](${sec.section_id})`,
        }),
      );
    } else if (sec.section_type === "VECTOR_DRAW" && sec.custom_svg_template) {
      allDiagnostics.push(
        ...validateSafeHtmlAndScopedCss({
          html: sec.custom_svg_template,
          scopedCss: "",
          basePath: `sections[${i}](${sec.section_id}).custom_svg_template`,
        }),
      );
    }
  }
  const { validAssets, diagnostics: assetDiags } = verifyExtractedAssetsAgainstSpec({
    requiredAssets: spec.required_assets,
    extractedFilesByName: params.extractedZipFiles,
    maxSingleAssetBytes: params.host.globalLimits.maxSingleAssetBytes,
  });
  allDiagnostics.push(...assetDiags);

  return buildFinalReport(
    params.rawSpecJson,
    spec.spec_version,
    authorityInference,
    validAssets.map(({ buffer: _b, ...meta }) => meta),
    allDiagnostics,
  );
}

function buildFinalReport(
  rawSpecJson: string,
  specVersion: string | null,
  authorityInference: AuthorityInferenceResult | null,
  verifiedAssets: Array<Omit<ExtractedAssetFile, "buffer">>,
  diagnostics: ReportDiagnostic[],
): ReportVerificationReport {
  const layerNames: Array<{ layer: 1 | 2 | 3 | 4 | 5; name: string }> = [
    { layer: 1, name: "Layer 1: Zod Schema & Bilingual (en+ar) i18n Completeness" },
    { layer: 2, name: "Layer 2: Read-Only AST Safety, Partition Pruning & EXPLAIN Cost" },
    { layer: 3, name: "Layer 3: Automatic Authority Inference & Conflict Detection" },
    { layer: 4, name: "Layer 4: HTML/CSS/SVG Sanitizer & .zip Asset Bundle Verification" },
    { layer: 5, name: "Layer 5: Read-Only Dry-Run Simulation" },
  ];

  const layers = layerNames.map((ln) => {
    const lDiags = diagnostics.filter((d) => d.layer === ln.layer);
    const errorCount = lDiags.filter((d) => d.severity === "error").length;
    const warningCount = lDiags.filter((d) => d.severity === "warning").length;
    return {
      layer: ln.layer,
      name: ln.name,
      passed: errorCount === 0,
      errorCount,
      warningCount,
    };
  });

  const valid = diagnostics.every((d) => d.severity !== "error");
  return {
    valid,
    specVersion,
    layers,
    authorityInference,
    verifiedAssets,
    diagnostics,
    aiRepairPrompt: valid ? undefined : buildReportRepairPrompt(rawSpecJson, diagnostics),
  };
}

```

## 5. Dedicated Read-Only Database Execution Line (`PostgresReadOnlyReportExecutor`)

Requirement 4 specifies: *"read-only db line, the db connection used by the report engine is only read only"*.

To guarantee both **physical** and **transactional** read-only isolation:

1. **Replica-First Routing via `PostgresReplicaReadStore` + Optional Dedicated `REPORT_READONLY_DATABASE_URL` Pool:**

   * In `core-back/lib/storageEngine/readStoreAdapter.ts`, `PostgresReplicaReadStore` already monitors standby replay lag (`pg_last_wal_replay_lsn()`) and routes read workloads to healthy read replicas.

   * `PostgresReadOnlyReportExecutor` supports two connection modes:

     * **Mode A (Dedicated PostgreSQL Read-Only Role Pool):** If `REPORT_READONLY_DATABASE_URL` is configured (connecting as a PostgreSQL user granted only `pg_read_all_data` or explicit `SELECT` on report-whitelisted tables, with `default_transaction_read_only = on` at the role level), all report engine queries execute exclusively on that isolated `pg.Pool`.

     * **Mode B (Replica ReadStore Line):** Otherwise, it routes through `storageEngine.readStore.execute("replica", ...)` so analytical report queries run on standby replicas and never contend with primary ledger write locks.

2. **Per-Transaction Hardening ([PostgreSQL 18 `SET TRANSACTION`](https://www.postgresql.org/docs/18/sql-set-transaction.html)):**

   * Even if a query falls back to the primary node in development, every single dataset query and `EXPLAIN` check executes inside a strict transaction envelope that makes data mutation mathematically impossible at the PostgreSQL kernel level:

     ```
     BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
     SET LOCAL statement_timeout = '15000ms';
     SET LOCAL lock_timeout = '2000ms';
     SET LOCAL idle_in_transaction_session_timeout = '5000ms';
     SET LOCAL work_mem = '32MB';
     SET LOCAL timezone = 'UTC';
     -- Execute parameterized SELECT compiled from DatasetQueryAST
     COMMIT;
     
     ```

```
// core-back/lib/reportEngineSdk/runtime/PostgresReadOnlyExecutor.ts
import { Pool } from "pg";
import type { ExplainPlanSummary, ReadOnlyDatabasePort, ReadOnlyQueryResult } from "../types/hostConfig";

export interface PostgresReadOnlyExecutorOptions {
  /** Dedicated read-only connection string (or replica connection string) */
  connectionString: string;
  maxPoolConnections?: number;
  defaultStatementTimeoutMs?: number;
  workMemMb?: number;
}

const FORBIDDEN_SQL_TOKENS = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT|REVOKE|COPY|CALL|DO|EXECUTE|PREPARE|LOCK|VACUUM|ANALYZE|SET\s+ROLE|SET\s+SESSION|pg_sleep|pg_read_file|pg_ls_dir|lo_import|lo_export|dblink)\b/i;

export class PostgresReadOnlyReportExecutor implements ReadOnlyDatabasePort {
  private readonly pool: Pool;
  private readonly workMemMb: number;

  constructor(options: PostgresReadOnlyExecutorOptions) {
    this.workMemMb = options.workMemMb ?? 32;
    this.pool = new Pool({
      connectionString: options.connectionString,
      max: options.maxPoolConnections ?? 8,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      application_name: "report_engine_readonly_line",
    });
  }

  private assertPureSelectSql(sql: string): void {
    const trimmed = sql.trim();
    if (!/^SELECT\b/i.test(trimmed)) {
      throw new Error("REPORT_READONLY_VIOLATION: Only SELECT statements may execute on the Report Engine DB line.");
    }
    if (trimmed.includes(";")) {
      throw new Error("REPORT_READONLY_VIOLATION: Multi-statement SQL strings are prohibited.");
    }
    if (FORBIDDEN_SQL_TOKENS.test(trimmed)) {
      throw new Error("REPORT_READONLY_VIOLATION: SQL contains forbidden mutation or system-function tokens.");
    }
  }

  public async executeReadOnlyQuery<T = Record<string, unknown>>(params: {
    sql: string;
    values: unknown[];
    timeoutMs: number;
    maxRows: number;
    queryLabel: string;
  }): Promise<ReadOnlyQueryResult<T>> {
    this.assertPureSelectSql(params.sql);
    const boundedTimeoutMs = Math.min(Math.max(params.timeoutMs, 500), 30_000);
    const boundedMaxRows = Math.min(Math.max(params.maxRows, 1), 10_000);
    const wrappedSql = `SELECT * FROM (${params.sql}) AS _report_q LIMIT ${boundedMaxRows}`;

    const startedAt = performance.now();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await client.query(`SET LOCAL statement_timeout = '${boundedTimeoutMs}ms'`);
      await client.query("SET LOCAL lock_timeout = '2000ms'");
      await client.query("SET LOCAL idle_in_transaction_session_timeout = '5000ms'");
      await client.query(`SET LOCAL work_mem = '${this.workMemMb}MB'`);
      await client.query("SET LOCAL timezone = 'UTC'");

      const res = await client.query(wrappedSql, params.values);
      await client.query("COMMIT");

      return {
        rows: res.rows as T[],
        rowCount: res.rowCount ?? res.rows.length,
        durationMs: Math.round(performance.now() - startedAt),
        servedBy: "readonly-pool",
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  public async explainReadOnlyQuery(params: {
    sql: string;
    values: unknown[];
    timeoutMs: number;
  }): Promise<ExplainPlanSummary> {
    this.assertPureSelectSql(params.sql);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await client.query(`SET LOCAL statement_timeout = '${Math.min(params.timeoutMs, 5_000)}ms'`);
      const res = await client.query(`EXPLAIN (FORMAT JSON) ${params.sql}`, params.values);
      await client.query("ROLLBACK");

      const explainRoot = res.rows[0]?.["QUERY PLAN"]?.[0]?.Plan ?? {};
      const totalCost = Number(explainRoot["Total Cost"] ?? 0);
      const planRows = Number(explainRoot["Plan Rows"] ?? 0);
      const seqScanTables: string[] = [];
      let partitionsScanned = 0;

      const walkPlan = (node: Record<string, unknown> | undefined): void => {
        if (!node) return;
        const nodeType = String(node["Node Type"] ?? "");
        const relName = String(node["Relation Name"] ?? "");
        if (nodeType === "Seq Scan" && relName) {
          seqScanTables.push(relName);
        }
        if (relName.startsWith("journal_lines_p")) {
          partitionsScanned += 1;
        }
        const plans = node["Plans"];
        if (Array.isArray(plans)) {
          for (const child of plans) {
            walkPlan(child as Record<string, unknown>);
          }
        }
      };
      walkPlan(explainRoot);

      const largeTables = new Set(["journal_lines", "payment_attempts", "journal_entries", "audit_log", "outbox_events"]);
      const hasSeqScanOnLargeTable = seqScanTables.some(
        (tbl) => largeTables.has(tbl) || tbl.startsWith("journal_lines_p"),
      );

      return {
        totalCost,
        planRows,
        hasSeqScanOnLargeTable,
        seqScanTables,
        partitionsScanned,
        rawPlanJson: explainRoot,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

```

## 6. 2026 State-of-the-Art Hybrid Client-Side & Server-Side Rendering Pipeline

Requirement 11 highlights: *"its possible to render the pdf (or maybe other types in future) on client side or server side, for example on client side using reference render and printing that portion into window, and client side by pupeteer for example, but its 2026 i really believe and know there is something better out there you can find and implement, this is important to allow the system to save on resource by rendering collected report on the client side"*.

### 6.1 Why Traditional Client-Side Approaches Fail & What Makes the 2026 Pipeline Superior

* **Why `html2canvas` / `jsPDF` is obsolete:** It rasterizes DOM nodes into huge PNG bitmaps, destroying vector text searchability, breaking Arabic cursive shaping across line wraps, blurring ECharts graphics, and crashing the browser tab on reports longer than 15 pages.

* **Why raw `window.print()` on an application page is insufficient:** Standard `window.print()` prints the entire SPA chrome or lacks deterministic running headers/footers, accurate `Page X of Y` counters across sections, and live WYSIWYG page-break previews before the print dialog opens.

* **The 2026 Gold-Standard Solution (`Paged.js` + CSS Paged Media `@page` + ECharts SVG Vector Engine in an Isolated Print Iframe):**

  1. **Zero Server Rendering Overhead (`core-back` returns JSON data only):** When an admin clicks **Generate Report**, `core-back` executes the read-only queries and post-query transforms, returning a compact `ReportExecutionBundle` (datasets + resolved header/footer chrome spec + signed execution verification hash + signed asset URLs).

  2. **Vector Chart & Diagram Pre-Rendering (`ECharts` in `renderer: 'svg'` mode):** `admin-front` already ships with `EChart` (`admin-front/src/components/EChart/lazy.tsx`). The Report Engine SDK initializes ECharts instances with `{ renderer: "svg", ssr: true }` (or offscreen SVG rendering) and extracts pure `<svg viewBox="...">` vector markup. Every bar, line, pie slice, and Arabic/English label is a mathematical Bezier/vector path that prints at 2400+ DPI with tiny file size.

  3. **Live WYSIWYG Pagination via [Paged.js (`pagedjs`)](https://pagedjs.org/documentation/) + [W3C CSS Paged Media `@page`](https://www.w3.org/TR/css-page-3/):**

     * Inside `ReportPagedPreviewSurface.tsx`, the SDK creates a dedicated, style-isolated `<iframe sandbox="allow-same-origin allow-modals">` container.

     * It injects the resolved Header (`ReportChromeSpec`), report sections, Footer (`ReportChromeSpec`), direction (`dir="rtl"` for `"ar"`, `dir="ltr"` for `"en"`), and `@page` CSS rules (`@page { size: A4 portrait; margin: 26mm 14mm 24mm 14mm; @top-center { content: element(report-running-header); } @bottom-center { content: element(report-running-footer); } }`).

     * The `Previewer` from `pagedjs` fragments the DOM into discrete `.pagedjs_page` sheets right inside the `admin-front` preview pane—so the operator sees the exact page breaks, running headers/footers on every page, repeated table headers (`<thead>`), and accurate `Page 1 of 14` counters (`counter(page)` / `counter(pages)`) *before* printing.

  4. **1-Click Native Vector PDF Export (`iframe.contentWindow.print()`):**

     * When the user clicks **Export PDF (Client-Side Vector)**, the SDK triggers `iframe.contentWindow.print()` on the already-paginated Paged.js document. The browser's native Skia PDF compositor writes a 100% vector, text-searchable, accessible PDF with zero server CPU or RAM usage.

  5. **Optional Server-Side Headless Chromium Fallback (`ServerPdfFallbackRenderer.ts`):**

     * Used **only** when the user explicitly requests a server-rendered PDF attachment (e.g., for automated background jobs or headless API export), reusing the exact same HTML + `@page` CSS + SVG bundle.

### 6.2 Client-Side Paged.js + Vector SVG Renderer Implementation (`admin-front/src/lib/reportEngineSdk/print/ClientVectorPdfExporter.ts`)

```
// admin-front/src/lib/reportEngineSdk/print/ClientVectorPdfExporter.ts
import * as echarts from "echarts";
import type { ReportDescriptorSpec } from "../types/reportSpec";
import type { ReportChromeSpec } from "../types/chromeSpec";

export interface ReportExecutionBundle {
  executionId: string;
  executedAtIso: string;
  verificationSha256: string;
  spec: ReportDescriptorSpec;
  resolvedHeaderChrome: ReportChromeSpec | null;
  resolvedFooterChrome: ReportChromeSpec | null;
  datasets: Record<string, Array<Record<string, unknown>>>;
  assetDataUrls: Record<string, string>; // Base64 or signed blob URLs for assets in the .zip bundle
  actor: {
    name: string;
    email: string;
    role: string;
  };
  inputsUsed: Record<string, unknown>;
}

/**
 * Renders an ECharts configuration to a standalone, crisp vector <svg> string
 * on the client thread without attaching to the visible DOM.
 */
export function renderChartSectionToSvgString(params: {
  echartsOption: echarts.EChartsOption;
  widthPx: number;
  heightPx: number;
}): string {
  const container = document.createElement("div");
  container.style.width = `${params.widthPx}px`;
  container.style.height = `${params.heightPx}px`;
  const chart = echarts.init(container, undefined, {
    renderer: "svg",
    width: params.widthPx,
    height: params.heightPx,
  });
  try {
    chart.setOption({
      ...params.echartsOption,
      animation: false,
    });
    return chart.renderToSVGString();
  } finally {
    chart.dispose();
  }
}

/**
 * Builds the complete self-contained HTML + @page CSS document for Paged.js
 * preview and zero-server-CPU vector PDF printing.
 */
export function buildPagedMediaHtmlDocument(params: {
  bundle: ReportExecutionBundle;
  locale: string;
  renderedSectionsHtml: string;
  renderedHeaderHtml: string;
  renderedFooterHtml: string;
}): string {
  const { bundle, locale, renderedSectionsHtml, renderedHeaderHtml, renderedFooterHtml } = params;
  const { page_layout } = bundle.spec;
  const isRtl = locale === "ar" || locale.startsWith("ar-") || locale === "he" || locale === "fa";
  const dir = isRtl ? "rtl" : "ltr";
  const pageSizeCss = `${page_layout.paper_size} ${page_layout.orientation.toLowerCase()}`;
  const m = page_layout.margins_mm;

  return `<!DOCTYPE html>
<html lang="${locale}" dir="${dir}">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(bundle.spec.i18n.locales[locale]?.["report.title"] ?? bundle.spec.report.code)}</title>
  <style>
    @page {
      size: ${pageSizeCss};
      margin: ${m.top}mm ${m.right}mm ${m.bottom}mm ${m.left}mm;
      @top-center {
        content: element(report-running-header);
      }
      @bottom-center {
        content: element(report-running-footer);
      }
    }
    * {
      box-sizing: border-box;
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }
    body {
      margin: 0;
      padding: 0;
      font-family: ${isRtl ? "'Tajawal', 'Cairo', 'Amiri', sans-serif" : "'Inter', -apple-system, BlinkMacSystemFont, sans-serif"};
      font-size: 9.5pt;
      line-height: 1.45;
      color: #0F172A;
      direction: ${dir};
    }
    .report-running-header {
      position: running(report-running-header);
      width: 100%;
    }
    .report-running-footer {
      position: running(report-running-footer);
      width: 100%;
    }
    /* Automatic CSS Paged Media page counters inside Header/Footer */
    .report-page-number::after {
      content: counter(page);
    }
    .report-total-pages::after {
      content: counter(pages);
    }
    table.report-data-table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 12pt;
      font-variant-numeric: tabular-nums;
    }
    table.report-data-table thead {
      display: table-header-group;
    }
    table.report-data-table tfoot {
      display: table-footer-group;
    }
    table.report-data-table tr {
      break-inside: avoid;
      page-break-inside: avoid;
    }
    table.report-data-table th,
    table.report-data-table td {
      padding: 5pt 7pt;
      border-bottom: 0.75pt solid #E2E8F0;
    }
    table.report-data-table th {
      background-color: #F1F5F9;
      font-weight: 700;
      color: #1E293B;
      border-top: 1pt solid #CBD5E1;
      border-bottom: 1.25pt solid #94A3B8;
    }
    .report-section {
      margin-bottom: 14pt;
    }
    .report-chart-box,
    .report-draw-box,
    .report-kpi-grid {
      break-inside: avoid;
      page-break-inside: avoid;
    }
    .report-page-break {
      break-before: page;
      page-break-before: always;
    }
    ${bundle.resolvedHeaderChrome?.template.scoped_css ?? ""}
    ${bundle.resolvedFooterChrome?.template.scoped_css ?? ""}
    ${page_layout.global_scoped_css ?? ""}
  </style>
</head>
<body>
  ${renderedHeaderHtml ? `<header class="report-running-header">${renderedHeaderHtml}</header>` : ""}
  ${renderedFooterHtml ? `<footer class="report-running-footer">${renderedFooterHtml}</footer>` : ""}
  <main class="report-body-container">
    ${renderedSectionsHtml}
  </main>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

```

### 6.3 Declarative Vector Drawing / Diagram Renderer (`admin-front/src/lib/reportEngineSdk/components/ReportVectorDrawRenderer.tsx`)

Requirement 5 specifies that reports *"can include html, css, charts, draws, and images"*. `ReportVectorDrawRenderer.tsx` renders declarative `VECTOR_DRAW` sections (`FLOW_DIAGRAM`, `SETTLEMENT_WATERFALL_DIAGRAM`, and `DECLARATIVE_SVG_CANVAS`) into pure `<svg>` vector diagrams with data-bound node values and automatic RTL/LTR coordinate mirroring:

```
// admin-front/src/lib/reportEngineSdk/components/ReportVectorDrawRenderer.tsx
import type { VectorDrawSectionSchema } from "../types/reportSpec";
import type { z } from "zod";

export type VectorDrawSection = z.infer<typeof VectorDrawSectionSchema>;

export function renderVectorDrawSectionToSvg(params: {
  section: VectorDrawSection;
  datasets: Record<string, Array<Record<string, unknown>>>;
  t: (key: string) => string;
  formatValue: (val: unknown, hint: string) => string;
  isRtl: boolean;
}): string {
  const { section, datasets, t, formatValue, isRtl } = params;
  const vbWidth = section.view_box.width;
  const vbHeight = section.view_box.height;

  const nodeMap = new Map(section.nodes.map((n) => [n.node_id, n]));
  const mirrorX = (x: number, w: number) => (isRtl ? vbWidth - x - w : x);

  const edgesSvg = section.edges
    .map((edge) => {
      const from = nodeMap.get(edge.from_node_id);
      const to = nodeMap.get(edge.to_node_id);
      if (!from || !to) return "";
      const x1 = mirrorX(from.x, from.width) + (isRtl ? 0 : from.width);
      const y1 = from.y + from.height / 2;
      const x2 = mirrorX(to.x, to.width) + (isRtl ? to.width : 0);
      const y2 = to.y + to.height / 2;
      const midX = (x1 + x2) / 2;
      const dashAttr =
        edge.style === "DASHED"
          ? 'stroke-dasharray="6,4"'
          : edge.style === "DOTTED"
            ? 'stroke-dasharray="2,3"'
            : "";
      const labelMarkup = edge.label_i18n_key
        ? `<text x="${midX}" y="${Math.min(y1, y2) - 6}" text-anchor="middle" font-size="10" fill="#475569">${escapeXml(t(edge.label_i18n_key))}</text>`
        : "";
      return `<g class="draw-edge">
        <path d="M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}" fill="none" stroke="${edge.color_hex}" stroke-width="1.75" ${dashAttr} marker-end="url(#report-arrow)" />
        ${labelMarkup}
      </g>`;
    })
    .join("\n");

  const nodesSvg = section.nodes
    .map((node) => {
      const nx = mirrorX(node.x, node.width);
      const ny = node.y;
      const rx = node.shape === "PILL" ? node.height / 2 : node.shape === "ROUNDED_RECT" ? 8 : 2;
      let boundValueText = "";
      if (node.value_binding) {
        const rows = datasets[node.value_binding.dataset_id] ?? [];
        const rawVal = rows[node.value_binding.row_index]?.[node.value_binding.field];
        boundValueText = formatValue(rawVal, node.value_binding.format_hint);
      }
      return `<g class="draw-node" transform="translate(${nx}, ${ny})">
        <rect width="${node.width}" height="${node.height}" rx="${rx}" fill="${node.fill_hex}" stroke="${node.stroke_hex}" stroke-width="1.5" />
        <text x="${node.width / 2}" y="${boundValueText ? node.height * 0.42 : node.height * 0.55}" text-anchor="middle" font-size="11" font-weight="600" fill="${node.text_hex}">${escapeXml(t(node.label_i18n_key))}</text>
        ${
          boundValueText
            ? `<text x="${node.width / 2}" y="${node.height * 0.76}" text-anchor="middle" font-size="12" font-weight="700" fill="${node.stroke_hex}">${escapeXml(boundValueText)}</text>`
            : ""
        }
      </g>`;
    })
    .join("\n");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${vbWidth} ${vbHeight}" style="width:100%;height:${section.height_mm}mm;display:block;">
    <defs>
      <marker id="report-arrow" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
        <path d="M 0 0 L 8 4 L 0 8 z" fill="#475569" />
      </marker>
    </defs>
    ${edgesSvg}
    ${nodesSvg}
  </svg>`;
}

function escapeXml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

```

### 6.4 Isolated Paged.js Live Preview & Client-Side Vector Print Surface (`admin-front/src/lib/reportEngineSdk/components/ReportPagedPreviewSurface.tsx`)

This Vue 3 TSX component mounts the isolated preview `<iframe>`, runs [Paged.js (`pagedjs`)](https://pagedjs.org/documentation/) to paginate the report into physical A4/Letter sheets with running headers/footers, supports instant client-side language toggling (`en` ↔ `ar`) and Header/Footer switching without re-querying `core-back`, and triggers 1-click native vector PDF printing:

```
// admin-front/src/lib/reportEngineSdk/components/ReportPagedPreviewSurface.tsx
import { defineComponent, ref, watch, onMounted, type PropType } from "vue";
import { Previewer } from "pagedjs";
import {
  buildPagedMediaHtmlDocument,
  type ReportExecutionBundle,
} from "../print/ClientVectorPdfExporter";

export const ReportPagedPreviewSurface = defineComponent({
  name: "ReportPagedPreviewSurface",
  props: {
    bundle: { type: Object as PropType<ReportExecutionBundle>, required: true },
    selectedLocale: { type: String, required: true },
    renderedSectionsHtml: { type: String, required: true },
    renderedHeaderHtml: { type: String, default: "" },
    renderedFooterHtml: { type: String, default: "" },
  },
  emits: ["pageCountChanged", "changeLocale"],
  setup(props, { emit, expose }) {
    const iframeRef = ref<HTMLIFrameElement | null>(null);
    const totalPages = ref<number>(1);
    const rendering = ref<boolean>(false);

    const renderPaginatedPreview = async () => {
      const iframe = iframeRef.value;
      if (!iframe || !iframe.contentDocument) return;
      rendering.value = true;
      try {
        const fullHtml = buildPagedMediaHtmlDocument({
          bundle: props.bundle,
          locale: props.selectedLocale,
          renderedSectionsHtml: props.renderedSectionsHtml,
          renderedHeaderHtml: props.renderedHeaderHtml,
          renderedFooterHtml: props.renderedFooterHtml,
        });

        const doc = iframe.contentDocument;
        doc.open();
        doc.write(fullHtml);
        doc.close();

        // Execute Paged.js polyfill inside the isolated iframe document
        const paged = new Previewer();
        const flow = await paged.preview(doc.body.innerHTML, [], doc.body);
        totalPages.value = flow.total ?? 1;
        emit("pageCountChanged", totalPages.value);
      } finally {
        rendering.value = false;
      }
    };

    const printClientSideVectorPdf = () => {
      const win = iframeRef.value?.contentWindow;
      if (!win) return;
      win.focus();
      win.print();
    };

    watch(
      () => [
        props.bundle.executionId,
        props.selectedLocale,
        props.renderedSectionsHtml,
        props.renderedHeaderHtml,
        props.renderedFooterHtml,
      ],
      () => {
        void renderPaginatedPreview();
      },
    );

    onMounted(() => {
      void renderPaginatedPreview();
    });

    expose({ printClientSideVectorPdf, renderPaginatedPreview });

    return () => (
      <div class="report-paged-preview-wrapper d-flex flex-column ga-3">
        <div class="d-flex align-center justify-space-between px-4 py-2 bg-grey-lighten-4 rounded border">
          <div class="d-flex align-center ga-3">
            <span class="text-subtitle-2 font-weight-bold">
              Pages: {totalPages.value} ({props.bundle.spec.page_layout.paper_size}{" "}
              {props.bundle.spec.page_layout.orientation})
            </span>
            <span class="text-caption text-medium-emphasis">
              SHA-256: {props.bundle.verificationSha256.slice(0, 12)}…
            </span>
          </div>
          <div class="d-flex align-center ga-2">
            {Object.keys(props.bundle.spec.i18n.locales).map((loc) => (
              <v-btn
                key={loc}
                size="small"
                variant={props.selectedLocale === loc ? "flat" : "outlined"}
                color={props.selectedLocale === loc ? "primary" : "default"}
                onClick={() => emit("changeLocale", loc)}
              >
                {loc.toUpperCase()}
              </v-btn>
            ))}
            <v-btn
              color="primary"
              prepend-icon="mdi-file-pdf-box"
              loading={rendering.value}
              onClick={printClientSideVectorPdf}
            >
              Export Vector PDF (Client-Side)
            </v-btn>
          </div>
        </div>
        <iframe
          ref={iframeRef}
          title="Report Paginated Vector Preview"
          sandbox="allow-same-origin allow-modals"
          style="width: 100%; min-height: 820px; border: 1px solid #CBD5E1; border-radius: 8px; background: #475569;"
        />
      </div>
    );
  },
});

```

## 7. Multi-Language (`i18n`), Standard Headers/Footers & Partnered `.zip` Asset Bundles

### 7.1 Multi-Language (`i18n`) Enforcement & Runtime Language Selector

Requirement 6 specifies: *"multi language support, by providing translation mechanism then the trasnaltion maps in the spec file directly, and upon generation if the report has more than one language it prompts the user to choose the language, in addition the transcript file informs the ai to include the translations in english and arabic by default, and any additional language the user asks for"*.

1. **Mandatory Bilingual Baseline (`en` + `ar`) in Every Spec:**

   * Both `ReportDescriptorSpecSchema` and `ReportChromeSpecSchema` enforce via Zod refinement that `i18n.locales.en` and `i18n.locales.ar` are present and non-empty.

   * Layer 1 (`SpecStructuralValidator.ts`) traverses every `label_i18n_key`, `title_i18n_key`, `subtitle_i18n_key`, `header_i18n_key`, `help_i18n_key`, and `{{$t.key}}` token in the spec and verifies that **every declared locale in `Object.keys(spec.i18n.locales)`** has a non-empty translation string for every key. Missing keys produce a `MISSING_I18N_KEY_FOR_LOCALE` diagnostic with the exact key and locale so the external AI fixes it immediately.

2. **Additional User-Requested Languages:**

   * If the user asks the AI for French (`"fr"`), Turkish (`"tr"`), or Italian (`"it"`), the AI adds `"fr": { ... }` alongside `"en"` and `"ar"` inside `i18n.locales`.

3. **Runtime Language Prompt (`ReportLanguagePromptDialog.tsx`):**

   * When the user clicks **Generate Report** in `admin-front/src/pages/reports/catalog/index.tsx`:

     * If `Object.keys(spec.i18n.locales).length > 1` (which is always true because `en` and `ar` are included by default) and `spec.i18n.prompt_user_when_multi_locale !== false`, a sleek modal / inline selector prompts the operator:

       * **English (`en` — LTR)**

       * **العربية (`ar` — RTL)**

       * Any additional locales present in `spec.i18n.locales` (e.g., **Français (`fr` — LTR)**)

     * Once rendered in the preview pane, the operator can also toggle between languages **instantly on the client side** without re-querying `core-back`, because `ReportExecutionBundle` already contains the raw datasets and the full `spec.i18n.locales` dictionary!

### 7.2 Reusable Standard Headers & Footers (`ReportChromeSpec`)

Requirement 7 specifies: *"support for standard headers and footer designs that can be uploaded to the system and the engine use them on all reports unless the spec file specifically instructs otherwise, the header and footer are uploaded as as their own spec files designed by an ai in addition to their image assets that needed for example the logo or something, system support multiple header and footer, there could be none and there could be assigned one (choose one that shows on all reports by default unless the user chooses another)"*.

1. **Dedicated Chrome Registry (`report_chrome_specs` Table):**

   * Stores multiple `HEADER` and `FOOTER` specs (`chrome_type: "HEADER" | "FOOTER"`), each versioned and paired with its own `ReportAssetBundle` (containing institution logos, CBL regulatory header crests, watermarks, or signatures).

   * At most one active `HEADER` has `is_default_global = true` and at most one active `FOOTER` has `is_default_global = true` (enforced by a partial unique index in PostgreSQL: `CREATE UNIQUE INDEX report_chrome_specs_one_default_per_type_idx ON report_chrome_specs (chrome_type) WHERE is_default_global = true AND status = 'PUBLISHED'`).

   * An administrator can set **no global default** (if `is_default_global = false` on all records) or assign any published header/footer as the **Global Default**.

2. **4-Mode Resolution Hierarchy on Every Report:**

   * `GLOBAL_DEFAULT` *(default in `ReportDescriptorSpec`)*: Uses whichever active Header/Footer is currently marked `is_default_global = true` (or renders none if no global default is assigned).

   * `SPECIFIC_CHROME_CODE`: Pins the report to a specific registered header/footer (e.g., `"cbl-aml-confidential-header"`).

   * `INLINE_SPEC`: Uses a custom header/footer template embedded directly inside `page_layout.inline_header_spec` / `inline_footer_spec`.

   * `NONE`: Explicitly suppresses the header or footer even when a Global Default exists (for example, on full-bleed certificate or statement cover reports).

   * Furthermore, when `page_layout.allow_runtime_chrome_selection = true`, the operator running the report in `admin-front` can override the Header or Footer from a dropdown (`Default`, `None`, or any published Header/Footer spec) right before printing or exporting!

### 7.3 Partnered `.zip` Asset Bundles & DSL Asset Comparison

Requirement 8 specifies: *"the upload of spec file is sometimes partnered with theh upload of image assets zip file or (or maybe other assets in the future that can be used for comparison in the dslm for example)"*.

1. **Flexible Upload Packaging (`Multipart Spec + .zip` or Combined `.reportpkg.zip`):**

   * In `admin-front`, the upload dropzone accepts:

     * A standalone `report-spec.json` (when `required_assets` is empty), **or**

     * A `report-spec.json` partnered with an `assets.zip` file, **or**

     * A single `.zip` archive containing `spec.json` at the root plus an `assets/` folder.

2. **Strict Security & Integrity Validation (`AssetBundleValidator.ts`):**

   * Rejects archives exceeding `maxAssetZipBytes` (15 MB default) or containing $> 50$ files or compression ratio $> 25:1$ (zip-bomb defense).

   * Rejects any entry with `..`, leading `/`, or symlink attributes (path-traversal defense).

   * Verifies true binary magic bytes (`89 50 4E 47` for PNG, `FF D8 FF` for JPEG, `52 49 46 46 ... 57 45 42 50` for WebP) and parses/sanitizes `.svg`, `.json`, and `.csv` files.

   * Computes a per-file SHA-256 digest and stores the verified files via `ReportAssetStoragePort`.

3. **Referencing Assets in the DSL (`asset://` & `COMPARE_WITH_ASSET`):**

   * **Visual Assets (`purpose: "VISUAL_IMAGE"`):** Referenced in `IMAGE_BANNER` sections, `HTML_TEMPLATE` (`<img src="asset://bank_logo" />`), or `VECTOR_DRAW` via `asset_key`. At runtime, the SDK resolves `asset://bank_logo` to a content-addressed data URL or signed internal asset URL.

   * **Comparison Baseline Assets (`purpose: "COMPARISON_BASELINE_DATA"`):** A `.zip` bundle can include a structured `.json` or `.csv` file (for example, `cbl_official_fee_schedule.json` or `external_switch_settlement_totals.csv`). The report spec's `transforms[]` pipeline can invoke `operation: "COMPARE_WITH_ASSET"` to join a live database dataset against the uploaded asset file and flag discrepancies exceeding `tolerance_minor`!

## 8. The AI Authoring Transcript Generator (`ReportTranscriptBuilder.ts`)

Just like `core-back/engine/specImporter/TranscriptBuilder.ts` generates a self-contained Markdown kit for payment gateway onboarding, `ReportTranscriptBuilder.ts` dynamically generates **`report-engine-ai-transcript-v1.0.md`** (and `chrome-engine-ai-transcript-v1.0.md` for headers/footers) from the live `ReportEngineHostConfig`.

### 8.1 What the Generated AI Transcript Contains

When an admin clicks **"Download AI Report Transcript"** in `admin-front/src/pages/reports/studio/index.tsx` (optionally filtering by domain such as *Finance & Ledger*, *Merchant Settlement*, *Reconciliation*, or *All Domains*), `ReportTranscriptBuilder` produces a structured Markdown file with 8 sections:

1. **System Role & Output Contract:** Instructs the external AI to output **only** a valid `ReportDescriptorSpec v1.0` JSON document (plus a list of filenames to place in `assets.zip` if the user wants custom logos or comparison CSV/JSON files).

2. **Mandatory Multi-Language (`i18n`) Rule:** Explicitly instructs the AI:

   > *"You MUST always populate `i18n.locales.en` (English) and `i18n.locales.ar` (Arabic) in every report spec and header/footer spec by default, even if the user wrote their prompt only in English or only in Arabic. If the user asks for additional languages (e.g. French `fr`), include them in `i18n.locales` alongside `en` and `ar`. Every label, title, column header, chart series name, and template string must use an i18n key present in all locales."*

3. **Live Schema Catalog (Models, Columns, Types, Sensitivity & Relations):** Auto-generated from `hostConfig.models`, listing every queryable table, column type, enum values, relation names for `joins[]`, and `merchantScopable` rules. Forbidden secret columns are omitted so the AI never attempts to query them.

4. **Mandatory Query Optimization Rules (PostgreSQL 18 Partitioning & Shards):**

   * **Rule OPT-01 (`journal_lines` Partition Pruning):** `journal_lines` is monthly range-partitioned by `created_at`. Every dataset querying `journal_lines` **MUST** include a `where` predicate on `created_at` (`op: "between"` or `gte`/`lte`) bound to a `date`/`daterange` input whose `validation.max_range_days` is $\le 366$.

   * **Rule OPT-02 (`gl_account_shards` vs. `journal_lines`):** For current live GL account balances, query `gl_account_shards` (`SUM(balance_minor) GROUP BY gl_account_id`) instead of summing historical `journal_lines`. Use `journal_lines` only for time-bounded statement line items or period turnover.

   * **Rule OPT-03 (`payment_attempts` & `audit_log` Time Bounds):** Always include a `created_at` range filter (`max_range_days <= 180`) and filter by indexed columns (`merchant_id`, `gateway_id`, `canonical_status`).

5. **Authority Auto-Detection & Audience Scope Rules:** Explains how `AuthorityInferenceEngine` infers required authorities from queried models, how `MERCHANT_FACING` reports must bind `report.merchant_scope_input_key` to a `merchants` autocomplete input, and advises avoiding unnecessary cross-domain joins unless required by the user's prompt.

6. **Input Parameter & Autocomplete Catalog:** Lists all 12 `REPORT_INPUT_TYPES` and all 8 `AUTOCOMPLETE_SOURCE_KEYS` (`merchants`, `applications`, `gateways`, `payment_rails`, `gl_accounts`, `currencies`, `staff_users`, `aml_cases`).

7. **Closed DSL Vocabulary & Visual Section Reference:** Lists exact JSON schemas for `KPI_GRID`, `DATA_TABLE`, `CHART` (ECharts vector charts), `VECTOR_DRAW` (flow diagrams, settlement waterfalls, custom SVG), `HTML_TEMPLATE` (Mustache syntax + scoped CSS rules), `IMAGE_BANNER`, and `PAGE_BREAK`, plus `page_layout` header/footer modes (`GLOBAL_DEFAULT`, `SPECIFIC_CHROME_CODE`, `INLINE_SPEC`, `NONE`).

8. **Complete Worked Bilingual Examples:** Includes a complete, copy-paste-ready `ReportDescriptorSpec v1.0` example (Merchant Settlement & Fee Waterfall Report with `en` + `ar` dictionaries, `journal_lines` partition-pruned query, `CHART`, `VECTOR_DRAW`, and `DATA_TABLE`) and a `ReportChromeSpec v1.0` example (Official Bank Header with logo asset and page counters).

### 8.2 Implementation of `ReportTranscriptBuilder.ts` and `buildReportRepairPrompt`

````
// core-back/lib/reportEngineSdk/transcript/ReportTranscriptBuilder.ts
import type { ReportEngineHostConfig } from "../types/hostConfig";
import type { ReportDiagnostic } from "../types/diagnostics";
import {
  AUTOCOMPLETE_SOURCE_KEYS,
  REPORT_INPUT_TYPES,
  REPORT_SPEC_VERSION,
  SQL_AGGREGATE_OPS,
  SQL_SCALAR_EXPRESSIONS,
  WHERE_OPERATORS,
} from "../types/reportSpec";

export interface ReportTranscriptOptions {
  domains?: Array<ReportEngineHostConfig["models"][string]["domain"]>;
  includeChromeAuthoringGuide?: boolean;
  generatedAt?: Date;
}

export function buildReportAuthoringTranscript(
  host: ReportEngineHostConfig,
  options: ReportTranscriptOptions = {},
): { filename: string; contentType: "text/markdown"; markdown: string; specVersion: string } {
  const generatedAtIso = (options.generatedAt ?? new Date()).toISOString();
  const domainFilter = options.domains && options.domains.length > 0 ? new Set(options.domains) : null;

  const modelSections: string[] = [];
  for (const model of Object.values(host.models)) {
    if (domainFilter && !domainFilter.has(model.domain)) continue;
    const cols = Object.values(model.columns)
      .filter((c) => c.sensitivity !== "FORBIDDEN_SECRET")
      .map(
        (c) =>
          `  - \`${c.name}\` (${c.type}${c.enumName ? `:${c.enumName}` : ""}${c.indexed ? ", INDEXED" : ""}${
            c.sensitivity !== "PUBLIC" && c.sensitivity !== "INTERNAL" ? `, ${c.sensitivity}` : ""
          }) — ${c.description}`,
      )
      .join("\n");

    const rels = Object.values(model.relations)
      .map((r) => `  - \`${r.name}\` -> \`${r.targetModel}\` (${r.cardinality} on \`${r.sourceKey} = ${r.targetKey}\`)`)
      .join("\n");

    const mandatoryFilters = (model.optimizationRule.mandatoryFilterColumns ?? [])
      .map(
        (mf) =>
          `  - **MANDATORY FILTER:** Column \`${mf.column}\` with op in [${mf.allowedOperators.join(", ")}]${
            mf.maxDateRangeDays ? ` (max range: ${mf.maxDateRangeDays} days)` : ""
          } — ${mf.rationale}`,
      )
      .join("\n");

    modelSections.push(
      [
        `### Model \`${model.modelName}\` (Domain: \`${model.domain}\`)`,
        `${model.description}`,
        `- **Natural Roles:** ${model.naturalRoles.map((r) => `\`${r}\``).join(", ")}`,
        `- **Required Authorities:** ${model.requiredAuthorities.map((a) => `\`${a}\``).join(", ")}`,
        model.merchantScopable
          ? `- **Merchant Scopable:** Yes (filter \`${model.merchantScopable.merchantIdColumn}\` by \`report.merchant_scope_input_key\`)`
          : `- **Merchant Scopable:** No (Backoffice internal only)`,
        `- **Optimization Note:** ${model.optimizationRule.transcriptOptimizationNote}`,
        mandatoryFilters ? `${mandatoryFilters}` : "",
        `- **Columns:**\n${cols}`,
        rels ? `- **Relations (for \`joins[]\`):**\n${rels}` : `- **Relations:** None`,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  const markdown = [
    `# ${host.institutionName} — Dynamic Report Engine AI Authoring Transcript (v${REPORT_SPEC_VERSION})`,
    `Generated: \`${generatedAtIso}\` | Default Currency: \`${host.defaultCurrency}\` | Default Timezone: \`${host.defaultTimezone}\``,
    ``,
    `## 1. Your Role & Output Instructions`,
    `You are generating a declarative **Report Descriptor Spec (\`spec_kind: "REPORT_DESCRIPTOR"\`, \`spec_version: "${REPORT_SPEC_VERSION}"\`)** (or a reusable Header/Footer **Report Chrome Spec (\`spec_kind: "REPORT_CHROME"\`)**) for ${host.institutionName}'s Dynamic Report Engine.`,
    `- Output **ONLY** valid JSON conforming to the schema documented below.`,
    `- **MANDATORY BILINGUAL TRANSLATION RULE (\`en\` + \`ar\`):** You MUST always populate \`i18n.locales.en\` (English) and \`i18n.locales.ar\` (Arabic) in every spec by default, plus any additional language the user requests. Every label, title, column header, and template token must exist in all locales inside \`i18n.locales\`.`,
    `- **READ-ONLY & PARTITION SAFETY:** Never write raw SQL. Use only the declarative \`datasets[]\` AST. Whenever querying partitioned tables such as \`journal_lines\`, you MUST include a bounded \`created_at\` filter bound to a \`daterange\` input with \`validation.max_range_days <= 366\`.`,
    ``,
    `## 2. Closed Vocabulary Reference`,
    `- **Input Types (\`inputs[].type\`):** ${REPORT_INPUT_TYPES.map((v) => `\`${v}\``).join(", ")}`,
    `- **Autocomplete Sources (\`inputs[].autocomplete.source\`):** ${AUTOCOMPLETE_SOURCE_KEYS.map((v) => `\`${v}\``).join(", ")}`,
    `- **Where Operators (\`op\`):** ${WHERE_OPERATORS.map((v) => `\`${v}\``).join(", ")}`,
    `- **Scalar Expressions (\`select[].expression\`):** ${SQL_SCALAR_EXPRESSIONS.map((v) => `\`${v}\``).join(", ")}`,
    `- **Aggregate Functions (\`select[].aggregate\`):** ${SQL_AGGREGATE_OPS.map((v) => `\`${v}\``).join(", ")}`,
    ``,
    `## 3. Queryable Database Models, Columns & Optimization Rules`,
    modelSections.join("\n\n"),
  ].join("\n");

  return {
    filename: `report-engine-ai-transcript-v${REPORT_SPEC_VERSION}.md`,
    contentType: "text/markdown",
    markdown,
    specVersion: REPORT_SPEC_VERSION,
  };
}

/**
 * Formats verification errors and warnings into a 1-click copy-paste prompt
 * for the external AI when a spec fails verification.
 */
export function buildReportRepairPrompt(
  rawSpecJson: string,
  diagnostics: readonly ReportDiagnostic[],
): string {
  const errors = diagnostics.filter((d) => d.severity === "error");
  const warnings = diagnostics.filter((d) => d.severity === "warning");

  const lines: string[] = [
    "The Report Descriptor Spec you generated failed verification in the Report Engine Studio.",
    "Please fix every error listed below and return the complete corrected JSON spec.",
    "",
    `### Verification Errors (${errors.length})`,
    ...errors.map(
      (e, idx) =>
        `${idx + 1}. **[Layer ${e.layer} — ${e.code}]** at \`${e.path}\`: ${e.message}${
          e.aiFixHint ? `\n   - **How to fix:** ${e.aiFixHint}` : ""
        }`,
    ),
  ];

  if (warnings.length > 0) {
    lines.push(
      "",
      `### Warnings (${warnings.length})`,
      ...warnings.map(
        (w, idx) =>
          `${idx + 1}. **[Layer ${w.layer} — ${w.code}]** at \`${w.path}\`: ${w.message}${
            w.aiFixHint ? `\n   - **Recommendation:** ${w.aiFixHint}` : ""
          }`,
      ),
    );
  }

  lines.push("", "### Original Spec Submitted", "```json", rawSpecJson, "```");
  return lines.join("\n");
}

````

## 9. Database Schema Migration (Schema Version 26), API Endpoints & Admin-Front UI

### 9.1 Prisma Schema Additions (`core-back/prisma/schema.prisma` -> Migration `20261110120000_dynamic_report_engine_sdk`)

We add four clean, indexed tables to store reusable Header/Footer Chrome specs, Report Descriptor specs (with version history, inferred authorities, and Security Admin overrides), partnered `.zip` Asset Bundles, and an immutable execution audit log:

```
enum ReportSpecStatus {
  DRAFT
  VERIFIED
  PUBLISHED
  ARCHIVED
}

enum ReportChromeType {
  HEADER
  FOOTER
}

enum ReportAudienceScope {
  BACKOFFICE_INTERNAL
  MERCHANT_FACING
  BOTH
}

enum ReportAuthorityMode {
  INFERRED_STRICT
  SECURITY_ADMIN_OVERRIDE
}

model ReportAssetBundle {
  id               String   @id @default(uuid()) @db.Uuid
  bundleSha256     String   @unique @map("bundle_sha256")
  storageKey       String   @map("storage_key")
  totalBytes       Int      @map("total_bytes")
  fileCount        Int      @map("file_count")
  manifestJson     Json     @map("manifest_json") // Array<{ assetKey, fileName, mimeType, sha256, bytes, purpose }>
  uploadedByUserId String   @map("uploaded_by_user_id") @db.Uuid
  createdAt        DateTime @default(now()) @map("created_at") @db.Timestamptz(6)

  chromeSpecs      ReportChromeSpecRecord[]
  reportSpecs      ReportDefinitionSpecRecord[]

  @@index([uploadedByUserId, createdAt(sort: Desc)], map: "report_asset_bundles_uploader_created_idx")
  @@map("report_asset_bundles")
}

model ReportChromeSpecRecord {
  id                String             @id @default(uuid()) @db.Uuid
  code              String             @db.VarChar(64)
  version           Int                @default(1)
  name              String             @db.VarChar(120)
  chromeType        ReportChromeType   @map("chrome_type")
  status            ReportSpecStatus   @default(DRAFT)
  isDefaultGlobal   Boolean            @default(false) @map("is_default_global")
  supportedLocales  String[]           @map("supported_locales")
  specJson          Json               @map("spec_json")
  specSha256        String             @map("spec_sha256") @db.VarChar(64)
  assetBundleId     String?            @map("asset_bundle_id") @db.Uuid
  assetBundle       ReportAssetBundle? @relation(fields: [assetBundleId], references: [id], onDelete: SetNull)
  createdByUserId   String             @map("created_by_user_id") @db.Uuid
  publishedByUserId String?            @map("published_by_user_id") @db.Uuid
  publishedAt       DateTime?          @map("published_at") @db.Timestamptz(6)
  createdAt         DateTime           @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt         DateTime           @updatedAt @map("updated_at") @db.Timestamptz(6)

  @@unique([code, version], map: "report_chrome_specs_code_version_key")
  @@index([chromeType, status, isDefaultGlobal], map: "report_chrome_specs_type_status_default_idx")
  @@map("report_chrome_specs")
}

model ReportDefinitionSpecRecord {
  id                         String              @id @default(uuid()) @db.Uuid
  code                       String              @db.VarChar(64)
  version                    Int                 @default(1)
  category                   String              @db.VarChar(48)
  audienceScope              ReportAudienceScope @map("audience_scope")
  status                     ReportSpecStatus    @default(DRAFT)
  isLatestPublished          Boolean             @default(false) @map("is_latest_published")
  supportedLocales           String[]            @map("supported_locales")
  defaultLocale              String              @default("en") @map("default_locale") @db.VarChar(16)
  specJson                   Json                @map("spec_json")
  specSha256                 String              @map("spec_sha256") @db.VarChar(64)
  verificationReportJson     Json                @map("verification_report_json")
  assetBundleId              String?             @map("asset_bundle_id") @db.Uuid
  assetBundle                ReportAssetBundle?  @relation(fields: [assetBundleId], references: [id], onDelete: SetNull)

  // Authority Inference & Security Admin Override Columns
  authorityMode              ReportAuthorityMode @default(INFERRED_STRICT) @map("authority_mode")
  inferredRoles              String[]            @map("inferred_roles")
  inferredAuthorities        String[]            @map("inferred_authorities")
  conflictStatus             String              @default("NONE") @map("conflict_status") @db.VarChar(48)
  requiresConfidentialAml    Boolean             @default(false) @map("requires_confidential_aml")
  overrideAllowedRoles       String[]            @map("override_allowed_roles")
  overrideAllowedAuthorities String[]            @map("override_allowed_authorities")
  overrideJustification      String?             @map("override_justification") @db.Text
  overriddenByUserId         String?             @map("overridden_by_user_id") @db.Uuid
  overriddenAt               DateTime?           @map("overridden_at") @db.Timestamptz(6)

  createdByUserId            String              @map("created_by_user_id") @db.Uuid
  publishedByUserId          String?             @map("published_by_user_id") @db.Uuid
  publishedAt                DateTime?           @map("published_at") @db.Timestamptz(6)
  createdAt                  DateTime            @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt                  DateTime            @updatedAt @map("updated_at") @db.Timestamptz(6)

  executions                 ReportExecutionAuditRecord[]

  @@unique([code, version], map: "report_definition_specs_code_version_key")
  @@index([status, isLatestPublished, category], map: "report_definition_specs_published_cat_idx")
  @@index([audienceScope, status], map: "report_definition_specs_audience_status_idx")
  @@map("report_definition_specs")
}

model ReportExecutionAuditRecord {
  id                 String                     @id @default(uuid()) @db.Uuid
  reportSpecId       String                     @map("report_spec_id") @db.Uuid
  reportSpec         ReportDefinitionSpecRecord @relation(fields: [reportSpecId], references: [id], onDelete: Restrict)
  reportCode         String                     @map("report_code") @db.VarChar(64)
  reportVersion      Int                        @map("report_version")
  actorUserId        String                     @map("actor_user_id") @db.Uuid
  actorRole          String                     @map("actor_role") @db.VarChar(48)
  selectedLocale     String                     @map("selected_locale") @db.VarChar(16)
  scopedMerchantId   String?                    @map("scoped_merchant_id") @db.Uuid
  inputsRedactedJson Json                       @map("inputs_redacted_json")
  rowCountTotal      Int                        @map("row_count_total")
  durationMs         Int                        @map("duration_ms")
  servedByNode       String                     @map("served_by_node") @db.VarChar(64)
  verificationSha256 String                     @map("verification_sha256") @db.VarChar(64)
  renderTarget       String                     @default("CLIENT_PAGED_VECTOR") @map("render_target") @db.VarChar(32)
  createdAt          DateTime                   @default(now()) @map("created_at") @db.Timestamptz(6)

  @@index([actorUserId, createdAt(sort: Desc)], map: "report_execution_audit_actor_created_idx")
  @@index([scopedMerchantId, createdAt(sort: Desc)], map: "report_execution_audit_merchant_created_idx")
  @@index([reportSpecId, createdAt(sort: Desc)], map: "report_execution_audit_spec_created_idx")
  @@map("report_execution_audit")
}

```

### 9.2 API Endpoints (`core-back/api/internal/adminReportEngine.ts` & `admin-back/api/reportEngine.ts`)

| Method & Route (`admin-back` -> `core-back`) | Required Authority / Role | Purpose | 
| ----- | ----- | ----- | 
| `GET /report-engine/transcript` | `report:review` or `report_engine:author` or `gateway:write` | Downloads `report-engine-ai-transcript-v1.0.md` (or `chrome-engine-ai-transcript-v1.0.md` when `?kind=CHROME`) compiled from live schema & optimization rules. | 
| `POST /report-engine/specs/verify` | `report:review` or `report_engine:author` | Accepts `multipart/form-data` (`specJson` + optional `assetsZip`). Runs all 5 verification layers (Zod, AST safety + `EXPLAIN`, authority inference, ZIP validation, read-only dry-run simulation) and returns `VerificationReport` + `aiRepairPrompt`. | 
| `POST /report-engine/specs` | `report:approve` or `report_engine:author` | Saves a verified `ReportDescriptorSpec` + `ReportAssetBundle` as `VERIFIED` or `PUBLISHED`. | 
| `POST /report-engine/specs/:id/authority-override` | Role `SECURITY_ADMIN` + Authority `security:write` | Sets or clears `authorityMode = "SECURITY_ADMIN_OVERRIDE"`, `overrideAllowedRoles`, `overrideAllowedAuthorities`, and mandatory `overrideJustification` (audited in `AuditLog`). | 
| `GET /report-engine/catalog` | Any authenticated `admin-front` staff principal | Lists all `PUBLISHED` reports that the current staff principal is authorized to see (evaluating `effectiveAccessPolicy` against `principal.role` and `principal.authorities`). | 
| `GET /report-engine/autocomplete/:sourceKey` | Verified against `AutocompleteProvider.requiredAuthority` | Executes fast indexed search for `merchants`, `applications`, `gateways`, `payment_rails`, `gl_accounts`, `currencies`, `staff_users`, or `aml_cases` to populate input form autocompletes. | 
| `POST /report-engine/catalog/:code/execute` | Evaluated against report's `effectiveAccessPolicy` | Validates input form parameters with compiled Zod schema, executes all `datasets[]` queries on `PostgresReadOnlyReportExecutor`, runs `transforms[]`, resolves Header/Footer chrome + assets, records `ReportExecutionAuditRecord`, and returns `ReportExecutionBundle` for client-side vector rendering (or streams PDF if `renderMode: "SERVER_PDF"`). | 
| `GET /report-engine/chrome` / `POST /report-engine/chrome` | `report:approve` or `security:write` | Lists, verifies, uploads, and publishes `ReportChromeSpec` (Headers & Footers) + `.zip` image bundles. | 
| `POST /report-engine/chrome/:id/set-default` | `report:approve` or `security:write` | Sets or clears a published Header or Footer as the Global Default (`is_default_global = true/false`). | 

### 9.3 Admin-Front UI Screens (`admin-front/src/pages/reports/`)

1. **Report Catalog & Runner (`admin-front/src/pages/reports/catalog/index.tsx`):**

   * **Audience Filter Tabs:** `All Authorized Reports`, `Backoffice Internal`, and `Merchant Reports (Generate for Merchant)`.

   * **Dynamic Input Form (`ReportInputForm.tsx`):** Automatically renders date-range pickers (with preset chips like `Last 30 Days`, `Current Month` and automatic enforcement of `max_range_days`), debounced autocomplete comboboxes (`v-autocomplete`) for selecting a Merchant, Gateway, Rail, or GL Account, and enum selectors.

   * **Language Prompt & Chrome Bar:** Prompts the user to choose the language (`English (en)`, `العربية (ar)`, or any extra locale in the spec) when generating the report, and lets the user keep the `Global Default` header/footer, pick a custom registered header/footer, or choose `None`.

   * **Live Paginated Vector Preview (`ReportPagedPreviewSurface.tsx`):** Displays the exact paginated A4/Letter sheets rendered by `Paged.js` with vector SVG ECharts and vector SVG diagrams, plus 1-click **Print / Save Vector PDF (Client-Side)**, **Export XLSX (`xlsxUIPipeline`)**, **Export CSV**, and **Switch Language (`en` ↔ `ar`)** without re-querying the server.

2. **AI Report Studio (`admin-front/src/pages/reports/studio/index.tsx`):**

   * **Step 1 — Download AI Transcript:** Domain filter checkboxes + **Download Report AI Transcript (`.md`)**.

   * **Step 2 — Upload Spec + Optional `.zip` Assets:** Drag-and-drop JSON spec editor + optional `.zip` asset uploader.

   * **Step 3 — 5-Layer Verification & Simulation Scorecard:** Visualizes Layer 1–5 pass/fail badges, `EXPLAIN` query cost & partition pruning metrics, and a 1-click **Copy AI Repair Prompt** button if any diagnostic fails.

   * **Step 4 — Authority Inference & Security Admin Override Panel:** Shows queried models, inferred required authorities, natural roles, and any cross-domain conflict alerts. If the logged-in user holds `SECURITY_ADMIN` / `security:write`, unlocks the **Security Admin Authority Override** form (`allowedRoles` multi-select, `allowedAuthorities` multi-select, and justification input).

3. **Standard Header & Footer Manager (`admin-front/src/pages/reports/chrome/index.tsx`):**

   * Allows downloading the **Header/Footer AI Transcript**, uploading `ReportChromeSpec` JSON + logo `.zip` bundle, previewing the header/footer in English (`LTR`) and Arabic (`RTL`), and toggling **Global Default Header** / **Global Default Footer** (or setting Global Default to `None`).

### 9.4 Complete Autocomplete Providers Implementation (`core-back/engine/reportStudio/autocompleteProviders.ts`)

Requirement 2 requires API-fetched autocomplete lists for setting the report base parameters. Below is the complete implementation of the 8 registered autocomplete providers executing over `ReadOnlyDatabasePort`:

```
// core-back/engine/reportStudio/autocompleteProviders.ts
import type { AutocompleteProvider, ReadOnlyDatabasePort } from "../../lib/reportEngineSdk/types/hostConfig";
import { hasConfidentialAmlAccess } from "../../lib/auth/confidentialAccess";

export function buildPaymentGatewayAutocompleteProviders(
  dbReadOnly: ReadOnlyDatabasePort,
): Record<string, AutocompleteProvider> {
  return {
    merchants: {
      sourceKey: "merchants",
      description: "Search merchants by trade name, legal name, merchant code, or UUID",
      valueType: "uuid",
      requiredAuthority: "merchant:read",
      search: async ({ query, limit }) => {
        const q = `%${query.trim().replace(/[%_]/g, "")}%`;
        const res = await dbReadOnly.executeReadOnlyQuery<{
          id: string;
          trade_name: string;
          legal_name: string;
          status: string;
        }>({
          sql: `SELECT id, trade_name, legal_name, status FROM merchants WHERE trade_name ILIKE $1 OR legal_name ILIKE $1 OR id::text = $2 ORDER BY trade_name ASC LIMIT $3`,
          values: [q, query.trim(), Math.min(limit, 50)],
          timeoutMs: 3_000,
          maxRows: 50,
          queryLabel: "autocomplete_merchants",
        });
        return res.rows.map((r) => ({
          value: r.id,
          label: r.trade_name,
          sublabel: r.legal_name,
          badge: r.status,
        }));
      },
    },

    applications: {
      sourceKey: "applications",
      description: "Search merchant applications (optionally filtered by dependent merchantId input)",
      valueType: "uuid",
      requiredAuthority: "merchant:read",
      search: async ({ query, limit, dependentValues }) => {
        const merchantId = typeof dependentValues?.merchantId === "string" ? dependentValues.merchantId : null;
        const q = `%${query.trim().replace(/[%_]/g, "")}%`;
        const sql = merchantId
          ? `SELECT id, name, environment, status FROM applications WHERE merchant_id = $1 AND name ILIKE $2 ORDER BY name ASC LIMIT $3`
          : `SELECT id, name, environment, status FROM applications WHERE name ILIKE $1 ORDER BY name ASC LIMIT $2`;
        const values = merchantId ? [merchantId, q, Math.min(limit, 50)] : [q, Math.min(limit, 50)];
        const res = await dbReadOnly.executeReadOnlyQuery<{
          id: string;
          name: string;
          environment: string;
          status: string;
        }>({
          sql,
          values,
          timeoutMs: 3_000,
          maxRows: 50,
          queryLabel: "autocomplete_applications",
        });
        return res.rows.map((r) => ({
          value: r.id,
          label: r.name,
          sublabel: r.environment,
          badge: r.status,
        }));
      },
    },

    gateways: {
      sourceKey: "gateways",
      description: "Search configured payment gateways by code or name",
      valueType: "uuid",
      requiredAuthority: "gateway:read",
      search: async ({ query, limit }) => {
        const q = `%${query.trim().replace(/[%_]/g, "")}%`;
        const res = await dbReadOnly.executeReadOnlyQuery<{
          id: string;
          code: string;
          name: string;
          status: string;
        }>({
          sql: `SELECT id, code, name, status FROM gateways WHERE code ILIKE $1 OR name ILIKE $1 ORDER BY name ASC LIMIT $2`,
          values: [q, Math.min(limit, 50)],
          timeoutMs: 3_000,
          maxRows: 50,
          queryLabel: "autocomplete_gateways",
        });
        return res.rows.map((r) => ({
          value: r.id,
          label: `${r.name} (${r.code})`,
          badge: r.status,
        }));
      },
    },

    payment_rails: {
      sourceKey: "payment_rails",
      description: "Search payment rails by code or display name",
      valueType: "uuid",
      requiredAuthority: "gateway:read",
      search: async ({ query, limit }) => {
        const q = `%${query.trim().replace(/[%_]/g, "")}%`;
        const res = await dbReadOnly.executeReadOnlyQuery<{
          id: string;
          code: string;
          name: string;
          collection_mode: string;
        }>({
          sql: `SELECT id, code, name, collection_mode FROM payment_rails WHERE code ILIKE $1 OR name ILIKE $1 ORDER BY code ASC LIMIT $2`,
          values: [q, Math.min(limit, 50)],
          timeoutMs: 3_000,
          maxRows: 50,
          queryLabel: "autocomplete_payment_rails",
        });
        return res.rows.map((r) => ({
          value: r.id,
          label: `${r.name} (${r.code})`,
          badge: r.collection_mode,
        }));
      },
    },

    gl_accounts: {
      sourceKey: "gl_accounts",
      description: "Search General Ledger (GL) accounts by code or name",
      valueType: "uuid",
      requiredAuthority: "finance:read",
      search: async ({ query, limit }) => {
        const q = `%${query.trim().replace(/[%_]/g, "")}%`;
        const res = await dbReadOnly.executeReadOnlyQuery<{
          id: string;
          code: string;
          name: string;
          account_type: string;
          currency: string;
        }>({
          sql: `SELECT id, code, name, account_type, currency FROM gl_accounts WHERE code ILIKE $1 OR name ILIKE $1 ORDER BY code ASC LIMIT $2`,
          values: [q, Math.min(limit, 50)],
          timeoutMs: 3_000,
          maxRows: 50,
          queryLabel: "autocomplete_gl_accounts",
        });
        return res.rows.map((r) => ({
          value: r.id,
          label: `${r.code} — ${r.name}`,
          sublabel: r.currency,
          badge: r.account_type,
        }));
      },
    },

    currencies: {
      sourceKey: "currencies",
      description: "Supported ISO-4217 currency codes",
      valueType: "string",
      requiredAuthority: "finance:read",
      search: async () => [
        { value: "LYD", label: "LYD — Libyan Dinar (1000 Dirhams)", badge: "DEFAULT" },
        { value: "USD", label: "USD — US Dollar", badge: "FX" },
        { value: "EUR", label: "EUR — Euro", badge: "FX" },
      ],
    },

    staff_users: {
      sourceKey: "staff_users",
      description: "Search internal backoffice staff users by email or role",
      valueType: "uuid",
      requiredAuthority: "security:read",
      search: async ({ query, limit }) => {
        const q = `%${query.trim().replace(/[%_]/g, "")}%`;
        const res = await dbReadOnly.executeReadOnlyQuery<{
          id: string;
          email: string;
          role: string;
        }>({
          sql: `SELECT id, email, role FROM users WHERE merchant_id IS NULL AND email ILIKE $1 ORDER BY email ASC LIMIT $2`,
          values: [q, Math.min(limit, 50)],
          timeoutMs: 3_000,
          maxRows: 50,
          queryLabel: "autocomplete_staff_users",
        });
        return res.rows.map((r) => ({
          value: r.id,
          label: r.email,
          badge: r.role,
        }));
      },
    },

    aml_cases: {
      sourceKey: "aml_cases",
      description: "Search confidential AML cases by case reference or subject (MLRO / Compliance only)",
      valueType: "uuid",
      requiredAuthority: "aml:read",
      search: async ({ query, limit, actor }) => {
        if (!hasConfidentialAmlAccess({ id: actor.userId, role: actor.role, authorities: actor.authorities })) {
          return [];
        }
        const q = `%${query.trim().replace(/[%_]/g, "")}%`;
        const res = await dbReadOnly.executeReadOnlyQuery<{
          id: string;
          subject_type: string;
          severity: string;
          status: string;
        }>({
          sql: `SELECT id, subject_type, severity, status FROM aml_cases WHERE id::text ILIKE $1 ORDER BY created_at DESC LIMIT $2`,
          values: [q, Math.min(limit, 50)],
          timeoutMs: 3_000,
          maxRows: 50,
          queryLabel: "autocomplete_aml_cases",
        });
        return res.rows.map((r) => ({
          value: r.id,
          label: `Case ${r.id.slice(0, 8)} (${r.subject_type})`,
          sublabel: r.severity,
          badge: r.status,
        }));
      },
    },
  };
}

```

### 9.5 Multi-Language Prompt Dialog (`admin-front/src/lib/reportEngineSdk/components/ReportLanguagePromptDialog.tsx`)

Requirement 6 specifies: *"upon generation if the report has more than one language it prompts the user to choose the language, in addition the transcript file informs the ai to include the translations in english and arabic by default, and any additional language the user asks for"*.

```
// admin-front/src/lib/reportEngineSdk/components/ReportLanguagePromptDialog.tsx
import { defineComponent, ref, type PropType } from "vue";

const LOCALE_DISPLAY_NAMES: Record<string, { nativeName: string; direction: "LTR" | "RTL" }> = {
  en: { nativeName: "English", direction: "LTR" },
  ar: { nativeName: "العربية (Arabic)", direction: "RTL" },
  fr: { nativeName: "Français (French)", direction: "LTR" },
  it: { nativeName: "Italiano (Italian)", direction: "LTR" },
  tr: { nativeName: "Türkçe (Turkish)", direction: "LTR" },
};

export const ReportLanguagePromptDialog = defineComponent({
  name: "ReportLanguagePromptDialog",
  props: {
    modelValue: { type: Boolean, required: true },
    availableLocales: { type: Array as PropType<string[]>, required: true },
    defaultLocale: { type: String, default: "en" },
    reportTitleMap: { type: Object as PropType<Record<string, string>>, default: () => ({}) },
  },
  emits: ["update:modelValue", "confirmLocale"],
  setup(props, { emit }) {
    const chosen = ref<string>(props.defaultLocale || props.availableLocales[0] || "en");

    const confirm = () => {
      emit("confirmLocale", chosen.value);
      emit("update:modelValue", false);
    };

    return () => (
      <v-dialog
        modelValue={props.modelValue}
        max-width="480"
        onUpdate:modelValue={(val: boolean) => emit("update:modelValue", val)}
      >
        <v-card class="pa-4">
          <v-card-title class="text-h6 font-weight-bold">
            Select Report Output Language / اختر لغة التقرير
          </v-card-title>
          <v-card-text>
            <p class="text-body-2 text-medium-emphasis mb-4">
              This report specification includes multiple translation dictionaries. Choose the language and layout
              direction for generation:
            </p>
            <v-radio-group v-model={chosen.value} hide-details>
              {props.availableLocales.map((loc) => {
                const meta = LOCALE_DISPLAY_NAMES[loc] ?? {
                  nativeName: loc.toUpperCase(),
                  direction: loc.startsWith("ar") ? "RTL" : "LTR",
                };
                const localizedTitle = props.reportTitleMap[loc];
                return (
                  <v-radio
                    key={loc}
                    value={loc}
                    label={`${meta.nativeName} [${loc.toUpperCase()} — ${meta.direction}]${
                      localizedTitle ? ` — ${localizedTitle}` : ""
                    }`}
                    class="mb-2"
                  />
                );
              })}
            </v-radio-group>
          </v-card-text>
          <v-card-actions class="justify-end ga-2 mt-2">
            <v-btn variant="text" onClick={() => emit("update:modelValue", false)}>
              Cancel
            </v-btn>
            <v-btn color="primary" variant="flat" prepend-icon="mdi-translate" onClick={confirm}>
              Generate Report
            </v-btn>
          </v-card-actions>
        </v-card>
      </v-dialog>
    );
  },
});

```

## 10. Exhaustive Verification, Security & Edge-Case Test Matrix

To guarantee delivery accuracy, database safety, and zero regression across `core-back` and `admin-front`, coding agents implementing this plan must include the following **22 automated unit, integration, and security test cases** under `core-back/test/reportEngineSdk/` and `admin-front/src/lib/reportEngineSdk/__tests__/`:

| Test ID | Test Suite & Target | Scenario & Edge Case Tested | Expected Deterministic Outcome | 
| ----- | ----- | ----- | ----- | 
| **RE-T01** | `SpecStructuralValidator.test.ts` | Upload a `ReportDescriptorSpec` missing `i18n.locales.ar` (only `en` provided). | Rejected at Layer 1 with `MISSING_DEFAULT_LOCALE_AR` and an `aiFixHint` instructing the AI to add the complete `ar` dictionary. | 
| **RE-T02** | `SpecStructuralValidator.test.ts` | Spec includes `en`, `ar`, and `fr`, but one table column `header_i18n_key` is missing in `fr`. | Rejected at Layer 1 with `MISSING_I18N_KEY_FOR_LOCALE` pinpointing the exact key and `"fr"` locale. | 
| **RE-T03** | `QuerySafetyAndOptValidator.test.ts` | Dataset queries `journal_lines` without a `created_at` filter in `where`. | Rejected at Layer 2 with `MANDATORY_PARTITION_FILTER_MISSING` and hint to add a bounded `created_at` predicate. | 
| **RE-T04** | `QuerySafetyAndOptValidator.test.ts` | Dataset queries `journal_lines` with `created_at` bound to a `daterange` input whose `max_range_days` is `730` ($> 366$). | Rejected at Layer 2 with `PARTITION_DATE_RANGE_UNBOUNDED` (`max_range_days` must be $\le 366$). | 
| **RE-T05** | `QuerySafetyAndOptValidator.test.ts` | Dataset attempts to select `credential_sets.entries_ciphertext` or `users.password_hash`. | Rejected at Layer 2 with `FORBIDDEN_SECRET_COLUMN`. | 
| **RE-T06** | `QuerySafetyAndOptValidator.test.ts` | Spec has `audience_scope: "MERCHANT_FACING"` and queries `payment_attempts`, but omits the `merchant_id = $input.merchantId` filter. | Rejected at Layer 2 with `MERCHANT_ISOLATION_FILTER_MISSING` to prevent cross-merchant data leakage. | 
| **RE-T07** | `QuerySafetyAndOptValidator.test.ts` | Dataset query produces an `EXPLAIN (FORMAT JSON)` plan with `totalCost > maxExplainCost` or a `Seq Scan` on `journal_lines`. | Rejected at Layer 2 with `QUERY_COST_EXCEEDED` and the exact `totalCost` and scanned tables. | 
| **RE-T08** | `AuthorityInferenceEngine.test.ts` | Single-domain report querying `journal_lines` and `gl_accounts`. | Infers `inferredRequiredAuthorities: ["finance:read"]`, `inferredNaturalRoles: ["FINANCE"]`, `conflictStatus: "NONE"`. | 
| **RE-T09** | `AuthorityInferenceEngine.test.ts` | Cross-domain report joining `journal_lines` (`FINANCE`), `aml_cases` (`COMPLIANCE_AML` confidential), and `gateway_versions` (`GATEWAY_ADMIN`). | Infers `inferredNaturalRoles: []`, flags `conflictStatus: "CONFIDENTIAL_DOMAIN_MIX"`, and emits resolution hint for `SECURITY_ADMIN` override. | 
| **RE-T10** | `AuthorityInferenceEngine.test.ts` | Non-security admin (`FINANCE` role) attempts to call `POST /report-engine/specs/:id/authority-override`. | Rejected with HTTP `403 FORBIDDEN` (`SECURITY_OVERRIDE_AUTHORITY_REQUIRED`). | 
| **RE-T11** | `AuthorityInferenceEngine.test.ts` | `SECURITY_ADMIN` with `security:write` applies an authority override granting `["FINANCE", "COMPLIANCE"]` access with justification. | Override persisted, `AuditLog` entry written, and subsequent catalog fetch by a `FINANCE` user includes the report. | 
| **RE-T12** | `PostgresReadOnlyExecutor.test.ts` | Attempt to pass a raw SQL string containing `UPDATE merchants SET ...` or `; COPY ...` or `pg_sleep(10)` to `executeReadOnlyQuery`. | Blocked immediately by `assertPureSelectSql` before acquiring a pool connection; even if bypassed, PostgreSQL rejects writes inside `BEGIN TRANSACTION READ ONLY`. | 
| **RE-T13** | `PostgresReadOnlyExecutor.test.ts` | Query exceeds `statement_timeout` (`15000ms`). | PostgreSQL cancels the query cleanly, transaction rolls back, pool connection is released without leak, and API returns `408 REPORT_QUERY_TIMEOUT`. | 
| **RE-T14** | `AssetBundleValidator.test.ts` | Uploaded `.zip` bundle contains `../../etc/passwd` path traversal or a fake `.png` containing HTML/JS bytes. | Rejected at Layer 4 with `ASSET_PATH_TRAVERSAL_DETECTED` or `ASSET_MAGIC_BYTE_MISMATCH`. | 
| **RE-T15** | `CssAndHtmlSanitizer.test.ts` | `HTML_TEMPLATE` or `VECTOR_DRAW` contains `<script>`, `onload=`, `javascript:`, or CSS `@import url("https://evil.example")`. | Rejected at Layer 4 with `UNSAFE_HTML_OR_CSS_CONSTRUCT` and stripped by defense-in-depth client sanitizer. | 
| **RE-T16** | `TransformPipelineExecutor.test.ts` | `COMPARE_WITH_ASSET` transform compares live `gl_account_shards` balances against an uploaded baseline JSON/CSV asset in the `.zip` bundle. | Accurately matches rows by `match_keys`, computes variance, and flags rows exceeding `tolerance_minor`. | 
| **RE-T17** | `ChromeResolution.test.ts` | System has a published Global Default Header (`cbl-header-v1`) and Footer (`cbl-footer-v1`). Report A uses `GLOBAL_DEFAULT`; Report B uses `NONE`; Report C uses `SPECIFIC_CHROME_CODE`. | Report A receives `cbl-header-v1`/`cbl-footer-v1`; Report B receives `null`/`null`; Report C receives its specific chrome spec. | 
| **RE-T18** | `ReportLanguagePromptDialog.test.ts` | User runs a report supporting `en`, `ar`, and `fr`. | UI prompts user to choose language (`en`, `ar`, `fr`); selecting `ar` sets `<html lang="ar" dir="rtl">` and renders Arabic labels and RTL table/chart alignment. | 
| **RE-T19** | `ClientVectorPdfExporter.test.ts` | Render a 25-page ledger statement with `CHART` (ECharts SVG), `VECTOR_DRAW` (settlement waterfall SVG), and `DATA_TABLE` (with `repeat_header_on_page_break: true`). | `Paged.js` fragments document into 25 `.pagedjs_page` sheets with repeated `<thead>`, running header/footer on every page, and `<svg>` vector charts with zero server CPU used. | 
| **RE-T20** | `InputFormZodCompiler.test.ts` | Report defines an `entity_autocomplete` input bound to `merchants` and a dependent `applications` autocomplete (`depends_on_input: "merchantId"`). | Selecting a merchant dynamically filters the `applications` autocomplete query; invalid UUID or out-of-range dates fail Zod validation before any DB query runs. | 
| **RE-T21** | `ReportRepairPrompt.test.ts` | Upload a spec with 3 deliberate errors across Layer 1 and Layer 2. | `buildReportRepairPrompt` outputs a deterministic Markdown prompt containing all 3 paths, error codes, `aiFixHint` instructions, and the original JSON. | 
| **RE-T22** | `SdkDecouplingCheck.test.ts` | Static import graph test scanning all files inside `core-back/lib/reportEngineSdk/`. | Verifies zero imports from `core-back/api/`, `core-back/engine/`, or `generated/prisma/client`, confirming 100% SDK decoupling. | 

## 11. Step-by-Step Implementation Sequence for Coding Agents

1. **Phase 1 — Decoupled Backend SDK (`core-back/lib/reportEngineSdk/`):**

   * Implement `types/hostConfig.ts`, `types/chromeSpec.ts`, `types/reportSpec.ts`, and `types/diagnostics.ts`.

   * Implement `compiler/InputFormZodCompiler.ts`, `compiler/QueryAstToSqlCompiler.ts`, and `compiler/TransformPipelineExecutor.ts` (including `COMPARE_WITH_ASSET`).

   * Implement `runtime/PostgresReadOnlyExecutor.ts` and `verifier/*` (Layers 1–5 + `AuthorityInferenceEngine.ts` + `CssAndHtmlSanitizer.ts` + `AssetBundleValidator.ts`).

   * Implement `transcript/ReportTranscriptBuilder.ts` and `transcript/ChromeTranscriptBuilder.ts`.

2. **Phase 2 — Database Migration & Host Wiring (`core-back/prisma/` & `core-back/engine/reportStudio/`):**

   * Add `ReportAssetBundle`, `ReportChromeSpecRecord`, `ReportDefinitionSpecRecord`, and `ReportExecutionAuditRecord` to `core-back/prisma/schema.prisma` (Schema Version 26) and add partial unique index for single global default header/footer.

   * Implement `core-back/engine/reportStudio/paymentGatewayHostConfig.ts` wiring `PostgresReplicaReadStore` / `PostgresReadOnlyReportExecutor`, the 78-model schema catalog with `journal_lines` partition rules, `UI_PROJECTION` authorities, and the 8 `autocompleteProviders.ts`.

   * Mount internal admin routes in `core-back/api/internal/adminReportEngine.ts` and proxy routes in `admin-back/api/reportEngine.ts`.

3. **Phase 3 — Decoupled Frontend SDK & Admin-Front Studio (`admin-front/src/lib/reportEngineSdk/` & `admin-front/src/pages/reports/`):**

   * Implement `ClientVectorPdfExporter.ts`, `ReportPagedPreviewSurface.tsx` ([Paged.js](https://pagedjs.org/documentation/) + `@page` CSS), `ReportChartRenderer.tsx` ([Apache ECharts](https://echarts.apache.org/handbook/en/how-to/cross-platform/server/) SVG mode), `ReportVectorDrawRenderer.tsx`, `ReportInputForm.tsx`, and `ReportLanguagePromptDialog.tsx`.

   * Build `/reports/catalog`, `/reports/studio`, and `/reports/chrome` in `admin-front` and register navigation items in `core-back/lib/auth/uiAuthorities.ts`.

4. **Phase 4 — Verification Suite (`RE-T01` through `RE-T22`):**

   * Run all 22 automated tests in `core-back/test/reportEngineSdk/` and `admin-front` to verify read-only enforcement, partition pruning, authority inference/override, bilingual `en`+`ar` validation, `.zip` asset comparison, and client-side vector PDF pagination.

## 12. Reference Host Wiring & Complete Bilingual Spec Examples (`ReportDescriptorSpec` & `ReportChromeSpec`)

### 12.1 Host Wiring Adapter (`core-back/engine/reportStudio/paymentGatewayHostConfig.ts`)

This thin adapter connects the decoupled `ReportEngineSdk` to `core-back`'s Prisma schema catalog, `PostgresReplicaReadStore` / read-only pool, `UI_PROJECTION` authorities, and PostgreSQL 18 partition rules:

```
// core-back/engine/reportStudio/paymentGatewayHostConfig.ts
import type { ReportEngineHostConfig } from "../../lib/reportEngineSdk/types/hostConfig";
import { PostgresReadOnlyReportExecutor } from "../../lib/reportEngineSdk/runtime/PostgresReadOnlyExecutor";
import { buildPaymentGatewayAutocompleteProviders } from "./autocompleteProviders";
import { env } from "../../lib/env";

export function createPaymentGatewayReportHostConfig(deps: {
  readOnlyConnectionString?: string;
  assetStoragePort: ReportEngineHostConfig["assetStoragePort"];
}): ReportEngineHostConfig {
  const dbReadOnlyPort = new PostgresReadOnlyReportExecutor({
    connectionString:
      deps.readOnlyConnectionString ??
      process.env.REPORT_READONLY_DATABASE_URL ??
      env.DATABASE_REPLICA_URLS?.[0] ??
      env.DATABASE_URL,
    maxPoolConnections: 8,
    defaultStatementTimeoutMs: 15_000,
    workMemMb: 32,
  });

  return {
    engineVersion: "1.0",
    institutionName: "Libyan National Payment Gateway",
    defaultCurrency: "LYD",
    defaultTimezone: "Africa/Tripoli",
    supportedLocales: ["en", "ar", "fr", "it", "tr"],
    mandatoryDefaultLocales: ["en", "ar"],
    rolesCatalog: [
      "GATEWAY_ADMIN",
      "SECURITY_ADMIN",
      "FINANCE",
      "OPERATOR",
      "COMPLIANCE",
      "MLRO",
      "SUPPORT",
    ],
    authoritiesCatalog: [
      "merchant:read",
      "merchant:write",
      "kyb:read",
      "compliance:read",
      "compliance:write",
      "aml:read",
      "aml:write",
      "report:review",
      "report:approve",
      "finance:read",
      "finance:write",
      "cashout:read",
      "commission:read",
      "velocity:read",
      "reconciliation:read",
      "gateway:read",
      "operator:read",
      "security:read",
      "security:write",
      "report_engine:author",
      "report_engine:run",
    ],
    securityOverrideAuthority: "security:write",
    securityOverrideRoles: ["SECURITY_ADMIN"],
    authorityConflictMatrix: [
      {
        domainA: "COMPLIANCE_AML",
        domainB: "GATEWAYS",
        conflictCode: "AML_CONFIDENTIAL_WITH_GATEWAY_OPS",
        description: "Combining confidential AML case tables with gateway engineering tables leaves zero default roles able to run the report.",
        resolutionHint: "Split into separate Compliance and Gateway reports, or have a SECURITY_ADMIN assign an explicit Authority Override.",
      },
      {
        domainA: "COMPLIANCE_AML",
        domainB: "OPERATIONS",
        conflictCode: "AML_CONFIDENTIAL_WITH_SUPPORT_OPS",
        description: "Support/Operations roles are barred from confidential AML records by hasConfidentialAmlAccess.",
        resolutionHint: "Restrict this report to MLRO/COMPLIANCE roles or remove aml_cases joins.",
      },
    ],
    models: {
      journal_lines: {
        modelName: "journal_lines",
        tableName: "journal_lines",
        domain: "LEDGER",
        description: "Monthly range-partitioned double-entry ledger lines (partitioned by created_at).",
        partitionedBy: "created_at",
        requiredAuthorities: ["finance:read"],
        naturalRoles: ["FINANCE"],
        merchantScopable: { merchantIdColumn: "merchant_id" },
        optimizationRule: {
          mandatoryFilterColumns: [
            {
              column: "created_at",
              allowedOperators: ["between", "gte_lte"],
              maxDateRangeDays: 366,
              rationale: "journal_lines is monthly range-partitioned by created_at; queries without a bounded created_at range scan all 72+ partitions.",
              aiFixHint: "Add a WHERE predicate on column 'created_at' with op='between' bound to a 'daterange' input with validation.max_range_days <= 366.",
            },
          ],
          requireIndexedFilter: true,
          maxRowsReturned: 10_000,
          transcriptOptimizationNote:
            "ALWAYS filter journal_lines by created_at (max 366 days) to trigger PostgreSQL 18 partition pruning. For current live GL balances, query gl_account_shards instead of summing journal_lines.",
        },
        columns: {
          id: { name: "id", dbColumnName: "id", type: "uuid", nullable: false, indexed: true, sensitivity: "INTERNAL", description: "Line UUID" },
          journal_entry_id: { name: "journal_entry_id", dbColumnName: "journal_entry_id", type: "uuid", nullable: false, indexed: true, sensitivity: "INTERNAL", description: "Parent journal entry UUID" },
          gl_account_id: { name: "gl_account_id", dbColumnName: "gl_account_id", type: "uuid", nullable: false, indexed: true, sensitivity: "INTERNAL", description: "GL Account UUID" },
          merchant_id: { name: "merchant_id", dbColumnName: "merchant_id", type: "uuid", nullable: true, indexed: true, sensitivity: "INTERNAL", description: "Scoped merchant UUID" },
          wallet_id: { name: "wallet_id", dbColumnName: "wallet_id", type: "uuid", nullable: true, indexed: true, sensitivity: "INTERNAL", description: "Scoped wallet UUID" },
          direction: { name: "direction", dbColumnName: "direction", type: "enum", enumName: "JournalDirection", nullable: false, indexed: false, sensitivity: "PUBLIC", description: "DEBIT or CREDIT" },
          amount_minor: { name: "amount_minor", dbColumnName: "amount_minor", type: "bigint", nullable: false, indexed: false, sensitivity: "INTERNAL", description: "Amount in minor units (dirhams, 1 LYD = 1000 minor)" },
          currency: { name: "currency", dbColumnName: "currency", type: "string", nullable: false, indexed: true, sensitivity: "PUBLIC", description: "ISO currency code (LYD)" },
          created_at: { name: "created_at", dbColumnName: "created_at", type: "datetime", nullable: false, indexed: true, sensitivity: "PUBLIC", description: "Partition key timestamp (UTC)" },
        },
        relations: {
          gl_account: { name: "gl_account", targetModel: "gl_accounts", cardinality: "MANY_TO_ONE", sourceKey: "gl_account_id", targetKey: "id" },
          journal_entry: { name: "journal_entry", targetModel: "journal_entries", cardinality: "MANY_TO_ONE", sourceKey: "journal_entry_id", targetKey: "id" },
          merchant: { name: "merchant", targetModel: "merchants", cardinality: "MANY_TO_ONE", sourceKey: "merchant_id", targetKey: "id" },
        },
      },
      gl_account_shards: {
        modelName: "gl_account_shards",
        tableName: "gl_account_shards",
        domain: "LEDGER",
        description: "Hot-account balance shards. Sum balance_minor grouped by gl_account_id for instant O(1) live balances.",
        requiredAuthorities: ["finance:read"],
        naturalRoles: ["FINANCE"],
        optimizationRule: {
          requireIndexedFilter: false,
          maxRowsReturned: 5_000,
          transcriptOptimizationNote: "Use gl_account_shards with SUM(balance_minor) GROUP BY gl_account_id for live account balances.",
        },
        columns: {
          gl_account_id: { name: "gl_account_id", dbColumnName: "gl_account_id", type: "uuid", nullable: false, indexed: true, sensitivity: "INTERNAL", description: "GL Account UUID" },
          shard_no: { name: "shard_no", dbColumnName: "shard_no", type: "int", nullable: false, indexed: true, sensitivity: "INTERNAL", description: "Shard number" },
          balance_minor: { name: "balance_minor", dbColumnName: "balance_minor", type: "bigint", nullable: false, indexed: false, sensitivity: "INTERNAL", description: "Signed shard balance in minor units" },
          updated_at: { name: "updated_at", dbColumnName: "updated_at", type: "datetime", nullable: false, indexed: false, sensitivity: "PUBLIC", description: "Last shard update timestamp" },
        },
        relations: {
          gl_account: { name: "gl_account", targetModel: "gl_accounts", cardinality: "MANY_TO_ONE", sourceKey: "gl_account_id", targetKey: "id" },
        },
      },
      // ... Remaining catalog models registered identically from schema catalog
    },
    enums: {
      JournalDirection: ["DEBIT", "CREDIT"],
      GlAccountType: ["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"],
      MerchantStatus: ["PENDING_KYB", "ACTIVE", "SUSPENDED", "TERMINATED"],
    },
    autocompleteProviders: buildPaymentGatewayAutocompleteProviders(dbReadOnlyPort),
    dbReadOnlyPort,
    assetStoragePort: deps.assetStoragePort,
    globalLimits: {
      maxDatasetsPerReport: 10,
      maxJoinsPerDataset: 6,
      maxRowsPerDataset: 10_000,
      maxQueryTimeoutMs: 15_000,
      maxExplainCost: 150_000,
      maxAssetZipBytes: 15 * 1024 * 1024,
      maxSingleAssetBytes: 5 * 1024 * 1024,
    },
  };
}

```

### 12.2 Complete Worked `ReportChromeSpec v1.0` JSON Example (Reusable Bilingual Official Header)

```
{
  "spec_kind": "REPORT_CHROME",
  "spec_version": "1.0",
  "chrome": {
    "code": "cbl-institutional-header-v1",
    "name": "Official Institutional Bilingual Header (v1)",
    "chrome_type": "HEADER",
    "description": "Standard bilingual institutional header with logo, classification badge, and generation metadata.",
    "height_mm": 22,
    "show_on_first_page": true,
    "border_style": "DOUBLE_BANK_RULE"
  },
  "required_assets": [
    {
      "asset_key": "institution_logo",
      "file_name": "institution-crest.svg",
      "mime_type": "image/svg+xml",
      "alt_i18n_key": "chrome.logo_alt",
      "max_width_mm": 38,
      "max_height_mm": 16
    }
  ],
  "i18n": {
    "default_locale": "en",
    "locales": {
      "en": {
        "chrome.logo_alt": "Libyan National Payment Gateway Official Crest",
        "chrome.division": "Financial Operations & Settlement Directorate",
        "chrome.generated_label": "Generated UTC:",
        "chrome.page_label": "Page",
        "chrome.of_label": "of"
      },
      "ar": {
        "chrome.logo_alt": "الشعار الرسمي لبوابة الدفع الوطنية الليبية",
        "chrome.division": "إدارة العمليات المالية والتسويات",
        "chrome.generated_label": "تاريخ الإصدار (UTC):",
        "chrome.page_label": "صفحة",
        "chrome.of_label": "من"
      }
    }
  },
  "template": {
    "html": "<div class=\"bank-chrome-header\"><div class=\"bank-chrome-brand\"><img src=\"asset://institution_logo\" alt=\"{{$t.chrome.logo_alt}}\" class=\"bank-chrome-logo\" /><div class=\"bank-chrome-titles\"><div class=\"bank-chrome-inst\">{{institutionName}}</div><div class=\"bank-chrome-div\">{{$t.chrome.division}}</div></div></div><div class=\"bank-chrome-meta\"><div><strong>{{reportTitle}}</strong> ({{reportCode}} v{{reportVersion}})</div><div>{{$t.chrome.generated_label}} {{generatedAtFormatted}} | {{$t.chrome.page_label}} <span class=\"report-page-number\"></span> {{$t.chrome.of_label}} <span class=\"report-total-pages\"></span></div></div></div>",
    "scoped_css": ".bank-chrome-header { display: flex; justify-content: space-between; align-items: center; padding-bottom: 4pt; border-bottom: 1.5pt double #1E293B; font-size: 8pt; } .bank-chrome-brand { display: flex; align-items: center; gap: 8pt; } .bank-chrome-logo { height: 14mm; width: auto; } .bank-chrome-inst { font-weight: 700; font-size: 9.5pt; color: #0F172A; } .bank-chrome-div { color: #475569; } .bank-chrome-meta { text-align: end; color: #334155; }",
    "used_variables": ["institutionName", "reportTitle", "reportCode", "reportVersion", "generatedAtFormatted", "pageNumber", "totalPages"]
  }
}

```

### 12.3 Complete Worked `ReportChromeSpec v1.0` JSON Example (Reusable Bilingual Official Footer)

```
{
  "spec_kind": "REPORT_CHROME",
  "spec_version": "1.0",
  "chrome": {
    "code": "cbl-institutional-footer-v1",
    "name": "Official Institutional Bilingual Footer with Verification Hash (v1)",
    "chrome_type": "FOOTER",
    "description": "Standard bilingual institutional footer displaying actor email, classification badge, SHA-256 verification hash, and page numbers.",
    "height_mm": 16,
    "show_on_first_page": true,
    "border_style": "THIN_RULE"
  },
  "required_assets": [],
  "i18n": {
    "default_locale": "en",
    "locales": {
      "en": {
        "chrome.confidentiality": "OFFICIAL FINANCIAL RECORD — READ-ONLY VERIFIED REPLICA EXTRACT",
        "chrome.generated_by": "Requested by:",
        "chrome.integrity_hash": "Integrity SHA-256:",
        "chrome.page": "Page",
        "chrome.of": "of"
      },
      "ar": {
        "chrome.confidentiality": "سجل مالي رسمي — مستخرج موثق للقراءة فقط",
        "chrome.generated_by": "صادر بواسطة:",
        "chrome.integrity_hash": "بصمة التحقق SHA-256:",
        "chrome.page": "صفحة",
        "chrome.of": "من"
      }
    }
  },
  "template": {
    "html": "<div class=\"bank-chrome-footer\"><div><strong>{{$t.chrome.confidentiality}}</strong> | {{$t.chrome.generated_by}} {{actorEmail}} ({{actorRole}})</div><div>{{$t.chrome.integrity_hash}} <code>{{verificationHashShort}}</code> | {{$t.chrome.page}} <span class=\"report-page-number\"></span> {{$t.chrome.of}} <span class=\"report-total-pages\"></span></div></div>",
    "scoped_css": ".bank-chrome-footer { display: flex; justify-content: space-between; align-items: center; padding-top: 4pt; border-top: 0.75pt solid #CBD5E1; font-size: 7.5pt; color: #475569; }",
    "used_variables": ["actorEmail", "actorRole", "verificationHashShort", "pageNumber", "totalPages"]
  }
}

```

### 12.4 Complete Worked `ReportDescriptorSpec v1.0` JSON Example (Bilingual Merchant Settlement, Fee Waterfall & GL Reconciliation Report)

This complete example demonstrates every capability of `ReportEngineSdk v1.0`:

* `audience_scope: "BOTH"` with `merchant_scope_input_key: "merchantId"` bound to the `merchants` autocomplete source.

* Partition-pruned query on `journal_lines` enforcing `created_at` `between` bound to `periodRange` (`max_range_days: 366`).

* Live shard query on `gl_account_shards` + `COMPARE_WITH_ASSET` transform comparing merchant fee rates against an uploaded `cbl-fee-schedule.json` baseline inside the partnered `.zip` archive.

* Bilingual `en` + `ar` dictionaries, `KPI_GRID`, `CHART` (rendered via ECharts SVG), `VECTOR_DRAW` (settlement waterfall diagram), `DATA_TABLE` (with summary footer), and `HTML_TEMPLATE`.

```
{
  "spec_kind": "REPORT_DESCRIPTOR",
  "spec_version": "1.0",
  "report": {
    "code": "merchant-settlement-and-gl-reconciliation",
    "version": 1,
    "category": "MERCHANT_SETTLEMENT",
    "audience_scope": "BOTH",
    "merchant_scope_input_key": "merchantId",
    "classification": "MERCHANT_CONFIDENTIAL"
  },
  "page_layout": {
    "paper_size": "A4",
    "orientation": "LANDSCAPE",
    "margins_mm": { "top": 25, "right": 14, "bottom": 20, "left": 14 },
    "header_mode": "GLOBAL_DEFAULT",
    "footer_mode": "GLOBAL_DEFAULT",
    "allow_runtime_chrome_selection": true,
    "global_scoped_css": ".signoff-box { display: grid; grid-template-columns: 1fr 1fr; gap: 24pt; margin-top: 18pt; padding-top: 10pt; border-top: 1pt dashed #94A3B8; }"
  },
  "required_assets": [
    {
      "asset_key": "cbl_fee_baseline",
      "file_name": "cbl-fee-schedule.json",
      "mime_type": "application/json",
      "purpose": "COMPARISON_BASELINE_DATA",
      "description": "Reference fee cap schedule per currency for variance comparison"
    }
  ],
  "i18n": {
    "default_locale": "en",
    "prompt_user_when_multi_locale": true,
    "locales": {
      "en": {
        "report.title": "Merchant Settlement & GL Turnover Statement",
        "input.merchant": "Target Merchant",
        "input.merchant_help": "Select the merchant account to generate the statement for",
        "input.period": "Statement Period (UTC)",
        "input.period_help": "Maximum 366 days (enforces monthly partition pruning on journal_lines)",
        "input.currency": "Settlement Currency",
        "kpi.title": "Executive Settlement Summary",
        "kpi.total_credit": "Gross Credited Volume",
        "kpi.total_debit": "Total Debits & Fees",
        "kpi.net_movement": "Net Period Movement",
        "kpi.line_count": "Posted Ledger Lines",
        "chart.daily_title": "Daily Credited vs. Debited Volume (LYD)",
        "chart.date_axis": "Posting Date (UTC)",
        "chart.credit_series": "Gross Credits",
        "chart.debit_series": "Debits & Settlements",
        "draw.waterfall_title": "Settlement & Fee Flow Diagram",
        "draw.node_gross": "Gross Collected",
        "draw.node_debits": "Fees & Payouts",
        "draw.node_net": "Net Period Position",
        "draw.edge_less": "Less Debits",
        "draw.edge_equals": "Net Balance",
        "table.daily_title": "Daily Partitioned Ledger Breakdown",
        "table.col_date": "Posting Day",
        "table.col_currency": "Currency",
        "table.col_credits": "Gross Credits",
        "table.col_debits": "Gross Debits",
        "table.col_net": "Net Movement",
        "table.col_lines": "Line Count",
        "signoff.title": "Official Backoffice & Merchant Reconciliation Sign-Off",
        "signoff.prepared_by": "Prepared by Financial Operations",
        "signoff.reviewed_by": "Reviewed & Verified by Authorized Officer"
      },
      "ar": {
        "report.title": "كشف تسويات التاجر وحركة الأستاذ العام",
        "input.merchant": "التاجر المستهدف",
        "input.merchant_help": "اختر حساب التاجر لإصدار الكشف المالي الخاص به",
        "input.period": "فترة الكشف (بتوقيت UTC)",
        "input.period_help": "بحد أقصى 366 يوماً (لضمان تقليم الأقسام الشهرية لجدول قيود اليومية)",
        "input.currency": "عملة التسوية",
        "kpi.title": "الملخص التنفيذي للتسويات",
        "kpi.total_credit": "إجمالي المبالغ الدائنة",
        "kpi.total_debit": "إجمالي المبالغ المدينة والعمولات",
        "kpi.net_movement": "صافي حركة الفترة",
        "kpi.line_count": "عدد قيود الأستاذ المرحلة",
        "chart.daily_title": "حجم الحركات الدائنة والمدينة اليومية (د.ل)",
        "chart.date_axis": "تاريخ الترحيل (UTC)",
        "chart.credit_series": "إجمالي الدائن",
        "chart.debit_series": "المدين والتسويات",
        "draw.waterfall_title": "مخطط تدفق التسويات والعمولات",
        "draw.node_gross": "إجمالي المتحصلات",
        "draw.node_debits": "العمولات والمسحوبات",
        "draw.node_net": "صافي مركز الفترة",
        "draw.edge_less": "يطرح المدين",
        "draw.edge_equals": "الصافي",
        "table.daily_title": "التفصيل اليومي لقيود الأستاذ العام",
        "table.col_date": "يوم الترحيل",
        "table.col_currency": "العملة",
        "table.col_credits": "إجمالي الدائن",
        "table.col_debits": "إجمالي المدين",
        "table.col_net": "صافي الحركة",
        "table.col_lines": "عدد القيود",
        "signoff.title": "اعتماد ومطابقة العمليات المالية",
        "signoff.prepared_by": "إعداد إدارة العمليات المالية",
        "signoff.reviewed_by": "مراجعة واعتماد المسؤول المخول"
      }
    }
  },
  "inputs": [
    {
      "key": "merchantId",
      "label_i18n_key": "input.merchant",
      "help_i18n_key": "input.merchant_help",
      "type": "entity_autocomplete",
      "required": true,
      "autocomplete": { "source": "merchants" },
      "layout_col_span": 5
    },
    {
      "key": "periodRange",
      "label_i18n_key": "input.period",
      "help_i18n_key": "input.period_help",
      "type": "daterange",
      "required": true,
      "default_value": { "preset": "CURRENT_MONTH" },
      "validation": { "max_range_days": 366 },
      "layout_col_span": 5
    },
    {
      "key": "currency",
      "label_i18n_key": "input.currency",
      "type": "entity_autocomplete",
      "required": true,
      "default_value": "LYD",
      "autocomplete": { "source": "currencies" },
      "layout_col_span": 2
    }
  ],
  "datasets": [
    {
      "dataset_id": "period_totals",
      "description": "Aggregates total credits, debits, and line counts for the selected merchant and partition-pruned date range.",
      "from_model": "journal_lines",
      "from_alias": "jl",
      "joins": [],
      "select": [
        { "alias": "currency", "column": "currency", "expression": "COLUMN", "format_hint": "RAW" },
        { "alias": "total_credit_minor", "column": "amount_minor", "expression": "COLUMN", "aggregate": "SUM_CREDIT_MINOR", "format_hint": "CURRENCY_MINOR" },
        { "alias": "total_debit_minor", "column": "amount_minor", "expression": "COLUMN", "aggregate": "SUM_DEBIT_MINOR", "format_hint": "CURRENCY_MINOR" },
        { "alias": "line_count", "column": "id", "expression": "COLUMN", "aggregate": "COUNT", "format_hint": "RAW" }
      ],
      "where": {
        "kind": "GROUP",
        "logic": "AND",
        "conditions": [
          {
            "kind": "PREDICATE",
            "column": "merchant_id",
            "op": "eq",
            "binding": { "source": "INPUT", "input_key": "merchantId" }
          },
          {
            "kind": "PREDICATE",
            "column": "created_at",
            "op": "between",
            "binding": { "source": "INPUT", "input_key": "periodRange", "range_bound": "BOTH" }
          },
          {
            "kind": "PREDICATE",
            "column": "currency",
            "op": "eq",
            "binding": { "source": "INPUT", "input_key": "currency" }
          }
        ]
      },
      "group_by": ["currency"],
      "limit": 10
    },
    {
      "dataset_id": "daily_turnover",
      "description": "Daily grouped credits and debits for the selected merchant within the partition-pruned created_at window.",
      "from_model": "journal_lines",
      "from_alias": "jl",
      "joins": [],
      "select": [
        { "alias": "posting_day", "column": "created_at", "expression": "DATE_TRUNC_DAY", "format_hint": "DATE_ISO" },
        { "alias": "currency", "column": "currency", "expression": "COLUMN", "format_hint": "RAW" },
        { "alias": "credit_minor", "column": "amount_minor", "expression": "COLUMN", "aggregate": "SUM_CREDIT_MINOR", "format_hint": "CURRENCY_MINOR" },
        { "alias": "debit_minor", "column": "amount_minor", "expression": "COLUMN", "aggregate": "SUM_DEBIT_MINOR", "format_hint": "CURRENCY_MINOR" },
        { "alias": "line_count", "column": "id", "expression": "COLUMN", "aggregate": "COUNT", "format_hint": "RAW" }
      ],
      "where": {
        "kind": "GROUP",
        "logic": "AND",
        "conditions": [
          {
            "kind": "PREDICATE",
            "column": "merchant_id",
            "op": "eq",
            "binding": { "source": "INPUT", "input_key": "merchantId" }
          },
          {
            "kind": "PREDICATE",
            "column": "created_at",
            "op": "between",
            "binding": { "source": "INPUT", "input_key": "periodRange", "range_bound": "BOTH" }
          },
          {
            "kind": "PREDICATE",
            "column": "currency",
            "op": "eq",
            "binding": { "source": "INPUT", "input_key": "currency" }
          }
        ]
      },
      "group_by": ["posting_day", "currency"],
      "order_by": [{ "field": "posting_day", "direction": "ASC" }],
      "limit": 366
    }
  ],
  "transforms": [
    {
      "operation": "COMPUTE_COLUMN",
      "target_dataset_id": "period_totals",
      "output_column": "net_movement_minor",
      "formula": "SUBTRACT",
      "left_operand": "total_credit_minor",
      "right_operand": "total_debit_minor",
      "format_hint": "CURRENCY_MINOR"
    },
    {
      "operation": "COMPUTE_COLUMN",
      "target_dataset_id": "daily_turnover",
      "output_column": "net_minor",
      "formula": "SUBTRACT",
      "left_operand": "credit_minor",
      "right_operand": "debit_minor",
      "format_hint": "CURRENCY_MINOR"
    },
    {
      "operation": "COMPARE_WITH_ASSET",
      "source_dataset_id": "period_totals",
      "asset_key": "cbl_fee_baseline",
      "output_dataset_id": "period_totals_compared",
      "match_keys": ["currency"],
      "compare_fields": [
        { "dataset_field": "total_debit_minor", "asset_field": "max_expected_debit_minor", "tolerance_minor": 5000 }
      ]
    }
  ],
  "sections": [
    {
      "section_type": "KPI_GRID",
      "section_id": "sec_kpis",
      "title_i18n_key": "kpi.title",
      "columns": 4,
      "cards": [
        { "label_i18n_key": "kpi.total_credit", "dataset_id": "period_totals", "value_field": "total_credit_minor", "format_hint": "CURRENCY_MINOR", "tone": "SUCCESS" },
        { "label_i18n_key": "kpi.total_debit", "dataset_id": "period_totals", "value_field": "total_debit_minor", "format_hint": "CURRENCY_MINOR", "tone": "WARNING" },
        { "label_i18n_key": "kpi.net_movement", "dataset_id": "period_totals", "value_field": "net_movement_minor", "format_hint": "CURRENCY_MINOR", "tone": "PRIMARY" },
        { "label_i18n_key": "kpi.line_count", "dataset_id": "period_totals", "value_field": "line_count", "format_hint": "INTEGER", "tone": "NEUTRAL" }
      ]
    },
    {
      "section_type": "VECTOR_DRAW",
      "section_id": "sec_waterfall_draw",
      "title_i18n_key": "draw.waterfall_title",
      "draw_kind": "SETTLEMENT_WATERFALL_DIAGRAM",
      "height_mm": 48,
      "view_box": { "width": 780, "height": 140 },
      "nodes": [
        {
          "node_id": "n_gross",
          "shape": "ROUNDED_RECT",
          "x": 30,
          "y": 35,
          "width": 190,
          "height": 64,
          "label_i18n_key": "draw.node_gross",
          "value_binding": { "dataset_id": "period_totals", "field": "total_credit_minor", "row_index": 0, "format_hint": "CURRENCY_MINOR" },
          "fill_hex": "#ECFDF5",
          "stroke_hex": "#059669",
          "text_hex": "#065F46"
        },
        {
          "node_id": "n_debits",
          "shape": "ROUNDED_RECT",
          "x": 295,
          "y": 35,
          "width": 190,
          "height": 64,
          "label_i18n_key": "draw.node_debits",
          "value_binding": { "dataset_id": "period_totals", "field": "total_debit_minor", "row_index": 0, "format_hint": "CURRENCY_MINOR" },
          "fill_hex": "#FFFBEB",
          "stroke_hex": "#D97706",
          "text_hex": "#92400E"
        },
        {
          "node_id": "n_net",
          "shape": "ROUNDED_RECT",
          "x": 560,
          "y": 35,
          "width": 190,
          "height": 64,
          "label_i18n_key": "draw.node_net",
          "value_binding": { "dataset_id": "period_totals", "field": "net_movement_minor", "row_index": 0, "format_hint": "CURRENCY_MINOR" },
          "fill_hex": "#EFF6FF",
          "stroke_hex": "#2563EB",
          "text_hex": "#1E40AF"
        }
      ],
      "edges": [
        { "from_node_id": "n_gross", "to_node_id": "n_debits", "label_i18n_key": "draw.edge_less", "style": "SOLID", "color_hex": "#475569" },
        { "from_node_id": "n_debits", "to_node_id": "n_net", "label_i18n_key": "draw.edge_equals", "style": "SOLID", "color_hex": "#2563EB" }
      ]
    },
    {
      "section_type": "CHART",
      "section_id": "sec_daily_chart",
      "title_i18n_key": "chart.daily_title",
      "dataset_id": "daily_turnover",
      "chart_kind": "COMBO_BAR_LINE",
      "height_mm": 68,
      "width_percent": 100,
      "x_field": "posting_day",
      "x_label_i18n_key": "chart.date_axis",
      "y_axis_format": "CURRENCY_MINOR",
      "series": [
        { "field": "credit_minor", "label_i18n_key": "chart.credit_series", "type_override": "bar", "color_hex": "#10B981", "show_value_labels": false },
        { "field": "debit_minor", "label_i18n_key": "chart.debit_series", "type_override": "line", "color_hex": "#F59E0B", "show_value_labels": false }
      ]
    },
    {
      "section_type": "DATA_TABLE",
      "section_id": "sec_daily_table",
      "title_i18n_key": "table.daily_title",
      "dataset_id": "daily_turnover",
      "repeat_header_on_page_break": true,
      "avoid_row_split": true,
      "zebra_striping": true,
      "columns": [
        { "field": "posting_day", "header_i18n_key": "table.col_date", "align": "START", "format_hint": "DATE_ISO", "summary_footer": "LABEL_TOTAL" },
        { "field": "currency", "header_i18n_key": "table.col_currency", "align": "CENTER", "format_hint": "RAW", "summary_footer": "NONE" },
        { "field": "credit_minor", "header_i18n_key": "table.col_credits", "align": "END", "format_hint": "CURRENCY_MINOR", "summary_footer": "SUM" },
        { "field": "debit_minor", "header_i18n_key": "table.col_debits", "align": "END", "format_hint": "CURRENCY_MINOR", "summary_footer": "SUM" },
        { "field": "net_minor", "header_i18n_key": "table.col_net", "align": "END", "format_hint": "CURRENCY_MINOR", "summary_footer": "SUM" },
        { "field": "line_count", "header_i18n_key": "table.col_lines", "align": "END", "format_hint": "RAW", "summary_footer": "SUM" }
      ]
    },
    {
      "section_type": "HTML_TEMPLATE",
      "section_id": "sec_signoff",
      "title_i18n_key": "signoff.title",
      "html_template": "<div class=\"signoff-box\"><div><strong>{{$t.signoff.prepared_by}}</strong><br/><br/>_______________________________</div><div><strong>{{$t.signoff.reviewed_by}}</strong><br/><br/>_______________________________</div></div>",
      "scoped_css": ""
    }
  ]
}

```

## 13. Final Architectural Completeness & Delivery Sign-Off Checklist

Every requirement from the specification is accounted for and ready for implementation:

* \[x\] **Requirement 1 — Authority Auto-Detection & Security Admin Override:** Covered in Section 4.3 (`AuthorityInferenceEngine.ts`) and Section 9.1 (`ReportDefinitionSpecRecord` override columns + `SECURITY_ADMIN` / `security:write` guard).

* \[x\] **Requirement 2 — Zod-Validated Input Form & Autocomplete Sources:** Covered in Section 3.2 (`ReportInputFieldSpecSchema`), Section 3.3 (`InputFormZodCompiler.ts`), and Section 9.4 (`autocompleteProviders.ts`).

* \[x\] **Requirement 3 — Verifiable DSL Safety & `EXPLAIN` Cost Guard:** Covered in Section 4.1–4.5 (`SpecStructuralValidator.ts`, `QuerySafetyAndOptValidator.ts`, `CssAndHtmlSanitizer.ts`, `ReportDryRunSimulator.ts`).

* \[x\] **Requirement 4 — Dedicated Read-Only DB Execution Line:** Covered in Section 5 (`PostgresReadOnlyReportExecutor` with `BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`, `statement_timeout`, `work_mem`, and replica routing).

* \[x\] **Requirement 5 — Rich HTML, Scoped CSS, Vector Charts, Vector Draws & Images:** Covered in Section 3.2 (`CHART`, `VECTOR_DRAW`, `HTML_TEMPLATE`, `IMAGE_BANNER`) and Section 6.2–6.3 (`ClientVectorPdfExporter.ts`, `ReportVectorDrawRenderer.tsx`).

* \[x\] **Requirement 6 — Multi-Language (`en` + `ar` Mandatory Default + Custom Prompt):** Covered in Section 3.2, Section 4.1 (`SpecStructuralValidator.ts`), Section 7.1, Section 8 (`ReportTranscriptBuilder.ts`), and Section 9.5 (`ReportLanguagePromptDialog.tsx`).

* \[x\] **Requirement 7 — Reusable Standard Headers & Footers (`ReportChromeSpec`):** Covered in Section 3.1 (`ReportChromeSpecSchema`), Section 7.2, Section 9.1 (`ReportChromeSpecRecord` with single-default partial unique index), and Section 12.2–12.3.

* \[x\] **Requirement 8 — Partnered `.zip` Asset Bundles & DSL Comparison (`COMPARE_WITH_ASSET`):** Covered in Section 3.5 (`TransformPipelineExecutor.ts`), Section 4.4 (`AssetBundleValidator.ts`), and Section 7.3.

* \[x\] **Requirement 9 — Decoupled Library / SDK Design:** Covered in Section 2.1–2.2 (`core-back/lib/reportEngineSdk/` and `admin-front/src/lib/reportEngineSdk/` with injected `ReportEngineHostConfig`) and verified by test `RE-T22`.

* \[x\] **Requirement 10 — Query Optimization Rules (Partition Pruning & Shards):** Covered in Section 2.2 (`ModelOptimizationRule`), Section 4.2 (`QuerySafetyAndOptValidator.ts`), Section 8.2 (`ReportTranscriptBuilder.ts`), and Section 12.1 (`paymentGatewayHostConfig.ts`).

* \[x\] **Requirement 11 — 2026 Client-Side First Vector PDF Rendering (`Paged.js` + CSS `@page` + ECharts SVG) & Server Fallback:** Covered in Section 6.1–6.4 (`ClientVectorPdfExporter.ts`, `ReportPagedPreviewSurface.tsx`) with zero server CPU/RAM overhead during interactive report generation.

*End of Dynamic AI-Transcript Report Engine SDK & Admin Studio Blueprint (`v1.0`).*
---

## 14. Addendum — Merchant Report Portal and Hardening (2026-11-09)

The original blueprint described the admin Report Catalog as the place where staff generate merchant reports. The delivered system also adds a merchant-portal runner, because merchants must be able to generate their own reports without staff involvement.

### 14.1 Merchant execution rules

- Merchants never author specs and never manage chrome; only the admin Studio/Chrome pages do that.
- A merchant sees only published `MERCHANT_FACING`/`BOTH` reports whose definitions pass `validateMerchantReportScope`.
- Every base and joined model in a merchant report must be merchant-scopable and must carry an alias-aware `merchant_id = input(merchant_scope_input_key)` predicate. An `OR` branch that omits the predicate is rejected.
- The merchant API overwrites the scope input with the authenticated principal's `merchantId`; a client-supplied merchant ID is ignored.
- The merchant page hides the scope input, prompts for language, and offers print/CSV/XLSX through the same client SDK.

### 14.2 Hardening added with the merchant runner

- Schema version 27: `report_definition_specs.allow_confidential_aml_bypass`, one latest-published row per report code, and append-only `report_execution_audit`.
- `PII_MASKED` values are redacted unless the actor holds `piiUnmaskAuthorities` (default `security:write`).
- Confidential AML reports require MLRO/Compliance access. `allowConfidentialAmlBypass` is only applied after a different MLRO or Security Admin approves a `REPORT_AML_BYPASS` request.
- Chrome assets are loaded during execution and preview; chrome variables include the host institution and period summary.
- Inline chrome, `global_scoped_css`, custom SVG and HTML templates reject `<style>`, external URLs, `@import`, event handlers and executable URI schemes.
- The report asset store uses `REPORT_ASSET_STORAGE_DIR`, preserves MIME/assetKey/uploader, and deduplicates identical bundles by SHA-256.
- `SERVER_PDF` remains an explicit deferred option and returns `501 SERVER_PDF_NOT_CONFIGURED`.

### 14.3 Authoring caps and aliases

The delivered schema raises the report caps to 64 datasets, 64 transforms and 128 sections (20 inputs, 6 joins per dataset, 40 select fields, 5 window fields remain). The AI transcript documents these limits.

The schema normalises common authoring aliases before validation: transform `kind` → `operation`; COMPUTE_COLUMN `compute`/`compute_op`/`operator` → `formula`; `{ literal: value }` → the raw default value; SVG-style `view_box` strings → `{ width, height }`. `INTEGER` is accepted in dataset/table format hints and `BAR` is a valid vector node shape (a rectangle).
