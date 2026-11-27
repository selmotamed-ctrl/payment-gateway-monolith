import type { TableServerConfig } from "@pg/ui";

/** The checkout portal has no back-office tables. */
export const tableRegistry: Record<string, TableServerConfig> = {};
