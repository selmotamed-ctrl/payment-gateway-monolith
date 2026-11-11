---
id: core.report-engine
title: Dynamic Report Engine SDK and Report Studio Host
status: implemented
confidence: high
last_verified: 2026-11-10
verified_against: working-tree
code:
  - core-back/lib/reportEngineSdk/**
  - core-back/engine/reportStudio/**
  - core-back/api/internal/adminReportEngine.ts
  - core-back/api/internal/admin.ts
  - admin-back/api/protected/reportEngine.ts
  - admin-back/api/protected/index.ts
  - core-back/lib/auth/uiAuthorities.ts
  - core-back/prisma/schema.prisma
  - core-back/prisma/migrations/20261110120000_dynamic_report_engine_sdk/migration.sql
  - core-back/prisma/migrations/20261110130000_report_engine_merchant_and_aml/migration.sql
  - core-back/prisma/migrations/20261110190000_merchant_report_engine/migration.sql
  - core-back/api/internal/merchantReportEngine.ts
  - core-back/api/internal/merchant.ts
  - merchant-back/api/protected/reportEngine.ts
  - merchant-front/src/pages/reports/index.tsx
  - merchant-front/src/pages/reports/studio/index.tsx
  - core-back/engine/reportStudio/merchantHostConfig.ts
  - core-back/engine/reportStudio/merchantReportEngine.ts
  - admin-front/src/pages/reports/merchant-reports/index.tsx
  - merchant-front/src/lib/reportEngineSdk/**
  - core-back/prisma/seed.ts
design_sources:
  - design/12-reporting/dynamic_ai_transcript_report_engine_sdk_plan.md
tests:
  - core-back/test/reportEngineSdk/**
  - core-back/test/admin-slice/admin-report-engine.test.ts
  - merchant-back/test/core-forwarding.test.ts
  - admin-back/test/report-engine-edge.test.ts
  - tests/unit/report-engine-sdk-mirror.test.ts
  - admin-front/src/lib/reportEngineSdk/__tests__/**
  - merchant-front/src/pages/reports/index.tsx
  - merchant-front/src/pages/reports/studio/index.tsx
  - core-back/engine/reportStudio/merchantHostConfig.ts
  - core-back/engine/reportStudio/merchantReportEngine.ts
  - admin-front/src/pages/reports/merchant-reports/index.tsx
  - core-back/test/exhaustive/01-schema/**
  - core-back/test/phase1-mtls-and-schema.test.ts
  - admin-back/test/**
gaps:
  - `SERVER_PDF` rendering is not implemented; execution requests for it return `501 SERVER_PDF_NOT_CONFIGURED` and the client Paged.js vector path is the supported renderer.
  - The report asset store is local filesystem (`REPORT_ASSET_STORAGE_DIR`, default `.report-assets`); object storage and signed asset delivery are not implemented.
  - `REPORT_READONLY_DATABASE_URL` may point at a replica, but replica routing is not verified in the report executor on a live multi-host deployment.
  - Report execution audits record the actor, scope and verification hash but do not yet copy the audit row into the dedicated audit database.
  - The merchant line uses an in-process concurrency semaphore and 60 s cache per core node; a multi-node deployment needs a shared semaphore for a strict global cap.
  - Chrome authoring remains staff-only; merchants run platform chrome.
---

# Dynamic Report Engine SDK and Report Studio Host

## 1. Purpose and scope

The report engine turns a declarative, AI-authored `ReportDescriptorSpec` into a bilingual, read-only financial report without storing or executing raw SQL. It is split into two layers:

- `core-back/lib/reportEngineSdk/**` is a host-agnostic SDK. It knows the DSL, the compilers, the five verification layers, the read-only PostgreSQL executor and the AI transcripts. It imports no `core-back/api`, `core-back/engine` or generated Prisma client modules.
- `core-back/engine/reportStudio/**` is the payment-gateway host adapter. It supplies the live schema catalog, authority/domain/optimization metadata, autocomplete providers, asset storage and the `ReportEngineHostConfig`.

`core-back/api/internal/adminReportEngine.ts` exposes the SDK through internal admin routes. `admin-back/api/protected/reportEngine.ts` proxies the same surface to the admin portal.

## 2. DSL and verification

`ReportDescriptorSpec v1.0` contains:

- `inputs`: typed form fields compiled to Zod (`string`, `uuid`, `number`, `integer`, `amount_minor`, `boolean`, `date`, `datetime`, `daterange`, `enum`, `multi_enum`, `entity_autocomplete`, `entity_multi_autocomplete`) with presets and a dependent autocomplete source.
- `datasets`: a safe AST (`from_model`, joins, select aliases, where tree, group by, having, window fields, order by, limit). The compiler emits only parameterized `SELECT` statements.
- `transforms`: deterministic post-query operations (`COMPUTE_COLUMN`, `JOIN_DATASETS`, `PIVOT_DATASET`, `COMPARE_WITH_ASSET`).
- `sections`: `KPI_GRID`, `DATA_TABLE`, `CHART`, `VECTOR_DRAW`, `HTML_TEMPLATE`, `IMAGE_BANNER`, `PAGE_BREAK`.
- `i18n.locales`: mandatory `en` and `ar` dictionaries; additional locales are allowed but must cover every referenced key.
- `required_assets`: flat-file image, JSON or CSV assets delivered in a partnered `.zip`.

The verification pipeline is:

1. **Layer 1** — Zod schema and bilingual completeness (`SpecStructuralValidator.ts`).
2. **Layer 2** — read-only AST safety, mandatory partition filters, merchant isolation, forbidden secret columns, `EXPLAIN` cost and sequential-scan guard (`QuerySafetyAndOptValidator.ts`).
3. **Layer 3** — automatic authority inference, cross-domain conflict detection and Security Admin override (`AuthorityInferenceEngine.ts`).
4. **Layer 4** — HTML/CSS/SVG sanitizer and `.zip` asset validation (magic bytes, traversal, zip bombs, comparison data) (`CssAndHtmlSanitizer.ts`, `AssetBundleValidator.ts`).
5. **Layer 5** — read-only dry run with synthesized inputs (`ReportDryRunSimulator.ts`).

`buildReportRepairPrompt` returns a deterministic Markdown prompt containing the original JSON, every diagnostic path/code and the `aiFixHint`.

## 3. Read-only execution line

`PostgresReadOnlyReportExecutor` enforces the following before and during every query:

- `assertPureSelectSql` rejects anything that is not a single `SELECT`/`WITH` statement and blocks `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `COPY`, `CALL`, `DO`, DDL, `pg_sleep` and other unsafe functions.
- The transaction is `BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`.
- Session settings are `statement_timeout`, `lock_timeout`, `idle_in_transaction_session_timeout`, `work_mem` and UTC.
- Rows are capped by the dataset `limit` and the host `maxRowsPerDataset`.
- The pool is a dedicated pool; it is not the application pool and does not accept writes.

The API maps a timeout to `408 REPORT_QUERY_TIMEOUT` and a cancelled/rolled-back query to the standard execution error response.

## 4. Host catalog and authority metadata

`core-back/engine/reportStudio/schemaCatalog.ts` parses `core-back/prisma/schema.prisma` at startup (cached) and builds `CatalogModelDef` entries:

- model/table names, scalar columns (keyed by database column name), enums, relations;
- domain (`LEDGER`, `PAYMENTS`, `MERCHANTS`, `COMPLIANCE_AML`, `GATEWAYS`, `SECURITY_AUDIT`, ...);
- natural roles and required authorities;
- merchant-scopable column and confidential AML marker;
- optimization rules (`journal_lines` requires a bounded `created_at`; `payment_attempts` requires a bounded range; row limits);
- `minorUnitScale: 1000` for the synthetic `amount_minor`/`balance_minor` vocabulary used by the DSL.

`core-back/engine/reportStudio/paymentGatewayHostConfig.ts` assembles the host config, including the read-only pool (replica URL when configured), asset storage and autocomplete providers.

`autocompleteProviders.ts` provides the eight sources: `merchants`, `applications`, `gateways`, `payment_rails`, `gl_accounts`, `currencies`, `staff_users`, `aml_cases`.

## 5. API surface

`core-back/api/internal/adminReportEngine.ts` (mounted in `core-back/api/internal/admin.ts`):

| Method | Path | Purpose |
| :--- | :--- | :--- |
| GET | `/report-engine/transcript` | AI authoring transcript for report descriptors. |
| GET | `/report-engine/chrome/transcript` | AI authoring transcript for chrome specs. |
| POST | `/report-engine/specs/verify` | Parse and run all five verification layers; returns diagnostics and the repair prompt. |
| POST | `/report-engine/specs` | Persist a verified draft; optionally publish. |
| POST | `/report-engine/specs/:id/authority-override` | Security Admin override with justification; requires `security:write`. |
| GET | `/report-engine/catalog` | Published catalog filtered by the actor's authority policy; accepts `audience`, `page`, `pageSize`, `search`, `sortKey`, `sortDirection` and returns `total`. |
| GET | `/report-engine/autocomplete` | Autocomplete provider query. |
| POST | `/report-engine/execute` | Read-only execution; returns datasets, resolved chrome, asset data URLs and verification hash. |
| GET | `/report-engine/chrome` | Chrome registry; accepts `type`, `includeArchived`, `page`, `pageSize`, `search`, `sortKey`, `sortDirection` and returns `total`. |
| POST | `/report-engine/chrome` | Create/update a chrome spec. |
| POST | `/report-engine/chrome/:id/set-default` | Set the single published global default per type. |
| POST | `/report-engine/chrome/:id/archive` | Archive a header/footer; archived rows are hidden from the registry by default. |

`admin-back/api/protected/reportEngine.ts` forwards the same routes under `/api/v1/admin/report-engine/*` with the admin authority guard.

## 6. Schema versions 26, 27 and 33

`20261110120000_dynamic_report_engine_sdk` adds:

- enums `ReportSpecStatus`, `ReportChromeType`, `ReportAudienceScope`, `ReportAuthorityMode`;
- `report_asset_bundles` (bundle SHA-256, storage key, total bytes, file count, manifest, uploader);
- `report_chrome_specs` (code/version, type, status, single global default per type via a partial unique index, supported locales, spec JSON/SHA-256, publisher);
- `report_definition_specs` (code/version, category, audience, status, latest-published flag, supported/default locales, spec JSON/SHA-256, verification report, inferred roles/authorities, conflict status, confidential AML flag, override fields, publisher);
- `report_execution_audit` (spec, code/version, actor, locale, scoped merchant, redacted inputs, row count, duration, node, verification hash, render target).

`REQUIRED_SCHEMA_VERSION` is 33. Version 27 adds the AML bypass flag, latest-published uniqueness and the append-only execution audit. Version 33 adds the separate merchant authoring line: `merchant_report_specs`, `merchant_report_asset_bundles`, `merchant_report_execution_audit` (append-only trigger), `merchant_report_rate_events` and `merchant_report_studio_status`, with unique `(merchant_id, code, version)` and one latest-published row per merchant/code. The seed calls `seedDefaultChromeSpecs` after the admin users exist, so a fresh database has one published bilingual header and footer marked as global defaults.

## 7. Security invariants

- Report SQL is never stored or accepted as raw SQL; only the AST is persisted.
- Every query runs in a read-only transaction on a dedicated pool.
- A merchant-facing report must bind `merchant_id` to the merchant scope input; the API also rejects a merchant actor whose application scope does not match.
- `FORBIDDEN_SECRET` columns (credential ciphertext, password hashes, sealed secrets) are rejected at Layer 2 and never appear in the transcript catalog.
- A Security Admin override requires the `security:write` authority and a non-empty justification; the override is stored on the spec and audited.
- The execution audit stores redacted inputs and a SHA-256 verification hash of the executed datasets.

## 8. Tests

`core-back/test/reportEngineSdk/**` implements the RE-T01..RE-T22 matrix (plus extra dry-run/transcript cases). `admin-front/src/lib/reportEngineSdk/__tests__/**` covers formatting, RTL vector mirroring, chrome binding, the language prompt options, the paged-media document and the client sanitizer. The exhaustive schema suite and `phase1-mtls-and-schema.test.ts` verify schema version 27 and the four new models.

## 9. Merchant reporting line (schema version 33)

The merchant line is physically separate from the staff registry. It has its own tables (`merchant_report_specs`, `merchant_report_asset_bundles`, `merchant_report_execution_audit`), its own host catalog (`engine/reportStudio/merchantHostConfig.ts`) and its own transcript.

### 9.1 Merchant host catalog

The merchant host is built from an explicit allow-list of directly merchant-scoped models only: `merchants`, `applications`, `wallets`, `payment_attempts`, `cashout_requests` and `rm_merchant_daily_stats`. Each model has an explicit column allow-list. Ledger, credentials, audit, AML, users, payment links, POS terminals, disputes, adjustments, reconciliation rows, webhooks and outbox tables are absent from the catalog. Models without a direct `merchant_id` are not admitted because the engine cannot inject a scope predicate on them.

### 9.2 Engine-injected identity

`compileDatasetQueryToSql` accepts `options.merchantScope`. It rejects any alias whose model is not merchant-scopable, adds `<alias>.<merchant_column> = $merchant` as a top-level AND for the base alias and every joined alias, and selects a hidden `__scope_merchant_id` column. `executeReport` verifies the injected alias set, asserts every returned row equals the principal's merchant, strips the hidden column, and on mismatch invokes the merchant callback before throwing `ReportMerchantScopeViolationError`; the API audits the event and opens a P1 `MANUAL_REVIEW` operator case.

### 9.3 Routes

Core merchant routes (mounted without a prefix behind merchant authentication):

| Method | Path | Purpose |
| :--- | :--- | :--- |
| GET | `/report-engine/catalog` | Platform templates plus the merchant's own published reports; strips the query AST. |
| GET | `/report-engine/autocomplete/:sourceKey` | Own applications, payment links, POS terminals and currencies. |
| POST | `/report-engine/catalog/:code/execute` | Scoped execution with the merchant identity injected. |
| GET | `/report-engine/studio/transcript` | Merchant-only AI transcript. |
| POST | `/report-engine/studio/verify` | Five layers plus merchant-tier limits. |
| POST | `/report-engine/studio/specs` | Save verified or publish. |
| GET | `/report-engine/studio/specs` | Own versions. |
| GET | `/report-engine/studio/specs/:id` | Own spec detail. |
| POST | `/report-engine/studio/specs/:id/publish` | Publish an own verified version. |
| POST | `/report-engine/studio/specs/:id/archive` | Archive and promote the previous published version. |
| GET | `/report-engine/studio/usage` | Codes, runs, DB time, hourly limits and suspension. |
| POST | `/report-engine/studio/templates/:code/clone` | Clone a platform template into the merchant registry. |

`merchant-back/api/protected/reportEngine.ts` proxies the same paths. Staff oversight lives in the admin router: `/report-engine/merchant-reports`, `/report-engine/merchant-executions` and the suspend/resume actions, proxied by `admin-back` and shown at `/reports/merchant-reports`.

### 9.4 Limits and abuse controls

Merchant tier limits are re-checked on verify, save and execute: ≤ 6 datasets, ≤ 2 joins, ≤ 20 select fields, ≤ 2 window fields, ≤ 24 sections, ≤ 10,000 rows, a bounded date range ≤ 92 days, spec ≤ 256 KB, zip ≤ 2 MB, a 5 s statement timeout, a lower EXPLAIN cost cap and no large-table sequential scans. Runtime controls: the `merchant_reports.policy` Platform Setting (`enabled` runner/Studio switch, `assetsEnabled` asset-bundle switch, read through a 5 s cache and invalidated after settings writes), per-merchant Studio suspension, 30 verifications/hour and 60 executions/hour, a daily DB-time budget (default 10 minutes), 50 codes with 20 versions each, one running execution per merchant plus a global semaphore (4), and a 60 s result cache keyed by `(merchant, spec, inputs)`. The merchant transcript prints the current asset policy; when assets are disabled, `required_assets` must be empty and `.zip` uploads are rejected.

## 9.5 API error handling

Invalid spec JSON returns `400 INVALID_JSON_SYNTAX`; a schema failure returns `400 SCHEMA_VALIDATION_ERROR` with the Zod issues. Admin execute returns `404 REPORT_NOT_FOUND` only when the code has no versions and `409 REPORT_NOT_PUBLISHED` with the latest status when versions exist but none is the published latest. Chrome save maps `P2002` to `409 REPORT_CHROME_DUPLICATE`, `P2003` to `409 REPORT_CHROME_REFERENCE_CONFLICT`, asset storage failures to `500 REPORT_CHROME_ASSET_SAVE_FAILED` and database failures to `500 REPORT_CHROME_SAVE_FAILED`, each with a reason. The admin portal renders returned diagnostics through `ReportDiagnosticsPanel`. The Studio also calls `POST /report-engine/specs/preview` to execute a verified draft with sample inputs and render the sandboxed paginated preview; nothing is persisted.

## 10. Security additions

- `PII_MASKED` values are redacted after query execution unless the actor holds `piiUnmaskAuthorities` (default `security:write`).
- Confidential AML reports require MLRO/Compliance access. A Security Admin may request `allowConfidentialAmlBypass`, but it applies only after a different MLRO/Security Admin approves the `REPORT_AML_BYPASS` request.
- Chrome templates, inline chrome, `global_scoped_css` and custom SVG templates are sanitized. `<style>`, external `src`/`href`, `@import`, event handlers and executable URI schemes are rejected.
- The client Paged.js preview runs in a sandboxed same-origin iframe (`sandbox="allow-same-origin allow-scripts allow-modals"`) with a strict meta CSP (`script-src 'self'`, no inline scripts or executable URLs), external same-origin Paged.js scripts, and `postMessage` page counts with render tokens. The report cannot execute scripts or inject styles into the portal head; printing copies the paginated DOM into a fresh same-origin print window (scripts stripped), with a bridge `window.print()` fallback. Report font URLs are absolute same-origin URLs because Paged.js resolves CSS `url()` values against the `about:srcdoc` document URL; relative font paths make its CSS parser throw and leave a blank preview. The chrome preview uses a separate script-free sandboxed surface.
- Chrome `required_assets` are loaded during execution and during the Chrome preview.
- Schema version 27 adds the AML bypass flag, latest-published uniqueness and append-only execution audit.

## 11. Performance, transcript and DSL completeness

- Datasets execute with bounded concurrency (4) on the read-only pool; each dataset still runs in its own read-only transaction, and transforms run after all datasets complete.
- Window functions are evaluated over the full filtered/grouped result, then the dataset `ORDER BY`/`LIMIT` is applied. Base columns referenced only by window/order clauses are added to the inner projection so the window query remains valid.
- The AI transcript now includes the complete report field reference, dataset/query operators, transforms, sections, inputs, assets, merchant-scope rules, suggested access and chrome fields. The chrome transcript documents height, first-page, border, asset dimensions and every allowed variable.
- `suggested_access` is validated and surfaced as a warning when it grants a role/authority the queried models do not naturally allow.
- Chrome `max_width_mm`/`max_height_mm` are applied to `asset://` images when the template does not already set an inline style.

## 12. Authoring compatibility and limits

- The report schema accepts up to 64 datasets, 64 transforms, 128 sections, 20 inputs, 6 joins per dataset, 40 select fields and 5 window fields.
- Transform `operation` also accepts the authoring alias `kind`; COMPUTE_COLUMN accepts `compute`, `compute_op` or `operator` as aliases for `formula`. The persisted canonical form is always `operation` + `formula`.
- `default_value` accepts a raw literal, a preset object, or `{ literal: <value> }` (normalised to the raw value).
- `view_box` accepts `{ width, height }` or an SVG-style `"x y width height"` string.
- `format_hint` supports `INTEGER` in dataset selects and table columns, matching KPI cards; `BAR` is a valid vector node shape and maps to a rectangle.
- These limits, aliases and shapes are documented in the AI authoring transcript.

## 13. Reference resolution and compiler edge cases

- Layer 1 now builds a field registry from every dataset's `select[].alias` and `window_fields[].alias`, then processes transforms in order: COMPUTE_COLUMN adds its output, JOIN_DATASETS unions left/right fields, PIVOT_DATASET exposes the row key plus a wildcard for data-dependent columns, and COMPARE_WITH_ASSET exposes the source fields plus `_asset_matched`, `_has_discrepancy`, `<field>_expected` and `<field>_variance`. Sections and visibility conditions are validated against this final registry.
- GROUP BY on a select alias backed by `CASE_WHEN_ENUM` expands to the underlying column, while other expressions still compile normally.
- `resolveColumnSql` is initialized before join processing, so `additional_on` predicates compile safely; a regression test covers an `additional_on` join plus an aggregate from the joined alias.
- ZIP assets are flattened to unique basenames, `./` prefixes are removed, duplicate basenames are rejected, and required-asset lookup is case-insensitive when there is exactly one match. The stored relative path uses the required canonical `file_name`, so later execution can retrieve the asset.

## 14. Transform output contract and diagnostics

- COMPARE_WITH_ASSET accepts an optional `output_field` per compare field. The output dataset always contains the source fields, the `asset_field` target value, `_asset_matched`, `_has_discrepancy`, `<dataset_field>_expected` and `<dataset_field>_variance`. When `output_field` is set it is an additional alias for the asset_field target value; when omitted, the asset_field name is addressable.
- COMPUTE_COLUMN `right_operand` is optional only for unary `PERCENTAGE_SHARE`; other formulas require it. `PERCENT_BPS` is accepted as a transform output format.
- Section-field diagnostics list available fields/datasets, add a closest-match suggestion, and distinguish unknown datasets from unknown fields.
- ZERO_NATURAL_ROLE_INTERSECTION remains a non-blocking warning and points to the Security Admin override; SUGGESTED_ACCESS_CONFLICT is emitted only when `suggested_access` is present.

## 15. Authoring transcript v1.1, mock preview and A4 containment

### 15.1 Transcript v1.1

`ReportTranscriptBuilder` now emits `report-engine-ai-transcript-v1.1.md` with:

- a mandatory self-validation checklist and a diagnostic-code→fix table derived from the verifier contract;
- the exact zod limits, required fields, identifier regexes and enum vocabularies;
- the joined-column rule (a select/predicate on a joined model must set `table_alias`) and the missing-column rule (join the related model that owns the field);
- an explicit COMPUTE_COLUMN contract (it appends `output_column` to `target_dataset_id`; it does not create a dataset and has no `output_dataset_id`);
- KPI-tone vs badge-tone vocabularies, `badge_tone_map` values, and the `{{$t.*}}`/`asset://`-only HTML template rule;
- SVG asset hygiene (no C2PA/foreign namespaces/metadata);
- authoring recipes and a complexity budget;
- **no chrome authoring** (headers/footers are a separate `kind=CHROME` workflow) unless a brief explicitly asks.

`transcript/reportableModels.ts` excludes engine-internal, authentication, queue, backup, gateway-configuration and report-engine storage tables from the transcript; Layer 2 rejects them with `MODEL_NOT_REPORTABLE`. The `?domains=` filter is fixed to the catalog domains and new `?models=`/`?brief=` parameters support brief-scoped transcripts.

### 15.2 Additional verification and compiler rules

- `AGE_DAYS` is a scalar expression (`EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - column)) / 86400.0`) usable with `AVG`/`MAX`; direct `AVG`/`SUM` on datetime/string/enum columns is rejected with `AGGREGATE_REQUIRES_NUMERIC`.
- `SUM`/`AVG` over `CASE_WHEN_ENUM` casts numeric `THEN` values to `numeric`, fixing `function sum(text) does not exist`.
- Report `HTML_TEMPLATE` tokens other than `{{$t.key}}` produce `UNSUPPORTED_TEMPLATE_TOKEN`.
- A large-table sequential scan is now an error only when its estimated cost is at/above `globalLimits.maxSeqScanCost` (admin: 25 000). A cheap bounded scan of a single partition is allowed, removing a false positive that made valid ledger datasets fail.
- `UNKNOWN_COLUMN` hints point at the joined model alias, or at the relation to join when the field is not on the base model. `UNKNOWN_TRANSFORM_DATASET`/`UNKNOWN_SECTION_DATASET` recognise a COMPUTE_COLUMN `output_column` and point at its target dataset.
- The merchant scope column is cast to text when the query is aggregated (`MAX(<scope>::text)`), because PostgreSQL has no `max(uuid)`; an aggregate row with a null scope column (zero matching rows) is skipped instead of raising a false `MERCHANT_SCOPE_VIOLATION`.

### 15.3 Studio mock preview

`lib/reportEngineSdk/preview/MockReportBundleBuilder.ts` builds a database-free, deterministic preview bundle from the spec: typed rows per dataset, window fields, the real transform pipeline (including COMPARE_WITH_ASSET), placeholder image assets and engine-injected merchant inputs. `POST /report-engine/specs/preview` and the merchant `/studio/preview` accept `mode: "MOCK" | "LIVE"` (default `MOCK`); MOCK still runs the five verification layers but never queries the database. The client renderer accepts `includeHiddenSections`, so a mock preview renders visibility-gated sections instead of hiding them.

### 15.4 A4 print containment

The paged-media stylesheet now uses fixed-layout data tables, wraps long values (`overflow-wrap:anywhere`), constrains HTML-template tables, charts, SVGs, images, chrome running elements and Paged.js content wrappers to the page content box. `show_on_first_page=false` still removes the first-page chrome. `tests/e2e/admin/report-a4-layout.spec.ts` renders a mock bundle through the real client SDK + Paged.js and asserts no visible client rect crosses the A4 content box in English and Arabic, portrait and landscape.

## 16. Print layout hardening (2026-11-11)

The showcase fixture `npg-ops-finance-deep-dive-showcase-v2` exposed structural print defects that were independent of the DSL. The renderer and transcripts now enforce:

- **KPI grids:** `columns` is capped at 3 (schema and transcript). Cards are flex columns with a reserved title area and a bottom-anchored metric block; values use a content-length font scale and never wrap mid-number; `delta_format_hint` lets a basis-point delta render as `PERCENT_BPS` instead of currency.
- **Section flow:** titles/subtitles use `break-after: avoid`; KPI, chart, vector, image and HTML sections use `break-inside: avoid`; compact tables (<= 8 rows) keep their title and content together.
- **Charts:** consecutive sub-100% charts are paired in a centered `.report-chart-row`; alone they are centered. Charts have an HTML legend outside the SVG with wrapping and real spacing; pie/donut slice labels are suppressed; series/category labels are truncated consistently; date axes render `YYYY-MM-DD`; long category labels switch BAR/STACKED_BAR to horizontal bars; value labels use `labelLayout.hideOverlap`; heatmaps keep the ECharts visualMap and omit the series legend; zero-row charts render a localized empty state.
- **Descriptions:** the transcript requires `subtitle_i18n_key` on every CHART and DATA_TABLE; missing descriptions produce a Layer 1 `MISSING_SECTION_DESCRIPTION` warning. The transcript also warns against `overflow-wrap:anywhere` on `td,th` in `global_scoped_css`, which defeats chip and number wrapping.
- **Tables:** print tables use a 7.8pt body / 7pt header scale and 3.5pt padding; numeric cells are no-wrap; long chips get `report-badge--long`/`--xlong` and never break words; pivot wildcard headers humanise snake_case; total labels are no-wrap; column widths are normalised to 100%. Long category charts (BAR/STACKED_BAR with long labels) render as horizontal bars so their labels stay readable.
- **Header repetition:** Paged.js splits tables into fragments without `<thead>`. `paged-preview-bridge.js` re-inserts the header/colgroup by `data-ref`, with a column-count fallback, MutationObserver and delayed passes; the print handler repeats the pass before printing.
- **Mixed orientation:** page-level named-page classes carry `page: landscape|portrait`; the bridge injects `@page` size rules after Paged.js has consumed the author rules. Chrome's print/PDF output now produces real landscape pages (12–15 in the showcase) instead of portrait sheets with clipped landscape content.
- **Vector text:** node labels/values wrap, use a length-aware font cap and padding, and are placed with the value bottom-aligned inside the node; short flow edges omit impossible labels; circle/diamond labels centre.
- **HTML templates:** `.report-html-section` keeps small narrative blocks together and uses a compact print base (8.5pt; author CSS can still override with a smaller size).

The sample spec was updated as a showcase fixture (KPI columns 3, chart/table subtitles, delta format, compact Methodology CSS). `tests/e2e/admin/report-a4-layout.spec.ts` now asserts sheet containment, vertical overflow, orientation, table header repetition, KPI column/value fit, chart-row centering and orphan titles; it can export the paginated PDF (`REPORT_LAYOUT_PDF`) and the generated `src/output/npg-ops-finance-deep-dive-showcase-v2-fixed-{en,ar}.pdf` are the reference output.

## 17. Chrome layout and multi-color bands (2026-11-11)

The institutional header/footer review exposed a chrome-specific layout defect: `.report-chrome` had a `min-height` slot but the template root (`lnpg-header`/`lnpg-footer`) did not fill it. The header root measured 13.6 mm inside a 22 mm slot, leaving an 8.4 mm internal gap, short teal/orange accent bars and a footer background only 11.4 mm inside a 16 mm slot.

- `.report-chrome` is now a flex column with `position: relative`, and its first child fills the configured height. The wrapper carries an explicit `height`/`min-height` from `chrome.height_mm`. The header/footer roots fill the slot; the left/right accent bars and footer background span the full chrome.
- `ReportChromeSpec.chrome.accent_band` is a new optional structured field: `position` (`TOP`/`BOTTOM`), `height_mm`, `radius_mm`, and 2-6 `segments` (`color`, `width_percent`). It renders a hard-stop `linear-gradient` band and takes precedence over `border_style`. The old single-color `ACCENT_BAND` rule remains for legacy specs. The chrome transcript documents the field and a reference 58/26/16 example.
- `ChromeVariableBindingSchema` adds `defaultCurrency`; the core execution bundle now returns `currency`. `renderChromeHtml` localizes `periodSummary` (`01 Jan 2026 – 31 Oct 2026`) and `generatedAtFormatted` (`11 Nov 2026, 14:31`) using the selected report locale.
- The provided `institutional-header-v1`/`institutional-footer-v1` specs were aligned to the reference HTML values (root `height:100%`, reference font sizes/widths, header period currency and multi-color band). They were published as new versions and set as the global defaults.
- The Chrome Studio preview now renders a real A4 page frame with sample body content, the selected header/footer and the global default counterpart, using realistic period/currency/title/subtitle/timestamp samples.
