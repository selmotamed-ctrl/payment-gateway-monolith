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
  "defaultCurrency",
  "classificationBadge",
  "verificationHashShort",
  "pageNumber",
  "totalPages",
]);

export const ChromeAccentBandSegmentSchema = z.object({
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/, "Accent band colors must be #RRGGBB"),
  width_percent: z.number().min(1).max(100),
});

export const ChromeAccentBandSchema = z.object({
  position: z.enum(["TOP", "BOTTOM"]).default("BOTTOM"),
  height_mm: z.number().min(0.5).max(6).default(1.4),
  radius_mm: z.number().min(0).max(3).default(0),
  segments: z.array(ChromeAccentBandSegmentSchema).min(2).max(6),
});

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
    border_style: z
      .enum(["NONE", "THIN_RULE", "DOUBLE_BANK_RULE", "ACCENT_BAND"])
      .default("THIN_RULE"),
    /** Structured multi-color band; takes precedence over border_style. */
    accent_band: ChromeAccentBandSchema.optional(),
  }),
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
  i18n: z.object({
    default_locale: z.string().default("en"),
    locales: z
      .record(z.string(), z.record(z.string(), z.string()))
      .refine((locales) => Boolean(locales.en && locales.ar), {
        message:
          "i18n.locales MUST include both 'en' (English) and 'ar' (Arabic) translation dictionaries by default.",
      }),
  }),
  template: z.object({
    html: z.string().min(1).max(20_000),
    scoped_css: z.string().max(15_000).default(""),
    used_variables: z.array(ChromeVariableBindingSchema).default([]),
  }),
});

export type ReportChromeSpec = z.infer<typeof ReportChromeSpecSchema>;
