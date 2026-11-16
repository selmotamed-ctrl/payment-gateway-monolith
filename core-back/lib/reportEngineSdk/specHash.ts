import { createHash } from "node:crypto";

/**
 * JSON with every object's keys sorted, recursively. Arrays keep their order.
 *
 * Report specs are stored in a PostgreSQL `jsonb` column, and `jsonb` does not keep the key order
 * of the document it was given (it orders keys by length, then bytes). A hash of
 * `JSON.stringify(spec)` taken before the insert could therefore never be recomputed from the
 * stored row, so `spec_sha256` proved nothing about the row it sits on. Sorting the keys makes the
 * hash a function of the content only: the same before the insert and after any read.
 */
export const canonicalJson = (value: unknown): string => JSON.stringify(sortKeys(value));

const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] !== undefined) sorted[key] = sortKeys(source[key]);
    }
    return sorted;
  }
  return value;
};

/** SHA-256 (hex) of a report spec's content; reproducible from the stored `spec_json`. */
export const specContentSha256 = (spec: unknown): string =>
  createHash("sha256").update(canonicalJson(spec)).digest("hex");
