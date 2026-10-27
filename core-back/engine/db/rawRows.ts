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
 * MySQL/MariaDB binds the values positionally with `?`, so the list is just
 * one `?` per value. The list has to sit in the statement exactly where the
 * values are bound: the first `?` of the list takes the first value of the
 * matching argument list.
 */
export const mysqlPlaceholders = (count: number): string =>
  Array.from({ length: count }, () => "?").join(", ");

/**
 * @deprecated The dialect is MySQL/MariaDB now: use `mysqlPlaceholders`.
 * Kept so that the callers of the old name keep working; the produced
 * placeholders are the MySQL ones.
 */
export const postgresPlaceholders = (count: number, _startIndex = 1): string =>
  mysqlPlaceholders(count);
