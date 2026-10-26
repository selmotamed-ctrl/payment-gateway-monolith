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

export const postgresPlaceholders = (count: number, startIndex = 1): string =>
  Array.from({ length: count }, (_unused, index) => `$${startIndex + index}`).join(", ");
