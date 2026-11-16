import type { DeployConfig } from "./configSchema";
import type { DeployPlan, StorageNodePlan } from "./hostPlanner";
import { sqlIdent, sqlLiteral, shellQuote } from "./quoting";
import type { SshRunner } from "./sshRunner";

export interface FreshStorageOptions {
  runner: SshRunner;
  config: DeployConfig;
  plan: DeployPlan;
  includePostgres: boolean;
  includeRedis: boolean;
  includeAuditLog: boolean;
  includeObjectStorage: boolean;
  includeFakeRails: boolean;
}

export interface FreshStorageState {
  nonEmpty: boolean;
  unknown: string[];
  details: string[];
}

const databaseNames = (config: DeployConfig, includePostgres: boolean, includeAuditLog: boolean): Array<{ node: StorageNodePlan | null; name: string; label: string }> => {
  const names: Array<{ node: StorageNodePlan | null; name: string; label: string }> = [];
  if (includePostgres) {
    names.push({ node: null, name: config.PG_DB_NAME, label: "PostgreSQL/Live" });
    if (config.SANDBOX_ENABLED) names.push({ node: null, name: config.SANDBOX_DB_NAME, label: "PostgreSQL/Sandbox" });
  }
  if (includeAuditLog) {
    if (config.AUDIT_DB_NAME) names.push({ node: null, name: config.AUDIT_DB_NAME, label: "PostgreSQL/Audit" });
    if (config.LOG_DB_NAME) names.push({ node: null, name: config.LOG_DB_NAME, label: "PostgreSQL/Log" });
  }
  return names;
};

const postgresPrimary = (plan: DeployPlan): StorageNodePlan | null => plan.storage.postgres.primary;

const pgCommand = (node: StorageNodePlan, port: number, database: string, sql: string): string =>
  `runuser -u postgres -- psql -p ${port} -d ${shellQuote(database)} -v ON_ERROR_STOP=1 -Atc ${shellQuote(sql)}`;

const probeDatabase = (
  runner: SshRunner,
  node: StorageNodePlan,
  database: string,
): { nonEmpty: boolean; unknown?: string } => {
  const port = node.servicePort || 5432;
  try {
    runner.capture(node.ssh, `runuser -u postgres -- pg_isready -h 127.0.0.1 -p ${port} >/dev/null 2>&1`, { sudo: true });
  } catch {
    // No PostgreSQL on this host yet: this is a genuinely empty fresh host.
    return { nonEmpty: false };
  }
  try {
    const exists = runner.capture(
      node.ssh,
      pgCommand(node, port, "postgres", `SELECT 1 FROM pg_database WHERE datname = ${sqlLiteral(database)}`),
      { sudo: true },
    ).trim();
    if (exists !== "1") return { nonEmpty: false };
    const count = runner.capture(
      node.ssh,
      pgCommand(node, port, database, "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'"),
      { sudo: true },
    ).trim();
    if (!/^\d+$/.test(count)) return { nonEmpty: false, unknown: `${database}: unexpected table count '${count.slice(0, 40)}'` };
    return { nonEmpty: Number(count) > 0 };
  } catch (error) {
    return { nonEmpty: false, unknown: `${database}: ${(error as Error).message.split("\n")[0]?.slice(0, 120)}` };
  }
};

export const probeFreshStorage = (options: FreshStorageOptions): FreshStorageState => {
  const { runner, config, plan, includePostgres, includeRedis, includeAuditLog, includeObjectStorage, includeFakeRails } = options;
  const details: string[] = [];
  const unknown: string[] = [];

  if (includePostgres || includeAuditLog) {
    const primary = postgresPrimary(plan);
    const auditNode = plan.storage.auditDb;
    const logNode = plan.storage.logDb;
    const targets = databaseNames(config, includePostgres, includeAuditLog).map((entry) => ({
      ...entry,
      node: entry.label.endsWith("Audit") ? auditNode : entry.label.endsWith("Log") ? logNode : primary,
    }));
    for (const target of targets) {
      if (!target.node) continue;
      const state = probeDatabase(runner, target.node, target.name);
      if (state.unknown) unknown.push(state.unknown);
      if (state.nonEmpty) details.push(`${target.label} database '${target.name}' already has tables`);
    }
  }

  if (includeRedis) {
    for (const node of plan.storage.redis) {
      try {
        const out = runner.capture(
          node.ssh,
          `REDISCLI_AUTH=${shellQuote(config.REDIS_PASSWORD ?? "")} redis-cli -h 127.0.0.1 -p ${node.servicePort} DBSIZE`,
          { sudo: false },
        ).trim();
        if (/^\d+$/.test(out) && Number(out) > 0) details.push(`Redis ${node.ssh.host}:${node.servicePort} has ${out} key(s)`);
      } catch {
        // A missing Redis client/service is an empty fresh storage host.
      }
    }
  }

  if (includeObjectStorage && plan.storage.objectStorage) {
    const node = plan.storage.objectStorage;
    try {
      const out = runner.capture(
        node.ssh,
        `if [ -d ${shellQuote(config.OBJECT_STORAGE_ROOT_DIR)} ]; then find ${shellQuote(config.OBJECT_STORAGE_ROOT_DIR)} -mindepth 1 -maxdepth 1 -print -quit; fi`,
        { sudo: true },
      ).trim();
      if (out.length > 0) details.push(`object-storage vault '${config.OBJECT_STORAGE_ROOT_DIR}' already contains data`);
    } catch (error) {
      unknown.push(`object storage: ${(error as Error).message.split("\n")[0]?.slice(0, 120)}`);
    }
  }

  if (includeFakeRails) {
    const fakeRailsHost = plan.hosts.find((host) => host.roles.includes("fake-rails"));
    const dataDir = `${config.FAKE_RAILS_REMOTE_DIR}/shared/data`;
    if (fakeRailsHost) {
      try {
        const out = runner.capture(
          fakeRailsHost.ssh,
          `if [ -d ${shellQuote(dataDir)} ]; then find ${shellQuote(dataDir)} -mindepth 1 -maxdepth 1 -print -quit; fi`,
          { sudo: false },
        ).trim();
        if (out.length > 0) details.push(`Fake Rails SQLite data '${dataDir}' already exists`);
      } catch (error) {
        unknown.push(`Fake Rails SQLite data: ${(error as Error).message.split("\n")[0]?.slice(0, 120)}`);
      }
    }
  }

  return { nonEmpty: details.length > 0, unknown, details };
};

const dropDatabase = (runner: SshRunner, node: StorageNodePlan, database: string): void => {
  const port = node.servicePort || 5432;
  const name = sqlIdent(database, "database");
  const literal = sqlLiteral(database);
  try {
    runner.run(
      node.ssh,
      `runuser -u postgres -- psql -p ${port} -d postgres -v ON_ERROR_STOP=1 -c ${shellQuote(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${literal} AND pid <> pg_backend_pid()`)} -c ${shellQuote(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)}`,
      { sudo: true },
    );
  } catch (error) {
    throw new Error(`Could not clean PostgreSQL database '${database}': ${(error as Error).message}`);
  }
};

export const cleanFreshStorage = (options: FreshStorageOptions): string[] => {
  const { runner, config, plan, includePostgres, includeRedis, includeAuditLog, includeObjectStorage, includeFakeRails } = options;
  const cleaned: string[] = [];
  if (includePostgres || includeAuditLog) {
    const primary = postgresPrimary(plan);
    const auditNode = plan.storage.auditDb;
    const logNode = plan.storage.logDb;
    const targets = databaseNames(config, includePostgres, includeAuditLog).map((entry) => ({
      ...entry,
      node: entry.label.endsWith("Audit") ? auditNode : entry.label.endsWith("Log") ? logNode : primary,
    }));
    for (const target of targets) {
      const node = target.node;
      if (!node) continue;
      const port = node.servicePort || 5432;
      const ready = (): boolean => {
        try {
          runner.capture(node.ssh, `runuser -u postgres -- pg_isready -h 127.0.0.1 -p ${port} >/dev/null 2>&1`, { sudo: true });
          return true;
        } catch {
          return false;
        }
      };
      if (!ready()) {
        // A stopped existing cluster still contains data. A truly fresh host
        // has no service unit, so the start is best effort.
        runner.run(node.ssh, "systemctl reset-failed postgresql >/dev/null 2>&1 || true; systemctl start postgresql >/dev/null 2>&1 || true", { sudo: true });
        if (!ready()) continue;
      }
      try {
        dropDatabase(runner, node, target.name);
        cleaned.push(`${target.label} database '${target.name}' dropped`);
      } catch (error) {
        // A missing database is already clean; a reachable server that refuses
        // the drop must fail loudly so the operator knows data was not removed.
        const message = (error as Error).message;
        if (/does not exist|no such database|database .* does not exist/i.test(message)) continue;
        throw error;
      }
    }
  }
  if (includeRedis) {
    for (const node of plan.storage.redis) {
      try {
        runner.run(node.ssh, "systemctl start redis >/dev/null 2>&1 || systemctl start redis-server >/dev/null 2>&1 || systemctl start valkey >/dev/null 2>&1 || true", { sudo: true });
        runner.run(node.ssh, `REDISCLI_AUTH=${shellQuote(config.REDIS_PASSWORD ?? "")} redis-cli -h 127.0.0.1 -p ${node.servicePort} FLUSHALL`, { sudo: false });
        cleaned.push(`Redis ${node.ssh.host}:${node.servicePort} flushed`);
      } catch {
        // Redis may not be installed/running on a genuinely fresh host; the
        // provisioner will start it after this cleanup step.
      }
    }
  }
  if (includeFakeRails) {
    const fakeRailsHost = plan.hosts.find((host) => host.roles.includes("fake-rails"));
    const dataDir = `${config.FAKE_RAILS_REMOTE_DIR}/shared/data`;
    if (fakeRailsHost) {
      runner.run(fakeRailsHost.ssh, `PM2="$HOME/.bun/bin/pm2"; "$PM2" stop pg-fake-rails-back >/dev/null 2>&1 || true`, { sudo: false });
      runner.run(
        fakeRailsHost.ssh,
        `if [ -d ${shellQuote(dataDir)} ]; then find ${shellQuote(dataDir)} -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; fi`,
        { sudo: false },
      );
      cleaned.push(`Fake Rails SQLite data '${dataDir}' cleared`);
    }
  }
  if (includeObjectStorage && plan.storage.objectStorage) {
    const node = plan.storage.objectStorage;
    runner.run(node.ssh, "systemctl stop pg-object-storage-daemon >/dev/null 2>&1 || true", { sudo: true });
    runner.run(
      node.ssh,
      `if [ -d ${shellQuote(config.OBJECT_STORAGE_ROOT_DIR)} ]; then find ${shellQuote(config.OBJECT_STORAGE_ROOT_DIR)} -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; fi`,
      { sudo: true },
    );
    cleaned.push(`object-storage vault '${config.OBJECT_STORAGE_ROOT_DIR}' cleared`);
  }
  return cleaned;
};
