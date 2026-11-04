import { describe, expect, test } from "bun:test";
import { loadDeployConfig } from "../lib/configSchema";
import { planHosts } from "../lib/hostPlanner";
import type { SshRunner } from "../lib/sshRunner";
import {
  probeAuditDb,
  probeBackupDaemon,
  probeCoreNodes,
  probeEdgeToCore,
  probeLogDb,
  probePgBouncer,
  probePgPrimary,
  probeRedis,
  verifyDeployment,
} from "../lib/healthVerifier";

const SOURCE = `
DB_MANAGE_VIA_SSH="false"
DB_NAME="gateway"
DB_USER="gw"
DB_PASSWORD="ultra-strong-db-password"
DATABASE_URL="postgresql://gw:ultra-strong-db-password@10.10.10.10:5432/gateway"
DB_ENGINE="postgresql"
CORE_NODES="core-1@10.10.1.11:22:10.10.1.11:4000,core-2@10.10.1.12:22:10.10.1.12:4000"
CORE_SSH_KEY_PATH="~/.ssh/core"
ADMIN_NODES="admin-1@10.10.2.11:22:10.10.2.11:4101"
ADMIN_SSH_KEY_PATH="~/.ssh/admin"
MERCHANT_NODES="merch-1@10.10.3.11:22:10.10.3.11:4102"
MERCHANT_SSH_KEY_PATH="~/.ssh/merchant"
MERCHANT_DOMAIN="merchant.example.ly"
CHECKOUT_NODES="chk-1@10.10.4.11:22:10.10.4.11:4103"
CHECKOUT_SSH_KEY_PATH="~/.ssh/checkout"
CHECKOUT_DOMAIN="pay.example.ly"
KMS_MASTER_KEY="0123456789abcdef0123456789abcdef"
PG_MANAGE_VIA_SSH="true"
PG_PRIMARY_NODE="pg-pri@10.10.10.10:22:10.10.10.10:5432"
PG_REPLICA_NODES="pg-rep-1@10.10.10.11:22:10.10.10.11:5432"
PG_SSH_KEY_PATH="~/.ssh/pg"
PG_DB_PASSWORD="ultra-strong-pg-password"
PGBOUNCER_ENABLED="true"
REDIS_MANAGE_VIA_SSH="true"
REDIS_NODES="redis-1@10.10.11.10:22:10.10.11.10:6379"
REDIS_SSH_KEY_PATH="~/.ssh/redis"
REDIS_PASSWORD="ultra-strong-redis-password"
AUDIT_DB_MANAGE_VIA_SSH="true"
AUDIT_DB_NODE="audit-db@10.10.12.10:22:10.10.12.10:5432"
AUDIT_DB_SSH_KEY_PATH="~/.ssh/audit"
AUDIT_DB_PASSWORD="ultra-strong-audit-password"
LOG_DB_MANAGE_VIA_SSH="true"
LOG_DB_NODE="log-db@10.10.12.20:22:10.10.12.20:5432"
LOG_DB_SSH_KEY_PATH="~/.ssh/log"
LOG_DB_PASSWORD="ultra-strong-log-password"
BACKUP_ENABLED="true"
BACKUP_NODE="backup-1@10.10.13.10:22:10.10.13.10:4090"
BACKUP_SSH_KEY_PATH="~/.ssh/backup"
BACKUP_ENGINE_MODE="barman"
BACKUP_PRIMARY_S3_ENDPOINT="https://s3.example.invalid"
BACKUP_PRIMARY_S3_BUCKET="s3://payment-gateway-backups/prod"
BACKUP_ENCRYPTION_KEY_HEX="abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
`;

const fixture = () => {
  const loaded = loadDeployConfig(SOURCE);
  if (!loaded.ok || !loaded.config) throw new Error(loaded.problems.join("; "));
  return { config: loaded.config, plan: planHosts(loaded.config) };
};

class FakeRunner {
  readonly commands: Array<{ host: string; command: string }> = [];
  capture(target: { host: string }, command: string): string {
    this.commands.push({ host: target.host, command });
    if (command.includes("/internal/")) return '{"status":"ok","channel":"admin"}';
    if (command.includes("core-back.crt")) return '{"msg":"OK"}';
    if (command.includes("pg_isready")) return "127.0.0.1:5432 - accepting connections";
    if (command.includes("psql")) return "1";
    if (command.includes("redis-cli")) return "PONG";
    if (command.includes("backup-daemon")) return '{"status":"ok"}';
    if (command.includes("/health")) return '{"status":"ok"}';
    return "ok";
  }
}

const asRunner = (fake: FakeRunner): SshRunner => fake as unknown as SshRunner;

describe("scaled health verification", () => {
  test("probes every core node and every edge-to-core URL", () => {
    const { config, plan } = fixture();
    const fake = new FakeRunner();
    const cores = probeCoreNodes(asRunner(fake), plan, config);
    expect(cores).toHaveLength(2);
    for (const core of cores) expect(core.ok).toBe(true);

    const edgeHost = plan.hosts.find((host) => host.roles.includes("admin"))!;
    const edge = probeEdgeToCore(asRunner(fake), edgeHost, config, ["https://10.10.1.11:4000", "https://10.10.1.12:4000"]);
    expect(edge).toHaveLength(2);
    expect(fake.commands.filter((entry) => entry.command.includes("/internal/admin/health"))).toHaveLength(2);
  });

  test("renders PG, PgBouncer, Redis, audit/log and backup probes", () => {
    const { config, plan } = fixture();
    const fake = new FakeRunner();
    expect(probePgPrimary(asRunner(fake), plan, config).every((result) => result.ok)).toBe(true);
    expect(probePgBouncer(asRunner(fake), plan, config).every((result) => result.ok)).toBe(true);
    expect(probeRedis(asRunner(fake), plan, config).every((result) => result.ok)).toBe(true);
    expect(probeAuditDb(asRunner(fake), plan, config).every((result) => result.ok)).toBe(true);
    expect(probeLogDb(asRunner(fake), plan, config).every((result) => result.ok)).toBe(true);
    expect(probeBackupDaemon(asRunner(fake), plan, config).every((result) => result.ok)).toBe(true);
    const all = fake.commands.map((entry) => entry.command).join("\n");
    expect(all).toContain("pg_isready");
    expect(all).toContain("psql -h 127.0.0.1 -p 6432");
    expect(all).toContain("redis-cli");
    expect(all).toContain("-d pg_audit_db");
    expect(all).toContain("-d pg_logs_db");
    expect(all).toContain("backup-daemon.crt");
    expect(all).toContain(":4090/health");
  });

  test("uses plain HTTP for the backup daemon when insecure HTTP is allowed", () => {
    const { config, plan } = fixture();
    const insecure = { ...config, BACKUP_ALLOW_INSECURE_HTTP: true };
    const fake = new FakeRunner();
    const results = probeBackupDaemon(asRunner(fake), plan, insecure);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(fake.commands.some((entry) => entry.command.startsWith("curl") && entry.command.includes("http://"))).toBe(true);
    expect(fake.commands.some((entry) => entry.command.includes("backup-daemon.crt"))).toBe(false);
  });

  test("verifyDeployment keeps the legacy probes and adds storage when configured", () => {
    const { config, plan } = fixture();
    const verification = verifyDeployment(asRunner(new FakeRunner()), plan, config);
    expect(verification.ok).toBe(true);
    const checks = verification.results.map((result) => result.check).join("\n");
    expect(checks).toContain("core-1");
    expect(checks).toContain("core-2");
    expect(checks).toContain("pg_isready");
    expect(checks).toContain("redis PING");
    expect(checks).toContain("backup-daemon /health");
  });
});
