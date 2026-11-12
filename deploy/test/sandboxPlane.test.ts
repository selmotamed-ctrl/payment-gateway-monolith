import { describe, expect, test } from "bun:test";
import { loadDeployConfig, productionGuardProblems, sandboxPlaneConfigured } from "../lib/configSchema";
import { planHosts } from "../lib/hostPlanner";

const BASE = `
DEPLOY_ENV="production"
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

const FAKE_RAILS = `
FAKE_RAILS_ENABLED="true"
FAKE_RAILS_ALLOW_IN_PRODUCTION="true"
FAKE_RAILS_NODE="fakerails-1@10.10.0.60:22:10.10.0.60:4104"
FAKE_RAILS_SSH_KEY_PATH="~/.ssh/fakerails"
FAKE_RAILS_PRIVATE_IP="10.10.0.60"
FAKE_RAILS_PUBLIC_BASE_URL="http://10.10.0.60:8444"
FAKE_RAILS_ALLOWED_HOSTS="10.10.0.60,127.0.0.1"
FAKE_RAILS_ADMIN_USER="tester_admin"
FAKE_RAILS_ADMIN_PASSWORD="Strong-Tester-Pass-2026!"
FAKE_RAILS_JWT_SECRET="jwt-Rk7Qm2Xv9Lp4Zn8Bc3Wd6Th1Yg5Js0Af"
FAKE_RAILS_SEEDER_TOKEN="seed-Hv3Tn8Yq1Dz6Mk4Pw9Xc2Lb7Rg5Fj0Ua"
`;

const SANDBOX = `
SANDBOX_ENABLED="true"
SANDBOX_NODE="sandbox-1@10.10.0.61:22:10.10.0.61:4005"
SANDBOX_SSH_KEY_PATH="~/.ssh/sandbox"
SANDBOX_PRIVATE_IP="10.10.0.61"
SANDBOX_DB_HOST="10.10.0.61"
SANDBOX_DB_NAME="payment_gateway_sandbox"
SANDBOX_DB_PASSWORD="sandbox-db-U9x2Kp7Lm4Qz8Rt5"
SANDBOX_APP_PASSWORD="sandbox-app-W3c8Ny6Bv2Hj9Sd4"
`;

const source = (extra = "") => `${BASE}\n${FAKE_RAILS}\n${SANDBOX}\n${extra}\n`;

const requireConfig = (input: string) => {
  const result = loadDeployConfig(input);
  if (!result.ok || !result.config) throw new Error(result.problems.join("; "));
  return result.config;
};

describe("parallel sandbox deploy configuration", () => {
  test("allows Fake Rails in production only with the sandbox plane and a distinct database", () => {
    const config = requireConfig(source());
    expect(sandboxPlaneConfigured(config)).toBe(true);
    expect(productionGuardProblems(config)).toEqual([]);
  });

  test("refuses Fake Rails in production without the sandbox plane", () => {
    const result = loadDeployConfig(`${BASE}\n${FAKE_RAILS}\n`);
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toContain("FAKE_RAILS_PRODUCTION_GUARD_BLOCKED");
  });

  test("refuses a sandbox database that shares the live database name", () => {
    const result = loadDeployConfig(`${source()}\nSANDBOX_DB_NAME="gateway"\n`);
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toContain("SANDBOX_DB_NAME must differ");
  });

  test("plans a dedicated sandbox core service with its own env, cert and firewall", () => {
    const config = requireConfig(source());
    const plan = planHosts(config);

    const sandboxNode = plan.nodes["core-sandbox"][0];
    expect(sandboxNode?.serviceName).toBe("pg-core-sandbox");
    expect(sandboxNode?.port).toBe(4005);

    const sandboxHost = plan.hosts.find((host) => host.roles.includes("core-sandbox"));
    expect(sandboxHost).toBeDefined();
    const sandboxService = sandboxHost!.services.find((service) => service.role === "core-sandbox");
    expect(sandboxService).toBeDefined();
    expect(sandboxService!.env.EXECUTION_PLANE).toBe("SANDBOX");
    expect(sandboxService!.env.DATABASE_URL).toContain("payment_gateway_sandbox");
    expect(sandboxService!.env.PGBOUNCER_ENABLED).toBe("false");
    expect(sandboxService!.env.ALLOW_FAKE_RAILS_HOSTS).toBe("true");
    expect(sandboxService!.env.FAKE_RAILS_PUBLIC_BASE_URL).toBe("http://10.10.0.60:8444");
    expect(sandboxHost!.certs).toContain("core-sandbox-server");
    expect(
      sandboxHost!.firewall.some((rule) => rule.port === 4005
        && (rule.fromCidrs ?? []).includes("10.10.0.30")
        && (rule.fromCidrs ?? []).includes("10.10.0.40")),
    ).toBe(true);

    const liveCoreHost = plan.hosts.find((host) => host.roles.includes("core"));
    const liveCore = liveCoreHost!.services.find((service) => service.role === "core")!;
    expect(liveCore.env.EXECUTION_PLANE).toBe("LIVE");
    expect(liveCore.env.FAKE_RAILS_ENABLED).toBe("false");
    expect(liveCore.env.ALLOW_FAKE_RAILS_HOSTS).toBeUndefined();
    expect(liveCore.env.FAKE_RAILS_ALLOWED_HOSTS).toBeUndefined();

    for (const role of ["admin", "merchant", "checkout"] as const) {
      const host = plan.hosts.find((candidate) => candidate.roles.includes(role));
      const service = host?.services.find((candidate) => candidate.role === role);
      expect(service?.env.SANDBOX_CORE_BACK_URLS).toBe("https://10.10.0.61:4005");
    }
  });

  test("keeps live core out of the fake rails firewall allowlist", () => {
    const config = requireConfig(source());
    const plan = planHosts(config);
    const fakeRailsHost = plan.hosts.find((host) => host.roles.includes("fake-rails"));
    expect(fakeRailsHost).toBeDefined();
    const rule = fakeRailsHost!.firewall.find((entry) => entry.port === config.FAKE_RAILS_NGINX_PORT);
    expect(rule).toBeDefined();
    expect(rule!.fromCidrs).toContain("10.10.0.61");
    expect(rule!.fromCidrs).not.toContain("10.10.0.20");
  });
});
