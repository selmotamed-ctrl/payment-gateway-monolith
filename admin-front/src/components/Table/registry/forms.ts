import type { TableServerConfig } from "../filters";

/**
 * Table filter configs of this area, keyed by ROUTE NAME (see tableRegistry.ts).
 * Spread into `tableRegistry`; import `urlsMap` and the option loaders as needed.
 */
export const formsTables: Record<string, TableServerConfig> = {};
