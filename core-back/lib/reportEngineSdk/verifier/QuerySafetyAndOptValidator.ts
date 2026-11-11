import type { CatalogModelDef, ReportEngineHostConfig } from "../types/hostConfig";
import type {
  DatasetQuerySpec,
  DatasetSelectField,
  ReportDescriptorSpec,
  ReportInputFieldSpec,
  WhereFilterNode,
} from "../types/reportSpec";
import type { ReportDiagnostic } from "../types/diagnostics";
import { compileDatasetQueryToSql, isMinorUnitColumn } from "../compiler/QueryAstToSqlCompiler";
import { resolveInputPresetValue } from "../compiler/InputFormZodCompiler";
import { isReportableModel } from "../transcript/reportableModels";

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
        : "00000000-0000-4000-8000-000000000000";
    case "entity_multi_autocomplete":
      return ["00000000-0000-4000-8000-000000000000"];
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

/** Points at the join alias when the column exists on a joined model, not the base model. */
function joinedColumnHint(
  ds: DatasetQuerySpec,
  column: string,
  host: ReportEngineHostConfig,
): string {
  const joined = ds.joins.find((join) => host.models[join.target_model]?.columns[column]);
  if (joined) {
    return ` Column "${column}" exists on joined model "${joined.target_model}"; set "table_alias": "${joined.alias}" on this clause.`;
  }
  const base = host.models[ds.from_model];
  for (const relation of Object.values(base?.relations ?? {})) {
    const target = host.models[relation.targetModel];
    if (!target?.columns[column]) continue;
    return ` Column "${column}" does not exist on "${ds.from_model}" but exists on related model "${relation.targetModel}". Add a join through relation "${relation.name}" (unique alias) and set that alias as "table_alias".`;
  }
  return "";
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
      aiFixHint: `Use one of the documented columns for model "${model.modelName}".${joinedColumnHint(ds, node.column, host)}`,
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
    const maxDays = model.optimizationRule.mandatoryFilterColumns?.find(
      (mandatory) => mandatory.column === node.column,
    )?.maxDateRangeDays;
    if (pair && maxDays) {
      const days = daysBetween(pair[0], pair[1]);
      if (days !== null && days > maxDays) {
        diagnostics.push({
          layer: 2,
          severity: "error",
          path: `${path}.binding`,
          code: "PARTITION_DATE_RANGE_UNBOUNDED",
          message: `Literal BETWEEN range on "${node.column}" spans ${Math.round(days)} days; the maximum is ${maxDays}.`,
          aiFixHint: `Use a bounded daterange input with validation.max_range_days <= ${maxDays}.`,
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
    } else if (!isReportableModel(target.tableName)) {
      diagnostics.push({
        layer: 2,
        severity: "error",
        path: `${path}.joins[${i}].target_model`,
        code: "MODEL_NOT_REPORTABLE",
        message: `Join target "${join.target_model}" is engine/operational plumbing and is not reportable.`,
        aiFixHint: "Join a business model listed in the transcript catalog.",
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
  if (ds.group_by.length > 0) {
    // With GROUP BY, ORDER BY and window references must be select aliases or
    // grouped expressions; referencing an ungrouped base column compiles to
    // invalid SQL that must be rejected at verification time (A14).
    const grouped = new Set(ds.group_by);
    for (let i = 0; i < ds.order_by.length; i++) {
      const field = ds.order_by[i]!.field;
      if (!selectAliases.has(field) && !grouped.has(field)) {
        diagnostics.push({
          layer: 2,
          severity: "error",
          path: `${path}.order_by[${i}]`,
          code: "GROUPED_ORDER_BY_REQUIRES_ALIAS",
          message: `ORDER BY "${field}" is not a select alias or grouped column, so the grouped query would be invalid.`,
          aiFixHint: "Order by a select alias or add the column to group_by.",
        });
      }
    }
    for (let i = 0; i < ds.window_fields.length; i++) {
      const window = ds.window_fields[i]!;
      for (const field of [
        window.target_field,
        ...window.partition_by,
        ...window.order_by.map((o) => o.field),
      ]) {
        if (!selectAliases.has(field) && !grouped.has(field)) {
          diagnostics.push({
            layer: 2,
            severity: "error",
            path: `${path}.window_fields[${i}]`,
            code: "GROUPED_WINDOW_REQUIRES_ALIAS",
            message: `Window field "${field}" is not a select alias or grouped column, so the grouped query would be invalid.`,
            aiFixHint: "Use a select alias or a grouped column in the window definition.",
          });
        }
      }
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

/** Predicates on `column` under the top-level AND chain (OR branches do not count). */
function predicatesInAnd(
  where: WhereFilterNode | undefined,
  column: string,
  ds: DatasetQuerySpec,
  alias: string,
): Array<Extract<WhereFilterNode, { kind: "PREDICATE" }>> {
  if (!where) return [];
  if (where.kind === "PREDICATE") {
    return where.column === column && aliasOf(ds, where.table_alias) === alias ? [where] : [];
  }
  return where.logic === "AND"
    ? where.conditions.flatMap((child) => predicatesInAnd(child, column, ds, alias))
    : [];
}

/** Every predicate under the top-level AND chain, regardless of column. */
function collectPredicatesInAnd(
  where: WhereFilterNode | undefined,
): Array<Extract<WhereFilterNode, { kind: "PREDICATE" }>> {
  if (!where) return [];
  if (where.kind === "PREDICATE") return [where];
  return where.logic === "AND"
    ? where.conditions.flatMap((child) => collectPredicatesInAnd(child))
    : [];
}

function validateMandatoryInputBounds(
  inputKey: string,
  column: string,
  maxDays: number,
  inputByKey: Map<string, ReportInputFieldSpec>,
  diagnostics: ReportDiagnostic[],
): void {
  const input = inputByKey.get(inputKey);
  if (input && !input.required && input.default_value === undefined) {
    diagnostics.push({
      layer: 2,
      severity: "error",
      path: `inputs(${inputKey})`,
      code: "MANDATORY_FILTER_INPUT_NOT_REQUIRED",
      message: `Input "${inputKey}" bounds mandatory column "${column}" but is optional with no default.`,
      aiFixHint: "Make the input required or give it a default value.",
    });
  }
  if (!input?.validation?.max_range_days || input.validation.max_range_days > maxDays) {
    diagnostics.push({
      layer: 2,
      severity: "error",
      path: `inputs(${inputKey}).validation.max_range_days`,
      code: "PARTITION_DATE_RANGE_UNBOUNDED",
      message: `Input "${inputKey}" filters partitioned column "${column}" and must set validation.max_range_days <= ${maxDays}.`,
      aiFixHint: `Set "validation": { "max_range_days": ${maxDays} } on input "${inputKey}".`,
    });
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
    if (!isReportableModel(model.tableName)) {
      diagnostics.push({
        layer: 2,
        severity: "error",
        path: `${basePath}.from_model`,
        code: "MODEL_NOT_REPORTABLE",
        message: `Model "${ds.from_model}" is engine/operational plumbing and is not reportable.`,
        aiFixHint: "Use a business model listed in the transcript catalog.",
      });
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
          aiFixHint: `Select only documented columns for model "${targetModel?.modelName ?? ds.from_model}".${joinedColumnHint(ds, sel.column, host)}`,
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
      if (sel.expression === "AGE_DAYS" && col.type !== "datetime") {
        diagnostics.push({
          layer: 2,
          severity: "error",
          path: `${basePath}.select.${sel.alias}`,
          code: "AGE_DAYS_REQUIRES_DATETIME",
          message: `AGE_DAYS is only valid on a datetime column; "${sel.column}" is ${col.type}.`,
          aiFixHint: "Use AGE_DAYS on a timestamp column such as created_at or updated_at.",
        });
      }
      const aggregatesTimestamp =
        (sel.aggregate === "SUM" || sel.aggregate === "AVG") &&
        col.type === "datetime" &&
        sel.expression !== "AGE_DAYS" &&
        sel.expression !== "CASE_WHEN_ENUM";
      const aggregatesNonNumeric =
        (sel.aggregate === "SUM" || sel.aggregate === "AVG") &&
        sel.expression !== "CASE_WHEN_ENUM" &&
        sel.expression !== "AGE_DAYS" &&
        ["string", "enum", "boolean", "json", "uuid", "datetime"].includes(col.type);
      if (aggregatesTimestamp) {
        diagnostics.push({
          layer: 2,
          severity: "error",
          path: `${basePath}.select.${sel.alias}`,
          code: "AGGREGATE_REQUIRES_NUMERIC",
          message: `${sel.aggregate} cannot be applied directly to datetime column "${sel.column}".`,
          aiFixHint: "Use expression AGE_DAYS on the datetime column before AVG/SUM, or aggregate a numeric column.",
        });
      } else if (aggregatesNonNumeric) {
        diagnostics.push({
          layer: 2,
          severity: "error",
          path: `${basePath}.select.${sel.alias}`,
          code: "AGGREGATE_REQUIRES_NUMERIC",
          message: `${sel.aggregate} cannot be applied to ${col.type} column "${sel.column}".`,
          aiFixHint: "Aggregate a numeric column, or use CASE_WHEN_ENUM with numeric case_map values to count categories.",
        });
      }
      if (sel.expression === "MINOR_TO_MAJOR_DECIMAL" && !isMinorUnitColumn(col)) {
        diagnostics.push({
          layer: 2,
          severity: "error",
          path: `${basePath}.select.${sel.alias}`,
          code: "MINOR_TO_MAJOR_REQUIRES_MINOR_COLUMN",
          message: `MINOR_TO_MAJOR_DECIMAL is only valid on a minor-unit column; "${sel.column}" is a major-unit column.`,
          aiFixHint: "Remove the conversion (the column is already in major units) or select its synthetic _minor column.",
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
          if (
            input.autocomplete &&
            !["merchants", "applications", "currencies", "payment_links", "pos_terminals"].includes(
              input.autocomplete.source,
            )
          ) {
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
      }
    }

    if (model.optimizationRule.requireIndexedFilter) {
      const predicates = collectPredicatesInAnd(ds.where);
      const indexed = predicates.some((pred) => {
        const target = resolveAliasModel(ds, pred.table_alias, host);
        return Boolean(target?.columns[pred.column]?.indexed);
      });
      if (!indexed) {
        diagnostics.push({
          layer: 2,
          severity: "error",
          path: `${basePath}.where`,
          code: "INDEXED_FILTER_REQUIRED",
          message: `Query on "${ds.from_model}" must include at least one indexed-column predicate.`,
          aiFixHint: "Filter on an indexed column such as an id, status, merchant_id or created_at.",
        });
      }
    }

    for (const mandatory of model.optimizationRule.mandatoryFilterColumns ?? []) {
      const foundPredicates = predicatesInAnd(ds.where, mandatory.column, ds, ds.from_alias);
      const allowedOps = mandatory.allowedOperators ?? ["between", "gte_lte"];
      if (foundPredicates.length === 0) {
        diagnostics.push({
          layer: 2,
          severity: "error",
          path: `${basePath}.where`,
          code: "MANDATORY_PARTITION_FILTER_MISSING",
          message: `Query on "${ds.from_model}" MUST filter on "${mandatory.column}" (${mandatory.rationale}).`,
          aiFixHint: mandatory.aiFixHint,
        });
        continue;
      }

      for (const pred of foundPredicates) {
        if (pred.binding?.source === "INPUT" && pred.binding.omit_if_empty) {
          diagnostics.push({
            layer: 2,
            severity: "error",
            path: `${basePath}.where`,
            code: "MANDATORY_FILTER_OPTIONAL_BINDING",
            message: `The mandatory filter on "${mandatory.column}" uses binding.omit_if_empty, so the predicate can disappear at runtime.`,
            aiFixHint: "Remove omit_if_empty from a mandatory partition filter.",
          });
        }
        const operatorKey: string = pred.op === "between"
          ? "between"
          : ["gte", "gt", "lte", "lt"].includes(pred.op)
            ? "gte_lte"
            : pred.op;
        if (!(allowedOps as readonly string[]).includes(operatorKey)) {
          diagnostics.push({
            layer: 2,
            severity: "error",
            path: `${basePath}.where`,
            code: "MANDATORY_FILTER_OPERATOR_NOT_ALLOWED",
            message: `Operator "${pred.op}" on mandatory column "${mandatory.column}" is not allowed (${allowedOps.join(", ")}).`,
            aiFixHint: mandatory.aiFixHint,
          });
        }
      }

      const between = foundPredicates.find((pred) => pred.op === "between");
      const lower = foundPredicates.find((pred) => pred.op === "gte" || pred.op === "gt");
      const upper = foundPredicates.find((pred) => pred.op === "lte" || pred.op === "lt");
      const pairUsesSameInput =
        lower?.binding?.source === "INPUT" &&
        upper?.binding?.source === "INPUT" &&
        lower.binding.input_key === upper.binding.input_key &&
        lower.binding.range_bound === "START" &&
        upper.binding.range_bound === "END";
      const pairUsesLiterals =
        lower?.binding?.source === "LITERAL" && upper?.binding?.source === "LITERAL";
      if (!between && !pairUsesSameInput && !pairUsesLiterals) {
        diagnostics.push({
          layer: 2,
          severity: "error",
          path: `${basePath}.where`,
          code: "MANDATORY_PARTITION_FILTER_UNBOUNDED",
          message: `The filter on "${mandatory.column}" is not a bounded range. Use op="between" or a gte+lt(e) pair bound to the same required daterange input.`,
          aiFixHint: mandatory.aiFixHint,
        });
        continue;
      }

      const maxDays = mandatory.maxDateRangeDays;
      if (maxDays) {
        if (between?.binding?.source === "INPUT") {
          validateMandatoryInputBounds(between.binding.input_key, mandatory.column, maxDays, inputByKey, diagnostics);
        } else if (between?.binding?.source === "LITERAL") {
          const value = between.binding.value;
          const pair = Array.isArray(value) && value.length === 2
            ? value
            : value && typeof value === "object" && "start" in value && "end" in value
              ? [(value as { start: unknown }).start, (value as { end: unknown }).end]
              : null;
          const days = pair ? daysBetween(pair[0], pair[1]) : null;
          if (days !== null && days > maxDays) {
            diagnostics.push({
              layer: 2,
              severity: "error",
              path: `${basePath}.where`,
              code: "PARTITION_DATE_RANGE_UNBOUNDED",
              message: `Literal range on "${mandatory.column}" spans ${Math.round(days)} days; the maximum is ${maxDays}.`,
              aiFixHint: mandatory.aiFixHint,
            });
          }
        } else if (pairUsesSameInput && lower?.binding?.source === "INPUT") {
          validateMandatoryInputBounds(lower.binding.input_key, mandatory.column, maxDays, inputByKey, diagnostics);
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
          // A bounded range on a single partition can legitimately choose a
          // cheap sequential scan. Only reject scans whose estimated cost is
          // above the configured cap; otherwise valid specs fail forever.
          const maxSeqScanCost = host.globalLimits.maxSeqScanCost ?? 10_000;
          const scans = explain.seqScans ?? [];
          const offending = scans.length > 0
            ? scans.filter((scan) => scan.largeTable === true && scan.totalCost >= maxSeqScanCost)
            : [
                {
                  table: explain.seqScanTables.join(", ") || "large table",
                  parentTable: null,
                  totalCost: explain.totalCost,
                  planRows: explain.planRows,
                },
              ];
          if (offending.length > 0) {
            diagnostics.push({
              layer: 2,
              severity: "error",
              path: basePath,
              code: "SEQUENTIAL_SCAN_DETECTED",
              message: `EXPLAIN detected a costly sequential scan on large table(s): ${offending
                .map((scan) => `${scan.table} (cost ${scan.totalCost.toFixed(0)})`)
                .join(", ")} (cap ${maxSeqScanCost}).`,
              aiFixHint:
                "Add selective indexed WHERE predicates (created_at range, merchant_id, status, or an id) or query pre-aggregated shards instead of scanning raw rows.",
            });
          }
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
