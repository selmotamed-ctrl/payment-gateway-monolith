import { describe, expect, test } from "bun:test";
import {
  buildChromeMigrationPrompt,
  buildReportMigrationPrompt,
  classifyStoredChromeSpec,
  classifyStoredReportSpec,
  safeParseStoredReportSpec,
} from "../../lib/reportEngineSdk";
import { exampleDescriptorSpec } from "../../lib/reportEngineSdk/transcript/ReportTranscriptBuilder";
import {
  REPORT_CHROME_SPEC_VERSION,
  REPORT_ENGINE_VERSION,
  REPORT_SPEC_VERSION,
} from "../../lib/reportEngineSdk/version";

const chromeSpec = {
  spec_kind: "REPORT_CHROME",
  spec_version: REPORT_CHROME_SPEC_VERSION,
  chrome: {
    code: "merchant-branding-header",
    name: "Merchant Branding Header",
    chrome_type: "HEADER",
    height_mm: 22,
    show_on_first_page: true,
    border_style: "NONE",
  },
  required_assets: [],
  i18n: {
    default_locale: "en",
    locales: {
      en: { "chrome.company": "Company" },
      ar: { "chrome.company": "الشركة" },
    },
  },
  template: {
    html: "<div>{{merchantTradeName}} — {{$t.chrome.company}}</div>",
    scoped_css: "",
    used_variables: ["merchantTradeName"],
  },
};

describe("stored report compatibility", () => {
  test("current specs are compatible and parse safely", () => {
    const spec = structuredClone(exampleDescriptorSpec);
    const result = classifyStoredReportSpec({
      specJson: spec,
      storedEngineVersion: REPORT_ENGINE_VERSION,
      storedSpecVersion: REPORT_SPEC_VERSION,
    });
    expect(result.status).toBe("COMPATIBLE");
    expect(result.promptAvailable).toBe(false);
    const parsed = safeParseStoredReportSpec({
      specJson: spec,
      storedEngineVersion: REPORT_ENGINE_VERSION,
      storedSpecVersion: REPORT_SPEC_VERSION,
    });
    expect(parsed.ok).toBe(true);
  });

  test("an engine major mismatch needs migration before parsing", () => {
    const result = classifyStoredReportSpec({
      specJson: structuredClone(exampleDescriptorSpec),
      storedEngineVersion: "0.9.0",
      storedSpecVersion: REPORT_SPEC_VERSION,
    });
    expect(result.status).toBe("NEEDS_MIGRATION");
    expect(result.reasonCode).toBe("ENGINE_MAJOR_VERSION_MISMATCH");
    expect(result.promptAvailable).toBe(true);
  });

  test("a current-version malformed spec is invalid, not thrown", () => {
    const broken = structuredClone(exampleDescriptorSpec) as Record<string, unknown>;
    broken.datasets = [];
    const result = classifyStoredReportSpec({
      specJson: broken,
      storedEngineVersion: REPORT_ENGINE_VERSION,
      storedSpecVersion: REPORT_SPEC_VERSION,
    });
    expect(result.status).toBe("INVALID");
    expect(result.reasonCode).toBe("CURRENT_SCHEMA_VALIDATION_FAILED");
    expect(result.issues.length).toBeGreaterThan(0);
  });

  test("missing version metadata needs migration", () => {
    const result = classifyStoredReportSpec({ specJson: structuredClone(exampleDescriptorSpec) });
    expect(result.status).toBe("NEEDS_MIGRATION");
    expect(result.reasonCode).toBe("MISSING_VERSION_METADATA");
  });

  test("report migration prompt carries the old spec and target transcript", () => {
    const compatibility = classifyStoredReportSpec({
      specJson: structuredClone(exampleDescriptorSpec),
      storedEngineVersion: "0.9.0",
      storedSpecVersion: REPORT_SPEC_VERSION,
    });
    const prompt = buildReportMigrationPrompt({
      code: exampleDescriptorSpec.report.code,
      version: 7,
      oldSpec: exampleDescriptorSpec,
      compatibility,
      targetTranscript: "# Current report transcript\nUse only current fields.",
      targetTranscriptVersion: "1.1",
    });
    expect(prompt).toContain("Report Descriptor Migration");
    expect(prompt).toContain(exampleDescriptorSpec.report.code);
    expect(prompt).toContain("ENGINE_MAJOR_VERSION_MISMATCH");
    expect(prompt).toContain("Current report transcript");
    expect(prompt).toContain("Return only the migrated JSON object");
  });
});

describe("stored chrome compatibility", () => {
  test("current chrome is compatible", () => {
    const result = classifyStoredChromeSpec({
      specJson: chromeSpec,
      storedEngineVersion: REPORT_ENGINE_VERSION,
      storedSpecVersion: REPORT_CHROME_SPEC_VERSION,
    });
    expect(result.status).toBe("COMPATIBLE");
  });

  test("chrome version mismatch needs migration and produces a prompt", () => {
    const compatibility = classifyStoredChromeSpec({
      specJson: chromeSpec,
      storedEngineVersion: "0.9.0",
      storedSpecVersion: REPORT_CHROME_SPEC_VERSION,
    });
    expect(compatibility.status).toBe("NEEDS_MIGRATION");
    const prompt = buildChromeMigrationPrompt({
      code: chromeSpec.chrome.code,
      version: 2,
      oldSpec: chromeSpec,
      compatibility,
      targetTranscript: "# Current chrome transcript\nUse asset:// for logos.",
      targetTranscriptVersion: "1.0",
      merchantMode: true,
    });
    expect(prompt).toContain("Report Header/Footer Migration");
    expect(prompt).toContain("merchant-branding-header");
    expect(prompt).toContain("Current chrome transcript");
    expect(prompt).toContain("Return only the migrated JSON object");
  });
});
