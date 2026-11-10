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
  - core-back/api/internal/merchantReportEngine.ts
  - core-back/api/internal/merchant.ts
  - merchant-back/api/protected/reportEngine.ts
  - merchant-front/src/pages/reports/index.tsx
  - merchant-front/src/lib/reportEngineSdk/**
  - core-back/prisma/seed.ts
design_sources:
  - design/12-reporting/dynamic_ai_transcript_report_engine_sdk_plan.md
tests:
  - core-back/test/reportEngineSdk/**
  - merchant-back/test/core-forwarding.test.ts
  - admin-front/src/lib/reportEngineSdk/__tests__/**
  - merchant-front/src/pages/reports/index.tsx
  - core-back/test/exhaustive/01-schema/**
  - core-back/test/phase1-mtls-and-schema.test.ts
  - admin-back/test/**
gaps:
  - `SERVER_PDF` rendering is not implemented; execution requests for it return `501 SERVER_PDF_NOT_CONFIGURED` and the client Paged.js vector path is the supported renderer.
  - The report asset store is local filesystem (`REPORT_ASSET_STORAGE_DIR`, default `.report-assets`); object storage and signed asset delivery are not implemented.
  - `REPORT_READONLY_DATABASE_URL` may point at a replica, but replica routing is not verified in the report executor on a live multi-host deployment.
  - Report execution audits record the actor, scope and verification hash but do not yet copy the audit row into the dedicated audit database.
  - The merchant portal runs merchant-safe reports; it does not author reports or manage chrome.
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

## 6. Schema versions 26 and 27

`20261110120000_dynamic_report_engine_sdk` adds:

- enums `ReportSpecStatus`, `ReportChromeType`, `ReportAudienceScope`, `ReportAuthorityMode`;
- `report_asset_bundles` (bundle SHA-256, storage key, total bytes, file count, manifest, uploader);
- `report_chrome_specs` (code/version, type, status, single global default per type via a partial unique index, supported locales, spec JSON/SHA-256, publisher);
- `report_definition_specs` (code/version, category, audience, status, latest-published flag, supported/default locales, spec JSON/SHA-256, verification report, inferred roles/authorities, conflict status, confidential AML flag, override fields, publisher);
- `report_execution_audit` (spec, code/version, actor, locale, scoped merchant, redacted inputs, row count, duration, node, verification hash, render target).

`REQUIRED_SCHEMA_VERSION` is 27; version 27 adds the AML bypass flag, latest-published uniqueness and the append-only execution audit. The seed calls `seedDefaultChromeSpecs` after the admin users exist, so a fresh database has one published bilingual header and footer marked as global defaults.

## 7. Security invariants

- Report SQL is never stored or accepted as raw SQL; only the AST is persisted.
- Every query runs in a read-only transaction on a dedicated pool.
- A merchant-facing report must bind `merchant_id` to the merchant scope input; the API also rejects a merchant actor whose application scope does not match.
- `FORBIDDEN_SECRET` columns (credential ciphertext, password hashes, sealed secrets) are rejected at Layer 2 and never appear in the transcript catalog.
- A Security Admin override requires the `security:write` authority and a non-empty justification; the override is stored on the spec and audited.
- The execution audit stores redacted inputs and a SHA-256 verification hash of the executed datasets.

## 8. Tests

`core-back/test/reportEngineSdk/**` implements the RE-T01..RE-T22 matrix (plus extra dry-run/transcript cases). `admin-front/src/lib/reportEngineSdk/__tests__/**` covers formatting, RTL vector mirroring, chrome binding, the language prompt options, the paged-media document and the client sanitizer. The exhaustive schema suite and `phase1-mtls-and-schema.test.ts` verify schema version 27 and the four new models.

## 9. Merchant report runner

`core-back/api/internal/merchantReportEngine.ts` is mounted under `/internal/merchant/report-engine` after merchant authentication. It exposes a catalog, autocomplete and execute route. The catalog accepts `page`, `pageSize`, `search`, `sortKey` and `sortDirection`, applies the merchant scope validation before slicing and returns the filtered total. Every merchant execution:

- requires `report_engine:run`;
- accepts only `MERCHANT_FACING`/`BOTH` reports;
- runs `validateMerchantReportScope` (every base/join model must be merchant-scopable, every model must be filtered by the scope input, and no OR branch may escape it);
- overwrites `inputs[report.merchant_scope_input_key]` with `principal.merchantId`;
- records the forced merchant ID in `report_execution_audit`.

`merchant-back/api/protected/reportEngine.ts` proxies the routes, and `merchant-front/src/pages/reports/index.tsx` is the portal page. The merchant SDK is a mirrored copy of the admin frontend SDK because this repository has no shared frontend workspace package.

## 9.1 API error handling

Invalid spec JSON returns `400 INVALID_JSON_SYNTAX`; a schema failure returns `400 SCHEMA_VALIDATION_ERROR` with the Zod issues. Admin execute returns `404 REPORT_NOT_FOUND` only when the code has no versions and `409 REPORT_NOT_PUBLISHED` with the latest status when versions exist but none is the published latest. Chrome save maps `P2002` to `409 REPORT_CHROME_DUPLICATE`, `P2003` to `409 REPORT_CHROME_REFERENCE_CONFLICT`, asset storage failures to `500 REPORT_CHROME_ASSET_SAVE_FAILED` and database failures to `500 REPORT_CHROME_SAVE_FAILED`, each with a reason. The admin portal renders returned diagnostics through `ReportDiagnosticsPanel`.

## 10. Security additions

- `PII_MASKED` values are redacted after query execution unless the actor holds `piiUnmaskAuthorities` (default `security:write`).
- Confidential AML reports require MLRO/Compliance access. A Security Admin may request `allowConfidentialAmlBypass`, but it applies only after a different MLRO/Security Admin approves the `REPORT_AML_BYPASS` request.
- Chrome templates, inline chrome, `global_scoped_css` and custom SVG templates are sanitized. `<style>`, external `src`/`href`, `@import`, event handlers and executable URI schemes are rejected.
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
