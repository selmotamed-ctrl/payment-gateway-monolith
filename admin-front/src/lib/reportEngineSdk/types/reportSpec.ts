import { z } from "zod";
import { ReportChromeSpecSchema } from "./chromeSpec";
import { normalizeReportSpec } from "./normalizeReportSpec";

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
        preset: z.enum([
          "TODAY",
          "YESTERDAY",
          "LAST_7_DAYS",
          "LAST_30_DAYS",
          "CURRENT_MONTH",
          "PREVIOUS_MONTH",
        ]),
      }),
      z.object({
        literal: z.union([
          z.string(),
          z.number(),
          z.boolean(),
          z.array(z.string()),
          z.record(z.string(), z.unknown()),
        ]),
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
      max_range_days: z.number().int().min(1).max(1095).optional(),
      enum_values: z.array(z.string()).max(100).optional(),
      enum_labels_i18n_prefix: z.string().optional(),
    })
    .optional(),
  autocomplete: z
    .object({
      source: z.enum(AUTOCOMPLETE_SOURCE_KEYS),
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
  "SIGNED_JOURNAL_AMOUNT",
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
    range_bound: z.enum(["START", "END", "BOTH"]).optional(),
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
    .enum([
      "RAW",
      "CURRENCY_MINOR",
      "DECIMAL_2",
      "DECIMAL_4",
      "PERCENT_BPS",
      "PERCENT_RATIO",
      "DATE_ISO",
      "DATETIME_ISO",
      "ENUM_TRANSLATED",
      "INTEGER",
    ])
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
  order_by: z
    .array(
      z.object({
        field: z.string(),
        direction: z.enum(["ASC", "DESC"]).default("ASC"),
      }),
    )
    .default([]),
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
    formula: z.enum([
      "ADD",
      "SUBTRACT",
      "MULTIPLY",
      "SAFE_DIVIDE",
      "PERCENTAGE_SHARE",
      "VARIANCE_BPS",
    ]),
    left_operand: z.string(),
    right_operand: z.union([z.string(), z.number()]).optional(),
    format_hint: z.enum(["RAW", "CURRENCY_MINOR", "DECIMAL_2", "PERCENT_RATIO", "PERCENT_BPS", "INTEGER"]).default("DECIMAL_2"),
  }).superRefine((value, ctx) => {
    if (value.formula !== "PERCENTAGE_SHARE" && value.right_operand === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["right_operand"],
        message: "right_operand is required unless formula is PERCENTAGE_SHARE",
      });
    }
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
    operation: z.literal("COMPARE_WITH_ASSET"),
    source_dataset_id: z.string(),
    asset_key: z.string(),
    output_dataset_id: z.string(),
    match_keys: z.array(z.string()).min(1).max(4),
    compare_fields: z.array(
      z.object({
        dataset_field: z.string(),
        asset_field: z.string(),
        output_field: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/).optional(),
        tolerance_minor: z.number().min(0).default(0),
      }),
    ),
  }),
]);

// ---------------------------------------------------------------------------
// 4. RICH VISUAL LAYOUT & SECTION PRIMITIVES
// ---------------------------------------------------------------------------
export const SectionVisibilityConditionSchema = z.object({
  dataset_id: z.string().optional(),
  when: z
    .enum(["ALWAYS", "DATASET_NOT_EMPTY", "DATASET_EMPTY", "INPUT_EQUALS"])
    .default("ALWAYS"),
  input_key: z.string().optional(),
  equals_value: z.union([z.string(), z.number(), z.boolean()]).optional(),
});

export const KpiGridSectionSchema = z.object({
  section_type: z.literal("KPI_GRID"),
  section_id: z.string(),
  title_i18n_key: z.string().optional(),
  columns: z.number().int().min(2).max(3).default(3),
  cards: z
    .array(
      z.object({
        label_i18n_key: z.string(),
        dataset_id: z.string(),
        value_field: z.string(),
        row_index: z.number().int().min(0).default(0),
        format_hint: z
          .enum(["RAW", "CURRENCY_MINOR", "DECIMAL_2", "PERCENT_RATIO", "INTEGER"])
          .default("CURRENCY_MINOR"),
        delta_field: z.string().optional(),
        delta_format_hint: z
          .enum(["RAW", "CURRENCY_MINOR", "DECIMAL_2", "PERCENT_BPS", "PERCENT_RATIO", "INTEGER"])
          .optional(),
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
          .enum([
            "RAW",
            "CURRENCY_MINOR",
            "DECIMAL_2",
            "DECIMAL_4",
            "PERCENT_BPS",
            "PERCENT_RATIO",
            "DATE_ISO",
            "DATETIME_ISO",
            "ENUM_TRANSLATED",
            "INTEGER",
            "BADGE",
          ])
          .default("RAW"),
        summary_footer: z.enum(["NONE", "SUM", "AVG", "COUNT", "MIN", "MAX", "LABEL_TOTAL"]).default("NONE"),
        badge_tone_map: z
          .record(z.string(), z.enum(["NEUTRAL", "SUCCESS", "WARNING", "DANGER", "INFO"]))
          .optional(),
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
  chart_kind: z.enum([
    "BAR",
    "STACKED_BAR",
    "LINE",
    "AREA",
    "PIE",
    "DONUT",
    "COMBO_BAR_LINE",
    "WATERFALL",
    "HEATMAP",
  ]),
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
  section_type: z.literal("VECTOR_DRAW"),
  section_id: z.string(),
  title_i18n_key: z.string().optional(),
  draw_kind: z.enum(["FLOW_DIAGRAM", "SETTLEMENT_WATERFALL_DIAGRAM", "DECLARATIVE_SVG_CANVAS"]),
  height_mm: z.number().min(25).max(180).default(65),
  view_box: z.object({
    x: z.number().optional(),
    y: z.number().optional(),
    width: z.number().min(100).max(2000).default(800),
    height: z.number().min(60).max(1200).default(260),
  }),
  dataset_id: z.string().optional(),
  nodes: z
    .array(
      z.object({
        node_id: z.string(),
        shape: z.enum(["RECT", "BAR", "ROUNDED_RECT", "PILL", "DIAMOND", "CIRCLE"]),
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
            format_hint: z
              .enum(["CURRENCY_MINOR", "INTEGER", "DECIMAL_2", "PERCENT_RATIO", "RAW"])
              .default("CURRENCY_MINOR"),
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
  custom_svg_template: z.string().max(30_000).optional(),
});

export const HtmlTemplateSectionSchema = z.object({
  section_type: z.literal("HTML_TEMPLATE"),
  section_id: z.string(),
  title_i18n_key: z.string().optional(),
  dataset_id: z.string().optional(),
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
const ReportDescriptorSpecObjectSchema = z.object({
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
    merchant_scope_input_key: z.string().optional(),
    classification: z
      .enum(["INTERNAL", "MERCHANT_CONFIDENTIAL", "REGULATORY_RESTRICTED"])
      .default("INTERNAL"),
  }),
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
  i18n: z.object({
    default_locale: z.string().default("en"),
    prompt_user_when_multi_locale: z.boolean().default(true),
    locales: z
      .record(z.string(), z.record(z.string(), z.string()))
      .refine((locales) => Boolean(locales.en && locales.ar), {
        message: "i18n.locales MUST contain at least 'en' (English) and 'ar' (Arabic) translations.",
      }),
  }),
  suggested_access: z
    .object({
      roles: z.array(z.string()).default([]),
      authorities: z.array(z.string()).default([]),
    })
    .optional(),
  inputs: z.array(ReportInputFieldSpecSchema).max(20).default([]),
  datasets: z.array(DatasetQuerySpecSchema).min(1).max(64),
  transforms: z.array(DatasetTransformSpecSchema).max(64).default([]),
  sections: z.array(ReportSectionSpecSchema).min(1).max(128),
});

export const ReportDescriptorSpecSchema = z.preprocess(
  normalizeReportSpec,
  ReportDescriptorSpecObjectSchema,
);

export type ReportDescriptorSpec = z.infer<typeof ReportDescriptorSpecSchema>;
export type ReportInputFieldSpec = z.infer<typeof ReportInputFieldSpecSchema>;
export type DatasetQuerySpec = z.infer<typeof DatasetQuerySpecSchema>;
export type DatasetSelectField = z.infer<typeof DatasetSelectFieldSchema>;
export type DatasetTransformSpec = z.infer<typeof DatasetTransformSpecSchema>;
export type ReportSectionSpec = z.infer<typeof ReportSectionSpecSchema>;
