import {
  parseNodeList,
  type DeployConfig,
  type NodeSpec,
} from "../lib/configSchema";
import type { SshTarget } from "../lib/hostPlanner";
import { assertSingleLine, dollarTag, pgbouncerQuoted, pgpassField, shellQuote, sqlIdent, sqlLiteral } from "../lib/quoting";

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
  config: Pick<DeployConfig, "PG_VERSION"> & Partial<Pick<DeployConfig, "PG_RAM_GB" | "PG_IO_METHOD">>,
  cluster: PgCluster,
  /** The node's private IP: PostgreSQL binds to loopback + this address instead of '*'. */
  privateIp?: string,
): string => `data_directory = '${cluster.dataDir}'
hba_file = '${cluster.hbaPath}'
port = ${cluster.port}
${postgresConfigSnippet(config, privateIp ? `127.0.0.1,${privateIp}` : "*")}${postgresTlsSnippet(cluster)}`;

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
export const postgresConfigSnippet = (
  config?: Partial<Pick<DeployConfig, "PG_VERSION" | "PG_RAM_GB" | "PG_IO_METHOD">>,
  listenAddresses = "*",
): string => {
  // PG_RAM_GB derives the memory settings from the node's RAM; unset keeps the
  // reference 32 GB profile (8GB / 24GB / 1GB).
  const ram = config?.PG_RAM_GB;
  const sharedBuffers = ram ? Math.max(1, Math.floor(ram * 0.25)) : 8;
  const effectiveCache = ram ? Math.max(2, Math.floor(ram * 0.75)) : 24;
  const maintenanceMb = ram ? Math.min(2048, Math.max(256, Math.floor((ram * 1024) / 16))) : 1024;
  const maintenance = maintenanceMb % 1024 === 0 ? `${maintenanceMb / 1024}GB` : `${maintenanceMb}MB`;
  return `listen_addresses = '${listenAddresses}'
max_connections = 300
shared_buffers = ${sharedBuffers}GB
effective_cache_size = ${effectiveCache}GB
work_mem = 32MB
maintenance_work_mem = ${maintenance}
io_method = '${config?.PG_IO_METHOD ?? "worker"}'
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
timezone = 'UTC'
log_timezone = 'UTC'
`;
};

/** Per-cluster TLS directory, next to the cluster's pg_hba.conf. */
export const pgTlsDir = (cluster: PgCluster): string => `${cluster.hbaPath.slice(0, cluster.hbaPath.lastIndexOf("/"))}/tls`;

/** PostgreSQL server TLS settings (GAP-022). Material is provisioned by pgTlsCommands. */
export const postgresTlsSnippet = (cluster: PgCluster): string => {
  const dir = pgTlsDir(cluster);
  return `ssl = on
ssl_cert_file = '${dir}/server.crt'
ssl_key_file = '${dir}/server.key'
ssl_min_protocol_version = 'TLSv1.2'
password_encryption = 'scram-sha-256'
`;
};

/**
 * Idempotently creates the server key/certificate (self-signed, 0600 key owned
 * by postgres) unless an operator already installed one.
 */
export const pgTlsCommands = (cluster: PgCluster, hostName: string): string[] => {
  const dir = pgTlsDir(cluster);
  const subject = `/CN=${hostName.replace(/[^A-Za-z0-9.-]/g, "")}`;
  const key = shellQuote(`${dir}/server.key`);
  const crt = shellQuote(`${dir}/server.crt`);
  return [
    `install -d -m 0750 -o postgres -g postgres ${shellQuote(dir)} && if [ ! -s ${key} ] || [ ! -s ${crt} ]; then (umask 077 && openssl req -x509 -newkey rsa:4096 -nodes -sha256 -days 825 -subj ${shellQuote(subject)} -keyout ${key} -out ${crt}); fi && chown postgres:postgres ${key} ${crt} && chmod 0600 ${key} && chmod 0644 ${crt}`,
  ];
};

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
    "hostssl all            all             127.0.0.1/32            scram-sha-256",
    "hostssl all            all             ::1/128                 scram-sha-256",
    ...sources.flatMap((source) => [
      // TLS is provisioned by pgTlsCommands; there are no plain `host` rules (GAP-022).
      `hostssl all             all             ${source}/32            scram-sha-256`,
      `hostssl replication     all             ${source}/32            scram-sha-256`,
    ]),
  ].join("\n") + "\n";
};

/** Primary SQL: application role/database, replication role and TLS host rules. */
export const primaryBootstrapSql = (config: DeployConfig, replicas: Array<PgNodeRef | string>): string => {
  const replicaSources = replicas.map((node) => nodeEndpoint(node));
  const allowed = [...replicaSources];
  const appUser = sqlIdent(config.PG_DB_USER, "PG_DB_USER");
  const appUserLit = sqlLiteral(config.PG_DB_USER, "PG_DB_USER");
  const appPw = sqlLiteral(config.PG_DB_PASSWORD, "PG_DB_PASSWORD");
  const replUser = sqlIdent(config.PG_REPLICATION_USER, "PG_REPLICATION_USER");
  const replUserLit = sqlLiteral(config.PG_REPLICATION_USER, "PG_REPLICATION_USER");
  const replPw = sqlLiteral(config.PG_REPLICATION_PASSWORD, "PG_REPLICATION_PASSWORD");
  const dbName = sqlIdent(config.PG_DB_NAME, "PG_DB_NAME");
  const dbNameLit = sqlLiteral(config.PG_DB_NAME, "PG_DB_NAME");
  // Dollar-quote tag is chosen so it cannot occur in the (already SQL-escaped) body.
  const doBlock = (body: string): string => {
    const tag = dollarTag(body);
    return `DO ${tag} BEGIN ${body} END ${tag};`;
  };
  const createDb = sqlLiteral(`CREATE DATABASE ${dbName} OWNER ${appUser}`, "CREATE DATABASE");
  return [
    doBlock(`IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = ${appUserLit}) THEN CREATE ROLE ${appUser} LOGIN PASSWORD ${appPw}; ELSE ALTER ROLE ${appUser} PASSWORD ${appPw}; END IF;`),
    `SELECT ${createDb} WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = ${dbNameLit})\\gexec`,
    doBlock(`IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = ${replUserLit}) THEN CREATE ROLE ${replUser} WITH REPLICATION LOGIN PASSWORD ${replPw}; ELSE ALTER ROLE ${replUser} WITH REPLICATION LOGIN PASSWORD ${replPw}; END IF;`),
    ...replicas.map((node, index) => {
      const slot = sqlLiteral(slotName(node, index), "replication slot");
      return doBlock(`IF NOT EXISTS (SELECT FROM pg_replication_slots WHERE slot_name = ${slot}) THEN PERFORM pg_create_physical_replication_slot(${slot}); END IF;`);
    }),
    `-- pg_hba sources: ${allowed.join(",").replace(/[\r\n]/g, " ")}`,
  ].join("\n") + "\n";
};

/** Content of the replica's ~postgres/.pgpass (written over stdin, mode 0600). */
export const replicaPgpassContent = (
  primary: PgNodeRef | string,
  config: Pick<DeployConfig, "PG_REPLICATION_USER" | "PG_REPLICATION_PASSWORD">,
): string =>
  `${pgpassField(nodeEndpoint(primary))}:${nodePort(primary)}:*:${pgpassField(config.PG_REPLICATION_USER ?? "pg_replicator")}:${pgpassField(config.PG_REPLICATION_PASSWORD ?? "")}\n`;

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
  const slot = slotName(replica);
  const autoConf = `${dataDir}/postgresql.auto.conf`;
  return [
    // The .pgpass (replication password) is streamed over stdin by
    // provisionPostgres18 (writeRemoteFile); it never appears in argv (GAP-028).
    `install -d -m 0700 -o postgres -g postgres /var/lib/postgresql && test -s /var/lib/postgresql/.pgpass && chown postgres:postgres /var/lib/postgresql/.pgpass && chmod 0600 /var/lib/postgresql/.pgpass`,
    // The cluster was created so Debian owns its config and systemd unit; the
    // base backup then replaces the empty data directory with the primary's.
    // Destructive rebuild guard: a replica that already holds a cluster (PG_VERSION)
    // and is a standby (standby.signal) is left alone unless PG_REPLICA_REBUILD=true.
    `if [ -s ${shellQuote(`${dataDir}/PG_VERSION`)} ] && [ -f ${shellQuote(`${dataDir}/standby.signal`)} ] && [ ${config?.PG_REPLICA_REBUILD ? "0" : "1"} -eq 1 ]; then echo "replica ${slot} already initialised; skipping rebuild (set PG_REPLICA_REBUILD=true to re-clone)"; systemctl start ${targetCluster.service} || true; exit 0; fi
systemctl stop ${targetCluster.service} || true
rm -rf ${shellQuote(dataDir)}/*
runuser -u postgres -- env PGPASSFILE=/var/lib/postgresql/.pgpass PGSSLMODE=require pg_basebackup -h ${shellQuote(primaryIp)} -p ${primaryPort} -U ${shellQuote(user)} -D ${shellQuote(dataDir)} -Fp -Xs -P -R -S ${shellQuote(slot)}`,
    `rm -f ${dataDir}/postgresql.conf ${dataDir}/pg_hba.conf && ln -sfn /etc/postgresql/${config?.PG_VERSION ?? "18"}/${targetCluster.name}/postgresql.conf ${dataDir}/postgresql.conf && ln -sfn /etc/postgresql/${config?.PG_VERSION ?? "18"}/${targetCluster.name}/pg_hba.conf ${dataDir}/pg_hba.conf`,
    `touch ${autoConf} && if grep -q '^primary_slot_name' ${autoConf}; then sed -i "s|^primary_slot_name = .*|primary_slot_name = '${slot}'|" ${autoConf}; else printf "primary_slot_name = '%s'\n" ${shellQuote(slot)} >> ${autoConf}; fi && chown -R postgres:postgres ${dataDir}`,
    `systemctl start ${targetCluster.service}`,
    `systemctl enable ${targetCluster.service}`,
  ];
};

/** libpq-style conninfo value for pgbouncer.ini [databases]: single-quoted, `\` and `'` backslash-escaped. */
const connValue = (value: string): string =>
  `'${assertSingleLine(value, "pgbouncer value").replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

/** The exact PgBouncer transaction-pooling configuration. */
export const pgbouncerIni = (config: DeployConfig, serverPort = 5432): string => `[databases]
${assertSingleLine(config.PG_DB_NAME, "PG_DB_NAME")} = host=127.0.0.1 port=${serverPort} dbname=${connValue(config.PG_DB_NAME)} user=${connValue(config.PG_DB_USER)} password=${connValue(config.PG_DB_PASSWORD)}

[pgbouncer]
listen_addr = 0.0.0.0
listen_port = ${config.PGBOUNCER_PORT}
pool_mode = transaction
server_tls_sslmode = require
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
  `${pgbouncerQuoted(config.PG_DB_USER)} ${pgbouncerQuoted(config.PG_DB_PASSWORD)}\n${pgbouncerQuoted(config.PG_REPLICATION_USER)} ${pgbouncerQuoted(config.PG_REPLICATION_PASSWORD)}\n`;

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
  const primaryCluster = pgClusterFor(config, "primary", primary);
  nodes.push(primaryIp);
  for (const command of bootstrapCommands(config, "primary", primaryCluster)) {
    commands.push(command);
    runner.run(primarySsh, command, { sudo: true });
  }
  for (const command of pgTlsCommands(primaryCluster, primaryIp)) {
    commands.push(command);
    runner.run(primarySsh, command, { sudo: true });
  }
  write(runner, primarySsh, postgresMainConfigPath(config, primaryCluster), postgresMainConfigSnippet(config, primaryCluster, primaryIp), 0o644);
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
  // Secret-bearing SQL: private 0700 dir owned by postgres, 0600 file, removed on exit.
  const bootstrapDir = `/var/lib/postgresql/.pg18-bootstrap-${process.pid}`;
  const bootstrapSqlPath = `${bootstrapDir}/bootstrap.sql`;
  runner.run(primarySsh, `install -d -m 0700 -o postgres -g postgres ${shellQuote(bootstrapDir)}`, { sudo: true });
  write(runner, primarySsh, bootstrapSqlPath, primaryBootstrapSql(config, replicaRefs), 0o600);
  runner.run(primarySsh, `chown postgres:postgres ${shellQuote(bootstrapSqlPath)}`, { sudo: true });
  const bootstrap = `trap ${shellQuote(`rm -rf ${shellQuote(bootstrapDir)}`)} EXIT; runuser -u postgres -- psql -v ON_ERROR_STOP=1 -f ${shellQuote(bootstrapSqlPath)}`;
  commands.push(bootstrap);
  runner.run(primarySsh, bootstrap, { sudo: true });
  runner.run(primarySsh, `systemctl restart ${primaryCluster.service}`, { sudo: true });
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
    runner.run(primarySsh, "chown pgbouncer:pgbouncer /etc/pgbouncer/pgbouncer.ini /etc/pgbouncer/userlist.txt 2>/dev/null || true", { sudo: true });
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
    for (const command of pgTlsCommands(replicaCluster, replicaIp)) {
      commands.push(command);
      runner.run(replicaSsh, command, { sudo: true });
    }
    write(runner, replicaSsh, postgresMainConfigPath(config, replicaCluster), postgresMainConfigSnippet(config, replicaCluster, replicaIp), 0o644);
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
    runner.run(replicaSsh, "install -d -m 0700 -o postgres -g postgres /var/lib/postgresql", { sudo: true });
    write(runner, replicaSsh, "/var/lib/postgresql/.pgpass", replicaPgpassContent(primary, config), 0o600);
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
      runner.run(replicaSsh, "chown pgbouncer:pgbouncer /etc/pgbouncer/pgbouncer.ini /etc/pgbouncer/userlist.txt 2>/dev/null || true", { sudo: true });
      const restart = "systemctl enable --now pgbouncer && systemctl restart pgbouncer";
      commands.push(restart);
      runner.run(replicaSsh, restart, { sudo: true });
    }
    const slot = slotName(replica, index);
    commands.push(`pg_create_physical_replication_slot('${slot}')`);
  }
  return { commands, nodes };
};
