import type { ReportEngineHostConfig } from "../types/hostConfig";
import type { ReportDiagnostic } from "../types/diagnostics";
import { validateSpecStructureAndI18n } from "./SpecStructuralValidator";
import {
  synthesizeDefaultInputs,
  validateQueriesAndOptimizations,
} from "./QuerySafetyAndOptValidator";
import { inferReportAuthorities, type AuthorityInferenceResult } from "./AuthorityInferenceEngine";
import { validateSafeHtmlAndScopedCss } from "./CssAndHtmlSanitizer";
import {
  verifyExtractedAssetsAgainstSpec,
  type ExtractedAssetFile,
} from "./AssetBundleValidator";
import { buildReportRepairPrompt } from "../transcript/ReportTranscriptBuilder";
import { validateSpecReferences } from "./SpecReferenceValidator";
import { validateMerchantReportScope } from "./MerchantScopeValidator";
import { compileDatasetQueryToSql } from "../compiler/QueryAstToSqlCompiler";
import { executeTransformPipeline, type DatasetMap } from "../compiler/TransformPipelineExecutor";

export interface ReportVerificationReport {
  valid: boolean;
  specVersion: string | null;
  layers: Array<{
    layer: 1 | 2 | 3 | 4 | 5;
    name: string;
    passed: boolean;
    status: "PASSED" | "FAILED" | "SKIPPED";
    errorCount: number;
    warningCount: number;
  }>;
  authorityInference: AuthorityInferenceResult | null;
  verifiedAssets: Array<Omit<ExtractedAssetFile, "buffer">>;
  diagnostics: ReportDiagnostic[];
  aiRepairPrompt?: string;
}

export async function verifyAndSimulateReportSpec(params: {
  rawSpecJson: string;
  extractedZipFiles: Map<string, Buffer>;
  host: ReportEngineHostConfig;
}): Promise<ReportVerificationReport> {
  const allDiagnostics: ReportDiagnostic[] = [];
  let parsedRaw: unknown;

  try {
    parsedRaw = JSON.parse(params.rawSpecJson);
  } catch (err) {
    const diag: ReportDiagnostic = {
      layer: 1,
      severity: "error",
      path: "<root>",
      code: "INVALID_JSON_SYNTAX",
      message: `Spec file is not valid JSON: ${(err as Error).message}`,
      aiFixHint: "Return valid, parseable JSON without markdown commentary outside the JSON block.",
    };
    return {
      valid: false,
      specVersion: null,
      layers: buildLayerScorecard([diag], true),
      authorityInference: null,
      verifiedAssets: [],
      diagnostics: [diag],
      aiRepairPrompt: buildReportRepairPrompt(params.rawSpecJson, [diag]),
    };
  }

  const { spec, diagnostics: l1Diags } = validateSpecStructureAndI18n(parsedRaw, params.host);
  allDiagnostics.push(...l1Diags);
  if (!spec) {
    return buildFinalReport(params.rawSpecJson, null, null, [], allDiagnostics);
  }

  allDiagnostics.push(...validateSpecReferences(spec, params.host));
  const l2Diags = await validateQueriesAndOptimizations(spec, params.host);
  allDiagnostics.push(...l2Diags);
  allDiagnostics.push(...validateMerchantReportScope(spec, params.host));

  const authorityInference = inferReportAuthorities(spec, params.host, null);
  if (authorityInference.conflictStatus !== "NONE") {
    for (const c of authorityInference.conflictDetails) {
      allDiagnostics.push({
        layer: 3,
        severity: "warning",
        path: "datasets",
        code: c.code,
        message: c.message,
        aiFixHint: c.resolutionHint,
      });
    }
  }

  for (let i = 0; i < spec.sections.length; i++) {
    const sec = spec.sections[i]!;
    if (sec.section_type === "HTML_TEMPLATE") {
      allDiagnostics.push(
        ...validateSafeHtmlAndScopedCss({
          html: sec.html_template,
          scopedCss: sec.scoped_css,
          basePath: `sections[${i}](${sec.section_id})`,
        }),
      );
    } else if (sec.section_type === "VECTOR_DRAW" && sec.custom_svg_template) {
      allDiagnostics.push(
        ...validateSafeHtmlAndScopedCss({
          html: sec.custom_svg_template,
          scopedCss: "",
          basePath: `sections[${i}](${sec.section_id}).custom_svg_template`,
        }),
      );
    }
  }

  const { validAssets, diagnostics: assetDiags } = verifyExtractedAssetsAgainstSpec({
    requiredAssets: spec.required_assets,
    extractedFilesByName: params.extractedZipFiles,
    maxSingleAssetBytes: params.host.globalLimits.maxSingleAssetBytes,
  });
  allDiagnostics.push(...assetDiags);

  // Layer 5: read-only dry-run simulation with synthesized sample inputs.
  if (!allDiagnostics.some((d) => d.severity === "error")) {
    const sampleInputs = synthesizeDefaultInputs(spec);
    const datasets: DatasetMap = {};
    try {
      for (const ds of spec.datasets) {
        const compiled = compileDatasetQueryToSql(ds, params.host, sampleInputs, {
          userId: "00000000-0000-0000-0000-000000000000",
          nowUtcIso: new Date().toISOString(),
        });
        const result = await params.host.dbReadOnlyPort.executeReadOnlyQuery({
          sql: compiled.sql,
          values: compiled.values,
          timeoutMs: Math.min(5_000, params.host.globalLimits.maxQueryTimeoutMs),
          maxRows: Math.min(ds.limit, params.host.globalLimits.maxRowsPerDataset),
          queryLabel: `dry_run_${ds.dataset_id}`,
        });
        datasets[ds.dataset_id] = result.rows;
      }
      const comparisonAssets: Record<string, Array<Record<string, unknown>>> = {};
      for (const asset of validAssets) {
        if (asset.parsedComparisonRows) {
          comparisonAssets[asset.assetKey] = asset.parsedComparisonRows;
        }
      }
      executeTransformPipeline(datasets, spec.transforms, comparisonAssets);
    } catch (error) {
      allDiagnostics.push({
        layer: 5,
        severity: "error",
        path: "datasets",
        code: "DRY_RUN_EXECUTION_FAILED",
        message: `Read-only dry-run failed: ${(error as Error).message}`,
        aiFixHint:
          "Check the dataset WHERE bindings, relation names, column names and input defaults; the dry-run uses synthesized sample values.",
      });
    }
  }

  return buildFinalReport(
    params.rawSpecJson,
    spec.spec_version,
    authorityInference,
    validAssets.map(({ buffer: _b, ...meta }) => meta),
    allDiagnostics,
  );
}

const REPORT_LAYER_NAMES: Array<{ layer: 1 | 2 | 3 | 4 | 5; name: string }> = [
  { layer: 1, name: "Layer 1: Zod Schema & Bilingual (en+ar) i18n Completeness" },
  { layer: 2, name: "Layer 2: Read-Only AST Safety, Partition Pruning & EXPLAIN Cost" },
  { layer: 3, name: "Layer 3: Automatic Authority Inference & Conflict Detection" },
  { layer: 4, name: "Layer 4: HTML/CSS/SVG Sanitizer & .zip Asset Bundle Verification" },
  { layer: 5, name: "Layer 5: Read-Only Dry-Run Simulation" },
];

/**
 * Layer scorecard with an explicit SKIPPED status: a layer that never ran
 * (because an earlier layer failed) must not be reported as passed (A16).
 */
function buildLayerScorecard(
  diagnostics: ReportDiagnostic[],
  specMissing: boolean,
): ReportVerificationReport["layers"] {
  const firstErrorLayer = diagnostics.find((d) => d.severity === "error")?.layer ?? null;
  return REPORT_LAYER_NAMES.map((entry) => {
    const layerDiagnostics = diagnostics.filter((d) => d.layer === entry.layer);
    const errorCount = layerDiagnostics.filter((d) => d.severity === "error").length;
    const warningCount = layerDiagnostics.filter((d) => d.severity === "warning").length;
    let status: "PASSED" | "FAILED" | "SKIPPED";
    if (specMissing && entry.layer > 1) {
      status = "SKIPPED";
    } else if (entry.layer === 5 && firstErrorLayer !== null && firstErrorLayer < 5) {
      status = "SKIPPED";
    } else {
      status = errorCount > 0 ? "FAILED" : "PASSED";
    }
    return {
      layer: entry.layer,
      name: entry.name,
      passed: status === "PASSED",
      status,
      errorCount,
      warningCount,
    };
  });
}

function buildFinalReport(
  rawSpecJson: string,
  specVersion: string | null,
  authorityInference: AuthorityInferenceResult | null,
  verifiedAssets: Array<Omit<ExtractedAssetFile, "buffer">>,
  diagnostics: ReportDiagnostic[],
): ReportVerificationReport {
  const layers = buildLayerScorecard(diagnostics, specVersion === null);

  const valid = diagnostics.every((d) => d.severity !== "error");
  return {
    valid,
    specVersion,
    layers,
    authorityInference,
    verifiedAssets,
    diagnostics,
    aiRepairPrompt: valid ? undefined : buildReportRepairPrompt(rawSpecJson, diagnostics),
  };
}
