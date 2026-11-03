export const snakeToCamelKey = (key: string): string =>
  key.replace(/_([a-zA-Z0-9])/g, (_match, character: string) => character.toUpperCase());

export const toCamelRow = <T>(value: unknown): T => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value as T;
  }
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    output[snakeToCamelKey(key)] = entry;
  }
  return output as T;
};

export const toCamelRows = <T>(value: unknown): T[] =>
  (Array.isArray(value) ? value : []).map((entry) => toCamelRow<T>(entry));

/**
 * The placeholder list of an `IN (...)` clause.
 *
 * PostgreSQL binds the values positionally with `$1`, `$2`, ..., so the list
 * is one numbered placeholder per value. The list has to sit in the statement
 * exactly where the values are bound: the first placeholder of the list takes
 * the first value of the matching argument list.
 */
export const postgresPlaceholders = (count: number, startIndex = 1, cast?: string): string =>
  Array.from({ length: count }, (_value, index) => `$${startIndex + index}${cast ? `::${cast}` : ""}`).join(", ");

/**
 * @deprecated The dialect is PostgreSQL now: use `postgresPlaceholders`.
 * Kept so that the callers of the old name keep working; the produced
 * placeholders are the PostgreSQL ones.
 */
