import type { CatalogModelDef, ReportEngineHostConfig } from "../types/hostConfig";
import type {
  DatasetQuerySpec,
  DatasetSelectField,
  ReportDescriptorSpec,
  ReportInputFieldSpec,
  WhereFilterNode,
} from "../types/reportSpec";
import type { ReportDiagnostic } from "../types/diagnostics";
import { compileDatasetQueryToSql } from "../compiler/QueryAstToSqlCompiler";
import { resolveInputPresetValue } from "../compiler/InputFormZodCompiler";

export function synthesizeDefaultInputs(
  spec: ReportDescriptorSpec,
  now: Date = new Date(),
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const field of spec.inputs) {
    const preset = resolveInputPresetValue(field, now);
    if (preset !== undefined) {
      values[field.key] = preset;
      continue;
    }
    values[field.key] = sampleValueForField(field, now);
  }
  return values;
}

function sampleValueForField(field: ReportInputFieldSpec, now: Date): unknown {
  switch (field.type) {
    case "uuid":
    case "entity_autocomplete":
      return field.autocomplete?.source === "currencies"
        ? "LYD"
        : "00000000-0000-0000-0000-000000000000";
    case "entity_multi_autocomplete":
      return ["00000000-0000-0000-0000-000000000000"];
    case "date":
      return now.toISOString().slice(0, 10);
    case "datetime":
      return now.toISOString();
    case "daterange": {
      const end = now.toISOString();
      const start = new Date(now.getTime() - 29 * 24 * 3600 * 1000).toISOString();
      return { start, end };
    }
    case "number":
    case "integer":
      return 1;
    case "amount_minor":
      return 1000;
    case "boolean":
      return true;
    case "enum":
      return field.validation?.enum_values?.[0] ?? "DEFAULT";
    case "multi_enum":
      return [field.validation?.enum_values?.[0] ?? "DEFAULT"];
    case "string":
    default:
      return "sample";
  }
}

function resolveAliasModel(
  ds: DatasetQuerySpec,
  tableAlias: string | undefined,
  host: ReportEngineHostConfig,
): CatalogModelDef | undefined {
  const alias = tableAlias ?? ds.from_alias;
  if (alias === ds.from_alias) return host.models[ds.from_model];
  const join = ds.joins.find((j) => j.alias === alias);
  return join ? host.models[join.target_model] : undefined;
}

function aliasOf(ds: DatasetQuerySpec, tableAlias: string | undefined): string {
  return tableAlias ?? ds.from_alias;
}

function findColumnPredicates(
  where: WhereFilterNode | undefined,
  column: string,
  ds: DatasetQuerySpec,
  alias: string,
): Array<Extract<WhereFilterNode, { kind: "PREDICATE" }>> {
  if (!where) return [];
  if (where.kind === "PREDICATE") {
    return where.column === column && aliasOf(ds, where.table_alias) === alias ? [where] : [];
  }
  return where.conditions.flatMap((child) => findColumnPredicates(child, column, ds, alias));
}

function hasMerchantScopePredicate(
  ds: DatasetQuerySpec,
  model: CatalogModelDef,
  alias: string,
  inputKey: string,
): boolean {
  if (!model.merchantScopable) return false;
  return hasPredicateInAnd(ds.where, model.merchantScopable.merchantIdColumn, ds, alias, inputKey);
}

function hasPredicateInAnd(
  where: WhereFilterNode | undefined,
  column: string,
  ds: DatasetQuerySpec,
  alias: string,
  inputKey: string,
): boolean {
  if (!where) return false;
  if (where.kind === "PREDICATE") {
    return (
      where.column === column &&
      aliasOf(ds, where.table_alias) === alias &&
      where.op === "eq" &&
      where.binding?.source === "INPUT" &&
      where.binding.input_key === inputKey
    );
  }
  return where.logic === "AND"
    ? where.conditions.some((child) => hasPredicateInAnd(child, column, ds, alias, inputKey))
    : where.conditions.every((child) => hasPredicateInAnd(child, column, ds, alias, inputKey));
}

function hasAnyColumnPredicateInAnd(
  where: WhereFilterNode | undefined,
  column: string,
  ds: DatasetQuerySpec,
  alias: string,
): boolean {
  if (!where) return false;
  if (where.kind === "PREDICATE") {
    return where.column === column && aliasOf(ds, where.table_alias) === alias;
  }
  return where.logic === "AND"
    ? where.conditions.some((child) => hasAnyColumnPredicateInAnd(child, column, ds, alias))
    : where.conditions.every((child) => hasAnyColumnPredicateInAnd(child, column, ds, alias));
}

function daysBetween(start: unknown, end: unknown): number | null {
  if (typeof start !== "string" || typeof end !== "string") return null;
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  return (endMs - startMs) / (24 * 3600 * 1000);
}

function validateWhereNode(
  node: WhereFilterNode,
  ds: DatasetQuerySpec,
  host: ReportEngineHostConfig,
  inputByKey: Map<string, ReportInputFieldSpec>,
  path: string,
  diagnostics: ReportDiagnostic[],
): void {
  if (node.kind === "GROUP") {
    node.conditions.forEach((child, index) =>
      validateWhereNode(child, ds, host, inputByKey, `${path}.conditions[${index}]`, diagnostics),
    );
    return;
  }
  const model = resolveAliasModel(ds, node.table_alias, host);
  if (!model) {
    diagnostics.push({
      layer: 2,
      severity: "error",
      path: `${path}.table_alias`,
      code: "UNKNOWN_TABLE_ALIAS",
      message: `Table alias "${aliasOf(ds, node.table_alias)}" is not declared by this dataset.`,
      aiFixHint: "Use the dataset's from_alias or a declared joins[].alias.",
    });
    return;
  }
  const column = model.columns[node.column];
  if (!column) {
    diagnostics.push({
      layer: 2,
      severity: "error",
      path: `${path}.column`,
      code: "UNKNOWN_COLUMN",
      message: `Column "${node.column}" does not exist on model "${model.modelName}".`,
      aiFixHint: `Use one of the documented columns for model "${model.modelName}".`,
    });
    return;
  }
  if (column.sensitivity === "FORBIDDEN_SECRET") {
    diagnostics.push({
      layer: 2,
      severity: "error",
      path: `${path}.column`,
      code: "FORBIDDEN_SECRET_COLUMN",
      message: `Column "${node.column}" is classified as FORBIDDEN_SECRET and can never be used by the Report Engine.`,
      aiFixHint: `Remove "${node.column}" from the query.`,
    });
  }
  if (node.binding?.source === "INPUT") {
    const input = inputByKey.get(node.binding.input_key);
    if (!input) {
      diagnostics.push({
        layer: 2,
        severity: "error",
        path: `${path}.binding.input_key`,
        code: "UNKNOWN_INPUT_BINDING",
        message: `WHERE predicate on "${node.column}" references unknown input "${node.binding.input_key}".`,
        aiFixHint: "Declare the input in inputs[] or bind a LITERAL/CONTEXT value.",
      });
    } else if (node.op === "between" && input.type !== "daterange") {
      diagnostics.push({
        layer: 2,
        severity: "error",
        path: `${path}.binding`,
        code: "BETWEEN_REQUIRES_DATERANGE",
        message: `BETWEEN on "${node.column}" must bind a daterange input.`,
        aiFixHint: `Change input "${input.key}" to type "daterange".`,
      });
    }
  }
  if (node.binding?.source === "LITERAL" && node.op === "between") {
    const value = node.binding.value;
    const pair = Array.isArray(value) && value.length === 2
      ? value
      : value && typeof value === "object" && "start" in value && "end" in value
        ? [(value as { start: unknown }).start, (value as { end: unknown }).end]
        : null;
    if (pair) {
      const days = daysBetween(pair[0], pair[1]);
      if (days !== null && days > 366) {
        diagnostics.push({
          layer: 2,
          severity: "error",
          path: `${path}.binding`,
          code: "PARTITION_DATE_RANGE_UNBOUNDED",
          message: `Literal BETWEEN range on "${node.column}" spans ${Math.round(days)} days; the maximum is 366.`,
          aiFixHint: "Use a bounded daterange input with validation.max_range_days <= 366.",
        });
      }
    }
  }
}

function validateDatasetReferences(
  ds: DatasetQuerySpec,
  host: ReportEngineHostConfig,
  inputByKey: Map<string, ReportInputFieldSpec>,
  path: string,
  diagnostics: ReportDiagnostic[],
): void {
  const model = host.models[ds.from_model];
  if (!model) return;
  const aliases = new Set<string>([ds.from_alias]);
  for (let i = 0; i < ds.joins.length; i++) {
    const join = ds.joins[i]!;
    if (aliases.has(join.alias)) {
      diagnostics.push({
        layer: 2,
        severity: "error",
        path: `${path}.joins[${i}].alias`,
        code: "DUPLICATE_TABLE_ALIAS",
        message: `Join alias "${join.alias}" is used more than once.`,
        aiFixHint: "Give each join a unique alias.",
      });
    }
    aliases.add(join.alias);
    const relation = model.relations[join.relation_name];
    const target = host.models[join.target_model];
    if (!relation || !target || relation.targetModel !== join.target_model) {
      diagnostics.push({
        layer: 2,
        severity: "error",
        path: `${path}.joins[${i}]`,
        code: "INVALID_JOIN_RELATION",
        message: `Relation "${join.relation_name}" does not connect "${ds.from_model}" to "${join.target_model}".`,
        aiFixHint: "Use a relation listed in the transcript for the base model.",
      });
    }
    if (join.additional_on) {
      validateWhereNode(join.additional_on, ds, host, inputByKey, `${path}.joins[${i}].additional_on`, diagnostics);
    }
  }

  if (ds.where) validateWhereNode(ds.where, ds, host, inputByKey, `${path}.where`, diagnostics);

  const selectAliases = new Set(ds.select.map((s) => s.alias));
  const baseModel = host.models[ds.from_model];
  const resolveBaseColumn = (name: string) => baseModel?.columns[name];
  for (let i = 0; i < ds.group_by.length; i++) {
    const group = ds.group_by[i]!;
    if (selectAliases.has(group)) continue;
    if (!resolveBaseColumn(group)) {
      diagnostics.push({
        layer: 2,
        severity: "error",
        path: `${path}.group_by[${i}]`,
        code: "UNKNOWN_COLUMN",
        message: `GROUP BY field "${group}" is neither a select alias nor a base-model column.`,
        aiFixHint: "Group by a selected alias or a base-model column.",
      });
    }
  }
  for (let i = 0; i < ds.order_by.length; i++) {
    const order = ds.order_by[i]!;
    if (selectAliases.has(order.field)) continue;
    if (!resolveBaseColumn(order.field)) {
      diagnostics.push({
        layer: 2,
        severity: "error",
        path: `${path}.order_by[${i}]`,
        code: "UNKNOWN_COLUMN",
        message: `ORDER BY field "${order.field}" is neither a select alias nor a base-model column.`,
        aiFixHint: "Order by a selected alias or a base-model column.",
      });
    }
  }
  for (let i = 0; i < ds.having.length; i++) {
    const having = ds.having[i]!;
    const selected = ds.select.find((s) => s.alias === having.select_alias);
    if (!selected || !selected.aggregate) {
      diagnostics.push({
        layer: 2,
        severity: "error",
        path: `${path}.having[${i}]`,
        code: "INVALID_HAVING_ALIAS",
        message: `HAVING references "${having.select_alias}", which is not an aggregate select alias.`,
        aiFixHint: "Reference an aggregate select alias.",
      });
    }
  }
  for (let i = 0; i < ds.window_fields.length; i++) {
    const window = ds.window_fields[i]!;
    const fields = [
      window.target_field,
      ...window.partition_by,
      ...window.order_by.map((o) => o.field),
    ];
    for (const field of fields) {
      if (!selectAliases.has(field) && !resolveBaseColumn(field)) {
        diagnostics.push({
          layer: 2,
          severity: "error",
          path: `${path}.window_fields[${i}]`,
          code: "UNKNOWN_COLUMN",
          message: `Window field "${field}" is neither a select alias nor a base-model column.`,
          aiFixHint: "Window fields must be selected aliases or base-model columns.",
        });
      }
    }
  }
}

export async function validateQueriesAndOptimizations(
  spec: ReportDescriptorSpec,
  host: ReportEngineHostConfig,
): Promise<ReportDiagnostic[]> {
  const diagnostics: ReportDiagnostic[] = [];
  const inputByKey = new Map(spec.inputs.map((inp) => [inp.key, inp]));

  if (spec.datasets.length > host.globalLimits.maxDatasetsPerReport) {
    diagnostics.push({
      layer: 2,
      severity: "error",
      path: "datasets",
      code: "TOO_MANY_DATASETS",
      message: `Report has ${spec.datasets.length} datasets; the host limit is ${host.globalLimits.maxDatasetsPerReport}.`,
      aiFixHint: "Split the report or reduce the number of datasets.",
    });
  }

  const merchantInputKey = spec.report.merchant_scope_input_key;
  const merchantInput = merchantInputKey ? inputByKey.get(merchantInputKey) : undefined;
  if (
    (spec.report.audience_scope === "MERCHANT_FACING" || spec.report.audience_scope === "BOTH") &&
    (!merchantInputKey || !merchantInput)
  ) {
    diagnostics.push({
      layer: 2,
      severity: "error",
      path: "report.merchant_scope_input_key",
      code: "MERCHANT_SCOPE_INPUT_MISSING",
      message: `Report has audience_scope="${spec.report.audience_scope}" but does not declare a valid report.merchant_scope_input_key.`,
      aiFixHint: `Add an input parameter with autocomplete.source="merchants" and set report.merchant_scope_input_key to that input's key.`,
    });
  } else if (
    merchantInput &&
    (merchantInput.type !== "entity_autocomplete" || merchantInput.autocomplete?.source !== "merchants")
  ) {
    diagnostics.push({
      layer: 2,
      severity: "error",
      path: `inputs(${merchantInput.key})`,
      code: "MERCHANT_SCOPE_INPUT_INVALID",
      message: `The merchant scope input "${merchantInput.key}" must be an entity_autocomplete bound to the merchants source.`,
      aiFixHint: 'Use type "entity_autocomplete" with autocomplete.source "merchants".',
    });
  }

  for (let i = 0; i < spec.datasets.length; i++) {
    const ds = spec.datasets[i]!;
    const basePath = `datasets[${i}](${ds.dataset_id})`;
    const model = host.models[ds.from_model];
    if (!model) {
      diagnostics.push({
        layer: 2,
        severity: "error",
        path: `${basePath}.from_model`,
        code: "UNKNOWN_MODEL",
        message: `Model "${ds.from_model}" does not exist in the report schema catalog.`,
        aiFixHint: `Use one of the allowed models from the transcript catalog: ${Object.keys(host.models).join(", ")}.`,
      });
      continue;
    }
    if (ds.joins.length > host.globalLimits.maxJoinsPerDataset) {
      diagnostics.push({
        layer: 2,
        severity: "error",
        path: `${basePath}.joins`,
        code: "TOO_MANY_JOINS",
        message: `Dataset "${ds.dataset_id}" has ${ds.joins.length} joins; the host limit is ${host.globalLimits.maxJoinsPerDataset}.`,
        aiFixHint: "Reduce the joins or split the dataset.",
      });
    }

    validateDatasetReferences(ds, host, inputByKey, basePath, diagnostics);

    for (const sel of ds.select) {
      if (sel.column === "*" && sel.aggregate === "COUNT") continue;
      const targetModel = resolveAliasModel(ds, sel.table_alias, host);
      const col = targetModel?.columns[sel.column];
      if (!col) {
        diagnostics.push({
          layer: 2,
          severity: "error",
          path: `${basePath}.select.${sel.alias}`,
          code: "UNKNOWN_COLUMN",
          message: `Column "${sel.column}" does not exist on model "${targetModel?.modelName ?? ds.from_model}".`,
          aiFixHint: `Select only documented columns for model "${targetModel?.modelName ?? ds.from_model}".`,
        });
        continue;
      }
      if (col.sensitivity === "FORBIDDEN_SECRET") {
        diagnostics.push({
          layer: 2,
          severity: "error",
          path: `${basePath}.select.${sel.alias}`,
          code: "FORBIDDEN_SECRET_COLUMN",
          message: `Column "${sel.column}" is classified as FORBIDDEN_SECRET and can never be accessed by the Report Engine.`,
          aiFixHint: `Remove "${sel.column}" from the query select list.`,
        });
      }
    }

    if (spec.report.audience_scope === "MERCHANT_FACING" || spec.report.audience_scope === "BOTH") {
      if (merchantInputKey && merchantInput) {
        const aliases = [
          { alias: ds.from_alias, model },
          ...ds.joins.map((join) => ({ alias: join.alias, model: host.models[join.target_model] })),
        ];
        for (const entry of aliases) {
          if (!entry.model) continue;
          if (!entry.model.merchantScopable) {
            diagnostics.push({
              layer: 2,
              severity: "error",
              path: `${basePath}.from_model`,
              code: "MERCHANT_MODEL_OUT_OF_SCOPE",
              message: `Model "${entry.model.modelName}" is not merchant-scopable and cannot be used in a merchant-facing report.`,
              aiFixHint: "Remove the model or split the report into a back-office report.",
            });
            continue;
          }
          if (!hasMerchantScopePredicate(ds, entry.model, entry.alias, merchantInputKey)) {
            diagnostics.push({
              layer: 2,
              severity: "error",
              path: `${basePath}.where`,
              code: "MERCHANT_ISOLATION_FILTER_MISSING",
              message: `Dataset "${ds.dataset_id}" queries merchant-scopable model "${entry.model.modelName}" without filtering "${entry.model.merchantScopable.merchantIdColumn}" by input "${merchantInputKey}".`,
              aiFixHint: `Add a WHERE predicate on "${entry.model.merchantScopable.merchantIdColumn}" with op="eq" bound to input "${merchantInputKey}".`,
            });
          }
        }
        for (let i = 0; i < spec.inputs.length; i++) {
          const input = spec.inputs[i]!;
          if (input.autocomplete && !["merchants", "applications", "currencies"].includes(input.autocomplete.source)) {
            diagnostics.push({
              layer: 2,
              severity: "error",
              path: `inputs[${i}].autocomplete.source`,
              code: "MERCHANT_AUTOCOMPLETE_SOURCE_NOT_ALLOWED",
              message: `Autocomplete source "${input.autocomplete.source}" is not available to a merchant-facing report.`,
              aiFixHint: "Use merchants, applications or currencies, or make the report back-office only.",
            });
          }
        }
      }
    }

    for (const mandatory of model.optimizationRule.mandatoryFilterColumns ?? []) {
      const foundPredicates = findColumnPredicates(ds.where, mandatory.column, ds, ds.from_alias);
      if (!hasAnyColumnPredicateInAnd(ds.where, mandatory.column, ds, ds.from_alias)) {
        diagnostics.push({
          layer: 2,
          severity: "error",
          path: `${basePath}.where`,
          code: "MANDATORY_PARTITION_FILTER_MISSING",
          message: `Query on "${ds.from_model}" MUST filter on "${mandatory.column}" (${mandatory.rationale}).`,
          aiFixHint: mandatory.aiFixHint,
        });
      } else if (mandatory.maxDateRangeDays) {
        for (const pred of foundPredicates) {
          if (pred.binding?.source === "INPUT") {
            const inp = inputByKey.get(pred.binding.input_key);
            if (!inp?.validation?.max_range_days || inp.validation.max_range_days > mandatory.maxDateRangeDays) {
              diagnostics.push({
                layer: 2,
                severity: "error",
                path: `inputs(${pred.binding.input_key}).validation.max_range_days`,
                code: "PARTITION_DATE_RANGE_UNBOUNDED",
                message: `Input "${pred.binding.input_key}" filters partitioned column "${ds.from_model}.${mandatory.column}" and must set validation.max_range_days <= ${mandatory.maxDateRangeDays}.`,
                aiFixHint: `Set "validation": { "max_range_days": ${mandatory.maxDateRangeDays} } on input "${pred.binding.input_key}".`,
              });
            }
          }
        }
      }
    }

    const datasetHasError = diagnostics.some(
      (d) => d.severity === "error" && (d.path === basePath || d.path.startsWith(`${basePath}.`) || d.path === `${basePath}`),
    );
    if (!datasetHasError) {
      const sampleInputs = synthesizeDefaultInputs(spec);
      try {
        const compiled = compileDatasetQueryToSql(ds, host, sampleInputs);
        const explain = await host.dbReadOnlyPort.explainReadOnlyQuery({
          sql: compiled.sql,
          values: compiled.values,
          timeoutMs: 3_000,
        });
        if (explain.totalCost > host.globalLimits.maxExplainCost) {
          diagnostics.push({
            layer: 2,
            severity: "error",
            path: basePath,
            code: "QUERY_COST_EXCEEDED",
            message: `PostgreSQL EXPLAIN estimated cost (${explain.totalCost.toFixed(0)}) exceeds maximum allowed report query cost (${host.globalLimits.maxExplainCost}).`,
            aiFixHint: "Add selective indexed WHERE predicates (such as created_at range, merchant_id, or wallet_id) or query pre-aggregated shards (gl_account_shards) instead of scanning raw rows.",
          });
        }
        if (explain.hasSeqScanOnLargeTable) {
          diagnostics.push({
            layer: 2,
            severity: "warning",
            path: basePath,
            code: "SEQUENTIAL_SCAN_DETECTED",
            message: `EXPLAIN detected sequential scan on table(s): ${explain.seqScanTables.join(", ")}.`,
            aiFixHint: "Ensure WHERE predicates reference indexed columns listed in the transcript catalog.",
          });
        }
      } catch (error) {
        diagnostics.push({
          layer: 2,
          severity: "error",
          path: basePath,
          code: "QUERY_COMPILATION_FAILED",
          message: `The dataset could not be compiled or explained: ${(error as Error).message}`,
          aiFixHint: "Check every model, alias, column, relation and binding against the transcript.",
        });
      }
    }
  }

  return diagnostics;
}
