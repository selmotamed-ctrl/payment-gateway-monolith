import { describe, expect, test } from "bun:test";
import { loadDeployConfig } from "../lib/configSchema";
import { planHosts, renderTopology } from "../lib/hostPlanner";

const BASE = `
DB_MANAGE_VIA_SSH="true"
DB_SSH_HOST="10.10.0.10"
DB_SSH_KEY_PATH="~/.ssh/db"
DB_PRIVATE_IP="10.10.0.10"
DB_NAME="gateway"
DB_USER="gw"
DB_PASSWORD="ultra-strong-db-password"
DATABASE_URL="postgresql://gw:ultra-strong-db-password@10.10.0.10:5432/gateway"
DB_ENGINE="postgresql"
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
KMS_MASTER_KEY="0123456789abcdef0123456789abcdef"
`;

const SCALE = `
CORE_NODES="core-1@10.10.1.11:22:10.10.1.11:4000,core-2@10.10.1.12:22:10.10.1.12:4000"
ADMIN_NODES="admin-1@10.10.2.11:22:10.10.2.11:4101"
MERCHANT_NODES="merch-1@203.0.113.11:22:10.10.3.11:4102,merch-2@203.0.113.12:22:10.10.3.12:4102"
CHECKOUT_NODES="chk-1@203.0.113.21:22:10.10.4.11:4103"
PG_MANAGE_VIA_SSH="true"
PG_PRIMARY_NODE="pg-pri@10.10.10.10:22:10.10.10.10:5432"
PG_REPLICA_NODES="pg-rep-1@10.10.10.11:22:10.10.10.11:5432,pg-rep-2@10.10.10.12:22:10.10.10.12:5432"
PG_SSH_KEY_PATH="~/.ssh/pg"
PG_DB_PASSWORD="ultra-strong-pg-password"
PG_REPLICATION_PASSWORD="ultra-strong-repl-password"
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

const config = (extra = "") => {
  const result = loadDeployConfig(`${BASE}\n${SCALE}\n${extra}`);
  if (!result.ok || !result.config) throw new Error(result.problems.join("; "));
  return result.config;
};

const hostWithRole = (plan: ReturnType<typeof planHosts>, role: string) =>
  plan.hosts.find((host) => host.roles.includes(role as never));

describe("multi-node host planning", () => {
  test("creates one uniquely named service per node", () => {
    const plan = planHosts(config());
    expect(plan.nodes.core).toHaveLength(2);
    expect(plan.nodes.merchant).toHaveLength(2);
    expect(plan.nodes.admin).toHaveLength(1);
    expect(plan.nodes.checkout).toHaveLength(1);
    const coreServices = plan.hosts.flatMap((host) => host.services).filter((service) => service.role === "core");
    expect(coreServices).toHaveLength(2);
    expect(new Set(coreServices.map((service) => service.name)).size).toBe(2);
    expect(coreServices.map((service) => service.nodeId)).toEqual(["core-1", "core-2"]);
  });

  test("merges nodes that share one SSH endpoint", () => {
    const plan = planHosts(config(`
CORE_NODES="core-1@10.10.1.11:22:10.10.1.11:4000,core-2@10.10.1.11:22:10.10.1.12:4001"
`));
    const host = plan.hosts.find((candidate) => candidate.services.filter((service) => service.role === "core").length === 2);
    expect(host).toBeDefined();
    expect(host?.ssh.host).toBe("10.10.1.11");
    expect(new Set(host?.services.map((service) => service.name)).size).toBe(2);
  });

  test("derives CORE_BACK_URLS for every edge node and keeps CORE_BACK_URL first", () => {
    const plan = planHosts(config());
    const edgeServices = plan.hosts.flatMap((host) => host.services).filter((service) => ["admin", "merchant", "checkout"].includes(service.role));
    expect(edgeServices.length).toBe(4);
    for (const service of edgeServices) {
      expect(service.env.CORE_BACK_URLS).toBe("https://10.10.1.11:4000,https://10.10.1.12:4000");
      expect(service.env.CORE_BACK_URL).toBe("https://10.10.1.11:4000");
      expect(service.env.DATABASE_URL).toBeUndefined();
      expect(service.env.PG_DB_PASSWORD).toBeUndefined();
      expect(service.env.KMS_MASTER_KEY).toBeUndefined();
    }
  });

  test("builds the complete storage firewall matrix", () => {
    const plan = planHosts(config());
    const primary = hostWithRole(plan, "pg-primary")!;
    expect(primary.firewall.find((rule) => rule.port === 5432)?.fromCidrs).toEqual(
      expect.arrayContaining(["10.10.10.11", "10.10.10.12", "10.10.13.10"]),
    );
    expect(primary.firewall.find((rule) => rule.port === 6432)?.fromCidrs).toEqual(["10.10.1.11", "10.10.1.12"]);

    const replica = hostWithRole(plan, "pg-replica")!;
    expect(replica.firewall.find((rule) => rule.port === 5432)?.fromCidrs).toEqual(
      expect.arrayContaining(["10.10.10.10", "10.10.13.10"]),
    );

    const redis = hostWithRole(plan, "redis")!;
    expect(redis.firewall.find((rule) => rule.port === 6379)?.fromCidrs).toEqual(
      expect.arrayContaining(["10.10.1.11", "10.10.1.12", "10.10.13.10"]),
    );

    for (const role of ["audit-db", "log-db"]) {
      const storage = hostWithRole(plan, role)!;
      expect(storage.firewall.find((rule) => rule.port === 5432)?.fromCidrs).toEqual(
        expect.arrayContaining(["10.10.1.11", "10.10.1.12", "10.10.13.10"]),
      );
    }

    const backup = hostWithRole(plan, "backup")!;
    expect(backup.firewall.find((rule) => rule.port === 4090)?.fromCidrs).toEqual(["10.10.1.11", "10.10.1.12"]);
  });

  test("exposes storage, replicas and backup on the plan", () => {
    const plan = planHosts(config());
    expect(plan.storage.postgres.primary?.nodeId).toBe("pg-pri");
    expect(plan.storage.postgres.replicas.map((node) => node.nodeId)).toEqual(["pg-rep-1", "pg-rep-2"]);
    expect(plan.replicas).toHaveLength(2);
    expect(plan.storage.redis[0]?.nodeId).toBe("redis-1");
    expect(plan.backup.enabled).toBe(true);
    expect(plan.backup.node?.nodeId).toBe("backup-1");
  });

  test("renders storage nodes in the topology map", () => {
    const map = renderTopology(planHosts(config()));
    expect(map).toContain("pg-primary");
    expect(map).toContain("pg-replica");
    expect(map).toContain("backup:");
    expect(map).toContain("storage pg-primary: pg-pri");
  });
});
