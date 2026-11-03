const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (value: string): boolean => UUID_PATTERN.test(value.trim());

/**
 * PostgreSQL stores ids as native uuid, so a substring (`contains`) match is
 * not available. Exact UUIDs are still searchable; free-text search continues
 * to use the reference/name columns.
 */
export const idSearchFilter = (query: string): Array<{ id: string }> =>
  isUuid(query) ? [{ id: query.trim() }] : [];
