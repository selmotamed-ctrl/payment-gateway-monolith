import { describe, expect, test } from "bun:test";
import { loadDeployConfig } from "../lib/configSchema";
import { planHosts } from "../lib/hostPlanner";
import { bootstrapPackagesCommand, installPackageCommand } from "../lib/osDetector";
import { isLocalTarget } from "../lib/sshRunner";

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

const fakeRails = `
FAKE_RAILS_ENABLED="true"
FAKE_RAILS_ALLOW_IN_PRODUCTION="true"
IS_TEST_SERVER="true"
FAKE_RAILS_SSH_HOST="10.10.0.60"
FAKE_RAILS_SSH_KEY_PATH="~/.ssh/fakerails"
FAKE_RAILS_PRIVATE_IP="10.10.0.60"
FAKE_RAILS_DOMAIN="fakerails.internal"
FAKE_RAILS_PUBLIC_BASE_URL="https://10.10.0.60:8444"
FAKE_RAILS_ADMIN_USER="tester_admin"
FAKE_RAILS_ADMIN_PASSWORD="ChangeMe-Strong-Tester-Pass-2026!"
FAKE_RAILS_JWT_SECRET="0123456789abcdef0123456789abcdef"
FAKE_RAILS_SEEDER_TOKEN="0123456789abcdef0123456789abcdef"
`;

const requireConfig = (source: string) => {
  const result = loadDeployConfig(source);
  if (!result.ok || !result.config) throw new Error(result.problems.join("; "));
  return result.config;
};

describe("fake rails deploy configuration", () => {
  test("accepts a dedicated fake rails host and plans the role", () => {
    const config = requireConfig(`${base}\n${fakeRails}`);
    const plan = planHosts(config);
    expect(plan.roles["fake-rails"]).toBe("10.10.0.60");
    const host = plan.hosts.find((candidate) => candidate.roles.includes("fake-rails"))!;
    expect(host.services.some((service) => service.name === "pg-fake-rails-back")).toBe(true);
    expect(host.nginx.some((site) => site.site === "fake-rails")).toBe(true);
    expect(host.certs).toContain("fake-rails-server");
  });

  test("rejects production without the explicit opt-in", () => {
    const result = loadDeployConfig(`${base}\n${fakeRails}\nDEPLOY_ENV="production"\nFAKE_RAILS_ALLOW_IN_PRODUCTION="false"`);
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toContain("FAKE_RAILS_PRODUCTION_GUARD_BLOCKED");
  });

  test("requires the tester credentials when enabled", () => {
    const result = loadDeployConfig(`${base}\n${fakeRails.replace(/FAKE_RAILS_ADMIN_PASSWORD=.*\n/, "")}`);
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toContain("FAKE_RAILS_ADMIN_PASSWORD");
  });

  test("rejects a fake rails port collision", () => {
    const result = loadDeployConfig(`${base}\n${fakeRails}\nFAKE_RAILS_NGINX_PORT="8443"`);
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toContain("FAKE_RAILS_NGINX_PORT must differ from ADMIN_NGINX_LAN_PORT");
  });

  test("synthetic seeding requires a declared test server with fake rails", () => {
    const result = loadDeployConfig(`${base}\nRUN_SYNTHETIC_HISTORY_SEED="true"`);
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toContain("RUN_SYNTHETIC_HISTORY_SEED requires IS_TEST_SERVER=true");
  });
});

describe("Arch Linux and localhost support", () => {
  test("detects the local execution target", () => {
    const target = (host: string) => ({ host, port: 22, user: "u", keyPath: "~/.ssh/k", sudoPassword: "" });
    expect(isLocalTarget(target("127.0.0.1"))).toBe(true);
    expect(isLocalTarget(target("localhost"))).toBe(true);
    expect(isLocalTarget(target("10.10.0.20"))).toBe(false);
  });

  test("uses pacman on Arch and apt-get on Debian", () => {
    expect(bootstrapPackagesCommand("arch")).toContain("pacman -Sy");
    expect(bootstrapPackagesCommand("arch")).not.toContain("apt-get");
    expect(bootstrapPackagesCommand("debian")).toContain("apt-get");
    expect(installPackageCommand("arch", "ufw")).toContain("pacman -S");
    expect(installPackageCommand("debian", "ufw")).toContain("apt-get install");
  });
});
