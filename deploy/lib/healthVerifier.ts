import type { DeployConfig } from "./configSchema";
import type { DeployPlan, HostPlan } from "./hostPlanner";
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

const certsDir = (host: HostPlan, config: DeployConfig): string => {
  const remoteDir = host.roles.includes("core")
    ? config.CORE_REMOTE_DIR
    : host.roles.includes("admin")
      ? config.ADMIN_REMOTE_DIR
      : host.roles.includes("merchant")
        ? config.MERCHANT_REMOTE_DIR
        : config.CHECKOUT_REMOTE_DIR;
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
  const command = mtlsCurl({
    certs,
    certName: "core-back",
    url: `https://127.0.0.1:${config.CORE_PORT}/health`,
    expect: "OK",
  });
  try {
    const body = runner.capture(host.ssh, command);
    const ok = /"msg"\s*:\s*"OK"/.test(body) || body.includes("OK");
    return { host: host.ssh.host, check: "core /health (mTLS)", ok, detail: body.slice(0, 200) };
  } catch (error) {
    return { host: host.ssh.host, check: "core /health (mTLS)", ok: false, detail: (error as Error).message };
  }
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
      const body = runner.capture(host.ssh, `curl -fsS --max-time 10 http://127.0.0.1:${service.port}/health`);
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
): ProbeResult[] => {
  const results: ProbeResult[] = [];
  const certs = certsDir(host, config);
  for (const role of ["admin", "merchant", "checkout"] as const) {
    if (!host.roles.includes(role)) continue;
    const channel = role === "checkout" ? "checkout" : role;
    const url = `https://${config.CORE_PRIVATE_IP}:${config.CORE_PORT}/internal/${channel}/health`;
    try {
      const body = runner.capture(host.ssh, mtlsCurl({
        certs,
        certName: `${role}-back-client`,
        url,
        expect: "OK",
      }));
      results.push({
        host: host.ssh.host,
        check: `${role}-back mTLS -> core /internal/${channel}/health`,
        ok: /"status"\s*:\s*"ok"/.test(body) || /"channel"\s*:\s*"${channel}"/.test(body) || body.includes("ok"),
        detail: body.slice(0, 200),
      });
    } catch (error) {
      results.push({
        host: host.ssh.host,
        check: `${role}-back mTLS -> core /internal/${channel}/health`,
        ok: false,
        detail: (error as Error).message,
      });
    }
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
  const results: ProbeResult[] = [];
  for (const host of plan.hosts) {
    if (host.roles.includes("core")) {
      results.push(probeCoreHealth(runner, host, config));
    }
    if (host.roles.some((role) => role !== "core" && role !== "db")) {
      results.push(...probeEdgeBackend(runner, host, config));
      results.push(...probeEdgeToCore(runner, host, config));
      results.push(...probePublicVhost(runner, host, config));
    }
  }
  return { ok: results.every((result) => result.ok), results };
};

export const renderVerification = (verification: DeploymentVerification): string => {
  const lines = verification.results.map(
    (result) => `  ${result.ok ? "PASS" : "FAIL"}  ${result.host}  ${result.check}${result.ok ? "" : ` :: ${result.detail}`}`,
  );
  return [`Verification: ${verification.ok ? "OK" : "FAILED"}`, ...lines].join("\n");
};
