import type { CatalogModelDef, ReportEngineHostConfig } from "../types/hostConfig";
import type { ReportDescriptorSpec, WhereFilterNode } from "../types/reportSpec";
import type { ReportDiagnostic } from "../types/diagnostics";
import { MERCHANT_REPORT_AUTOCOMPLETE_SOURCE_KEYS } from "../types/reportSpec";

const MERCHANT_SAFE_AUTOCOMPLETE = new Set(["merchants", ...MERCHANT_REPORT_AUTOCOMPLETE_SOURCE_KEYS]);

function aliasOf(alias: string | undefined, fallback: string): string {
  return alias ?? fallback;
}

function hasPredicate(
  where: WhereFilterNode | undefined,
  column: string,
  ds: ReportDescriptorSpec["datasets"][number],
  alias: string,
  inputKey: string,
): boolean {
  if (!where) return false;
  if (where.kind === "PREDICATE") {
    return (
      where.column === column &&
      aliasOf(where.table_alias, ds.from_alias) === alias &&
      where.op === "eq" &&
      where.binding?.source === "INPUT" &&
      where.binding.input_key === inputKey
    );
  }
  // An OR branch that lacks the predicate would let a merchant escape its
  // scope, so every OR branch must carry the predicate.
  return where.logic === "AND"
    ? where.conditions.some((child) => hasPredicate(child, column, ds, alias, inputKey))
    : where.conditions.every((child) => hasPredicate(child, column, ds, alias, inputKey));
}

/**
 * A report may be published as MERCHANT_FACING/BOTH only when every model it
 * touches is merchant-scoped by the forced merchant input. The merchant API
 * also calls this at execution time, so a legacy row cannot bypass it.
 */
export function validateMerchantReportScope(
  spec: ReportDescriptorSpec,
  host: ReportEngineHostConfig,
): ReportDiagnostic[] {
  const diagnostics: ReportDiagnostic[] = [];
  if (spec.report.audience_scope !== "MERCHANT_FACING" && spec.report.audience_scope !== "BOTH") {
    return diagnostics;
  }

  const scopeKey = spec.report.merchant_scope_input_key;
  const scopeInput = scopeKey ? spec.inputs.find((input) => input.key === scopeKey) : undefined;
  if (!scopeKey || !scopeInput) {
    diagnostics.push({
      layer: 2,
      severity: "error",
      path: "report.merchant_scope_input_key",
      code: "MERCHANT_SCOPE_INPUT_MISSING",
      message: "A merchant-facing report must declare report.merchant_scope_input_key.",
      aiFixHint: 'Add an entity_autocomplete input bound to the "merchants" source and name it here.',
    });
    return diagnostics;
  }
  if (scopeInput.type !== "entity_autocomplete" || scopeInput.autocomplete?.source !== "merchants") {
    diagnostics.push({
      layer: 2,
      severity: "error",
      path: `inputs(${scopeInput.key})`,
      code: "MERCHANT_SCOPE_INPUT_INVALID",
      message: "The merchant scope input must be an entity_autocomplete bound to the merchants source.",
      aiFixHint: 'Use type "entity_autocomplete" with autocomplete.source "merchants".',
    });
  }

  for (let i = 0; i < spec.inputs.length; i++) {
    const input = spec.inputs[i]!;
    if (input.autocomplete?.source === "merchants" && input.key !== scopeKey) {
      diagnostics.push({
        layer: 2,
        severity: "error",
        path: `inputs[${i}].autocomplete.source`,
        code: "MERCHANT_EXTRA_MERCHANT_INPUT_FORBIDDEN",
        message: `Only the merchant scope input "${scopeKey}" may use the merchants autocomplete source.`,
        aiFixHint: "Remove the extra merchant input or make the report back-office only.",
      });
    }
    if (input.autocomplete && !MERCHANT_SAFE_AUTOCOMPLETE.has(input.autocomplete.source)) {
      diagnostics.push({
        layer: 2,
        severity: "error",
        path: `inputs[${i}].autocomplete.source`,
        code: "MERCHANT_AUTOCOMPLETE_SOURCE_NOT_ALLOWED",
        message: `Autocomplete source "${input.autocomplete.source}" is not available to a merchant-facing report.`,
        aiFixHint: "Use the merchant scope input or one of the merchant autocomplete sources listed in the transcript.",
      });
    }
  }

  for (let i = 0; i < spec.datasets.length; i++) {
    const ds = spec.datasets[i]!;
    const basePath = `datasets[${i}](${ds.dataset_id})`;
    const models: Array<{ alias: string; model: CatalogModelDef | undefined }> = [
      { alias: ds.from_alias, model: host.models[ds.from_model] },
      ...ds.joins.map((join) => ({ alias: join.alias, model: host.models[join.target_model] })),
    ];
    for (const entry of models) {
      if (!entry.model) {
        diagnostics.push({
          layer: 2,
          severity: "error",
          path: `${basePath}.from_model`,
          code: "UNKNOWN_MODEL",
          message: `Model "${ds.from_model}" or a joined model does not exist in the report catalog.`,
          aiFixHint: "Use only models listed in the transcript.",
        });
        continue;
      }
      if (entry.model.domain === "COMPLIANCE_AML" || entry.model.domain === "SECURITY_AUDIT" || entry.model.domain === "GATEWAYS") {
        diagnostics.push({
          layer: 2,
          severity: "error",
          path: `${basePath}.from_model`,
          code: "MERCHANT_CONFIDENTIAL_DOMAIN_FORBIDDEN",
          message: `Model "${entry.model.modelName}" belongs to ${entry.model.domain} and cannot appear in a merchant-facing report.`,
          aiFixHint: "Remove the model or make the report back-office only.",
        });
        continue;
      }
      if (!entry.model.merchantScopable) {
        diagnostics.push({
          layer: 2,
          severity: "error",
          path: `${basePath}.from_model`,
          code: "MERCHANT_MODEL_OUT_OF_SCOPE",
          message: `Model "${entry.model.modelName}" is not merchant-scopable and cannot appear in a merchant-facing report.`,
          aiFixHint: "Remove the model or split the report into a back-office report.",
        });
        continue;
      }
      if (!hasPredicate(ds.where, entry.model.merchantScopable.merchantIdColumn, ds, entry.alias, scopeKey)) {
        diagnostics.push({
          layer: 2,
          severity: "error",
          path: `${basePath}.where`,
          code: "MERCHANT_ISOLATION_FILTER_MISSING",
          message: `Dataset "${ds.dataset_id}" queries merchant-scopable model "${entry.model.modelName}" without filtering "${entry.model.merchantScopable.merchantIdColumn}" by "${scopeKey}".`,
          aiFixHint: `Add an equality predicate on "${entry.model.merchantScopable.merchantIdColumn}" bound to input "${scopeKey}".`,
        });
      }
    }
  }

  return diagnostics;
}
