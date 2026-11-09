import type { DatasetTransformSpec } from "../types/reportSpec";

export type DatasetMap = Record<string, Array<Record<string, unknown>>>;

export function executeTransformPipeline(
  datasets: DatasetMap,
  transforms: readonly DatasetTransformSpec[],
  parsedComparisonAssets: Record<string, Array<Record<string, unknown>>>,
): DatasetMap {
  const working: DatasetMap = { ...datasets };

  for (const step of transforms) {
    switch (step.operation) {
      case "COMPUTE_COLUMN": {
        const rows = working[step.target_dataset_id] ?? [];
        const totalForShare =
          step.formula === "PERCENTAGE_SHARE"
            ? rows.reduce((acc, r) => acc + Number(r[step.left_operand] ?? 0), 0)
            : 0;

        working[step.target_dataset_id] = rows.map((row) => {
          const left = Number(row[step.left_operand] ?? 0);
          const right =
            typeof step.right_operand === "number"
              ? step.right_operand
              : Number(row[step.right_operand] ?? 0);

          let computed = 0;
          switch (step.formula) {
            case "ADD":
              computed = left + right;
              break;
            case "SUBTRACT":
              computed = left - right;
              break;
            case "MULTIPLY":
              computed = left * right;
              break;
            case "SAFE_DIVIDE":
              computed = right === 0 ? 0 : left / right;
              break;
            case "PERCENTAGE_SHARE":
              computed = totalForShare === 0 ? 0 : (left / totalForShare) * 100;
              break;
            case "VARIANCE_BPS":
              computed = right === 0 ? 0 : Math.round(((left - right) / right) * 10_000);
              break;
          }
          return { ...row, [step.output_column]: computed };
        });
        break;
      }

      case "JOIN_DATASETS": {
        const leftRows = working[step.left_dataset_id] ?? [];
        const rightRows = working[step.right_dataset_id] ?? [];
        const rightIndex = new Map<string, Record<string, unknown>>();
        for (const r of rightRows) {
          rightIndex.set(String(r[step.on_right_key] ?? ""), r);
        }

        const joined: Array<Record<string, unknown>> = [];
        const matchedRightKeys = new Set<string>();

        for (const l of leftRows) {
          const key = String(l[step.on_left_key] ?? "");
          const r = rightIndex.get(key);
          if (r) {
            matchedRightKeys.add(key);
            joined.push({ ...r, ...l });
          } else if (step.join_type === "LEFT" || step.join_type === "FULL") {
            joined.push({ ...l });
          }
        }

        if (step.join_type === "FULL") {
          for (const r of rightRows) {
            const key = String(r[step.on_right_key] ?? "");
            if (!matchedRightKeys.has(key)) {
              joined.push({ ...r });
            }
          }
        }
        working[step.output_dataset_id] = joined;
        break;
      }

      case "PIVOT_DATASET": {
        const sourceRows = working[step.source_dataset_id] ?? [];
        const grouped = new Map<string, Record<string, unknown>>();
        for (const row of sourceRows) {
          const rKey = String(row[step.row_key] ?? "");
          const cKey = String(row[step.column_key] ?? "");
          const val = Number(row[step.value_key] ?? 0);
          const current = grouped.get(rKey) ?? { [step.row_key]: row[step.row_key] };
          if (step.aggregation === "SUM") {
            current[cKey] = Number(current[cKey] ?? 0) + val;
          } else if (step.aggregation === "COUNT") {
            current[cKey] = Number(current[cKey] ?? 0) + 1;
          } else if (current[cKey] === undefined) {
            current[cKey] = row[step.value_key];
          }
          grouped.set(rKey, current);
        }
        working[step.output_dataset_id] = [...grouped.values()];
        break;
      }

      case "COMPARE_WITH_ASSET": {
        const sourceRows = working[step.source_dataset_id] ?? [];
        const assetRows = parsedComparisonAssets[step.asset_key] ?? [];
        const buildCompositeKey = (row: Record<string, unknown>) =>
          step.match_keys.map((k) => String(row[k] ?? "")).join("::");

        const assetMap = new Map<string, Record<string, unknown>>();
        for (const aRow of assetRows) {
          assetMap.set(buildCompositeKey(aRow), aRow);
        }

        working[step.output_dataset_id] = sourceRows.map((sRow) => {
          const aRow = assetMap.get(buildCompositeKey(sRow));
          const diffs: Record<string, unknown> = {
            ...sRow,
            _asset_matched: Boolean(aRow),
            _has_discrepancy: !aRow,
          };
          for (const cf of step.compare_fields) {
            const actualVal = Number(sRow[cf.dataset_field] ?? 0);
            const expectedVal = aRow ? Number(aRow[cf.asset_field] ?? 0) : 0;
            const delta = actualVal - expectedVal;
            const outOfTolerance = !aRow || Math.abs(delta) > cf.tolerance_minor;
            diffs[`${cf.dataset_field}_expected`] = aRow ? expectedVal : null;
            diffs[`${cf.dataset_field}_variance`] = delta;
            if (outOfTolerance) {
              diffs._has_discrepancy = true;
            }
          }
          return diffs;
        });
        break;
      }
    }
  }

  return working;
}
