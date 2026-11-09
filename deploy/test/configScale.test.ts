import { describe, expect, test } from "bun:test";
import { clamdManaged, edgeCoreUrls, effectiveDatabase, loadDeployConfig, parseNodeList } from "../lib/configSchema";

const BASE = `
DB_MANAGE_VIA_SSH="true"
DB_SSH_HOST="10.10.0.10"
DB_SSH_KEY_PATH="~/.ssh/db"
DB_PRIVATE_IP="10.10.0.10"
DB_NAME="gateway"
DB_USER="gw"
DB_PASSWORD="ultra-strong-db-K7p2Zq9w"
DATABASE_URL="postgresql://gw:ultra-strong-db-K7p2Zq9w@10.10.0.10:5432/gateway"
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

const withOverrides = (overrides: string): string => `${BASE}\n${overrides}\n`;

const requireConfig = (source: string) => {
  const result = loadDeployConfig(source);
  if (!result.ok || !result.config) throw new Error(result.problems.join("; "));
  return result.config;
};

const nodes = (count: number, tier: string, basePort: number): string =>
  Array.from({ length: count }, (_, index) => {
    const n = index + 1;
    return `${tier}-${n}@10.${tier.length}.${n}.10:22:10.${tier.length}.${n}.11:${basePort}`;
  }).join(",");

describe("horizontal node list parsing", () => {
  test("parses and validates the nodeId@sshHost:sshPort:privateIp:servicePort format", () => {
    const parsed = parseNodeList("core-1@10.0.0.11:2222:10.1.0.11:4000, core-2@10.0.0.12:22:10.1.0.12:4001");
    expect(parsed).toEqual([
      { nodeId: "core-1", sshHost: "10.0.0.11", sshPort: 2222, privateIp: "10.1.0.11", servicePort: 4000 },
      { nodeId: "core-2", sshHost: "10.0.0.12", sshPort: 22, privateIp: "10.1.0.12", servicePort: 4001 },
    ]);
  });

  test("rejects malformed entries", () => {
    for (const value of [
      "core-1",
      "core-1@10.0.0.11",
      "core-1@10.0.0.11:22:10.1.0.11",
      "core-1@10.0.0.999:22:10.1.0.11:4000",
      "core-1@10.0.0.11:22:10.1.0.999:4000",
      "core-1@10.0.0.11:not-a-port:10.1.0.11:4000",
      "core-1@10.0.0.11:22:10.1.0.11:70000",
      "bad id@10.0.0.11:22:10.1.0.11:4000",
    ]) {
      expect(() => parseNodeList(value)).toThrow();
    }
  });

  test("rejects duplicate ids and duplicate endpoints, but allows two nodes on one private IP", () => {
    expect(() => parseNodeList("core-1@10.0.0.11:22:10.1.0.11:4000,core-1@10.0.0.12:22:10.1.0.12:4000")).toThrow(/duplicate node id/);
    expect(() => parseNodeList("core-1@10.0.0.11:22:10.1.0.11:4000,core-2@10.0.0.12:22:10.1.0.11:4000")).toThrow(/duplicate endpoint/);
    expect(parseNodeList("core-1@10.0.0.11:22:10.1.0.11:4000,core-2@10.0.0.12:22:10.1.0.11:4001")).toHaveLength(2);
  });
});

describe("multi-node config topologies", () => {
  for (const count of [1, 2, 5, 30]) {
    test(`accepts a ${count}-node core tier and derives every edge URL`, () => {
      const config = requireConfig(withOverrides(`CORE_NODES="${nodes(count, "core", 4000)}"`));
      expect(parseNodeList(config.CORE_NODES)).toHaveLength(count);
      const urls = edgeCoreUrls(config);
      expect(urls).toHaveLength(count);
      expect(urls[0]).toStartWith("https://");
      expect(urls.every((url) => url.endsWith(":4000"))).toBe(true);
    });
  }

  test("an explicit CORE_BACK_URLS wins over the derived list", () => {
    const config = requireConfig(withOverrides(`
CORE_NODES="core-1@10.0.0.11:22:10.1.0.11:4000"
CORE_BACK_URLS="https://edge.example:4000,https://edge2.example:4000"
`));
    expect(edgeCoreUrls(config)).toEqual(["https://edge.example:4000", "https://edge2.example:4000"]);
  });

  test("duplicate ids across tiers are rejected", () => {
    const result = loadDeployConfig(withOverrides(`
CORE_NODES="core-1@10.0.0.11:22:10.1.0.11:4000"
ADMIN_NODES="core-1@10.0.0.12:22:10.1.0.12:4101"
`));
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toContain("used more than once");
  });

  test("replica without a primary is rejected", () => {
    const result = loadDeployConfig(withOverrides(`
DB_ENGINE="postgresql"
DATABASE_URL="postgresql://gw:pw@10.10.0.10:5432/gateway"
PG_REPLICA_NODES="pg-rep-1@10.0.1.11:22:10.1.1.11:5432"
`));
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toContain("PG_REPLICA_NODES requires PG_PRIMARY_NODE");
  });

  test("DB_ENGINE defaults to PostgreSQL 18 on port 5432", () => {
    const config = requireConfig(BASE);
    expect(config.DB_ENGINE).toBe("postgresql");
    expect(config.DB_PORT).toBe(5432);
  });

  test("legacy DB_* remains the compatibility path when no PG storage is configured", () => {
    const database = effectiveDatabase(requireConfig(BASE));
    expect(database.name).toBe("gateway");
    expect(database.user).toBe("gw");
    expect(database.password).toBe("ultra-strong-db-K7p2Zq9w");
    expect(database.host).toBe("10.10.0.10");
  });

  test("PG storage credentials override the legacy DB_* compatibility block", () => {
    const config = requireConfig(withOverrides(`
PG_MANAGE_VIA_SSH="true"
PG_PRIMARY_NODE="pg-pri@10.0.1.10:22:10.1.1.10:5432"
PG_DB_NAME="pg_authoritative"
PG_DB_USER="gw_authoritative_user"
PG_DB_PASSWORD="strong-pg-Xk7Qm2Zr"
PG_SSH_KEY_PATH="~/.ssh/pg"
`));
    const database = effectiveDatabase(config);
    expect(database.engine).toBe("postgresql");
    expect(database.name).toBe("pg_authoritative");
    expect(database.user).toBe("gw_authoritative_user");
    expect(database.password).toBe("strong-pg-Xk7Qm2Zr");
    expect(database.host).toBe("10.1.1.10");
    expect(database.port).toBe(5432);
  });

  test("an invalid backup endpoint is rejected", () => {
    const result = loadDeployConfig(withOverrides(`
BACKUP_ENABLED="true"
BACKUP_NODE="backup-1@10.0.3.10:22:10.1.3.10:4090"
BACKUP_SSH_KEY_PATH="~/.ssh/backup"
BACKUP_PRIMARY_S3_ENDPOINT="s3.example.invalid"
BACKUP_PRIMARY_S3_BUCKET="s3://payment-gateway-backups/prod"
BACKUP_ENCRYPTION_KEY_HEX="9f3a7c1e5b2d84f06a1c3e7b9d2f4a8c5e0b6d1a3f7c9e2b4d8a0c6e1f5b3a79"
`));
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toContain("BACKUP_PRIMARY_S3_ENDPOINT must be an absolute http(s) URL");
  });

  test("backup without an encryption key is always rejected; S3 is required only by the engines that need it", () => {
    const base = `
BACKUP_ENABLED="true"
BACKUP_NODE="backup-1@10.0.3.10:22:10.1.3.10:4090"
BACKUP_SSH_KEY_PATH="~/.ssh/backup"
`;
    // default engine (pg-native): the key is required, S3 is optional (local repository only)
    const native = loadDeployConfig(withOverrides(base));
    expect(native.ok).toBe(false);
    expect(native.problems.join(" ")).toContain("BACKUP_ENCRYPTION_KEY_HEX");
    expect(native.problems.join(" ")).not.toContain("BACKUP_PRIMARY_S3_BUCKET");
    // barman (explicit): S3 is required as well
    const barman = loadDeployConfig(withOverrides(`${base}BACKUP_ENGINE_MODE="barman"\n`));
    expect(barman.ok).toBe(false);
    const problems = barman.problems.join(" ");
    expect(problems).toContain("BACKUP_PRIMARY_S3_BUCKET");
    expect(problems).toContain("BACKUP_ENCRYPTION_KEY_HEX");
    expect(problems).toContain("BACKUP_PRIMARY_S3_ENDPOINT");
  });

  test("the shipped example env remains a valid legacy single-host configuration", () => {
    const text: string = require("node:fs").readFileSync("deploy.env.example", "utf8");
    // The example ships placeholders on purpose: it must NOT validate as-is...
    expect(loadDeployConfig(text).ok).toBe(false);
    // ...but is otherwise structurally valid once every placeholder secret is replaced with a real-looking value.
    const filled = text.replace(/^([A-Z_]+)="[^"\n]*(?:change-me|changeme)[^"\n]*"/gim, (m, key: string) => (key === "DATABASE_URL" ? m : `${key}="Xk7Qm2Zr-${key.length}-9Lp4Vn8Bc3Wd6Th-Hy5Jp0Sa2Fg7"`))
      .replace("postgresql://gw_core_user:change-me-strong-db-password@", "postgresql://gw_core_user:Xk7Qm2Zr-db_password-9Lp4Vn8Bc3Wd6Th@");
    const example = requireConfig(filled);
    expect(example.PG_VERSION).toBe("18");
    expect(example.PGBOUNCER_PORT).toBe(6432);
    expect(example.BACKUP_DAEMON_PORT).toBe(4090);
  });
});

describe("KYB scanner configuration (AUTO-06)", () => {
  test("clamd without an address is managed by the deploy engine; a given address must be a socket path or host:port; eicar and disabled need nothing", () => {
    expect(loadDeployConfig(withOverrides('KYB_SCANNER_MODE="clamd"')).problems).toEqual([]);
    expect(clamdManaged(requireConfig(withOverrides('KYB_SCANNER_MODE="clamd"')))).toBe(true);
    expect(clamdManaged(requireConfig(withOverrides('KYB_SCANNER_MODE="clamd"\nKYB_CLAMD_ADDRESS="10.10.0.60:3310"')))).toBe(false);
    expect(clamdManaged(requireConfig(withOverrides('KYB_SCANNER_MODE="eicar"')))).toBe(false);
    expect(loadDeployConfig(withOverrides('KYB_SCANNER_MODE="clamd"\nKYB_CLAMD_ADDRESS="scan.internal"')).problems.join(";")).toMatch(/socket path or host:port/);
    expect(loadDeployConfig(withOverrides('KYB_SCANNER_MODE="clamd"\nKYB_CLAMD_ADDRESS="scan.internal:99999"')).problems.join(";")).toMatch(/socket path or host:port/);
    for (const good of ["/run/clamav/clamd.ctl", "unix:/run/clamav/clamd.ctl", "10.10.0.60:3310", "scan.internal:3310", "[::1]:3310"]) {
      expect(loadDeployConfig(withOverrides(`KYB_SCANNER_MODE="clamd"\nKYB_CLAMD_ADDRESS="${good}"`)).problems).toEqual([]);
    }
    expect(loadDeployConfig(withOverrides('KYB_SCANNER_MODE="eicar"')).problems).toEqual([]);
    expect(loadDeployConfig(withOverrides('KYB_SCANNER_MODE="disabled"')).problems).toEqual([]);
    expect(loadDeployConfig(withOverrides('KYB_SCANNER_MODE="virustotal"')).ok).toBe(false);
  });

  test("the rescan window is bounded and defaults to 30 days", () => {
    expect(requireConfig(withOverrides("")).KYB_RESCAN_DAYS).toBe(30);
    expect(requireConfig(withOverrides('KYB_RESCAN_DAYS="0"')).KYB_RESCAN_DAYS).toBe(0);
    expect(loadDeployConfig(withOverrides('KYB_RESCAN_DAYS="-1"')).ok).toBe(false);
  });
});
