---
id: core.report-engine
title: Dynamic Report Engine SDK and Report Studio Host
status: implemented
confidence: high
last_verified: 2026-11-09
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
  - Archive/list APIs exist but the admin Studio has no version-history page yet.
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
| GET | `/report-engine/catalog` | Published catalog filtered by the actor's authority policy. |
| GET | `/report-engine/autocomplete` | Autocomplete provider query. |
| POST | `/report-engine/execute` | Read-only execution; returns datasets, resolved chrome, asset data URLs and verification hash. |
| GET | `/report-engine/chrome` | Chrome registry. |
| POST | `/report-engine/chrome` | Create/update a chrome spec. |
| POST | `/report-engine/chrome/:id/set-default` | Set the single published global default per type. |

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

`core-back/api/internal/merchantReportEngine.ts` is mounted under `/internal/merchant/report-engine` after merchant authentication. It exposes a catalog, autocomplete and execute route. Every merchant execution:

- requires `report_engine:run`;
- accepts only `MERCHANT_FACING`/`BOTH` reports;
- runs `validateMerchantReportScope` (every base/join model must be merchant-scopable, every model must be filtered by the scope input, and no OR branch may escape it);
- overwrites `inputs[report.merchant_scope_input_key]` with `principal.merchantId`;
- records the forced merchant ID in `report_execution_audit`.

`merchant-back/api/protected/reportEngine.ts` proxies the routes, and `merchant-front/src/pages/reports/index.tsx` is the portal page. The merchant SDK is a mirrored copy of the admin frontend SDK because this repository has no shared frontend workspace package.

## 10. Security additions

- `PII_MASKED` values are redacted after query execution unless the actor holds `piiUnmaskAuthorities` (default `security:write`).
- Confidential AML reports require MLRO/Compliance access. A Security Admin may request `allowConfidentialAmlBypass`, but it applies only after a different MLRO/Security Admin approves the `REPORT_AML_BYPASS` request.
- Chrome templates, inline chrome, `global_scoped_css` and custom SVG templates are sanitized. `<style>`, external `src`/`href`, `@import`, event handlers and executable URI schemes are rejected.
- Chrome `required_assets` are loaded during execution and during the Chrome preview.
- Schema version 27 adds the AML bypass flag, latest-published uniqueness and append-only execution audit.
