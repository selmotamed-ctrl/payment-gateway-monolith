import { describe, expect, test } from "bun:test";
import { cleanFreshStorage, probeFreshStorage } from "../lib/freshStorage";
import type { DeployConfig } from "../lib/configSchema";
import type { DeployPlan, StorageNodePlan } from "../lib/hostPlanner";
import type { SshRunner } from "../lib/sshRunner";

const node = {
  role: "pg-primary",
  nodeId: "pg-1",
  ssh: { host: "127.0.0.1", port: 22, user: "deploy", keyPath: "/tmp/key", sudoPassword: "" },
  host: "127.0.0.1",
  sshHost: "127.0.0.1",
  sshPort: 22,
  privateIp: "127.0.0.1",
  servicePort: 5432,
  port: 5432,
  hostKey: "127.0.0.1:22",
} as StorageNodePlan;

const config = {
  PG_DB_NAME: "payment_gateway_prod",
  SANDBOX_ENABLED: true,
  SANDBOX_DB_NAME: "payment_gateway_sandbox",
  AUDIT_DB_NAME: "pg_audit_db",
  LOG_DB_NAME: "pg_logs_db",
  REDIS_PASSWORD: "redis-secret-value",
  OBJECT_STORAGE_ROOT_DIR: "/var/lib/pg-object-storage/vault",
  FAKE_RAILS_REMOTE_DIR: "/var/www/pg-fake-rails",
} as DeployConfig;

const plan = {
  hosts: [{ roles: ["fake-rails"], ssh: node.ssh }],
  storage: {
    postgres: { primary: node, replicas: [], pgbouncer: [], version: "18" },
    redis: [node],
    auditDb: node,
    logDb: node,
    objectStorage: node,
  },
} as unknown as DeployPlan;

const makeRunner = () => {
  const runs: string[] = [];
  const captures: string[] = [];
  const runner = {
    dryRun: false,
    capture: (_ssh: unknown, command: string) => {
      captures.push(command);
      if (command.includes("pg_isready")) return "";
      if (command.includes("pg_database")) return "1";
      if (command.includes("information_schema.tables")) return "2";
      if (command.includes("DBSIZE")) return "3";
      if (command.includes("find ") && command.includes("fake-rails")) return "/var/www/pg-fake-rails/shared/data/fake-rails.sqlite";
      if (command.includes("find ")) return "/var/lib/pg-object-storage/vault/objects";
      return "";
    },
    run: (_ssh: unknown, command: string) => {
      runs.push(command);
      return "";
    },
  } as unknown as SshRunner;
  return { runner, runs, captures };
};

describe("fresh storage guard", () => {
  test("detects populated PostgreSQL, Redis and object-storage engines", () => {
    const { runner } = makeRunner();
    const state = probeFreshStorage({ runner, config, plan, includePostgres: true, includeRedis: true, includeAuditLog: true, includeObjectStorage: true, includeFakeRails: true });
    expect(state.nonEmpty).toBe(true);
    expect(state.details.join(" ")).toContain("PostgreSQL/Live");
    expect(state.details.join(" ")).toContain("PostgreSQL/Sandbox");
    expect(state.details.join(" ")).toContain("Redis");
    expect(state.details.join(" ")).toContain("object-storage vault");
    expect(state.details.join(" ")).toContain("Fake Rails SQLite data");
  });

  test("force cleanup drops databases, flushes Redis and clears the vault", () => {
    const { runner, runs } = makeRunner();
    const cleaned = cleanFreshStorage({ runner, config, plan, includePostgres: true, includeRedis: true, includeAuditLog: true, includeObjectStorage: true, includeFakeRails: true });
    expect(cleaned.length).toBeGreaterThanOrEqual(5);
    expect(runs.some((command) => command.includes("DROP DATABASE IF EXISTS"))).toBe(true);
    expect(runs.some((command) => command.includes("FLUSHALL"))).toBe(true);
    expect(runs.some((command) => command.includes("pg-object-storage-daemon"))).toBe(true);
    expect(runs.some((command) => command.includes("pg-fake-rails-back"))).toBe(true);
  });
});
