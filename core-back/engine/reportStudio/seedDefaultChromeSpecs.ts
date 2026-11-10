import { createHash } from "node:crypto";
import type { ReportChromeSpec } from "../../lib/reportEngineSdk/types/chromeSpec";

export const DEFAULT_HEADER_CHROME: ReportChromeSpec = {
  spec_kind: "REPORT_CHROME",
  spec_version: "1.0",
  chrome: {
    code: "cbl-institutional-header-v1",
    name: "Official Institutional Bilingual Header (v1)",
    chrome_type: "HEADER",
    description: "Standard bilingual institutional header with generation metadata and page counters.",
    height_mm: 22,
    show_on_first_page: true,
    border_style: "DOUBLE_BANK_RULE",
  },
  required_assets: [],
  i18n: {
    default_locale: "en",
    locales: {
      en: {
        "chrome.division": "Financial Operations & Settlement Directorate",
        "chrome.page": "Page",
        "chrome.of": "of",
        "chrome.generated": "Generated UTC:",
      },
      ar: {
        "chrome.division": "إدارة العمليات المالية والتسويات",
        "chrome.page": "صفحة",
        "chrome.of": "من",
        "chrome.generated": "تاريخ الإصدار (UTC):",
      },
    },
  },
  template: {
    html:
      '<div style="display:flex;justify-content:space-between;align-items:center;padding-bottom:4pt;border-bottom:1.5pt double #1E293B;font-size:8pt"><div><div style="font-weight:700;font-size:9.5pt">{{institutionName}}</div><div style="color:#475569">{{$t.chrome.division}}</div></div><div style="text-align:end"><div><strong>{{reportTitle}}</strong> ({{reportCode}} v{{reportVersion}})</div><div>{{$t.chrome.generated}} {{generatedAtFormatted}} | {{$t.chrome.page}} <span class="report-page-number"></span> {{$t.chrome.of}} <span class="report-total-pages"></span></div></div></div>',
    scoped_css: "",
    used_variables: [
      "institutionName",
      "reportTitle",
      "reportCode",
      "reportVersion",
      "generatedAtFormatted",
      "pageNumber",
      "totalPages",
    ],
  },
};

export const DEFAULT_FOOTER_CHROME: ReportChromeSpec = {
  spec_kind: "REPORT_CHROME",
  spec_version: "1.0",
  chrome: {
    code: "cbl-institutional-footer-v1",
    name: "Official Institutional Bilingual Footer with Verification Hash (v1)",
    chrome_type: "FOOTER",
    description: "Standard bilingual footer with actor, classification and verification hash.",
    height_mm: 16,
    show_on_first_page: true,
    border_style: "THIN_RULE",
  },
  required_assets: [],
  i18n: {
    default_locale: "en",
    locales: {
      en: {
        "chrome.confidentiality": "OFFICIAL FINANCIAL RECORD — READ-ONLY VERIFIED REPLICA EXTRACT",
        "chrome.generated_by": "Requested by:",
        "chrome.integrity_hash": "Integrity SHA-256:",
        "chrome.page": "Page",
        "chrome.of": "of",
      },
      ar: {
        "chrome.confidentiality": "سجل مالي رسمي — مستخرج موثق للقراءة فقط",
        "chrome.generated_by": "صادر بواسطة:",
        "chrome.integrity_hash": "بصمة التحقق SHA-256:",
        "chrome.page": "صفحة",
        "chrome.of": "من",
      },
    },
  },
  template: {
    html:
      '<div style="display:flex;justify-content:space-between;align-items:center;padding-top:4pt;border-top:0.75pt solid #CBD5E1;font-size:7.5pt;color:#475569"><div><strong>{{$t.chrome.confidentiality}}</strong> | {{$t.chrome.generated_by}} {{actorEmail}} ({{actorRole}})</div><div>{{$t.chrome.integrity_hash}} <code>{{verificationHashShort}}</code> | {{$t.chrome.page}} <span class="report-page-number"></span> {{$t.chrome.of}} <span class="report-total-pages"></span></div></div>',
    scoped_css: "",
    used_variables: ["actorEmail", "actorRole", "verificationHashShort", "pageNumber", "totalPages"],
  },
};

export async function seedDefaultChromeSpecs(
  client: {
    $transaction: (fn: (tx: any) => Promise<void>) => Promise<void>;
  },
  createdByUserId: string,
): Promise<void> {
  await client.$transaction(async (tx) => {
    for (const spec of [DEFAULT_HEADER_CHROME, DEFAULT_FOOTER_CHROME]) {
      const specJson = JSON.parse(JSON.stringify(spec));
      const specSha256 = createHash("sha256").update(JSON.stringify(specJson)).digest("hex");
      // Status and the global-default flag are only set when the seeded row is
      // first created: a re-run must not un-archive the seeded chrome or steal
      // the default back from a chrome an operator has since made the default.
      const existing = await tx.reportChromeSpecRecord.findUnique({
        where: { code_version: { code: spec.chrome.code, version: 1 } },
        select: { id: true },
      });
      const otherDefault = existing
        ? null
        : await tx.reportChromeSpecRecord.findFirst({
            where: { chromeType: spec.chrome.chrome_type, isDefaultGlobal: true, status: "PUBLISHED" },
            select: { id: true },
          });
      await tx.reportChromeSpecRecord.upsert({
        where: { code_version: { code: spec.chrome.code, version: 1 } },
        create: {
          code: spec.chrome.code,
          version: 1,
          name: spec.chrome.name,
          chromeType: spec.chrome.chrome_type,
          status: "PUBLISHED",
          isDefaultGlobal: !otherDefault,
          supportedLocales: Object.keys(spec.i18n.locales),
          specJson,
          specSha256,
          createdByUserId,
        },
        update: {
          name: spec.chrome.name,
          supportedLocales: Object.keys(spec.i18n.locales),
          specJson,
          specSha256,
        },
      });
    }
  });
}
