import { Decimal } from "decimal.js";
import type { DatasetTransformSpec } from "../types/reportSpec";

export type DatasetMap = Record<string, Array<Record<string, unknown>>>;

/**
 * All transform arithmetic uses decimal.js (money invariant: never JS floats).
 * Computed values are emitted as plain decimal strings (no exponent), so
 * minor-unit amounts above 2^53 and fractional values such as 0.1 + 0.2 are
 * exact. COUNT aggregations stay integers.
 */
const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP, toExpNeg: -40, toExpPos: 40 });
type Dec = InstanceType<typeof D>;

/** Fractional results (division, shares) are rounded to this many places. */
const DIVISION_SCALE = 10;

/** Parses a numeric cell; null/undefined/"" are null, non-numeric text is null. */
export function toDecimalOrNull(value: unknown): Dec | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return new D(value.toString());
  if (typeof value === "number") return Number.isFinite(value) ? new D(value) : null;
  if (typeof value === "boolean") return null;
  const text = String(value).trim();
  if (text === "" || !/^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/.test(text)) return null;
  return new D(text);
}

const decimalString = (value: Dec): string => value.toFixed();

const formulaResult = (
  formula: Extract<DatasetTransformSpec, { operation: "COMPUTE_COLUMN" }>["formula"],
  left: Dec | null,
  right: Dec | null,
  totalForShare: Dec,
): string | null => {
  switch (formula) {
    case "ADD":
      return left && right ? decimalString(left.plus(right)) : null;
    case "SUBTRACT":
      return left && right ? decimalString(left.minus(right)) : null;
    case "MULTIPLY":
      return left && right ? decimalString(left.times(right)) : null;
    case "SAFE_DIVIDE":
      if (!left || !right) return null;
      return right.isZero() ? "0" : decimalString(left.dividedBy(right).toDecimalPlaces(DIVISION_SCALE));
    case "PERCENTAGE_SHARE":
      if (!left) return null;
      return totalForShare.isZero()
        ? "0"
        : decimalString(left.dividedBy(totalForShare).times(100).toDecimalPlaces(DIVISION_SCALE));
    case "VARIANCE_BPS":
      if (!left || !right) return null;
      return right.isZero()
        ? "0"
        : decimalString(left.minus(right).dividedBy(right).times(10_000).toDecimalPlaces(0));
  }
};

/** Key used by JOIN/COMPARE matching; null means "never matches". */
const matchKeyOf = (row: Record<string, unknown>, fields: readonly string[]): string | null => {
  const parts: string[] = [];
  for (const field of fields) {
    const value = row[field];
    if (value === null || value === undefined) return null;
    parts.push(JSON.stringify(String(value)));
  }
  return parts.join("\u0000");
};

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
            ? rows.reduce<Dec>((acc, r) => acc.plus(toDecimalOrNull(r[step.left_operand]) ?? 0), new D(0))
            : new D(0);

        working[step.target_dataset_id] = rows.map((row) => {
          const left = toDecimalOrNull(row[step.left_operand] ?? 0);
          const right =
            step.right_operand === undefined
              ? new D(0)
              : typeof step.right_operand === "number"
                ? toDecimalOrNull(step.right_operand)
                : toDecimalOrNull(row[step.right_operand] ?? 0);
          let computed = formulaResult(step.formula, left, right, totalForShare);
          if (computed !== null && step.format_hint === "INTEGER") {
            computed = decimalString(new D(computed).toDecimalPlaces(0));
          }
          return { ...row, [step.output_column]: computed };
        });
        break;
      }

      case "JOIN_DATASETS": {
        const leftRows = working[step.left_dataset_id] ?? [];
        const rightRows = working[step.right_dataset_id] ?? [];
        // Every right row is kept per key (cross product on duplicates);
        // null keys never match anything, mirroring SQL join semantics.
        const rightIndex = new Map<string, Array<{ row: Record<string, unknown>; index: number }>>();
        rightRows.forEach((row, index) => {
          const key = matchKeyOf(row, [step.on_right_key]);
          if (key === null) return;
          const bucket = rightIndex.get(key) ?? [];
          bucket.push({ row, index });
          rightIndex.set(key, bucket);
        });

        const joined: Array<Record<string, unknown>> = [];
        const matchedRightRows = new Set<number>();
        for (const l of leftRows) {
          const key = matchKeyOf(l, [step.on_left_key]);
          const matches = key === null ? undefined : rightIndex.get(key);
          if (matches && matches.length > 0) {
            for (const match of matches) {
              matchedRightRows.add(match.index);
              joined.push({ ...match.row, ...l });
            }
          } else if (step.join_type === "LEFT" || step.join_type === "FULL") {
            joined.push({ ...l });
          }
        }

        if (step.join_type === "FULL") {
          rightRows.forEach((row, index) => {
            if (!matchedRightRows.has(index)) joined.push({ ...row });
          });
        }
        working[step.output_dataset_id] = joined;
        break;
      }

      case "PIVOT_DATASET": {
        const sourceRows = working[step.source_dataset_id] ?? [];
        const grouped = new Map<string, Record<string, unknown>>();
        const sums = new Map<string, Map<string, Dec>>();
        for (const row of sourceRows) {
          const rKey = String(row[step.row_key] ?? "");
          const cKey = String(row[step.column_key] ?? "");
          const current = grouped.get(rKey) ?? { [step.row_key]: row[step.row_key] };
          if (step.aggregation === "SUM") {
            const rowSums = sums.get(rKey) ?? new Map<string, Dec>();
            const next = (rowSums.get(cKey) ?? new D(0)).plus(toDecimalOrNull(row[step.value_key]) ?? 0);
            rowSums.set(cKey, next);
            sums.set(rKey, rowSums);
            current[cKey] = decimalString(next);
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

        const assetMap = new Map<string, { row: Record<string, unknown>; count: number }>();
        for (const aRow of assetRows) {
          const key = matchKeyOf(aRow, step.match_keys);
          if (key === null) continue;
          const existing = assetMap.get(key);
          if (existing) existing.count += 1;
          else assetMap.set(key, { row: aRow, count: 1 });
        }
        const sourceFieldNames = new Set<string>(sourceRows.flatMap((row) => Object.keys(row)));
        const matchedAssetKeys = new Set<string>();

        const compareRow = (
          base: Record<string, unknown>,
          liveRow: Record<string, unknown> | null,
          asset: { row: Record<string, unknown>; count: number } | undefined,
        ): Record<string, unknown> => {
          const out: Record<string, unknown> = {
            ...base,
            _asset_matched: Boolean(asset),
            _missing_in_live: liveRow === null,
            _duplicate_asset_key: Boolean(asset && asset.count > 1),
            _has_discrepancy: !asset || liveRow === null || Boolean(asset && asset.count > 1),
          };
          for (const cf of step.compare_fields) {
            const actualRaw = liveRow ? liveRow[cf.dataset_field] : null;
            const expectedRaw = asset ? (asset.row[cf.asset_field] ?? null) : null;
            const actual = liveRow ? toDecimalOrNull(actualRaw ?? 0) : null;
            const expected = asset ? toDecimalOrNull(expectedRaw ?? 0) : null;
            let variance: string | null = null;
            let outOfTolerance: boolean;
            if (actual && expected) {
              const delta = actual.minus(expected);
              variance = decimalString(delta);
              outOfTolerance = delta.abs().greaterThan(cf.tolerance_minor);
            } else if (liveRow === null && expected) {
              variance = decimalString(expected.negated());
              outOfTolerance = true;
            } else {
              // Non-numeric or missing values compare as exact strings.
              outOfTolerance = !asset || liveRow === null || String(actualRaw ?? "") !== String(expectedRaw ?? "");
            }
            const expectedValue = expected ? decimalString(expected) : expectedRaw;
            // Source fields are never overwritten: the asset value is written
            // under <dataset_field>_expected, the optional output_field, and
            // the asset_field name only when it is not already a source field.
            if (!sourceFieldNames.has(cf.asset_field) && !(cf.asset_field in out)) {
              out[cf.asset_field] = expectedRaw;
            }
            if (cf.output_field && !sourceFieldNames.has(cf.output_field)) out[cf.output_field] = expectedValue;
            out[`${cf.dataset_field}_expected`] = asset ? expectedValue : null;
            out[`${cf.dataset_field}_variance`] = variance;
            if (outOfTolerance) out._has_discrepancy = true;
          }
          return out;
        };

        const output = sourceRows.map((sRow) => {
          const key = matchKeyOf(sRow, step.match_keys);
          const asset = key === null ? undefined : assetMap.get(key);
          if (key !== null && asset) matchedAssetKeys.add(key);
          return compareRow(sRow, sRow, asset);
        });
        // Asset rows with no live counterpart are reported, not dropped.
        for (const [key, asset] of assetMap) {
          if (matchedAssetKeys.has(key)) continue;
          const base: Record<string, unknown> = {};
          for (const matchKey of step.match_keys) base[matchKey] = asset.row[matchKey];
          output.push(compareRow(base, null, asset));
        }
        working[step.output_dataset_id] = output;
        break;
      }
    }
  }

  return working;
}
