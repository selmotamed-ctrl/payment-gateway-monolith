# Report Engine Remediation Plan (2026-11-10)

Status: **plan + execution record**. Source plan: `design/12-reporting/dynamic_ai_transcript_report_engine_sdk_plan.md`.
Canonical parts touched: `project-design/parts/01-core-back/12-report-engine-sdk.md`, `parts/03-admin-front/07-report-studio.md`, `parts/04-merchant-front/02-reports.md`, `parts/03-admin-front/00-ui-system.md`, `parts/04-merchant-front/00-portal.md`.

## 0. How this plan was produced

Four independent read-only audits were run on 2026-11-10 against the working tree (`optomizations-plan`, `6f1e605`):

1. core SDK (DSL, compilers, verifiers, executor, transcript, host catalog);
2. core API routes, edge proxies, schema, seed;
3. frontend behaviour (client SDK, Catalog/Studio/Chrome, merchant page);
4. visual style against the portal design system.

Most P0/P1 findings were reproduced with scripts against the real `schema.prisma` catalog and compiler, or with an Express mount reproduction. Baseline: `core-back` `test/reportEngineSdk` 64 pass / 1 skip (after `bun install`; `jszip` and `pagedjs` were declared but not installed in the dev tree), admin-front type-check and 11 SDK unit tests pass. None of the existing tests covered the defects below.

Severity: **P0** wrong data or security, **P1** broken feature, **P2** missing plan feature / integrity, **P3** minor.

## 1. Findings and fixes

### WS-A — Core SDK and host catalog (`core-back/lib/reportEngineSdk/**`, `core-back/engine/reportStudio/**`)

| ID | Sev | Finding | Fix | Test |
| :--- | :--- | :--- | :--- | :--- |
| A01 | P0 | Window/order base columns not in `select` are emitted as extra output columns (`_base.*`) and bypass `redactPiiRow`; authority inference ignores them. | Wrap the base query and project only select + window aliases outward; extra base columns never leave the inner query. Authority/PII inference scans every referenced column (select, where, group, order, window, join). | compile test: window ordered by a PII column → column absent from output; inference flags PII. |
| A02 | P0 | Secret/PII classification uses exact-name sets; many ciphertext/hash/token/bank/national-id/email/IP columns are `PUBLIC` and appear in the transcript. | Pattern classifier: `/ciphertext|_hash$|secret|_token$|token_hash|private_key|password|_ref$ on crypto/ |code_hash/` → `FORBIDDEN_SECRET`; `name|email|phone|iban|bank|national|address|client_ip|_json` on KYB/payout/people tables → `PII_MASKED`; explicit allow-list overrides. | catalog test asserting every listed column's class. |
| A03 | P0 | Relation parser ignores `@relation("Name")`, composite keys and 1:1 back-relations → wrong join columns (e.g. `users.checkerApprovalRequests` joins on `maker_user_id`; `t0.id = c.id`). | Pair inverse relations by relation name; multi-column `fields/references` as key-pair arrays ANDed in the compiler; 1:1 back-relation resolved from the FK side. | catalog tests for the named examples; compiler test for composite join. |
| A04 | P0 | `COMPARE_WITH_ASSET` gets no asset rows at runtime (routes pass `assetBundleId` only) → every row "discrepant". | `executeReport` loads `COMPARISON_BASELINE_DATA` assets from the bundle via `getAssetBuffer` when `input.assets` is absent. | executeReport test with a stored bundle. |
| A05 | P1 | `COMPARE_WITH_ASSET` overwrites the live field with the asset value when names match; unmatched asset rows and duplicate asset keys are silent. | Never overwrite source fields; write `<field>_expected`, `<field>_variance`, optional `output_field`; append `_missing_in_live` rows; flag `_duplicate_asset_key`. | transform tests. |
| A06 | P1 | `JOIN_DATASETS` keeps one right row per key (last wins); null keys match each other. | `Map<string, Row[]>`, cross product, null keys never match. | transform tests. |
| A07 | P0 | Transform/CSV math uses JS `Number` (money invariant); CSV coerces `"0012"` → `12`. | decimal.js for all arithmetic, results as strings; CSV cells stay strings, coercion only at compare time. | transform tests with `0.1+0.2`, > 2^53, leading zeros. |
| A08 | P1 | `MINOR_TO_MAJOR_DECIMAL` on a major-unit column divides by 1000. | Layer 2 rejects it unless the column is a synthetic `_minor` column. | validator test. |
| A09 | P1 | Mandatory partition filter bypassable (`is_not_null`, optional `gte` with `omit_if_empty`); `allowedOperators`/`requireIndexedFilter` unused; literal range hard-coded 366. | Require `between` or a lower+upper pair bound to a required input or bounded literals; forbid `omit_if_empty` on mandatory predicates; enforce `allowedOperators`, `requireIndexedFilter`, per-model `maxDateRangeDays`. | validator tests per bypass. |
| A10 | P1 | EXPLAIN guard looks for `journal_lines_p*`, real partitions are `journal_lines_YYYY_MM`/`_default` → never fires; seq scan only a warning (plan RE-T07 says reject). | Detect children by parent prefix; count partitions scanned; large-table seq scan is an error. | executor plan-parsing unit test. |
| A11 | P1 | Transcript example uses non-existent `journal_lines.merchant_id/currency`; documents invalid op `gte_lte`; never lists enums; unit semantics and per-model range limits wrong. | Example built from a merchant-scopable model in the live catalog and verified in a test; print `between | gte+lte`; emit enum values; document `_minor` scale and per-model limits. | test: transcript example passes layers 1–3. |
| A12 | P0 | Scoped CSS can contain `</style>`; sanitizer regex bypasses (unquoted `src=`, inline `style` url(), `srcset`, `<image href>`, entity-encoded schemes, `<use href=data:>`, CSS escapes, `image-set`). | Parser-based allow-list sanitizer (tags/attrs allow-list, entity-decoded scheme check, attribute `style` through the CSS checker, only `asset://`/`#` URLs, CSS escape decoding, reject `<` in CSS). | sanitizer tests for each bypass. |
| A13 | P1 | Confidential-AML gate covers only `aml_cases`/`aml_screenings`. | Whole `COMPLIANCE_AML` domain (incl. `regulatory_reports`, matches, rules, reporting rules) is confidential. | catalog test. |
| A14 | P2 | Window + GROUP BY or ORDER BY on non-grouped base columns produces invalid SQL that verify accepts. | With `group_by`, ORDER BY / window refs must be select aliases or grouped columns (Layer 2 error). | validator test. |
| A15 | P2 | Input definitions never compiled at verify time (bad regex → 500 at run; defaults not validated; enum literals unchecked; preset on `date` returns range). | Layer 1 compiles the Zod schema, vets regex (length cap + try/catch), parses resolved defaults, checks enum literals against `host.enums`, rejects range presets on non-range inputs. | structural tests. |
| A16 | P2 | Layer 5 reported `passed` when skipped. | `status: "SKIPPED"` in the layer scorecard. | dry-run test. |
| A17 | P1 | Zip-bomb check trusts header sizes, inflates whole entry first; symlinks not rejected. | Stream-inflate with a running byte cap; reject symlink entries (`unixPermissions & 0o170000 === 0o120000`). | bundle tests. |
| A18 | P3 | `ilike_prefix` does not escape `\`; multi-autocomplete items not UUID-validated (→ 500); `client.release()` without error returns broken connections; COUNT over PII masked; `IMAGE_BANNER.caption_i18n_key` not checked; no truncation flag. | `ESCAPE '\'`; uuid items; `release(err)`; skip masking aggregates; i18n check; `truncated: true` on datasets at cap. | unit tests. |
| A19 | P2 | Replica ReadStore routing (plan §5 Mode B) missing; falls back to the write-capable `DATABASE_URL`. | Keep fallback but surface `servedBy: "primary-readonly-tx"` vs `"replica"` honestly; record as gap (no live replica to verify). | — (gap) |

### WS-B — Core API, edges, schema, seed

| ID | Sev | Finding | Fix | Test |
| :--- | :--- | :--- | :--- | :--- |
| B01 | P1 | Merchant router mounted under `/report-engine` while routes already start with `/report-engine` → every merchant report call 404s. | Mount without prefix. | core route test hitting the real merchant paths. |
| B02 | P1 | Global `express.json({limit:"1mb"})` in core runs first → zips > ~750 KB 413; admin-back caps at 4 MB. | Core: report-engine prefix parsed with a 24 MB limit before the global parser (skip global for that prefix). admin-back: route-level 24 MB parser for `/report-engine` ahead of the global one. Client checks 15 MB zip size. (Deviation from plan §9.2 multipart, recorded.) | core + admin-back body-size tests. |
| B03 | P1 | Edge guard treats `catalog/:code/execute` as a write and blocks most staff from listing/running; no seeded role holds `report_engine:run`. | Catalog/autocomplete/execute allowed for any authenticated staff principal at the edge (core enforces policy); `report_engine:run` granted to staff roles in seed and `createAdminPlan`. | admin-back guard test. |
| B04 | P1 | Publishing a new chrome version leaves older versions `PUBLISHED`; selection and asset loading then depend on row order; default stays on the old version. | Publish supersedes (archives) earlier published versions of the code in the same transaction and moves the default flag; registry/resolution choose the highest published version per code. | route test. |
| B05 | P2 | Stored `version` ≠ `spec.report.version` → printed version and hash disagree with DB/audit. | Persist the spec with `report.version = row.version` before hashing. | route test. |
| B06 | P2 | Save races surface as 500 (`P2002`); asset dedup find-then-create race; audits written outside the transaction. | Map `P2002` → `409 REPORT_SPEC_CONFLICT`; upsert bundle; `writeAudit(tx, …)` inside transactions. | route test. |
| B07 | P1 | AML bypass approve race, no expiry check, reject of an already-approved request, no re-check of the spec. | Conditional claim on `PENDING_REVIEW` + unexpired; reject only pending; approve re-checks spec status & confidential flag. | route tests. |
| B08 | P2 | Override applied to a VERIFIED row is lost on publish (publish re-POSTs and creates version+1); no way to publish an existing version. | `POST /report-engine/specs/:id/publish` (core + admin-back + Studio row action); carries override. | route test. |
| B09 | P2 | Archiving the published version leaves the report with no published version. | Promote previous published version in the same transaction. | route test. |
| B10 | P2 | `{{actorEmail}}` always empty (email null), actor name is UUID. | Look up user email/display name in both routers. | route test. |
| B11 | P3 | `GET /chrome` has no authority check, returns drafts, inlines base64 assets for 200 rows. | Non-authors see only published; assets inlined only for `?includeAssets=1` / single preview. | route test. |
| B12 | P3 | `BACKOFFICE_INTERNAL` tab excludes `BOTH`. | Include `BOTH` in both audience tabs. | route test. |
| B13 | P2 | Merchant routes skip `isActorAllowedByPolicy`; merchant catalog returns full AST. | Apply policy; merchant catalog returns only inputs, i18n, sections metadata needed to render (no datasets AST). | route test. |
| B14 | P3 | Seed resets defaults and un-archives seeded chrome on every run. | Only set status/default on create. | seed test. |
| B15 | P3 | `String[]` fields lack `@default([])` vs migration defaults (drift). | Add `@default([])`. | schema test unchanged. |
| B16 | P3 | `55P03` lock timeout and compile errors → 500; redaction regex `/pin|key/` over-matches. | `55P03` → `408 REPORT_LOCK_TIMEOUT`; compile errors → `422 REPORT_COMPILE_ERROR`; redaction by exact sensitive key list. | route test. |
| B17 | P2 | Request carries `headerMode:"<code>"` from UI (see C07); API has no `headerChromeCode` echo. | API accepts `{headerMode:"SPECIFIC_CHROME_CODE", headerChromeCode}` (already), validated; UI fixed in C07. | — |

### WS-C — Client rendering SDK (admin + merchant mirror)

| ID | Sev | Finding | Fix |
| :--- | :--- | :--- | :--- |
| C01 | P0 | Footer totals computed in float, unscaled, unformatted; COUNT counts numerics only; "Total" hard-coded. | decimal.js aggregation, null-skipping, formatted with the column hint, translated label. |
| C02 | P0 | `Number(value)/1000` for money; currency always LYD. | decimal.js scaling; currency from row field (`currency`), input, or bundle meta. |
| C03 | P1 | Paged.js preview: stylesheets passed as `[]`, Polisher styles injected into the portal `<head>`, unpaginated body left in place, no cancel/cleanup → no pagination, running chrome, page counts; CSS leaks into the app. | Render inside an opaque-origin sandboxed iframe (`sandbox="allow-scripts allow-modals"`, no `allow-same-origin`) whose `srcdoc` carries a strict CSP (nonce script only, `img-src data:`), the inlined Paged.js polyfill and the sanitized report; parent ↔ iframe via `postMessage` (page count, print request). Render tokens cancel stale renders. |
| C04 | P1 | App `t` passed into renderer → report labels render as raw keys. | Renderer always uses the spec dictionary for the selected locale; app `t` only for engine chrome labels. |
| C05 | P1 | `ENUM_TRANSLATED` never translates. | Pass spec `t`, key convention `enum.<VALUE>` (documented in transcript). |
| C06 | P1 | Required booleans never seeded → 400. | `resolveInputDefaults` seeds `false`. |
| C07 | P1 | Specific header/footer selection sends the code as `headerMode` → 400. | Send `SPECIFIC_CHROME_CODE` + code; one option per code (latest). |
| C08 | P1 | CSV/XLSX: first-row headers only, no BOM, formula injection, raw minor units. | One sheet per dataset with translated headers and formatted values via `xlsxUIPipeline`; CSV removed from primary actions (portal standard is Export Excel). |
| C09 | P0 | Client does not sanitize custom SVG; scoped CSS injected raw. | SVG through `sanitizeReportHtml`; CSS strip `<`, `@import`, `url(` (non-data). |
| C10 | P2 | Input form: no min/max/regex/max_range_days enforcement; `static_filter` not sent; dependency only works for key `merchantId`; stale dependent selection; datetime `Z` shift; missing YESTERDAY preset; preset on `date` returns range. | Client Zod mirror for validation; send `staticFilter`; core providers read `dependentValues` by declared `depends_on_input` mapping; clear dependents; local→ISO conversion; preset matrix by type. |
| C11 | P2 | DATA_TABLE ignores `width_percent`, `badge_tone_map`, `avoid_row_split`; pivot wildcard columns not rendered; charts fixed 900 px; PAGE_BREAK landscape on the wrong node; duplicate chart title; RTL axis not inverted. | Implement each. |
| C12 | P3 | Language dialog keeps first choice; hard-coded English; preview toolbar hard-coded. | Reset on open; `t()` everywhere. |

### WS-D — Pages, visual style and i18n

Portal conventions (from `admin-front/src/components/ui/**`, `styles/fintech-minimal.css`, `plugins/vuetify.ts`): `ScreenContainer` › `ThemedView gap 18px` › `PageHeader` (no breadcrumbs; tonal `end` actions), `SurfaceCard`, `ApiTable`/`DataTable` + `TableRowActions`, `SegmentedTabs` above tables, `SlideOverDrawer` for row work, `FormModal`/`FormField`/`SectionFields` for forms, `StatusBadge` with human labels, `MonoRef` for codes/hashes, `showSnackBar` for success/copy, `extractApiErrorMessage`/`StateView` for errors, `showConfirm` for destructive actions, `formatDateTime`, `DateInput multiple="range"`, global compact density, `--pg-*` tokens only.

| ID | Sev | Finding | Fix |
| :--- | :--- | :--- | :--- |
| D01 | P1 | Report document styles: KPI/tone/badge/zebra classes have no CSS; `.report-kpi-grid` not a grid; fonts Inter/Tajawal not bundled; physical text-align in RTL; preview is one white strip. | Exporter stylesheet with print-safe values copied from the light `--pg-*` tokens, bundled Plus Jakarta Sans / Cairo / JetBrains Mono `@font-face` inlined (data URLs), logical alignment, paper sheets on a canvas with `--pg-shadow-sm`, dark-mode canvas. |
| D02 | P2 | Preview toolbar hand-rolled, hard-coded English, raw SHA, VBtn locale toggles, duplicate Print/Export/locale controls. | `SurfaceCard` header actions: Regenerate, Export Excel, Print/PDF; `MetaPill` page count; `MonoRef` hash; `SegmentedTabs` locale; preview without its own buttons. |
| D03 | P2 | `ReportLanguagePromptDialog` raw VDialog/VCard, hard-coded strings. | `FormModal size="sm"`. |
| D04 | P2 | `ReportInputForm`: density override, native date inputs, x-small preset buttons, inset grey switches, inline 12-col grid. | Defaults, `DateInput multiple="range"`, `SegmentedTabs`/chips presets, `color="primary"` switches, responsive grid class. |
| D05 | P2 | `ReportDiagnosticsPanel` alert wall. | One `SurfaceCard` with counts, rows with `StatusBadge`, `MonoRef` code/path, collapsible hint. |
| D06 | P2 | Catalog: breadcrumbs, English-only titles, raw enum badges, code as caption, tabs in TopSlot with inline padding, Run panel opens below the table, density overrides, copy without feedback, raw error messages, CSV + hex colour in export. | Fix per conventions; Run opens a `SlideOverDrawer` (form + output options), result card above the table. |
| D07 | P2 | Studio: raw badge text, persistent success alerts, monospace textarea, inline widths, raw dates, lone Archive button without confirm, hand-made override block, hand-rolled AML list, stray CSS import, stale verification after edit, maker sees Approve/Reject, no load-version-into-editor, no execution history, no live preview. | Shared `JsonSpecEditor` (pg-mono, ltr, no spellcheck, parse-error line); snackbars; `formatDateTime`; `TableRowActions` + `showConfirm`; override in `FormModal`; AML list in `DataTable`; invalidate verification on edit; hide decide actions for maker; "Open in editor" and "Publish" row actions; Executions tab; Preview step rendering the dry-run bundle. |
| D08 | P2 | Chrome page: density mismatch, preview in portal DOM without `dir`/scoped CSS, unlabelled locale select, edit drops zip without hint, no publish-later. | Preview in a drawer through the sandboxed paper surface; `SegmentedTabs`; zip-required hint; publish via save-as-new-version with publish switch on by default for edits of published rows. |
| D09 | P2 | Merchant page: lone Run button, double spacing, raw errors, exports always enabled, English titles, no friendly error mapping. | Mirror the catalog fixes with merchant components. |
| D10 | P3 | Missing i18n keys (`Copy AI Repair Prompt`, `Layer`, new labels); diagnostics fallback comparison never true. | Add EN/AR pairs; fix `diagnostics.ts`. |

### WS-E — Separate merchant reporting line (Studio, transcript, registry, execution) — owner request 2026-11-11

Requirement: merchant report authoring, transcript and execution are **completely separate** from the staff (admin-front) line. A merchant query may only touch merchant-allowed data and only that merchant's rows; the engine **self-validates** the merchant identity `WHERE` clause rather than trusting the spec. Merchants get their own Studio, protected against resource abuse.

| ID | Item | Design |
| :--- | :--- | :--- |
| E01 | Separate registry | New tables `merchant_report_specs` (owner `merchant_id`, code/version, status, spec JSON/SHA-256, verification report, created/published by merchant user) and `merchant_report_asset_bundles` (owner `merchant_id`). Unique `(merchant_id, code, version)`, one latest-published per `(merchant_id, code)`. Staff tables are never read or written by merchant authoring routes. Migration + `REQUIRED_SCHEMA_VERSION` bump. |
| E02 | Separate catalog/host | `merchantHostConfig` built from an **explicit allow-list** of merchant-scopable models (payments/attempts, refunds, settlements/statements, wallet statement lines, payment links, POS, applications, disputes, cash-outs — exact list fixed against `schema.prisma`) with column allow-lists; `FORBIDDEN_SECRET`, `PII_MASKED`, confidential AML, ledger internals and other-merchant/system tables are **absent from the catalog**, not merely blocked. Autocomplete limited to merchant-safe sources (own applications, currencies, own payment links/terminals). |
| E03 | Separate transcript | `MerchantReportTranscriptBuilder` generated only from the merchant catalog and merchant limits; no admin models, no authority/override/AML sections, no chrome authoring (merchants use platform chrome). Separate repair prompt. |
| E04 | Self-validating merchant identity | (1) The compiler **injects** `"<alias>"."merchant_id" = $merchant` for the base model and **every** joined alias as a top-level `AND` (spec-supplied merchant predicates are ignored/replaced; the `$merchant` parameter is bound from the authenticated principal only). (2) A post-compile verifier re-parses the compiled AST and rejects execution unless every model alias carries the injected predicate outside any `OR`. (3) Each dataset query selects a hidden `__scope_merchant_id` column; the executor asserts every returned row equals the principal's merchant before stripping it — any mismatch aborts, is audited and raises a P1 case. (4) Transforms cannot introduce cross-merchant data (assets are the merchant's own bundle). |
| E05 | Resource guards (anti-abuse) | Merchant tier limits enforced in Layer 1/2 and at runtime: ≤ 6 datasets, ≤ 2 joins/dataset, ≤ 20 select fields, ≤ 2 window fields, ≤ 24 sections, ≤ 10,000 rows/dataset, mandatory bounded date range ≤ 92 days on every dataset, `statement_timeout` 5 s, EXPLAIN total-cost cap lower than staff and no sequential scans on large tables, spec JSON ≤ 256 KB, zip ≤ 2 MB. **Dedicated merchant read-only pool** (small, separate from the staff report pool) so merchant load never starves staff reports or the app. Concurrency: 1 running execution per merchant, global merchant semaphore; queued requests fail fast with `429 MERCHANT_REPORT_BUSY`. Rate limits per merchant: verify 30/h, execute 60/h, daily DB-time budget (sum of execution ms) → `429 MERCHANT_REPORT_BUDGET_EXHAUSTED`. Storage quota: ≤ 50 report codes, ≤ 20 versions each. Result cache 60 s keyed by `(spec SHA, normalized inputs, merchant)`. Platform kill switch (platform setting) and per-merchant suspension of the Studio by staff. |
| E06 | Merchant routes and edge | `merchant-back` and core routes under `/report-engine/studio/*` (transcript, verify, save, publish, archive, versions, my-catalog, execute) and `/report-engine/catalog` (platform templates + own published). Merchant authorities `report_engine:author` (owner/admin roles) and `report_engine:run`. Every route reads the merchant only from the principal. |
| E07 | Platform templates | Staff-published `MERCHANT_FACING`/`BOTH` reports stay available as read-only templates, but run **through the merchant engine** (E04 injection and E05 limits apply). Merchants can clone a template into their own Studio. |
| E08 | Merchant Studio UI | `merchant-front` `/portal/reports/studio`: transcript download, JSON editor, `.zip` upload (≤ 2 MB), five-layer verification with diagnostics, save/publish/archive, version history, quota/usage meter (runs today, DB time used). Merchant Reports page lists templates + own reports. Same portal style as the admin Studio. |
| E09 | Staff oversight | Admin view of merchant-authored reports (read-only list per merchant, execution audit, suspend Studio) under the admin Reporting section. |
| E10 | Tests | Injection on every alias, OR-escape attempts, spec trying `merchant_id = <other>`, join to a non-allow-listed model, row-level scope assertion, every limit, rate limit/budget/concurrency, cache isolation between merchants, template execution through the merchant engine. |

## 2. Execution order

1. **WS-A** and **WS-B** in parallel (disjoint files: A owns `lib/reportEngineSdk/**` + `engine/reportStudio/**`; B owns `api/internal/*ReportEngine.ts`, `api/internal/merchant.ts` mount, `core-back/index.ts` parser, `admin-back/**`, `merchant-back/**`, `prisma/**`, seed, `createAdminPlan`). Contract between them: B calls `engine.executeReport` unchanged; A adds bundle-backed comparison assets inside the SDK.
2. **WS-C + WS-D** together after B's API contract is fixed (new `POST /specs/:id/publish`, `GET /executions` consumed by the Studio; `headerChromeCode`). Admin first; merchant SDK re-mirrored from admin (`diff -r` must show only `__tests__`).
3. **WS-E** after WS-A/WS-B land (it builds on the fixed SDK and merchant routes): E01–E06 backend, then E07–E09 UI, E10 throughout.
4. Docs: canonical parts updated, `TRACKER.md` entry, generator run.
5. Gates: `core-back` typecheck + `test/reportEngineSdk` + route tests; `admin-back`/`merchant-back` typecheck + tests; `admin-front`/`merchant-front` type-check + unit tests + build; `bun scripts/project-design/build.ts --check`; `git diff --check`.

## 3. Decisions and deviations

- **Upload transport:** route-scoped 24 MB JSON/base64 limits instead of plan §9.2 multipart; keeps the strict zod edge contract. Zip cap stays 15 MB, checked in the client.
- **Paged.js isolation:** opaque-origin iframe with scripts allowed and a nonce CSP, not `allow-same-origin`; the parent never touches the iframe DOM, so the report cannot reach the portal origin even if sanitization failed.
- **Exports:** Excel via the shared pipeline is the only primary export (portal standard); CSV is dropped from report pages.
- **Merchant SDK** remains a mirrored copy (no shared frontend package); a test asserts the mirror is identical.
- **Merchant Studio (owner, 2026-11-11):** approved on the condition that abuse and resource exhaustion are prevented — hence E05's hard limits, separate pool, per-merchant concurrency/rate/DB-time budget, quotas and the kill switch. The merchant identity predicate is engine-injected and verified three times (compile, post-compile AST, returned rows); the spec is never trusted for scoping.
- **Not in scope (stay gaps):** `SERVER_PDF`, object-store assets, live replica routing verification (A19), visual drag-and-drop builder, combined `.reportpkg.zip`.

## 4. Execution record

Filled in when each workstream lands (see `project-design/TRACKER.md`, 2026-11-10 report-engine remediation entry).
