import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadDeployConfig } from "../lib/configSchema";
import { preMigrationBackup } from "../deploy";

const BASE = `
DB_MANAGE_VIA_SSH="true"
DB_SSH_HOST="10.10.0.10"
DB_SSH_KEY_PATH="~/.ssh/db"
DB_PRIVATE_IP="10.10.0.10"
DB_NAME="legacy_gateway"
DB_USER="legacy_user"
DB_PASSWORD="ultra-strong-db-K7p2Zq9w"
DATABASE_URL="postgresql://legacy_user:ultra-strong-db-K7p2Zq9w@10.10.0.10:5432/legacy_gateway"
CORE_SSH_HOST="10.10.0.20"
CORE_SSH_KEY_PATH="~/.ssh/core"
CORE_PRIVATE_IP="10.10.0.20"
ADMIN_SSH_HOST="10.10.0.30"
ADMIN_SSH_KEY_PATH="~/.ssh/admin"
ADMIN_PRIVATE_IP="10.10.0.30"
MERCHANT_SSH_HOST="203.0.113.10"
MERCHANT_SSH_KEY_PATH="~/.ssh/merchant"
MERCHANT_PRIVATE_IP="10.10.0.40"
MERCHANT_DOMAIN="merchant.example.ly"
CHECKOUT_SSH_HOST="203.0.113.20"
CHECKOUT_SSH_KEY_PATH="~/.ssh/checkout"
CHECKOUT_PRIVATE_IP="10.10.0.50"
CHECKOUT_DOMAIN="pay.example.ly"
KMS_MASTER_KEY="kms-Q7x9Lm2Zr4Vb8Nc1Wd5Tg3Hy6Jp0Sa2"
`;

const PG = `
PG_MANAGE_VIA_SSH="true"
PG_PRIMARY_NODE="pg-pri@10.10.10.10:22:10.10.10.10:5432"
PG_REPLICA_NODES="pg-rep-1@10.10.10.11:22:10.10.10.11:5432"
PG_SSH_KEY_PATH="~/.ssh/pg"
PG_DB_NAME="pg_authoritative"
PG_DB_USER="pg_owner"
PG_DB_PASSWORD="ultra-strong-pg-K7p2Zq9w"
PGBOUNCER_ENABLED="true"
`;

const requireConfig = (source: string) => {
  const result = loadDeployConfig(source);
  if (!result.ok || !result.config) throw new Error(result.problems.join("; "));
  return result.config;
};

describe("pre-migration backup", () => {
  test("uses the PG primary direct port and PG credentials, never PgBouncer", () => {
    const backup = preMigrationBackup(requireConfig(`${BASE}\n${PG}`), "/var/www/pg-core/shared/backups/pre-migrate");
    expect(backup.host).toBe("10.10.10.10");
    expect(backup.port).toBe(5432);
    expect(backup.database).toBe("pg_authoritative");
    expect(backup.user).toBe("pg_owner");
    // The password is streamed into a 0600 PGPASSFILE, never placed on the command line.
    expect(backup.command).not.toContain("ultra-strong-pg-K7p2Zq9w");
    expect(backup.command).not.toContain("PGPASSWORD");
    expect(backup.command).toContain("PGPASSFILE='/var/www/pg-core/shared/backups/pre-migrate.pgpass'");
    expect(backup.pgpassContent).toBe("10.10.10.10:5432:*:pg_owner:ultra-strong-pg-K7p2Zq9w\n");
    expect(backup.command).toContain("umask 077");
    expect(backup.command).toContain("pg_dump --no-password -h '10.10.10.10' -p 5432 -U 'pg_owner' -Fc");
    expect(backup.command).toContain(".dump");
    expect(backup.command).not.toContain("6432");
  });

  test("keeps the legacy single-host path working", () => {
    const backup = preMigrationBackup(requireConfig(BASE), "/var/www/pg-core/shared/backups/pre-migrate");
    expect(backup.host).toBe("10.10.0.10");
    expect(backup.port).toBe(5432);
    expect(backup.database).toBe("legacy_gateway");
    expect(backup.user).toBe("legacy_user");
    expect(backup.command).toContain("pg_dump");
  });
});

describe("14-step deploy pipeline", () => {
  const source = readFileSync(join(import.meta.dirname, "..", "deploy.ts"), "utf8");

  test("has the 14-step pipeline and only the PostgreSQL dump path", () => {
    expect(source).toContain("step(14,");
    expect(source).toContain("[${index}/14]");
    expect(source).toContain("pg_dump");
  });

  test("deploys the daemon source and enables it before verification", () => {
    expect(source).toContain("/opt/pg-backup-daemon");
    expect(source).toContain("backup-daemon");
    expect(source).toContain("/usr/local/bin/bun install --frozen-lockfile");
    expect(source).toContain("systemctl enable pg-backup-daemon");
    expect(source.indexOf("deployBackupDaemon")).toBeLessThan(source.indexOf("End-to-end cross-host"));
  });
});
