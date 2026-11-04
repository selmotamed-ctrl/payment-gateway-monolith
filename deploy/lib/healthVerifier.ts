import { edgeCoreUrls, parseNodeList, type DeployConfig } from "./configSchema";
import type { DeployPlan, HostPlan, NodePlan, StorageNodePlan } from "./hostPlanner";
import type { SshRunner } from "./sshRunner";

/**
 * End-to-end verification.
 *
 * The real question is not "is the process running" but "can the admin/merchant/
 * checkout hosts actually complete a mutually authenticated TLS 1.3 handshake
 * with the core, on the channel their certificate is allowed to use". The
 * probes therefore run ON the target host, with that host's own client
 * certificate, exactly as the edge service will.
 */

export interface ProbeResult {
  host: string;
  check: string;
  ok: boolean;
  detail: string;
}

const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

const certsDir = (host: HostPlan, config: DeployConfig): string => {
  const remoteDir = host.roles.includes("core")
    ? config.CORE_REMOTE_DIR
    : host.roles.includes("admin")
      ? config.ADMIN_REMOTE_DIR
      : host.roles.includes("merchant")
        ? config.MERCHANT_REMOTE_DIR
        : host.roles.includes("checkout")
          ? config.CHECKOUT_REMOTE_DIR
          : host.roles.includes("fake-rails")
            ? config.FAKE_RAILS_REMOTE_DIR
            : "/var/lib/pg-backup";
  return `${remoteDir}/shared/certs`;
};

/** A curl probe that pins the CA and presents a client certificate. */
const mtlsCurl = (input: {
  certs: string;
  certName: string;
  url: string;
  expect: string;
  timeoutSeconds?: number;
}): string =>
  [
    `curl -fsS --max-time ${input.timeoutSeconds ?? 10}`,
    `--cacert ${input.certs}/internal-ca.crt`,
    `--cert ${input.certs}/${input.certName}.crt`,
    `--key ${input.certs}/${input.certName}.key`,
    input.url,
  ].join(" ");

/**
 * The core's own mTLS health endpoint (from the core host, loopback).
 * The core server certificate doubles as the client certificate for /health:
 * the TLS layer requires *a* CA-signed certificate, and /health has no CN guard.
 */
export const probeCoreHealth = (
  runner: SshRunner,
  host: HostPlan,
  config: DeployConfig,
): ProbeResult => {
  const certs = certsDir(host, config);
  const coreServices = host.services.filter((service) => service.role === "core");
  const port = coreServices[0]?.port ?? config.CORE_PORT;
  const command = mtlsCurl({
    certs,
    certName: "core-back",
    url: `https://127.0.0.1:${port}/health`,
    expect: "OK",
  });
  const check = coreServices[0] ? `${coreServices[0].name} /health (mTLS)` : "core /health (mTLS)";
  try {
    const body = runner.capture(host.ssh, command);
    const ok = /"msg"\s*:\s*"OK"/.test(body) || body.includes("OK");
    return { host: host.ssh.host, check, ok, detail: body.slice(0, 200) };
  } catch (error) {
    return { host: host.ssh.host, check, ok: false, detail: (error as Error).message };
  }
};

/** Probes one specific core service (used by rolling batches). */
export const probeCoreService = (
  runner: SshRunner,
  host: HostPlan,
  service: { name: string; port: number },
  config: DeployConfig,
): ProbeResult => {
  const certs = `${config.CORE_REMOTE_DIR}/shared/certs`;
  const command = mtlsCurl({
    certs,
    certName: "core-back",
    url: `https://127.0.0.1:${service.port}/health`,
    expect: "OK",
  });
  let lastError = "";
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const body = runner.capture(host.ssh, command);
      return { host: host.ssh.host, check: `${service.name} /health (mTLS)`, ok: /"msg"\s*:\s*"OK"/.test(body) || body.includes("OK"), detail: body.slice(0, 200) };
    } catch (error) {
      lastError = (error as Error).message;
      sleepSync(1_000);
    }
  }
  return { host: host.ssh.host, check: `${service.name} /health (mTLS)`, ok: false, detail: lastError };
};

/** Probes one edge service (used by rolling batches). */
export const probeEdgeService = (
  runner: SshRunner,
  host: HostPlan,
  service: { name: string; port: number; privateIp?: string },
): ProbeResult => {
  const address = service.privateIp ?? "127.0.0.1";
  let lastError = "";
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const body = runner.capture(host.ssh, `curl -fsS --max-time 10 http://${address}:${service.port}/health`);
      return { host: host.ssh.host, check: `${service.name} /health`, ok: /"status"\s*:\s*"ok"/.test(body) || body.includes("ok"), detail: body.slice(0, 200) };
    } catch (error) {
      lastError = (error as Error).message;
      sleepSync(1_000);
    }
  }
  return { host: host.ssh.host, check: `${service.name} /health`, ok: false, detail: lastError };
};

/** Probes every horizontally scaled core node (loopback, mTLS). */
export const probeCoreNodes = (
  runner: SshRunner,
  plan: DeployPlan,
  config: DeployConfig,
): ProbeResult[] => {
  const results: ProbeResult[] = [];
  const cores = plan.nodes.core.length > 0
    ? plan.nodes.core
    : plan.hosts.filter((host) => host.roles.includes("core")).map((host): NodePlan => ({
        nodeId: "core-1",
        id: "core-1",
        role: "core",
        ssh: host.ssh,
        host: host.ssh.host,
        privateIp: config.CORE_PRIVATE_IP ?? host.ssh.host,
        port: config.CORE_PORT,
        servicePort: config.CORE_PORT,
        serviceName: "pg-core-back",
        hostKey: host.key,
      }));
  for (const node of cores) {
    const certs = `${config.CORE_REMOTE_DIR}/shared/certs`;
    const command = mtlsCurl({
      certs,
      certName: "core-back",
      url: `https://127.0.0.1:${node.port}/health`,
      expect: "OK",
    });
    try {
      const body = runner.capture(node.ssh, command);
      results.push({
        host: node.ssh.host,
        check: `${node.nodeId} ${node.serviceName} /health (mTLS)`,
        ok: /"msg"\s*:\s*"OK"/.test(body) || body.includes("OK"),
        detail: body.slice(0, 200),
      });
    } catch (error) {
      results.push({ host: node.ssh.host, check: `${node.nodeId} ${node.serviceName} /health (mTLS)`, ok: false, detail: (error as Error).message });
    }
  }
  return results;
};

/** The edge backend's own /health, from the edge host, over loopback. */
export const probeEdgeBackend = (
  runner: SshRunner,
  host: HostPlan,
  config: DeployConfig,
): ProbeResult[] => {
  const results: ProbeResult[] = [];
  for (const service of host.services) {
    if (service.role === "core") continue;
    try {
      const body = runner.capture(host.ssh, `curl -fsS --max-time 10 http://${service.privateIp ?? "127.0.0.1"}:${service.port}/health`);
      results.push({
        host: host.ssh.host,
        check: `${service.name} /health`,
        ok: /"status"\s*:\s*"ok"/.test(body) || body.includes("ok"),
        detail: body.slice(0, 200),
      });
    } catch (error) {
      results.push({ host: host.ssh.host, check: `${service.name} /health`, ok: false, detail: (error as Error).message });
    }
  }
  return results;
};

/**
 * The critical cross-host check: each edge host presents ITS client
 * certificate to the core. `admin-back` hitting the admin channel, etc. The
 * design's channel-bound CN guard means the certificate must match the role.
 */
export const probeEdgeToCore = (
  runner: SshRunner,
  host: HostPlan,
  config: DeployConfig,
  coreUrls?: string[],
): ProbeResult[] => {
  const results: ProbeResult[] = [];
  const certs = certsDir(host, config);
  const urls = coreUrls && coreUrls.length > 0 ? coreUrls : edgeCoreUrls(config);
  for (const role of ["admin", "merchant", "checkout"] as const) {
    if (!host.roles.includes(role)) continue;
    const channel = role === "checkout" ? "checkout" : role;
    for (const coreUrl of urls) {
      const url = `${coreUrl.replace(/\/$/, "")}/internal/${channel}/health`;
      try {
        const body = runner.capture(host.ssh, mtlsCurl({
          certs,
          certName: `${role}-back-client`,
          url,
          expect: "OK",
        }));
        results.push({
          host: host.ssh.host,
          check: `${role}-back mTLS -> ${coreUrl} /internal/${channel}/health`,
          ok: /"status"\s*:\s*"ok"/.test(body) || /"channel"\s*:\s*"${channel}"/.test(body) || body.includes("ok"),
          detail: body.slice(0, 200),
        });
      } catch (error) {
        results.push({
          host: host.ssh.host,
          check: `${role}-back mTLS -> ${coreUrl} /internal/${channel}/health`,
          ok: false,
          detail: (error as Error).message,
        });
      }
    }
  }
  return results;
};

const result = (node: StorageNodePlan, check: string, ok: boolean, detail: string): ProbeResult => ({
  host: node.ssh.host,
  check: `${node.nodeId} ${check}`,
  ok,
  detail,
});

const psqlSelectOne = (user: string, password: string, database: string, port: number): string =>
  `PGPASSWORD=${JSON.stringify(password)} psql -h 127.0.0.1 -p ${port} -U ${user} -d ${database} -tAc 'SELECT 1'`;

/** PostgreSQL 18 primary/replica readiness (`pg_isready` + `SELECT 1`). */
export const probePostgresNode = (
  runner: SshRunner,
  node: StorageNodePlan,
  config: DeployConfig,
): ProbeResult[] => {
  const results: ProbeResult[] = [];
  const port = node.servicePort;
  try {
    const body = runner.capture(node.ssh, `pg_isready -h 127.0.0.1 -p ${port}`);
    results.push(result(node, `pg_isready :${port}`, /accepting connections/i.test(body), body.slice(0, 200)));
  } catch (error) {
    results.push(result(node, `pg_isready :${port}`, false, (error as Error).message));
  }
  try {
    const body = runner.capture(node.ssh, psqlSelectOne(config.PG_DB_USER, config.PG_DB_PASSWORD, config.PG_DB_NAME, port));
    results.push(result(node, `psql SELECT 1 :${port}`, body.trim() === "1", body.slice(0, 200)));
  } catch (error) {
    results.push(result(node, `psql SELECT 1 :${port}`, false, (error as Error).message));
  }
  return results;
};

export const probePgPrimary = (runner: SshRunner, plan: DeployPlan, config: DeployConfig): ProbeResult[] =>
  plan.storage.postgres.primary ? probePostgresNode(runner, plan.storage.postgres.primary, config) : [];

export const probePgReplicas = (runner: SshRunner, plan: DeployPlan, config: DeployConfig): ProbeResult[] =>
  plan.storage.postgres.replicas.flatMap((node) => probePostgresNode(runner, node, config));

/** PgBouncer transaction-pool health (`psql -p 6432 SELECT 1`). */
export const probePgBouncer = (runner: SshRunner, plan: DeployPlan, config: DeployConfig): ProbeResult[] =>
  plan.storage.pgbouncer.flatMap((node) => {
    try {
      const body = runner.capture(node.ssh, psqlSelectOne(config.PG_DB_USER, config.PG_DB_PASSWORD, config.PG_DB_NAME, config.PGBOUNCER_PORT));
      return [result(node, `pgbouncer psql SELECT 1 :${config.PGBOUNCER_PORT}`, body.trim() === "1", body.slice(0, 200))];
    } catch (error) {
      return [result(node, `pgbouncer psql SELECT 1 :${config.PGBOUNCER_PORT}`, false, (error as Error).message)];
    }
  });

/** Redis PING. Authentication is passed via REDISCLI_AUTH, never argv. */
export const probeRedis = (runner: SshRunner, plan: DeployPlan, config: DeployConfig): ProbeResult[] =>
  plan.storage.redis.flatMap((node) => {
    const auth = config.REDIS_PASSWORD ? `REDISCLI_AUTH=${JSON.stringify(config.REDIS_PASSWORD)} ` : "";
    try {
      const body = runner.capture(node.ssh, `${auth}redis-cli -h 127.0.0.1 -p ${node.servicePort} PING`);
      return [result(node, `redis PING :${node.servicePort}`, /PONG/i.test(body), body.slice(0, 200))];
    } catch (error) {
      return [result(node, `redis PING :${node.servicePort}`, false, (error as Error).message)];
    }
  });

export const probeAuditDb = (runner: SshRunner, plan: DeployPlan, config: DeployConfig): ProbeResult[] => {
  const node = plan.storage.auditDb;
  if (!node) return [];
  try {
    const body = runner.capture(node.ssh, psqlSelectOne(config.AUDIT_DB_USER, config.AUDIT_DB_PASSWORD, config.AUDIT_DB_NAME, node.servicePort));
    return [result(node, `audit DB SELECT 1 :${node.servicePort}`, body.trim() === "1", body.slice(0, 200))];
  } catch (error) {
    return [result(node, `audit DB SELECT 1 :${node.servicePort}`, false, (error as Error).message)];
  }
};

export const probeLogDb = (runner: SshRunner, plan: DeployPlan, config: DeployConfig): ProbeResult[] => {
  const node = plan.storage.logDb;
  if (!node) return [];
  try {
    const body = runner.capture(node.ssh, psqlSelectOne(config.LOG_DB_USER, config.LOG_DB_PASSWORD, config.LOG_DB_NAME, node.servicePort));
    return [result(node, `log DB SELECT 1 :${node.servicePort}`, body.trim() === "1", body.slice(0, 200))];
  } catch (error) {
    return [result(node, `log DB SELECT 1 :${node.servicePort}`, false, (error as Error).message)];
  }
};

/** backup-daemon /health over mTLS when the backup engine is configured. */
export const probeBackupDaemon = (runner: SshRunner, plan: DeployPlan, config: DeployConfig): ProbeResult[] => {
  const node = plan.storage.backup;
  if (!node || !config.BACKUP_ENABLED) return [];
  const certs = config.BACKUP_DAEMON_CERT_DIR;
  const configuredBind = config.BACKUP_DAEMON_BIND_HOST.trim();
  const healthHost = !configuredBind || configuredBind === "0.0.0.0" ? node.privateIp : configuredBind;
  const command = mtlsCurl({
    certs,
    certName: "backup-daemon",
    url: `https://${healthHost}:${config.BACKUP_DAEMON_PORT}/health`,
    expect: "OK",
  });
  try {
    const body = runner.capture(node.ssh, command, { sudo: true });
    return [result(node, "backup-daemon /health (mTLS)", /"status"\s*:\s*"ok"/.test(body) || body.includes("ok"), body.slice(0, 200))];
  } catch (error) {
    return [result(node, "backup-daemon /health (mTLS)", false, (error as Error).message)];
  }
};

export const probeStorage = (runner: SshRunner, plan: DeployPlan, config: DeployConfig): ProbeResult[] => [
  ...probePgPrimary(runner, plan, config),
  ...probePgReplicas(runner, plan, config),
  ...(config.PGBOUNCER_ENABLED ? probePgBouncer(runner, plan, config) : []),
  ...probeRedis(runner, plan, config),
  ...probeAuditDb(runner, plan, config),
  ...probeLogDb(runner, plan, config),
  ...probeBackupDaemon(runner, plan, config),
];

/** The Fake Rails service: backend /health and the Nginx vhost. */
export const probeFakeRails = (
  runner: SshRunner,
  host: HostPlan,
  config: DeployConfig,
): ProbeResult[] => {
  const results: ProbeResult[] = [];
  const fakeRailsPort = parseNodeList(config.FAKE_RAILS_NODE)[0]?.servicePort ?? config.FAKE_RAILS_BACK_PORT;
  try {
    const body = runner.capture(host.ssh, `curl -fsS --max-time 10 http://127.0.0.1:${fakeRailsPort}/health`);
    results.push({
      host: host.ssh.host,
      check: "fake-rails-back /health",
      ok: /"status"\s*:\s*"ok"/.test(body),
      detail: body.slice(0, 200),
    });
  } catch (error) {
    results.push({ host: host.ssh.host, check: "fake-rails-back /health", ok: false, detail: (error as Error).message });
  }
  const scheme = config.FAKE_RAILS_SSL ? "https" : "http";
  const insecure = config.FAKE_RAILS_SSL ? " -k" : "";
  try {
    const body = runner.capture(
      host.ssh,
      `curl -fsS --max-time 10${insecure} ${scheme}://127.0.0.1:${config.FAKE_RAILS_NGINX_PORT}/health`,
    );
    results.push({
      host: host.ssh.host,
      check: `fake-rails vhost ${scheme}:${config.FAKE_RAILS_NGINX_PORT}`,
      ok: /"status"\s*:\s*"ok"/.test(body),
      detail: body.slice(0, 200),
    });
  } catch (error) {
    results.push({
      host: host.ssh.host,
      check: `fake-rails vhost ${scheme}:${config.FAKE_RAILS_NGINX_PORT}`,
      ok: false,
      detail: (error as Error).message,
    });
  }
  return results;
};

/** The public TLS vhost of an edge host, from the edge host itself. */
export const probePublicVhost = (
  runner: SshRunner,
  host: HostPlan,
  config: DeployConfig,
): ProbeResult[] => {
  const results: ProbeResult[] = [];
  for (const site of host.nginx) {
    // The admin vhost is covered by the edge-backend probe; the merchant and
    // checkout vhosts (public and LAN) are probed on their configured port and
    // scheme, so SSL can be enabled or disabled per site.
    if (site.sslMode === "lan") continue;
    const scheme = site.ssl ? "https" : "http";
    const insecure = site.ssl ? " -k" : "";
    const base = `${scheme}://127.0.0.1:${site.listenPort}`;
    try {
      const body = runner.capture(
        host.ssh,
        `curl -fsS --max-time 10${insecure} ${base}/health || curl -fsS --max-time 10${insecure} ${base}/ -o /dev/null -w '%{http_code}'`,
      );
      results.push({
        host: host.ssh.host,
        check: `vhost ${site.site} ${scheme}:${site.listenPort}`,
        ok: body.length > 0,
        detail: body.slice(0, 200),
      });
    } catch (error) {
      results.push({
        host: host.ssh.host,
        check: `vhost ${site.site} ${scheme}:${site.listenPort}`,
        ok: false,
        detail: (error as Error).message,
      });
    }
  }
  return results;
};

export interface DeploymentVerification {
  ok: boolean;
  results: ProbeResult[];
}

export const verifyDeployment = (
  runner: SshRunner,
  plan: DeployPlan,
  config: DeployConfig,
): DeploymentVerification => {
  const results: ProbeResult[] = probeCoreNodes(runner, plan, config);
  const coreUrls = edgeCoreUrls(config);
  for (const host of plan.hosts) {
    if (host.roles.includes("fake-rails")) {
      results.push(...probeFakeRails(runner, host, config));
    }
    if (host.roles.some((role) => role === "admin" || role === "merchant" || role === "checkout")) {
      results.push(...probeEdgeBackend(runner, host, config));
      results.push(...probeEdgeToCore(runner, host, config, coreUrls));
      results.push(...probePublicVhost(runner, host, config));
    }
  }
  results.push(...probeStorage(runner, plan, config));
  return { ok: results.every((result) => result.ok), results };
};

export const renderVerification = (verification: DeploymentVerification): string => {
  const lines = verification.results.map(
    (result) => `  ${result.ok ? "PASS" : "FAIL"}  ${result.host}  ${result.check}${result.ok ? "" : ` :: ${result.detail}`}`,
  );
  return [`Verification: ${verification.ok ? "OK" : "FAILED"}`, ...lines].join("\n");
};
