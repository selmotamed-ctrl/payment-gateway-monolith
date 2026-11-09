import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  ReportActorContext,
  ReportEngineHostConfig,
} from "./types/hostConfig";
import type { ReportChromeSpec } from "./types/chromeSpec";
import type { ReportDescriptorSpec } from "./types/reportSpec";
import {
  compileReportInputsToZodObject,
  resolveInputDefaults,
} from "./compiler/InputFormZodCompiler";
import { compileDatasetQueryToSql } from "./compiler/QueryAstToSqlCompiler";
import {
  executeTransformPipeline,
  type DatasetMap,
} from "./compiler/TransformPipelineExecutor";
import {
  buildReportAuthoringTranscript,
  buildReportRepairPrompt,
  type ReportTranscriptOptions,
} from "./transcript/ReportTranscriptBuilder";
import {
  buildChromeAuthoringTranscript,
  type ChromeTranscriptOptions,
} from "./transcript/ChromeTranscriptBuilder";
import {
  validateSpecStructureAndI18n,
  validateChromeSpecStructureAndI18n,
} from "./verifier/SpecStructuralValidator";
import {
  verifyAndSimulateReportSpec,
  type ReportVerificationReport,
} from "./verifier/ReportDryRunSimulator";
import {
  inferReportAuthorities,
  type AuthorityInferenceResult,
} from "./verifier/AuthorityInferenceEngine";
import {
  verifyExtractedAssetsAgainstSpec,
  parseCsvRows,
  type ExtractedAssetFile,
} from "./verifier/AssetBundleValidator";
import { validateSafeHtmlAndScopedCss } from "./verifier/CssAndHtmlSanitizer";

export * from "./types/hostConfig";
export * from "./types/chromeSpec";
export * from "./types/reportSpec";
export * from "./types/diagnostics";
export { buildReportRepairPrompt } from "./transcript/ReportTranscriptBuilder";
export { executeReport };
export { inferReportAuthorities, canApplySecurityOverride, isActorAllowedByPolicy } from "./verifier/AuthorityInferenceEngine";
export { validateMerchantReportScope } from "./verifier/MerchantScopeValidator";
export { PostgresReadOnlyReportExecutor } from "./runtime/PostgresReadOnlyExecutor";
export { executeTransformPipeline } from "./compiler/TransformPipelineExecutor";
export { compileDatasetQueryToSql } from "./compiler/QueryAstToSqlCompiler";
export { compileReportInputsToZodObject, resolveInputDefaults } from "./compiler/InputFormZodCompiler";
export {
  extractZipAssetFiles,
  verifyExtractedAssetsAgainstSpec,
} from "./verifier/AssetBundleValidator";
export { sanitizeHtmlForClient } from "./verifier/CssAndHtmlSanitizer";
export type { ReportVerificationReport, AuthorityInferenceResult };

export interface ReportChromeRegistryEntry {
  spec: ReportChromeSpec;
  isDefaultGlobal: boolean;
  status: "DRAFT" | "VERIFIED" | "PUBLISHED" | "ARCHIVED";
  assetBundleId?: string | null;
}

export interface ChromeSelectionOverride {
  headerMode?: "GLOBAL_DEFAULT" | "SPECIFIC_CHROME_CODE" | "INLINE_SPEC" | "NONE";
  headerChromeCode?: string | null;
  footerMode?: "GLOBAL_DEFAULT" | "SPECIFIC_CHROME_CODE" | "INLINE_SPEC" | "NONE";
  footerChromeCode?: string | null;
}

export interface ReportExecutionBundle {
  executionId: string;
  executedAtIso: string;
  verificationSha256: string;
  spec: ReportDescriptorSpec;
  resolvedHeaderChrome: ReportChromeSpec | null;
  resolvedFooterChrome: ReportChromeSpec | null;
  datasets: Record<string, Array<Record<string, unknown>>>;
  assetDataUrls: Record<string, string>;
  actor: {
    name: string;
    email: string;
    role: string;
  };
  institutionName: string;
  chromeVariables: Record<string, string>;
  inputsUsed: Record<string, unknown>;
  rowCountTotal: number;
  durationMs: number;
  servedByNode: string;
}

export interface ExecuteReportInput {
  spec: ReportDescriptorSpec;
  inputs: Record<string, unknown>;
  actor: ReportActorContext;
  chromeRegistry: ReportChromeRegistryEntry[];
  chromeOverride?: ChromeSelectionOverride | null;
  /** Already-verified assets, keyed by asset_key. */
  assets?: Record<string, { mimeType: string; buffer: Buffer; sha256: string }>;
  assetBundleId?: string | null;
  /** Only set when a second MLRO/Security Admin approved the AML bypass. */
  allowConfidentialAmlBypass?: boolean;
}

export interface ReportEngine {
  host: ReportEngineHostConfig;
  buildTranscript(options?: ReportTranscriptOptions): ReturnType<typeof buildReportAuthoringTranscript>;
  buildChromeTranscript(options?: ChromeTranscriptOptions): ReturnType<typeof buildChromeAuthoringTranscript>;
  verifyDescriptor(params: {
    rawSpecJson: string;
    extractedZipFiles: Map<string, Buffer>;
  }): Promise<ReportVerificationReport>;
  verifyChrome(params: {
    rawSpecJson: string;
    extractedZipFiles: Map<string, Buffer>;
  }): Promise<{ valid: boolean; diagnostics: import("./types/diagnostics").ReportDiagnostic[]; spec: ReportChromeSpec | null; verifiedAssets: Array<Omit<ExtractedAssetFile, "buffer">>; aiRepairPrompt?: string }>;
  inferAuthorities(
    spec: ReportDescriptorSpec,
    override?: Parameters<typeof inferReportAuthorities>[2],
  ): AuthorityInferenceResult;
  validateInputs(spec: ReportDescriptorSpec, inputs: Record<string, unknown>): Record<string, unknown>;
  resolveChrome(params: {
    spec: ReportDescriptorSpec;
    chromeRegistry: ReportChromeRegistryEntry[];
    override?: ChromeSelectionOverride | null;
  }): { header: ReportChromeSpec | null; footer: ReportChromeSpec | null };
  executeReport(input: ExecuteReportInput): Promise<ReportExecutionBundle>;
}

export function createReportEngine(host: ReportEngineHostConfig): ReportEngine {
  const engine: ReportEngine = {
    host,
    buildTranscript: (options) => buildReportAuthoringTranscript(host, options),
    buildChromeTranscript: (options) => buildChromeAuthoringTranscript(host, options),
    verifyDescriptor: (params) =>
      verifyAndSimulateReportSpec({
        rawSpecJson: params.rawSpecJson,
        extractedZipFiles: params.extractedZipFiles,
        host,
      }),
    verifyChrome: async (params) => {
      let raw: unknown;
      try {
        raw = JSON.parse(params.rawSpecJson);
      } catch (error) {
        return {
          valid: false,
          spec: null,
          verifiedAssets: [],
          diagnostics: [
            {
              layer: 1,
              severity: "error",
              path: "<root>",
              code: "INVALID_JSON_SYNTAX",
              message: `Chrome spec is not valid JSON: ${(error as Error).message}`,
              aiFixHint: "Return valid, parseable JSON without markdown commentary.",
            },
          ],
          aiRepairPrompt: buildReportRepairPrompt(params.rawSpecJson, []),
        };
      }
      const structural = validateChromeSpecStructureAndI18n(raw);
      if (!structural.spec) {
        return {
          valid: false,
          spec: null,
          verifiedAssets: [],
          diagnostics: structural.diagnostics,
          aiRepairPrompt: buildReportRepairPrompt(params.rawSpecJson, structural.diagnostics),
        };
      }
      const assets = verifyExtractedAssetsAgainstSpec({
        requiredAssets: structural.spec.required_assets,
        extractedFilesByName: params.extractedZipFiles,
        maxSingleAssetBytes: host.globalLimits.maxSingleAssetBytes,
      });
      const chromeSanitizer = validateSafeHtmlAndScopedCss({
        html: structural.spec.template.html,
        scopedCss: structural.spec.template.scoped_css,
        basePath: "chrome.template",
      });
      const diagnostics = [...structural.diagnostics, ...assets.diagnostics, ...chromeSanitizer];
      const valid = diagnostics.every((d) => d.severity !== "error");
      return {
        valid,
        spec: structural.spec,
        verifiedAssets: assets.validAssets.map(({ buffer: _b, ...meta }) => meta),
        diagnostics,
        aiRepairPrompt: valid ? undefined : buildReportRepairPrompt(params.rawSpecJson, diagnostics),
      };
    },
    inferAuthorities: (spec, override) => inferReportAuthorities(spec, host, override),
    validateInputs: (spec, inputs) => {
      const schema = compileReportInputsToZodObject(spec);
      const merged = { ...resolveInputDefaults(spec), ...inputs };
      const parsed = schema.safeParse(merged);
      if (!parsed.success) {
        throw new ReportInputValidationError(parsed.error);
      }
      return parsed.data as Record<string, unknown>;
    },
    resolveChrome: ({ spec, chromeRegistry, override }) =>
      resolveChrome(spec, chromeRegistry, override),
    executeReport: async (input) => executeReport(host, input),
  };
  return engine;
}

export class ReportInputValidationError extends Error {
  readonly code = "REPORT_INPUT_VALIDATION_FAILED";
  constructor(readonly zodError: z.ZodError) {
    super(zodError.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
  }
}

export class ReportAccessDeniedError extends Error {
  readonly code: "CONFIDENTIAL_AML_ACCESS_REQUIRED" | "REPORT_ACCESS_DENIED";
  constructor(code: "CONFIDENTIAL_AML_ACCESS_REQUIRED" | "REPORT_ACCESS_DENIED", message: string) {
    super(message);
    this.code = code;
  }
}

function hasConfidentialAmlAccess(actor: ReportActorContext): boolean {
  const role = actor.role.toUpperCase();
  return (
    role === "COMPLIANCE" ||
    role === "MLRO" ||
    (actor.authorities.includes("aml:read") && actor.authorities.includes("compliance:read"))
  );
}

function canUnmaskPii(actor: ReportActorContext, host: ReportEngineHostConfig): boolean {
  const authorities = host.piiUnmaskAuthorities ?? ["security:write"];
  return authorities.some((authority) => actor.authorities.includes(authority));
}

function maskPii(value: unknown, strategy: string | undefined): unknown {
  if (value === null || value === undefined) return value;
  const text = String(value);
  switch (strategy ?? "MASK_MIDDLE") {
    case "OMIT":
      return null;
    case "HASH_PREFIX":
      return createHash("sha256").update(text).digest("hex").slice(0, 12);
    case "MASK_MIDDLE":
    default: {
      if (text.includes("@")) {
        const [local, domain] = text.split("@");
        return `${local?.slice(0, 1) ?? ""}***@${domain ?? ""}`;
      }
      if (text.length <= 4) return "***";
      return `${text.slice(0, 2)}***${text.slice(-2)}`;
    }
  }
}

function redactPiiRow(
  ds: ReportDescriptorSpec["datasets"][number],
  row: Record<string, unknown>,
  host: ReportEngineHostConfig,
  actor: ReportActorContext,
): Record<string, unknown> {
  if (canUnmaskPii(actor, host)) return row;
  const output = { ...row };
  for (const select of ds.select) {
    const alias = select.table_alias ?? ds.from_alias;
    const model = alias === ds.from_alias
      ? host.models[ds.from_model]
      : host.models[ds.joins.find((join) => join.alias === alias)?.target_model ?? ""];
    const column = model?.columns[select.column];
    if (column?.sensitivity === "PII_MASKED") {
      output[select.alias] = maskPii(output[select.alias], column.redactionStrategy);
    }
  }
  return output;
}

function findChrome(
  registry: ReportChromeRegistryEntry[],
  type: "HEADER" | "FOOTER",
  mode: string,
  code?: string | null,
): ReportChromeSpec | null {
  if (mode === "NONE") return null;
  const published = registry.filter(
    (entry) => entry.status === "PUBLISHED" && entry.spec.chrome.chrome_type === type,
  );
  if (mode === "SPECIFIC_CHROME_CODE") {
    return published.find((entry) => entry.spec.chrome.code === code)?.spec ?? null;
  }
  if (mode === "GLOBAL_DEFAULT") {
    return published.find((entry) => entry.isDefaultGlobal)?.spec ?? null;
  }
  return null;
}

function inlineChrome(
  spec: ReportDescriptorSpec,
  type: "HEADER" | "FOOTER",
): ReportChromeSpec | null {
  const template =
    type === "HEADER" ? spec.page_layout.inline_header_spec : spec.page_layout.inline_footer_spec;
  if (!template) return null;
  return {
    spec_kind: "REPORT_CHROME",
    spec_version: "1.0",
    chrome: {
      code: `inline-${type.toLowerCase()}`,
      name: `Inline ${type}`,
      chrome_type: type,
      height_mm: 22,
      show_on_first_page: true,
      border_style: "NONE",
    },
    required_assets: [],
    i18n: {
      default_locale: spec.i18n.default_locale,
      locales: spec.i18n.locales,
    },
    template,
  };
}

function resolveChrome(
  spec: ReportDescriptorSpec,
  registry: ReportChromeRegistryEntry[],
  override?: ChromeSelectionOverride | null,
): { header: ReportChromeSpec | null; footer: ReportChromeSpec | null } {
  const headerMode = override?.headerMode ?? spec.page_layout.header_mode;
  const footerMode = override?.footerMode ?? spec.page_layout.footer_mode;
  const headerCode = override?.headerChromeCode ?? spec.page_layout.header_chrome_code;
  const footerCode = override?.footerChromeCode ?? spec.page_layout.footer_chrome_code;

  const header =
    headerMode === "INLINE_SPEC"
      ? inlineChrome(spec, "HEADER")
      : findChrome(registry, "HEADER", headerMode, headerCode);
  const footer =
    footerMode === "INLINE_SPEC"
      ? inlineChrome(spec, "FOOTER")
      : findChrome(registry, "FOOTER", footerMode, footerCode);
  return { header, footer };
}

async function executeReport(
  host: ReportEngineHostConfig,
  input: ExecuteReportInput,
): Promise<ReportExecutionBundle> {
  const startedAt = performance.now();
  const spec = input.spec;
  const schema = compileReportInputsToZodObject(spec);
  const mergedInputs = { ...resolveInputDefaults(spec), ...input.inputs };
  const parsed = schema.safeParse(mergedInputs);
  if (!parsed.success) {
    throw new ReportInputValidationError(parsed.error);
  }
  const inputsUsed = parsed.data as Record<string, unknown>;
  const nowIso = new Date().toISOString();

  const authorityInference = inferReportAuthorities(spec, host, null);
  if (
    authorityInference.requiresConfidentialAmlAccess &&
    !input.allowConfidentialAmlBypass &&
    !hasConfidentialAmlAccess(input.actor)
  ) {
    throw new ReportAccessDeniedError(
      "CONFIDENTIAL_AML_ACCESS_REQUIRED",
      "This report contains confidential AML data and requires MLRO/Compliance access or an approved AML bypass.",
    );
  }

  const datasets: DatasetMap = {};
  let rowCountTotal = 0;
  let servedByNode = "readonly-pool";
  const datasetResults = await mapWithConcurrency(spec.datasets, 4, async (ds) => {
    const compiled = compileDatasetQueryToSql(ds, host, inputsUsed, {
      userId: input.actor.userId,
      nowUtcIso: nowIso,
    });
    const result = await host.dbReadOnlyPort.executeReadOnlyQuery({
      sql: compiled.sql,
      values: compiled.values,
      timeoutMs: host.globalLimits.maxQueryTimeoutMs,
      maxRows: Math.min(ds.limit, host.globalLimits.maxRowsPerDataset),
      queryLabel: `report_${spec.report.code}_${ds.dataset_id}`,
    });
    return {
      datasetId: ds.dataset_id,
      rows: result.rows.map((row) => redactPiiRow(ds, row, host, input.actor)),
      rowCount: result.rowCount,
      servedBy: result.servedBy,
    };
  });
  for (const result of datasetResults) {
    datasets[result.datasetId] = result.rows;
    rowCountTotal += result.rowCount;
    servedByNode = result.servedBy;
  }

  const comparisonAssets: Record<string, Array<Record<string, unknown>>> = {};
  for (const [assetKey, asset] of Object.entries(input.assets ?? {})) {
    if (asset.mimeType === "application/json") {
      try {
        const parsedAsset = JSON.parse(asset.buffer.toString("utf-8"));
        if (Array.isArray(parsedAsset)) comparisonAssets[assetKey] = parsedAsset;
      } catch {
        // invalid assets are rejected during verification
      }
    } else if (asset.mimeType === "text/csv") {
      comparisonAssets[assetKey] = parseCsvRows(asset.buffer.toString("utf-8"));
    }
  }

  const finalDatasets = executeTransformPipeline(datasets, spec.transforms, comparisonAssets);
  const chrome = resolveChrome(spec, input.chromeRegistry, input.chromeOverride);

  const assetDataUrls: Record<string, string> = {};
  const chromeEntries = input.chromeRegistry.filter(
    (entry) =>
      (entry.spec.chrome.code === chrome.header?.chrome.code && entry.spec.chrome.chrome_type === "HEADER") ||
      (entry.spec.chrome.code === chrome.footer?.chrome.code && entry.spec.chrome.chrome_type === "FOOTER"),
  );
  for (const entry of chromeEntries) {
    if (!entry.assetBundleId) continue;
    for (const required of entry.spec.required_assets) {
      const stored = await host.assetStoragePort.getAssetBuffer({
        bundleId: entry.assetBundleId,
        relativePath: required.file_name,
      });
      if (stored) {
        assetDataUrls[required.asset_key] = `data:${stored.mimeType};base64,${stored.buffer.toString("base64")}`;
      }
    }
  }
  for (const required of spec.required_assets) {
    let asset = input.assets?.[required.asset_key];
    if (!asset && input.assetBundleId) {
      const stored = await host.assetStoragePort.getAssetBuffer({
        bundleId: input.assetBundleId,
        relativePath: required.file_name,
      });
      if (stored) {
        asset = { mimeType: stored.mimeType, buffer: stored.buffer, sha256: stored.sha256 };
      }
    }
    if (asset) {
      assetDataUrls[required.asset_key] = `data:${asset.mimeType};base64,${asset.buffer.toString("base64")}`;
    }
  }

  const periodInput = Object.values(inputsUsed).find(
    (value) =>
      value &&
      typeof value === "object" &&
      "start" in value &&
      "end" in value &&
      typeof (value as { start: unknown }).start === "string" &&
      typeof (value as { end: unknown }).end === "string",
  ) as { start: string; end: string } | undefined;
  const chromeVariables: Record<string, string> = {
    periodSummary: periodInput ? `${periodInput.start.slice(0, 10)} – ${periodInput.end.slice(0, 10)}` : "",
    merchantTradeName: typeof inputsUsed.merchantTradeName === "string" ? inputsUsed.merchantTradeName : "",
    merchantLegalName: typeof inputsUsed.merchantLegalName === "string" ? inputsUsed.merchantLegalName : "",
  };

  const verificationSha256 = createHash("sha256")
    .update(
      JSON.stringify({
        reportCode: spec.report.code,
        reportVersion: spec.report.version,
        inputsUsed,
        datasets: finalDatasets,
        executedAtIso: nowIso,
      }),
    )
    .digest("hex");

  return {
    executionId: randomUUID(),
    executedAtIso: nowIso,
    verificationSha256,
    spec,
    resolvedHeaderChrome: chrome.header,
    resolvedFooterChrome: chrome.footer,
    datasets: finalDatasets,
    assetDataUrls,
    actor: {
      name: input.actor.email ?? input.actor.userId,
      email: input.actor.email ?? "",
      role: input.actor.role,
    },
    institutionName: host.institutionName,
    chromeVariables,
    inputsUsed,
    rowCountTotal,
    durationMs: Math.round(performance.now() - startedAt),
    servedByNode,
  };
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!, index);
    }
  });
  await Promise.all(runners);
  return results;
}
