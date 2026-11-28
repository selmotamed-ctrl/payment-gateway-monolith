# Libyan National Payment Gateway — Merchant Report Authoring Transcript (v1.1)
Generated: `1970-01-01T00:00:00.000Z` | Default Currency: `LYD` | Default Timezone: `Africa/Tripoli` | Spec version: `1.0`

## 1. Output Rules and Mandatory Self-Validation
Return **exactly one JSON object**. No markdown fences, no commentary, no extra files unless the task explicitly asks for an asset bundle.
Run the checklist below before returning. If any item fails, fix the spec and re-check; do not return a spec that fails a check.

### 1.1 Non-negotiable rules
- `spec_kind` MUST be `"REPORT_DESCRIPTOR"` and `spec_version` MUST be `"1.0"`.
- **Bilingual requirement:** populate English (`en`) and Arabic (`ar`) under `i18n.locales`; every referenced `*_i18n_key` must exist non-empty in both.
- Never write raw SQL. Use only the declarative dataset AST.
- Never author headers/footers or `REPORT_CHROME` documents. Use `GLOBAL_DEFAULT` unless the user explicitly asks for no branding (`NONE`).
- `HTML_TEMPLATE` supports ONLY `{{$t.<key>}}` translation tokens and `asset://<asset_key>` image references. It does NOT bind dataset values; any other `{{...}}` token is invalid.
- Do not invent models, columns, relations, enum values, authorities or template tokens.
- If the user did not ask for logos/assets, keep `required_assets` empty and do not reference `asset://`.
- The engine injects the merchant predicate. Never add a second merchant input; filter every merchant-scopable model by the scope input.

### 1.2 Self-validation checklist
1. JSON parses; exactly one object; `spec_kind` and `spec_version` correct.
2. `report.code` is kebab-case and <= 64 chars; `version` >= 1; category/audience/classification are allowed values.
3. `audience_scope` is `MERCHANT_FACING`/`BOTH` → `report.merchant_scope_input_key` points to an `entity_autocomplete` input with source `merchants`.
4. Every translation key used by inputs, section titles/subtitles, KPI labels, table headers, chart labels, vector node/edge labels, image captions and `{{$t.*}}` tokens exists in **every** locale; `report.title` should exist. If the platform header/footer shows `reportSubtitle`, also provide a non-empty `report.subtitle` translation in every locale.
5. Input keys are unique and match the identifier regex; enum inputs list `validation.enum_values`; defaults match the type; `daterange` inputs used for partition filters set `validation.max_range_days` within the model limit.
6. Every `from_model` and join `target_model` is in the catalog below; every column exists on the model/alias you reference; no `FORBIDDEN_SECRET` column is referenced. If a requested field is missing from the base model, join the related model that owns it (for example wallet currency for cashout requests) instead of inventing a column.
7. Every join uses a relation listed on the base model and a unique alias. Any select/predicate on a joined model sets `table_alias` to that alias.
8. Every table with a **MANDATORY** filter has a bounded predicate on that column, bound to a required `daterange` input (or a bounded literal); no `omit_if_empty` on mandatory filters.
9. Models with **INDEXED FILTER REQUIRED** have at least one indexed predicate (id, merchant_id, status, created_at, ...).
10. `group_by`/`order_by`/`window_fields` reference select or window aliases (preferred) or base-model columns; with `GROUP BY`, order/window references must be grouped aliases.
11. `having[].select_alias` is an aggregate alias.
12. Every transform references an existing dataset or earlier transform output; `output_dataset_id` values are unique; COMPUTE_COLUMN adds a column to `target_dataset_id` (it has NO `output_dataset_id`) and has `right_operand` unless the formula is `PERCENTAGE_SHARE`.
13. Every section dataset/field exists after transforms (select aliases + window aliases + transform outputs); section ids are unique.
14. `CHART` has a `title_i18n_key`; `width_percent` 30-100; series fields exist; pie/donut use a category x-field.
15. `DATA_TABLE` column widths are sensible and sum to <= 100; use short headers; do not exceed 8-10 columns unless the user asks for a wide table. `badge_tone_map` values are NEUTRAL/SUCCESS/WARNING/DANGER/INFO (never PRIMARY). Every table and chart has a descriptive `subtitle_i18n_key`.
16. `VECTOR_DRAW` node coordinates fit inside `view_box`; every node id referenced by an edge exists.
17. No unsafe HTML/CSS: no `<script>`, `<style>` outside `scoped_css`, event handlers, iframes, external URLs, `javascript:`/`data:` hrefs, or foreign SVG namespaces/C2PA metadata.
18. Every `asset://` and `COMPARE_WITH_ASSET` asset is declared in `required_assets`; visual assets are images; comparison assets are `application/json` or `text/csv`.
19. `page_layout` margins are within range; header/footer modes are valid and no chrome is authored.
20. The spec respects the complexity budget: prefer one dataset per visual and <= 10 datasets / <= 25 sections for a first version.

### 1.3 Diagnostic code → fix (the Studio returns these)
| Code | Fix |
| :--- | :--- |
| `INVALID_JSON_SYNTAX` | Return parseable JSON with no prose/fences. |
| `SCHEMA_VALIDATION_ERROR` | Fix the named field/type/limit from section 2. |
| `MISSING_I18N_KEY_FOR_LOCALE` | Add the named key to every locale. |
| `MISSING_DEFAULT_LOCALE_AR` | Add a complete `i18n.locales.ar` dictionary. |
| `UNKNOWN_MODEL` / `MODEL_NOT_REPORTABLE` | Use a model from section 3. |
| `UNKNOWN_COLUMN` | Use a documented column; check spelling. |
| `FORBIDDEN_SECRET_COLUMN` | Remove the secret/credential column. |
| `INVALID_JOIN_RELATION` | Use a relation listed on the base model. |
| `MANDATORY_PARTITION_FILTER_MISSING` | Add the bounded predicate from the model block. |
| `MANDATORY_FILTER_OPERATOR_NOT_ALLOWED` / `MANDATORY_PARTITION_FILTER_UNBOUNDED` | Use `between` or a gte+lte pair bound to the same daterange input. |
| `PARTITION_DATE_RANGE_UNBOUNDED` | Set `validation.max_range_days` within the model limit. |
| `INDEXED_FILTER_REQUIRED` | Add an indexed predicate (id, status, created_at, merchant_id). |
| `BETWEEN_REQUIRES_DATERANGE` / `UNKNOWN_INPUT_BINDING` | Bind `between` to a daterange input; declare the input. |
| `MERCHANT_SCOPE_INPUT_MISSING` / `MERCHANT_SCOPE_INPUT_INVALID` | Add a merchants entity_autocomplete input and set `merchant_scope_input_key`. |
| `MERCHANT_ISOLATION_FILTER_MISSING` | Filter every merchant-scopable model/alias by the scope input. |
| `MERCHANT_MODEL_OUT_OF_SCOPE` | Remove non-scopable models from a merchant-facing report. |
| `UNKNOWN_SECTION_DATASET` / `UNKNOWN_SECTION_FIELD` | Use a dataset/field produced by `datasets` or `transforms`. |
| `DUPLICATE_DATASET_ID` / `DUPLICATE_SECTION_ID` | Make ids unique. |
| `UNKNOWN_TRANSFORM_DATASET` | Reference a declared dataset or earlier transform output. |
| `UNSUPPORTED_TEMPLATE_TOKEN` | Use only `{{$t.key}}` or `asset://key` in HTML templates. |
| `UNSAFE_HTML_TAG_FORBIDDEN` / `UNSAFE_HTML_ATTRIBUTE_FORBIDDEN` | Remove scripts/external URIs/foreign SVG metadata. |
| `REQUIRED_ASSET_MISSING_FROM_ZIP` | Include the exact flat `file_name` in the `.zip`, or remove the asset. |
| `UNKNOWN_IMAGE_ASSET` / `UNKNOWN_COMPARISON_ASSET` | Declare the asset in `required_assets`. |
| `COMPARISON_ASSET_MIME_INVALID` / `VISUAL_ASSET_MIME_INVALID` | Use JSON/CSV for baselines and an image MIME for visuals. |
| `QUERY_COST_EXCEEDED` / `SEQUENTIAL_SCAN_DETECTED` | Add selective indexed predicates; use shards/pre-aggregated models when available. |
| `QUERY_COMPILATION_FAILED` / `DRY_RUN_EXECUTION_FAILED` | Re-check every model, alias, column, relation and binding. |

## 2. Exact Contract and Hard Limits
Every field below is validated. Values outside a limit are rejected, not clamped.

| Field | Rule |
| :--- | :--- |
| `report.code` | ^[a-z0-9]+(-[a-z0-9]+)*$, 3-64 chars, kebab-case |
| `report.version` | integer >= 1 (the server may assign the next version) |
| `report.category` | FINANCE_LEDGER, MERCHANT_SETTLEMENT, RECONCILIATION, COMPLIANCE_AML, GATEWAY_PERFORMANCE, OPERATIONS_SUPPORT, SECURITY_AUDIT |
| `report.audience_scope` | BACKOFFICE_INTERNAL, MERCHANT_FACING, BOTH |
| `report.classification` | INTERNAL, MERCHANT_CONFIDENTIAL, REGULATORY_RESTRICTED |
| `page_layout.paper_size` | A4, LETTER, LEGAL (use A4 by default) |
| `page_layout.orientation` | PORTRAIT, LANDSCAPE |
| `page_layout.margins_mm` | top/bottom 10-50, left/right 8-40 (defaults 26/24/14/14) |
| `page_layout.header_mode` / `footer_mode` | GLOBAL_DEFAULT, SPECIFIC_CHROME_CODE, INLINE_SPEC, NONE |
| `inputs` | <= 20; key must match ^[a-zA-Z][a-zA-Z0-9_]*$ and be <= 48 chars; keys unique |
| `inputs[].layout_col_span` | integer 3-12 (default 6) |
| `datasets` | 1-64; `dataset_id` matches ^[a-zA-Z][a-zA-Z0-9_]*$; ids unique |
| `datasets[].select` | 1-40; aliases unique and match ^[a-zA-Z][a-zA-Z0-9_]*$ |
| `datasets[].joins` | <= 6; alias unique; relation must exist on the base model |
| `datasets[].group_by` | <= 15 |
| `datasets[].having` | <= 5; alias must be an aggregate |
| `datasets[].window_fields` | <= 5 |
| `datasets[].order_by` | <= 5 |
| `datasets[].limit` | integer 1-10000 (default 1000) |
| `transforms` | <= 64; every `output_dataset_id` must be unique |
| `sections` | 1-128; `section_id` unique |
| `DATA_TABLE.columns` | 1-25 |
| `KPI_GRID.cards` | 1-12; `columns` 2-3 (max 3 per row on A4) |
| `CHART.series` | 1-8; `height_mm` 35-180; `width_percent` 30-100 |
| `VECTOR_DRAW.nodes` | <= 40; `edges` <= 60; `height_mm` 25-180 |
| `required_assets` | <= 20; `asset_key` and flat `file_name` |
| `i18n.locales` | MUST contain non-empty `en` and `ar` dictionaries |
| Merchant limits | datasets <= 6; joins <= 2; selects <= 20; windows <= 2; sections <= 24; rows <= 10000; bounded date range <= 92 days |

**Required shape:**
```json
{
  "spec_kind": "REPORT_DESCRIPTOR",
  "spec_version": "1.0",
  "report": {
    "code": "kebab-case-code",
    "version": 1,
    "category": "GATEWAY_PERFORMANCE",
    "audience_scope": "BACKOFFICE_INTERNAL",
    "classification": "INTERNAL"
  },
  "page_layout": {
    "paper_size": "A4",
    "orientation": "PORTRAIT",
    "margins_mm": {
      "top": 26,
      "right": 14,
      "bottom": 24,
      "left": 14
    },
    "header_mode": "GLOBAL_DEFAULT",
    "footer_mode": "GLOBAL_DEFAULT",
    "allow_runtime_chrome_selection": true,
    "global_scoped_css": ""
  },
  "required_assets": [],
  "suggested_access": {
    "roles": [],
    "authorities": []
  },
  "i18n": {
    "default_locale": "en",
    "prompt_user_when_multi_locale": true,
    "locales": {
      "en": {},
      "ar": {}
    }
  },
  "inputs": [],
  "datasets": [
    {
      "dataset_id": "example",
      "description": "Example",
      "from_model": "payment_attempts",
      "from_alias": "t0",
      "select": [
        {
          "alias": "count",
          "column": "id",
          "aggregate": "COUNT"
        }
      ],
      "limit": 10
    }
  ],
  "transforms": [],
  "sections": []
}
```

**Report families (choose the closest category):**
- Finance/ledger: `FINANCE_LEDGER`, authority `finance:read`.
- Merchant settlement/balances: `MERCHANT_SETTLEMENT`, authority `merchant:read`.
- Reconciliation: `RECONCILIATION`, authority `reconciliation:read`.
- AML/compliance: `COMPLIANCE_AML`, authorities `aml:read`, `compliance:read` (confidential).
- Gateway/rail performance: `GATEWAY_PERFORMANCE`, authority `gateway:read`.
- Support/incidents/cases: `OPERATIONS_SUPPORT`, authority `operator:read`.
- Audit/security: `SECURITY_AUDIT`, authority `security:read`.

## 3. Reportable Models, Columns and Query Rules
Only models below are visible to a merchant-authored report. The engine injects the authenticated merchant predicate.

### 3.1 Model index
- `MERCHANTS`: `merchants`, `applications`
- `PAYMENTS`: `wallets`, `payment_attempts`, `cashout_requests`
- `OPERATIONS`: `rm_merchant_daily_stats`

### 3.2 Model catalog
### `merchants` — MERCHANTS
- Access: merchant-scoped
- Merchant scopable: filter `id` by `report.merchant_scope_input_key`.
- Columns:
  - `id` (uuid; INDEXED, NOT NULL)
  - `version` (int; NOT NULL)
  - `created_at` (datetime; INDEXED, NOT NULL)
  - `updated_at` (datetime; NOT NULL)
  - `legal_name` (string; NOT NULL)
  - `trade_name` (string; NOT NULL)
  - `display_name` (string)
  - `business_category` (string)
  - `status` (enum:MerchantStatus {PENDING | ACTIVE | SUSPENDED | REJECTED | CLOSED}; INDEXED, NOT NULL)
  - `kyb_status` (enum:KybStatus {UNVERIFIED | PENDING | VERIFIED | REJECTED}; INDEXED, NOT NULL)
  - `risk_tier` (enum:RiskTier {LOW | STANDARD | HIGH}; INDEXED, NOT NULL)
  - `country` (string; NOT NULL)
  - `activated_at` (datetime)
  - `suspended_at` (datetime)
  - `next_kyb_review_at` (datetime; INDEXED)
- Relations (for joins):
  - `applications` -> `applications` (ONE_TO_MANY; `id = merchant_id`)
  - `wallets` -> `wallets` (ONE_TO_MANY; `id = merchant_id`)
  - `cashoutRequests` -> `cashout_requests` (ONE_TO_MANY; `id = merchant_id`)
  - `paymentAttempts` -> `payment_attempts` (ONE_TO_MANY; `id = merchant_id`)

### `applications` — MERCHANTS
- Access: merchant-scoped
- Merchant scopable: filter `merchant_id` by `report.merchant_scope_input_key`.
- Columns:
  - `id` (uuid; INDEXED, NOT NULL)
  - `created_at` (datetime; NOT NULL)
  - `updated_at` (datetime; NOT NULL)
  - `merchant_id` (uuid; INDEXED, NOT NULL)
  - `name` (string; NOT NULL)
  - `business_use_description` (string)
  - `expected_monthly_volume` (decimal; NOT NULL)
  - `expected_monthly_volume_minor` (bigint; minor scale 1000, NOT NULL)
  - `assigned_wallet_id` (uuid; INDEXED, NOT NULL)
  - `status` (enum:ApplicationStatus {DRAFT | PENDING | ACTIVE | SUSPENDED | CLOSED}; INDEXED, NOT NULL)
- Relations (for joins):
  - `merchant` -> `merchants` (MANY_TO_ONE; `merchant_id = id`)
  - `assignedWallet` -> `wallets` (MANY_TO_ONE; `assigned_wallet_id = id`)
  - `paymentAttempts` -> `payment_attempts` (ONE_TO_MANY; `id = application_id`)

### `wallets` — PAYMENTS
- Access: merchant-scoped
- Merchant scopable: filter `merchant_id` by `report.merchant_scope_input_key`.
- Columns:
  - `id` (uuid; INDEXED, NOT NULL)
  - `created_at` (datetime; NOT NULL)
  - `updated_at` (datetime; NOT NULL)
  - `merchant_id` (uuid; INDEXED, NOT NULL)
  - `gl_account_id` (uuid; INDEXED, NOT NULL)
  - `currency` (string; NOT NULL)
  - `status` (enum:WalletStatus {PENDING | ACTIVE | FROZEN | CLOSED}; INDEXED, NOT NULL)
- Relations (for joins):
  - `merchant` -> `merchants` (MANY_TO_ONE; `merchant_id = id`)
  - `applications` -> `applications` (ONE_TO_MANY; `id = assigned_wallet_id`)
  - `cashoutRequests` -> `cashout_requests` (ONE_TO_MANY; `id = wallet_id`)

### `payment_attempts` — PAYMENTS
- Access: merchant-scoped
- Merchant scopable: filter `merchant_id` by `report.merchant_scope_input_key`.
  - **MANDATORY:** filter `created_at` with op `between` or `gte`+`lte` pair; range <= 180 days. payment_attempts is a large history table; a bounded created_at range keeps the report query indexed.
- **INDEXED FILTER REQUIRED:** include at least one predicate on an INDEXED column.
- Columns:
  - `id` (uuid; INDEXED, NOT NULL)
  - `created_at` (datetime; INDEXED, NOT NULL)
  - `updated_at` (datetime; NOT NULL)
  - `reference` (string; INDEXED, NOT NULL)
  - `link_id` (uuid; INDEXED, NOT NULL)
  - `application_id` (uuid; INDEXED, NOT NULL)
  - `merchant_id` (uuid; INDEXED, NOT NULL)
  - `rail_id` (uuid; INDEXED, NOT NULL)
  - `status` (enum:AttemptStatus {CREATED | INITIATING | AWAITING_CUSTOMER | AUTHORIZING | VERIFYING | UNKNOWN | SUCCEEDED | FAILED | EXPIRED | CANCELLED | BLOCKED | PARTIALLY_REFUNDED | REFUNDED | DISPUTED}; INDEXED, NOT NULL)
  - `substatus` (string)
  - `requested_amount` (decimal; NOT NULL)
  - `requested_amount_minor` (bigint; minor scale 1000, NOT NULL)
  - `surcharge_amount` (decimal; NOT NULL)
  - `surcharge_amount_minor` (bigint; minor scale 1000, NOT NULL)
  - `total_charged_amount` (decimal; NOT NULL)
  - `total_charged_amount_minor` (bigint; minor scale 1000, NOT NULL)
  - `settled_amount` (decimal)
  - `settled_amount_minor` (bigint; minor scale 1000)
  - `gateway_fee_amount` (decimal)
  - `gateway_fee_amount_minor` (bigint; minor scale 1000)
  - `platform_commission_amount` (decimal; NOT NULL)
  - `platform_commission_amount_minor` (bigint; minor scale 1000, NOT NULL)
  - `net_merchant_amount` (decimal; NOT NULL)
  - `net_merchant_amount_minor` (bigint; minor scale 1000, NOT NULL)
  - `fee_bearer` (enum:FeeBearer {MERCHANT_ABSORBS | PAYER_SURCHARGE | SPLIT}; NOT NULL)
  - `settlement_target` (enum:SettlementTarget {PLATFORM_CLEARING | MERCHANT_DIRECT | PROVIDER_HELD}; NOT NULL)
  - `currency` (string; NOT NULL)
  - `expires_at` (datetime; NOT NULL)
  - `terminal_at` (datetime)
- Relations (for joins):
  - `application` -> `applications` (MANY_TO_ONE; `application_id = id`)
  - `merchant` -> `merchants` (MANY_TO_ONE; `merchant_id = id`)

### `cashout_requests` — PAYMENTS
- Access: merchant-scoped
- Merchant scopable: filter `merchant_id` by `report.merchant_scope_input_key`.
- Columns:
  - `id` (uuid; INDEXED, NOT NULL)
  - `created_at` (datetime; INDEXED, NOT NULL)
  - `updated_at` (datetime; NOT NULL)
  - `merchant_id` (uuid; INDEXED, NOT NULL)
  - `wallet_id` (uuid; INDEXED, NOT NULL)
  - `amount` (decimal; NOT NULL)
  - `amount_minor` (bigint; minor scale 1000, NOT NULL)
  - `state` (enum:CashoutState {PENDING | REJECTED | PROCESSING | COMPLETE | SUBTRACTED}; INDEXED, NOT NULL)
  - `adjustment_id` (uuid; INDEXED)
- Relations (for joins):
  - `merchant` -> `merchants` (MANY_TO_ONE; `merchant_id = id`)
  - `wallet` -> `wallets` (MANY_TO_ONE; `wallet_id = id`)

### `rm_merchant_daily_stats` — OPERATIONS
- Access: merchant-scoped
- Merchant scopable: filter `merchant_id` by `report.merchant_scope_input_key`.
- Columns:
  - `merchant_id` (uuid; NOT NULL)
  - `day` (datetime; INDEXED, NOT NULL)
  - `currency` (string; NOT NULL)
  - `attempt_count` (int; NOT NULL)
  - `success_count` (int; NOT NULL)
  - `failure_count` (int; NOT NULL)
  - `gross_amount` (decimal; NOT NULL)
  - `gross_amount_minor` (bigint; minor scale 1000, NOT NULL)
  - `net_amount` (decimal; NOT NULL)
  - `net_amount_minor` (bigint; minor scale 1000, NOT NULL)
  - `success_amount` (decimal; NOT NULL)
  - `success_amount_minor` (bigint; minor scale 1000, NOT NULL)
  - `success_net_amount` (decimal; NOT NULL)
  - `success_net_amount_minor` (bigint; minor scale 1000, NOT NULL)
  - `updated_at` (datetime; NOT NULL)
- Relations: none

## 4. Dataset Reference
- A dataset has `dataset_id`, `description`, `from_model`, `from_alias`, optional `joins`, `select`, optional `where`, `group_by`, `having`, `window_fields`, `order_by` and `limit`.
- `select[]`: `alias` (identifier), optional `table_alias`, `column`, `expression` (COLUMN, COALESCE_ZERO, DATE_TRUNC_HOUR/DAY/WEEK/MONTH, MINOR_TO_MAJOR_DECIMAL, SIGNED_JOURNAL_AMOUNT, CASE_WHEN_ENUM, AGE_DAYS), optional `aggregate` (COUNT, COUNT_DISTINCT, SUM, AVG, MIN, MAX, SUM_DEBIT_MINOR, SUM_CREDIT_MINOR), optional `case_map`, `format_hint` (RAW, CURRENCY_MINOR, DECIMAL_2, DECIMAL_4, PERCENT_BPS, PERCENT_RATIO, DATE_ISO, DATETIME_ISO, ENUM_TRANSLATED, INTEGER).
- `AGE_DAYS` turns a datetime column into fractional days since now (use with AVG/MAX/etc); it is the supported way to compute an average age. Never apply AVG directly to a datetime column.
- Minor-unit columns (`*_minor`, documented as minor scale) are already in minor units; use `format_hint: CURRENCY_MINOR` and do not divide again.
- `where` is a recursive `PREDICATE` / `GROUP` tree. Predicate operators: `eq, neq, gt, gte, lt, lte, between, in, not_in, is_null, is_not_null, ilike_prefix`.
- A predicate `binding` is one of: `{ source: "INPUT", input_key, range_bound?: START|END|BOTH, omit_if_empty?: boolean }`, `{ source: "LITERAL", value }`, or `{ source: "CONTEXT", context_key: ACTOR_USER_ID|NOW_UTC|TODAY_START_UTC|DEFAULT_CURRENCY }`.
- There is no `gte_lte` operator. Write a gte+lte pair (two predicates: `gte` with `range_bound: START`, `lte` with `range_bound: END`) bound to the same daterange input, or one `between` with `range_bound: BOTH`.
- `joins[]`: `join_type` (INNER/LEFT), `relation_name` (must exist on the base model), `target_model`, unique `alias`, optional `additional_on` (same predicate tree).
- **Joined-column rule:** a select or predicate that targets a joined model MUST set `table_alias` to the join alias. Without `table_alias`, the column is resolved on the base model and fails with `UNKNOWN_COLUMN`.
- **Missing-column rule:** if a requested field is not on the chosen model, check the model's Relations. Join the related model that owns the field and select it with that join alias; do not invent a column.
- `group_by` and `order_by` reference select aliases (preferred) or base-model columns. With `GROUP BY`, order/window references must be grouped aliases.
- `having[]`: `select_alias`, op (`gt,gte,lt,lte,eq,neq`) and numeric `value`; the alias must be an aggregate.
- `window_fields[]`: `alias`, `window_fn` (RUNNING_SUM, ROW_NUMBER, RANK, PERCENT_OF_TOTAL), `target_field`, optional `partition_by`, optional `order_by`. Window functions run over the full filtered result before the dataset limit; the alias becomes section-addressable.

## 5. Transform Reference
`transforms[]` use `operation` (the alias `kind` is accepted). Only JOIN_DATASETS, PIVOT_DATASET and COMPARE_WITH_ASSET create a new dataset via `output_dataset_id`.
- **COMPUTE_COLUMN does NOT create a dataset.** It adds (or replaces) `output_column` on `target_dataset_id`; there is no `output_dataset_id` field. To compute two derived columns, run two COMPUTE_COLUMN transforms with the same `target_dataset_id` and different `output_column` values. Example: target_dataset_id `daily`, output_column `share`, formula `PERCENTAGE_SHARE`, left_operand `volume`; then a second transform targeting `daily` with output_column `rate`.
- **COMPUTE_COLUMN fields**: `target_dataset_id`, `output_column`, `formula` (ADD, SUBTRACT, MULTIPLY, SAFE_DIVIDE, PERCENTAGE_SHARE, VARIANCE_BPS), `left_operand`, optional `right_operand` (required unless `PERCENTAGE_SHARE`), optional `format_hint`.
- **JOIN_DATASETS**: `output_dataset_id`, `left_dataset_id`, `right_dataset_id`, `join_type` (INNER/LEFT/FULL), `on_left_key`, `on_right_key`.
- **PIVOT_DATASET**: `source_dataset_id`, `output_dataset_id`, `row_key`, `column_key`, `value_key`, `aggregation` (SUM/COUNT/FIRST).
- **COMPARE_WITH_ASSET**: `source_dataset_id`, `asset_key`, `output_dataset_id`, `match_keys`, `compare_fields[]` with `dataset_field`, `asset_field`, optional `output_field`, `tolerance_minor`. Output includes source fields, `_asset_matched`, `_has_discrepancy`, `<dataset_field>_expected`, `<dataset_field>_variance`, and the asset target field.

## 6. Section Reference
- **KPI_GRID**: `section_id`, optional `title_i18n_key`, `columns` (2-3, max 3 per row), `cards[]` with `label_i18n_key`, `dataset_id`, `value_field`, optional `row_index`, `delta_field`, `delta_format_hint` (use PERCENT_BPS for basis-point deltas), `format_hint` (RAW, CURRENCY_MINOR, DECIMAL_2, PERCENT_RATIO, INTEGER), `tone` (NEUTRAL, PRIMARY, SUCCESS, WARNING, DANGER). Prefer 3 or 6 headline cards.
- **Tone vocabulary:** KPI card tones are NEUTRAL/PRIMARY/SUCCESS/WARNING/DANGER; badge tones are NEUTRAL/SUCCESS/WARNING/DANGER/INFO. Do not use INFO on a KPI card or PRIMARY on a badge.
- **DATA_TABLE**: `section_id`, optional title, REQUIRED `subtitle_i18n_key` (one short descriptive sentence), `dataset_id`, `columns[]` with `field`, `header_i18n_key`, `align` (START/CENTER/END), optional `width_percent` (3-80), `format_hint` (includes BADGE), `summary_footer` (NONE, SUM, AVG, COUNT, MIN, MAX, LABEL_TOTAL), optional `badge_tone_map`; plus `repeat_header_on_page_break`, `avoid_row_split`, `zebra_striping`.
- **Badge tones:** `badge_tone_map` values MUST be one of `NEUTRAL`, `SUCCESS`, `WARNING`, `DANGER`, `INFO`; map enum values to tones, for example PENDING to WARNING and PROCESSING to INFO. `PRIMARY` is only a KPI card tone, not a badge tone.
- **CHART**: `section_id`, REQUIRED `title_i18n_key`, REQUIRED `subtitle_i18n_key` (one short descriptive sentence), `dataset_id`, `chart_kind` (BAR, STACKED_BAR, LINE, AREA, PIE, DONUT, COMBO_BAR_LINE, WATERFALL, HEATMAP), `height_mm` (35-180), `width_percent` (30-100), `x_field`, optional `x_label_i18n_key`, `y_axis_format` (CURRENCY_MINOR, INTEGER, DECIMAL_2, PERCENT_RATIO), `series[]` (1-8) with `field`, `label_i18n_key`, optional `type_override` (bar/line/area), `color_hex` (#RRGGBB), `show_value_labels`.
- **Chart layout:** `width_percent: 100` means the chart owns a full row. A chart below 100% is centered; consecutive charts below 100% are paired side by side (max two) and the row is centered. Use 100 for a single wide chart and 50 for an intentional pair; never rely on the renderer to squeeze more than two charts into one row.
- **Chart descriptions:** the subtitle is rendered as a small paragraph between the title and the chart. Do not put dataset values in it; describe what the chart shows.
- **VECTOR_DRAW**: `section_id`, optional title, `draw_kind` (FLOW_DIAGRAM, SETTLEMENT_WATERFALL_DIAGRAM, DECLARATIVE_SVG_CANVAS), `height_mm` (25-180), `view_box` { width, height } (or SVG string), optional `dataset_id`, `nodes[]` (node_id, shape RECT/BAR/ROUNDED_RECT/PILL/DIAMOND/CIRCLE, x/y/width/height, `label_i18n_key`, optional `value_binding`, colors) and `edges[]` (from_node_id, to_node_id, optional label, style, color). BAR is a rectangle; use it for waterfall bars. Give nodes enough width/height for their label and value; the renderer wraps text and pads it, but very small nodes force tiny text.
- **HTML_TEMPLATE**: `section_id`, optional `title_i18n_key`/`dataset_id`, `html_template`, `scoped_css`. ONLY `{{$t.key}}` translation tokens and `asset://key` are supported. No dataset bindings, no scripts, no external URLs.
- **HTML_TEMPLATE typography:** keep narrative blocks compact (body <= 8.5pt, headings <= 10pt) and short enough to fit one page; the renderer keeps small HTML sections together instead of splitting a heading from its list.
- **Global print CSS:** do not set `overflow-wrap:anywhere` on `td,th` or `table` in `global_scoped_css`; it breaks status/chip words and numbers. Use the renderer's table classes and `scoped_css` only for colours or spacing.
- **IMAGE_BANNER**: `section_id`, `asset_key`, optional `caption_i18n_key`, `align` (START/CENTER/END), `max_height_mm` (10-160).
- **PAGE_BREAK**: `section_id`, optional `orientation_after` (PORTRAIT/LANDSCAPE).
- Every section may declare `visibility: { when: ALWAYS|DATASET_NOT_EMPTY|DATASET_EMPTY|INPUT_EQUALS, dataset_id?, input_key?, equals_value? }`. Use visibility sparingly; the Studio preview renders all sections with mock data.

## 7. Input and Asset Reference
- Inputs: `key`, `label_i18n_key`, optional `help_i18n_key`/`placeholder_i18n_key`, `type`, `required`, optional `default_value`, `validation` (min, max, min_length, max_length, regex, max_range_days, enum_values, enum_labels_i18n_prefix), optional `autocomplete` (source, depends_on_input, static_filter), `layout_col_span` (3-12).
- Input types: `string`, `uuid`, `number`, `integer`, `amount_minor`, `boolean`, `date`, `datetime`, `daterange`, `enum`, `multi_enum`, `entity_autocomplete`, `entity_multi_autocomplete`.
- Autocomplete sources: `applications`, `currencies`, `payment_links`, `pos_terminals`; `merchants` is allowed only on the merchant scope input.
- `default_value` accepts a raw literal, a preset object `{ "preset": "TODAY" | "YESTERDAY" | "LAST_7_DAYS" | "LAST_30_DAYS" | "CURRENT_MONTH" | "PREVIOUS_MONTH" }`, or `{ "literal": <value> }`. Range presets are daterange-only.
- A `MERCHANT_FACING`/`BOTH` report MUST declare `report.merchant_scope_input_key`; that input must be `entity_autocomplete` with source `merchants`, and every merchant-scopable dataset/join alias must be filtered by it.
- **Merchant assets are DISABLED by platform policy:** required_assets MUST be empty. Do not declare `required_assets` and do not upload a `.zip`.
- **SVG asset hygiene:** produce plain SVG 1.1. Do NOT embed `<metadata>`, C2PA/`c2pa:*` manifests, foreign namespaces, `<script>`, `<style>`, `<foreignObject>`, embedded raster previews, external URLs or event handlers. Minimal `<svg xmlns="http://www.w3.org/2000/svg">` paths/shapes only.
- The asset `.zip` must contain only the flat declared files (no folders, no spec/chrome JSON, no duplicate basenames); file names must match `required_assets[].file_name` exactly.

## 8. Page Layout
- `page_layout`: `paper_size`, `orientation`, `margins_mm`, `header_mode`/`footer_mode`, optional `header_chrome_code`/`footer_chrome_code`, inline template objects, `allow_runtime_chrome_selection`, `global_scoped_css`.
- **Do not author headers/footers.** Keep `header_mode`/`footer_mode` at `GLOBAL_DEFAULT` unless the user explicitly asks for `NONE` or for a registered chrome code. Chrome authoring is a separate Studio workflow.
- The print stylesheet uses A4 content width, fixed-layout tables and wraps long values. Keep table widths <= 100% and use short headers; avoid absolute pixel widths in `scoped_css`.

## 9. Authoring Recipes
### Top-N ranking (e.g. best 10 wallets, merchants or institutions)
1. One dataset with `from_model`, grouped by the entity key + label columns.
2. Aggregate the metric (`SUM`, `COUNT`, `COUNT_DISTINCT`).
3. `order_by` the metric `DESC`, set `limit: N`.
4. Render a `DATA_TABLE` (or a `CHART` BAR) with the ranking fields; add a computed rank with a `ROW_NUMBER` window only if the user asks for an explicit rank.
5. Do not fetch every row and sort in HTML; the dataset `limit` does the top-N.

### Time trend
Use `DATE_TRUNC_DAY`/`DATE_TRUNC_MONTH` on `created_at`, group by the alias, order ascending, render a LINE/AREA chart. Always keep the mandatory `created_at` range predicate.

### Comparison against a target file
Declare the JSON/CSV asset, create the live dataset, then `COMPARE_WITH_ASSET` with `match_keys` and `compare_fields`; render the output fields `_has_discrepancy`, `<field>_expected` and `<field>_variance` in a table with a DANGER badge map.

### Pivot (e.g. environment × rail)
Use `PIVOT_DATASET`, then a `DATA_TABLE` with one explicit row-key column and one `field: "*"` column. The wildcard expands to the data-dependent columns; give it a base `header_i18n_key`.

### Flow diagram
Use `VECTOR_DRAW` with `draw_kind: FLOW_DIAGRAM`, a `view_box` such as `{ "width": 800, "height": 260 }`, nodes with x/y/width/height inside the view box, and edges between existing node ids.

### Cover / narrative block
Use `HTML_TEMPLATE` only for text and `asset://` imagery with `{{$t.key}}` tokens. Put every dynamic number in a `KPI_GRID` or `DATA_TABLE`; HTML templates cannot bind dataset values.

### Wide table
Prefer <= 8 columns. If the user requires more, provide sensible `width_percent` values that sum to <= 100 and short headers; the renderer uses a fixed table layout and wraps long values.

### Complexity budget
- Simple report: 1-3 datasets, 1-6 sections.
- Standard report: 3-8 datasets, 6-20 sections.
- Only exceed 10 datasets/25 sections when the brief explicitly asks for a comprehensive multi-part report; split unrelated questions into separate reports.

## 10. Complete Bilingual Example
```json
{
  "spec_kind": "REPORT_DESCRIPTOR",
  "spec_version": "1.0",
  "report": {
    "code": "merchant-settlement-summary",
    "version": 1,
    "category": "MERCHANT_SETTLEMENT",
    "audience_scope": "BOTH",
    "merchant_scope_input_key": "merchantId",
    "classification": "MERCHANT_CONFIDENTIAL"
  },
  "page_layout": {
    "paper_size": "A4",
    "orientation": "PORTRAIT",
    "header_mode": "GLOBAL_DEFAULT",
    "footer_mode": "GLOBAL_DEFAULT"
  },
  "required_assets": [],
  "i18n": {
    "default_locale": "en",
    "prompt_user_when_multi_locale": true,
    "locales": {
      "en": {
        "report.title": "Merchant Settlement Summary",
        "input.merchant": "Target Merchant",
        "input.period": "Statement Period",
        "kpi.title": "Settlement Summary",
        "kpi.total": "Total Movement",
        "table.title": "Daily Turnover",
        "table.day": "Day",
        "table.amount": "Amount"
      },
      "ar": {
        "report.title": "ملخص تسويات التاجر",
        "input.merchant": "التاجر المستهدف",
        "input.period": "فترة الكشف",
        "kpi.title": "ملخص التسوية",
        "kpi.total": "إجمالي الحركة",
        "table.title": "الحركة اليومية",
        "table.day": "اليوم",
        "table.amount": "المبلغ"
      }
    }
  },
  "inputs": [
    {
      "key": "merchantId",
      "label_i18n_key": "input.merchant",
      "type": "entity_autocomplete",
      "required": true,
      "autocomplete": {
        "source": "merchants"
      }
    },
    {
      "key": "periodRange",
      "label_i18n_key": "input.period",
      "type": "daterange",
      "required": true,
      "validation": {
        "max_range_days": 90
      },
      "default_value": {
        "preset": "CURRENT_MONTH"
      }
    }
  ],
  "datasets": [
    {
      "dataset_id": "totals",
      "description": "Merchant payment totals by currency for the selected period",
      "from_model": "payment_attempts",
      "from_alias": "pa",
      "select": [
        {
          "alias": "currency",
          "column": "currency"
        },
        {
          "alias": "total",
          "column": "total_charged_amount_minor",
          "aggregate": "SUM",
          "format_hint": "CURRENCY_MINOR"
        }
      ],
      "where": {
        "kind": "GROUP",
        "logic": "AND",
        "conditions": [
          {
            "kind": "PREDICATE",
            "column": "merchant_id",
            "op": "eq",
            "binding": {
              "source": "INPUT",
              "input_key": "merchantId"
            }
          },
          {
            "kind": "PREDICATE",
            "column": "created_at",
            "op": "between",
            "binding": {
              "source": "INPUT",
              "input_key": "periodRange",
              "range_bound": "BOTH"
            }
          }
        ]
      },
      "group_by": [
        "currency"
      ],
      "limit": 10
    }
  ],
  "transforms": [],
  "sections": [
    {
      "section_type": "KPI_GRID",
      "section_id": "kpis",
      "title_i18n_key": "kpi.title",
      "columns": 2,
      "cards": [
        {
          "label_i18n_key": "kpi.total",
          "dataset_id": "totals",
          "value_field": "total",
          "format_hint": "CURRENCY_MINOR",
          "tone": "PRIMARY"
        }
      ]
    }
  ]
}
```

## 11. Minimal Top-10 Example (back-office)
```json
{
  "spec_kind": "REPORT_DESCRIPTOR",
  "spec_version": "1.0",
  "report": {
    "code": "top-ten-merchants-by-volume",
    "version": 1,
    "category": "MERCHANT_SETTLEMENT",
    "audience_scope": "BACKOFFICE_INTERNAL",
    "classification": "INTERNAL"
  },
  "page_layout": {
    "paper_size": "A4",
    "orientation": "PORTRAIT",
    "header_mode": "GLOBAL_DEFAULT",
    "footer_mode": "GLOBAL_DEFAULT"
  },
  "required_assets": [],
  "suggested_access": {
    "roles": [
      "OPERATOR",
      "FINANCE"
    ],
    "authorities": [
      "merchant:read"
    ]
  },
  "i18n": {
    "default_locale": "en",
    "prompt_user_when_multi_locale": true,
    "locales": {
      "en": {
        "report.title": "Top 10 Merchants by Volume",
        "input.period": "Period",
        "table.title": "Top Merchants",
        "table.merchant": "Merchant",
        "table.attempts": "Attempts",
        "table.volume": "Volume"
      },
      "ar": {
        "report.title": "أفضل 10 تجار حسب الحجم",
        "input.period": "الفترة",
        "table.title": "أفضل التجار",
        "table.merchant": "التاجر",
        "table.attempts": "المحاولات",
        "table.volume": "الحجم"
      }
    }
  },
  "inputs": [
    {
      "key": "periodRange",
      "label_i18n_key": "input.period",
      "type": "daterange",
      "required": true,
      "validation": {
        "max_range_days": 180
      },
      "default_value": {
        "preset": "LAST_30_DAYS"
      }
    }
  ],
  "datasets": [
    {
      "dataset_id": "top_merchants",
      "description": "Top merchants by settled volume",
      "from_model": "payment_attempts",
      "from_alias": "pa",
      "joins": [
        {
          "join_type": "LEFT",
          "relation_name": "merchant",
          "target_model": "merchants",
          "alias": "m"
        }
      ],
      "select": [
        {
          "alias": "merchant_id",
          "column": "id",
          "table_alias": "m"
        },
        {
          "alias": "merchant_name",
          "column": "trade_name",
          "table_alias": "m"
        },
        {
          "alias": "attempts",
          "column": "id",
          "aggregate": "COUNT",
          "format_hint": "INTEGER"
        },
        {
          "alias": "volume_minor",
          "column": "total_charged_amount_minor",
          "aggregate": "SUM",
          "format_hint": "CURRENCY_MINOR"
        }
      ],
      "where": {
        "kind": "PREDICATE",
        "column": "created_at",
        "op": "between",
        "binding": {
          "source": "INPUT",
          "input_key": "periodRange",
          "range_bound": "BOTH"
        }
      },
      "group_by": [
        "merchant_id",
        "merchant_name"
      ],
      "order_by": [
        {
          "field": "volume_minor",
          "direction": "DESC"
        }
      ],
      "limit": 10
    }
  ],
  "transforms": [],
  "sections": [
    {
      "section_type": "DATA_TABLE",
      "section_id": "top_table",
      "title_i18n_key": "table.title",
      "dataset_id": "top_merchants",
      "columns": [
        {
          "field": "merchant_name",
          "header_i18n_key": "table.merchant",
          "width_percent": 50
        },
        {
          "field": "attempts",
          "header_i18n_key": "table.attempts",
          "align": "END",
          "width_percent": 20,
          "format_hint": "INTEGER"
        },
        {
          "field": "volume_minor",
          "header_i18n_key": "table.volume",
          "align": "END",
          "width_percent": 30,
          "format_hint": "CURRENCY_MINOR"
        }
      ]
    }
  ]
}
```