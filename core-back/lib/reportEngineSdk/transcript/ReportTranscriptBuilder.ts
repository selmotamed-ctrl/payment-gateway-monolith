import type { CatalogModelDef, ReportEngineHostConfig } from "../types/hostConfig";
import type { ReportDiagnostic } from "../types/diagnostics";
import {
  AUTOCOMPLETE_SOURCE_KEYS,
  MERCHANT_REPORT_AUTOCOMPLETE_SOURCE_KEYS,
  REPORT_INPUT_TYPES,
  REPORT_SPEC_VERSION,
  SQL_AGGREGATE_OPS,
  SQL_SCALAR_EXPRESSIONS,
  WHERE_OPERATORS,
} from "../types/reportSpec";

export interface ReportTranscriptOptions {
  domains?: Array<CatalogModelDef["domain"]>;
  includeChromeAuthoringGuide?: boolean;
  generatedAt?: Date;
  /** Merchant line: only merchant-safe models and merchant identity rules. */
  merchantMode?: boolean;
  /** Current staff-managed merchant asset policy (defaults to allowed). */
  merchantAssetsEnabled?: boolean;
}

export function buildReportAuthoringTranscript(
  host: ReportEngineHostConfig,
  options: ReportTranscriptOptions = {},
): { filename: string; contentType: "text/markdown"; markdown: string; specVersion: string } {
  const generatedAtIso = (options.generatedAt ?? new Date()).toISOString();
  const merchantMode = options.merchantMode === true;
  const merchantAssetsEnabled = options.merchantAssetsEnabled !== false;
  const domainFilter =
    options.domains && options.domains.length > 0 ? new Set(options.domains) : null;

  const modelSections: string[] = [];
  for (const model of Object.values(host.models)) {
    if (domainFilter && !domainFilter.has(model.domain)) continue;
    const cols = Object.values(model.columns)
      .filter((c) => c.sensitivity !== "FORBIDDEN_SECRET")
      .map((c) => {
        const enumValues = c.enumName ? host.enums[c.enumName] : undefined;
        const enumText = c.enumName
          ? `:${c.enumName}${enumValues?.length ? ` {${enumValues.join(" | ")}}` : ""}`
          : "";
        return `  - \`${c.name}\` (${c.type}${enumText}${c.indexed ? ", INDEXED" : ""}${
          c.sensitivity !== "PUBLIC" && c.sensitivity !== "INTERNAL" ? `, ${c.sensitivity}` : ""
        }${c.minorUnitScale ? `, minor units at scale ${c.minorUnitScale}` : ""}) — ${c.description}`;
      })
      .join("\n");

    const rels = Object.values(model.relations)
      .map(
        (r) =>
          `  - \`${r.name}\` -> \`${r.targetModel}\` (${r.cardinality} on \`${r.sourceKey} = ${r.targetKey}\`)`,
      )
      .join("\n");

    const mandatoryFilters = (model.optimizationRule.mandatoryFilterColumns ?? [])
      .map(
        (mf) =>
          `  - **MANDATORY FILTER:** Column \`${mf.column}\` with op in [${mf.allowedOperators
            .map((operator) => (operator === "gte_lte" ? "gte+lte pair" : operator))
            .join(", ")}]${mf.maxDateRangeDays ? ` (max range: ${mf.maxDateRangeDays} days)` : ""} — ${mf.rationale}`,
      )
      .join("\n");

    modelSections.push(
      [
        `### Model \`${model.modelName}\` (Domain: \`${model.domain}\`)`,
        `${model.description}`,
        merchantMode ? "" : `- **Natural Roles:** ${model.naturalRoles.map((r) => `\`${r}\``).join(", ")}`,
        merchantMode ? "" : `- **Required Authorities:** ${model.requiredAuthorities.map((a) => `\`${a}\``).join(", ")}`,
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

  const merchantExample = (() => {
    if (!merchantMode) return exampleDescriptorSpec;
    const { suggested_access: _suggestedAccess, ...rest } = exampleDescriptorSpec as typeof exampleDescriptorSpec & {
      suggested_access?: unknown;
    };
    return rest;
  })();

  const markdown = [
    merchantMode
      ? `# ${host.institutionName} — Merchant Report Authoring Transcript (v${REPORT_SPEC_VERSION})`
      : `# ${host.institutionName} — Dynamic Report Engine AI Authoring Transcript (v${REPORT_SPEC_VERSION})`,
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
    merchantMode
      ? `- **Autocomplete Sources (\`inputs[].autocomplete.source\`):** ${MERCHANT_REPORT_AUTOCOMPLETE_SOURCE_KEYS.map((v) => `\`${v}\``).join(", ")}; \`merchants\` is allowed only on the merchant scope input.`
      : `- **Autocomplete Sources (\`inputs[].autocomplete.source\`):** ${AUTOCOMPLETE_SOURCE_KEYS.map((v) => `\`${v}\``).join(", ")}`,
    `- **Where Operators (\`op\`):** ${WHERE_OPERATORS.map((v) => `\`${v}\``).join(", ")}`,
    `- **Scalar Expressions (\`select[].expression\`):** ${SQL_SCALAR_EXPRESSIONS.map((v) => `\`${v}\``).join(", ")}`,
    `- **Aggregate Functions (\`select[].aggregate\`):** ${SQL_AGGREGATE_OPS.map((v) => `\`${v}\``).join(", ")}`,
    `- **Format hints:** RAW, CURRENCY_MINOR, DECIMAL_2, DECIMAL_4, PERCENT_BPS, PERCENT_RATIO, DATE_ISO, DATETIME_ISO, ENUM_TRANSLATED, INTEGER, BADGE (table cells). Dataset selects, transform outputs and table columns accept INTEGER; PERCENT_BPS is valid on transform outputs and table columns.`,
    merchantMode
      ? `- **Merchant limits:** datasets <= 6, joins per dataset <= 2, select fields per dataset <= 20, window fields <= 2, sections <= 24, rows per dataset <= 10,000, spec JSON <= 256 KB, and a bounded date range of at most 92 days on every dataset. **Merchant assets are ${merchantAssetsEnabled ? "ENABLED" : "DISABLED"} by platform policy**${merchantAssetsEnabled ? " (one flat .zip, at most 2 MB)" : " (required_assets MUST be empty and no .zip may be uploaded)"}.`
      : `- **Hard limits:** inputs <= 20, datasets <= 64, transforms <= 64, sections <= 128, joins per dataset <= 6, select fields per dataset <= 40, window fields <= 5.`,
    merchantMode
      ? `- **MERCHANT IDENTITY RULE:** The engine injects the authenticated merchant predicate into every base model and every joined alias. A spec-supplied merchant predicate is never trusted. Do not try to read another merchant's rows; execution aborts and is audited if a row escapes the scope.`
      : ``,
    ``,
    `## 3. Queryable Database Models, Columns & Optimization Rules`,
    modelSections.join("\n\n"),
    ``,
    `## 4. Report Descriptor Field Reference`,
    merchantMode
      ? `- Top level: \`spec_kind\`, \`spec_version\`, \`report\`, \`page_layout\`, \`required_assets\`, \`i18n\`, \`inputs\`, \`datasets\`, \`transforms\`, \`sections\`. Merchant specs do not carry authority overrides.`
      : `- Top level: \`spec_kind\`, \`spec_version\`, \`report\`, \`page_layout\`, \`required_assets\`, \`i18n\`, \`suggested_access\`, \`inputs\`, \`datasets\`, \`transforms\`, \`sections\`.`,
    `- \`report\`: \`code\` (kebab-case), \`version\`, \`category\`, \`audience_scope\` (\`BACKOFFICE_INTERNAL\` | \`MERCHANT_FACING\` | \`BOTH\`), optional \`merchant_scope_input_key\`, \`classification\` (\`INTERNAL\` | \`MERCHANT_CONFIDENTIAL\` | \`REGULATORY_RESTRICTED\`).`,
    `- \`page_layout\`: \`paper_size\` (A4/LETTER/LEGAL), \`orientation\`, \`margins_mm\`, \`header_mode\`/\`footer_mode\` (\`GLOBAL_DEFAULT\` | \`SPECIFIC_CHROME_CODE\` | \`INLINE_SPEC\` | \`NONE\`), optional \`header_chrome_code\`/\`footer_chrome_code\`, optional inline template objects, \`allow_runtime_chrome_selection\`, \`global_scoped_css\`.`,
    merchantMode
      ? ``
      : `- \`suggested_access\`: optional \`{ roles: string[], authorities: string[] }\`; this is only a suggestion and is checked against inferred authority.`,
    ``,
    `## 5. Dataset Query Reference`,
    `- A dataset has \`dataset_id\`, \`description\`, \`from_model\`, \`from_alias\`, \`joins\`, \`select\`, optional \`where\`, \`group_by\`, \`having\`, \`window_fields\`, \`order_by\` and \`limit\`.`,
    `- \`select[]\`: \`alias\`, optional \`table_alias\`, \`column\`, \`expression\` (COLUMN, COALESCE_ZERO, DATE_TRUNC_HOUR/DAY/WEEK/MONTH, MINOR_TO_MAJOR_DECIMAL, SIGNED_JOURNAL_AMOUNT, CASE_WHEN_ENUM), optional \`aggregate\` (COUNT, COUNT_DISTINCT, SUM, AVG, MIN, MAX, SUM_DEBIT_MINOR, SUM_CREDIT_MINOR), optional \`case_map\`, \`format_hint\`.`,
    `- \`where\`: recursive \`PREDICATE\` / \`GROUP\` tree. Predicate operators: eq, neq, gt, gte, lt, lte, between, in, not_in, is_null, is_not_null, ilike_prefix. There is no \`gte_lte\` operator: write two predicates (gte + lte) bound to the same daterange input with \`range_bound: START\` / \`END\`, or use \`between\` with \`range_bound: BOTH\`. Bind with \`INPUT\`, \`LITERAL\` or \`CONTEXT\`; mandatory partition filters must not use \`omit_if_empty\`.`,
    `- Minor-unit columns (\`*_minor\`) are returned as bigint values at the documented scale (normally 1000). Use \`format_hint: CURRENCY_MINOR\` and do not divide them again in the spec.`,
    `- \`joins[]\`: \`join_type\` (INNER/LEFT), \`relation_name\`, \`target_model\`, unique \`alias\`, optional \`additional_on\`.`,
    `- \`group_by\` and \`order_by\` reference select aliases (preferred) or base-model columns.`,
    `- \`having[]\`: \`select_alias\`, comparison op and numeric \`value\`; the alias must be an aggregate.`,
    `- \`window_fields[]\`: \`alias\`, \`window_fn\` (RUNNING_SUM, ROW_NUMBER, RANK, PERCENT_OF_TOTAL), \`target_field\`, optional \`partition_by\`, optional \`order_by\`. Window functions see the full filtered result, then the dataset limit is applied. Every \`window_fields[].alias\` becomes a section-addressable field.`,
    `- \`transforms[]\` use the field \`operation\` (the alias \`kind\` is accepted). Operations and fields:`,
    `  - COMPUTE_COLUMN: \`target_dataset_id\`, \`output_column\`, \`formula\` (ADD, SUBTRACT, MULTIPLY, SAFE_DIVIDE, PERCENTAGE_SHARE, VARIANCE_BPS; aliases compute/compute_op/operator are accepted), \`left_operand\`, optional \`right_operand\` (required except for unary PERCENTAGE_SHARE), optional \`format_hint\`.`,
    `  - JOIN_DATASETS: \`output_dataset_id\`, \`left_dataset_id\`, \`right_dataset_id\`, \`join_type\` (INNER/LEFT/FULL), \`on_left_key\`, \`on_right_key\`.`,
    `  - PIVOT_DATASET: \`source_dataset_id\`, \`output_dataset_id\`, \`row_key\`, \`column_key\`, \`value_key\`, \`aggregation\` (SUM/COUNT/FIRST).`,
    `  - COMPARE_WITH_ASSET: \`source_dataset_id\`, \`asset_key\`, \`output_dataset_id\`, \`match_keys\` (string[]), \`compare_fields[]\` with \`dataset_field\`, \`asset_field\`, optional \`output_field\` and \`tolerance_minor\`. The output always contains the source fields, the asset_field target value, \`_asset_matched\`, \`_has_discrepancy\`, \`<dataset_field>_expected\` and \`<dataset_field>_variance\`. When \`output_field\` is present it is an additional alias for the asset_field target value; when omitted, the asset_field name is the addressable target column. Every transform \`output_dataset_id\` becomes a section-addressable dataset.`,
    ``,
    `## 6. Section Reference`,
    `- \`KPI_GRID\`: \`section_id\`, optional title, \`columns\`, \`cards[]\` with \`label_i18n_key\`, \`dataset_id\`, \`value_field\`, optional \`delta_field\`, \`format_hint\`, \`tone\`.`,
    `- \`DATA_TABLE\`: \`section_id\`, optional title/subtitle, \`dataset_id\`, \`columns[]\` with \`field\`, \`header_i18n_key\`, \`align\`, optional \`width_percent\`, \`format_hint\`, \`summary_footer\`, optional \`badge_tone_map\`, plus \`repeat_header_on_page_break\`, \`avoid_row_split\`, \`zebra_striping\`.`,
    `- \`CHART\`: \`section_id\`, title/subtitle, \`dataset_id\`, \`chart_kind\` (BAR, STACKED_BAR, LINE, AREA, PIE, DONUT, COMBO_BAR_LINE, WATERFALL, HEATMAP), \`height_mm\`, \`width_percent\`, \`x_field\`, optional \`x_label_i18n_key\`, \`y_axis_format\`, \`series[]\` with \`field\`, \`label_i18n_key\`, optional \`type_override\`, \`color_hex\`, \`show_value_labels\`.`,
    `- \`VECTOR_DRAW\`: \`section_id\`, optional title, \`draw_kind\` (FLOW_DIAGRAM, SETTLEMENT_WATERFALL_DIAGRAM, DECLARATIVE_SVG_CANVAS), \`height_mm\`, \`view_box\` (object \`{ width, height }\`, or SVG-style string \`"x y width height"\`), optional \`dataset_id\`, \`nodes[]\` (shape RECT/BAR/ROUNDED_RECT/PILL/DIAMOND/CIRCLE, coordinates, label, optional value_binding, colors), \`edges[]\`, optional sanitized \`custom_svg_template\`. BAR is a rectangle; use it for waterfall bars.`,
    `- \`HTML_TEMPLATE\`: \`section_id\`, optional title/dataset, sanitized \`html_template\`, \`scoped_css\`; use \`{{$t.key}}\` and \`asset://key\`.`,
    `- \`IMAGE_BANNER\`: \`section_id\`, \`asset_key\`, optional caption, align, \`max_height_mm\`.`,
    `- \`PAGE_BREAK\`: \`section_id\`, optional \`orientation_after\` (PORTRAIT/LANDSCAPE).`,
    `- Every section may declare \`visibility: { when: ALWAYS|DATASET_NOT_EMPTY|DATASET_EMPTY|INPUT_EQUALS, dataset_id?, input_key?, equals_value? }\`.`,
    ``,
    `## 7. Input and Asset Reference`,
    `- Inputs: \`key\`, \`label_i18n_key\`, type, \`required\`, optional \`help_i18n_key\`, \`placeholder_i18n_key\`, \`default_value\`, \`validation\` (min, max, min_length, max_length, regex, max_range_days, enum_values, enum_labels_i18n_prefix), \`autocomplete\` (source, depends_on_input, static_filter), \`layout_col_span\`.`,
    `- \`default_value\` accepts a raw literal (string/number/boolean/string[]) or \`{ "preset": "TODAY" | "YESTERDAY" | "LAST_7_DAYS" | "LAST_30_DAYS" | "CURRENT_MONTH" | "PREVIOUS_MONTH" }\`. The wrapper \`{ "literal": <value> }\` is also accepted and normalised to the raw value.`,
    `- Presets: TODAY, YESTERDAY, LAST_7_DAYS, LAST_30_DAYS, CURRENT_MONTH, PREVIOUS_MONTH.`,
    `- A \`MERCHANT_FACING\` or \`BOTH\` report MUST declare \`report.merchant_scope_input_key\`; that input must be an entity_autocomplete bound to \`merchants\`, and every merchant-scopable model in every dataset/join must be filtered by it. Do not use other merchant autocomplete inputs.`,
    merchantMode && !merchantAssetsEnabled
      ? `- Assets: DISABLED by platform policy. Do not declare \`required_assets\` and do not upload a .zip.`
      : `- Assets: \`asset_key\`, flat \`file_name\`, \`mime_type\` (image/png, image/jpeg, image/webp, image/svg+xml, application/json, text/csv), \`purpose\` (VISUAL_IMAGE or COMPARISON_BASELINE_DATA), optional description. Reference visual assets as \`asset://asset_key\`; compare with \`COMPARE_WITH_ASSET\`.${merchantMode ? " Merchant asset bundles are enabled by platform policy; one flat .zip at most 2 MB." : ""}`,
    ``,
    `## 8. Visual Sections & Page Layout`,
    `Use only the closed section vocabulary: \`KPI_GRID\`, \`DATA_TABLE\`, \`CHART\` (ECharts vector), \`VECTOR_DRAW\` (flow diagram, settlement waterfall, declarative SVG canvas), \`HTML_TEMPLATE\` (logic-less Mustache with \`{{$t.key}}\` tokens), \`IMAGE_BANNER\` (asset:// references) and \`PAGE_BREAK\`.`,
    `Every section needs a unique \`section_id\`, and every referenced \`*_i18n_key\` must exist in **all** locales.`,
    ``,
    `## 9. Headers and Footers`,
    `Report headers and footers are authored as \`ReportChromeSpec\` documents (\`spec_kind: "REPORT_CHROME"\`, \`chrome.chrome_type: "HEADER" | "FOOTER"\`) with their own \`required_assets\`, bilingual \`i18n\`, \`template.html\` and \`template.scoped_css\`. A report selects them with \`page_layout.header_mode/footer_mode\` = \`GLOBAL_DEFAULT\`, \`SPECIFIC_CHROME_CODE\`, \`INLINE_SPEC\` or \`NONE\`.`,
    ``,
    `## 10. Asset Bundles`,
    merchantMode && !merchantAssetsEnabled
      ? `Merchant report asset bundles are **DISABLED by platform policy**. A merchant-authored spec must keep \`required_assets\` empty and must not upload a .zip. Remove any logo, seal or comparison-baseline asset from the design.`
      : `If the report needs logos, seals or comparison baselines, declare them in \`required_assets[]\` with a flat \`file_name\` and \`purpose\`: \`VISUAL_IMAGE\` or \`COMPARISON_BASELINE_DATA\` (\`.json\`/\`.csv\`). Reference visual assets with \`asset://asset_key\` and compare datasets with the \`COMPARE_WITH_ASSET\` transform.${merchantMode ? " Merchant asset bundles are **ENABLED by platform policy**; upload one flat .zip at most 2 MB. Platform templates that already use staff-owned assets must be re-authored with your own bundle." : ""}`,
    ``,
    `## 11. Complete Bilingual Example`,
    "```json",
    JSON.stringify(merchantExample, null, 2),
    "```",
    ``,
    `## 12. Chrome Example`,
    "```json",
    JSON.stringify(exampleChromeSpec, null, 2),
    "```",
  ].join("\n");

  return {
    filename: `report-engine-ai-transcript-v${REPORT_SPEC_VERSION}.md`,
    contentType: "text/markdown",
    markdown,
    specVersion: REPORT_SPEC_VERSION,
  };
}

/** Merchant-only transcript (E03): merchant-safe catalog, no staff authority sections. */
export function buildMerchantReportAuthoringTranscript(
  host: ReportEngineHostConfig,
  options: Omit<ReportTranscriptOptions, "merchantMode"> = {},
): { filename: string; contentType: "text/markdown"; markdown: string; specVersion: string } {
  return buildReportAuthoringTranscript(host, { ...options, merchantMode: true });
}

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

export const exampleDescriptorSpec = {
  spec_kind: "REPORT_DESCRIPTOR",
  spec_version: REPORT_SPEC_VERSION,
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
    header_mode: "GLOBAL_DEFAULT",
    footer_mode: "GLOBAL_DEFAULT",
  },
  required_assets: [],
  suggested_access: {
    roles: ["OPERATOR", "FINANCE", "SUPPORT"],
    authorities: ["merchant:read"],
  },
  i18n: {
    default_locale: "en",
    prompt_user_when_multi_locale: true,
    locales: {
      en: {
        "report.title": "Merchant Settlement Summary",
        "input.merchant": "Target Merchant",
        "input.period": "Statement Period",
        "kpi.title": "Settlement Summary",
        "kpi.total": "Total Movement",
        "table.title": "Daily Turnover",
        "table.day": "Day",
        "table.amount": "Amount",
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
      },
    },
  },
  inputs: [
    {
      key: "merchantId",
      label_i18n_key: "input.merchant",
      type: "entity_autocomplete",
      required: true,
      autocomplete: { source: "merchants" },
    },
    {
      key: "periodRange",
      label_i18n_key: "input.period",
      type: "daterange",
      required: true,
      validation: { max_range_days: 180 },
      default_value: { preset: "CURRENT_MONTH" },
    },
  ],
  datasets: [
    {
      dataset_id: "totals",
      description: "Merchant payment totals by currency for the selected period",
      from_model: "payment_attempts",
      from_alias: "pa",
      select: [
        { alias: "currency", column: "currency" },
        {
          alias: "total",
          column: "total_charged_amount_minor",
          aggregate: "SUM",
          format_hint: "CURRENCY_MINOR",
        },
      ],
      where: {
        kind: "GROUP",
        logic: "AND",
        conditions: [
          {
            kind: "PREDICATE",
            column: "merchant_id",
            op: "eq",
            binding: { source: "INPUT", input_key: "merchantId" },
          },
          {
            kind: "PREDICATE",
            column: "created_at",
            op: "between",
            binding: { source: "INPUT", input_key: "periodRange", range_bound: "BOTH" },
          },
        ],
      },
      group_by: ["currency"],
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
          format_hint: "CURRENCY_MINOR",
          tone: "PRIMARY",
        },
      ],
    },
  ],
};

export const exampleChromeSpec = {
  spec_kind: "REPORT_CHROME",
  spec_version: "1.0",
  chrome: {
    code: "institutional-header-v1",
    name: "Institutional Header",
    chrome_type: "HEADER",
    height_mm: 22,
    show_on_first_page: true,
    border_style: "THIN_RULE",
  },
  required_assets: [],
  suggested_access: {
    roles: ["FINANCE"],
    authorities: ["finance:read"],
  },
  i18n: {
    default_locale: "en",
    locales: {
      en: { "chrome.division": "Financial Operations" },
      ar: { "chrome.division": "العمليات المالية" },
    },
  },
  template: {
    html: "<div><strong>{{institutionName}}</strong> — {{$t.chrome.division}} — {{reportTitle}} — {{$t.chrome.page}}</div>",
    scoped_css: "",
    used_variables: ["institutionName", "reportTitle"],
  },
};
