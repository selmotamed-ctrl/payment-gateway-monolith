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
    ``,
    `## 2. Available Variables`,
    variables.map((v) => `- \`{{${v}}}\``).join("\n"),
    ``,
    `## 3. Chrome Spec Schema`,
    "```json",
    JSON.stringify(exampleChromeSpec, null, 2),
    "```",
    ``,
    `## 4. Page Layout Integration`,
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
