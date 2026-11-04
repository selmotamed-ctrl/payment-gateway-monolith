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

export interface PgCluster {
  name: string;
  port: number;
  dataDir: string;
  configDir: string;
  hbaPath: string;
  service: string;
}

const clusterName = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^([^a-z])/, "c_$1").slice(0, 60) || "main";

/**
 * Debian/Ubuntu can run several PostgreSQL 18 clusters on one host. Port 5432
 * keeps the conventional `main` cluster; every other role gets its own named
 * cluster so two roles never share a data directory, WAL stream or systemd
 * unit.
 */
export const pgClusterFor = (
  config: Pick<DeployConfig, "PG_VERSION">,
  role: "primary" | "replica" | "audit" | "log",
  node: PgNodeRef | string,
): PgCluster => {
  const port = nodePort(node);
  const nodeId = typeof node === "string" ? role : node.nodeId ?? role;
  const name = port === 5432 ? "main" : clusterName(role === "replica" ? `replica_${nodeId}` : role);
  return {
    name,
    port,
    dataDir: postgresDataDir(config, name),
    configDir: `/etc/postgresql/${version(config)}/${name}`,
    hbaPath: `/etc/postgresql/${version(config)}/${name}/pg_hba.conf`,
    service: `postgresql@${version(config)}-${name}`,
  };
};

export const postgresDataDir = (
  config?: Pick<DeployConfig, "PG_VERSION">,
  cluster = "main",
): string => `/var/lib/postgresql/${version(config)}/${cluster}`;

export const postgresConfigPath = (
  config?: Pick<DeployConfig, "PG_VERSION">,
  cluster = "main",
): string => `/etc/postgresql/${version(config)}/${cluster}/conf.d/zz-pg-switch.conf`;

export const postgresMainConfigPath = (
  config: Pick<DeployConfig, "PG_VERSION">,
  cluster: PgCluster,
): string => `/etc/postgresql/${version(config)}/${cluster.name}/postgresql.conf`;

export const postgresMainConfigSnippet = (
  config: Pick<DeployConfig, "PG_VERSION">,
  cluster: PgCluster,
): string => `data_directory = '${cluster.dataDir}'
hba_file = '${cluster.hbaPath}'
port = ${cluster.port}
${postgresConfigSnippet(config)}`;

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

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\''`)}'`;

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
const ensureClusterScript = (
  config: DeployConfig,
  cluster: PgCluster,
): string => `set -e
if command -v pg_createcluster >/dev/null 2>&1; then
  pg_lsclusters -h | awk '{print $2}' | grep -qx ${shellQuote(cluster.name)} || pg_createcluster ${version(config)} ${cluster.name} -p ${cluster.port} --start-conf=auto
else
  # Arch Linux: the package is a single server binary, so create each lab
  # cluster with initdb and a dedicated systemd unit.
  install -d -m 0755 /etc/postgresql/${version(config)}/${cluster.name}
  install -d -m 0700 -o postgres -g postgres ${cluster.dataDir}
  if [ ! -s ${cluster.dataDir}/PG_VERSION ]; then
    runuser -u postgres -- initdb -D ${cluster.dataDir}
  fi
  install -d -m 0755 -o postgres -g postgres /run/postgresql
  for f in postgresql.conf pg_hba.conf; do
    if [ -f ${cluster.dataDir}/$f ] && [ ! -L ${cluster.dataDir}/$f ]; then
      mv ${cluster.dataDir}/$f /etc/postgresql/${version(config)}/${cluster.name}/$f
    fi
    ln -sfn /etc/postgresql/${version(config)}/${cluster.name}/$f ${cluster.dataDir}/$f
  done
  cat > /etc/systemd/system/${cluster.service}.service <<UNIT
[Unit]
Description=PostgreSQL 18 ${cluster.name}
After=network.target

[Service]
Type=simple
User=postgres
Group=postgres
ExecStart=/usr/bin/postgres -D ${cluster.dataDir} -p ${cluster.port}
ExecReload=/bin/kill -HUP \$MAINPID
Restart=on-failure

[Install]
WantedBy=multi-user.target
UNIT
fi
systemctl daemon-reload
systemctl enable --now ${cluster.service} || true`;

export const bootstrapCommands = (
  config: DeployConfig,
  role: "primary" | "replica" | "pgbouncer" = "primary",
  cluster: PgCluster = pgClusterFor(config, "primary", { privateIp: "127.0.0.1", servicePort: 5432 }),
): string[] => [
  `if command -v apt-get >/dev/null 2>&1; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y postgresql-${version(config)} postgresql-contrib-${version(config)} pgbouncer
elif command -v pacman >/dev/null 2>&1; then
  pacman -Sy --noconfirm postgresql pgbouncer
else
  echo "unsupported package manager" >&2; exit 1
fi`,
  ensureClusterScript(config, cluster),
  ...(role === "primary" || role === "pgbouncer" ? ["systemctl enable --now pgbouncer || true"] : []),
];

/** pg_hba policy: TLS + SCRAM for every application/replication source. */
export const pgHbaSnippet = (config: DeployConfig, allowedSources: string[]): string => {
  const sources = [...new Set(allowedSources.filter((entry) => entry.length > 0))];
  return [
    "local   all             all                                     peer",
    "host    all             all             127.0.0.1/32            scram-sha-256",
    "host    all             all             ::1/128                 scram-sha-256",
    ...sources.flatMap((source) => [
      // PostgreSQL TLS material is not provisioned by this deploy, so a
      // non-TLS SCRAM rule is kept alongside hostssl. The core still uses the
      // private LAN and UFW allowlists; the hostssl rules apply when an
      // operator supplies certificates.
      `hostssl all             all             ${source}/32            scram-sha-256`,
      `host    all             all             ${source}/32            scram-sha-256`,
      `hostssl replication     all             ${source}/32            scram-sha-256`,
      `host    replication     all             ${source}/32            scram-sha-256`,
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
    ...ownershipReconcileSql(config),
    `-- pg_hba sources: ${allowed.join(",")}`,
  ].join("\n") + "\n";
};

/**
 * A database created by an earlier deploy under a different application role
 * (e.g. `core_user` before the env moved to `gw_core_user`) leaves tables the
 * configured role cannot read or migrate. Hand the database and every object
 * owned by another non-superuser role in `public` over to the configured role.
 * Idempotent; a no-op on a fresh or already-consistent database. Must be last
 * (it \connects to the application database).
 */
export const ownershipReconcileSql = (config: DeployConfig): string[] => [
  `ALTER DATABASE "${config.PG_DB_NAME}" OWNER TO "${config.PG_DB_USER}";`,
  `\\connect "${config.PG_DB_NAME}"`,
  `DO $$ DECLARE r record; BEGIN FOR r IN SELECT DISTINCT o.rolname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_roles o ON o.oid = c.relowner WHERE n.nspname = 'public' AND NOT o.rolsuper AND o.rolname <> '${config.PG_DB_USER}' LOOP EXECUTE format('REASSIGN OWNED BY %I TO %I', r.rolname, '${config.PG_DB_USER}'); END LOOP; END $$;`,
];

/** Slot creation + `pg_basebackup -R` for each replica (idempotent). */
export const replicaCommands = (
  primary: PgNodeRef | string,
  replica: PgNodeRef | string,
  config?: DeployConfig,
  cluster?: PgCluster,
): string[] => {
  const primaryIp = nodeEndpoint(primary);
  const primaryPort = nodePort(primary);
  const targetCluster = cluster ?? pgClusterFor(config ?? { PG_VERSION: "18" }, "replica", replica);
  const dataDir = targetCluster.dataDir;
  const user = config?.PG_REPLICATION_USER ?? "pg_replicator";
  const password = config?.PG_REPLICATION_PASSWORD ?? "";
  const slot = slotName(replica);
  const pgpassEntry = `${primaryIp}:${primaryPort}:*:${user}:${password}`;
  const autoConf = `${dataDir}/postgresql.auto.conf`;
  return [
    `install -d -m 0700 -o postgres -g postgres /var/lib/postgresql && (umask 077 && printf '%s\n' ${shellQuote(pgpassEntry)} > /var/lib/postgresql/.pgpass) && chown postgres:postgres /var/lib/postgresql/.pgpass && chmod 0600 /var/lib/postgresql/.pgpass`,
    // The cluster was created so Debian owns its config and systemd unit; the
    // base backup then replaces the empty data directory with the primary's.
    `systemctl stop ${targetCluster.service} || true`,
    `rm -rf ${dataDir}/*`,
    `runuser -u postgres -- env PGPASSWORD=${shellQuote(password)} pg_basebackup -h ${primaryIp} -p ${primaryPort} -U ${user} -D ${dataDir} -Fp -Xs -P -R -S ${shellQuote(slot)}`,
    `rm -f ${dataDir}/postgresql.conf ${dataDir}/pg_hba.conf && ln -sfn /etc/postgresql/${config?.PG_VERSION ?? "18"}/${targetCluster.name}/postgresql.conf ${dataDir}/postgresql.conf && ln -sfn /etc/postgresql/${config?.PG_VERSION ?? "18"}/${targetCluster.name}/pg_hba.conf ${dataDir}/pg_hba.conf`,
    `touch ${autoConf} && if grep -q '^primary_slot_name' ${autoConf}; then sed -i "s|^primary_slot_name = .*|primary_slot_name = '${slot}'|" ${autoConf}; else printf "primary_slot_name = '%s'\n" ${shellQuote(slot)} >> ${autoConf}; fi && chown -R postgres:postgres ${dataDir}`,
    `systemctl start ${targetCluster.service}`,
    `systemctl enable ${targetCluster.service}`,
  ];
};

/** The exact PgBouncer transaction-pooling configuration. */
export const pgbouncerIni = (config: DeployConfig, serverPort = 5432): string => `[databases]
${config.PG_DB_NAME} = host=127.0.0.1 port=${serverPort} dbname=${config.PG_DB_NAME} user=${config.PG_DB_USER} password=${config.PG_DB_PASSWORD}

[pgbouncer]
listen_addr = 0.0.0.0
listen_port = ${config.PGBOUNCER_PORT}
pool_mode = transaction
server_tls_sslmode = prefer
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
 * The systemd unit decides which account owns the PgBouncer config: Debian
 * and Ubuntu units run as `postgres` (and may not create a `pgbouncer` user),
 * while other distributions use `pgbouncer`. Resolve the unit user, fall back
 * to `postgres`, and only then set ownership so the service can read the
 * files.
 */
const pgbouncerConfigOwnership = (): string => {
  const ini = "/etc/pgbouncer/pgbouncer.ini";
  const userlist = "/etc/pgbouncer/userlist.txt";
  return [
    `pgbouncer_owner="$(systemctl show -p User --value pgbouncer 2>/dev/null)"`,
    `[ -n "$pgbouncer_owner" ] || pgbouncer_owner=pgbouncer`,
    `if ! id "$pgbouncer_owner" >/dev/null 2>&1; then pgbouncer_owner=postgres; fi`,
    `chown "$pgbouncer_owner:" ${ini} ${userlist}`,
    `chmod 0640 ${ini}`,
    `chmod 0600 ${userlist}`,
  ].join(" && ");
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
  const primaryCluster = pgClusterFor(config, "primary", primary);
  nodes.push(primaryIp);
  for (const command of bootstrapCommands(config, "primary", primaryCluster)) {
    commands.push(command);
    runner.run(primarySsh, command, { sudo: true });
  }
  const snippet = postgresConfigSnippet(config);
  write(runner, primarySsh, postgresMainConfigPath(config, primaryCluster), postgresMainConfigSnippet(config, primaryCluster), 0o644);
  const replicaRefs = replicas;
  const primaryAllowed = [
    primaryIp,
    ...replicaRefs.map((node) => nodeEndpoint(node)),
    ...parseNodeList(config.CORE_NODES).map((node) => node.privateIp),
    ...(config.CORE_PRIVATE_IP ? [config.CORE_PRIVATE_IP] : []),
    ...parseNodeList(config.BACKUP_NODE).map((node) => node.privateIp),
    ...parseNodeList(config.AUDIT_DB_NODE).map((node) => node.privateIp),
    ...parseNodeList(config.LOG_DB_NODE).map((node) => node.privateIp),
  ];
  write(runner, primarySsh, primaryCluster.hbaPath, pgHbaSnippet(config, primaryAllowed), 0o640);
  runner.run(primarySsh, `chown postgres:postgres ${primaryCluster.hbaPath} && chmod 0640 ${primaryCluster.hbaPath}`, { sudo: true });
  const bootstrapSqlPath = `/tmp/pg18-bootstrap-${process.pid}.sql`;
  write(runner, primarySsh, bootstrapSqlPath, primaryBootstrapSql(config, replicaRefs), 0o644);
  const bootstrap = `runuser -u postgres -- psql -v ON_ERROR_STOP=1 -f ${bootstrapSqlPath}`;
  commands.push(bootstrap);
  runner.run(primarySsh, bootstrap, { sudo: true });
  runner.run(primarySsh, `systemctl restart ${primaryCluster.service}`, { sudo: true });
  const primaryReady = `for i in $(seq 1 30); do pg_isready -h 127.0.0.1 -p ${primaryCluster.port} >/dev/null 2>&1 && exit 0; sleep 1; done; exit 1`;
  commands.push(primaryReady);
  runner.run(primarySsh, primaryReady, { sudo: true });
  const journalPartitionCron = `30 1 * * * root runuser -u postgres -- psql -p ${primaryCluster.port} -d ${config.PG_DB_NAME} -c 'SELECT ensure_journal_line_partitions(18)' >/var/log/pg-journal-partitions.log 2>&1`;
  runner.writeRemoteFile({
    target: primarySsh,
    path: "/etc/cron.d/pg-journal-partitions",
    content: `${journalPartitionCron}\n`,
    mode: 0o644,
    sudo: true,
  });
  commands.push("install /etc/cron.d/pg-journal-partitions");

  if (config.PGBOUNCER_ENABLED) {
    write(runner, primarySsh, "/etc/pgbouncer/pgbouncer.ini", pgbouncerIni(config, primaryCluster.port), 0o640);
    write(runner, primarySsh, "/etc/pgbouncer/userlist.txt", pgbouncerUserlist(config), 0o600);
    runner.run(primarySsh, pgbouncerConfigOwnership(), { sudo: true });
    const restart = "systemctl enable --now pgbouncer && systemctl restart pgbouncer";
    commands.push(restart);
    runner.run(primarySsh, restart, { sudo: true });
  }

  const pgbouncerHosts = new Set<string>([primarySsh.host]);
  for (const [index, replica] of replicaRefs.entries()) {
    const replicaSsh = nodeSsh(config, replica);
    const replicaIp = nodeEndpoint(replica);
    const replicaCluster = pgClusterFor(config, "replica", replica);
    nodes.push(replicaIp);
    for (const command of bootstrapCommands(config, "replica", replicaCluster)) {
      commands.push(command);
      runner.run(replicaSsh, command, { sudo: true });
    }
    write(runner, replicaSsh, postgresMainConfigPath(config, replicaCluster), postgresMainConfigSnippet(config, replicaCluster), 0o644);
    write(
      runner,
      replicaSsh,
      replicaCluster.hbaPath,
      pgHbaSnippet(config, [
        primaryIp,
        ...parseNodeList(config.BACKUP_NODE).map((node) => node.privateIp),
      ]),
      0o640,
    );
    runner.run(replicaSsh, `chown postgres:postgres ${replicaCluster.hbaPath} && chmod 0640 ${replicaCluster.hbaPath}`, { sudo: true });
    for (const command of replicaCommands(primary, replica, config, replicaCluster)) {
      commands.push(command);
      runner.run(replicaSsh, command, { sudo: true });
    }
    // One PgBouncer per host. A host that also runs the primary keeps the
    // primary pool; a replica-only host gets a pool pointed at its replica.
    if (config.PGBOUNCER_ENABLED && !pgbouncerHosts.has(replicaSsh.host)) {
      pgbouncerHosts.add(replicaSsh.host);
      write(runner, replicaSsh, "/etc/pgbouncer/pgbouncer.ini", pgbouncerIni(config, replicaCluster.port), 0o640);
      write(runner, replicaSsh, "/etc/pgbouncer/userlist.txt", pgbouncerUserlist(config), 0o600);
      runner.run(replicaSsh, pgbouncerConfigOwnership(), { sudo: true });
      const restart = "systemctl enable --now pgbouncer && systemctl restart pgbouncer";
      commands.push(restart);
      runner.run(replicaSsh, restart, { sudo: true });
    }
    const slot = slotName(replica, index);
    commands.push(`pg_create_physical_replication_slot('${slot}')`);
  }
  return { commands, nodes };
};
