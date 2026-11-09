import { describe, expect, test } from "bun:test";
import { createReportEngine } from "../../lib/reportEngineSdk";
import { buildReportRepairPrompt } from "../../lib/reportEngineSdk/transcript/ReportTranscriptBuilder";
import { baseReportSpec, createTestHostConfig } from "./helpers";

describe("RE-T20b: AI authoring transcript and repair prompt", () => {
  test("the transcript carries host columns, partition rules and bilingual mandates", () => {
    const engine = createReportEngine(createTestHostConfig());
    const transcript = engine.buildTranscript({ generatedAt: new Date("2026-05-15T00:00:00Z") });
    expect(transcript.contentType).toBe("text/markdown");
    expect(transcript.markdown).toContain("journal_lines");
    expect(transcript.markdown).toContain("created_at");
    expect(transcript.markdown).toContain("finance:read");
    expect(transcript.markdown).toMatch(/English.*Arabic|Arabic.*English/is);
    expect(transcript.markdown).toContain("asset://");
    expect(transcript.markdown).toContain("REPORT_CHROME");
    expect(transcript.markdown).toContain("2026-05-15T00:00:00.000Z");
  });

  test("the repair prompt embeds the diagnostics and the rejected spec JSON", () => {
    const prompt = buildReportRepairPrompt(JSON.stringify(baseReportSpec()), [
      {
        layer: 2,
        severity: "error",
        path: "datasets[0].where",
        code: "MANDATORY_PARTITION_FILTER_MISSING",
        message: "created_at is required",
        aiFixHint: "Add a bounded created_at predicate.",
      },
    ]);
    expect(prompt).toContain("MANDATORY_PARTITION_FILTER_MISSING");
    expect(prompt).toContain("Add a bounded created_at predicate.");
    expect(prompt).toContain("merchant-settlement-summary");
    expect(prompt).toContain("Report Descriptor Spec");
  });
});
