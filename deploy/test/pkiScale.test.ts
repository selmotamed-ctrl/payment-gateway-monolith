import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDeployConfig } from "../lib/configSchema";
import { buildPki, certFilesForHost, inspectCertificate } from "../lib/pkiManager";

const SOURCE = `
DB_MANAGE_VIA_SSH="false"
DB_NAME="gateway"
DB_USER="gw"
DB_PASSWORD="ultra-strong-db-K7p2Zq9w"
DATABASE_URL="postgresql://gw:ultra-strong-db-K7p2Zq9w@10.10.10.10:5432/gateway"
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
KMS_MASTER_KEY="kms-Q7x9Lm2Zr4Vb8Nc1Wd5Tg3Hy6Jp0Sa2"
PG_MANAGE_VIA_SSH="true"
PG_PRIMARY_NODE="pg-pri@10.10.10.10:22:10.10.10.10:5432"
PG_SSH_KEY_PATH="~/.ssh/pg"
PG_DB_PASSWORD="ultra-strong-pg-K7p2Zq9w"
REDIS_MANAGE_VIA_SSH="true"
REDIS_NODES="redis-1@10.10.11.10:22:10.10.11.10:6379"
REDIS_SSH_KEY_PATH="~/.ssh/redis"
REDIS_PASSWORD="ultra-strong-redis-K7p2Zq9w"
BACKUP_ENABLED="true"
BACKUP_NODE="backup-1@10.10.13.10:22:10.10.13.10:4090"
BACKUP_SSH_KEY_PATH="~/.ssh/backup"
BACKUP_ENGINE_MODE="barman"
BACKUP_PRIMARY_S3_ENDPOINT="https://s3.example.invalid"
BACKUP_PRIMARY_S3_BUCKET="s3://payment-gateway-backups/prod"
BACKUP_ENCRYPTION_KEY_HEX="9f3a7c1e5b2d84f06a1c3e7b9d2f4a8c5e0b6d1a3f7c9e2b4d8a0c6e1f5b3a79"
OBJECT_STORAGE_NODE="obj-1@10.10.13.10:22:10.10.13.10:4095"
OBJECT_STORAGE_SSH_KEY_PATH="~/.ssh/backup"
OBJECT_STORAGE_KEK_KEYRING="v1:7e1f4b9a3c6d2058e1a7b4c9d3f6082a5b1c8e4d7a0f3b6c9e2d5a8f1b4c7e03"
`;

const requireConfig = (source: string) => {
  const result = loadDeployConfig(source);
  if (!result.ok || !result.config) throw new Error(result.problems.join("; "));
  return result.config;
};

const config = () => requireConfig(SOURCE);

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

  test("re-signs the backup and Fake Rails leaves when their SANs drift, keeping the CA stable", () => {
    const directory = mkdtempSync(join(tmpdir(), "pg-pki-drift-"));
    try {
      buildPki({ config: config(), directory });
      const caBefore = readFileSync(join(directory, "internal-ca.crt"), "utf8");
      const changed = requireConfig(`${SOURCE}
BACKUP_NODE="backup-1@10.10.13.99:22:10.10.13.99:4090"
FAKE_RAILS_PRIVATE_IP="10.10.14.10"
FAKE_RAILS_DOMAIN="fakerails.internal"
`);
      buildPki({ config: changed, directory });
      expect(inspectCertificate(join(directory, "backup-daemon.crt"), "backup-daemon").sans).toContain("10.10.13.99");
      expect(inspectCertificate(join(directory, "fake-rails.crt"), "fake-rails").sans).toContain("10.10.14.10");
      expect(readFileSync(join(directory, "internal-ca.crt"), "utf8")).toBe(caBefore);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
