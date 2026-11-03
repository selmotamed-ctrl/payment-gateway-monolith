import {
  parseNodeList,
  type DeployConfig,
  type NodeSpec,
} from "../lib/configSchema";
import type { SshTarget } from "../lib/hostPlanner";

/**
 * PostgreSQL 18 + PgBouncer provisioner.
 *
 * Every builder is pure so the exact configuration can be asserted in tests;
 * `provisionPostgres18` only performs remote work through the supplied runner.
 */

export interface ProvisionRunner {
  dryRun?: boolean;
  run(target: SshTarget, command: string, options?: { sudo?: boolean; sudoUser?: string; cwd?: string; timeoutMs?: number }): unknown;
  capture(target: SshTarget, command: string, options?: { sudo?: boolean; sudoUser?: string; cwd?: string }): string;
  writeRemoteFile(input: { target: SshTarget; path: string; content: string | Buffer; mode?: number; sudo?: boolean }): void;
}

export interface PgNodeRef {
  nodeId?: string;
  sshHost?: string;
  sshPort?: number;
  privateIp: string;
  servicePort?: number;
  port?: number;
  ssh?: SshTarget;
}

export interface PostgresProvisionInput {
  runner: ProvisionRunner;
  config: DeployConfig;
  dryRun?: boolean;
  primary?: PgNodeRef | null;
  replicas?: PgNodeRef[];
}

export interface ProvisionReport {
  commands: string[];
  nodes: string[];
}

const version = (config?: Pick<DeployConfig, "PG_VERSION">): string => config?.PG_VERSION ?? "18";

export const postgresDataDir = (config?: Pick<DeployConfig, "PG_VERSION">): string =>
  `/var/lib/postgresql/${version(config)}/main`;

export const postgresConfigPath = (config?: Pick<DeployConfig, "PG_VERSION">): string =>
  `/etc/postgresql/${version(config)}/main/conf.d/zz-pg-switch.conf`;

const nodeEndpoint = (node: PgNodeRef | string): string =>
  typeof node === "string" ? node : node.privateIp ?? node.sshHost ?? "127.0.0.1";

const nodePort = (node: PgNodeRef | string): number =>
  typeof node === "string" ? 5432 : node.servicePort ?? node.port ?? 5432;

const nodeSsh = (config: DeployConfig, node: PgNodeRef | string): SshTarget => {
  if (typeof node !== "string" && node.ssh) return node.ssh;
  return {
    host: typeof node === "string" ? node : node.sshHost ?? node.privateIp,
    port: typeof node === "string" ? config.PG_SSH_PORT : node.sshPort ?? config.PG_SSH_PORT,
    user: config.PG_SSH_USER,
    keyPath: config.PG_SSH_KEY_PATH ?? "",
    sudoPassword: config.PG_SUDO_PASSWORD,
  };
};

const specToRef = (spec: NodeSpec): PgNodeRef => ({
  nodeId: spec.nodeId,
  sshHost: spec.sshHost,
  sshPort: spec.sshPort,
  privateIp: spec.privateIp,
  servicePort: spec.servicePort,
});

const slotName = (node: PgNodeRef | string, index = 0): string => {
  const raw = typeof node === "string" ? `replica_${index + 1}` : node.nodeId ?? `replica_${index + 1}`;
  return raw.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^([^a-z])/, "r_$1").slice(0, 63);
};

/** The exact PostgreSQL 18 tuning block from the storage architecture. */
export const postgresConfigSnippet = (_config?: Pick<DeployConfig, "PG_VERSION">): string => `listen_addresses = '*'
max_connections = 300
shared_buffers = 8GB
effective_cache_size = 24GB
work_mem = 32MB
maintenance_work_mem = 1GB
io_method = 'io_uring'
synchronous_commit = on
wal_level = replica
max_wal_senders = 16
max_replication_slots = 16
max_wal_size = 16GB
min_wal_size = 2GB
checkpoint_completion_target = 0.9
random_page_cost = 1.1
shared_preload_libraries = 'pg_stat_statements'
track_io_timing = on
`;

/** Install PostgreSQL 18, contrib extensions and PgBouncer. */
export const bootstrapCommands = (
  config: DeployConfig,
  role: "primary" | "replica" | "pgbouncer" = "primary",
): string[] => [
  "apt-get update",
  `DEBIAN_FRONTEND=noninteractive apt-get install -y postgresql-${version(config)} postgresql-contrib-${version(config)} pgbouncer`,
  "systemctl enable --now postgresql",
  ...(role === "primary" || role === "pgbouncer" ? ["systemctl enable --now pgbouncer"] : []),
  `install -d -m 0700 -o postgres -g postgres ${postgresDataDir(config)}`,
];

/** pg_hba policy: TLS + SCRAM for every application/replication source. */
export const pgHbaSnippet = (config: DeployConfig, allowedSources: string[]): string => {
  const sources = [...new Set(allowedSources.filter((entry) => entry.length > 0))];
  return [
    "local   all             all                                     peer",
    "host    all             all             127.0.0.1/32            scram-sha-256",
    "host    all             all             ::1/128                 scram-sha-256",
    ...sources.flatMap((source) => [
      `hostssl all             all             ${source}/32            scram-sha-256`,
      `hostssl replication     all             ${source}/32            scram-sha-256`,
    ]),
  ].join("\n") + "\n";
};

/** Primary SQL: application role/database, replication role and TLS host rules. */
export const primaryBootstrapSql = (config: DeployConfig, replicas: Array<PgNodeRef | string>): string => {
  const replicaSources = replicas.map((node) => nodeEndpoint(node));
  const allowed = [...replicaSources];
  return [
    `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${config.PG_DB_USER}') THEN CREATE ROLE "${config.PG_DB_USER}" LOGIN PASSWORD '${config.PG_DB_PASSWORD}'; ELSE ALTER ROLE "${config.PG_DB_USER}" PASSWORD '${config.PG_DB_PASSWORD}'; END IF; END $$;`,
    `SELECT 'CREATE DATABASE "${config.PG_DB_NAME}" OWNER "${config.PG_DB_USER}"' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${config.PG_DB_NAME}')\\gexec`,
    `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${config.PG_REPLICATION_USER}') THEN CREATE ROLE "${config.PG_REPLICATION_USER}" WITH REPLICATION LOGIN PASSWORD '${config.PG_REPLICATION_PASSWORD}'; ELSE ALTER ROLE "${config.PG_REPLICATION_USER}" WITH REPLICATION LOGIN PASSWORD '${config.PG_REPLICATION_PASSWORD}'; END IF; END $$;`,
    ...replicas.map((node, index) => {
      const slot = slotName(node, index);
      return `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_replication_slots WHERE slot_name = '${slot}') THEN PERFORM pg_create_physical_replication_slot('${slot}'); END IF; END $$;`;
    }),
    `-- pg_hba sources: ${allowed.join(",")}`,
  ].join("\n") + "\n";
};

/** Slot creation + `pg_basebackup -R` for each replica (idempotent). */
export const replicaCommands = (
  primary: PgNodeRef | string,
  replica: PgNodeRef | string,
  config?: DeployConfig,
): string[] => {
  const primaryIp = nodeEndpoint(primary);
  const primaryPort = nodePort(primary);
  const dataDir = postgresDataDir(config);
  const user = config?.PG_REPLICATION_USER ?? "pg_replicator";
  return [
    `test -s ${dataDir}/PG_VERSION || pg_basebackup -h ${primaryIp} -p ${primaryPort} -U ${user} -D ${dataDir} -Fp -Xs -P -R`,
    `test -s ${dataDir}/PG_VERSION && echo 'replica already initialized'`,
    "systemctl enable --now postgresql",
  ];
};

/** The exact PgBouncer transaction-pooling configuration. */
export const pgbouncerIni = (config: DeployConfig): string => `[pgbouncer]
listen_port = ${config.PGBOUNCER_PORT}
pool_mode = transaction
max_client_conn = ${config.PGBOUNCER_MAX_CLIENT_CONN}
default_pool_size = ${config.PGBOUNCER_DEFAULT_POOL_SIZE}
reserve_pool_size = 10
max_prepared_statements = ${config.PGBOUNCER_MAX_PREPARED_STATEMENTS}
server_reset_query_always = 0
ignore_startup_parameters = extra_float_digits,search_path
auth_type = scram-sha-256
auth_file = /etc/pgbouncer/userlist.txt
`;

export const pgbouncerUserlist = (config: DeployConfig): string =>
  `"${config.PG_DB_USER}" "${config.PG_DB_PASSWORD}"\n"${config.PG_REPLICATION_USER}" "${config.PG_REPLICATION_PASSWORD}"\n`;

const write = (runner: ProvisionRunner, target: SshTarget, path: string, content: string, mode = 0o600): void => {
  runner.writeRemoteFile({ target, path, content, mode, sudo: true });
};

/**
 * Applies PostgreSQL 18, streaming replicas and PgBouncer. The runner is the
 * only side effect; tests pass a recording fake.
 */
export const provisionPostgres18 = (input: PostgresProvisionInput): ProvisionReport => {
  const { runner, config } = input;
  const commands: string[] = [];
  const nodes: string[] = [];
  const primary = input.primary === undefined
    ? parseNodeList(config.PG_PRIMARY_NODE)[0] ?? null
    : input.primary;
  const replicas = input.replicas ?? parseNodeList(config.PG_REPLICA_NODES).map(specToRef);
  if (!primary) return { commands, nodes };

  const primarySsh = nodeSsh(config, primary);
  const primaryIp = nodeEndpoint(primary);
  nodes.push(primaryIp);
  for (const command of bootstrapCommands(config, "primary")) {
    commands.push(command);
    runner.run(primarySsh, command, { sudo: true });
  }
  const snippet = postgresConfigSnippet(config);
  write(runner, primarySsh, postgresConfigPath(config), snippet, 0o644);
  const replicaRefs = replicas;
  const primaryAllowed = [
    primaryIp,
    ...replicaRefs.map((node) => nodeEndpoint(node)),
    ...parseNodeList(config.CORE_NODES).map((node) => node.privateIp),
    ...(config.CORE_PRIVATE_IP ? [config.CORE_PRIVATE_IP] : []),
  ];
  write(runner, primarySsh, `/etc/postgresql/${version(config)}/main/pg_hba.conf`, pgHbaSnippet(config, primaryAllowed), 0o600);
  const bootstrapSqlPath = `/tmp/pg18-bootstrap-${process.pid}.sql`;
  write(runner, primarySsh, bootstrapSqlPath, primaryBootstrapSql(config, replicaRefs), 0o600);
  const bootstrap = `su - postgres -c "psql -v ON_ERROR_STOP=1 -f ${bootstrapSqlPath}"`;
  commands.push(bootstrap);
  runner.run(primarySsh, bootstrap, { sudo: true });
  runner.run(primarySsh, "systemctl restart postgresql", { sudo: true });

  if (config.PGBOUNCER_ENABLED) {
    write(runner, primarySsh, "/etc/pgbouncer/pgbouncer.ini", pgbouncerIni(config), 0o640);
    write(runner, primarySsh, "/etc/pgbouncer/userlist.txt", pgbouncerUserlist(config), 0o600);
    const restart = "systemctl enable --now pgbouncer && systemctl restart pgbouncer";
    commands.push(restart);
    runner.run(primarySsh, restart, { sudo: true });
  }

  for (const [index, replica] of replicaRefs.entries()) {
    const replicaSsh = nodeSsh(config, replica);
    const replicaIp = nodeEndpoint(replica);
    nodes.push(replicaIp);
    for (const command of bootstrapCommands(config, "replica")) {
      commands.push(command);
      runner.run(replicaSsh, command, { sudo: true });
    }
    write(runner, replicaSsh, postgresConfigPath(config), snippet, 0o644);
    write(runner, replicaSsh, `/etc/postgresql/${version(config)}/main/pg_hba.conf`, pgHbaSnippet(config, [primaryIp]), 0o600);
    for (const command of replicaCommands(primary, replica, config)) {
      commands.push(command);
      runner.run(replicaSsh, command, { sudo: true, sudoUser: "postgres" });
    }
    if (config.PGBOUNCER_ENABLED) {
      write(runner, replicaSsh, "/etc/pgbouncer/pgbouncer.ini", pgbouncerIni(config), 0o640);
      write(runner, replicaSsh, "/etc/pgbouncer/userlist.txt", pgbouncerUserlist(config), 0o600);
      const restart = "systemctl enable --now pgbouncer && systemctl restart pgbouncer";
      commands.push(restart);
      runner.run(replicaSsh, restart, { sudo: true });
    }
    const slot = slotName(replica, index);
    commands.push(`pg_create_physical_replication_slot('${slot}')`);
  }
  return { commands, nodes };
};
