import { loadDeployConfig, type DeployConfig } from "../../../lib/configSchema";

/**
 * The deploy configuration of the two-host lab: PostgreSQL primary on host A, the backup daemon alone on host B,
 * `pg-native`, local repository only (no S3), audit database inside the primary cluster (shared).
 * The REAL provisioner functions render the daemon env, the systemd unit, the archive_command and the cluster SQL
 * from this, so the lab exercises generated artifacts instead of hand-written look-alikes.
 */
export interface LabAddresses {
  a: string;
  b: string;
  pgPort: number;
  daemonPort: number;
}

export const labDeployConfig = (addr: LabAddresses): DeployConfig => {
  const source = `
DEPLOY_ENV="test"
CORE_NODES="core-1@10.10.1.11:22:10.10.1.11:4000"
CORE_SSH_KEY_PATH="~/.ssh/core"
ADMIN_NODES="admin-1@10.10.2.11:22:10.10.2.11:4101"
ADMIN_SSH_KEY_PATH="~/.ssh/admin"
MERCHANT_NODES="merch-1@10.10.3.11:22:10.10.3.11:4102"
MERCHANT_SSH_KEY_PATH="~/.ssh/merchant"
MERCHANT_DOMAIN="merchant.example.ly"
CHECKOUT_NODES="chk-1@10.10.4.11:22:10.10.4.11:4103"
CHECKOUT_SSH_KEY_PATH="~/.ssh/checkout"
CHECKOUT_DOMAIN="pay.example.ly"
KMS_MASTER_KEY="kms-Q7x9Lm2Zr4Vb8Nc1Wd5Tg3Hy6Jp0Sa2"
BACKUP_ENABLED="true"
BACKUP_SSH_KEY_PATH="~/.ssh/backup"
BACKUP_ENCRYPTION_KEY_HEX="9f3a7c1e5b2d84f06a1c3e7b9d2f4a8c5e0b6d1a3f7c9e2b4d8a0c6e1f5b3a79"
DB_MANAGE_VIA_SSH="false"
DB_NAME="gateway"
DB_USER="gw"
DB_PASSWORD="ultra-strong-db-K7p2Zq9w"
DATABASE_URL="postgresql://gw:ultra-strong-db-K7p2Zq9w@${addr.a}:${addr.pgPort}/gateway"
DB_ENGINE="postgresql"
PG_MANAGE_VIA_SSH="true"
PG_PRIMARY_NODE="pg-pri@${addr.a}:22:${addr.a}:${addr.pgPort}"
PG_SSH_KEY_PATH="~/.ssh/pg"
PG_DB_NAME="payment_gateway_prod"
PG_DB_USER="gw_app"
PG_DB_PASSWORD="ultra-strong-pg-K7p2Zq9w"
PG_REPLICATION_PASSWORD="ultra-strong-repl-K7p2Zq9w"
AUDIT_DB_NAME="pg_audit_db"
AUDIT_DB_PASSWORD="ultra-strong-audit-K7p2Zq9w"
BACKUP_NODE="backup-1@${addr.b}:22:${addr.b}:${addr.daemonPort}"
BACKUP_ENGINE_MODE="pg-native"
BACKUP_PRIMARY_S3_ENDPOINT=""
BACKUP_PRIMARY_S3_BUCKET=""
BACKUP_SCHEDULER_ENABLED="false"
`;
  const result = loadDeployConfig(source);
  if (!result.ok || !result.config) throw new Error(`lab config invalid: ${result.problems.join("; ")}`);
  return result.config;
};

/**
 * Single-host deployment for the deploy-engine lab: PostgreSQL primary, the audit database (inside the same cluster)
 * and the backup daemon all on ONE host, `pg-native`, local repository only. Used to run the REAL storage steps
 * (provisionPostgres18, provisionAuditAndLogDb, provisionBackupEngine, deployBackupDaemon) against a real machine.
 * The ssh key path is a placeholder: the lab drives the provisioners through its own password-based runner.
 */
export const labSingleHostConfig = (input: { host: string; user: string; sudoPassword: string; backupEngineMode?: string }): DeployConfig => {
  const { host } = input;
  const source = `
DEPLOY_ENV="test"
CORE_NODES="core-1@10.10.1.11:22:10.10.1.11:4000"
CORE_SSH_KEY_PATH="~/.ssh/none"
ADMIN_NODES="admin-1@10.10.2.11:22:10.10.2.11:4101"
ADMIN_SSH_KEY_PATH="~/.ssh/none"
MERCHANT_NODES="merch-1@10.10.3.11:22:10.10.3.11:4102"
MERCHANT_SSH_KEY_PATH="~/.ssh/none"
MERCHANT_DOMAIN="merchant.example.ly"
CHECKOUT_NODES="chk-1@10.10.4.11:22:10.10.4.11:4103"
CHECKOUT_SSH_KEY_PATH="~/.ssh/none"
CHECKOUT_DOMAIN="pay.example.ly"
KMS_MASTER_KEY="kms-Q7x9Lm2Zr4Vb8Nc1Wd5Tg3Hy6Jp0Sa2"
DB_MANAGE_VIA_SSH="false"
DB_NAME="gateway"
DB_USER="gw"
DB_PASSWORD="ultra-strong-db-K7p2Zq9w"
DATABASE_URL="postgresql://gw:ultra-strong-db-K7p2Zq9w@${host}:5432/gateway"
DB_ENGINE="postgresql"
PG_MANAGE_VIA_SSH="true"
PG_PRIMARY_NODE="pg-pri@${host}:22:${host}:5432"
PG_SSH_USER="${input.user}"
PG_SSH_KEY_PATH="~/.ssh/none"
PG_SUDO_PASSWORD="${input.sudoPassword}"
PG_DB_NAME="payment_gateway_prod"
PG_DB_USER="gw_app"
PG_DB_PASSWORD="ultra-strong-pg-K7p2Zq9w"
PG_REPLICATION_PASSWORD="ultra-strong-repl-K7p2Zq9w"
AUDIT_DB_MANAGE_VIA_SSH="true"
AUDIT_DB_NODE="audit-db@${host}:22:${host}:5432"
AUDIT_DB_SSH_USER="${input.user}"
AUDIT_DB_SSH_KEY_PATH="~/.ssh/none"
AUDIT_DB_SUDO_PASSWORD="${input.sudoPassword}"
AUDIT_DB_NAME="pg_audit_db"
AUDIT_DB_PASSWORD="ultra-strong-audit-K7p2Zq9w"
BACKUP_ENABLED="true"
BACKUP_NODE="backup-1@${host}:22:${host}:4090"
BACKUP_SSH_USER="${input.user}"
BACKUP_SSH_KEY_PATH="~/.ssh/none"
BACKUP_SUDO_PASSWORD="${input.sudoPassword}"
BACKUP_ENCRYPTION_KEY_HEX="9f3a7c1e5b2d84f06a1c3e7b9d2f4a8c5e0b6d1a3f7c9e2b4d8a0c6e1f5b3a79"
BACKUP_ENGINE_MODE="${input.backupEngineMode ?? "auto"}"
BACKUP_PRIMARY_S3_ENDPOINT=""
BACKUP_PRIMARY_S3_BUCKET=""
BACKUP_SCHEDULER_ENABLED="false"
`;
  const result = loadDeployConfig(source);
  if (!result.ok || !result.config) throw new Error(`lab single-host config invalid: ${result.problems.join("; ")}`);
  return result.config;
};
