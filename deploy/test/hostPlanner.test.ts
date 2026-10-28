import { describe, expect, test } from "bun:test";
import { loadDeployConfig, parseDeployEnv } from "../lib/configSchema";
import { findSshConflicts, planHosts, renderTopology } from "../lib/hostPlanner";

const base = `
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

const withOverrides = (overrides: string): string => `${base}\n${overrides}\n`;

const requireConfig = (source: string) => {
  const result = loadDeployConfig(source);
  if (!result.ok || !result.config) {
    throw new Error(`expected a valid config, got: ${result.problems.join("; ")}`);
  }
  return result.config;
};

describe("deploy env parser", () => {
  test("handles quoted values, inline comments and blank lines", () => {
    const parsed = parseDeployEnv(`
# a comment
A="hello world"
B=plain-value
C='single quoted'
D="value with # hash"
`);
    expect(parsed).toEqual({ A: "hello world", B: "plain-value", C: "single quoted", D: "value with # hash" });
  });
});

describe("deploy config validation", () => {
  test("accepts a complete five-host configuration", () => {
    const config = requireConfig(base);
    expect(config.DB_ENGINE).toBe("mysql");
    expect(config.CORE_PORT).toBe(4000);
    expect(config.ADMIN_NGINX_LAN_PORT).toBe(8443);
    expect(config.KEEP_RELEASES).toBe(5);
    expect(config.ROTATE_MTLS_CERTS).toBe(false);
  });

  test("defaults the optional sections", () => {
    const config = requireConfig(base);
    expect(config.MERCHANT_SSL_MODE).toBe("certbot");
    expect(config.LAN_ALLOWED_CIDRS).toContain("10.0.0.0/8");
    expect(config.RUN_PRISMA_SEED).toBe(false);
    expect(config.REDIS_URL).toBeUndefined();
  });

  test("rejects a DATABASE_URL that disagrees with DB_ENGINE", () => {
    const result = loadDeployConfig(withOverrides(`DB_ENGINE="postgresql"`));
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toContain("DATABASE_URL must start with postgresql://");
  });

  test("allows a single-box install where the database is co-located with the core", () => {
    const result = loadDeployConfig(withOverrides(`CORE_PRIVATE_IP="10.10.0.10"`));
    expect(result.ok).toBe(true);
  });

  test("rejects an invalid IP, CIDR, identifier and short password", () => {
    expect(loadDeployConfig(withOverrides(`CORE_SSH_HOST="10.10.0.999"`)).ok).toBe(false);
    expect(loadDeployConfig(withOverrides(`LAN_ALLOWED_CIDRS="not-a-cidr"`)).ok).toBe(false);
    expect(loadDeployConfig(withOverrides(`DB_NAME="bad-name"`)).ok).toBe(false);
    expect(loadDeployConfig(withOverrides(`DB_PASSWORD="short"`)).ok).toBe(false);
  });

  test("requires the certificate paths in custom SSL mode", () => {
    const result = loadDeployConfig(withOverrides(`MERCHANT_SSL_MODE="custom"`));
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toContain("MERCHANT_SSL_CERT_PATH");
  });

  test("rejects identical merchant and checkout domains and clashing ports", () => {
    expect(loadDeployConfig(withOverrides(`CHECKOUT_DOMAIN="merchant.example.ly"`)).ok).toBe(false);
    expect(loadDeployConfig(withOverrides(`ADMIN_BACK_PORT="4000"`)).ok).toBe(false);
  });
});

describe("host planner", () => {
  test("scenario A — five separate servers", () => {
    const plan = planHosts(requireConfig(base));
    expect(plan.topology).toBe("distributed");
    expect(plan.hosts).toHaveLength(5);
    const core = plan.hosts.find((host) => host.roles.includes("core"));
    expect(core?.services.map((service) => service.name)).toEqual(["pg-core-back"]);
    expect(core?.certs).toEqual(["core-server"]);
    expect(core?.nginx).toHaveLength(0);
    const admin = plan.hosts.find((host) => host.roles.includes("admin"));
    expect(admin?.nginx[0]?.site).toBe("admin-lan");
    expect(admin?.nginx[0]?.listenPort).toBe(8443);
  });

  test("scenario B — a 2-host split", () => {
    // Admin shares the core host; checkout shares the merchant host. The
    // database is managed outside the deploy (DB_MANAGE_VIA_SSH=false), so the
    // plan is exactly two application hosts.
    const plan = planHosts(requireConfig(`
${base}
DB_MANAGE_VIA_SSH="false"
ADMIN_SSH_HOST="10.10.0.20"
ADMIN_SSH_KEY_PATH="~/.ssh/core"
CHECKOUT_SSH_HOST="203.0.113.10"
CHECKOUT_SSH_KEY_PATH="~/.ssh/merchant"
`));
    expect(plan.topology).toBe("split");
    expect(plan.hosts).toHaveLength(2);
    const internal = plan.hosts.find((host) => host.ssh.host === "10.10.0.20");
    expect(internal?.roles.sort()).toEqual(["admin", "core"]);
    expect(internal?.services.map((service) => service.name).sort()).toEqual(["pg-admin-back", "pg-core-back"]);
    expect(internal?.certs.sort()).toEqual(["admin-client", "core-server"]);
    expect(internal?.nginx.map((site) => site.site)).toEqual(["admin-lan"]);

    const edge = plan.hosts.find((host) => host.ssh.host === "203.0.113.10");
    expect(edge?.roles.sort()).toEqual(["checkout", "merchant"]);
    expect(edge?.nginx.map((site) => site.site).sort()).toEqual([
      "checkout-lan",
      "checkout-public",
      "merchant-lan",
      "merchant-public",
    ]);
    expect(edge?.certs.sort()).toEqual(["checkout-client", "merchant-client"]);
  });

  test("scenario C — a single all-in-one host", () => {
    const plan = planHosts(requireConfig(`
${base}
DB_MANAGE_VIA_SSH="false"
CORE_SSH_HOST="127.0.0.1"
CORE_PRIVATE_IP="127.0.0.1"
CORE_SSH_KEY_PATH="~/.ssh/one"
ADMIN_SSH_HOST="127.0.0.1"
ADMIN_SSH_KEY_PATH="~/.ssh/one"
ADMIN_PRIVATE_IP="127.0.0.1"
MERCHANT_SSH_HOST="127.0.0.1"
MERCHANT_SSH_KEY_PATH="~/.ssh/one"
MERCHANT_PRIVATE_IP="127.0.0.1"
CHECKOUT_SSH_HOST="127.0.0.1"
CHECKOUT_SSH_KEY_PATH="~/.ssh/one"
CHECKOUT_PRIVATE_IP="127.0.0.1"
`));
    expect(plan.topology).toBe("single-host");
    expect(plan.hosts).toHaveLength(1);
    const host = plan.hosts[0]!;
    expect(host.roles.sort()).toEqual(["admin", "checkout", "core", "merchant"]);
    expect(host.services).toHaveLength(4);
    expect(host.nginx).toHaveLength(5);
    // The firewall is the union: the core port, the LAN admin port and 443.
    const ports = host.firewall.map((rule) => rule.port);
    expect(ports).toContain(4000);
    expect(ports).toContain(8443);
    expect(ports).toContain(443);
    // LAN-only, no-domain listeners for the merchant and checkout portals.
    expect(ports).toContain(8081);
    expect(ports).toContain(8082);
  });

  test("the firewall restricts the database and the core to the right peers", () => {
    const plan = planHosts(requireConfig(base));
    const db = plan.hosts.find((host) => host.roles.includes("db"));
    const dbRule = db?.firewall.find((rule) => rule.port === 3306);
    expect(dbRule?.fromCidrs).toEqual(["10.10.0.20"]);

    const core = plan.hosts.find((host) => host.roles.includes("core"));
    const coreRule = core?.firewall.find((rule) => rule.port === 4000);
    expect(coreRule?.fromCidrs?.sort()).toEqual(["10.10.0.30", "10.10.0.40", "10.10.0.50"]);

    // The edge opens SSH + 80/443 publicly and the LAN-only portals to the LAN.
    const merchant = plan.hosts.find((host) => host.roles.includes("merchant"));
    expect(merchant?.firewall.map((rule) => rule.port).sort((left, right) => left - right)).toEqual([22, 80, 443, 8081]);
    const lanRule = merchant?.firewall.find((rule) => rule.port === 8081);
    expect(lanRule?.fromCidrs).toContain("192.168.0.0/16");
    expect(merchant?.firewall.filter((rule) => rule.port === 443).every((rule) => rule.fromCidrs === undefined)).toBe(true);
  });

  test("an edge .env never contains a database credential or the KMS key", () => {
    const plan = planHosts(requireConfig(base));
    const edge = plan.hosts.filter((host) => !host.roles.includes("core"));
    for (const host of edge) {
      for (const service of host.services) {
        expect(Object.keys(service.env)).not.toContain("DATABASE_URL");
        expect(Object.keys(service.env)).not.toContain("KMS_MASTER_KEY");
      }
    }
    const core = plan.hosts.find((host) => host.roles.includes("core"));
    expect(core?.services[0]?.env.DATABASE_URL).toContain("mysql://");
    expect(core?.services[0]?.env.KMS_MASTER_KEY).toBeDefined();
    expect(core?.services[0]?.env.MTLS_SERVER_CERT_PATH).toBe("shared/certs/core-back.crt");
  });

  test("two roles on one host with different keys is rejected", () => {
    const config = requireConfig(`
${base}
ADMIN_SSH_HOST="10.10.0.20"
ADMIN_SSH_KEY_PATH="~/.ssh/other-key"
`);
    const conflicts = findSshConflicts(config);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toContain("more than one SSH key");
    expect(() => planHosts(config)).toThrow(/more than one SSH key/);
  });

  test("the topology map lists every host and service", () => {
    const map = renderTopology(planHosts(requireConfig(base)));
    expect(map).toContain("Topology: distributed (5 hosts)");
    expect(map).toContain("pg-core-back");
    expect(map).toContain("admin-lan");
    expect(map).toContain("8443<=10.0.0.0/8|192.168.0.0/16");
  });
});
