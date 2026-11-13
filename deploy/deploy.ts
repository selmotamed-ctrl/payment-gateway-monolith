#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { backupS3Configured, clamdManaged, effectiveDatabase, loadDeployConfig, objectStorageConfigured, pgAppRoleEnabled, resolveBackupS3Mode, withIpv6Loopback, parseNodeList, pgStorageConfigured, type DeployConfig, type DeployRole, sandboxDatabase } from "./lib/configSchema";
import { findSshConflicts, planHosts, renderTopology, type DeployPlan, type HostPlan, type ServicePlan } from "./lib/hostPlanner";
import { buildPki, certFilesForHost, checkPkiExpiry, pkiRenewalReport, readMaterial, verifyPki, WAL_ARCHIVE_CLIENT } from "./lib/pkiManager";
import {
  CERTBOT_DEPLOY_HOOK_PATH,
  CERTBOT_SERVICE_PATH,
  CERTBOT_TIMER_PATH,
  certbotDeployHook,
  certbotRenewalEnableScript,
  certbotRenewalService,
  certbotRenewalTimer,
} from "./lib/certRenewal";
import { collectSecretValues, effectiveTargetHome, effectiveTargetUser, SshRunner, shellQuote } from "./lib/sshRunner";
import { deploymentUnits, isFullDeployment, normalizeOnlyRole, shouldRun, shouldRunStorage, type OnlyRole } from "./lib/selection";
import { buildPreflightPlan, renderPreflightReport, runPreflight } from "./lib/preflight";
import { dollarTag, pgpassField, sqlIdent, sqlLiteral } from "./lib/quoting";
import { applyFirewall, readFirewallStatus } from "./lib/firewallConfigurator";
import { probeCoreService, probeEdgeService, renderVerification, verifyDeployment } from "./lib/healthVerifier";
import { bootstrapPackagesCommand, detectHostOs } from "./lib/osDetector";
import { bootstrapGaps, hostProbeScript } from "./lib/hostProbe";
import { parseApplyOutcome } from "./lib/converge";
import { startFrontendBuilds, type FrontendBuildHandle } from "./lib/frontendBuild";
import { provisionPostgres18 } from "./provisioners/postgres18Provisioner";
import { provisionRedis } from "./provisioners/redisProvisioner";
import { provisionClamav } from "./provisioners/clamavProvisioner";
import { provisionAuditAndLogDb } from "./provisioners/auditAndLogDbProvisioner";
import { backupDaemonUser, provisionBackupEngine, STORAGE_CERT_DIR } from "./provisioners/backupEngineProvisioner";
import {
  OBJECT_STORAGE_INSTALL_DIR,
  OBJECT_STORAGE_SERVICE_USER,
  provisionObjectStorageEngine,
} from "./provisioners/objectStorageProvisioner";
import { cleanFreshStorage, probeFreshStorage } from "./lib/freshStorage";

/**
 * The multi-host deployment orchestrator.
 *
 *   bun run deploy/deploy.ts --env=deploy/deploy.env
 *   bun run deploy/deploy.ts --only=checkout --update
 *   bun run deploy/deploy.ts --fresh --enforce-firewall
 *   bun run deploy/deploy.ts --dry-run
 *
 * It is strictly ordered: the database and the core come up first, then the
 * edge tiers, and the whole run is verified end to end before it is declared
 * successful.
 */

const REPO_ROOT = resolve(import.meta.dirname, "..");

interface CliOptions {
  envPath: string;
  only: Set<OnlyRole>;
  dryRun: boolean;
  fresh: boolean;
  /** Explicit opt-in to run a fresh deploy (migrations from scratch) against a non-empty database. */
  forceFresh: boolean;
  update: boolean;
  enforceFirewall: boolean;
  skipBuild: boolean;
  skipVerify: boolean;
  rotateCerts: boolean;
  /** Print the certificate expiry table and exit non-zero when anything expires within MTLS_RENEW_WITHIN_DAYS (AUTO-28). */
  checkCerts: boolean;
  /** Restart PostgreSQL/PgBouncer/Redis/the backup daemon even when nothing changed. */
  forceRestart: boolean;
  /** Ignore the frontend build cache and rebuild every SPA. */
  rebuild: boolean;
  /** Run only the read-only preflight and exit. */
  preflightOnly: boolean;
  /** Skip the preflight gate (emergency use). */
  skipPreflight: boolean;
  /** Allow the preflight to stop safe same-repo dev listeners. */
  stopUnmanaged: boolean;
  keepReleases?: number;
  rollingBatch?: number;
  nodes?: Set<string>;
}

/** Splits an ordered node list into rolling batches without reordering it. */
export const rollingBatches = <T>(nodes: readonly T[], batchSize: number): T[][] => {
  if (nodes.length === 0) return [];
  const size = Number.isFinite(batchSize) && batchSize >= 1 ? Math.floor(batchSize) : 1;
  const batches: T[][] = [];
  for (let index = 0; index < nodes.length; index += size) {
    batches.push(nodes.slice(index, index + size));
  }
  return batches;
};

const parseArgs = (argv: string[]): CliOptions => {
  const options: CliOptions = {
    envPath: join(REPO_ROOT, "deploy", "deploy.env"),
    only: new Set(),
    dryRun: false,
    fresh: false,
    forceFresh: process.env.DEPLOY_FORCE_FRESH === "1",
    update: false,
    enforceFirewall: false,
    skipBuild: false,
    skipVerify: false,
    rotateCerts: false,
    checkCerts: false,
    forceRestart: false,
    rebuild: false,
    preflightOnly: false,
    skipPreflight: false,
    stopUnmanaged: false,
  };
  for (const raw of argv) {
    if (raw === "--dry-run") options.dryRun = true;
    else if (raw === "--fresh") options.fresh = true;
    else if (raw === "--force-fresh") { options.fresh = true; options.forceFresh = true; }
    else if (raw === "--update") options.update = true;
    else if (raw === "--enforce-firewall") options.enforceFirewall = true;
    else if (raw === "--skip-build") options.skipBuild = true;
    else if (raw === "--skip-verify") options.skipVerify = true;
    else if (raw === "--rotate-certs") options.rotateCerts = true;
    else if (raw === "--check-certs") options.checkCerts = true;
    else if (raw === "--force-restart") options.forceRestart = true;
    else if (raw === "--rebuild") options.rebuild = true;
    else if (raw === "--preflight-only") options.preflightOnly = true;
    else if (raw === "--skip-preflight") options.skipPreflight = true;
    else if (raw === "--stop-unmanaged") options.stopUnmanaged = true;
    else if (raw.startsWith("--env=")) options.envPath = resolve(REPO_ROOT, raw.slice(6));
    else if (raw.startsWith("--only=")) {
      for (const role of raw.slice(7).split(",")) {
        options.only.add(normalizeOnlyRole(role));
      }
    } else if (raw.startsWith("--keep=")) options.keepReleases = Number(raw.slice(7));
    else if (raw.startsWith("--rolling-batch=")) {
      const value = Number(raw.slice(16));
      if (!Number.isInteger(value) || value < 1) throw new Error(`Invalid --rolling-batch '${raw.slice(16)}'`);
      options.rollingBatch = value;
    } else if (raw.startsWith("--nodes=")) {
      const ids = raw.slice(8).split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
      options.nodes = new Set(ids);
    } else if (raw.startsWith("--")) throw new Error(`Unknown option '${raw}'`);
  }
  return options;
};

const log = (message = ""): void => console.log(message);

/** Short commit used in health payloads and the final audit summary. */
const deployCommit = (): string => {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
};
const stepTimes: Array<{ index: number; title: string; startedAt: number }> = [];
const step = (index: number, title: string): void => {
  stepTimes.push({ index, title, startedAt: Date.now() });
  log();
  log(`\u001b[1m[${index}/14] ${title}\u001b[0m`);
};

/** Wall-clock per step, so a slow phase is visible without reading the whole log. */
export const renderStepTimings = (steps: ReadonlyArray<{ index: number; title: string; startedAt: number }>, endedAt: number): string =>
  steps
    .map((entry, position) => {
      const next = steps[position + 1]?.startedAt ?? endedAt;
      return `  ${String(entry.index).padStart(2)}  ${((next - entry.startedAt) / 1000).toFixed(1).padStart(7)}s  ${entry.title}`;
    })
    .join("\n");

let activeRunner: SshRunner | undefined;
let activeBuilds: FrontendBuildHandle | undefined;
const warn = (message: string): void => console.warn(`  ! ${message}`);

const timestamp = (): string => new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);


const isStorageRole = (role: string): boolean =>
  ["pg-primary", "pg-replica", "pgbouncer", "redis", "audit-db", "log-db", "backup", "object-storage"].includes(role);

export const uploadStorageCertificates = (
  runner: SshRunner,
  plan: DeployPlan,
  pki: ReturnType<typeof buildPki>,
  config: DeployConfig,
  dryRun: boolean,
): void => {
  const coreCertDir = `${config.CORE_REMOTE_DIR}/shared/certs`;
  for (const host of plan.hosts.filter((candidate) => candidate.roles.some(isStorageRole))) {
    const materials = certFilesForHost(pki, host.roles);
    const has = (role: string) => (host.roles as readonly string[]).includes(role);

    // Certificate placement is per consumer, never by "the first role on the
    // host". A co-located storage/core/backup host must not let the storage
    // service read core or edge private keys (and vice versa).
    const directoriesFor = (material: { name: string; kind: string }): string[] => {
      const dirs = new Set<string>();
      if (material.kind === "ca") {
        if (has("object-storage")) dirs.add(config.OBJECT_STORAGE_DAEMON_CERT_DIR);
        if (has("backup")) dirs.add(config.BACKUP_DAEMON_CERT_DIR);
        if (has("pg-primary") || has("pg-replica") || has("audit-db")) dirs.add(STORAGE_CERT_DIR);
      }
      if (material.name === "object-storage-daemon" && has("object-storage")) {
        dirs.add(config.OBJECT_STORAGE_DAEMON_CERT_DIR);
      }
      if (material.name === "object-storage-client") {
        if (has("core")) dirs.add(coreCertDir);
        if (has("backup")) dirs.add(config.BACKUP_DAEMON_CERT_DIR);
        // An object-storage-only host has no consumer for the client leaf; the
        // CA + server leaf are sufficient. Keep it only when it is the sole role
        // for compatibility with the standalone daemon checks.
        if (has("object-storage") && !has("core") && !has("backup")) {
          dirs.add(config.OBJECT_STORAGE_DAEMON_CERT_DIR);
        }
      }
      if ((material.name === "backup-daemon" || material.name === "backup-client") && has("backup")) {
        dirs.add(config.BACKUP_DAEMON_CERT_DIR);
      }
      if (material.name === "pg-client") {
        if (has("backup")) dirs.add(config.BACKUP_DAEMON_CERT_DIR);
        if (has("pg-primary") || has("pg-replica") || has("pgbouncer") || has("audit-db")) dirs.add(STORAGE_CERT_DIR);
      }
      if (material.name === WAL_ARCHIVE_CLIENT) dirs.add(STORAGE_CERT_DIR);
      return [...dirs];
    };

    const written = new Set<string>();
    for (const material of materials) {
      const content = dryRun ? null : readMaterial(material);
      for (const target of directoriesFor(material)) {
        if (written.has(`${target}/${material.name}`)) continue;
        written.add(`${target}/${material.name}`);
        if (dryRun) {
          runner.writeRemoteFile({ target: host.ssh, path: `${target}/${material.name}.crt`, content: "", mode: 0o644, sudo: true });
          continue;
        }
        runner.writeRemoteFile({ target: host.ssh, path: `${target}/${material.name}.crt`, content: content!.cert, mode: 0o644, sudo: true });
        if (content!.key) {
          runner.writeRemoteFile({ target: host.ssh, path: `${target}/${material.name}.key`, content: content!.key, mode: 0o600, sudo: true });
        }
      }
    }
    if (materials.some((material) => material.name === WAL_ARCHIVE_CLIENT) && !dryRun) {
      // archive_command runs as the postgres OS user: it must read the WAL
      // client key, and nothing else in this directory is made group-readable.
      const dir = shellQuote(STORAGE_CERT_DIR);
      runner.run(
        host.ssh,
        `getent group postgres >/dev/null 2>&1 && { chgrp postgres ${dir} ${shellQuote(`${STORAGE_CERT_DIR}/${WAL_ARCHIVE_CLIENT}.key`)} && chmod 0750 ${dir} && chmod 0640 ${shellQuote(`${STORAGE_CERT_DIR}/${WAL_ARCHIVE_CLIENT}.key`)}; } || true`,
        { sudo: true },
      );
    }
    if (has("backup") && !dryRun) {
      // The daemon (pgbackup, or postgres when co-located in wal-g mode) must own its mTLS material.
      const owner = shellQuote(`${backupDaemonUser(config)}:${backupDaemonUser(config)}`);
      const dir = shellQuote(config.BACKUP_DAEMON_CERT_DIR);
      runner.run(
        host.ssh,
        `chown ${owner} ${dir} 2>/dev/null && chmod 0750 ${dir} 2>/dev/null && { chown ${owner} ${dir}/*.crt ${dir}/*.key 2>/dev/null; chmod 0640 ${dir}/*.crt 2>/dev/null; chmod 0600 ${dir}/*.key 2>/dev/null; true; } || true`,
        { sudo: true },
      );
    }
    if (has("object-storage") && !dryRun) {
      // The user is created in step 5, after this step on a fresh host. Keep the
      // directory root-owned here; the provisioner hands the dedicated cert
      // files to pgobjstore after the account exists.
      const dir = shellQuote(config.OBJECT_STORAGE_DAEMON_CERT_DIR);
      runner.run(host.ssh, `install -d -m 0750 -o root -g root ${dir}`, { sudo: true });
    }
  }
};

const absoluteEnv = (env: Record<string, string>, remoteDir: string): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    result[key] = value.replace(/shared\/certs\//g, `${remoteDir}/shared/certs/`);
  }
  return result;
};

const renderEnvFile = (env: Record<string, string>): string =>
  `${Object.entries(env).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join("\n")}\n`;

const pm2Ecosystem = (service: ServicePlan, releaseDir: string): string => {
  const appDir = `${releaseDir}/${service.sourceDir}`;
  return `module.exports = {
  apps: [
    {
      name: ${JSON.stringify(service.name)},
      script: "pm2-compatible-start.js",
      interpreter: "/usr/local/bin/bun",
      cwd: ${JSON.stringify(appDir)},
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      kill_timeout: 15000,
      env: { NODE_ENV: "production" },
    },
  ],
};
`;
};

const FRONTENDS: Record<"admin" | "merchant" | "checkout" | "fake-rails", string> = {
  admin: "admin-front",
  merchant: "merchant-front",
  checkout: "checkout-front",
  "fake-rails": "fake-rails-front",
};

const nginxTemplatePath = (template: string): string => join(REPO_ROOT, "deploy", "templates", template);

const certbotRenewalHosts = new Set<string>();

/**
 * AUTO-28: schedules certbot renewal (twice a day) and an Nginx reload after a renewal, once per host per run. Both
 * files are rewritten only when they changed; a host without certbot or systemd only gets a warning.
 */
const ensureCertbotRenewal = (runner: SshRunner, host: HostPlan): void => {
  if (certbotRenewalHosts.has(host.ssh.host)) return;
  certbotRenewalHosts.add(host.ssh.host);
  runner.writeRemoteFile({ target: host.ssh, path: CERTBOT_DEPLOY_HOOK_PATH, content: certbotDeployHook(), mode: 0o755, sudo: true });
  runner.writeRemoteFile({ target: host.ssh, path: CERTBOT_SERVICE_PATH, content: certbotRenewalService(), mode: 0o644, sudo: true });
  runner.writeRemoteFile({ target: host.ssh, path: CERTBOT_TIMER_PATH, content: certbotRenewalTimer(), mode: 0o644, sudo: true });
  runner.run(host.ssh, certbotRenewalEnableScript(), { sudo: true });
};

/**
 * Resolves the TLS certificate of a public vhost.
 *
 * `certbot` expects the operator (or a cron) to have issued the certificate;
 * the deploy verifies it exists and, if it does not, prints the exact command.
 * `self_signed` issues a local certificate bound to the domain.
 */
const resolvePublicCertificate = (
  runner: SshRunner,
  host: HostPlan,
  domain: string,
  mode: "certbot" | "custom" | "self_signed",
  certPath: string,
  keyPath: string,
): { certPath: string; keyPath: string } => {
  if (mode === "self_signed") {
    const localCert = `/etc/ssl/pg/${domain}.crt`;
    const localKey = `/etc/ssl/pg/${domain}.key`;
    const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(domain);
    const san = isIp ? `IP:${domain}` : `DNS:${domain}`;
    runner.run(host.ssh, `mkdir -p /etc/ssl/pg && openssl req -x509 -newkey rsa:2048 -nodes -keyout ${shellQuote(localKey)} -out ${shellQuote(localCert)} -days 365 -subj ${shellQuote(`/CN=${domain}`)} -addext ${shellQuote(`subjectAltName=${san}`)}`, { sudo: true });
    return { certPath: localCert, keyPath: localKey };
  }
  if (mode === "certbot") {
    runner.run(
      host.ssh,
      `test -f ${certPath} || echo "!! missing certificate ${certPath}; run: certbot --nginx -d ${domain} --agree-tos -m ops@${domain}"`,
      { sudo: true },
    );
    ensureCertbotRenewal(runner, host);
  }
  return { certPath, keyPath };
};

/**
 * Renders one Nginx template. Pure: the caller resolves the TLS paths (which
 * may involve the remote host) and hands them in.
 */
export const renderNginxTemplate = (input: {
  template: string;
  serverName: string;
  listenPort: number;
  httpPort: number;
  httpsPort: number;
  ssl: boolean;
  sslCertPath: string;
  sslKeyPath: string;
  staticRoot: string;
  backendPort: number;
  lanAllowedCidrs: string;
  upstreamName?: string;
  upstreamServers?: string[];
  /** CSP frame-ancestors sources; the Fake Rails widget is embedded by the portals. */
  frameAncestors?: string;
}): string => {
  const lanRules = withIpv6Loopback(input.lanAllowedCidrs).split(",")
    .map((cidr) => cidr.trim())
    .filter((cidr) => cidr.length > 0)
    .map((cidr) => `    allow ${cidr};`)
    .join("\n");
  // `{{#SSL}}…{{/SSL}}` renders when TLS is on, `{{^SSL}}…{{/SSL}}` when it is
  // off. Process these before the simple placeholders.
  const withConditionals = input.template
    .replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_match, name: string, body: string) =>
      name === "SSL" && input.ssl ? body : "",
    )
    .replace(/\{\{\^(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_match, name: string, body: string) =>
      name === "SSL" && !input.ssl ? body : "",
    );
  const upstreamBlock = input.upstreamName && input.upstreamServers && input.upstreamServers.length > 0
    ? `upstream ${input.upstreamName} {\n    least_conn;\n${input.upstreamServers.map((server) => `    server ${server} max_fails=2 fail_timeout=3s;`).join("\n")}\n}\n\n`
    : "";
  return upstreamBlock + withConditionals
    .replaceAll("{{LAN_ALLOW_RULES}}", `${lanRules}\n    deny all;`)
    .replaceAll("{{SERVER_NAME}}", input.serverName)
    .replaceAll("{{LISTEN_PORT}}", String(input.listenPort))
    .replaceAll("{{HTTP_PORT}}", String(input.httpPort))
    .replaceAll("{{HTTPS_PORT}}", String(input.httpsPort))
    .replaceAll("{{SSL_CERT_PATH}}", input.sslCertPath)
    .replaceAll("{{SSL_KEY_PATH}}", input.sslKeyPath)
    .replaceAll("{{STATIC_ROOT}}", input.staticRoot)
    .replaceAll("{{BACKEND_PORT}}", String(input.backendPort))
    .replaceAll("{{UPSTREAM_NAME}}", input.upstreamName ?? `127.0.0.1:${input.backendPort}`)
    .replaceAll("{{LAN_ALLOWED_CIDRS}}", withIpv6Loopback(input.lanAllowedCidrs))
    .replaceAll("{{FRAME_ANCESTORS}}", input.frameAncestors ?? "'self'");
};

const renderNginx = (host: HostPlan, config: DeployConfig, runner: SshRunner, role?: string): void => {
  for (const site of host.nginx.filter((candidate) => !role || candidate.role === role)) {
    const template = readFileSync(nginxTemplatePath(site.template), "utf8");
    // The admin vhost is LAN-only and usually has no operator certificate; it
    // still needs a TLS pair so `nginx -t` accepts the server block, so we mint
    // a self-signed certificate bound to its server name when none is given.
    const tls = !site.ssl
      ? { certPath: "", keyPath: "" }
      : site.role === "fake-rails" && site.certPath && site.keyPath
        ? { certPath: site.certPath, keyPath: site.keyPath }
      : site.sslMode === "lan" && site.certPath && site.keyPath
        ? { certPath: site.certPath, keyPath: site.keyPath }
        : site.sslMode === "lan"
          ? resolvePublicCertificate(runner, host, site.serverName, "self_signed", "", "")
          : resolvePublicCertificate(
              runner,
              host,
              site.serverName,
              site.sslMode,
              site.certPath ?? "",
              site.keyPath ?? "",
            );
    const rendered = renderNginxTemplate({
      template,
      serverName: site.serverName,
      listenPort: site.listenPort,
      httpPort: site.httpPort,
      httpsPort: site.httpsPort,
      ssl: site.ssl,
      sslCertPath: tls.certPath,
      sslKeyPath: tls.keyPath,
      staticRoot: site.staticRoot,
      backendPort: site.role === "admin"
        ? config.ADMIN_BACK_PORT
        : site.role === "merchant"
          ? config.MERCHANT_BACK_PORT
          : site.role === "fake-rails"
            ? config.FAKE_RAILS_BACK_PORT
            : config.CHECKOUT_BACK_PORT,
      lanAllowedCidrs: site.role === "fake-rails" ? config.FAKE_RAILS_ALLOWED_CIDRS : config.LAN_ALLOWED_CIDRS,
      upstreamName: site.upstreamName,
      upstreamServers: site.upstreamServers,
      ...(site.role === "fake-rails"
        ? {
            frameAncestors: [
              "'self'",
              publicOrigin(config.MERCHANT_DOMAIN, false, config.MERCHANT_HTTP_PORT, config.MERCHANT_HTTPS_PORT),
              publicOrigin(config.MERCHANT_DOMAIN, true, config.MERCHANT_HTTP_PORT, config.MERCHANT_HTTPS_PORT),
              publicOrigin(config.CHECKOUT_DOMAIN, false, config.CHECKOUT_HTTP_PORT, config.CHECKOUT_HTTPS_PORT),
              publicOrigin(config.CHECKOUT_DOMAIN, true, config.CHECKOUT_HTTP_PORT, config.CHECKOUT_HTTPS_PORT),
              "http://localhost:*",
              "http://127.0.0.1:*",
            ].join(" "),
          }
        : {}),
    });
    const available = `/etc/nginx/sites-available/pg-${site.site}.conf`;
    runner.writeRemoteFile({ target: host.ssh, path: available, content: rendered, mode: 0o644, sudo: true });
    runner.run(host.ssh, `ln -sfn ${shellQuote(available)} ${shellQuote(`/etc/nginx/sites-enabled/pg-${site.site}.conf`)} && rm -f /etc/nginx/sites-enabled/default`, { sudo: true });
    runner.run(host.ssh, "nginx -t", { sudo: true });
    runner.run(host.ssh, "systemctl reload nginx", { sudo: true });
    log(`  nginx ${site.site} -> ${site.serverName}:${site.listenPort} (${site.ssl ? "https" : "http"})`);
  }
};

/**
 * PM2 apps of this tier that follow the engine's naming (`<base>` or
 * `<base>-<anything>`) but are not in the current plan are leftovers from an
 * earlier topology (e.g. `pg-core-back-core-1` after moving to a single
 * `pg-core-back`). They keep the tier's ports bound and run stale
 * configuration, so the new instance dies with EADDRINUSE while health probes
 * hit the stale one. Returns the shell command that retires them.
 */
export const retireOrphanedPm2Apps = (service: { name: string; nodeId?: string }, plannedNames: string[]): string => {
  const base = service.nodeId && service.name.endsWith(`-${service.nodeId}`)
    ? service.name.slice(0, -(service.nodeId.length + 1))
    : service.name;
  const keep = [...new Set([service.name, ...plannedNames])];
  const script =
    'const t=await Bun.stdin.text();const i=t.indexOf("[");if(i<0)process.exit(0);' +
    `const base=${JSON.stringify(base)};const keep=new Set(${JSON.stringify(keep)});` +
    'for(const p of JSON.parse(t.slice(i))){const n=p.name;if((n===base||n.startsWith(base+"-"))&&!keep.has(n))console.log(n)}';
  return [
    'PM2="$HOME/.bun/bin/pm2"',
    `for app in $("$PM2" jlist 2>/dev/null | "$HOME/.bun/bin/bun" -e '${script}'); do echo "retiring orphaned PM2 app $app (not in the current plan)"; "$PM2" delete "$app" >/dev/null 2>&1 || true; done`,
  ].join("; ");
};

const deployService = (input: {
  runner: SshRunner;
  host: HostPlan;
  service: ServicePlan;
  config: DeployConfig;
  pki: ReturnType<typeof buildPki>;
  releaseTimestamp: string;
  keepReleases: number;
  /** Every service name the plan has for this tier (all nodes, unfiltered). */
  plannedServiceNames?: string[];
  /** Set for core services; only the first core node actually migrates. */
  migration?: { fresh: boolean; forceFresh: boolean; firstCoreNode: boolean };
}): string => {
  const { runner, host, service, config, pki, releaseTimestamp } = input;
  const remote = service.remoteDir;
  const releaseRoot = service.nodeId ? `${remote}/releases/${service.nodeId}` : `${remote}/releases`;
  const releaseDir = `${releaseRoot}/${releaseTimestamp}`;
  const frontend = service.role === "core" || service.role === "db" ? null : FRONTENDS[service.role];
  const appDir = `${releaseDir}/${service.sourceDir}`;
  const targetUser = effectiveTargetUser(host.ssh);
  const owner = `${targetUser}:${targetUser}`;

  // The tree lives under /var/www, so creating it needs sudo; everything the
  // application reads afterwards (keys, .env, PM2 files, the release tree) is
  // owned by the SSH user so PM2 — never root — can read it.
  runner.run(host.ssh, "mkdir -p " + [releaseDir, `${remote}/shared/certs`, `${remote}/shared/backups`, `${remote}/shared/pm2`, `${remote}/shared/data`].map(shellQuote).join(" ") + ` && chown -R ${shellQuote(owner)} ${shellQuote(remote)}`, { sudo: true });

  // 1. The backend source.
  runner.sync({
    target: host.ssh,
    local: join(REPO_ROOT, service.sourceDir),
    remote: appDir,
    excludes: ["node_modules", ".git", "dist", "generated", "test", "certs", ".certs", "*.log", ".env"],
  });

  // 2. The frontend build (already compiled locally in step 2).
  if (frontend) {
    const dist = join(REPO_ROOT, frontend, "dist");
    if (!existsSync(dist) && !input.runner.dryRun) {
      throw new Error(`The ${frontend} build is missing (${dist}); run without --skip-build`);
    }
    // rsync creates only the final path component, so make the parent first.
    runner.run(host.ssh, `mkdir -p ${shellQuote(`${releaseDir}/${frontend}`)}`, { sudo: false });
    runner.sync({
      target: host.ssh,
      local: dist,
      remote: `${releaseDir}/${frontend}/dist`,
      excludes: [".pg-build-stamp"],
    });
    // Deployment-specific UI visibility is resolved when the release is
    // assembled, so it can be changed without rebuilding the SPA. The file is
    // loaded by index.html before the application module.
    const runtimeConfig = frontendRuntimeConfig(frontend, config);
    if (runtimeConfig) {
      runner.writeRemoteFile({
        target: host.ssh,
        path: `${releaseDir}/${frontend}/dist/runtime-config.js`,
        content: `window.__PG_RUNTIME_CONFIG__ = ${JSON.stringify(runtimeConfig)};\n`,
        mode: 0o644,
        sudo: false,
      });
      log(`  ${frontend} runtime config -> ${releaseDir}/${frontend}/dist/runtime-config.js`);
    }
  }

  // 3. The least-privilege certificates of this host.
  for (const material of certFilesForHost(pki, [service.role])) {
    if (runner.dryRun) {
      log(`[dry-run] upload ${material.name}.crt${material.kind === "ca" ? "" : ` + ${material.name}.key`} -> ${remote}/shared/certs/`);
      continue;
    }
    const content = readMaterial(material);
    runner.writeRemoteFile({ target: host.ssh, path: `${remote}/shared/certs/${material.name}.crt`, content: content.cert, mode: 0o644, sudo: false });
    if (content.key) {
      runner.writeRemoteFile({ target: host.ssh, path: `${remote}/shared/certs/${material.name}.key`, content: content.key, mode: 0o600, sudo: false });
    }
  }

  // 4. The environment. It lives in `shared/` and is symlinked into the release
  //    so a release always reads the current configuration.
  const env = absoluteEnv(
    { ...service.env, APP_RELEASE: releaseTimestamp, APP_COMMIT: deployCommit() },
    remote,
  );
  const envPath = `${remote}/shared/${service.envFileName ?? ".env"}`;
  runner.writeRemoteFile({ target: host.ssh, path: envPath, content: renderEnvFile(env), mode: 0o600, sudo: false });
  runner.run(host.ssh, `ln -sfn ${shellQuote(envPath)} ${shellQuote(`${appDir}/.env`)}`, { sudo: false });

  // 5. Dependencies and, for the core, the schema.
  const bun = 'PATH="$HOME/.bun/bin:/usr/local/bin:$PATH" bun';
  runner.run(host.ssh, `${bun} install --frozen-lockfile`, { cwd: appDir, sudo: false });
  if (service.role === "core") {
    runner.run(host.ssh, `${bun}x prisma generate`, { cwd: appDir, sudo: false });
    const isSandboxCore = service.name === "pg-core-sandbox";
    if (isSandboxCore) {
      const sandboxOwnerUrl = sandboxDatabase(config).ownerUrl;
      if (!sandboxOwnerUrl) throw new Error("The Sandbox database endpoint is not configured (SANDBOX_ENABLED requires a managed database)");
      runAsDatabaseOwner(runner, host, appDir, config, (flag) => () =>
        runner.run(host.ssh, `${bun} ${flag} run migrate-deploy`.replace("  ", " "), { cwd: appDir, sudo: false }), sandboxOwnerUrl);
      if (config.RUN_PRISMA_SEED) {
        runAsDatabaseOwner(runner, host, appDir, config, (flag) => () =>
          runner.run(host.ssh, `${bun} ${flag} run db-seed`.replace("  ", " "), { cwd: appDir, sudo: false }), sandboxOwnerUrl);
      }
      if (config.SEED_FAKE_RAILS_BLUEPRINTS) {
        runAsDatabaseOwner(runner, host, appDir, config, (flag) => () =>
          runner.run(host.ssh, `${bun} ${flag} run seed-fake-rails`.replace("  ", " "), { cwd: appDir, sudo: false, timeoutMs: 30 * 60_000 }), sandboxOwnerUrl);
      }
    } else if (input.migration?.firstCoreNode) {
      const state = probeMigrationState({ runner, config, host, appDir, releaseTimestamp });
      const migrationPlan = planMigrations({
        fresh: input.migration.fresh,
        firstCoreNode: true,
        databaseNonEmpty: state.databaseNonEmpty,
        pendingMigrations: state.pendingMigrations,
        forceFresh: input.migration.forceFresh,
        dryRun: runner.dryRun,
      });
      if (migrationPlan.refuse) throw new Error(migrationPlan.refuse);
      if (migrationPlan.dumpBeforeMigrate) {
        backupDatabase({ runner, config, host, releaseTimestamp });
      }
      if (migrationPlan.runMigrate) {
        runAsDatabaseOwner(runner, host, appDir, config, (flag) => () =>
          runner.run(host.ssh, `${bun} ${flag} run migrate-deploy`.replace("  ", " "), { cwd: appDir, sudo: false }));
      } else {
        log("  no pending migrations");
      }
    }
    if (!isSandboxCore && config.RUN_PRISMA_SEED) {
      const seedStarted = Date.now();
      runAsDatabaseOwner(runner, host, appDir, config, (flag) => () =>
        runner.run(host.ssh, `${bun} ${flag} run db-seed`.replace("  ", " "), { cwd: appDir, sudo: false }));
      const seedMs = Date.now() - seedStarted;
      if (!input.migration?.fresh && seedMs >= 3000) {
        log(`  hint: db-seed took ${(seedMs / 1000).toFixed(1)}s on every deploy; it is first-deploy reference data, so set RUN_PRISMA_SEED=false once it has run`);
      }
    }
  }

  // 6. Atomic symlink switch. Multi-node hosts use a per-node link so two
  //    instances of the same tier never overwrite each other.
  const currentLink = service.currentLink ?? `${remote}/current`;
  runner.run(host.ssh, `ln -sfn ${shellQuote(releaseDir)} ${shellQuote(currentLink)}`, { sudo: false });

  // 7. PM2.
  const ecosystem = `${remote}/shared/pm2/${service.name}.config.cjs`;
  runner.writeRemoteFile({ target: host.ssh, path: ecosystem, content: pm2Ecosystem(service, releaseDir), mode: 0o644, sudo: false });
  runner.run(host.ssh, retireOrphanedPm2Apps(service, input.plannedServiceNames ?? []), { sudo: false });
  runner.run(
    host.ssh,
    `"$HOME/.bun/bin/pm2" delete ${shellQuote(service.name)} >/dev/null 2>&1 || true; "$HOME/.bun/bin/pm2" start ${shellQuote(ecosystem)} --update-env && "$HOME/.bun/bin/pm2" save`,
    { sudo: false },
  );

  // 8. Nginx (only the site owned by the service being deployed).
  renderNginx(host, config, runner, service.role);

  // 9. Prune.
  runner.run(
    host.ssh,
    `ls -1dt -- ${shellQuote(releaseRoot)}/*/ 2>/dev/null | tail -n +${input.keepReleases + 1} | xargs -r -d '\\n' rm -rf --`,
    { sudo: false },
  );

  log(`  ${service.name} -> ${releaseDir}`);
  return releaseDir;
};

/**
 * Waits (up to ~10 s) for the daemon unit to be active and to stay active for a
 * moment (Restart=always would otherwise hide a crash loop behind a brief
 * "active"); on failure prints the unit's journal to stderr and exits 1.
 */
export const daemonReadinessWait = (unit = "pg-backup-daemon"): string =>
  `ok=0; for i in $(seq 1 10); do if systemctl is-active --quiet ${unit}; then sleep 1; if systemctl is-active --quiet ${unit}; then ok=1; break; fi; fi; sleep 1; done
if [ "$ok" != 1 ]; then echo "${unit} did not become active within 10s" >&2; journalctl -u ${unit} -n 40 --no-pager >&2; exit 1; fi`;

/**
 * Copies the daemon source to BACKUP_NODE and brings its systemd unit up.
 * The daemon is restarted only when something it runs on changed (its source,
 * environment or unit) or it is down: a blind restart can interrupt a backup
 * or restore drill in progress.
 */
export const deployBackupDaemon = (input: {
  runner: SshRunner;
  config: DeployConfig;
  host: HostPlan;
  /** The provisioner rewrote the daemon's env/unit/archive environment. */
  configChanged?: boolean;
  forceRestart?: boolean;
}): void => {
  const { runner, config, host } = input;
  const installDir = "/opt/pg-backup-daemon";
  const sourceDir = join(REPO_ROOT, "deploy", "backup-daemon");
  const targetUser = effectiveTargetUser(host.ssh);
  // The daemon account: pgbackup, or postgres only for a co-located wal-g backup.
  const daemonUser = backupDaemonUser(config);
  const daemonOwner = `${daemonUser}:${daemonUser}`;
  const bunCacheDir = "/var/lib/pg-backup/.bun-cache";
  // Hand the source tree (never node_modules, which the daemon user owns and which can
  // hold thousands of files) to the deploy user for rsync, and back afterwards.
  const chownSource = (owner: string): string =>
    `find ${shellQuote(installDir)} -path ${shellQuote(`${installDir}/node_modules`)} -prune -o -exec chown ${shellQuote(owner)} {} +`;
  runner.run(
    host.ssh,
    `install -d -m 0755 -o ${shellQuote(targetUser)} -g ${shellQuote(targetUser)} ${shellQuote(installDir)} && ${chownSource(`${targetUser}:${targetUser}`)}`,
    { sudo: true },
  );
  const synced = runner.sync({
    target: host.ssh,
    local: sourceDir,
    remote: installDir,
    delete: true,
    excludes: ["node_modules", ".git", "dist", "test", "*.log", ".env"],
  });
  // Ownership and dependencies only need work when the source changed (or the
  // dependency tree is missing).
  runner.run(host.ssh, bunInstallCommand(config), { sudo: true });
  const nodeModules = shellQuote(`${installDir}/node_modules`);
  // The dependency tree is deliberately excluded from the recursive chown (a multi-GB node_modules is expensive),
  // but switching the daemon account (for example wal-g/postgres -> pg-native/pgbackup) would leave the old owner's
  // files in place and `bun install` fails with "Failed to link <pkg>: EEXIST". Detect a foreign-owned tree and
  // reinstall it as the current account instead; with the tree removed the install condition below always runs.
  const foreignNodeModules = `if [ -d ${nodeModules} ] && [ -n "$(find ${nodeModules} ! -user ${shellQuote(daemonUser)} -print -quit 2>/dev/null)" ]; then rm -rf ${nodeModules}; fi`;
  runner.run(
    host.ssh,
    `${chownSource(daemonOwner)}; install -d -m 0755 -o ${shellQuote(daemonUser)} -g ${shellQuote(daemonUser)} ${shellQuote(bunCacheDir)}; ${foreignNodeModules}; if [ ${synced.changed ? 1 : 0} = 1 ] || [ ! -d ${nodeModules} ]; then install -d -o ${shellQuote(daemonUser)} -g ${shellQuote(daemonUser)} ${nodeModules} && cd ${shellQuote(installDir)} && runuser -u ${shellQuote(daemonUser)} -- env HOME=/var/lib/pg-backup BUN_INSTALL_CACHE_DIR=${shellQuote(bunCacheDir)} /usr/local/bin/bun install --frozen-lockfile; fi`,
    { sudo: true },
  );
  // A previous run can leave the unit file/env updated on disk while the old
  // process keeps running (for example a deploy that failed after rsync but
  // before the restart, or an engine switch from wal-g/postgres to
  // pg-native/pgbackup). File-content convergence alone would see "unchanged"
  // and skip the restart, so also compare the running process account and
  // systemd's reload state.
  const runningUser = runner.capture(
    host.ssh,
    `pid=$(systemctl show -p MainPID --value pg-backup-daemon 2>/dev/null); if [ -n "$pid" ] && [ "$pid" != 0 ]; then ps -o user= -p "$pid" 2>/dev/null | tr -d ' '; fi`,
  ).trim();
  const unitDirty = runner.capture(
    host.ssh,
    `systemctl show -p NeedDaemonReload --value pg-backup-daemon 2>/dev/null || true`,
  ).trim() === "yes";
  const restart = input.forceRestart === true
    || synced.changed
    || input.configChanged !== false
    || unitDirty
    || (runningUser !== "" && runningUser !== daemonUser);
  const outcome = parseApplyOutcome(runner.capture(
    host.ssh,
    `systemctl daemon-reload && systemctl enable pg-backup-daemon >/dev/null 2>&1
if ! systemctl is-active --quiet pg-backup-daemon; then systemctl start pg-backup-daemon; echo __PG_APPLY__=started
elif [ ${restart ? 1 : 0} = 1 ]; then systemctl restart pg-backup-daemon; echo __PG_APPLY__=restarted
else echo __PG_APPLY__=unchanged; fi
${daemonReadinessWait()}`,
    { sudo: true },
  ));
  log(`  backup daemon ${outcome === "unknown" ? "applied" : outcome} -> ${host.ssh.host}:${installDir} (BACKUP_DAEMON_PORT=${config.BACKUP_DAEMON_PORT})`);
};

/**
 * Copies the shared object-storage daemon source to OBJECT_STORAGE_NODE and
 * brings its systemd unit up. The daemon has no runtime dependencies, so the
 * deploy does not run a package install on the storage host. It is restarted
 * only when its source, environment or unit changed (or on --force-restart).
 */
export const deployObjectStorageDaemon = (input: {
  runner: SshRunner;
  config: DeployConfig;
  host: HostPlan;
  configChanged?: boolean;
  forceRestart?: boolean;
}): void => {
  const { runner, config, host } = input;
  const installDir = OBJECT_STORAGE_INSTALL_DIR;
  const sourceDir = join(REPO_ROOT, "deploy", "object-storage-daemon");
  const targetUser = effectiveTargetUser(host.ssh);
  const daemonUser = OBJECT_STORAGE_SERVICE_USER;
  const daemonOwner = `${daemonUser}:${daemonUser}`;
  const chownSource = (owner: string): string =>
    `find ${shellQuote(installDir)} -path ${shellQuote(`${installDir}/node_modules`)} -prune -o -exec chown ${shellQuote(owner)} {} +`;
  // The daemon unit runs the pinned /usr/local/bin/bun. A fresh storage host
  // has no bun unless this step installs it, including the documented
  // --update --only=object-storage path.
  runner.run(host.ssh, bunInstallCommand(config), { sudo: true });
  runner.run(
    host.ssh,
    `install -d -m 0755 -o ${shellQuote(targetUser)} -g ${shellQuote(targetUser)} ${shellQuote(installDir)} && ${chownSource(`${targetUser}:${targetUser}`)}`,
    { sudo: true },
  );
  const synced = runner.sync({
    target: host.ssh,
    local: sourceDir,
    remote: installDir,
    delete: true,
    excludes: ["node_modules", ".git", "dist", "test", "*.log", ".env", "bun.lock"],
  });
  runner.run(host.ssh, `${chownSource(daemonOwner)}`, { sudo: true });
  const restart = input.forceRestart === true || synced.changed || input.configChanged !== false;
  const outcome = parseApplyOutcome(
    runner.capture(
      host.ssh,
      `systemctl daemon-reload && systemctl enable pg-object-storage-daemon >/dev/null 2>&1
if ! systemctl is-active --quiet pg-object-storage-daemon; then systemctl start pg-object-storage-daemon; echo __PG_APPLY__=started
elif [ ${restart ? 1 : 0} = 1 ]; then systemctl restart pg-object-storage-daemon; echo __PG_APPLY__=restarted
else echo __PG_APPLY__=unchanged; fi
${daemonReadinessWait("pg-object-storage-daemon")}`,
      { sudo: true },
    ),
  );
  log(`  object-storage daemon ${outcome === "unknown" ? "applied" : outcome} -> ${host.ssh.host}:${installDir}`);
};

/**
 * Installs Bun system-wide without `curl | bash`: a pinned release is
 * downloaded and verified against BUN_SHA256. Without BUN_SHA256 an already
 * installed bun is reused, otherwise the command fails closed.
 */
export const bunInstallCommand = (config: Pick<DeployConfig, "BUN_VERSION" | "BUN_SHA256">): string => {
  const sha = config.BUN_SHA256.trim().toLowerCase();
  const link = 'ln -sfn bun /usr/local/bin/bunx';
  const missing = `echo ${shellQuote(`bun is not installed and BUN_SHA256 is not set: install bun ${config.BUN_VERSION} manually or set BUN_SHA256 (SHA-256 of bun-linux-x64.zip) in deploy.env`)} >&2; exit 1`;
  const download = sha
    ? `d=$(mktemp -d) && trap 'rm -rf "$d"' EXIT && curl -fsSL ${shellQuote(`https://github.com/oven-sh/bun/releases/download/bun-v${config.BUN_VERSION}/bun-linux-x64.zip`)} -o "$d/bun.zip" && echo ${shellQuote(`${sha}  `)}"$d/bun.zip" | sha256sum -c - && unzip -q -o "$d/bun.zip" -d "$d" && install -m 0755 "$d/bun-linux-x64/bun" /usr/local/bin/bun`
    : missing;
  // The daemon runs as an unprivileged service user, which cannot traverse the deploy user's home directory (0750),
  // so /usr/local/bin/bun must be a REAL file, never a symlink into a home directory. An existing symlink (from an
  // earlier deploy or a per-user install) is converted. Copies go through a temp file + mv so a running daemon's
  // binary is replaced atomically instead of failing with "text file busy".
  const realCopy = (source: string): string => `install -m 0755 ${source} /usr/local/bin/bun.new && mv -f /usr/local/bin/bun.new /usr/local/bin/bun`;
  return `if [ -L /usr/local/bin/bun ]; then t=$(readlink -f /usr/local/bin/bun); if [ -x "$t" ]; then ${realCopy('"$t"')}; else rm -f /usr/local/bin/bun; fi; fi; if [ ! -x /usr/local/bin/bun ]; then if command -v bun >/dev/null 2>&1; then ${realCopy('"$(readlink -f "$(command -v bun)")"')}; elif [ -x "$HOME/.bun/bin/bun" ]; then ${realCopy('"$HOME/.bun/bin/bun"')}; else ${download}; fi; fi; ${link}`;
};

const provisionDatabase = (input: {
  runner: SshRunner;
  config: DeployConfig;
  host: HostPlan;
}): void => {
  const { runner, config, host } = input;
  if (!config.DB_MANAGE_VIA_SSH) {
    log("  DB_MANAGE_VIA_SSH=false: the database is managed outside this deploy");
    return;
  }
  // The DDL runs ON the database host through its own sudo access. The
  // application credential is never used to create the database, and it never
  // leaves the core host. The SQL is streamed to a temporary file instead of
  // quoted on the command line.
  const roleBody = `IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = ${sqlLiteral(config.DB_USER ?? "", "DB_USER")}) THEN CREATE ROLE ${sqlIdent(config.DB_USER ?? "", "DB_USER")} LOGIN PASSWORD ${sqlLiteral(config.DB_PASSWORD ?? "", "DB_PASSWORD")}; END IF;`;
  const tag = dollarTag(roleBody);
  const createSql = [
    `DO ${tag} BEGIN ${roleBody} END ${tag};`,
    `SELECT ${sqlLiteral(`CREATE DATABASE ${sqlIdent(config.DB_NAME ?? "", "DB_NAME")} OWNER ${sqlIdent(config.DB_USER ?? "", "DB_USER")}`)} WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = ${sqlLiteral(config.DB_NAME ?? "", "DB_NAME")})\\gexec`,
  ].join("\n");

  // Secret-bearing SQL lives in a private postgres-owned 0700 dir, mode 0600,
  // and is always removed afterwards.
  const sqlDir = `/var/lib/postgresql/.pg-db-init-${timestamp()}`;
  const sqlPath = `${sqlDir}/init.sql`;
  runner.run(host.ssh, `install -d -m 0700 -o postgres -g postgres ${shellQuote(sqlDir)}`, { sudo: true });
  try {
    runner.writeRemoteFile({ target: host.ssh, path: sqlPath, content: `${createSql}\n`, mode: 0o600, sudo: true });
    runner.run(host.ssh, `chown postgres:postgres ${shellQuote(sqlPath)}`, { sudo: true });
    runner.run(host.ssh, `psql -f ${shellQuote(sqlPath)}`, { sudo: true, sudoUser: "postgres" });
  } finally {
    runner.run(host.ssh, `rm -rf ${shellQuote(sqlDir)}`, { sudo: true });
  }
  log(`  database ${config.DB_NAME} and user ${config.DB_USER} ready on ${config.DB_PRIVATE_IP ?? host.ssh.host}`);
};

/** The exact pre-migration backup command, against the primary direct port. */
export const preMigrationBackup = (
  config: DeployConfig,
  target: string,
): { command: string; host: string; port: number; database: string; user: string; pgpassPath: string; pgpassContent: string } => {
  const database = effectiveDatabase(config);
  const primary = parseNodeList(config.PG_PRIMARY_NODE)[0];
  const pgStorage = pgStorageConfigured(config);
  const host = pgStorage && primary ? primary.privateIp : (config.DB_PRIVATE_IP ?? config.DB_SSH_HOST ?? "");
  const port = pgStorage && primary ? primary.servicePort : config.DB_PORT;
  const name = pgStorage ? config.PG_DB_NAME : database.name;
  const user = pgStorage ? config.PG_DB_USER : database.user;
  const password = pgStorage ? config.PG_DB_PASSWORD : database.password;
  // The password never goes on a command line: it is streamed into a 0600
  // PGPASSFILE (see backupDatabase) and pg_dump reads it from there.
  const pgpassPath = `${target}.pgpass`;
  return {
    host,
    port,
    database: name,
    user,
    pgpassPath,
    pgpassContent: `${pgpassField(host)}:${port}:*:${pgpassField(user)}:${pgpassField(password)}\n`,
    command: `(umask 077; PGPASSFILE=${shellQuote(pgpassPath)} pg_dump --no-password -h ${shellQuote(host)} -p ${port} -U ${shellQuote(user)} -Fc -f ${shellQuote(`${target}.dump`)} ${shellQuote(name)})`,
  };
};

const OWNER_ENV_FILE = ".env.owner";

/**
 * Runs `build(flag)` with the database OWNER's credentials when the migration/seed connection differs from the
 * runtime one. That happens when the application has its own non-owner role (`PG_APP_PASSWORD`) and also in the
 * legacy single-role mode when PgBouncer is enabled: migrations must use the session-safe endpoint (pgw_session or
 * the explicit leader URL), while the runtime `DATABASE_URL` stays transaction-pooled. The owner's URL exists only
 * in a temporary `.env.owner` (mode 0600) that is created for the one command and removed afterwards, even on
 * failure, so a compromised service process cannot read it from its environment or from disk.
 * `flag` is `--env-file=.env.owner` (Bun layers it over `.env`) or empty when the runtime URL is already safe.
 */
export const runAsDatabaseOwner = <T>(
  runner: SshRunner,
  host: HostPlan,
  appDir: string,
  config: DeployConfig,
  build: (envFlag: string) => () => T,
  ownerUrlOverride?: string | null,
): T => {
  const database = effectiveDatabase(config);
  const ownerUrl = ownerUrlOverride ?? database.ownerUrl;
  if (!ownerUrl || ownerUrl === database.url) return build("")();
  const envPath = `${appDir}/${OWNER_ENV_FILE}`;
  // The owner URL is session-pooled (pgw_session) so Prisma's advisory lock survives. Migrations and seeders do not
  // start workers, so disable them here: the core loader otherwise rejects a session-pooled DATABASE_URL that has
  // the same endpoint as LEADER_ELECTION_DATABASE_URL (that check assumes DATABASE_URL is the transaction pool).
  runner.writeRemoteFile({ target: host.ssh, path: envPath, content: `DATABASE_URL="${ownerUrl}"\nWORKER_ENABLED="false"\n`, mode: 0o600, sudo: false });
  try {
    return build(`--env-file=${OWNER_ENV_FILE}`)();
  } finally {
    runner.run(host.ssh, `rm -f ${shellQuote(envPath)}`, { sudo: false });
  }
};

/** Installs the packages, Bun and PM2 a host needs (the `--fresh` bootstrap, for one host). */
const bootstrapHost = (runner: SshRunner, host: HostPlan, config: DeployConfig): void => {
  const os = detectHostOs(runner, host);
  log(`  ${host.ssh.host}: detected ${os} package manager`);
  const packages = bootstrapPackagesCommand(os);
  if (packages) {
    runner.run(host.ssh, packages, { sudo: true });
  } else {
    warn(`unknown OS on ${host.ssh.host}; install nginx/rsync/curl/nodejs manually`);
  }
  const targetUser = effectiveTargetUser(host.ssh);
  const targetHome = effectiveTargetHome(host.ssh);
  // PM2 is a Node program and its shebang is `node`; Bun lives on a stable
  // absolute path (/usr/local/bin/bun, pinned + checksum verified).
  runner.run(host.ssh, bunInstallCommand(config), { sudo: true });
  runner.run(host.ssh, 'test -x "$HOME/.bun/bin/pm2" || PATH="$HOME/.bun/bin:/usr/local/bin:$PATH" bun add -g pm2', { sudo: false });
  // Best effort: re-register the PM2 process list on boot.
  const pm2Path = `${targetHome}/.bun/bin:/usr/local/bin:/usr/bin:/bin`;
  runner.run(
    host.ssh,
    `env PATH=${pm2Path} pm2 startup systemd -u ${targetUser} --hp ${targetHome} >/dev/null 2>&1 || true`,
    { sudo: true },
  );
};

/** Result of probing the target database before a migration run. */
export interface MigrationPlanInput {
  fresh: boolean;
  /** Only the first core node ever runs migrations. */
  firstCoreNode: boolean;
  /** true/false when probed, undefined when unknown (dry run, probe failure). */
  databaseNonEmpty: boolean | undefined;
  /** true/false when probed, undefined when unknown. */
  pendingMigrations: boolean | undefined;
  forceFresh: boolean;
  /** A dry run never probes, so an unknown emptiness is expected there and must not refuse. */
  dryRun?: boolean;
}

export interface MigrationPlan {
  runMigrate: boolean;
  /** pg_dump taken BEFORE `prisma migrate deploy`. */
  dumpBeforeMigrate: boolean;
  /** Set when the deploy must stop. */
  refuse?: string;
}

/**
 * The single decision point for schema migrations (pure, unit-tested):
 *  - only the first core node migrates;
 *  - `--fresh` against a non-empty database is refused unless --force-fresh, and so is `--fresh`
 *    when the emptiness probe FAILED (unknown is not "empty": a missing psql client or a refused
 *    connection must not switch the safety check off);
 *  - update deploys run `migrate deploy` whenever migrations are (or may be) pending;
 *  - a dump is always taken first when the database is (or may be) non-empty.
 */
export const planMigrations = (input: MigrationPlanInput): MigrationPlan => {
  if (!input.firstCoreNode) return { runMigrate: false, dumpBeforeMigrate: false };
  const maybeNonEmpty = input.databaseNonEmpty !== false;
  if (input.fresh) {
    if (input.databaseNonEmpty === true && !input.forceFresh) {
      return {
        runMigrate: false,
        dumpBeforeMigrate: false,
        refuse: "--fresh refused: the target database is not empty. Re-run with --force-fresh (or DEPLOY_FORCE_FRESH=1) only if you intend to migrate over existing data; a pre-migration dump is taken first.",
      };
    }
    if (input.databaseNonEmpty === undefined && !input.forceFresh && !input.dryRun) {
      return {
        runMigrate: false,
        dumpBeforeMigrate: false,
        refuse: "--fresh refused: the emptiness probe of the target database failed (is the PostgreSQL client installed on the core host and the database reachable?), so it cannot be shown to be empty. Fix the probe, or re-run with --force-fresh (or DEPLOY_FORCE_FRESH=1) if you accept the risk; a pre-migration dump is taken first.",
      };
    }
    return { runMigrate: true, dumpBeforeMigrate: maybeNonEmpty };
  }
  const runMigrate = input.pendingMigrations !== false;
  return { runMigrate, dumpBeforeMigrate: runMigrate && maybeNonEmpty };
};

const backupDatabase = (input: { runner: SshRunner; config: DeployConfig; host: HostPlan; releaseTimestamp: string }): void => {
  const { runner, config, host, releaseTimestamp } = input;
  const backupDir = `${config.CORE_REMOTE_DIR}/shared/backups`;
  const target = `${backupDir}/pre-migrate-${releaseTimestamp}`;
  const { command, pgpassPath, pgpassContent } = preMigrationBackup(config, target);
  // The tree lives under /var/www and may not exist yet on an update deploy, so
  // the directory is created as root and handed to the effective target user (0700) before
  // the dump writes into it.
  const targetUser = effectiveTargetUser(host.ssh);
  runner.run(host.ssh, `mkdir -p ${shellQuote(backupDir)} && chown ${shellQuote(`${targetUser}:${targetUser}`)} ${shellQuote(backupDir)} && chmod 0700 ${shellQuote(backupDir)}`, { sudo: true });
  try {
    runner.writeRemoteFile({ target: host.ssh, path: pgpassPath, content: pgpassContent, mode: 0o600, sudo: false });
    runner.run(host.ssh, command, { sudo: false });
  } finally {
    runner.run(host.ssh, `rm -f ${shellQuote(pgpassPath)}`, { sudo: false });
  }
  // Keep only the newest dumps (they contain the whole database).
  runner.run(host.ssh, `ls -1t -- ${shellQuote(backupDir)}/pre-migrate-*.dump 2>/dev/null | tail -n +${Math.max(1, config.KEEP_RELEASES) + 1} | xargs -r rm -f --`, { sudo: false });
  log(`  pre-migration backup -> ${target}.dump`);
};

/** Probes whether the database has tables and whether `prisma migrate` has pending work. */
const probeMigrationState = (input: {
  runner: SshRunner;
  config: DeployConfig;
  host: HostPlan;
  appDir: string;
  releaseTimestamp: string;
}): { databaseNonEmpty: boolean | undefined; pendingMigrations: boolean | undefined } => {
  const { runner, config, host, appDir, releaseTimestamp } = input;
  if (runner.dryRun) return { databaseNonEmpty: undefined, pendingMigrations: undefined };
  const backupDir = `${config.CORE_REMOTE_DIR}/shared/backups`;
  const probe = preMigrationBackup(config, `${backupDir}/probe-${releaseTimestamp}`);
  let databaseNonEmpty: boolean | undefined;
  try {
    runner.writeRemoteFile({ target: host.ssh, path: probe.pgpassPath, content: probe.pgpassContent, mode: 0o600, sudo: false });
    const out = runner.capture(
      host.ssh,
      `PGPASSFILE=${shellQuote(probe.pgpassPath)} psql --no-password -h ${shellQuote(probe.host)} -p ${probe.port} -U ${shellQuote(probe.user)} -d ${shellQuote(probe.database)} -Atc ${shellQuote("SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'")}`,
      { sudo: false },
    );
    databaseNonEmpty = /^\d+$/.test(out) ? Number(out) > 0 : undefined;
  } catch {
    databaseNonEmpty = undefined;
  } finally {
    runner.run(host.ssh, `rm -f ${shellQuote(probe.pgpassPath)}`, { sudo: false });
  }
  let pendingMigrations: boolean | undefined;
  try {
    runner.run(host.ssh, 'PATH="$HOME/.bun/bin:/usr/local/bin:$PATH" bunx prisma migrate status', { cwd: appDir, sudo: false });
    pendingMigrations = false;
  } catch {
    // Non-zero: pending migrations, an unmanaged database, or an unreachable one.
    // `migrate deploy` then either applies them or fails loudly.
    pendingMigrations = true;
  }
  return { databaseNonEmpty, pendingMigrations };
};

/**
 * Build-time constants injected into each SPA. The deploy engine is the single
 * source of truth for deployment-specific UI visibility, so Vite never reads a
 * committed `.env` default for these values.
 */
export const adminChecklistsVisible = (config: DeployConfig): boolean =>
  config.ADMIN_SHOW_CHECKLISTS ?? config.ADMIN_SHOW_SNAPSHOT_EXPORT_CHECKLIST;

const publicOrigin = (domain: string, ssl: boolean, httpPort: number, httpsPort: number): string => {
  const port = ssl ? httpsPort : httpPort;
  const suffix = port === (ssl ? 443 : 80) ? "" : `:${port}`;
  return `${ssl ? "https" : "http"}://${domain}${suffix}`;
};

const frontendBuildEnv = (frontend: string, config: DeployConfig): Record<string, string> => {
  if (frontend === "admin-front") {
    const visible = String(adminChecklistsVisible(config));
    return {
      VITE_SHOW_CHECKLISTS: visible,
      VITE_SHOW_SNAPSHOT_EXPORT_CHECKLIST: visible,
      VITE_SHOW_HELP_PANELS: String(config.ADMIN_SHOW_HELP_PANELS),
    };
  }
  if (frontend === "merchant-front") {
    // The merchant portal and the checkout portal are separate vhosts; a link
    // built from the merchant origin would point at the wrong service.
    return { VITE_CHECKOUT_BASE_URL: publicOrigin(config.CHECKOUT_DOMAIN, config.CHECKOUT_SSL, config.CHECKOUT_HTTP_PORT, config.CHECKOUT_HTTPS_PORT) };
  }
  if (frontend === "fake-rails-front") {
    // The hosted widget posts to its embedding checkout origin instead of "*".
    return { VITE_CHECKOUT_ORIGIN: publicOrigin(config.CHECKOUT_DOMAIN, config.CHECKOUT_SSL, config.CHECKOUT_HTTP_PORT, config.CHECKOUT_HTTPS_PORT) };
  }
  return {};
};

/**
 * Runtime settings written into the deployed release. These are the values
 * the SPA reads at boot and take precedence over build-time defaults.
 */
const frontendRuntimeConfig = (frontend: string, config: DeployConfig): Record<string, unknown> | null => {
  if (frontend === "admin-front") {
    const visible = adminChecklistsVisible(config);
    return {
      showChecklists: visible,
      // Legacy key read by releases built before the master checklist flag.
      showSnapshotExportChecklist: visible,
      showHelpPanels: config.ADMIN_SHOW_HELP_PANELS,
    };
  }
  return null;
};

/** The SPAs the selected roles actually deploy (an `--only=core` run builds none). */
const frontendsToBuild = (config: DeployConfig, options: CliOptions): string[] => {
  const wanted: Array<[DeployRole, string]> = [["admin", "admin-front"], ["merchant", "merchant-front"], ["checkout", "checkout-front"]];
  if (config.FAKE_RAILS_ENABLED) wanted.push(["fake-rails", "fake-rails-front"]);
  return wanted.filter(([role]) => shouldRun(options, role)).map(([, frontend]) => frontend);
};

/** One line per managed service: what the convergence did (started / restarted / reloaded / unchanged). */
const logOutcomes = (outcomes: Record<string, string> | undefined): void => {
  const entries = Object.entries(outcomes ?? {});
  if (entries.length === 0) return;
  log(`  services: ${entries.map(([service, outcome]) => `${service}=${outcome}`).join(", ")}`);
};

const main = async (): Promise<void> => {
  const options = parseArgs(process.argv.slice(2));

  // ---- Step 1: configuration and plan ------------------------------------
  step(1, "Validate deploy.env and build the execution plan");
  if (!existsSync(options.envPath)) {
    throw new Error(
      `Missing ${options.envPath}. Copy deploy/deploy.env.example to deploy/deploy.env and fill it in.`,
    );
  }
  const loaded = loadDeployConfig(readFileSync(options.envPath, "utf8"));
  if (!loaded.ok || !loaded.config) {
    throw new Error(`Invalid deploy.env:\n- ${loaded.problems.join("\n- ")}`);
  }
  const config = loaded.config;
  if (!objectStorageConfigured(config)) {
    warn("OBJECT_STORAGE_NODE is not configured: the platform will boot, but every storage-backed feature (KYB, reconciliation, reports, disputes, AML evidence, brand assets) will return 503 until the shared vault is configured.");
  }
  if (config.PGBOUNCER_ENABLED && !config.PG_MANAGE_VIA_SSH && !config.LEADER_ELECTION_DATABASE_URL) {
    warn(
      "PgBouncer is externally managed and LEADER_ELECTION_DATABASE_URL is not set: the deploy assumes a session-pooled " +
        "database alias named 'pgw_session' on the pooler. If your session route has another name or uses a direct " +
        "PostgreSQL URL, set LEADER_ELECTION_DATABASE_URL; migrations and seeders reuse it with the owner credentials.",
    );
  }
  const conflicts = findSshConflicts(config);
  if (conflicts.length > 0) {
    throw new Error(`Invalid host topology:\n- ${conflicts.join("\n- ")}`);
  }
  if (options.checkCerts) {
    // AUTO-28: read-only expiry report for cron / an alert hook; exit 1 when anything needs attention.
    const window = config.MTLS_RENEW_WITHIN_DAYS > 0 ? config.MTLS_RENEW_WITHIN_DAYS : 30;
    const report = checkPkiExpiry(buildPki({ config, dryRun: true }), window, new Date(), objectStorageConfigured(config));
    log(report.lines.join("\n"));
    log(report.ok ? `\nAll certificates are valid for at least ${window} days.` : `\nAttention: leaves are re-issued by the next deploy; a CA near expiry needs --rotate-certs.`);
    process.exit(report.ok ? 0 : 1);
  }
  const plan = planHosts(config);
  log(renderTopology(plan));
  if (options.dryRun) {
    log("\n[dry-run] no remote command will be executed");
  }

  const runner = new SshRunner({ dryRun: options.dryRun, verbose: true });
  // Mask every credential value (pgpass lines, connection URLs...) in logs and errors.
  runner.addSecrets(collectSecretValues(config));
  activeRunner = runner;

  const fresh = options.fresh || (options.update ? false : config.DEPLOY_MODE === "fresh");
  // `auto` (the default) decides PER HOST: a host with gaps is bootstrapped, a complete one is left alone.
  const autoProbe = !fresh && !options.update && config.DEPLOY_MODE === "auto";

  // ---- Preflight (read-only; before builds, PKI, bootstrap or any mutation) ----
  if (options.preflightOnly || !options.skipPreflight) {
    const preflightOptions = {
      only: options.only,
      nodes: options.nodes,
      fresh,
      deployMode: config.DEPLOY_MODE,
      dryRun: options.dryRun,
      stopUnmanaged: options.stopUnmanaged,
    };
    const preflightPlan = buildPreflightPlan(config, plan, preflightOptions);
    const report = runPreflight(runner, config, plan, preflightOptions);
    for (const line of renderPreflightReport(report, preflightPlan)) log(line);
    if (options.preflightOnly) {
      runner.close();
      process.exit(report.blocking.length > 0 ? 1 : 0);
    }
    if (report.blocking.length > 0) {
      throw new Error(
        `Preflight failed with ${report.blocking.length} blocking issue(s). Nothing was built or changed. ` +
          "Fix the issues above (or use --stop-unmanaged for a safe same-repo dev listener).",
      );
    }
  } else {
    warn("Preflight skipped (--skip-preflight): port ownership, SSH/sudo, dependency and release checks were not run.");
  }

  // ---- Step 2: build the SPAs locally ------------------------------------
  // Started in the background (content-addressed cache, parallel): the builds
  // overlap with storage provisioning and each one is awaited right before the
  // tier that ships it.
  step(2, "Build the frontend SPAs (background, cached)");
  let builds: FrontendBuildHandle | undefined;
  if (options.skipBuild || options.dryRun) {
    log(`  skipped (${options.dryRun ? "--dry-run" : "--skip-build"})`);
  } else {
    const frontends = frontendsToBuild(config, options);
    if (frontends.length === 0) {
      log("  nothing to build (--only excludes every portal)");
    } else {
      builds = startFrontendBuilds({
        repoRoot: REPO_ROOT,
        frontends,
        envFor: (frontend) => frontendBuildEnv(frontend, config),
        force: options.rebuild,
        logger: log,
      });
      activeBuilds = builds;
      log(`  building in the background: ${frontends.join(", ")}`);
    }
  }

  // ---- Step 3: PKI -------------------------------------------------------
  step(3, "Ensure the mTLS PKI");
  const pki = buildPki({ config, rotate: options.rotateCerts, dryRun: options.dryRun });
  if (options.dryRun) {
    log(`  would ensure: ${[pki.ca, pki.server, pki.backup, ...pki.clients, ...pki.storageClients].map((material) => material.name).join(", ")}`);
    log(`  core SAN: ${(pki.server.sans ?? []).join(",")}`);
  } else {
    if ((pki.renewed ?? []).length > 0) {
      log(`  renewed (expiring within ${config.MTLS_RENEW_WITHIN_DAYS} days, same CA): ${(pki.renewed ?? []).join(", ")}`);
    }
    for (const certificate of verifyPki(pki)) {
      log(`  ${certificate.name}: valid ${certificate.expiresInDays} day(s)${certificate.sans.length > 0 ? ` SAN=${certificate.sans.join(",")}` : ""}`);
    }
    for (const row of pkiRenewalReport(pki, config.MTLS_RENEW_WITHIN_DAYS > 0 ? config.MTLS_RENEW_WITHIN_DAYS : 30)) {
      if (row.action !== "renew-on-deploy") warn(`${row.name}: ${row.action === "expired" ? "EXPIRED" : `expires in ${row.expiresInDays} day(s); replacing the CA is a rotation: run deploy with --rotate-certs`}`);
    }
  }
  uploadStorageCertificates(runner, plan, pki, config, options.dryRun);
  const certRefresh = options.rotateCerts || (pki.renewed ?? []).length > 0;

  // ---- Step 4: bootstrap the unique hosts -------------------------------
  step(4, "Bootstrap the target hosts and apply the firewall");
  if (fresh || options.enforceFirewall || autoProbe) {
    for (const host of plan.hosts) {
      if (!options.dryRun) {
        runner.assertKeyExists(host.ssh);
      }
      runner.run(host.ssh, "true");
      let bootstrapThisHost = fresh;
      if (autoProbe && !options.dryRun) {
        const gaps = bootstrapGaps(runner.capture(host.ssh, hostProbeScript({ nginx: host.nginx.length > 0 }), { sudo: false }));
        if (gaps.length > 0) {
          log(`  ${host.ssh.host}: auto mode found a host that is not bootstrapped (${gaps.join(", ")}); bootstrapping it`);
          bootstrapThisHost = true;
        } else {
          log(`  ${host.ssh.host}: auto mode found a bootstrapped host`);
        }
      }
      if (bootstrapThisHost) {
        bootstrapHost(runner, host, config);
      }
      if (autoProbe && !options.enforceFirewall && !bootstrapThisHost) continue;
      const firewall = applyFirewall({ runner, host, config, dryRun: options.dryRun });
      log(`  ${host.ssh.host}: ${firewall.commands.length} ufw rule(s)`);
      if (!options.dryRun) {
        log(readFirewallStatus(runner, host).split("\n").slice(0, 12).map((line) => `    ${line}`).join("\n"));
      }
    }
  } else {
    log("  skipped (update mode; pass --fresh or --enforce-firewall to bootstrap)");
  }
  if (autoProbe && options.dryRun) log("  auto mode: hosts are not probed in --dry-run");

  // ---- Step 5: storage provisioning and pre-migration backup -------------
  step(5, "Provision storage engines and take a pre-migration backup");
  const coreHost = plan.hosts.find((host) => host.roles.includes("core"));
  if (!coreHost) {
    throw new Error("The plan has no core host");
  }
  const releaseTimestamp = timestamp();

  // A `--fresh` deploy is only safe when the storage engines it is about to
  // provision are empty. Probe before installing/migrating anything, so a
  // populated PostgreSQL/Redis/vault is never silently reused. A typed
  // --force-fresh is the explicit destructive opt-in; it clears those stores
  // before the provisioners recreate their schemas. Backup repositories are
  // deliberately preserved (they are the recovery path, not application data).
  const freshStorageOptions = {
    runner,
    config,
    plan,
    includePostgres: pgStorageConfigured(config) && shouldRunStorage(options, ["pg", "pg-primary", "pgbouncer"]),
    includeRedis: config.REDIS_MANAGE_VIA_SSH && shouldRunStorage(options, ["redis"]),
    includeAuditLog: (config.AUDIT_DB_MANAGE_VIA_SSH || config.LOG_DB_MANAGE_VIA_SSH)
      && shouldRunStorage(options, ["audit-db", "log-db"]),
    includeObjectStorage: objectStorageConfigured(config) && shouldRunStorage(options, ["object-storage"]),
    includeFakeRails: config.FAKE_RAILS_ENABLED && shouldRun(options, "fake-rails"),
  };
  if (fresh && !options.dryRun && (freshStorageOptions.includePostgres || freshStorageOptions.includeRedis || freshStorageOptions.includeAuditLog || freshStorageOptions.includeObjectStorage || freshStorageOptions.includeFakeRails)) {
    const storageState = probeFreshStorage(freshStorageOptions);
    const occupied = storageState.nonEmpty || storageState.unknown.length > 0;
    if (occupied && !options.forceFresh) {
      throw new Error(
        [
          "--fresh refused: existing storage-engine data was found.",
          ...storageState.details.map((line) => `- ${line}`),
          ...storageState.unknown.map((line) => `- ${line}`),
          "Re-run with --force-fresh (or DEPLOY_FORCE_FRESH=1) only if you intend to erase it. A pre-clean dump of the Live PostgreSQL database is taken first.",
        ].join("\n"),
      );
    }
    if (options.forceFresh) {
      if (storageState.details.some((line) => line.startsWith("PostgreSQL/Live"))) {
        // Cleanup happens before the core migration step, so take the safety
        // dump now rather than after the database has been dropped.
        backupDatabase({ runner, config, host: coreHost, releaseTimestamp });
      }
      if (storageState.details.length > 0) log(`  cleaning storage: ${storageState.details.join("; ")}`);
      for (const line of cleanFreshStorage(freshStorageOptions)) log(`  cleaned: ${line}`);
    } else if (storageState.unknown.length > 0) {
      warn(`  storage emptiness could not be proven: ${storageState.unknown.join("; ")}`);
    }
  }

  if (config.PG_MANAGE_VIA_SSH && shouldRunStorage(options, ["pg", "pg-primary", "pg-replica", "pgbouncer"])) {
    const report = provisionPostgres18({ runner, config, dryRun: options.dryRun, forceRestart: options.forceRestart });
    log(`  PostgreSQL ${config.PG_VERSION} primary/replicas: ${report.nodes.join(", ") || "none"}`);
    for (const note of report.notes ?? []) warn(note);
    log(`  PgBouncer ${config.PGBOUNCER_ENABLED ? `:${config.PGBOUNCER_PORT}` : "disabled"}`);
    logOutcomes(report.outcomes);
  } else if (pgStorageConfigured(config)) {
    log("  PostgreSQL: skipped (--only excludes pg)");
  }
  if (pgStorageConfigured(config) && !pgAppRoleEnabled(config)) {
    warn("PG_APP_PASSWORD is not set: the application connects to PostgreSQL as the database OWNER, so the append-only ledger protection can be removed by anything that runs as the application. Set PG_APP_PASSWORD (and optionally PG_APP_USER) to run it as the non-owner `pgw_app` role.");
  }
  if (config.REDIS_MANAGE_VIA_SSH && shouldRunStorage(options, ["redis"])) {
    const report = provisionRedis({ runner, config, dryRun: options.dryRun, forceRestart: options.forceRestart });
    log(`  Redis nodes: ${report.nodes.join(", ") || "none"}`);
    logOutcomes(report.outcomes);
  }
  if (clamdManaged(config) && shouldRun(options, "core")) {
    // AUTO-06: ClamAV (clamd + freshclam) on every core host, loopback only; the core env points at it.
    const coreHosts = plan.hosts.filter((host) => host.roles.includes("core"));
    const report = provisionClamav({ runner, config, hosts: coreHosts, dryRun: options.dryRun, forceRestart: options.forceRestart });
    log(`  ClamAV (clamd ${options.dryRun ? "planned" : "converged"}) on: ${report.nodes.join(", ") || "none"}`);
    for (const note of report.notes ?? []) warn(note);
    logOutcomes(report.outcomes);
  }
  if ((config.AUDIT_DB_MANAGE_VIA_SSH || config.LOG_DB_MANAGE_VIA_SSH) && shouldRunStorage(options, ["audit-db", "log-db"])) {
    const report = provisionAuditAndLogDb({ runner, config, dryRun: options.dryRun, forceRestart: options.forceRestart });
    log(`  Audit/log databases: ${report.nodes.join(", ") || "none"}`);
    logOutcomes(report.outcomes);
  }
  if (objectStorageConfigured(config) && shouldRunStorage(options, ["object-storage"])) {
    const report = provisionObjectStorageEngine({
      runner,
      config,
      dryRun: options.dryRun,
      forceRestart: options.forceRestart,
    });
    log(`  Object storage engine on: ${report.nodes.join(", ") || "none"}`);
    logOutcomes(report.outcomes);
    const objectStorageHost = plan.hosts.find((host) => host.roles.includes("object-storage"));
    if (objectStorageHost) {
      deployObjectStorageDaemon({
        runner,
        config,
        host: objectStorageHost,
        configChanged: report.daemonConfigChanged,
        forceRestart: options.forceRestart || certRefresh,
      });
    } else {
      warn("object storage is configured but the plan has no object-storage host; the daemon was not deployed");
    }
  }
  if (config.BACKUP_ENABLED && shouldRunStorage(options, ["backup"])) {
    const report = provisionBackupEngine({ runner, config, dryRun: options.dryRun, forceRestart: options.forceRestart });
    log(`  Backup engine (${config.BACKUP_ENGINE_MODE}) on: ${report.nodes.join(", ") || "none"}; object store: ${backupS3Configured(config) ? resolveBackupS3Mode(config) : "none (local repo)"}`);
    logOutcomes(report.outcomes);
    const backupHost = plan.hosts.find((host) => host.roles.includes("backup"));
    if (backupHost) {
      deployBackupDaemon({ runner, config, host: backupHost, configChanged: report.daemonConfigChanged, forceRestart: options.forceRestart || certRefresh });
    } else {
      warn("BACKUP_ENABLED but the plan has no backup host; the daemon was not deployed");
    }
  }

  if (!pgStorageConfigured(config) && (shouldRun(options, "db") || shouldRun(options, "core"))) {
    const dbHost = plan.hosts.find((host) => host.roles.includes("db")) ?? coreHost;
    provisionDatabase({ runner, config, host: dbHost });
  } else if (!pgStorageConfigured(config)) {
    log("  skipped (--only excludes db/core)");
  }
  // The pre-migration dump (primary direct port, never PgBouncer) is taken by
  // deployService on the first core node, BEFORE `migrate deploy`, in both
  // fresh and update mode whenever the database is non-empty (see planMigrations).

  // ---- Steps 6-9: deploy the services in dependency order ---------------
  const deployTargets: Array<{ index: number; role: "core" | "admin" | "merchant" | "checkout" | "fake-rails"; title: string }> = [
    { index: 6, role: "core", title: "Deploy core-back to CORE_HOST" },
    ...(config.FAKE_RAILS_ENABLED
      ? [{ index: 7, role: "fake-rails" as const, title: "Deploy fake-rails-back + fake-rails-front to FAKE_RAILS_HOST" }]
      : []),
    { index: 8, role: "admin", title: "Deploy admin-back + admin-front to ADMIN_HOST" },
    { index: 9, role: "merchant", title: "Deploy merchant-back + merchant-front to MERCHANT_HOST" },
    { index: 10, role: "checkout", title: "Deploy checkout-back + checkout-front to CHECKOUT_HOST" },
  ];
  // The SPA builds run in the background since step 2. Wait for ALL of them before the first service
  // is touched: otherwise a failed build was only noticed per role inside the loop below, after the
  // database had been migrated and core had been switched to the new release.
  if (builds) await builds.waitAll();
  for (const target of deployTargets) {
    step(target.index, target.title);
    if (!shouldRun(options, target.role)) {
      log(`  skipped (--only excludes ${target.role})`);
      continue;
    }
    const units = deploymentUnits(plan, target.role, options.nodes);
    if (units.length === 0) {
      if (options.nodes) {
        log(`  skipped (--nodes excludes every ${target.role} node)`);
        continue;
      }
      throw new Error(`The plan has no ${target.role} host`);
    }
    const allUnits = deploymentUnits(plan, target.role);
    if (builds && target.role !== "core") {
      const result = await builds.wait(FRONTENDS[target.role]);
      if (!result.cached) log(`  ${FRONTENDS[target.role]} build ready (${(result.ms / 1000).toFixed(1)}s)`);
    }
    const batchSize = options.rollingBatch ?? config.ROLLING_BATCH_SIZE;
    const batches = rollingBatches(units, batchSize);
    for (const [batchIndex, batch] of batches.entries()) {
      log(`  rolling batch ${batchIndex + 1}/${batches.length} (${batch.map((unit) => unit.service.nodeId ?? unit.service.name).join(", ")})`);
      for (const unit of batch) {
        deployService({
          runner,
          host: unit.host,
          service: unit.service,
          config,
          pki,
          releaseTimestamp,
          keepReleases: options.keepReleases ?? config.KEEP_RELEASES,
          plannedServiceNames: allUnits.map((candidate) => candidate.service.name),
          migration: target.role === "core"
            ? { fresh, forceFresh: options.forceFresh, firstCoreNode: unit.service.nodeId === plan.nodes.core[0]?.nodeId }
            : undefined,
        });
      }
      if (options.dryRun) continue;
      for (const unit of batch) {
        const probe = target.role === "core"
          ? probeCoreService(runner, unit.host, unit.service, config, releaseTimestamp)
          : probeEdgeService(runner, unit.host, unit.service, releaseTimestamp);
        if (!probe.ok) {
          throw new Error(
            runner.scrub(`Rolling batch ${batchIndex + 1} failed health check on ${probe.host} ${probe.check}: ${probe.detail}`),
          );
        }
        log(`  PASS ${probe.host} ${probe.check}`);
      }
      if (batchIndex < batches.length - 1) {
        log(`  batch ${batchIndex + 1} healthy; continuing to the next batch`);
      }
    }
  }

  // ---- Step 11: end-to-end verification (BEFORE the seed) ----------------
  // A deployment that does not verify must stop here: the seed can run for up to an hour and writes ~280k rows
  // that nobody wants on top of a release that already failed its health checks.
  step(11, "End-to-end cross-host mTLS and health verification");
  if (options.skipVerify || options.dryRun) {
    log("  skipped");
  } else {
    // Step 7 already checks APP_RELEASE on every unit this run deployed.
    // Only a full deploy may require every (possibly unchanged) service to
    // advertise the new global release; a partial deploy intentionally leaves
    // the other tiers on their previous release.
    const releaseToVerify = isFullDeployment(options) ? releaseTimestamp : undefined;
    if (!releaseToVerify) log("  release identity checked per deployed unit in step 7; unchanged services are health-checked only");
    const verification = verifyDeployment(runner, plan, config, releaseToVerify);
    log(runner.scrub(renderVerification(verification)));
    if (!verification.ok) {
      throw new Error("Deployment verification failed. There is no automatic rollback and no rollback command: the previous release is still on disk (KEEP_RELEASES), but `current` already points at the new one and the database schema was already migrated and is NOT reverted. To go back, re-point <remote dir>/current to the previous release on each host, restart the PM2 services, and only then decide about the schema.");
    }
  }

  // ---- Step 12: seed the Fake Rails blueprints and synthetic history ------
  step(12, "Seed Fake Rails blueprints and synthetic operational history");
  if (options.dryRun) {
    log("  skipped (--dry-run)");
  } else if (!config.FAKE_RAILS_ENABLED) {
    log("  skipped (FAKE_RAILS_ENABLED=false)");
  } else if (shouldRun(options, "core")) {
    const firstCore = plan.nodes.core[0];
    const coreService = coreHost.services.find((service) => service.role === "core" && service.nodeId === firstCore?.nodeId)
      ?? coreHost.services.find((service) => service.role === "core");
    const coreCurrent = coreService?.currentLink ?? `${config.CORE_REMOTE_DIR}/current`;
    const coreRemote = `${coreCurrent}/core-back`;
    const coreSeedTarget = firstCore?.ssh ?? coreHost.ssh;
    const bun = 'PATH="$HOME/.bun/bin:/usr/local/bin:$PATH" bun';
    if (config.SEED_FAKE_RAILS_BLUEPRINTS) {
      runAsDatabaseOwner(runner, coreHost, coreRemote, config, (flag) => () =>
        runner.run(coreSeedTarget, `${bun} ${flag} run seed-fake-rails`.replace("  ", " "), { cwd: coreRemote, sudo: false, timeoutMs: 30 * 60_000 }));
      log("  fake rails blueprints seeded in core-back");
    }
    if (config.RUN_SYNTHETIC_HISTORY_SEED) {
      // The STANDARD profile generates/writes ~280k rows and syncs 120k
      // transactions to Fake Rails; on a single box this exceeds the default
      // 15-minute command timeout, so give it a generous ceiling.
      const seeded = runAsDatabaseOwner(runner, coreHost, coreRemote, config, (flag) => () =>
        runner.run(coreSeedTarget, `${bun} ${flag} run seed-synthetic-history`.replace("  ", " "), { cwd: coreRemote, sudo: false, timeoutMs: 60 * 60_000 }));
      const summary = seeded.stdout.trim().split("\n").slice(-4).join("\n");
      if (summary) log(summary.split("\n").map((line) => `  ${line}`).join("\n"));
      if (seeded.stdout.includes("was already seeded successfully") || seeded.stdout.includes("synthetic history already present under seed key")) {
        log(`  synthetic history already present for seed key '${config.SYNTHETIC_SEED_KEY}'; skipped`);
      } else {
        log(`  synthetic history seeded (${config.SYNTHETIC_SEED_PROFILE})`);
      }
    }
  } else {
    log("  skipped (--only excludes core)");
  }

  // ---- Step 13: prune ----------------------------------------------------
  step(13, "Prune old releases");
  log(`  kept the last ${options.keepReleases ?? config.KEEP_RELEASES} release(s) per host`);

  // ---- Step 14: audit summary -------------------------------------------
  step(14, "Deployment audit summary");
  const commit = deployCommit();
  log(`  commit:     ${commit}`);
  log(`  release:    ${releaseTimestamp}`);
  log(`  topology:   ${plan.topology} (${plan.hosts.length} host(s))`);
  for (const host of plan.hosts) {
    log(`  ${host.ssh.host}: ${host.roles.join(", ")}`);
  }
  if (!options.dryRun) {
    for (const certificate of verifyPki(pki)) {
      log(`  cert ${certificate.name}: expires ${certificate.notAfter} (${certificate.expiresInDays} days)`);
    }
  }
  const finishedAt = Date.now();
  log("");
  log("Timing (wall clock per step):");
  log(renderStepTimings(stepTimes, finishedAt));
  if (!options.dryRun) {
    const slowest = runner.slowest(5).filter((entry) => entry.ms >= 1000);
    if (slowest.length > 0) {
      log("Slowest remote commands:");
      for (const entry of slowest) log(`  ${(entry.ms / 1000).toFixed(1).padStart(7)}s  ${entry.host}  ${entry.command.slice(0, 110)}`);
    }
  }
  runner.close();
  log("");
  log("Deployment complete.");
};

export { parseArgs, absoluteEnv, renderEnvFile, pm2Ecosystem, frontendRuntimeConfig, frontendsToBuild };

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = (error as Error).message;
    console.error(`\nDeployment failed: ${activeRunner ? activeRunner.scrub(message) : message}`);
    activeBuilds?.abort();
    activeRunner?.close();
    process.exit(1);
  });
}
