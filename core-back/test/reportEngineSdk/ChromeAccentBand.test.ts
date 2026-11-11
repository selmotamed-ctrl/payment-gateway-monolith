import { describe, expect, test } from "bun:test";
import { ReportChromeSpecSchema } from "../../lib/reportEngineSdk/types/chromeSpec";
import { buildChromeAuthoringTranscript } from "../../lib/reportEngineSdk/transcript/ChromeTranscriptBuilder";
import { createTestHostConfig } from "./helpers";

const baseChrome = {
  spec_kind: "REPORT_CHROME",
  spec_version: "1.0",
  chrome: {
    code: "institutional-header-v1",
    name: "Institutional Header",
    chrome_type: "HEADER",
    height_mm: 22,
    show_on_first_page: true,
    border_style: "NONE",
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
  required_assets: [],
  i18n: {
    default_locale: "en",
    locales: { en: { "chrome.page": "Page" }, ar: { "chrome.page": "صفحة" } },
  },
  template: {
    html: "<div>{{$t.chrome.page}}</div>",
    scoped_css: "",
    used_variables: [],
  },
};

describe("chrome accent band schema", () => {
  test("accepts structured multi-color segments", () => {
    const parsed = ReportChromeSpecSchema.safeParse(baseChrome);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.chrome.accent_band?.segments.map((segment) => segment.width_percent)).toEqual([58, 26, 16]);
  });

  test("rejects a malformed accent color", () => {
    const broken = structuredClone(baseChrome);
    broken.chrome.accent_band.segments[0]!.color = "blue";
    expect(ReportChromeSpecSchema.safeParse(broken).success).toBe(false);
  });
});

describe("chrome transcript", () => {
  test("documents accent bands, defaultCurrency and slot fill", () => {
    const transcript = buildChromeAuthoringTranscript(createTestHostConfig());
    expect(transcript.markdown).toContain("accent_band");
    expect(transcript.markdown).toContain("Multi-color band example");
    expect(transcript.markdown).toContain("defaultCurrency");
    expect(transcript.markdown).toContain("fills the configured");
  });
});

