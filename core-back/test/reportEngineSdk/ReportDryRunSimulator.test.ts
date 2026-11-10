import { describe, expect, test } from "bun:test";
import { verifyAndSimulateReportSpec } from "../../lib/reportEngineSdk/verifier/ReportDryRunSimulator";
import { baseReportSpec, createTestHostConfig } from "./helpers";

describe("RE-T19b: five-layer verification and dry-run", () => {
  test("a missing required asset fails layer 4 and produces an AI repair prompt", async () => {
    const spec = baseReportSpec();
    spec.required_assets = [
      {
        asset_key: "logo",
        file_name: "logo.png",
        mime_type: "image/png",
        purpose: "VISUAL_IMAGE",
      },
    ];
    const report = await verifyAndSimulateReportSpec({
      rawSpecJson: JSON.stringify(spec),
      extractedZipFiles: new Map(),
      host: createTestHostConfig(),
    });
    expect(report.valid).toBe(false);
    expect(report.layers.find((l) => l.layer === 4)?.passed).toBe(false);
    expect(report.diagnostics.some((d) => d.code === "REQUIRED_ASSET_MISSING_FROM_ZIP")).toBe(true);
    expect(report.aiRepairPrompt).toContain("REQUIRED_ASSET_MISSING_FROM_ZIP");
    expect(report.aiRepairPrompt).toContain("merchant-settlement-summary");
  });

  test("a valid spec passes all five layers and carries the inferred authorities", async () => {
    const report = await verifyAndSimulateReportSpec({
      rawSpecJson: JSON.stringify(baseReportSpec()),
      extractedZipFiles: new Map(),
      host: createTestHostConfig(),
    });
    expect(report.valid).toBe(true);
    expect(report.layers.every((layer) => layer.passed)).toBe(true);
    expect(report.authorityInference?.inferredNaturalRoles).toEqual(["FINANCE"]);
    expect(report.aiRepairPrompt).toBeUndefined();
  });

  test("invalid JSON fails layer 1 with a repair prompt", async () => {
    const report = await verifyAndSimulateReportSpec({
      rawSpecJson: "{ not json",
      extractedZipFiles: new Map(),
      host: createTestHostConfig(),
    });
    expect(report.valid).toBe(false);
    expect(report.diagnostics[0]?.code).toBe("INVALID_JSON_SYNTAX");
    expect(report.aiRepairPrompt).toContain("INVALID_JSON_SYNTAX");
  });
});
