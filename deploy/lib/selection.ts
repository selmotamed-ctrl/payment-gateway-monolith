import type { DeployRole, StorageRole } from "./configSchema";
import type { DeployPlan, HostPlan, ServicePlan } from "./hostPlanner";

/** CLI role names plus convenience aliases for the backend service names. */
export const ONLY_ROLE_ALIASES: Record<string, string> = {
  "core-back": "core",
  "admin-back": "admin",
  "merchant-back": "merchant",
  "checkout-back": "checkout",
  "fake-rails-back": "fake-rails",
  "object-storage-daemon": "object-storage",
};

export const COMPUTE_ROLES = ["db", "core", "core-sandbox", "admin", "merchant", "checkout", "fake-rails"] as const;
export const STORAGE_ONLY_ROLES = [
  "pg",
  "pg-primary",
  "pg-replica",
  "pgbouncer",
  "redis",
  "audit-db",
  "log-db",
  "backup",
  "object-storage",
  "storage",
] as const;

export const ALL_ONLY_ROLES = [...COMPUTE_ROLES, ...STORAGE_ONLY_ROLES] as const;

export type OnlyRole = (typeof ALL_ONLY_ROLES)[number];

/** Normalizes `--only` aliases (`admin-back` -> `admin`, `core-back` -> `core`, ...). */
export const normalizeOnlyRole = (role: string): OnlyRole => {
  const normalized = role.trim().toLowerCase();
  const mapped = ONLY_ROLE_ALIASES[normalized] ?? normalized;
  if (!(ALL_ONLY_ROLES as readonly string[]).includes(mapped)) {
    throw new Error(`Unknown --only role '${role}'`);
  }
  return mapped as OnlyRole;
};

export interface SelectionOptions {
  only: Set<string>;
  nodes?: Set<string>;
}

export const shouldRun = (options: SelectionOptions, role: DeployRole): boolean =>
  options.only.size === 0 || options.only.has(role);

export const shouldRunStorage = (options: SelectionOptions, roles: readonly (StorageRole | "pg" | "storage")[]): boolean =>
  options.only.size === 0 || options.only.has("storage") || roles.some((role) => options.only.has(role));

/**
 * True when the run deploys every compute unit. A partial run (`--only` or
 * `--nodes`) is verified per deployed unit in the rolling batch step; applying
 * the new global release identity to unchanged services in step 11 would
 * fail a correct partial deploy.
 */
export const isFullDeployment = (options: SelectionOptions): boolean =>
  options.only.size === 0 && !(options.nodes && options.nodes.size > 0);

/** The storage provisioner groups, mirroring the branches in `main()` step 5. */
export const STORAGE_PROVISIONER_GROUPS = {
  postgres: ["pg", "pg-primary", "pg-replica", "pgbouncer"] as StorageRole[],
  redis: ["redis"] as StorageRole[],
  auditLog: ["audit-db", "log-db"] as StorageRole[],
  backup: ["backup"] as StorageRole[],
  objectStorage: ["object-storage"] as StorageRole[],
};

export interface SelectedStorage {
  postgres: boolean;
  redis: boolean;
  auditLog: boolean;
  backup: boolean;
  objectStorage: boolean;
}

export const selectedStorage = (options: SelectionOptions): SelectedStorage => ({
  postgres: shouldRunStorage(options, STORAGE_PROVISIONER_GROUPS.postgres),
  redis: shouldRunStorage(options, STORAGE_PROVISIONER_GROUPS.redis),
  auditLog: shouldRunStorage(options, STORAGE_PROVISIONER_GROUPS.auditLog),
  backup: shouldRunStorage(options, STORAGE_PROVISIONER_GROUPS.backup),
  objectStorage: shouldRunStorage(options, STORAGE_PROVISIONER_GROUPS.objectStorage),
});

export const deploymentUnits = (
  plan: DeployPlan,
  role: DeployRole,
  nodes?: Set<string>,
): Array<{ host: HostPlan; service: ServicePlan }> =>
  plan.hosts.flatMap((host) =>
    host.services
      .filter((service) => service.role === role)
      .filter((service) => !nodes || (service.nodeId !== undefined && nodes.has(service.nodeId)))
      .map((service) => ({ host, service })),
  );

/** The compute units selected by `--only` and `--nodes`, exactly as the deploy steps select them. */
export const selectedComputeUnits = (
  plan: DeployPlan,
  options: SelectionOptions,
): Array<{ host: HostPlan; service: ServicePlan }> => {
  const roles: DeployRole[] = ["core", "core-sandbox", "admin", "merchant", "checkout", "fake-rails"];
  return roles.flatMap((role) => (shouldRun(options, role) ? deploymentUnits(plan, role, options.nodes) : []));
};

/** True when the selected compute/storage checks require a core host (edge/fake-rails dependencies). */
export const requiresCoreDependency = (options: SelectionOptions): boolean =>
  ["admin", "merchant", "checkout", "fake-rails"].some((role) => options.only.has(role));
