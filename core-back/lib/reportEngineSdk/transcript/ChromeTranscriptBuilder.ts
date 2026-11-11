import type { ReportEngineHostConfig } from "../types/hostConfig";
import {
  ChromeVariableBindingSchema,
  REPORT_CHROME_SPEC_VERSION,
} from "../types/chromeSpec";

export interface ChromeTranscriptOptions {
  generatedAt?: Date;
}

export function buildChromeAuthoringTranscript(
  host: ReportEngineHostConfig,
  options: ChromeTranscriptOptions = {},
): { filename: string; contentType: "text/markdown"; markdown: string; specVersion: string } {
  const generatedAtIso = (options.generatedAt ?? new Date()).toISOString();
  const variables = ChromeVariableBindingSchema.options;

  const markdown = [
    `# ${host.institutionName} — Report Header/Footer (Chrome) AI Authoring Transcript (v${REPORT_CHROME_SPEC_VERSION})`,
    `Generated: \`${generatedAtIso}\` | Default Currency: \`${host.defaultCurrency}\``,
    ``,
    `## 1. Your Role & Output Instructions`,
    `You are generating a reusable **Report Chrome Spec** (\`spec_kind: "REPORT_CHROME"\`, \`spec_version: "${REPORT_CHROME_SPEC_VERSION}"\`) for a report header or footer. Output ONLY valid JSON.`,
    `- **MANDATORY BILINGUAL RULE:** Always include complete \`i18n.locales.en\` and \`i18n.locales.ar\` dictionaries. Every \`{{$t.key}}\` token used in \`template.html\` must exist in every locale.`,
    `- Use only safe layout HTML (\`div\`, \`span\`, \`table\`, \`img\`, \`svg\`). Never include scripts, event handlers, iframes or external URLs.`,
    `- Images must be declared in \`required_assets\` and referenced as \`asset://asset_key\` in the template.`,
    `- Page counters use \`<span class="report-page-number"></span>\` and \`<span class="report-total-pages"></span>\`; they are bound by CSS Paged Media \`counter(page)\`/\`counter(pages)\`.`,
    `- The first top-level element of \`template.html\` fills the configured \`height_mm\` slot. Use one root wrapper (usually a flex row) and do not rely on a parent min-height.`,
    `- \`periodSummary\` and \`generatedAtFormatted\` are localized by the renderer; do not pre-format ISO strings in the template.`,
    `- \`defaultCurrency\` is the host default currency (for example LYD); use it only when the header/footer design calls for it.`,
    ``,
    `## 2. Available Variables`,
    variables.map((v) => `- \`{{${v}}}\``).join("\n"),
    ``,
    `## 3. Chrome Spec Schema`,
    "```json",
    JSON.stringify(exampleChromeSpec, null, 2),
    "```",
    ``,
    `## 4. Chrome Field Reference`,
    `- \`chrome\`: \`code\` (kebab-case), \`name\`, \`chrome_type\` (HEADER | FOOTER), optional \`description\`, \`height_mm\` (8-45), \`show_on_first_page\`, \`border_style\` (NONE, THIN_RULE, DOUBLE_BANK_RULE, ACCENT_BAND).`,
    `- \`chrome.accent_band\` (optional): \`position\` (TOP | BOTTOM), \`height_mm\` (0.5-6), \`radius_mm\` (0-3), and 2-6 \`segments\` with \`color\` (#RRGGBB) and \`width_percent\`. This draws a hard-stop multi-color band and takes precedence over \`border_style\`.`,
    `- For a multi-color bottom border always use \`accent_band\`; do not try to emulate it with a single \`border_style\`. For a single-color rule use \`border_style\`. Advanced custom decoration may use \`template.scoped_css\` with namespaced classes; no external URLs, scripts or imports.`,
    `- \`required_assets[]\`: \`asset_key\`, flat \`file_name\`, \`mime_type\` (image/png, image/jpeg, image/webp, image/svg+xml), \`alt_i18n_key\`, optional \`max_width_mm\`/\`max_height_mm\`. Reference as \`asset://asset_key\`.`,
    `- \`i18n\`: \`default_locale\` and complete \`locales.en\` + \`locales.ar\` dictionaries. Every \`{{$t.key}}\` and every \`alt_i18n_key\` must exist in every locale.`,
    `- \`template\`: sanitized \`html\`, \`scoped_css\`, and \`used_variables\`. Allowed variables are listed in section 2. Use page counters exactly as described in section 1. Every variable used in the template must be listed in \`used_variables\`.`,
    `- \`show_on_first_page=false\` suppresses this header/footer on page 1. \`height_mm\` is the chrome slot height; \`border_style\` draws a simple rule and \`accent_band\` draws a multi-color band.`,
    ``,
    `## 5. Multi-color band example`,
    "```json",
    JSON.stringify(
      {
        accent_band: {
          position: "BOTTOM",
          height_mm: 1.4,
          radius_mm: 0.6,
          segments: [
            { color: "#0b5d7a", width_percent: 58 },
            { color: "#2e8b57", width_percent: 26 },
            { color: "#e67e22", width_percent: 16 },
          ],
        },
      },
      null,
      2,
    ),
    "```",
    `This is the institutional header band: teal 58%, green 26%, orange 16%. Set \`chrome.border_style\` to \`"NONE"\` when using it.`,
    ``,
    `## 6. Page Layout Integration`,
    `A report selects this chrome with \`page_layout.header_mode/footer_mode\` = \`GLOBAL_DEFAULT\`, \`SPECIFIC_CHROME_CODE\` (with \`header_chrome_code\`/\`footer_chrome_code\`), \`INLINE_SPEC\`, or \`NONE\`. Only one published HEADER and one published FOOTER can be the global default at a time.`,
  ].join("\n");

  return {
    filename: `chrome-engine-ai-transcript-v${REPORT_CHROME_SPEC_VERSION}.md`,
    contentType: "text/markdown",
    markdown,
    specVersion: REPORT_CHROME_SPEC_VERSION,
  };
}

const exampleChromeSpec = {
  spec_kind: "REPORT_CHROME",
  spec_version: REPORT_CHROME_SPEC_VERSION,
  chrome: {
    code: "institutional-header-v1",
    name: "Institutional Header",
    chrome_type: "HEADER",
    description: "Bilingual institutional header",
    height_mm: 22,
    show_on_first_page: true,
    border_style: "THIN_RULE",
  },
  required_assets: [
    {
      asset_key: "institution_logo",
      file_name: "institution-crest.svg",
      mime_type: "image/svg+xml",
      alt_i18n_key: "chrome.logo_alt",
      max_width_mm: 38,
      max_height_mm: 16,
    },
  ],
  i18n: {
    default_locale: "en",
    locales: {
      en: {
        "chrome.logo_alt": "Institution official crest",
        "chrome.division": "Financial Operations",
        "chrome.page": "Page",
        "chrome.of": "of",
      },
      ar: {
        "chrome.logo_alt": "الشعار الرسمي للمؤسسة",
        "chrome.division": "العمليات المالية",
        "chrome.page": "صفحة",
        "chrome.of": "من",
      },
    },
  },
  template: {
    html: "<div style=\"display:flex;justify-content:space-between;align-items:center\"><div><img src=\"asset://institution_logo\" alt=\"{{$t.chrome.logo_alt}}\" style=\"height:14mm\" /><strong>{{institutionName}}</strong> — {{$t.chrome.division}}</div><div>{{reportTitle}} ({{reportCode}} v{{reportVersion}}) — {{$t.chrome.page}} <span class=\"report-page-number\"></span> {{$t.chrome.of}} <span class=\"report-total-pages\"></span></div></div>",
    scoped_css: "",
    used_variables: ["institutionName", "reportTitle", "reportCode", "reportVersion", "pageNumber", "totalPages"],
  },
};
