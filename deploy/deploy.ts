#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { effectiveDatabase, loadDeployConfig, resolveBackupS3Mode, withIpv6Loopback, parseNodeList, pgStorageConfigured, type DeployConfig, type DeployRole } from "./lib/configSchema";
import { findSshConflicts, planHosts, renderTopology, type DeployPlan, type HostPlan, type ServicePlan } from "./lib/hostPlanner";
import { buildPki, certFilesForHost, readMaterial, verifyPki } from "./lib/pkiManager";
import { effectiveTargetHome, effectiveTargetUser, SshRunner } from "./lib/sshRunner";
import { applyFirewall, readFirewallStatus } from "./lib/firewallConfigurator";
import { probeCoreService, probeEdgeService, renderVerification, verifyDeployment } from "./lib/healthVerifier";
import { bootstrapPackagesCommand, detectHostOs } from "./lib/osDetector";
import { provisionPostgres18 } from "./provisioners/postgres18Provisioner";
import { provisionRedis } from "./provisioners/redisProvisioner";
import { provisionAuditAndLogDb } from "./provisioners/auditAndLogDbProvisioner";
import { provisionBackupEngine } from "./provisioners/backupEngineProvisioner";

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

type StorageOnlyRole = "pg" | "pg-primary" | "pg-replica" | "pgbouncer" | "redis" | "audit-db" | "log-db" | "backup" | "storage";
type OnlyRole = DeployRole | StorageOnlyRole;

interface CliOptions {
  envPath: string;
  only: Set<OnlyRole>;
  dryRun: boolean;
  fresh: boolean;
  update: boolean;
  enforceFirewall: boolean;
  skipBuild: boolean;
  skipVerify: boolean;
  rotateCerts: boolean;
  keepReleases?: number;
  rollingBatch?: number;
  nodes?: Set<string>;
}

const ONLY_ROLES: OnlyRole[] = ["db", "core", "admin", "merchant", "checkout", "fake-rails", "pg", "pg-primary", "pg-replica", "pgbouncer", "redis", "audit-db", "log-db", "backup", "storage"];

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
    update: false,
    enforceFirewall: false,
    skipBuild: false,
    skipVerify: false,
    rotateCerts: false,
  };
  for (const raw of argv) {
    if (raw === "--dry-run") options.dryRun = true;
    else if (raw === "--fresh") options.fresh = true;
    else if (raw === "--update") options.update = true;
    else if (raw === "--enforce-firewall") options.enforceFirewall = true;
    else if (raw === "--skip-build") options.skipBuild = true;
    else if (raw === "--skip-verify") options.skipVerify = true;
    else if (raw === "--rotate-certs") options.rotateCerts = true;
    else if (raw.startsWith("--env=")) options.envPath = resolve(REPO_ROOT, raw.slice(6));
    else if (raw.startsWith("--only=")) {
      for (const role of raw.slice(7).split(",")) {
        const normalized = role.trim().toLowerCase();
        if (!ONLY_ROLES.includes(normalized as OnlyRole)) {
          throw new Error(`Unknown --only role '${role}'`);
        }
        options.only.add(normalized as OnlyRole);
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
const step = (index: number, title: string): void => {
  log();
  log(`\u001b[1m[${index}/14] ${title}\u001b[0m`);
};
const warn = (message: string): void => console.warn(`  ! ${message}`);

const timestamp = (): string => new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);

const STORAGE_CERT_DIR = "/etc/pg-deploy/certs";

const isStorageRole = (role: string): boolean =>
  ["pg-primary", "pg-replica", "pgbouncer", "redis", "audit-db", "log-db", "backup"].includes(role);

const uploadStorageCertificates = (
  runner: SshRunner,
  plan: DeployPlan,
  pki: ReturnType<typeof buildPki>,
  config: DeployConfig,
  dryRun: boolean,
): void => {
  for (const host of plan.hosts.filter((candidate) => candidate.roles.some(isStorageRole))) {
    const directory = host.roles.includes("backup")
      ? config.BACKUP_DAEMON_CERT_DIR
      : STORAGE_CERT_DIR;
    for (const material of certFilesForHost(pki, host.roles)) {
      if (dryRun) {
        runner.writeRemoteFile({ target: host.ssh, path: `${directory}/${material.name}.crt`, content: "", mode: 0o644, sudo: true });
        continue;
      }
      const content = readMaterial(material);
      runner.writeRemoteFile({ target: host.ssh, path: `${directory}/${material.name}.crt`, content: content.cert, mode: 0o644, sudo: true });
      if (content.key) {
        runner.writeRemoteFile({ target: host.ssh, path: `${directory}/${material.name}.key`, content: content.key, mode: 0o600, sudo: true });
      }
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
    runner.run(host.ssh, `mkdir -p /etc/ssl/pg && openssl req -x509 -newkey rsa:2048 -nodes -keyout ${localKey} -out ${localCert} -days 365 -subj "/CN=${domain}" -addext "subjectAltName=${san}"`, { sudo: true });
    return { certPath: localCert, keyPath: localKey };
  }
  if (mode === "certbot") {
    runner.run(
      host.ssh,
      `test -f ${certPath} || echo "!! missing certificate ${certPath}; run: certbot --nginx -d ${domain} --agree-tos -m ops@${domain}"`,
      { sudo: true },
    );
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
    .replaceAll("{{LAN_ALLOWED_CIDRS}}", withIpv6Loopback(input.lanAllowedCidrs));
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
      lanAllowedCidrs: config.LAN_ALLOWED_CIDRS,
      upstreamName: site.upstreamName,
      upstreamServers: site.upstreamServers,
    });
    const available = `/etc/nginx/sites-available/pg-${site.site}.conf`;
    runner.writeRemoteFile({ target: host.ssh, path: available, content: rendered, mode: 0o644, sudo: true });
    runner.run(host.ssh, `ln -sfn ${available} /etc/nginx/sites-enabled/pg-${site.site}.conf && rm -f /etc/nginx/sites-enabled/default`, { sudo: true });
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
  runMigrations?: boolean;
  /** Every service name the plan has for this tier (all nodes, unfiltered). */
  plannedServiceNames?: string[];
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
  runner.run(host.ssh, "mkdir -p " + [releaseDir, `${remote}/shared/certs`, `${remote}/shared/backups`, `${remote}/shared/pm2`, `${remote}/shared/data`].join(" ") + ` && chown -R ${owner} ${remote}`, { sudo: true });

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
    runner.run(host.ssh, `mkdir -p ${releaseDir}/${frontend}`, { sudo: false });
    runner.sync({
      target: host.ssh,
      local: dist,
      remote: `${releaseDir}/${frontend}/dist`,
      excludes: [],
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
  for (const material of certFilesForHost(pki, host.roles)) {
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
  const env = absoluteEnv(service.env, remote);
  const envPath = `${remote}/shared/${service.envFileName ?? ".env"}`;
  runner.writeRemoteFile({ target: host.ssh, path: envPath, content: renderEnvFile(env), mode: 0o600, sudo: false });
  runner.run(host.ssh, `ln -sfn ${envPath} ${appDir}/.env`, { sudo: false });

  // 5. Dependencies and, for the core, the schema.
  const bun = 'PATH="$HOME/.bun/bin:/usr/local/bin:$PATH" bun';
  runner.run(host.ssh, `${bun} install --frozen-lockfile`, { cwd: appDir, sudo: false });
  if (service.role === "core") {
    runner.run(host.ssh, `${bun}x prisma generate`, { cwd: appDir, sudo: false });
    if (input.runMigrations !== false) {
      runner.run(host.ssh, `${bun} run migrate-deploy`, { cwd: appDir, sudo: false });
    }
    if (config.RUN_PRISMA_SEED) {
      runner.run(host.ssh, `${bun} run db-seed`, { cwd: appDir, sudo: false });
    }
  }

  // 6. Atomic symlink switch. Multi-node hosts use a per-node link so two
  //    instances of the same tier never overwrite each other.
  const currentLink = service.currentLink ?? `${remote}/current`;
  runner.run(host.ssh, `ln -sfn ${releaseDir} ${currentLink}`, { sudo: false });

  // 7. PM2.
  const ecosystem = `${remote}/shared/pm2/${service.name}.config.cjs`;
  runner.writeRemoteFile({ target: host.ssh, path: ecosystem, content: pm2Ecosystem(service, releaseDir), mode: 0o644, sudo: false });
  runner.run(host.ssh, retireOrphanedPm2Apps(service, input.plannedServiceNames ?? []), { sudo: false });
  runner.run(
    host.ssh,
    `"$HOME/.bun/bin/pm2" delete ${service.name} >/dev/null 2>&1 || true; "$HOME/.bun/bin/pm2" start ${ecosystem} --update-env && "$HOME/.bun/bin/pm2" save`,
    { sudo: false },
  );

  // 8. Nginx (only the site owned by the service being deployed).
  renderNginx(host, config, runner, service.role);

  // 9. Prune.
  runner.run(
    host.ssh,
    `ls -1dt ${releaseRoot}/*/ 2>/dev/null | tail -n +${input.keepReleases + 1} | xargs -r rm -rf`,
    { sudo: false },
  );

  log(`  ${service.name} -> ${releaseDir}`);
  return releaseDir;
};

/** Copies the daemon source to BACKUP_NODE and (re)starts its systemd unit. */
const deployBackupDaemon = (input: {
  runner: SshRunner;
  config: DeployConfig;
  host: HostPlan;
}): void => {
  const { runner, config, host } = input;
  const installDir = "/opt/pg-backup-daemon";
  const sourceDir = join(REPO_ROOT, "deploy", "backup-daemon");
  const targetUser = effectiveTargetUser(host.ssh);
  runner.run(
    host.ssh,
    `install -d -m 0755 -o ${targetUser} -g ${targetUser} ${installDir} && chown -R ${targetUser}:${targetUser} ${installDir}`,
    { sudo: true },
  );
  runner.sync({
    target: host.ssh,
    local: sourceDir,
    remote: installDir,
    delete: true,
    excludes: ["node_modules", ".git", "dist", "test", "*.log", ".env"],
  });
  runner.run(host.ssh, `chown -R postgres:postgres ${installDir}`, { sudo: true });
  runner.run(host.ssh, 'command -v /usr/local/bin/bun >/dev/null 2>&1 || (command -v bun >/dev/null 2>&1 || curl -fsSL https://bun.sh/install | bash)', { sudo: false });
  // The daemon runs as postgres, so a symlink into the SSH user's home can be
  // unreadable when that home is not world-traversable. Install a real copy.
  const bunPath = runner.dryRun
    ? `${effectiveTargetHome(host.ssh)}/.bun/bin/bun`
    : runner.capture(host.ssh, `command -v bun || { [ -x "$HOME/.bun/bin/bun" ] && echo "$HOME/.bun/bin/bun"; } || true`, { sudo: false }).trim();
  if (!bunPath && !runner.dryRun) {
    throw new Error(`bun is required on ${host.ssh.host} to run pg-backup-daemon`);
  }
  if (bunPath) {
    runner.run(
      host.ssh,
      `install -m 0755 ${JSON.stringify(bunPath)} /usr/local/bin/bun.staged && mv -f /usr/local/bin/bun.staged /usr/local/bin/bun`,
      { sudo: true },
    );
  }
  runner.run(host.ssh, "/usr/local/bin/bun install --frozen-lockfile", { cwd: installDir, sudo: true, sudoUser: "postgres" });
  runner.run(
    host.ssh,
    "systemctl daemon-reload && systemctl enable pg-backup-daemon && systemctl restart pg-backup-daemon",
    { sudo: true },
  );
  log(`  backup daemon source -> ${host.ssh.host}:${installDir} (BACKUP_DAEMON_PORT=${config.BACKUP_DAEMON_PORT})`);
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
  const createSql = [
    `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${config.DB_USER}') THEN CREATE ROLE "${config.DB_USER}" LOGIN PASSWORD '${config.DB_PASSWORD}'; END IF; END $$;`,
    `SELECT 'CREATE DATABASE "${config.DB_NAME}" OWNER "${config.DB_USER}"' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${config.DB_NAME}')\\gexec`,
  ].join("\n");

  const sqlPath = `/tmp/pg-db-init-${timestamp()}.sql`;
  runner.writeRemoteFile({ target: host.ssh, path: sqlPath, content: `${createSql}\n`, mode: 0o600 });
  try {
    runner.run(host.ssh, `psql -f ${sqlPath}`, { sudo: true, sudoUser: "postgres" });
  } finally {
    runner.run(host.ssh, `rm -f ${sqlPath}`);
  }
  log(`  database ${config.DB_NAME} and user ${config.DB_USER} ready on ${config.DB_PRIVATE_IP ?? host.ssh.host}`);
};

/** The exact pre-migration backup command, against the primary direct port. */
export const preMigrationBackup = (
  config: DeployConfig,
  target: string,
): { command: string; host: string; port: number; database: string; user: string } => {
  const database = effectiveDatabase(config);
  const primary = parseNodeList(config.PG_PRIMARY_NODE)[0];
  const pgStorage = pgStorageConfigured(config);
  const host = pgStorage && primary ? primary.privateIp : (config.DB_PRIVATE_IP ?? config.DB_SSH_HOST ?? "");
  const port = pgStorage && primary ? primary.servicePort : config.DB_PORT;
  const name = pgStorage ? config.PG_DB_NAME : database.name;
  const user = pgStorage ? config.PG_DB_USER : database.user;
  const password = pgStorage ? config.PG_DB_PASSWORD : database.password;
  return {
    host,
    port,
    database: name,
    user,
    command: `PGPASSWORD=${JSON.stringify(password)} pg_dump -h ${host} -p ${port} -U ${user} -Fc ${name} > ${target}.dump`,
  };
};

const backupDatabase = (input: { runner: SshRunner; config: DeployConfig; host: HostPlan; releaseTimestamp: string }): void => {
  const { runner, config, host, releaseTimestamp } = input;
  const backupDir = `${config.CORE_REMOTE_DIR}/shared/backups`;
  const target = `${backupDir}/pre-migrate-${releaseTimestamp}`;
  const { command } = preMigrationBackup(config, target);
  // The tree lives under /var/www and may not exist yet on an update deploy, so
  // the directory is created as root and handed to the effective target user
  // before the dump writes into it.
  const targetUser = effectiveTargetUser(host.ssh);
  runner.run(host.ssh, `mkdir -p ${backupDir} && chown ${targetUser}:${targetUser} ${backupDir}`, { sudo: true });
  runner.run(host.ssh, command, { sudo: false });
  log(`  pre-migration backup -> ${target}`);
};

/**
 * Build-time constants injected into each SPA. The deploy engine is the single
 * source of truth for deployment-specific UI visibility, so Vite never reads a
 * committed `.env` default for these values.
 */
export const adminChecklistsVisible = (config: DeployConfig): boolean =>
  config.ADMIN_SHOW_CHECKLISTS ?? config.ADMIN_SHOW_SNAPSHOT_EXPORT_CHECKLIST;

const frontendBuildEnv = (frontend: string, config: DeployConfig): Record<string, string> => {
  if (frontend === "admin-front") {
    const visible = String(adminChecklistsVisible(config));
    return {
      VITE_SHOW_CHECKLISTS: visible,
      VITE_SHOW_SNAPSHOT_EXPORT_CHECKLIST: visible,
      VITE_SHOW_HELP_PANELS: String(config.ADMIN_SHOW_HELP_PANELS),
    };
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

const buildFrontends = async (runner: SshRunner, config: DeployConfig): Promise<void> => {
  const frontends = ["admin-front", "merchant-front", "checkout-front"];
  if (config.FAKE_RAILS_ENABLED) frontends.push("fake-rails-front");
  for (const frontend of frontends) {
    await runner.localStreaming("bun run build", join(REPO_ROOT, frontend), frontendBuildEnv(frontend, config));
    log(`  built ${frontend}/dist`);
  }
};

const shouldRun = (options: CliOptions, role: DeployRole): boolean =>
  options.only.size === 0 || options.only.has(role);

const shouldRunStorage = (options: CliOptions, roles: StorageOnlyRole[]): boolean =>
  options.only.size === 0 || options.only.has("storage") || roles.some((role) => options.only.has(role));

const deploymentUnits = (
  plan: DeployPlan,
  role: DeployRole,
  nodes?: Set<string>,
): Array<{ host: HostPlan; service: ServicePlan }> =>
  plan.hosts.flatMap((host) =>
    host.services
      .filter((service) => service.role === role)
      .filter((service) => !nodes || (service.nodeId !== undefined && nodes.has(service.nodeId)))
      .map((service) => ({ host, service })),
  );

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
  const conflicts = findSshConflicts(config);
  if (conflicts.length > 0) {
    throw new Error(`Invalid host topology:\n- ${conflicts.join("\n- ")}`);
  }
  const plan = planHosts(config);
  log(renderTopology(plan));
  if (options.dryRun) {
    log("\n[dry-run] no remote command will be executed");
  }

  const runner = new SshRunner({ dryRun: options.dryRun, verbose: true });

  // ---- Step 2: build the three SPAs locally ------------------------------
  step(2, "Build the frontend SPAs");
  if (options.skipBuild || options.dryRun) {
    log(`  skipped (${options.dryRun ? "--dry-run" : "--skip-build"})`);
  } else {
    await buildFrontends(runner, config);
  }

  // ---- Step 3: PKI -------------------------------------------------------
  step(3, "Ensure the mTLS PKI");
  const pki = buildPki({ config, rotate: options.rotateCerts, dryRun: options.dryRun });
  if (options.dryRun) {
    log(`  would ensure: ${[pki.ca, pki.server, pki.backup, ...pki.clients, ...pki.storageClients].map((material) => material.name).join(", ")}`);
    log(`  core SAN: ${(pki.server.sans ?? []).join(",")}`);
  } else {
    for (const certificate of verifyPki(pki)) {
      log(`  ${certificate.name}: valid ${certificate.expiresInDays} day(s)${certificate.sans.length > 0 ? ` SAN=${certificate.sans.join(",")}` : ""}`);
    }
  }
  uploadStorageCertificates(runner, plan, pki, config, options.dryRun);

  // ---- Step 4: bootstrap the unique hosts -------------------------------
  step(4, "Bootstrap the target hosts and apply the firewall");
  const fresh = options.fresh || (options.update ? false : config.DEPLOY_MODE === "fresh");
  if (fresh || options.enforceFirewall) {
    for (const host of plan.hosts) {
      if (!options.dryRun) {
        runner.assertKeyExists(host.ssh);
      }
      runner.run(host.ssh, "true");
      if (fresh) {
        const os = detectHostOs(runner, host);
        log(`  ${host.ssh.host}: detected ${os} package manager`);
        const packages = bootstrapPackagesCommand(os);
        if (packages) {
          runner.run(host.ssh, packages, { sudo: true });
        } else {
          warn(`unknown OS on ${host.ssh.host}; install nginx/rsync/curl/nodejs manually`);
        }
        runner.run(host.ssh, "command -v bun >/dev/null 2>&1 || curl -fsSL https://bun.sh/install | bash", { sudo: false });
        // PM2 is a Node program and its shebang is `node`; expose Bun on a
        // stable absolute path so the PM2 interpreter setting always resolves.
        const targetUser = effectiveTargetUser(host.ssh);
        const targetHome = effectiveTargetHome(host.ssh);
        runner.run(host.ssh, `ln -sfn ${targetHome}/.bun/bin/bun /usr/local/bin/bun`, { sudo: true });
        runner.run(host.ssh, 'test -x "$HOME/.bun/bin/pm2" || PATH="$HOME/.bun/bin:/usr/local/bin:$PATH" bun add -g pm2', { sudo: false });
        runner.run(host.ssh, `ln -sfn ${targetHome}/.bun/bin/bunx /usr/local/bin/bunx`, { sudo: true });
        // Best effort: re-register the PM2 process list on boot.
        const pm2Path = `${targetHome}/.bun/bin:/usr/local/bin:/usr/bin:/bin`;
        runner.run(
          host.ssh,
          `env PATH=${pm2Path} pm2 startup systemd -u ${targetUser} --hp ${targetHome} >/dev/null 2>&1 || true`,
          { sudo: true },
        );
      }
      const firewall = applyFirewall({ runner, host, config, dryRun: options.dryRun });
      log(`  ${host.ssh.host}: ${firewall.commands.length} ufw rule(s)`);
      if (!options.dryRun) {
        log(readFirewallStatus(runner, host).split("\n").slice(0, 12).map((line) => `    ${line}`).join("\n"));
      }
    }
  } else {
    log("  skipped (update mode; pass --fresh or --enforce-firewall to bootstrap)");
  }

  // ---- Step 5: storage provisioning and pre-migration backup -------------
  step(5, "Provision storage engines and take a pre-migration backup");
  const coreHost = plan.hosts.find((host) => host.roles.includes("core"));
  if (!coreHost) {
    throw new Error("The plan has no core host");
  }
  const releaseTimestamp = timestamp();

  if (config.PG_MANAGE_VIA_SSH && shouldRunStorage(options, ["pg", "pg-primary", "pg-replica", "pgbouncer"])) {
    const report = provisionPostgres18({ runner, config, dryRun: options.dryRun });
    log(`  PostgreSQL ${config.PG_VERSION} primary/replicas: ${report.nodes.join(", ") || "none"}`);
    log(`  PgBouncer ${config.PGBOUNCER_ENABLED ? `:${config.PGBOUNCER_PORT}` : "disabled"}`);
  } else if (pgStorageConfigured(config)) {
    log("  PostgreSQL: skipped (--only excludes pg)");
  }
  if (config.REDIS_MANAGE_VIA_SSH && shouldRunStorage(options, ["redis"])) {
    const report = provisionRedis({ runner, config, dryRun: options.dryRun });
    log(`  Redis nodes: ${report.nodes.join(", ") || "none"}`);
  }
  if ((config.AUDIT_DB_MANAGE_VIA_SSH || config.LOG_DB_MANAGE_VIA_SSH) && shouldRunStorage(options, ["audit-db", "log-db"])) {
    const report = provisionAuditAndLogDb({ runner, config, dryRun: options.dryRun });
    log(`  Audit/log databases: ${report.nodes.join(", ") || "none"}`);
  }
  if (config.BACKUP_ENABLED && shouldRunStorage(options, ["backup"])) {
    const report = provisionBackupEngine({ runner, config, dryRun: options.dryRun });
    log(`  Backup engine (${config.BACKUP_ENGINE_MODE}) on: ${report.nodes.join(", ") || "none"}; object store: ${resolveBackupS3Mode(config)}`);
    const backupHost = plan.hosts.find((host) => host.roles.includes("backup"));
    if (backupHost) {
      deployBackupDaemon({ runner, config, host: backupHost });
    } else {
      warn("BACKUP_ENABLED but the plan has no backup host; the daemon was not deployed");
    }
  }

  if (!pgStorageConfigured(config) && (shouldRun(options, "db") || shouldRun(options, "core"))) {
    const dbHost = plan.hosts.find((host) => host.roles.includes("db")) ?? coreHost;
    provisionDatabase({ runner, config, host: dbHost });
    if (!fresh) {
      backupDatabase({ runner, config, host: coreHost, releaseTimestamp });
    }
  } else if (!pgStorageConfigured(config)) {
    log("  skipped (--only excludes db/core)");
  } else if (!fresh && shouldRun(options, "core")) {
    // PostgreSQL storage: dump the primary directly (never through PgBouncer)
    // before the core release runs migrate-deploy.
    backupDatabase({ runner, config, host: coreHost, releaseTimestamp });
  }

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
          runMigrations: target.role === "core" ? unit.service.nodeId === plan.nodes.core[0]?.nodeId : undefined,
          plannedServiceNames: allUnits.map((candidate) => candidate.service.name),
        });
      }
      if (options.dryRun) continue;
      for (const unit of batch) {
        const probe = target.role === "core"
          ? probeCoreService(runner, unit.host, unit.service, config)
          : probeEdgeService(runner, unit.host, unit.service);
        if (!probe.ok) {
          throw new Error(
            `Rolling batch ${batchIndex + 1} failed health check on ${probe.host} ${probe.check}: ${probe.detail}`,
          );
        }
        log(`  PASS ${probe.host} ${probe.check}`);
      }
      if (batchIndex < batches.length - 1) {
        log(`  batch ${batchIndex + 1} healthy; continuing to the next batch`);
      }
    }
  }

  // ---- Step 11: seed the Fake Rails blueprints and synthetic history ------
  step(11, "Seed Fake Rails blueprints and synthetic operational history");
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
      runner.run(coreSeedTarget, `${bun} run seed-fake-rails`, { cwd: coreRemote, sudo: false, timeoutMs: 30 * 60_000 });
      log("  fake rails blueprints seeded in core-back");
    }
    if (config.RUN_SYNTHETIC_HISTORY_SEED) {
      // The STANDARD profile generates/writes ~280k rows and syncs 120k
      // transactions to Fake Rails; on a single box this exceeds the default
      // 15-minute command timeout, so give it a generous ceiling.
      const seeded = runner.run(coreSeedTarget, `${bun} run seed-synthetic-history`, { cwd: coreRemote, sudo: false, timeoutMs: 60 * 60_000 });
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

  // ---- Step 12: end-to-end verification ---------------------------------
  step(12, "End-to-end cross-host mTLS and health verification");
  if (options.skipVerify || options.dryRun) {
    log("  skipped");
  } else {
    const verification = verifyDeployment(runner, plan, config);
    log(renderVerification(verification));
    if (!verification.ok) {
      throw new Error("Deployment verification failed; the previous release is still on disk for a rollback");
    }
  }

  // ---- Step 13: prune ----------------------------------------------------
  step(13, "Prune old releases");
  log(`  kept the last ${options.keepReleases ?? config.KEEP_RELEASES} release(s) per host`);

  // ---- Step 14: audit summary -------------------------------------------
  step(14, "Deployment audit summary");
  let commit = "unknown";
  try {
    commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  } catch {
    // git may be unavailable on the operator machine; the summary is still useful
  }
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
  log("");
  log("Deployment complete.");
};

export { parseArgs, absoluteEnv, renderEnvFile, pm2Ecosystem, frontendRuntimeConfig };

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(`\nDeployment failed: ${(error as Error).message}`);
    process.exit(1);
  });
}
