import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDeployConfig, parseDeployEnv } from "../lib/configSchema";
import { planHosts } from "../lib/hostPlanner";
import { buildAllTopologySpecs, writeTopologyConfigs } from "../test-matrix/generateTopologyConfigs";
import { pgClusterFor, postgresConfigPath, postgresDataDir } from "../provisioners/postgres18Provisioner";
import { auditDatabaseDdl } from "../provisioners/auditAndLogDbProvisioner";
import { summarize } from "../test-matrix/stressWorkload";
import type { LabHostsConfig } from "../test-matrix/types";

const LAB: LabHostsConfig = {
  hostALanIp: "10.209.250.48",
  hostASshUser: "salem",
  hostASudoPass: "1234",
  hostBLanIp: "10.209.250.205",
  hostBSshUser: "salem",
  hostBSudoPass: "1234",
  sshKeyPath: "~/.ssh/id_ed25519_pg_lab_matrix",
};

describe("two-machine topology generator", () => {
  test("generates all eight configs that pass deploy validation", () => {
    const directory = mkdtempSync(join(tmpdir(), "pg-topologies-"));
    try {
      const paths = writeTopologyConfigs(LAB, directory);
      expect(paths).toHaveLength(8);
      for (const path of paths) {
        const result = loadDeployConfig(readFileSync(path, "utf8"));
        if (!result.ok) throw new Error(`${path}: ${result.problems.join("; ")}`);
        expect(result.config?.FAKE_RAILS_ENABLED).toBe(true);
        expect(result.config?.PG_MANAGE_VIA_SSH).toBe(true);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("T6 has four core/checkout/merchant nodes and two replicas", () => {
    const spec = buildAllTopologySpecs().find((entry) => entry.id === "T6")!;
    const env = parseDeployEnv(Object.entries(spec.buildEnv(LAB)).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join("\n"));
    expect(env.CORE_NODES?.split(",")).toHaveLength(4);
    expect(env.CHECKOUT_NODES?.split(",")).toHaveLength(4);
    expect(env.MERCHANT_NODES?.split(",")).toHaveLength(4);
    expect(env.PG_REPLICA_NODES?.split(",")).toHaveLength(2);
    expect(env.STORAGE_SHARD_COUNT).toBe("32");
    expect(env.SYNTHETIC_SEED_PROFILE).toBe("STANDARD");
  });

  test("multi-node hosts get per-node env files, release suffixes and a least_conn upstream", () => {
    const spec = buildAllTopologySpecs().find((entry) => entry.id === "T1")!;
    const loaded = loadDeployConfig(Object.entries(spec.buildEnv(LAB)).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join("\n"));
    if (!loaded.ok || !loaded.config) throw new Error(loaded.problems.join("; "));
    const plan = planHosts(loaded.config);
    const host = plan.hosts.find((candidate) => candidate.services.filter((service) => service.role === "core").length === 2)!;
    const core = host.services.filter((service) => service.role === "core");
    expect(core.map((service) => service.name)).toEqual(["pg-core-back-core-1", "pg-core-back-core-2"]);
    expect(core.map((service) => service.envFileName)).toEqual([".env.core-1", ".env.core-2"]);
    expect(core.map((service) => service.currentLink)).toEqual(["/var/www/pg-core/current-core-1", "/var/www/pg-core/current-core-2"]);
    const admin = host.nginx.find((site) => site.site === "admin-lan")!;
    expect(admin.upstreamName).toBe("pg_admin_backend");
    expect(admin.upstreamServers).toEqual(["10.209.250.48:4101"]);
    const checkout = host.nginx.find((site) => site.site === "checkout-public")!;
    expect(checkout.upstreamServers).toEqual(["10.209.250.48:4103", "10.209.250.48:4113"]);
  });
});

describe("multi-cluster PostgreSQL", () => {
  test("co-located roles get independent clusters and ports", () => {
    const config = { PG_VERSION: "18" };
    expect(pgClusterFor(config, "primary", { privateIp: "10.0.0.1", servicePort: 5432 }).name).toBe("main");
    expect(pgClusterFor(config, "replica", { nodeId: "pg-rep-1", privateIp: "10.0.0.1", servicePort: 5433 })).toMatchObject({
      name: "replica_pg_rep_1",
      port: 5433,
      dataDir: "/var/lib/postgresql/18/replica_pg_rep_1",
      service: "postgresql@18-replica_pg_rep_1",
    });
    expect(pgClusterFor(config, "audit", { privateIp: "10.0.0.1", servicePort: 5434 }).name).toBe("audit");
    expect(pgClusterFor(config, "log", { privateIp: "10.0.0.1", servicePort: 5435 }).name).toBe("log");
    expect(postgresDataDir(config, "audit")).toBe("/var/lib/postgresql/18/audit");
    expect(postgresConfigPath(config, "audit")).toBe("/etc/postgresql/18/audit/conf.d/zz-pg-switch.conf");
  });

  test("audit DDL installs the serialized trigger and pgcrypto", () => {
    const ddl = auditDatabaseDdl({ AUDIT_DB_USER: "pg_audit_writer" });
    expect(ddl).toContain("CREATE EXTENSION IF NOT EXISTS pgcrypto");
    expect(ddl).toContain("compute_audit_chain_hash_trg");
    expect(ddl).toContain("pg_advisory_xact_lock(994001)");
    expect(ddl).toContain("trg_audit_chain_compute");
  });
});

describe("stress workload summary", () => {
  test("separates success, exhaustion and failures", () => {
    const summary = summarize(5, [1, 2, 3, 4, 5], [201, 201, 409, 409, 500], ["boom"]);
    expect(summary.succeeded).toBe(2);
    expect(summary.conflict).toBe(2);
    expect(summary.failed).toBe(2);
    expect(summary.p50).toBe(3);
  });
});
