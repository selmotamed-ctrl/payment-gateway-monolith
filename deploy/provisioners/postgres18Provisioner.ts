import {
  parseNodeList,
  pgAppRoleEnabled,
  PGBOUNCER_SESSION_ALIAS,
  type DeployConfig,
  type NodeSpec,
} from "../lib/configSchema";
import {
  ensurePackagesScript,
  isChanged,
  outcomeBounced,
  parseApplyOutcome,
  pgbouncerApplyScript,
  pgbouncerRestartSignature,
  pgbouncerSystemdDropIn,
  PGBOUNCER_DROPIN_PATH,
  PGBOUNCER_SIGNATURE_PATH,
  postgresApplyScript,
  poolerLoginScript,
  type ApplyOutcome,
  type ProvisionRunner,
} from "../lib/converge";
import type { SshTarget } from "../lib/hostPlanner";
import { assertSingleLine, dollarTag, pgbouncerQuoted, pgpassField, shellQuote, sqlIdent, sqlLiteral } from "../lib/quoting";

/**
 * PostgreSQL 18 + PgBouncer provisioner.
 *
 * Every builder is pure so the exact configuration can be asserted in tests;
 * `provisionPostgres18` only performs remote work through the supplied runner.
 */

export type { ProvisionRunner };

/**
 * True when two node specs are the same PostgreSQL cluster (same SSH host and
 * service port, e.g. core + audit + log all on 5432). Such a cluster has ONE
 * postgresql.conf, pg_hba.conf and WAL archive stream, so only one provisioner
 * may own each of them.
 */
export const isSameCluster = (
  a: { sshHost: string; servicePort: number } | null | undefined,
  b: { sshHost: string; servicePort: number } | null | undefined,
): boolean => a != null && b != null && a.sshHost === b.sshHost && a.servicePort === b.servicePort;

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
  /** Restart every service even when nothing changed (`--force-restart`). */
  forceRestart?: boolean;
  primary?: PgNodeRef | null;
  replicas?: PgNodeRef[];
}

export interface ProvisionReport {
  commands: string[];
  nodes: string[];
  /** What happened to each managed service (`<host>:<service>` -> outcome); lets tests and the timing report prove nothing was bounced needlessly. */
  outcomes?: Record<string, ApplyOutcome>;
  /** Things the operator should read (for example how the memory settings were sized). */
  notes?: string[];
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

/**
 * Loopback + the node's private IP, de-duplicated: on a single-host install the
 * private IP IS 127.0.0.1, and PostgreSQL fails to start when it is told to
 * bind the same address twice ("could not bind IPv4 address ... Address already
 * in use").
 */
export const postgresListenAddresses = (privateIp?: string): string => {
  const addresses = ["127.0.0.1", ...(privateIp ?? "").split(",")]
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return [...new Set(addresses)].join(",");
};

export const postgresMainConfigSnippet = (
  config: Pick<DeployConfig, "PG_VERSION"> & Partial<Pick<DeployConfig, "PG_RAM_GB" | "PG_IO_METHOD">>,
  cluster: PgCluster,
  /** The node's private IP: PostgreSQL binds to loopback + this address instead of '*'. */
  privateIp?: string,
): string => `data_directory = '${cluster.dataDir}'
hba_file = '${cluster.hbaPath}'
port = ${cluster.port}
${postgresConfigSnippet(config, privateIp ? postgresListenAddresses(privateIp) : "*")}${postgresTlsSnippet(cluster)}`;

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

/** Prints the host's RAM in whole GB (read-only). */
export const MEM_TOTAL_GB_COMMAND = "awk '/^MemTotal:/ { printf \"%d\\n\", $2 / 1048576 }' /proc/meminfo";

/**
 * Memory sizing is a preflight, not a guess. With `PG_RAM_GB` unset the reference profile assumes a 32 GB host
 * (`shared_buffers = 8GB`, `effective_cache_size = 24GB`), which on a smaller machine either fails to start or
 * pushes the host into swap. So the host's real RAM is read and used when `PG_RAM_GB` is unset, and an explicit
 * `PG_RAM_GB` that the host cannot hold is refused instead of deployed. Pure: `detectedGb` is `undefined` when the
 * host could not be probed (a dry run, an unreadable `/proc/meminfo`).
 */
export const resolvePostgresSizing = (
  configuredGb: number | undefined,
  detectedGb: number | undefined,
  host: string,
): { ramGb: number | undefined; notes: string[] } => {
  const known = detectedGb !== undefined && Number.isFinite(detectedGb) && detectedGb > 0 ? detectedGb : undefined;
  if (known === undefined) {
    return {
      ramGb: configuredGb,
      notes: configuredGb
        ? []
        : [`${host}: PG_RAM_GB is not set and the host's RAM could not be read, so the 32 GB reference profile is used (shared_buffers = 8GB). Set PG_RAM_GB to the database host's RAM.`],
    };
  }
  if (configuredGb === undefined) {
    return { ramGb: known, notes: [`${host}: PG_RAM_GB is not set; memory settings are sized from the host's ${known} GB of RAM.`] };
  }
  if (configuredGb > known * 1.1 + 1) {
    throw new Error(
      `PG_RAM_GB=${configuredGb} exceeds the ${known} GB of RAM that ${host} has: shared_buffers and effective_cache_size would not fit. `
      + "Lower PG_RAM_GB (or unset it to size from the host).",
    );
  }
  return { ramGb: configuredGb, notes: [] };
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
# /run is a tmpfs, so the socket directory is gone after every reboot. Without
# this the postmaster dies with "could not create lock file
# /run/postgresql/.s.PGSQL.<port>.lock" and never comes back up.
RuntimeDirectory=postgresql
RuntimeDirectoryMode=2775
ExecStart=/usr/bin/postgres -D ${cluster.dataDir} -p ${cluster.port}
ExecReload=/bin/kill -HUP \\$MAINPID
# SIGINT = fast shutdown. The default SIGTERM is a smart shutdown that waits for every session to end.
KillSignal=SIGINT
TimeoutStopSec=60s
Restart=on-failure

[Install]
WantedBy=multi-user.target
UNIT
fi
systemctl daemon-reload
# Started (with the final configuration) by applyPostgresCluster, not here.
systemctl enable ${cluster.service} >/dev/null 2>&1 || true`;

/**
 * PostgreSQL server + client packages (pg_ctl, initdb, pg_basebackup, pg_dump, psql ...).
 * Shared by the cluster bootstrap and by the backup host, which needs the same
 * binaries even when it is a dedicated backup-only machine.
 */
export const postgresServerPackages = (
  config: Pick<DeployConfig, "PG_VERSION">,
): { debian: string[]; arch: string[] } => ({
  debian: [`postgresql-${version(config)}`, `postgresql-client-${version(config)}`, `postgresql-contrib-${version(config)}`],
  arch: ["postgresql"],
});

export const bootstrapCommands = (
  config: DeployConfig,
  role: "primary" | "replica" | "pgbouncer" = "primary",
  cluster: PgCluster = pgClusterFor(config, "primary", { privateIp: "127.0.0.1", servicePort: 5432 }),
): string[] => [
  `if ! command -v apt-get >/dev/null 2>&1 && ! command -v pacman >/dev/null 2>&1; then echo "unsupported package manager" >&2; exit 1; fi
${ensurePackagesScript({
    debian: [...postgresServerPackages(config).debian, "pgbouncer"],
    arch: [...postgresServerPackages(config).arch, "pgbouncer"],
  })}`,
  ensureClusterScript(config, cluster),
  // Enabled for boot, started by applyPgbouncer with its final configuration.
  ...(role === "primary" || role === "pgbouncer" ? ["systemctl enable pgbouncer >/dev/null 2>&1 || true"] : []),
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

/**
 * Idempotent creation of the streaming-replication role (used by replicas,
 * Barman and the pg-native daemon).
 */
export const replicationRoleSql = (config: Pick<DeployConfig, "PG_REPLICATION_USER" | "PG_REPLICATION_PASSWORD">): string => {
  const replUser = sqlIdent(config.PG_REPLICATION_USER, "PG_REPLICATION_USER");
  const replUserLit = sqlLiteral(config.PG_REPLICATION_USER, "PG_REPLICATION_USER");
  const replPw = sqlLiteral(config.PG_REPLICATION_PASSWORD, "PG_REPLICATION_PASSWORD");
  const body = `IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = ${replUserLit}) THEN CREATE ROLE ${replUser} WITH REPLICATION LOGIN PASSWORD ${replPw}; ELSE ALTER ROLE ${replUser} WITH REPLICATION LOGIN PASSWORD ${replPw}; END IF;`;
  const tag = dollarTag(body);
  return `DO ${tag} BEGIN ${body} END ${tag};`;
};

/** Primary SQL: application role/database, replication role and TLS host rules. */
export const primaryBootstrapSql = (config: DeployConfig, replicas: Array<PgNodeRef | string>): string => {
  const replicaSources = replicas.map((node) => nodeEndpoint(node));
  const allowed = [...replicaSources];
  const appUser = sqlIdent(config.PG_DB_USER, "PG_DB_USER");
  const appUserLit = sqlLiteral(config.PG_DB_USER, "PG_DB_USER");
  const appPw = sqlLiteral(config.PG_DB_PASSWORD, "PG_DB_PASSWORD");
  const dbName = sqlIdent(config.PG_DB_NAME, "PG_DB_NAME");
  const dbNameLit = sqlLiteral(config.PG_DB_NAME, "PG_DB_NAME");
  // Dollar-quote tag is chosen so it cannot occur in the (already SQL-escaped) body.
  const doBlock = (body: string): string => {
    const tag = dollarTag(body);
    return `DO ${tag} BEGIN ${body} END ${tag};`;
  };
  const createDb = sqlLiteral(`CREATE DATABASE ${dbName} OWNER ${appUser}`, "CREATE DATABASE");
  // The runtime login role: a plain LOGIN member of `pgw_app` (DML only; no DDL, no UPDATE/DELETE/TRUNCATE on the
  // ledger and audit tables). `pgw_app` itself is also created by the append-only migration; creating it here first
  // lets the role exist before the first migration runs, and the migration's own IF NOT EXISTS keeps both safe.
  const runtimeRole = pgAppRoleEnabled(config)
    ? [
        doBlock(`IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'pgw_app') THEN CREATE ROLE pgw_app NOLOGIN; END IF;`),
        doBlock(`IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = ${sqlLiteral(config.PG_APP_USER, "PG_APP_USER")}) THEN CREATE ROLE ${sqlIdent(config.PG_APP_USER, "PG_APP_USER")} LOGIN PASSWORD ${sqlLiteral(config.PG_APP_PASSWORD, "PG_APP_PASSWORD")} NOSUPERUSER NOCREATEDB NOCREATEROLE; ELSE ALTER ROLE ${sqlIdent(config.PG_APP_USER, "PG_APP_USER")} PASSWORD ${sqlLiteral(config.PG_APP_PASSWORD, "PG_APP_PASSWORD")} NOSUPERUSER NOCREATEDB NOCREATEROLE; END IF;`),
        `GRANT pgw_app TO ${sqlIdent(config.PG_APP_USER, "PG_APP_USER")};`,
      ]
    : [];
  return [
    doBlock(`IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = ${appUserLit}) THEN CREATE ROLE ${appUser} LOGIN PASSWORD ${appPw}; ELSE ALTER ROLE ${appUser} PASSWORD ${appPw}; END IF;`),
    ...runtimeRole,
    `SELECT ${createDb} WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = ${dbNameLit})\\gexec`,
    replicationRoleSql(config),
    ...replicas.map((node, index) => {
      const slot = sqlLiteral(slotName(node, index), "replication slot");
      return doBlock(`IF NOT EXISTS (SELECT FROM pg_replication_slots WHERE slot_name = ${slot}) THEN PERFORM pg_create_physical_replication_slot(${slot}); END IF;`);
    }),
    ...ownershipReconcileSql(config),
    `-- pg_hba sources: ${allowed.join(",").replace(/[\r\n]/g, " ")}`,
  ].join("\n") + "\n";
};

/** Content of the replica's ~postgres/.pgpass (written over stdin, mode 0600). */
export const replicaPgpassContent = (
  primary: PgNodeRef | string,
  config: Pick<DeployConfig, "PG_REPLICATION_USER" | "PG_REPLICATION_PASSWORD">,
): string =>
  `${pgpassField(nodeEndpoint(primary))}:${nodePort(primary)}:*:${pgpassField(config.PG_REPLICATION_USER ?? "pg_replicator")}:${pgpassField(config.PG_REPLICATION_PASSWORD ?? "")}\n`;

/**
 * A database created by an earlier deploy under a different application role
 * (e.g. `core_user` before the env moved to `gw_core_user`) leaves tables the
 * configured role cannot read or migrate. Hand the database and every object
 * owned by another non-superuser role in `public` over to the configured role.
 * Idempotent; a no-op on a fresh or already-consistent database. Must be last
 * (it runs \connect against the application database). Identifiers/literals are quoted.
 */
export const ownershipReconcileSql = (config: DeployConfig): string[] => {
  const dbName = sqlIdent(config.PG_DB_NAME, "PG_DB_NAME");
  const appUser = sqlIdent(config.PG_DB_USER, "PG_DB_USER");
  const appUserLit = sqlLiteral(config.PG_DB_USER, "PG_DB_USER");
  const body = `DECLARE r record; BEGIN FOR r IN SELECT DISTINCT o.rolname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_roles o ON o.oid = c.relowner WHERE n.nspname = 'public' AND NOT o.rolsuper AND o.rolname <> ${appUserLit} LOOP EXECUTE format('REASSIGN OWNED BY %I TO %I', r.rolname, ${appUserLit}); END LOOP; END`;
  const tag = dollarTag(body);
  return [
    `ALTER DATABASE ${dbName} OWNER TO ${appUser};`,
    `\\connect ${dbName}`,
    `DO ${tag} ${body} ${tag};`,
  ];
};

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
  const user = config?.PG_REPLICATION_USER ?? "gw_replicator";
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

export const PGBOUNCER_TLS_DIR = "/etc/pgbouncer/tls";
export const PGBOUNCER_TLS_KEY = `${PGBOUNCER_TLS_DIR}/server.key`;
export const PGBOUNCER_TLS_CERT = `${PGBOUNCER_TLS_DIR}/server.crt`;

/**
 * The exact PgBouncer configuration.
 *
 * Each client connects as ITSELF and PgBouncer opens the server connection with the same user and the password
 * from the auth file. The `[databases]` entries used to force `user=PG_DB_USER password=...`, so every session
 * the database saw was the table OWNER whatever role the application logged in with: the non-owner `pgw_app`
 * role (and with it the append-only ledger protection) could never take effect through the pooler.
 *
 * The client side requires TLS (`client_tls_sslmode = require`): the core reaches PgBouncer across hosts, and the
 * link used to be plaintext. The certificate is self-signed per host, so clients encrypt without verifying it
 * (`sslmode=no-verify`), exactly like the direct PostgreSQL links.
 *
 * The application database stays in transaction mode (the pooler's reason to
 * exist). A second alias, `pgw_session`, maps to the SAME real database with
 * `pool_mode=session`, because PostgreSQL advisory locks live on a backend
 * session. Singleton workers connect only through the session alias.
 */
export const pgbouncerIni = (config: DeployConfig, serverPort = 5432): string => {
  const coreNodes = parseNodeList(config.CORE_NODES).length || 1;
  const sessionPoolSize = Math.max(8, coreNodes * 2 + 4);
  return `[databases]
${assertSingleLine(config.PG_DB_NAME, "PG_DB_NAME")} = host=127.0.0.1 port=${serverPort} dbname=${connValue(config.PG_DB_NAME)}
${PGBOUNCER_SESSION_ALIAS} = host=127.0.0.1 port=${serverPort} dbname=${connValue(config.PG_DB_NAME)} pool_mode=session pool_size=${sessionPoolSize}

[pgbouncer]
listen_addr = 0.0.0.0
listen_port = ${config.PGBOUNCER_PORT}
pool_mode = transaction
server_tls_sslmode = require
client_tls_sslmode = require
client_tls_key_file = ${PGBOUNCER_TLS_KEY}
client_tls_cert_file = ${PGBOUNCER_TLS_CERT}
max_client_conn = ${config.PGBOUNCER_MAX_CLIENT_CONN}
default_pool_size = ${config.PGBOUNCER_DEFAULT_POOL_SIZE}
reserve_pool_size = 10
max_prepared_statements = ${config.PGBOUNCER_MAX_PREPARED_STATEMENTS}
server_reset_query_always = 0
ignore_startup_parameters = extra_float_digits,search_path
auth_type = scram-sha-256
auth_file = /etc/pgbouncer/userlist.txt
`;
};

export const pgbouncerUserlist = (config: DeployConfig): string =>
  `${pgbouncerQuoted(config.PG_DB_USER)} ${pgbouncerQuoted(config.PG_DB_PASSWORD)}\n`
  + (pgAppRoleEnabled(config) ? `${pgbouncerQuoted(config.PG_APP_USER)} ${pgbouncerQuoted(config.PG_APP_PASSWORD)}\n` : "")
  + `${pgbouncerQuoted(config.PG_REPLICATION_USER)} ${pgbouncerQuoted(config.PG_REPLICATION_PASSWORD)}\n`;

/**
 * Creates (once) the self-signed certificate PgBouncer presents to its clients and hands it to the account the
 * PgBouncer unit runs as. Idempotent: an existing certificate is kept, so a re-deploy does not rotate it.
 */
export const pgbouncerTlsCommand = (hostName: string): string => {
  const subject = `/CN=${hostName.replace(/[^A-Za-z0-9.-]/g, "")}`;
  return [
    `install -d -m 0750 ${PGBOUNCER_TLS_DIR}`,
    `if [ ! -s ${PGBOUNCER_TLS_KEY} ] || [ ! -s ${PGBOUNCER_TLS_CERT} ]; then (umask 077 && openssl req -x509 -newkey rsa:4096 -nodes -sha256 -days 825 -subj ${shellQuote(subject)} -keyout ${PGBOUNCER_TLS_KEY} -out ${PGBOUNCER_TLS_CERT}); fi`,
    `pgbouncer_owner="$(systemctl show -p User --value pgbouncer 2>/dev/null)"`,
    `[ -n "$pgbouncer_owner" ] || pgbouncer_owner=pgbouncer`,
    `if ! id "$pgbouncer_owner" >/dev/null 2>&1; then pgbouncer_owner=postgres; fi`,
    `chown "$pgbouncer_owner:" ${PGBOUNCER_TLS_DIR} ${PGBOUNCER_TLS_KEY} ${PGBOUNCER_TLS_CERT}`,
    `chmod 0600 ${PGBOUNCER_TLS_KEY}`,
    `chmod 0644 ${PGBOUNCER_TLS_CERT}`,
  ].join(" && ");
};

/** Writes a root-owned file and reports whether its content changed. */
const write = (runner: ProvisionRunner, target: SshTarget, path: string, content: string, mode = 0o600): boolean =>
  isChanged(runner.writeRemoteFile({ target, path, content, mode, sudo: true }));

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
 * Brings one PostgreSQL cluster to its configured state with the least
 * disruption (see postgresApplyScript): start if down, reload on a config
 * change, restart only for a postmaster-level (`pending_restart`) change.
 */
export const applyPostgresCluster = (input: {
  runner: ProvisionRunner;
  ssh: SshTarget;
  cluster: PgCluster;
  /** A config/hba file (or ALTER SYSTEM) changed since the last apply. */
  changed: boolean;
  force?: boolean;
  commands?: string[];
  outcomes?: Record<string, ApplyOutcome>;
}): ApplyOutcome => {
  const script = postgresApplyScript({ unit: input.cluster.service, port: input.cluster.port, changed: input.changed, force: input.force });
  input.commands?.push(script);
  const outcome = parseApplyOutcome(String(input.runner.capture(input.ssh, script, { sudo: true, timeoutMs: 5 * 60_000 })));
  if (input.outcomes) input.outcomes[`${input.ssh.host}:${input.cluster.service}`] = outcome;
  return outcome;
};

/**
 * Writes PgBouncer's configuration, its fast-stop systemd drop-in and applies
 * it: reload for ordinary changes, restart only for restart-only settings or
 * after the upstream PostgreSQL bounced, start if down, otherwise nothing.
 */
export const applyPgbouncer = (input: {
  runner: ProvisionRunner;
  ssh: SshTarget;
  config: DeployConfig;
  serverPort: number;
  /** The upstream PostgreSQL was started/restarted in this run (its server connections are gone). */
  upstreamBounced: boolean;
  force?: boolean;
  commands?: string[];
  outcomes?: Record<string, ApplyOutcome>;
}): ApplyOutcome => {
  const { runner, ssh, config } = input;
  const ini = pgbouncerIni(config, input.serverPort);
  const iniChanged = write(runner, ssh, "/etc/pgbouncer/pgbouncer.ini", ini, 0o640);
  const userlistChanged = write(runner, ssh, "/etc/pgbouncer/userlist.txt", pgbouncerUserlist(config), 0o600);
  const dropInChanged = write(runner, ssh, PGBOUNCER_DROPIN_PATH, pgbouncerSystemdDropIn(), 0o644);
  const signatureChanged = write(runner, ssh, PGBOUNCER_SIGNATURE_PATH, pgbouncerRestartSignature(ini), 0o644);
  runner.run(ssh, pgbouncerConfigOwnership(), { sudo: true });
  // The key and certificate must exist, readable by the PgBouncer account, before it starts with client TLS.
  runner.run(ssh, pgbouncerTlsCommand(ssh.host), { sudo: true });
  const script = pgbouncerApplyScript({
    port: config.PGBOUNCER_PORT,
    daemonReload: dropInChanged,
    restart: input.force === true || input.upstreamBounced || signatureChanged,
    reload: iniChanged || userlistChanged,
  });
  input.commands?.push(script);
  const outcome = parseApplyOutcome(String(runner.capture(ssh, script, { sudo: true, timeoutMs: 5 * 60_000 })));
  if (input.outcomes) input.outcomes[`${ssh.host}:pgbouncer`] = outcome;
  return outcome;
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
  const outcomes: Record<string, ApplyOutcome> = {};
  for (const command of bootstrapCommands(config, "primary", primaryCluster)) {
    commands.push(command);
    runner.run(primarySsh, command, { sudo: true });
  }
  for (const command of pgTlsCommands(primaryCluster, primaryIp)) {
    commands.push(command);
    runner.run(primarySsh, command, { sudo: true });
  }
  const notes: string[] = [];
  const sized = (target: SshTarget): DeployConfig => {
    const detected = runner.dryRun ? undefined : Number.parseInt(String(runner.capture(target, MEM_TOTAL_GB_COMMAND, { sudo: false })).trim(), 10);
    const sizing = resolvePostgresSizing(config.PG_RAM_GB, Number.isFinite(detected) ? detected : undefined, target.host);
    notes.push(...sizing.notes);
    return sizing.ramGb === undefined ? config : { ...config, PG_RAM_GB: sizing.ramGb };
  };
  const confChanged = write(runner, primarySsh, postgresMainConfigPath(config, primaryCluster), postgresMainConfigSnippet(sized(primarySsh), primaryCluster, primaryIp), 0o644);
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
  const hbaChanged = write(runner, primarySsh, primaryCluster.hbaPath, pgHbaSnippet(config, primaryAllowed), 0o640);
  runner.run(primarySsh, `chown postgres:postgres ${primaryCluster.hbaPath} && chmod 0640 ${primaryCluster.hbaPath}`, { sudo: true });
  // Start / reload / (only if a postmaster setting changed) restart, then wait
  // for readiness. The bootstrap SQL below needs a running server.
  const primaryOutcome = applyPostgresCluster({
    runner,
    ssh: primarySsh,
    cluster: primaryCluster,
    changed: confChanged || hbaChanged,
    force: input.forceRestart,
    commands,
    outcomes,
  });
  // Secret-bearing SQL: private 0700 dir owned by postgres, 0600 file, removed on exit.
  const bootstrapDir = `/var/lib/postgresql/.pg18-bootstrap-${process.pid}`;
  const bootstrapSqlPath = `${bootstrapDir}/bootstrap.sql`;
  runner.run(primarySsh, `install -d -m 0700 -o postgres -g postgres ${shellQuote(bootstrapDir)}`, { sudo: true });
  write(runner, primarySsh, bootstrapSqlPath, primaryBootstrapSql(config, replicaRefs), 0o600);
  runner.run(primarySsh, `chown postgres:postgres ${shellQuote(bootstrapSqlPath)}`, { sudo: true });
  const bootstrap = `trap ${shellQuote(`rm -rf ${shellQuote(bootstrapDir)}`)} EXIT; runuser -u postgres -- psql -v ON_ERROR_STOP=1 -p ${primaryCluster.port} -f ${shellQuote(bootstrapSqlPath)}`;
  commands.push(bootstrap);
  runner.run(primarySsh, bootstrap, { sudo: true });
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
    applyPgbouncer({
      runner,
      ssh: primarySsh,
      config,
      serverPort: primaryCluster.port,
      upstreamBounced: outcomeBounced(primaryOutcome),
      force: input.forceRestart,
      commands,
      outcomes,
    });
    // The bootstrap SQL may just have (re)created the database or role; make
    // sure the pooler really serves it before anything migrates through it.
    const login = poolerLoginScript({
      port: config.PGBOUNCER_PORT,
      database: config.PG_DB_NAME,
      user: config.PG_DB_USER,
      pgpassLine: `${pgpassField("127.0.0.1")}:${config.PGBOUNCER_PORT}:${pgpassField(config.PG_DB_NAME)}:${pgpassField(config.PG_DB_USER)}:${pgpassField(config.PG_DB_PASSWORD)}`,
    });
    commands.push(login);
    runner.run(primarySsh, login, { sudo: false, timeoutMs: 2 * 60_000 });

    // The singleton workers use the session alias for their advisory locks.
    // Prove it is served before core starts: a reload normally publishes a new
    // [databases] entry, but a restart is the safe fallback if it did not.
    const leaderLogin = poolerLoginScript({
      port: config.PGBOUNCER_PORT,
      database: PGBOUNCER_SESSION_ALIAS,
      user: config.PG_DB_USER,
      pgpassLine: `${pgpassField("127.0.0.1")}:${config.PGBOUNCER_PORT}:${pgpassField(PGBOUNCER_SESSION_ALIAS)}:${pgpassField(config.PG_DB_USER)}:${pgpassField(config.PG_DB_PASSWORD)}`,
    });
    commands.push(leaderLogin);
    try {
      runner.run(primarySsh, leaderLogin, { sudo: false, timeoutMs: 2 * 60_000 });
    } catch {
      runner.run(primarySsh, "systemctl restart pgbouncer", { sudo: true, timeoutMs: 2 * 60_000 });
      runner.run(primarySsh, leaderLogin, { sudo: false, timeoutMs: 2 * 60_000 });
    }
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
    const replicaConfChanged = write(runner, replicaSsh, postgresMainConfigPath(config, replicaCluster), postgresMainConfigSnippet(sized(replicaSsh), replicaCluster, replicaIp), 0o644);
    const replicaHbaChanged = write(
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
    // An already-initialised standby is only started by replicaCommands; apply
    // its (possibly changed) configuration with reload / pending-restart.
    const replicaOutcome = applyPostgresCluster({
      runner,
      ssh: replicaSsh,
      cluster: replicaCluster,
      changed: replicaConfChanged || replicaHbaChanged,
      force: input.forceRestart,
      commands,
      outcomes,
    });
    // One PgBouncer per host. A host that also runs the primary keeps the
    // primary pool; a replica-only host gets a pool pointed at its replica.
    if (config.PGBOUNCER_ENABLED && !pgbouncerHosts.has(replicaSsh.host)) {
      pgbouncerHosts.add(replicaSsh.host);
      applyPgbouncer({
        runner,
        ssh: replicaSsh,
        config,
        serverPort: replicaCluster.port,
        upstreamBounced: outcomeBounced(replicaOutcome),
        force: input.forceRestart,
        commands,
        outcomes,
      });
    }
    const slot = slotName(replica, index);
    commands.push(`pg_create_physical_replication_slot('${slot}')`);
  }
  return { commands, nodes, outcomes, ...(notes.length > 0 ? { notes } : {}) };
};
