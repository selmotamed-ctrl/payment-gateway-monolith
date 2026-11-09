import type { CatalogModelDef, ReportEngineHostConfig } from "../types/hostConfig";
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
  domains?: Array<CatalogModelDef["domain"]>;
  includeChromeAuthoringGuide?: boolean;
  generatedAt?: Date;
}

export function buildReportAuthoringTranscript(
  host: ReportEngineHostConfig,
  options: ReportTranscriptOptions = {},
): { filename: string; contentType: "text/markdown"; markdown: string; specVersion: string } {
  const generatedAtIso = (options.generatedAt ?? new Date()).toISOString();
  const domainFilter =
    options.domains && options.domains.length > 0 ? new Set(options.domains) : null;

  const modelSections: string[] = [];
  for (const model of Object.values(host.models)) {
    if (domainFilter && !domainFilter.has(model.domain)) continue;
    const cols = Object.values(model.columns)
      .filter((c) => c.sensitivity !== "FORBIDDEN_SECRET")
      .map(
        (c) =>
          `  - \`${c.name}\` (${c.type}${c.enumName ? `:${c.enumName}` : ""}${c.indexed ? ", INDEXED" : ""}${
            c.sensitivity !== "PUBLIC" && c.sensitivity !== "INTERNAL" ? `, ${c.sensitivity}` : ""
          }${c.minorUnitScale ? `, minor scale ${c.minorUnitScale}` : ""}) — ${c.description}`,
      )
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
    ``,
    `## 4. Visual Sections & Page Layout`,
    `Use only the closed section vocabulary: \`KPI_GRID\`, \`DATA_TABLE\`, \`CHART\` (ECharts vector), \`VECTOR_DRAW\` (flow diagram, settlement waterfall, declarative SVG canvas), \`HTML_TEMPLATE\` (logic-less Mustache with \`{{$t.key}}\` tokens), \`IMAGE_BANNER\` (asset:// references) and \`PAGE_BREAK\`.`,
    `Every section needs a unique \`section_id\`, and every referenced \`*_i18n_key\` must exist in **all** locales.`,
    ``,
    `## 5. Headers and Footers`,
    `Report headers and footers are authored as \`ReportChromeSpec\` documents (\`spec_kind: "REPORT_CHROME"\`, \`chrome.chrome_type: "HEADER" | "FOOTER"\`) with their own \`required_assets\`, bilingual \`i18n\`, \`template.html\` and \`template.scoped_css\`. A report selects them with \`page_layout.header_mode/footer_mode\` = \`GLOBAL_DEFAULT\`, \`SPECIFIC_CHROME_CODE\`, \`INLINE_SPEC\` or \`NONE\`.`,
    ``,
    `## 6. Asset Bundles`,
    `If the report needs logos, seals or comparison baselines, declare them in \`required_assets[]\` with a flat \`file_name\` and \`purpose\`: \`VISUAL_IMAGE\` or \`COMPARISON_BASELINE_DATA\` (\`.json\`/\`.csv\`). Reference visual assets with \`asset://asset_key\` and compare datasets with the \`COMPARE_WITH_ASSET\` transform.`,
    ``,
    `## 7. Complete Bilingual Example`,
    "```json",
    JSON.stringify(exampleDescriptorSpec, null, 2),
    "```",
    ``,
    `## 8. Chrome Example`,
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

const exampleDescriptorSpec = {
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
      validation: { max_range_days: 366 },
      default_value: { preset: "CURRENT_MONTH" },
    },
  ],
  datasets: [
    {
      dataset_id: "totals",
      description: "Period totals",
      from_model: "journal_lines",
      from_alias: "jl",
      select: [
        { alias: "currency", column: "currency" },
        { alias: "total", column: "amount_minor", aggregate: "SUM", format_hint: "CURRENCY_MINOR" },
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

const exampleChromeSpec = {
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
