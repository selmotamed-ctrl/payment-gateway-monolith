import { describe, expect, test } from "bun:test";
import { loadDeployConfig } from "../lib/configSchema";
import { buildPki, certFilesForHost } from "../lib/pkiManager";

const SOURCE = `
DB_MANAGE_VIA_SSH="false"
DB_NAME="gateway"
DB_USER="gw"
DB_PASSWORD="ultra-strong-db-password"
DATABASE_URL="postgresql://gw:ultra-strong-db-password@10.10.10.10:5432/gateway"
DB_ENGINE="postgresql"
CORE_NODES="core-1@10.10.1.11:22:10.10.1.11:4000,core-2@10.10.1.12:22:10.10.1.12:4000,core-3@10.10.1.13:22:10.10.1.13:4000"
CORE_SSH_KEY_PATH="~/.ssh/core"
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
KMS_MASTER_KEY="0123456789abcdef0123456789abcdef"
PG_MANAGE_VIA_SSH="true"
PG_PRIMARY_NODE="pg-pri@10.10.10.10:22:10.10.10.10:5432"
PG_SSH_KEY_PATH="~/.ssh/pg"
PG_DB_PASSWORD="ultra-strong-pg-password"
REDIS_MANAGE_VIA_SSH="true"
REDIS_NODES="redis-1@10.10.11.10:22:10.10.11.10:6379"
REDIS_SSH_KEY_PATH="~/.ssh/redis"
REDIS_PASSWORD="ultra-strong-redis-password"
BACKUP_ENABLED="true"
BACKUP_NODE="backup-1@10.10.13.10:22:10.10.13.10:4090"
BACKUP_SSH_KEY_PATH="~/.ssh/backup"
BACKUP_PRIMARY_S3_BUCKET="s3://payment-gateway-backups/prod"
BACKUP_ENCRYPTION_KEY_HEX="abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
`;

const config = () => {
  const result = loadDeployConfig(SOURCE);
  if (!result.ok || !result.config) throw new Error(result.problems.join("; "));
  return result.config;
};

describe("multi-node PKI", () => {
  test("the core certificate SAN carries every core private IP, loopback and the internal DNS name", () => {
    const bundle = buildPki({ config: config(), dryRun: true, directory: "/tmp/pg-pki-scale-core" });
    expect(bundle.server.sans).toEqual(expect.arrayContaining([
      "IP:10.10.1.11",
      "IP:10.10.1.12",
      "IP:10.10.1.13",
      "IP:127.0.0.1",
      "DNS:core-back.internal",
    ]));
  });

  test("adds a backup-daemon server certificate bound to the backup private IP", () => {
    const bundle = buildPki({ config: config(), dryRun: true, directory: "/tmp/pg-pki-scale-backup" });
    expect(bundle.backup.cn).toBe("backup-daemon.internal");
    expect(bundle.backup.sans).toEqual(expect.arrayContaining([
      "IP:10.10.13.10",
      "IP:127.0.0.1",
      "DNS:backup-daemon.internal",
    ]));
  });

  test("creates optional storage client certificates", () => {
    const bundle = buildPki({ config: config(), dryRun: true, directory: "/tmp/pg-pki-scale-storage" });
    expect(bundle.storageClients.map((client) => client.name)).toEqual(
      expect.arrayContaining(["pg-client", "redis-client", "backup-client"]),
    );
  });

  test("distributes only the certificate material each role needs", () => {
    const bundle = buildPki({ config: config(), dryRun: true, directory: "/tmp/pg-pki-scale-dist" });
    const core = certFilesForHost(bundle, ["core"]);
    expect(core.map((file) => file.name)).toEqual(expect.arrayContaining(["internal-ca", "core-back", "pg-client"]));
    const backup = certFilesForHost(bundle, ["backup"]);
    expect(backup.map((file) => file.name)).toEqual(expect.arrayContaining(["internal-ca", "backup-daemon", "backup-client"]));
    const edge = certFilesForHost(bundle, ["admin"]);
    expect(edge.map((file) => file.name)).toEqual(["internal-ca", "admin-back-client"]);
  });
});
