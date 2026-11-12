import { Decimal } from "decimal.js";
import type { CatalogModelDef, ReportActorContext, ReportEngineHostConfig } from "../types/hostConfig";
import type { ReportDescriptorSpec, ReportSectionSpec } from "../types/reportSpec";
import type { ReportChromeSpec } from "../types/chromeSpec";
import { executeTransformPipeline, type DatasetMap } from "../compiler/TransformPipelineExecutor";
import { REPORT_ENGINE_VERSION, REPORT_SPEC_VERSION } from "../version";

/**
 * Deterministic, database-free bundle used by the Studio preview.
 *
 * A preview must fill every section: an author checking a draft should not see
 * empty tables merely because a synthesized zero UUID matches no real entity.
 * This builder fabricates typed rows from the dataset AST, runs the real
 * transform pipeline over them, and produces placeholder asset data URLs. The
 * result is rendered through the exact same client renderer as a live run.
 */

export interface MockReportBundle {
  executionId: string;
  executedAtIso: string;
  verificationSha256: string;
  spec: ReportDescriptorSpec;
  resolvedHeaderChrome: ReportChromeSpec | null;
  resolvedFooterChrome: ReportChromeSpec | null;
  datasets: Record<string, Array<Record<string, unknown>>>;
  assetDataUrls: Record<string, string>;
  actor: { name: string; email: string; role: string };
  institutionName?: string;
  chromeVariables?: Record<string, string>;
  chromeFallbackUsed?: boolean;
  engineVersion?: string;
  reportSpecVersion?: string;
  currency?: string;
  inputsUsed: Record<string, unknown>;
  rowCountTotal: number;
  durationMs: number;
  servedByNode: string;
  previewMode: "MOCK";
}

const CURRENCY_CODES = ["LYD", "USD", "EUR", "GBP"];
const STATUS_CODES = ["SUCCEEDED", "PENDING", "FAILED", "REVERSED"];
const CATEGORY_CODES = ["CARD", "WALLET", "BANK", "QR"];
const CHANNEL_CODES = ["WEB", "MOBILE", "POS", "API"];
const COUNTRY_CODES = ["LY", "EG", "TN", "AE"];

const isDateAlias = (alias: string): boolean =>
  /(^|_)(day|date|month|week|hour|period|window_start|created_at|updated_at|due_at|executed_at)($|_)/i.test(alias);
const isCountAlias = (alias: string): boolean =>
  /(^|_)(count|attempts|lines|samples|items|total_count|n|rows|transactions|volume_count)($|_)/i.test(alias);
const isRankAlias = (alias: string): boolean => /(^|_)(rank|position|row_number|row_num)($|_)/i.test(alias);
const isShareAlias = (alias: string): boolean =>
  /(^|_)(share|ratio|percent|percentage|pct|rate|success_rate|cost_ratio)($|_)/i.test(alias);
const isNameAlias = (alias: string): boolean =>
  /(^|_)(name|title|label|legal_name|trade_name|display_name|merchant_name|rail_name)($|_)/i.test(alias);
const isCodeAlias = (alias: string): boolean => /(^|_)(code|status|state|type|tier|environment|channel|currency|direction)($|_)/i.test(alias);
const isIdAlias = (alias: string): boolean => /(^|_)(id|uuid|reference|ref|key|token)($|_)/i.test(alias);

function modelForAlias(
  ds: ReportDescriptorSpec["datasets"][number],
  tableAlias: string | undefined,
  host: ReportEngineHostConfig,
): CatalogModelDef | undefined {
  const alias = tableAlias ?? ds.from_alias;
  if (alias === ds.from_alias) return host.models[ds.from_model];
  const join = ds.joins.find((candidate) => candidate.alias === alias);
  return join ? host.models[join.target_model] : undefined;
}

function decimalString(value: number | string): string {
  try {
    return new Decimal(value).toFixed();
  } catch {
    return "0";
  }
}

function categoryValue(
  alias: string,
  index: number,
  model: CatalogModelDef | undefined,
  columnName: string,
  host: ReportEngineHostConfig,
): string {
  const column = model?.columns[columnName];
  const enumValues = column?.enumName ? host.enums[column.enumName] : undefined;
  if (enumValues && enumValues.length > 0) return enumValues[index % enumValues.length]!;
  if (/currency/i.test(alias)) return CURRENCY_CODES[index % CURRENCY_CODES.length]!;
  if (/status|state/i.test(alias)) return STATUS_CODES[index % STATUS_CODES.length]!;
  if (/rail|gateway|method/i.test(alias)) return CATEGORY_CODES[index % CATEGORY_CODES.length]!;
  if (/channel|source/i.test(alias)) return CHANNEL_CODES[index % CHANNEL_CODES.length]!;
  if (/country/i.test(alias)) return COUNTRY_CODES[index % COUNTRY_CODES.length]!;
  if (/direction/i.test(alias)) return index % 2 === 0 ? "DEBIT" : "CREDIT";
  if (/type|tier|environment/i.test(alias)) return ["LIVE", "SANDBOX", "STANDARD", "HIGH"][index % 4]!;
  if (isRankAlias(alias)) return String(index + 1);
  return `${titleCase(alias)} ${index + 1}`;
}

function titleCase(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function dateValue(alias: string, index: number, now: Date): string {
  const date = new Date(now.getTime() - (index + 1) * 24 * 3600 * 1000);
  if (/month/i.test(alias)) return `${date.toISOString().slice(0, 7)}-01`;
  if (/hour/i.test(alias)) return date.toISOString();
  if (/week/i.test(alias)) return date.toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function aggregateValue(
  alias: string,
  index: number,
  formatHint: string,
): string | number {
  if (formatHint === "CURRENCY_MINOR") return 1_250_000 + index * 2_375_000;
  if (formatHint === "INTEGER") return (index + 1) * 37;
  if (formatHint === "PERCENT_BPS") return 120 + index * 35;
  if (formatHint === "PERCENT_RATIO" || formatHint === "DECIMAL_2" || formatHint === "DECIMAL_4") {
    return decimalString(12.5 + index * 3.25);
  }
  if (isCountAlias(alias)) return (index + 1) * 37;
  if (isShareAlias(alias)) return decimalString(10 + index * 5);
  return decimalString(1_250_000 + index * 2_375_000);
}

function sampleValue(params: {
  alias: string;
  columnName: string;
  expression: string;
  aggregate?: string;
  formatHint: string;
  index: number;
  model: CatalogModelDef | undefined;
  host: ReportEngineHostConfig;
  now: Date;
  groupField: boolean;
}): unknown {
  const { alias, columnName, expression, aggregate, formatHint, index, model, host, now, groupField } = params;
  if (expression === "DATE_TRUNC_DAY" || expression === "DATE_TRUNC_MONTH" || expression === "DATE_TRUNC_WEEK" || expression === "DATE_TRUNC_HOUR") {
    return dateValue(expression, index, now);
  }
  if (aggregate) return aggregateValue(alias, index, formatHint);
  if (isDateAlias(alias) || model?.columns[columnName]?.type === "datetime") return dateValue(alias, index, now);
  if (formatHint === "CURRENCY_MINOR") return 1_250_000 + index * 2_375_000;
  if (formatHint === "INTEGER") return groupField ? index + 1 : 10 + index * 3;
  if (formatHint === "PERCENT_BPS") return 120 + index * 35;
  if (formatHint === "PERCENT_RATIO" || formatHint === "DECIMAL_2" || formatHint === "DECIMAL_4") {
    return decimalString(12.5 + index * 3.25);
  }
  if (formatHint === "ENUM_TRANSLATED" || (model?.columns[columnName]?.enumName && groupField)) {
    return categoryValue(alias, index, model, columnName, host);
  }
  if (isRankAlias(alias)) return index + 1;
  if (isShareAlias(alias)) return decimalString(10 + index * 5);
  if (isCountAlias(alias)) return 10 + index * 3;
  if (isNameAlias(alias)) return `${titleCase(columnName)} ${index + 1}`;
  if (isIdAlias(alias)) return `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
  if (isCodeAlias(alias) || groupField) return categoryValue(alias, index, model, columnName, host);
  return `${titleCase(alias)} ${index + 1}`;
}

/** Highest row index referenced by KPI cards, vector bindings or table row selectors. */
function requiredRowIndex(spec: ReportDescriptorSpec): Map<string, number> {
  const required = new Map<string, number>();
  const note = (datasetId: string, index: number): void => {
    required.set(datasetId, Math.max(required.get(datasetId) ?? 0, index));
  };
  for (const section of spec.sections) {
    if (section.section_type === "KPI_GRID") {
      for (const card of section.cards) note(card.dataset_id, card.row_index);
    } else if (section.section_type === "VECTOR_DRAW") {
      for (const node of section.nodes) {
        if (node.value_binding) note(node.value_binding.dataset_id, node.value_binding.row_index);
      }
    }
  }
  return required;
}

function applyWindowFields(
  rows: Array<Record<string, unknown>>,
  ds: ReportDescriptorSpec["datasets"][number],
): void {
  for (const window of ds.window_fields) {
    const partitions = new Map<string, Array<{ row: Record<string, unknown>; index: number }>>();
    const orderFields = window.order_by.length > 0 ? window.order_by : [{ field: window.target_field, direction: "ASC" as const }];
    rows.forEach((row, index) => {
      const key = window.partition_by.map((field) => String(row[field] ?? "")).join("\u0000");
      const bucket = partitions.get(key) ?? [];
      bucket.push({ row, index });
      partitions.set(key, bucket);
    });
    const total = rows.reduce<Decimal>((sum, row) => sum.plus(new Decimal(String(row[window.target_field] ?? 0) || "0")), new Decimal(0));
    for (const bucket of partitions.values()) {
      const sorted = [...bucket].sort((left, right) => {
        for (const order of orderFields) {
          const leftValue = String(left.row[order.field] ?? "");
          const rightValue = String(right.row[order.field] ?? "");
          const direction = order.direction === "DESC" ? -1 : 1;
          const numeric = Number(leftValue) - Number(rightValue);
          const comparison = Number.isFinite(numeric) && leftValue !== "" && rightValue !== ""
            ? numeric
            : leftValue.localeCompare(rightValue);
          if (comparison !== 0) return comparison * direction;
        }
        return left.index - right.index;
      });
      let running = new Decimal(0);
      sorted.forEach((entry, position) => {
        const value = new Decimal(String(entry.row[window.target_field] ?? 0) || "0");
        running = running.plus(value);
        if (window.window_fn === "RUNNING_SUM") entry.row[window.alias] = running.toFixed();
        else if (window.window_fn === "ROW_NUMBER") entry.row[window.alias] = position + 1;
        else if (window.window_fn === "RANK") entry.row[window.alias] = position + 1;
        else if (window.window_fn === "PERCENT_OF_TOTAL") {
          entry.row[window.alias] = total.isZero() ? "0" : value.dividedBy(total).times(100).toDecimalPlaces(2).toFixed();
        }
      });
    }
  }
}

function mockDatasetRows(
  spec: ReportDescriptorSpec,
  ds: ReportDescriptorSpec["datasets"][number],
  host: ReportEngineHostConfig,
  now: Date,
  minRows: number,
): Array<Record<string, unknown>> {
  const groupFields = new Set(ds.group_by);
  const hasGrouping = ds.group_by.length > 0;
  const baseCount = hasGrouping ? 6 : 8;
  const rowCount = Math.max(1, Math.min(12, Math.max(baseCount, minRows + 1, hasGrouping ? ds.group_by.length * 2 : 0)));
  const rows: Array<Record<string, unknown>> = [];
  for (let index = 0; index < rowCount; index++) {
    const row: Record<string, unknown> = {};
    for (const field of ds.select) {
      const model = modelForAlias(ds, field.table_alias, host);
      row[field.alias] = sampleValue({
        alias: field.alias,
        columnName: field.column,
        expression: field.expression,
        aggregate: field.aggregate,
        formatHint: field.format_hint,
        index,
        model,
        host,
        now,
        groupField: groupFields.has(field.alias),
      });
    }
    rows.push(row);
  }
  if (hasGrouping) {
    // Keep the grouping key distinct when an aggregate shares its alias name.
    const seen = new Set<string>();
    for (const row of rows) {
      while (seen.has(ds.group_by.map((field) => String(row[field] ?? "")).join("\u0000"))) {
        for (const field of ds.group_by) {
          row[field] = `${String(row[field] ?? "")} copy`;
        }
      }
      seen.add(ds.group_by.map((field) => String(row[field] ?? "")).join("\u0000"));
    }
  }
  if (ds.order_by.length > 0) {
    rows.sort((left, right) => {
      for (const order of ds.order_by) {
        const leftValue = left[order.field];
        const rightValue = right[order.field];
        const leftNumber = Number(leftValue);
        const rightNumber = Number(rightValue);
        const comparison =
          Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftValue !== "" && rightValue !== ""
            ? leftNumber - rightNumber
            : String(leftValue ?? "").localeCompare(String(rightValue ?? ""));
        if (comparison !== 0) return order.direction === "DESC" ? -comparison : comparison;
      }
      return 0;
    });
  }
  applyWindowFields(rows, ds);
  return rows.slice(0, Math.min(ds.limit, 12));
}

function comparisonAssetRows(
  spec: ReportDescriptorSpec,
  datasets: DatasetMap,
  host: ReportEngineHostConfig,
  now: Date,
): Record<string, Array<Record<string, unknown>>> {
  const assets: Record<string, Array<Record<string, unknown>>> = {};
  for (const transform of spec.transforms) {
    if (transform.operation !== "COMPARE_WITH_ASSET") continue;
    const rows = datasets[transform.source_dataset_id] ?? [];
    assets[transform.asset_key] = rows.map((row, index) => {
      const assetRow: Record<string, unknown> = {};
      for (const key of transform.match_keys) assetRow[key] = row[key];
      transform.compare_fields.forEach((compare, compareIndex) => {
        const value = Number(row[compare.dataset_field]);
        assetRow[compare.asset_field] = Number.isFinite(value)
          ? value + (index % 3 === 0 ? 0 : index % 2 === 0 ? 5_000 : -7_500)
          : row[compare.dataset_field] ?? `target-${compareIndex + 1}`;
      });
      return assetRow;
    });
  }
  // Declared comparison assets remain populated even when no transform uses
  // them yet, so the preview never silently drops the bundle entry.
  for (const asset of spec.required_assets) {
    if (asset.purpose === "COMPARISON_BASELINE_DATA" && !assets[asset.asset_key]) {
      assets[asset.asset_key] = [{ sample_key: "sample", sample_value: 1 }];
    }
  }
  return assets;
}

function ensureTransformOutputs(
  spec: ReportDescriptorSpec,
  datasets: DatasetMap,
): DatasetMap {
  let working: DatasetMap = { ...datasets };
  for (const transform of spec.transforms) {
    if (transform.operation === "JOIN_DATASETS" && (working[transform.output_dataset_id] ?? []).length === 0) {
      const left = working[transform.left_dataset_id] ?? [];
      const right = working[transform.right_dataset_id] ?? [];
      working[transform.output_dataset_id] = left.map((row, index) => ({ ...(right[index] ?? right[0] ?? {}), ...row }));
      if ((working[transform.output_dataset_id] ?? []).length === 0) {
        working[transform.output_dataset_id] = [{ [transform.on_left_key]: "sample" }];
      }
      working = { ...working };
    }
    if (transform.operation === "PIVOT_DATASET" && (working[transform.output_dataset_id] ?? []).length === 0) {
      working = {
        ...working,
        [transform.output_dataset_id]: [{ [transform.row_key]: "sample", sample: 1 }],
      };
    }
    if (transform.operation === "COMPARE_WITH_ASSET" && (working[transform.output_dataset_id] ?? []).length === 0) {
      working = {
        ...working,
        [transform.output_dataset_id]: (working[transform.source_dataset_id] ?? []).map((row) => ({
          ...row,
          _asset_matched: true,
          _has_discrepancy: false,
          ...Object.fromEntries(
            transform.compare_fields.flatMap((compare) => [
              [`${compare.dataset_field}_expected`, row[compare.dataset_field] ?? null],
              [`${compare.dataset_field}_variance`, "0"],
            ]),
          ),
        })),
      };
    }
  }
  return working;
}

function placeholderAssetDataUrl(assetKey: string, fileName: string): string {
  const palette = ["#0F766E", "#2563EB", "#7C3AED", "#DB2777", "#EA580C"];
  const color = palette[assetKey.length % palette.length] ?? palette[0]!;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="240" viewBox="0 0 640 240" role="img" aria-label="${escapeXml(assetKey)}"><rect width="640" height="240" fill="${color}" opacity="0.12"/><rect x="16" y="16" width="608" height="208" fill="none" stroke="${color}" stroke-width="2" stroke-dasharray="8 6"/><text x="320" y="112" text-anchor="middle" font-family="sans-serif" font-size="28" font-weight="700" fill="${color}">${escapeXml(assetKey)}</text><text x="320" y="150" text-anchor="middle" font-family="sans-serif" font-size="16" fill="${color}">${escapeXml(fileName)}</text></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function buildMockReportBundle(params: {
  spec: ReportDescriptorSpec;
  host: ReportEngineHostConfig;
  locale?: string;
  inputsUsed?: Record<string, unknown>;
  actor?: ReportActorContext | null;
  resolvedHeaderChrome?: ReportChromeSpec | null;
  resolvedFooterChrome?: ReportChromeSpec | null;
  chromeVariables?: Record<string, string>;
  assetDataUrls?: Record<string, string>;
  now?: Date;
}): MockReportBundle {
  const { spec, host } = params;
  const now = params.now ?? new Date();
  const requiredRows = requiredRowIndex(spec);
  const datasets: DatasetMap = {};
  for (const ds of spec.datasets) {
    datasets[ds.dataset_id] = mockDatasetRows(spec, ds, host, now, requiredRows.get(ds.dataset_id) ?? 0);
  }
  const assets = comparisonAssetRows(spec, datasets, host, now);
  const transformed = executeTransformPipeline(datasets, spec.transforms, assets);
  const finalDatasets = ensureTransformOutputs(spec, transformed);

  const assetDataUrls: Record<string, string> = { ...(params.assetDataUrls ?? {}) };
  const collectAssets = (specAssets: ReportDescriptorSpec["required_assets"] | ReportChromeSpec["required_assets"]): void => {
    for (const asset of specAssets) {
      if (assetDataUrls[asset.asset_key]) continue;
      const mimeType = "mime_type" in asset ? asset.mime_type : undefined;
      if (mimeType?.startsWith("image/")) {
        assetDataUrls[asset.asset_key] = placeholderAssetDataUrl(asset.asset_key, asset.file_name);
      }
    }
  };
  collectAssets(spec.required_assets);
  if (params.resolvedHeaderChrome) collectAssets(params.resolvedHeaderChrome.required_assets);
  if (params.resolvedFooterChrome) collectAssets(params.resolvedFooterChrome.required_assets);

  const rowCountTotal = Object.values(finalDatasets).reduce((sum, rows) => sum + rows.length, 0);
  const inputsUsed =
    params.inputsUsed ??
    Object.fromEntries(
      spec.inputs.map((input) => {
        if (input.default_value !== undefined && typeof input.default_value !== "object") {
          return [input.key, input.default_value];
        }
        if (input.type === "daterange") {
          return [input.key, { start: now.toISOString().slice(0, 10), end: now.toISOString().slice(0, 10) }];
        }
        if (input.type === "boolean") return [input.key, true];
        if (input.type === "amount_minor" || input.type === "integer" || input.type === "number") return [input.key, 1];
        if (input.type === "multi_enum" || input.type === "entity_multi_autocomplete") {
          return [input.key, [input.validation?.enum_values?.[0] ?? "SAMPLE"]];
        }
        if (input.type === "enum") return [input.key, input.validation?.enum_values?.[0] ?? "SAMPLE"];
        if (input.autocomplete?.source === "currencies") return [input.key, host.defaultCurrency];
        return [input.key, "sample"];
      }),
    );

  const chromeVariables: Record<string, string> = { ...(params.chromeVariables ?? {}) };
  const periodRange = Object.values(inputsUsed).find(
    (value): value is { start: string; end: string } =>
      Boolean(value) &&
      typeof value === "object" &&
      "start" in (value as Record<string, unknown>) &&
      "end" in (value as Record<string, unknown>) &&
      typeof (value as { start?: unknown }).start === "string" &&
      typeof (value as { end?: unknown }).end === "string",
  );
  if (periodRange) {
    chromeVariables.periodSummary = `${periodRange.start.slice(0, 10)} – ${periodRange.end.slice(0, 10)}`;
  }

  return {
    executionId: `mock-preview-${Date.now().toString(36)}`,
    executedAtIso: now.toISOString(),
    verificationSha256: "mock-preview-data",
    spec,
    resolvedHeaderChrome: params.resolvedHeaderChrome ?? null,
    resolvedFooterChrome: params.resolvedFooterChrome ?? null,
    datasets: finalDatasets,
    assetDataUrls,
    actor: {
      name: params.actor?.email ? String(params.actor.email).split("@")[0]! : "Preview Author",
      email: params.actor?.email ?? "preview@example.test",
      role: params.actor?.role ?? "REPORT_AUTHOR",
    },
    institutionName: host.institutionName,
    chromeVariables,
    engineVersion: REPORT_ENGINE_VERSION,
    reportSpecVersion: REPORT_SPEC_VERSION,
    currency: host.defaultCurrency,
    inputsUsed,
    rowCountTotal,
    durationMs: 0,
    servedByNode: "mock-preview",
    previewMode: "MOCK",
  };
}

/** Render-time helper: every section type must have a visible representation in a mock preview. */
export function sectionHasRenderableContent(section: ReportSectionSpec): boolean {
  return ["KPI_GRID", "DATA_TABLE", "CHART", "VECTOR_DRAW", "HTML_TEMPLATE", "IMAGE_BANNER"].includes(section.section_type);
}
