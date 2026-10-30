/**
 * Suite 10.3 — multi-host deployment matrix.
 *
 * 1/2/5/6-host topologies, firewall rule unions, PKI SAN binding and nginx
 * template rendering, driven through the real deploy libraries.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadDeployConfig } from "../lib/configSchema";
import {
  findSshConflicts,
  planHosts,
  renderTopology,
} from "../lib/hostPlanner";
import { buildFirewallPlan, ufwCommandsForRule } from "../lib/firewallConfigurator";
import { buildPki, certFilesForHost } from "../lib/pkiManager";
import { renderNginxTemplate } from "../deploy";

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

const SINGLE = `
${BASE}
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
`;

const SPLIT = `
${BASE}
DB_MANAGE_VIA_SSH="false"
ADMIN_SSH_HOST="10.10.0.20"
ADMIN_SSH_KEY_PATH="~/.ssh/core"
CHECKOUT_SSH_HOST="203.0.113.10"
CHECKOUT_SSH_KEY_PATH="~/.ssh/merchant"
`;

const SIX = `
${BASE}
FAKE_RAILS_ENABLED="true"
FAKE_RAILS_SSH_HOST="203.0.113.30"
FAKE_RAILS_SSH_KEY_PATH="~/.ssh/fakerails"
FAKE_RAILS_PRIVATE_IP="10.10.0.60"
FAKE_RAILS_ADMIN_USER="tester_admin"
FAKE_RAILS_ADMIN_PASSWORD="Strong-Tester-Pass-2026!"
FAKE_RAILS_JWT_SECRET="0123456789abcdef0123456789abcdef"
FAKE_RAILS_SEEDER_TOKEN="0123456789abcdef0123456789abcdef"
`;

const config = (source: string) => {
  const result = loadDeployConfig(source);
  if (!result.ok || !result.config) {
    throw new Error(result.problems.join("; "));
  }
  return result.config;
};

describe("Suite 10 · deploy topology matrix", () => {
  test("5-host distributed topology", () => {
    const plan = planHosts(config(BASE));
    expect(plan.topology).toBe("distributed");
    expect(plan.hosts).toHaveLength(5);
    expect(plan.hosts.flatMap((host) => host.services)).toHaveLength(4);
  });

  test("1-host all-in-one topology", () => {
    const plan = planHosts(config(SINGLE));
    expect(plan.topology).toBe("single-host");
    expect(plan.hosts).toHaveLength(1);
    const host = plan.hosts[0]!;
    expect(host.roles.sort()).toEqual(["admin", "checkout", "core", "merchant"]);
    expect(host.services.map((service) => service.name).sort()).toEqual([
      "pg-admin-back",
      "pg-checkout-back",
      "pg-core-back",
      "pg-merchant-back",
    ]);
    expect(host.nginx).toHaveLength(5);
  });

  test("2-host split topology", () => {
    const plan = planHosts(config(SPLIT));
    expect(plan.topology).toBe("split");
    expect(plan.hosts).toHaveLength(2);
    const internal = plan.hosts.find((host) => host.ssh.host === "10.10.0.20")!;
    expect(internal.roles.sort()).toEqual(["admin", "core"]);
    const edge = plan.hosts.find((host) => host.ssh.host === "203.0.113.10")!;
    expect(edge.roles.sort()).toEqual(["checkout", "merchant"]);
  });

  test("6-host topology with Fake Rails", () => {
    const plan = planHosts(config(SIX));
    expect(plan.hosts).toHaveLength(6);
    const fakeRails = plan.hosts.find((host) => host.roles.includes("fake-rails"));
    expect(fakeRails).toBeDefined();
    expect(fakeRails?.services.map((service) => service.name)).toEqual(["pg-fake-rails-back"]);
    expect(fakeRails?.certs).toEqual(["fake-rails-server"]);
    expect(fakeRails?.nginx.map((site) => site.site)).toEqual(["fake-rails"]);
  });

  test("the topology map names every service and site", () => {
    const map = renderTopology(planHosts(config(SIX)));
    expect(map).toContain("pg-core-back");
    expect(map).toContain("pg-fake-rails-back");
    expect(map).toContain("fake-rails");
  });

  test("conflicting SSH keys on one host are rejected", () => {
    const conflicts = findSshConflicts(config(`
${BASE}
ADMIN_SSH_HOST="10.10.0.20"
ADMIN_SSH_KEY_PATH="~/.ssh/other"
`));
    expect(conflicts).toHaveLength(1);
  });
});

describe("Suite 10 · firewall unions", () => {
  test("the base policy denies inbound and allows outbound", () => {
    const plan = buildFirewallPlan(planHosts(config(SINGLE)).hosts[0]!);
    expect(plan.commands.slice(0, 3).map((command) => command.args)).toEqual([
      ["default", "deny", "incoming"],
      ["default", "allow", "outgoing"],
      ["default", "deny", "routed"],
    ]);
    expect(plan.commands.at(-1)?.args).toEqual(["--force", "enable"]);
  });

  test("a public rule becomes a plain allow", () => {
    const commands = ufwCommandsForRule({
      port: 443,
      protocol: "tcp",
      comment: "https",
    } as never);
    expect(commands).toHaveLength(1);
    expect(commands[0]?.args).toEqual(["allow", "443/tcp", "comment", "https"]);
  });

  test("a CIDR-scoped rule emits one command per CIDR", () => {
    const commands = ufwCommandsForRule({
      port: 4000,
      protocol: "tcp",
      comment: "core",
      fromCidrs: ["10.10.0.30", "10.10.0.40", "10.10.0.50"],
    } as never);
    expect(commands).toHaveLength(3);
    expect(commands[0]?.args).toEqual([
      "allow", "from", "10.10.0.30", "to", "any", "port", "4000", "proto", "tcp", "comment", "core",
    ]);
  });

  test("the single host firewall is the union of all role rules", () => {
    const host = planHosts(config(SINGLE)).hosts[0]!;
    const ports = host.firewall.map((rule) => rule.port);
    for (const port of [22, 4000, 8443, 443, 8081, 8082]) {
      expect(ports).toContain(port);
    }
  });

  test("the database port is restricted to the core host", () => {
    const plan = planHosts(config(BASE));
    const db = plan.hosts.find((host) => host.roles.includes("db"))!;
    const rule = db.firewall.find((entry) => entry.port === 3306);
    expect(rule?.fromCidrs).toEqual(["10.10.0.20"]);
  });

  test("the core port is restricted to the three edge hosts", () => {
    const plan = planHosts(config(BASE));
    const core = plan.hosts.find((host) => host.roles.includes("core"))!;
    const rule = core.firewall.find((entry) => entry.port === 4000);
    expect(rule?.fromCidrs?.sort()).toEqual(["10.10.0.30", "10.10.0.40", "10.10.0.50"]);
  });

  test("the fake-rails host exposes only its portal listeners", () => {
    const plan = planHosts(config(SIX));
    const fakeRails = plan.hosts.find((host) => host.roles.includes("fake-rails"))!;
    const ports = fakeRails.firewall.map((rule) => rule.port);
    expect(ports).toContain(8444);
    expect(ports).not.toContain(4000);
    expect(ports).not.toContain(3306);
  });
});

describe("Suite 10 · PKI and SAN binding", () => {
  const bundle = buildPki({ config: config(BASE), dryRun: true, directory: "/tmp/pg-pki-dry" });

  test("the bundle contains the internal CA and the four leaves", () => {
    expect(bundle.ca.name).toBe("internal-ca");
    expect(bundle.server.name).toBe("core-back");
    expect(bundle.clients.map((client) => client.cn).sort()).toEqual([
      "admin-back",
      "checkout-back",
      "merchant-back",
    ]);
    expect(bundle.fakeRails.name).toBe("fake-rails");
  });

  test("the core certificate SAN is bound to the private IP and loopback", () => {
    expect(bundle.server.sans).toContain("IP:10.10.0.20");
    expect(bundle.server.sans).toContain("IP:127.0.0.1");
    expect(bundle.server.sans).toContain("DNS:core-back.internal");
  });

  test("certFilesForHost distributes the right leaves", () => {
    const coreFiles = certFilesForHost(bundle, ["core"]);
    expect(coreFiles.map((file) => file.name)).toContain("core-back");
    const adminFiles = certFilesForHost(bundle, ["admin"]);
    expect(adminFiles.some((file) => file.cn === "admin-back")).toBe(true);
    const fakeFiles = certFilesForHost(bundle, ["fake-rails"]);
    expect(fakeFiles.some((file) => file.name === "fake-rails")).toBe(true);
  });

  test("a shared host de-duplicates the CA", () => {
    const files = certFilesForHost(bundle, ["admin", "merchant", "checkout"]);
    expect(files.filter((file) => file.name === "internal-ca")).toHaveLength(1);
  });

  test("the six-host bundle includes the fake-rails server SAN", () => {
    const sixBundle = buildPki({ config: config(SIX), dryRun: true, directory: "/tmp/pg-pki-six" });
    expect(sixBundle.fakeRails.sans).toContain("IP:10.10.0.60");
  });
});

describe("Suite 10 · nginx rendering", () => {
  const template = (name: string): string =>
    readFileSync(join(import.meta.dirname, "..", "templates", name), "utf8");

  const names = [
    "nginx.admin.lan.conf.tpl",
    "nginx.merchant.ssl.conf.tpl",
    "nginx.merchant.lan.conf.tpl",
    "nginx.checkout.ssl.conf.tpl",
    "nginx.checkout.lan.conf.tpl",
    "nginx.fakerails.conf.tpl",
  ];

  for (const name of names) {
    test(`${name} renders without a placeholder`, () => {
      const rendered = renderNginxTemplate({
        template: template(name),
        serverName: "example.ly",
        listenPort: 443,
        httpPort: 80,
        httpsPort: 443,
        ssl: name.includes("ssl"),
        sslCertPath: "/etc/ssl/example.ly.crt",
        sslKeyPath: "/etc/ssl/example.ly.key",
        staticRoot: "/var/www/example/current/app/dist",
        backendPort: 4102,
        lanAllowedCidrs: "10.0.0.0/8,192.168.0.0/16",
      });
      expect(rendered).not.toMatch(/\{\{[^}]+\}\}/);
      expect(rendered).toContain("example.ly");
    });
  }

  test("the LAN template restricts the listener to the LAN CIDRs", () => {
    const rendered = renderNginxTemplate({
      template: template("nginx.admin.lan.conf.tpl"),
      serverName: "admin.internal",
      listenPort: 8443,
      httpPort: 80,
      httpsPort: 8443,
      ssl: true,
      sslCertPath: "/etc/ssl/admin.crt",
      sslKeyPath: "/etc/ssl/admin.key",
      staticRoot: "/var/www/admin/dist",
      backendPort: 4101,
      lanAllowedCidrs: "10.0.0.0/8,192.168.0.0/16",
    });
    expect(rendered).toContain("10.0.0.0/8");
    expect(rendered).toContain("192.168.0.0/16");
  });
});
