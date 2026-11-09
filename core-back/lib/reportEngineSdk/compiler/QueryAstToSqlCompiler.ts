import type { CatalogModelDef, ReportEngineHostConfig } from "../types/hostConfig";
import type {
  DatasetQuerySpec,
  DatasetSelectField,
  WhereFilterNode,
} from "../types/reportSpec";

export interface CompiledSqlQuery {
  sql: string;
  values: unknown[];
}

const quoteIdent = (ident: string): string => {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(ident)) {
    throw new Error(`UNSAFE_SQL_IDENTIFIER: "${ident}"`);
  }
  return `"${ident}"`;
};

export function compileDatasetQueryToSql(
  ds: DatasetQuerySpec,
  host: ReportEngineHostConfig,
  resolvedInputs: Record<string, unknown>,
  actorContext?: { userId: string; nowUtcIso: string },
): CompiledSqlQuery {
  const values: unknown[] = [];
  const pushParam = (val: unknown): string => {
    values.push(val);
    return `$${values.length}`;
  };

  const baseModel = host.models[ds.from_model];
  if (!baseModel) {
    throw new Error(`UNKNOWN_MODEL: "${ds.from_model}"`);
  }

  const aliasToModel = new Map<string, CatalogModelDef>();
  aliasToModel.set(ds.from_alias, baseModel);

  const joinClauses: string[] = [];
  for (const j of ds.joins) {
    const rel = baseModel.relations[j.relation_name];
    const targetModel = host.models[j.target_model];
    if (!rel || !targetModel || rel.targetModel !== j.target_model) {
      throw new Error(`INVALID_JOIN_RELATION: "${j.relation_name}" -> "${j.target_model}"`);
    }
    aliasToModel.set(j.alias, targetModel);
    const sourceCol = baseModel.columns[rel.sourceKey]?.dbColumnName ?? rel.sourceKey;
    const targetCol = targetModel.columns[rel.targetKey]?.dbColumnName ?? rel.targetKey;
    let onSql = `${quoteIdent(ds.from_alias)}.${quoteIdent(sourceCol)} = ${quoteIdent(j.alias)}.${quoteIdent(targetCol)}`;
    if (j.additional_on) {
      const extraOn = compileWhereNode(j.additional_on);
      if (extraOn) onSql = `(${onSql}) AND (${extraOn})`;
    }
    joinClauses.push(
      `${j.join_type} JOIN ${quoteIdent(targetModel.tableName)} AS ${quoteIdent(j.alias)} ON ${onSql}`,
    );
  }

  const resolveColumnSql = (tableAlias: string | undefined, colName: string): string => {
    const alias = tableAlias ?? ds.from_alias;
    const model = aliasToModel.get(alias);
    if (!model) throw new Error(`UNKNOWN_TABLE_ALIAS: "${alias}"`);
    const col = model.columns[colName];
    if (!col) throw new Error(`UNKNOWN_COLUMN: "${alias}.${colName}"`);
    if (col.sensitivity === "FORBIDDEN_SECRET") {
      throw new Error(`FORBIDDEN_SECRET_COLUMN: "${alias}.${colName}"`);
    }
    const raw = `${quoteIdent(alias)}.${quoteIdent(col.dbColumnName)}`;
    if (col.minorUnitScale && col.minorUnitScale !== 1) {
      return `ROUND((${raw}::numeric * ${col.minorUnitScale}))`;
    }
    return raw;
  };

  const compileScalarExpr = (sel: DatasetSelectField): string => {
    const colSql = resolveColumnSql(sel.table_alias, sel.column);
    switch (sel.expression) {
      case "COLUMN":
        return colSql;
      case "COALESCE_ZERO":
        return `COALESCE(${colSql}, 0)`;
      case "DATE_TRUNC_HOUR":
        return `date_trunc('hour', ${colSql})`;
      case "DATE_TRUNC_DAY":
        return `date_trunc('day', ${colSql})`;
      case "DATE_TRUNC_WEEK":
        return `date_trunc('week', ${colSql})`;
      case "DATE_TRUNC_MONTH":
        return `date_trunc('month', ${colSql})`;
      case "MINOR_TO_MAJOR_DECIMAL": {
        const scale = sel.table_alias
          ? aliasToModel.get(sel.table_alias)?.columns[sel.column]?.minorUnitScale
          : baseModel.columns[sel.column]?.minorUnitScale;
        return `ROUND((${colSql}::numeric / ${scale ?? 1000}.0), 3)`;
      }
      case "SIGNED_JOURNAL_AMOUNT": {
        const dirSql = resolveColumnSql(sel.table_alias, "direction");
        return `CASE WHEN ${dirSql} = 'DEBIT' THEN ${colSql} ELSE -(${colSql}) END`;
      }
      case "CASE_WHEN_ENUM": {
        const entries = Object.entries(sel.case_map ?? {});
        if (entries.length === 0) return colSql;
        const branches = entries
          .map(([k, v]) => `WHEN ${colSql} = ${pushParam(k)} THEN ${pushParam(v)}`)
          .join(" ");
        return `CASE ${branches} ELSE NULL END`;
      }
    }
  };

  const compileSelectField = (sel: DatasetSelectField): string => {
    if (sel.column === "*" && sel.aggregate === "COUNT") {
      return `COUNT(*)::bigint AS ${quoteIdent(sel.alias)}`;
    }
    const inner = compileScalarExpr(sel);
    if (!sel.aggregate) {
      return `${inner} AS ${quoteIdent(sel.alias)}`;
    }
    switch (sel.aggregate) {
      case "COUNT":
        return `COUNT(${inner})::bigint AS ${quoteIdent(sel.alias)}`;
      case "COUNT_DISTINCT":
        return `COUNT(DISTINCT ${inner})::bigint AS ${quoteIdent(sel.alias)}`;
      case "SUM":
        return `COALESCE(SUM(${inner}), 0) AS ${quoteIdent(sel.alias)}`;
      case "AVG":
        return `COALESCE(AVG(${inner}), 0) AS ${quoteIdent(sel.alias)}`;
      case "MIN":
        return `MIN(${inner}) AS ${quoteIdent(sel.alias)}`;
      case "MAX":
        return `MAX(${inner}) AS ${quoteIdent(sel.alias)}`;
      case "SUM_DEBIT_MINOR": {
        const dirSql = resolveColumnSql(sel.table_alias, "direction");
        return `COALESCE(SUM(CASE WHEN ${dirSql} = 'DEBIT' THEN ${inner} ELSE 0 END), 0) AS ${quoteIdent(sel.alias)}`;
      }
      case "SUM_CREDIT_MINOR": {
        const dirSql = resolveColumnSql(sel.table_alias, "direction");
        return `COALESCE(SUM(CASE WHEN ${dirSql} = 'CREDIT' THEN ${inner} ELSE 0 END), 0) AS ${quoteIdent(sel.alias)}`;
      }
    }
  };

  function resolveBindingValue(
    binding: NonNullable<Extract<WhereFilterNode, { kind: "PREDICATE" }>["binding"]>,
  ): { omit: boolean; value: unknown } {
    if (binding.source === "LITERAL") {
      return { omit: false, value: binding.value };
    }
    if (binding.source === "CONTEXT") {
      const nowIso = actorContext?.nowUtcIso ?? new Date().toISOString();
      switch (binding.context_key) {
        case "ACTOR_USER_ID":
          return { omit: false, value: actorContext?.userId ?? "00000000-0000-0000-0000-000000000000" };
        case "NOW_UTC":
          return { omit: false, value: nowIso };
        case "TODAY_START_UTC":
          return { omit: false, value: `${nowIso.slice(0, 10)}T00:00:00.000Z` };
        case "DEFAULT_CURRENCY":
          return { omit: false, value: host.defaultCurrency };
      }
    }
    const raw = resolvedInputs[binding.input_key];
    if (raw === undefined || raw === null || raw === "") {
      if (binding.omit_if_empty) return { omit: true, value: null };
      throw new Error(`MISSING_REQUIRED_INPUT_BINDING: "${binding.input_key}"`);
    }
    if (
      binding.range_bound &&
      typeof raw === "object" &&
      raw !== null &&
      "start" in raw &&
      "end" in raw
    ) {
      const rangeObj = raw as { start: string; end: string };
      if (binding.range_bound === "START") return { omit: false, value: rangeObj.start };
      if (binding.range_bound === "END") return { omit: false, value: rangeObj.end };
      return { omit: false, value: [rangeObj.start, rangeObj.end] };
    }
    return { omit: false, value: raw };
  }

  function compileWhereNode(node: WhereFilterNode): string | null {
    if (node.kind === "GROUP") {
      const compiledChildren = node.conditions
        .map((c) => compileWhereNode(c))
        .filter((s): s is string => Boolean(s));
      if (compiledChildren.length === 0) return null;
      return compiledChildren.map((c) => `(${c})`).join(` ${node.logic} `);
    }

    const colSql = resolveColumnSql(node.table_alias, node.column);
    if (node.op === "is_null") return `${colSql} IS NULL`;
    if (node.op === "is_not_null") return `${colSql} IS NOT NULL`;
    if (!node.binding) throw new Error(`MISSING_WHERE_BINDING: "${node.column}" (${node.op})`);

    const resolved = resolveBindingValue(node.binding);
    if (resolved.omit) return null;

    switch (node.op) {
      case "eq":
        return `${colSql} = ${pushParam(resolved.value)}`;
      case "neq":
        return `${colSql} <> ${pushParam(resolved.value)}`;
      case "gt":
        return `${colSql} > ${pushParam(resolved.value)}`;
      case "gte":
        return `${colSql} >= ${pushParam(resolved.value)}`;
      case "lt":
        return `${colSql} < ${pushParam(resolved.value)}`;
      case "lte":
        return `${colSql} <= ${pushParam(resolved.value)}`;
      case "ilike_prefix":
        return `${colSql} ILIKE ${pushParam(`${String(resolved.value).replace(/[%_]/g, "")}%`)}`;
      case "between": {
        const pair =
          Array.isArray(resolved.value) && resolved.value.length === 2
            ? resolved.value
            : typeof resolved.value === "object" &&
                resolved.value !== null &&
                "start" in resolved.value &&
                "end" in resolved.value
              ? [
                  (resolved.value as { start: unknown }).start,
                  (resolved.value as { end: unknown }).end,
                ]
              : null;
        if (!pair) throw new Error(`BETWEEN_REQUIRES_RANGE_PAIR: "${node.column}"`);
        return `${colSql} BETWEEN ${pushParam(pair[0])} AND ${pushParam(pair[1])}`;
      }
      case "in":
      case "not_in": {
        const arr = Array.isArray(resolved.value) ? resolved.value : [resolved.value];
        if (arr.length === 0) return node.op === "in" ? "1 = 0" : "1 = 1";
        const placeholders = arr.map((item) => pushParam(item)).join(", ");
        return `${colSql} ${node.op === "in" ? "IN" : "NOT IN"} (${placeholders})`;
      }
    }
  }

  const selectAliases = new Map<string, DatasetSelectField>(ds.select.map((s) => [s.alias, s]));
  const baseSelectSql = ds.select.map((s) => compileSelectField(s)).join(", ");
  const windowExtraFields = new Set<string>();
  if (ds.window_fields.length > 0) {
    for (const window of ds.window_fields) {
      for (const field of [
        window.target_field,
        ...window.partition_by,
        ...window.order_by.map((order) => order.field),
      ]) {
        if (!selectAliases.has(field) && baseModel.columns[field]) windowExtraFields.add(field);
      }
    }
    for (const order of ds.order_by) {
      if (!selectAliases.has(order.field) && baseModel.columns[order.field]) {
        windowExtraFields.add(order.field);
      }
    }
  }
  const windowExtraSelectSql = [...windowExtraFields]
    .map((field) => `${resolveColumnSql(undefined, field)} AS ${quoteIdent(field)}`)
    .join(", ");
  const fromSql = `FROM ${quoteIdent(baseModel.tableName)} AS ${quoteIdent(ds.from_alias)}`;
  const whereClause = ds.where ? compileWhereNode(ds.where) : null;
  const whereSql = whereClause ? `WHERE ${whereClause}` : "";

  const groupBySql =
    ds.group_by.length > 0
      ? `GROUP BY ${ds.group_by
          .map((g) => {
            const sel = selectAliases.get(g);
            return sel ? compileScalarExpr(sel) : resolveColumnSql(undefined, g);
          })
          .join(", ")}`
      : "";

  const havingSql =
    ds.having.length > 0
      ? `HAVING ${ds.having
          .map((h) => {
            const sel = selectAliases.get(h.select_alias);
            if (!sel || !sel.aggregate) throw new Error(`INVALID_HAVING_ALIAS: "${h.select_alias}"`);
            const aggExpr = compileSelectField(sel).replace(/\s+AS\s+"[^"]+"$/, "");
            const opMap = { gt: ">", gte: ">=", lt: "<", lte: "<=", eq: "=", neq: "<>" } as const;
            return `${aggExpr} ${opMap[h.op]} ${pushParam(h.value)}`;
          })
          .join(" AND ")}`
      : "";

  const boundedLimit = Math.min(
    ds.limit,
    baseModel.optimizationRule.maxRowsReturned,
    host.globalLimits.maxRowsPerDataset,
  );
  const orderBySql =
    ds.order_by.length > 0
      ? `ORDER BY ${ds.order_by
          .map((o) => {
            const colRef = selectAliases.has(o.field)
              ? quoteIdent(o.field)
              : resolveColumnSql(undefined, o.field);
            return `${colRef} ${o.direction}`;
          })
          .join(", ")}`
      : "";

  const coreSql = [
    `SELECT ${baseSelectSql}`,
    fromSql,
    ...joinClauses,
    whereSql,
    groupBySql,
    havingSql,
    orderBySql,
    `LIMIT ${boundedLimit}`,
  ]
    .filter(Boolean)
    .join(" ");

  if (ds.window_fields.length === 0) {
    return { sql: coreSql, values };
  }

  // Window functions must see the full filtered/grouped result, not the
  // already-limited page. Build the base query without ORDER BY/LIMIT, apply
  // the window functions, then order and limit the windowed rows.
  const windowBaseSql = [
    `SELECT ${baseSelectSql}${windowExtraSelectSql ? `, ${windowExtraSelectSql}` : ""}`,
    fromSql,
    ...joinClauses,
    whereSql,
    groupBySql,
    havingSql,
  ]
    .filter(Boolean)
    .join(" ");
  const windowOrderSql = ds.order_by.length > 0
    ? `ORDER BY ${ds.order_by
        .map((o) => {
          const colRef = selectAliases.has(o.field)
            ? quoteIdent(o.field)
            : quoteIdent(o.field);
          return `${colRef} ${o.direction}`;
        })
        .join(", ")}`
    : "";

  const windowSelects = ds.window_fields.map((wf) => {
    const partSql =
      wf.partition_by.length > 0
        ? `PARTITION BY ${wf.partition_by.map((p) => quoteIdent(p)).join(", ")}`
        : "";
    const ordSql =
      wf.order_by.length > 0
        ? `ORDER BY ${wf.order_by.map((o) => `${quoteIdent(o.field)} ${o.direction}`).join(", ")}`
        : "";
    const overClause = `OVER (${[partSql, ordSql].filter(Boolean).join(" ")})`;
    switch (wf.window_fn) {
      case "RUNNING_SUM":
        return `SUM(${quoteIdent(wf.target_field)}) ${overClause} AS ${quoteIdent(wf.alias)}`;
      case "ROW_NUMBER":
        return `ROW_NUMBER() ${overClause} AS ${quoteIdent(wf.alias)}`;
      case "RANK":
        return `RANK() ${overClause} AS ${quoteIdent(wf.alias)}`;
      case "PERCENT_OF_TOTAL":
        return `ROUND((${quoteIdent(wf.target_field)}::numeric * 100.0) / NULLIF(SUM(${quoteIdent(wf.target_field)}) OVER (${partSql}), 0), 2) AS ${quoteIdent(wf.alias)}`;
    }
  });

  return {
    sql: `SELECT _base.*, ${windowSelects.join(", ")} FROM (${windowBaseSql}) AS _base ${windowOrderSql} LIMIT ${boundedLimit}`,
    values,
  };
}
