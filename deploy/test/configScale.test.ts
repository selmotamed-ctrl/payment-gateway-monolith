import { describe, expect, test } from "bun:test";
import { edgeCoreUrls, loadDeployConfig, parseNodeList } from "../lib/configSchema";

const BASE = `
DB_MANAGE_VIA_SSH="true"
DB_SSH_HOST="10.10.0.10"
DB_SSH_KEY_PATH="~/.ssh/db"
DB_PRIVATE_IP="10.10.0.10"
DB_NAME="gateway"
DB_USER="gw"
DB_PASSWORD="ultra-strong-db-password"
DATABASE_URL="mysql://gw:ultra-strong-db-password@10.10.0.10:3306/gateway"
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

  test("rejects duplicate ids and duplicate private IPs in one list", () => {
    expect(() => parseNodeList("core-1@10.0.0.11:22:10.1.0.11:4000,core-1@10.0.0.12:22:10.1.0.12:4000")).toThrow(/duplicate node id/);
    expect(() => parseNodeList("core-1@10.0.0.11:22:10.1.0.11:4000,core-2@10.0.0.12:22:10.1.0.11:4000")).toThrow(/duplicate private IP/);
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

  test("PG storage forces DB_ENGINE=postgresql", () => {
    const result = loadDeployConfig(withOverrides(`
PG_MANAGE_VIA_SSH="true"
PG_PRIMARY_NODE="pg-pri@10.0.1.10:22:10.1.1.10:5432"
PG_DB_PASSWORD="strong-pg-password"
PG_SSH_KEY_PATH="~/.ssh/pg"
`));
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toContain("DB_ENGINE must be 'postgresql'");
  });

  test("backup without S3 bucket or encryption key is rejected", () => {
    const result = loadDeployConfig(withOverrides(`
BACKUP_ENABLED="true"
BACKUP_NODE="backup-1@10.0.3.10:22:10.1.3.10:4090"
BACKUP_SSH_KEY_PATH="~/.ssh/backup"
`));
    expect(result.ok).toBe(false);
    const problems = result.problems.join(" ");
    expect(problems).toContain("BACKUP_PRIMARY_S3_BUCKET");
    expect(problems).toContain("BACKUP_ENCRYPTION_KEY_HEX");
  });

  test("the shipped example env remains a valid legacy single-host configuration", () => {
    const example = requireConfig(require("node:fs").readFileSync("deploy.env.example", "utf8"));
    expect(example.PG_VERSION).toBe("18");
    expect(example.PGBOUNCER_PORT).toBe(6432);
    expect(example.BACKUP_DAEMON_PORT).toBe(4090);
  });
});
