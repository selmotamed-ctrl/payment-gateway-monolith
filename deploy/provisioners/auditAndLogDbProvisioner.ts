import { parseNodeList, type DeployConfig } from "../lib/configSchema";
import type { SshTarget } from "../lib/hostPlanner";
import { pgHbaSnippet, postgresConfigPath, type ProvisionReport, type ProvisionRunner } from "./postgres18Provisioner";

/**
 * Dedicated append-only audit database and monthly-partitioned operational log
 * database. The DDL is copied verbatim from the storage architecture.
 */

const AUDIT_DB_BASE = `CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS audit_records (
  seq_no              BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  id                  UUID         PRIMARY KEY,
  created_at          TIMESTAMPTZ  NOT NULL,
  ingested_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  actor_id            UUID         NOT NULL,
  actor_email         VARCHAR(191) NULL,
  role                VARCHAR(64)  NOT NULL,
  action              VARCHAR(96)  NOT NULL,
  entity_type         VARCHAR(64)  NOT NULL,
  entity_id           VARCHAR(64)  NOT NULL,
  merchant_id         UUID         NULL,
  approval_request_id UUID         NULL,
  request_id          VARCHAR(64)  NULL,
  client_ip           VARCHAR(45)  NULL,
  user_agent          TEXT         NULL,
  before_json         JSONB        NOT NULL,
  after_json          JSONB        NOT NULL,
  prev_hash           CHAR(64)     NOT NULL,
  row_hash            CHAR(64)     NOT NULL
);

CREATE INDEX IF NOT EXISTS audit_records_entity_idx
  ON audit_records (entity_type, entity_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS audit_records_actor_idx
  ON audit_records (actor_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS audit_records_created_brin_idx
  ON audit_records USING brin (created_at);

CREATE INDEX IF NOT EXISTS audit_records_trgm_search_idx
  ON audit_records USING gin (
    action gin_trgm_ops,
    entity_type gin_trgm_ops,
    entity_id gin_trgm_ops,
    actor_email gin_trgm_ops
  );

-- Immutability trigger: forbid UPDATE and DELETE even by table owner unless superuser maintenance
CREATE OR REPLACE FUNCTION forbid_audit_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AUDIT_TAMPER_PROHIBITED: audit_records is strictly append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_immutable ON audit_records;
CREATE TRIGGER trg_audit_immutable
  BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_records
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();

-- Least-privilege runtime privileges for pg_audit_writer
REVOKE UPDATE, DELETE, TRUNCATE ON audit_records FROM PUBLIC;
`;

const LOG_DB_BASE = `CREATE TABLE IF NOT EXISTS attempt_step_logs (
  id                     UUID         NOT NULL,
  attempt_id             UUID         NOT NULL,
  gateway_version_id     UUID         NOT NULL,
  phase                  VARCHAR(32)  NOT NULL,
  step_id                UUID         NULL,
  step_order             INT          NOT NULL,
  redacted_request_json  JSONB        NOT NULL,
  redacted_response_text TEXT         NOT NULL,
  http_status            INT          NULL,
  duration_ms            INT          NULL,
  outcome                VARCHAR(64)  NOT NULL,
  created_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE INDEX IF NOT EXISTS attempt_step_logs_attempt_idx
  ON attempt_step_logs (attempt_id, step_order ASC);

CREATE INDEX IF NOT EXISTS attempt_step_logs_created_brin_idx
  ON attempt_step_logs USING brin (created_at);

CREATE TABLE IF NOT EXISTS http_access_logs (
  id             BIGINT GENERATED ALWAYS AS IDENTITY,
  request_id     VARCHAR(64)  NOT NULL,
  channel        VARCHAR(24)  NOT NULL,
  method         VARCHAR(10)  NOT NULL,
  route_pattern  VARCHAR(191) NOT NULL,
  status_code    SMALLINT     NOT NULL,
  duration_ms    INT          NOT NULL,
  db_queries     SMALLINT     NOT NULL DEFAULT 0,
  db_duration_ms INT          NOT NULL DEFAULT 0,
  actor_id       UUID         NULL,
  client_ip      VARCHAR(45)  NULL,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE INDEX IF NOT EXISTS http_access_logs_created_brin_idx
  ON http_access_logs USING brin (created_at);
`;

const sqlIdentifier = (value: string): string => `"${value.replace(/"/g, '""')}"`;

/** Least-privilege runtime grants for the audit writer (append-only). */
export const auditRuntimeGrants = (role: string): string => {
  const writer = sqlIdentifier(role);
  return `-- Least-privilege runtime privileges for the audit writer
GRANT USAGE ON SCHEMA public TO ${writer};
GRANT SELECT, INSERT ON audit_records TO ${writer};
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${writer};
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT ON TABLES TO ${writer};
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${writer};
`;
};

/** Least-privilege runtime grants for the log writer (no UPDATE/DELETE/TRUNCATE). */
export const logRuntimeGrants = (role: string): string => {
  const writer = sqlIdentifier(role);
  return `-- Least-privilege runtime privileges for the log writer
GRANT USAGE ON SCHEMA public TO ${writer};
GRANT SELECT, INSERT ON attempt_step_logs, http_access_logs TO ${writer};
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${writer};
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT ON TABLES TO ${writer};
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${writer};
`;
};

/** The default-role DDL, kept as a stable export for operators and tests. */
export const AUDIT_DB_DDL = `${AUDIT_DB_BASE}\n${auditRuntimeGrants("pg_audit_writer")}`;
export const LOG_DB_DDL = `${LOG_DB_BASE}\n${logRuntimeGrants("pg_log_writer")}`;

export const auditDatabaseDdl = (config?: Pick<DeployConfig, "AUDIT_DB_USER">): string =>
  config ? `${AUDIT_DB_BASE}\n${auditRuntimeGrants(config.AUDIT_DB_USER)}` : AUDIT_DB_DDL;
export const logDatabaseDdl = (config?: Pick<DeployConfig, "LOG_DB_USER">): string =>
  config ? `${LOG_DB_BASE}\n${logRuntimeGrants(config.LOG_DB_USER)}` : LOG_DB_DDL;
export const auditDbDdl = auditDatabaseDdl;
export const logDbDdl = logDatabaseDdl;

const monthKey = (date: Date): string => `${date.getUTCFullYear()}_${String(date.getUTCMonth() + 1).padStart(2, "0")}`;

const monthStart = (date: Date): string =>
  `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-01`;

const nextMonth = (date: Date): Date => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));

/**
 * Creates the next N monthly partitions for both log tables plus the
 * maintenance function/cron SQL. Accepts (monthsAhead, now, retentionMonths)
 * or (now, monthsAhead, retentionMonths).
 */
export function ensureLogPartitions(monthsAhead?: number, now?: Date, retentionMonths?: number): string;
export function ensureLogPartitions(now?: Date, monthsAhead?: number, retentionMonths?: number): string;
export function ensureLogPartitions(first?: number | Date, second?: number | Date, third?: number): string {
  const monthsAhead = typeof first === "number" ? first : typeof second === "number" ? second : 6;
  const now = first instanceof Date ? first : second instanceof Date ? second : new Date();
  const retention = typeof third === "number" ? third : 12;
  const statements: string[] = [];
  for (let offset = 0; offset < monthsAhead; offset += 1) {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
    const end = nextMonth(start);
    const suffix = monthKey(start);
    for (const table of ["attempt_step_logs", "http_access_logs"] as const) {
      statements.push(
        `CREATE TABLE IF NOT EXISTS ${table}_${suffix} PARTITION OF ${table} FOR VALUES FROM ('${monthStart(start)}') TO ('${monthStart(end)}');`,
      );
    }
  }
  statements.push(`CREATE OR REPLACE FUNCTION ensure_log_partitions(months_ahead INT DEFAULT 6, retention_months INT DEFAULT 12)
RETURNS void AS $$
DECLARE
  offset INT;
  start_date DATE;
  end_date DATE;
  suffix TEXT;
  cutoff_date DATE;
  partition_name TEXT;
  partition_start DATE;
BEGIN
  FOR offset IN 0..months_ahead - 1 LOOP
    start_date := (date_trunc('month', now())::date + (offset || ' months')::interval)::date;
    end_date := (start_date + interval '1 month')::date;
    suffix := to_char(start_date, 'YYYY_MM');
    EXECUTE format('CREATE TABLE IF NOT EXISTS attempt_step_logs_%s PARTITION OF attempt_step_logs FOR VALUES FROM (%L) TO (%L)', suffix, start_date, end_date);
    EXECUTE format('CREATE TABLE IF NOT EXISTS http_access_logs_%s PARTITION OF http_access_logs FOR VALUES FROM (%L) TO (%L)', suffix, start_date, end_date);
  END LOOP;

  -- Retention is applied only to monthly partitions older than the configured
  -- window; the default partition and any non-monthly table are never touched.
  cutoff_date := (date_trunc('month', now()) - make_interval(months => retention_months))::date;
  FOR partition_name IN
    SELECT child.relname
    FROM pg_inherits
    JOIN pg_class parent ON parent.oid = pg_inherits.inhparent
    JOIN pg_class child ON child.oid = pg_inherits.inhrelid
    WHERE parent.relname = 'attempt_step_logs'
      AND child.relname ~ '^attempt_step_logs_[0-9]{4}_[0-9]{2}$'
  LOOP
    partition_start := to_date(right(partition_name, 7), 'YYYY_MM');
    IF partition_start < cutoff_date THEN
      EXECUTE format('DROP TABLE IF EXISTS %I', partition_name);
    END IF;
  END LOOP;
  FOR partition_name IN
    SELECT child.relname
    FROM pg_inherits
    JOIN pg_class parent ON parent.oid = pg_inherits.inhparent
    JOIN pg_class child ON child.oid = pg_inherits.inhrelid
    WHERE parent.relname = 'http_access_logs'
      AND child.relname ~ '^http_access_logs_[0-9]{4}_[0-9]{2}$'
  LOOP
    partition_start := to_date(right(partition_name, 7), 'YYYY_MM');
    IF partition_start < cutoff_date THEN
      EXECUTE format('DROP TABLE IF EXISTS %I', partition_name);
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

SELECT ensure_log_partitions(${monthsAhead}, ${retention});
`);
  return statements.join("\n");
}

export const LOG_PARTITION_MAINTENANCE_CRON = "15 1 * * *";
export const logPartitionCronLine = (config: DeployConfig): string =>
  `${LOG_PARTITION_MAINTENANCE_CRON} root su - postgres -c "psql -d ${config.LOG_DB_NAME} -c 'SELECT ensure_log_partitions(6, ${config.LOG_RETENTION_MONTHS})'" >/var/log/pg-log-partitions.log 2>&1`;

const nodeSsh = (config: DeployConfig, spec: { sshHost: string; sshPort: number }, kind: "audit" | "log"): SshTarget => ({
  host: spec.sshHost,
  port: spec.sshPort,
  user: kind === "audit" ? config.AUDIT_DB_SSH_USER : config.LOG_DB_SSH_USER,
  keyPath: (kind === "audit" ? config.AUDIT_DB_SSH_KEY_PATH : config.LOG_DB_SSH_KEY_PATH) ?? "",
  sudoPassword: kind === "audit" ? config.AUDIT_DB_SUDO_PASSWORD : config.LOG_DB_SUDO_PASSWORD,
});

const repositorySql = (config: DeployConfig, kind: "audit" | "log"): string => {
  const name = kind === "audit" ? config.AUDIT_DB_NAME : config.LOG_DB_NAME;
  const user = kind === "audit" ? config.AUDIT_DB_USER : config.LOG_DB_USER;
  const password = kind === "audit" ? config.AUDIT_DB_PASSWORD : config.LOG_DB_PASSWORD;
  return [
    `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${user}') THEN CREATE ROLE "${user}" LOGIN PASSWORD '${password}'; ELSE ALTER ROLE "${user}" PASSWORD '${password}'; END IF; END $$;`,
    `SELECT 'CREATE DATABASE "${name}" OWNER "${user}"' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${name}')\\gexec`,
  ].join("\n") + "\n";
};

const applySql = (
  runner: ProvisionRunner,
  ssh: SshTarget,
  path: string,
  sql: string,
  config: DeployConfig,
  database: string,
): void => {
  runner.writeRemoteFile({ target: ssh, path, content: sql, mode: 0o600, sudo: true });
  runner.run(ssh, `su - postgres -c "psql -v ON_ERROR_STOP=1 -d ${database} -f ${path}"`, { sudo: true });
};

export interface AuditLogProvisionInput {
  runner: ProvisionRunner;
  config: DeployConfig;
  dryRun?: boolean;
  now?: Date;
}

const auditLogConfigSnippet = (): string => `listen_addresses = '*'
wal_level = replica
max_wal_senders = 16
max_replication_slots = 16
`;

const allowedAuditLogSources = (config: DeployConfig): string[] => [
  ...parseNodeList(config.CORE_NODES).map((node) => node.privateIp),
  ...(config.CORE_PRIVATE_IP ? [config.CORE_PRIVATE_IP] : []),
  ...parseNodeList(config.BACKUP_NODE).map((node) => node.privateIp),
];

const configureAuditLogHost = (
  runner: ProvisionRunner,
  ssh: SshTarget,
  config: DeployConfig,
): void => {
  runner.writeRemoteFile({
    target: ssh,
    path: postgresConfigPath(config),
    content: auditLogConfigSnippet(),
    mode: 0o644,
    sudo: true,
  });
  runner.writeRemoteFile({
    target: ssh,
    path: `/etc/postgresql/${config.PG_VERSION}/main/pg_hba.conf`,
    content: pgHbaSnippet(config, allowedAuditLogSources(config)),
    mode: 0o600,
    sudo: true,
  });
  runner.run(ssh, "systemctl restart postgresql", { sudo: true });
};

export const provisionAuditAndLogDb = (input: AuditLogProvisionInput): ProvisionReport => {
  const { runner, config } = input;
  const commands: string[] = [];
  const nodes: string[] = [];
  const install = [
    "apt-get update",
    `DEBIAN_FRONTEND=noninteractive apt-get install -y postgresql-${config.PG_VERSION} postgresql-contrib-${config.PG_VERSION}`,
    "systemctl enable --now postgresql",
  ];
  const auditSpec = parseNodeList(config.AUDIT_DB_NODE)[0];
  if (auditSpec && config.AUDIT_DB_MANAGE_VIA_SSH) {
    const ssh = nodeSsh(config, auditSpec, "audit");
    nodes.push(auditSpec.privateIp);
    for (const command of install) {
      commands.push(command);
      runner.run(ssh, command, { sudo: true });
    }
    configureAuditLogHost(runner, ssh, config);
    const repoPath = `/tmp/pg-audit-bootstrap-${process.pid}.sql`;
    applySql(runner, ssh, repoPath, repositorySql(config, "audit"), config, "postgres");
    const ddlPath = `/tmp/pg-audit-ddl-${process.pid}.sql`;
    applySql(runner, ssh, ddlPath, auditDatabaseDdl(config), config, config.AUDIT_DB_NAME);
    commands.push("apply audit_records DDL + immutability trigger");
  }
  const logSpec = parseNodeList(config.LOG_DB_NODE)[0];
  if (logSpec && config.LOG_DB_MANAGE_VIA_SSH) {
    const ssh = nodeSsh(config, logSpec, "log");
    nodes.push(logSpec.privateIp);
    for (const command of install) {
      commands.push(command);
      runner.run(ssh, command, { sudo: true });
    }
    configureAuditLogHost(runner, ssh, config);
    const repoPath = `/tmp/pg-log-bootstrap-${process.pid}.sql`;
    applySql(runner, ssh, repoPath, repositorySql(config, "log"), config, "postgres");
    const ddlPath = `/tmp/pg-log-ddl-${process.pid}.sql`;
    applySql(runner, ssh, ddlPath, `${logDatabaseDdl(config)}\n${ensureLogPartitions(input.now ?? new Date(), 6, config.LOG_RETENTION_MONTHS)}`, config, config.LOG_DB_NAME);
    const cronPath = "/etc/cron.d/pg-log-partitions";
    runner.writeRemoteFile({ target: ssh, path: cronPath, content: `${logPartitionCronLine(config)}\n`, mode: 0o644, sudo: true });
    commands.push(`install ${cronPath}`);
  }
  return { commands, nodes };
};
