import { describe, expect, test } from "bun:test";
import { createReportEngine } from "../../lib/reportEngineSdk";
import {
  buildMerchantReportAuthoringTranscript,
  buildReportAuthoringTranscript,
  buildReportRepairPrompt,
} from "../../lib/reportEngineSdk/transcript/ReportTranscriptBuilder";
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
    expect(transcript.markdown).toContain("Do not author headers/footers");
    expect(transcript.markdown).not.toContain("## 12. Chrome Example");
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

import { validateSpecStructureAndI18n } from "../../lib/reportEngineSdk/verifier/SpecStructuralValidator";
import { validateQueriesAndOptimizations } from "../../lib/reportEngineSdk/verifier/QuerySafetyAndOptValidator";

function parseSpecFromTranscript(markdown: string): Record<string, any> {
  const section = markdown.split("## 10. Complete Bilingual Example")[1]!;
  const match = /```json\n([\s\S]*?)\n```/.exec(section);
  if (!match) throw new Error("example block not found");
  return JSON.parse(match[1]!);
}

describe("remediation A11: the transcript example is executable", () => {
  test("the embedded bilingual example passes Layers 1-3 against the live catalog shape", async () => {
    const host = createTestHostConfig();
    const transcript = buildReportAuthoringTranscript(host);
    const spec = parseSpecFromTranscript(transcript.markdown);
    expect(spec.report.code).toBe("merchant-settlement-summary");

    const structural = validateSpecStructureAndI18n(spec, host);
    expect(structural.diagnostics.filter((d) => d.severity === "error")).toEqual([]);

    const queryDiagnostics = await validateQueriesAndOptimizations(structural.spec!, host);
    expect(queryDiagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });

  test("enum values and the gte+lte-pair rule are documented", () => {
    const transcript = buildReportAuthoringTranscript(createTestHostConfig());
    expect(transcript.markdown).toContain("AttemptStatus {SUCCEEDED | FAILED | EXPIRED}");
    expect(transcript.markdown).toContain("gte+lte pair");
    expect(transcript.markdown).toContain("Minor-unit columns");
  });
});

describe("merchant report transcript policy", () => {
  test("states that assets are enabled and excludes suggested_access", () => {
    const transcript = buildMerchantReportAuthoringTranscript(createTestHostConfig(), {
      merchantAssetsEnabled: true,
    });
    expect(transcript.markdown).toContain("Merchant assets are ENABLED by platform policy");
    expect(transcript.markdown).toContain("one flat .zip, at most 2 MB");
    expect(transcript.markdown).toContain("`applications`, `currencies`, `payment_links`, `pos_terminals`");
    const example = parseSpecFromTranscript(transcript.markdown);
    expect(example.suggested_access).toBeUndefined();
  });

  test("states that assets are disabled and forbids required_assets", () => {
    const transcript = buildMerchantReportAuthoringTranscript(createTestHostConfig(), {
      merchantAssetsEnabled: false,
    });
    expect(transcript.markdown).toContain("Merchant assets are DISABLED by platform policy");
    expect(transcript.markdown).toContain("required_assets MUST be empty");
    expect(transcript.markdown).toContain("Do not declare `required_assets`");
  });
});
