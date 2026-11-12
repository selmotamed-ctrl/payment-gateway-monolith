import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { loadDeployConfig } from "../lib/configSchema";
import { planHosts } from "../lib/hostPlanner";
import { buildPreflightPlan, classifyPort, runPreflight, type HostSnapshot } from "../lib/preflight";
import { isFullDeployment, normalizeOnlyRole, selectedStorage } from "../lib/selection";

const REPO_ROOT = resolve(import.meta.dir, "../..");

const SOURCE = `
DEPLOY_ENV="test"
CORE_NODES="core-1@10.0.0.10:22:10.0.0.10:4000"
CORE_SSH_KEY_PATH="~/.ssh/deploy"
ADMIN_NODES="admin-1@10.0.0.10:22:10.0.0.10:4101"
ADMIN_SSH_KEY_PATH="~/.ssh/deploy"
ADMIN_NGINX_LAN_PORT="8080"
ADMIN_SSL="false"
MERCHANT_NODES="merch-1@10.0.0.10:22:10.0.0.10:4102"
MERCHANT_SSH_KEY_PATH="~/.ssh/deploy"
MERCHANT_DOMAIN="merchant.example.ly"
CHECKOUT_NODES="chk-1@10.0.0.10:22:10.0.0.10:4103"
CHECKOUT_SSH_KEY_PATH="~/.ssh/deploy"
CHECKOUT_DOMAIN="pay.example.ly"
KMS_MASTER_KEY="kms-Q7x9Lm2Zr4Vb8Nc1Wd5Tg3Hy6Jp0Sa2"
PG_MANAGE_VIA_SSH="true"
PG_PRIMARY_NODE="pg-pri@10.0.0.10:22:10.0.0.10:5432"
PG_SSH_KEY_PATH="~/.ssh/deploy"
PG_DB_PASSWORD="ultra-strong-pg-K7p2Zq9w"
PGBOUNCER_ENABLED="true"
`;

const load = () => {
  const result = loadDeployConfig(SOURCE);
  if (!result.ok || !result.config) throw new Error(result.problems.join("; "));
  return { config: result.config, plan: planHosts(result.config) };
};

const options = (only: string[] = [], extra: Partial<Parameters<typeof buildPreflightPlan>[2]> = {}) => ({
  only: new Set(only),
  fresh: false,
  deployMode: "update" as const,
  dryRun: false,
  stopUnmanaged: false,
  ...extra,
});

const snapshot = (overrides: Partial<HostSnapshot> = {}): HostSnapshot => ({
  reachable: true,
  sudo: true,
  os: "arch",
  tools: { systemctl: true, ps: true, ss: true, rsync: true, curl: true, bun: true, pm2: true, nginx: true },
  diskFreeKb: { "/": 32 * 1024 * 1024 },
  memoryMb: 16_384,
  clockSeconds: Math.floor(Date.now() / 1000),
  pm2Apps: [],
  processes: [],
  ports: [],
  cwds: new Map(),
  nginxTest: "nginx: configuration file /etc/nginx/nginx.conf test is successful",
  units: {},
  ...overrides,
});

describe("preflight selection", () => {
  test("normalizes backend service aliases", () => {
    expect(normalizeOnlyRole("admin-back")).toBe("admin");
    expect(normalizeOnlyRole("core-back")).toBe("core");
    expect(normalizeOnlyRole("fake-rails-back")).toBe("fake-rails");
  });

  test("admin-only checks the admin port and Nginx, not core's port", () => {
    const { config, plan } = load();
    const preflight = buildPreflightPlan(config, plan, options([normalizeOnlyRole("admin-back")]));
    expect(preflight.ports.some((check) => check.port === 4101)).toBe(true);
    expect(preflight.ports.some((check) => check.port === 8080)).toBe(true);
    expect(preflight.ports.some((check) => check.port === 4000)).toBe(false);
    expect(preflight.dependencies.some((check) => check.kind === "edge-core")).toBe(true);
  });

  test("core-only checks core and its database dependency, not the edge ports", () => {
    const { config, plan } = load();
    const preflight = buildPreflightPlan(config, plan, options(["core"]));
    expect(preflight.ports.some((check) => check.port === 4000)).toBe(true);
    expect(preflight.ports.some((check) => check.port === 4101)).toBe(false);
    expect(preflight.dependencies.some((check) => check.kind === "core-db")).toBe(true);
  });

  test("release identity is global only for a full deploy", () => {
    expect(isFullDeployment({ only: new Set() })).toBe(true);
    expect(isFullDeployment({ only: new Set(["admin"]) })).toBe(false);
    expect(isFullDeployment({ only: new Set(), nodes: new Set(["core-2"]) })).toBe(false);
  });

  test("a full deploy selects every compute tier and managed storage tier", () => {
    const { config, plan } = load();
    const preflight = buildPreflightPlan(config, plan, options());
    expect(preflight.selection.compute).toEqual(["admin", "checkout", "core", "merchant"]);
    expect(preflight.selection.storage).toEqual(["postgres"]);
    expect(preflight.ports.some((check) => check.port === 4000)).toBe(true);
    expect(preflight.ports.some((check) => check.port === 5432)).toBe(true);
  });

  test("selectedStorage follows --only=storage and individual tiers", () => {
    expect(selectedStorage(options(["storage"]))).toMatchObject({ postgres: true, redis: true, backup: true, objectStorage: true });
    expect(selectedStorage(options(["pg"]))).toMatchObject({ postgres: true, redis: false, backup: false });
  });

  test("dry-run makes no remote calls", () => {
    const { config, plan } = load();
    const fakeRunner = { capture: () => { throw new Error("must not connect"); } } as never;
    const report = runPreflight(fakeRunner, config, plan, options([], { dryRun: true }));
    expect(report.blocking).toEqual([]);
    expect(report.results.every((entry) => entry.status === "skip")).toBe(true);
  });
});

describe("preflight port ownership classification", () => {
  const coreCheck = () => {
    const { config, plan } = load();
    return buildPreflightPlan(config, plan, options()).ports.find((check) => check.port === 4000)!;
  };

  test("free, managed-current, managed-orphan, same-repo dev and foreign", () => {
    const check = coreCheck();
    expect(classifyPort(check, snapshot()).classification).toBe("free");

    const current = snapshot({
      pm2Apps: [{ name: "pg-core-back", pid: 100, cwd: "/var/www/pg-core/releases/core-1/20260101000000/core-back", status: "online" }],
      processes: [{ pid: 100, ppid: 1, user: "salem", elapsed: "1", command: "bun" }],
      ports: [{ port: 4000, address: "0.0.0.0:4000", pid: 100, process: "bun" }],
    });
    expect(classifyPort(check, current).classification).toBe("managed-current");

    const orphan = snapshot({
      pm2Apps: [{ name: "pg-core-back-core-2", pid: 101, cwd: "/var/www/pg-core/releases/core-2/20260101000000/core-back", status: "online" }],
      processes: [{ pid: 101, ppid: 1, user: "salem", elapsed: "1", command: "bun" }],
      ports: [{ port: 4000, address: "0.0.0.0:4000", pid: 101, process: "bun" }],
    });
    expect(classifyPort(check, orphan).classification).toBe("managed-orphan");

    const dev = snapshot({
      processes: [{ pid: 102, ppid: 1, user: "salem", elapsed: "1", command: "bun run index.ts" }],
      ports: [{ port: 4000, address: "0.0.0.0:4000", pid: 102, process: "bun" }],
      cwds: new Map([[102, { cwd: `${REPO_ROOT}/core-back`, packageName: "core-back" }]]),
    });
    expect(classifyPort(check, dev).classification).toBe("unmanaged-same-repo");

    const foreign = snapshot({
      processes: [{ pid: 103, ppid: 1, user: "root", elapsed: "1", command: "other-service" }],
      ports: [{ port: 4000, address: "0.0.0.0:4000", pid: 103, process: "other-service" }],
    });
    expect(classifyPort(check, foreign).classification).toBe("foreign");
  });

  test("nginx is managed; a non-nginx listener is foreign", () => {
    const { config, plan } = load();
    const nginxCheck = buildPreflightPlan(config, plan, options(["admin"])).ports.find((check) => check.port === 8080)!;
    const nginx = snapshot({
      processes: [{ pid: 200, ppid: 1, user: "http", elapsed: "1", command: "nginx: master process /usr/bin/nginx" }],
      ports: [{ port: 8080, address: "0.0.0.0:8080", pid: 200, process: "nginx" }],
    });
    expect(classifyPort(nginxCheck, nginx).classification).toBe("managed-service");
    const other = snapshot({
      processes: [{ pid: 201, ppid: 1, user: "root", elapsed: "1", command: "apache2" }],
      ports: [{ port: 8080, address: "0.0.0.0:8080", pid: 201, process: "apache2" }],
    });
    expect(classifyPort(nginxCheck, other).classification).toBe("foreign");
  });

  test("postgres must run from the expected data directory", () => {
    const { config, plan } = load();
    const pgCheck = buildPreflightPlan(config, plan, options()).ports.find((check) => check.port === 5432)!;
    const correct = snapshot({
      processes: [{ pid: 300, ppid: 1, user: "postgres", elapsed: "1", command: "/usr/bin/postgres -D /var/lib/postgresql/18/main -p 5432" }],
      ports: [{ port: 5432, address: "127.0.0.1:5432", pid: 300, process: "postgres" }],
    });
    expect(classifyPort(pgCheck, correct).classification).toBe("managed-service");
    const wrong = snapshot({
      processes: [{ pid: 301, ppid: 1, user: "salem", elapsed: "1", command: "/usr/bin/postgres -D /tmp/other -p 5432" }],
      ports: [{ port: 5432, address: "127.0.0.1:5432", pid: 301, process: "postgres" }],
    });
    expect(classifyPort(pgCheck, wrong).classification).toBe("foreign");
  });
});
