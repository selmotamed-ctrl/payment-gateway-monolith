#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadDeployConfig, type DeployConfig } from "./lib/configSchema";
import { findSshConflicts, planHosts, renderTopology, type DeployPlan, type HostPlan, type ServicePlan } from "./lib/hostPlanner";
import { buildPki, certFilesForHost, readMaterial, verifyPki } from "./lib/pkiManager";
import { SshRunner } from "./lib/sshRunner";
import { applyFirewall, readFirewallStatus } from "./lib/firewallConfigurator";
import { renderVerification, verifyDeployment } from "./lib/healthVerifier";

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
  only: Set<"db" | "core" | "admin" | "merchant" | "checkout">;
  dryRun: boolean;
  fresh: boolean;
  update: boolean;
  enforceFirewall: boolean;
  skipBuild: boolean;
  skipVerify: boolean;
  rotateCerts: boolean;
  keepReleases?: number;
}

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
        if (!["db", "core", "admin", "merchant", "checkout"].includes(normalized)) {
          throw new Error(`Unknown --only role '${role}'`);
        }
        options.only.add(normalized as never);
      }
    } else if (raw.startsWith("--keep=")) options.keepReleases = Number(raw.slice(7));
    else if (raw.startsWith("--")) throw new Error(`Unknown option '${raw}'`);
  }
  return options;
};

const log = (message = ""): void => console.log(message);
const step = (index: number, title: string): void => {
  log();
  log(`\u001b[1m[${index}/12] ${title}\u001b[0m`);
};
const warn = (message: string): void => console.warn(`  ! ${message}`);

const timestamp = (): string => new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);

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

const FRONTENDS: Record<"admin" | "merchant" | "checkout", string> = {
  admin: "admin-front",
  merchant: "merchant-front",
  checkout: "checkout-front",
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
}): string => {
  const lanRules = input.lanAllowedCidrs.split(",")
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
  return withConditionals
    .replaceAll("{{LAN_ALLOW_RULES}}", `${lanRules}\n    deny all;`)
    .replaceAll("{{SERVER_NAME}}", input.serverName)
    .replaceAll("{{LISTEN_PORT}}", String(input.listenPort))
    .replaceAll("{{HTTP_PORT}}", String(input.httpPort))
    .replaceAll("{{HTTPS_PORT}}", String(input.httpsPort))
    .replaceAll("{{SSL_CERT_PATH}}", input.sslCertPath)
    .replaceAll("{{SSL_KEY_PATH}}", input.sslKeyPath)
    .replaceAll("{{STATIC_ROOT}}", input.staticRoot)
    .replaceAll("{{BACKEND_PORT}}", String(input.backendPort))
    .replaceAll("{{LAN_ALLOWED_CIDRS}}", input.lanAllowedCidrs);
};

const renderNginx = (host: HostPlan, config: DeployConfig, runner: SshRunner): void => {
  for (const site of host.nginx) {
    const template = readFileSync(nginxTemplatePath(site.template), "utf8");
    // The admin vhost is LAN-only and usually has no operator certificate; it
    // still needs a TLS pair so `nginx -t` accepts the server block, so we mint
    // a self-signed certificate bound to its server name when none is given.
    const tls = !site.ssl
      ? { certPath: "", keyPath: "" }
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
      backendPort: site.role === "admin" ? config.ADMIN_BACK_PORT : site.role === "merchant" ? config.MERCHANT_BACK_PORT : config.CHECKOUT_BACK_PORT,
      lanAllowedCidrs: config.LAN_ALLOWED_CIDRS,
    });
    const available = `/etc/nginx/sites-available/pg-${site.site}.conf`;
    runner.writeRemoteFile({ target: host.ssh, path: available, content: rendered, mode: 0o644, sudo: true });
    runner.run(host.ssh, `ln -sfn ${available} /etc/nginx/sites-enabled/pg-${site.site}.conf && rm -f /etc/nginx/sites-enabled/default`, { sudo: true });
    runner.run(host.ssh, "nginx -t", { sudo: true });
    runner.run(host.ssh, "systemctl reload nginx", { sudo: true });
    log(`  nginx ${site.site} -> ${site.serverName}:${site.listenPort} (${site.ssl ? "https" : "http"})`);
  }
};

const deployService = (input: {
  runner: SshRunner;
  host: HostPlan;
  service: ServicePlan;
  config: DeployConfig;
  pki: ReturnType<typeof buildPki>;
  releaseTimestamp: string;
  keepReleases: number;
}): string => {
  const { runner, host, service, config, pki, releaseTimestamp } = input;
  const remote = service.remoteDir;
  const releaseDir = `${remote}/releases/${releaseTimestamp}`;
  const frontend = service.role === "core" || service.role === "db" ? null : FRONTENDS[service.role];
  const appDir = `${releaseDir}/${service.sourceDir}`;
  const owner = `${host.ssh.user}:${host.ssh.user}`;

  // The tree lives under /var/www, so creating it needs sudo; everything the
  // application reads afterwards (keys, .env, PM2 files, the release tree) is
  // owned by the SSH user so PM2 — never root — can read it.
  runner.run(host.ssh, "mkdir -p " + [releaseDir, `${remote}/shared/certs`, `${remote}/shared/backups`, `${remote}/shared/pm2`].join(" ") + ` && chown -R ${owner} ${remote}`, { sudo: true });

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
  runner.writeRemoteFile({ target: host.ssh, path: `${remote}/shared/.env`, content: renderEnvFile(env), mode: 0o600, sudo: false });
  runner.run(host.ssh, `ln -sfn ${remote}/shared/.env ${appDir}/.env`, { sudo: false });

  // 5. Dependencies and, for the core, the schema.
  const bun = 'PATH="$HOME/.bun/bin:/usr/local/bin:$PATH" bun';
  runner.run(host.ssh, `${bun} install --frozen-lockfile`, { cwd: appDir, sudo: false });
  if (service.role === "core") {
    runner.run(host.ssh, `${bun}x prisma generate`, { cwd: appDir, sudo: false });
    runner.run(host.ssh, `${bun} run migrate-deploy`, { cwd: appDir, sudo: false });
    if (config.RUN_PRISMA_SEED) {
      runner.run(host.ssh, `${bun} run db-seed`, { cwd: appDir, sudo: false });
    }
  }

  // 6. Atomic symlink switch.
  runner.run(host.ssh, `ln -sfn ${releaseDir} ${remote}/current`, { sudo: false });

  // 7. PM2.
  const ecosystem = `${remote}/shared/pm2/${service.name}.config.cjs`;
  runner.writeRemoteFile({ target: host.ssh, path: ecosystem, content: pm2Ecosystem(service, releaseDir), mode: 0o644, sudo: false });
  runner.run(
    host.ssh,
    `"$HOME/.bun/bin/pm2" delete ${service.name} >/dev/null 2>&1 || true; "$HOME/.bun/bin/pm2" start ${ecosystem} --update-env && "$HOME/.bun/bin/pm2" save`,
    { sudo: false },
  );

  // 8. Nginx (only the hosts that own a site).
  renderNginx(host, config, runner);

  // 9. Prune.
  runner.run(
    host.ssh,
    `ls -1dt ${remote}/releases/*/ 2>/dev/null | tail -n +${input.keepReleases + 1} | xargs -r rm -rf`,
    { sudo: false },
  );

  log(`  ${service.name} -> ${releaseDir}`);
  return releaseDir;
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
  // quoted on the command line: it contains backticks and quotes.
  const createSql = config.DB_ENGINE === "mysql"
    ? [
        `CREATE DATABASE IF NOT EXISTS \`${config.DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`,
        `CREATE USER IF NOT EXISTS '${config.DB_USER}'@'${config.CORE_PRIVATE_IP}' IDENTIFIED BY '${config.DB_PASSWORD}';`,
        `CREATE USER IF NOT EXISTS '${config.DB_USER}'@'127.0.0.1' IDENTIFIED BY '${config.DB_PASSWORD}';`,
        `CREATE USER IF NOT EXISTS '${config.DB_USER}'@'%' IDENTIFIED BY '${config.DB_PASSWORD}';`,
        `GRANT ALL PRIVILEGES ON \`${config.DB_NAME}\`.* TO '${config.DB_USER}'@'${config.CORE_PRIVATE_IP}';`,
        `GRANT ALL PRIVILEGES ON \`${config.DB_NAME}\`.* TO '${config.DB_USER}'@'127.0.0.1';`,
        `GRANT ALL PRIVILEGES ON \`${config.DB_NAME}\`.* TO '${config.DB_USER}'@'%';`,
        "FLUSH PRIVILEGES;",
      ].join("\n")
    : [
        `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${config.DB_USER}') THEN CREATE ROLE "${config.DB_USER}" LOGIN PASSWORD '${config.DB_PASSWORD}'; END IF; END $$;`,
        `SELECT 'CREATE DATABASE "${config.DB_NAME}" OWNER "${config.DB_USER}"' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${config.DB_NAME}')\\gexec`,
      ].join("\n");

  const sqlPath = `/tmp/pg-db-init-${timestamp()}.sql`;
  runner.writeRemoteFile({ target: host.ssh, path: sqlPath, content: `${createSql}\n`, mode: 0o600 });
  try {
    if (config.DB_ENGINE === "mysql") {
      runner.run(host.ssh, `mysql --protocol=socket < ${sqlPath}`, { sudo: true });
    } else {
      runner.run(host.ssh, `psql -f ${sqlPath}`, { sudo: true, sudoUser: "postgres" });
    }
  } finally {
    runner.run(host.ssh, `rm -f ${sqlPath}`);
  }

  // The schema enforces maker≠checker with a BEFORE INSERT trigger. MySQL
  // requires SUPER to create a trigger while the binary log is on unless
  // log_bin_trust_function_creators is set; the application user must not have
  // SUPER, so raise the flag here (and persist it for the next restart).
  if (config.DB_ENGINE === "mysql") {
    runner.run(host.ssh, `mysql --protocol=socket -e "SET GLOBAL log_bin_trust_function_creators = 1"`, { sudo: true });
    runner.writeRemoteFile({
      target: host.ssh,
      path: "/etc/mysql/conf.d/zz-payment-gateway.cnf",
      content: "[mysqld]\nlog_bin_trust_function_creators = 1\n",
      mode: 0o644,
      sudo: true,
    });
    log("  log_bin_trust_function_creators=1 (required for the maker≠checker trigger)");
  }
  log(`  database ${config.DB_NAME} and user ${config.DB_USER} ready on ${config.DB_PRIVATE_IP ?? host.ssh.host}`);
};

const backupDatabase = (input: { runner: SshRunner; config: DeployConfig; host: HostPlan; releaseTimestamp: string }): void => {
  const { runner, config, host, releaseTimestamp } = input;
  const databaseHost = config.DB_PRIVATE_IP ?? config.DB_SSH_HOST ?? "";
  const target = `${config.CORE_REMOTE_DIR}/shared/backups/pre-migrate-${releaseTimestamp}`;
  const command = config.DB_ENGINE === "mysql"
    ? `MYSQL_PWD=${JSON.stringify(config.DB_PASSWORD)} mysqldump -h ${databaseHost} -P ${config.DB_PORT} -u ${config.DB_USER} --single-transaction --routines --events ${config.DB_NAME} | gzip > ${target}.sql.gz`
    : `PGPASSWORD=${JSON.stringify(config.DB_PASSWORD)} pg_dump -h ${databaseHost} -p ${config.DB_PORT} -U ${config.DB_USER} -Fc ${config.DB_NAME} > ${target}.dump`;
  runner.run(host.ssh, `mkdir -p ${config.CORE_REMOTE_DIR}/shared/backups && ${command}`, { sudo: false });
  log(`  pre-migration backup -> ${target}`);
};

const buildFrontends = async (runner: SshRunner): Promise<void> => {
  for (const frontend of Object.values(FRONTENDS)) {
    await runner.localStreaming("bun run build", join(REPO_ROOT, frontend));
    log(`  built ${frontend}/dist`);
  }
};

const shouldRun = (options: CliOptions, role: "db" | "core" | "admin" | "merchant" | "checkout"): boolean =>
  options.only.size === 0 || options.only.has(role);

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
  step(2, "Build the three frontend SPAs");
  if (options.skipBuild || options.dryRun) {
    log(`  skipped (${options.dryRun ? "--dry-run" : "--skip-build"})`);
  } else {
    await buildFrontends(runner);
  }

  // ---- Step 3: PKI -------------------------------------------------------
  step(3, "Ensure the mTLS PKI");
  const pki = buildPki({ config, rotate: options.rotateCerts, dryRun: options.dryRun });
  if (options.dryRun) {
    log(`  would ensure: ${[pki.ca, pki.server, ...pki.clients].map((material) => material.name).join(", ")}`);
    log(`  core SAN: ${(pki.server.sans ?? []).join(",")}`);
  } else {
    for (const certificate of verifyPki(pki)) {
      log(`  ${certificate.name}: valid ${certificate.expiresInDays} day(s)${certificate.sans.length > 0 ? ` SAN=${certificate.sans.join(",")}` : ""}`);
    }
  }

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
        runner.run(
          host.ssh,
          "apt-get update -y && DEBIAN_FRONTEND=noninteractive apt-get install -y nginx rsync ufw curl ca-certificates nodejs",
          { sudo: true },
        );
        runner.run(host.ssh, "command -v bun >/dev/null 2>&1 || curl -fsSL https://bun.sh/install | bash", { sudo: false });
        // PM2 is a Node program and its shebang is `node`; expose Bun on a
        // stable absolute path so the PM2 interpreter setting always resolves.
        runner.run(host.ssh, `ln -sfn /home/${host.ssh.user}/.bun/bin/bun /usr/local/bin/bun`, { sudo: true });
        runner.run(host.ssh, 'test -x "$HOME/.bun/bin/pm2" || PATH="$HOME/.bun/bin:/usr/local/bin:$PATH" bun add -g pm2', { sudo: false });
        runner.run(host.ssh, `ln -sfn /home/${host.ssh.user}/.bun/bin/bunx /usr/local/bin/bunx`, { sudo: true });
        // Best effort: re-register the PM2 process list on boot.
        const pm2Path = `/home/${host.ssh.user}/.bun/bin:/usr/local/bin:/usr/bin:/bin`;
        runner.run(
          host.ssh,
          `env PATH=${pm2Path} pm2 startup systemd -u ${host.ssh.user} --hp /home/${host.ssh.user} >/dev/null 2>&1 || true`,
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

  // ---- Step 5: database provisioning and backup -------------------------
  step(5, "Provision the database and take a pre-migration backup");
  const coreHost = plan.hosts.find((host) => host.roles.includes("core"));
  if (!coreHost) {
    throw new Error("The plan has no core host");
  }
  const releaseTimestamp = timestamp();
  const dbHost = plan.hosts.find((host) => host.roles.includes("db")) ?? coreHost;
  if (shouldRun(options, "db") || shouldRun(options, "core")) {
    provisionDatabase({ runner, config, host: dbHost });
    if (!fresh) {
      backupDatabase({ runner, config, host: coreHost, releaseTimestamp });
    }
  } else {
    log("  skipped (--only excludes db/core)");
  }

  // ---- Steps 6-9: deploy the services in dependency order ---------------
  const deployTargets: Array<{ index: number; role: "core" | "admin" | "merchant" | "checkout"; title: string }> = [
    { index: 6, role: "core", title: "Deploy core-back to CORE_HOST" },
    { index: 7, role: "admin", title: "Deploy admin-back + admin-front to ADMIN_HOST" },
    { index: 8, role: "merchant", title: "Deploy merchant-back + merchant-front to MERCHANT_HOST" },
    { index: 9, role: "checkout", title: "Deploy checkout-back + checkout-front to CHECKOUT_HOST" },
  ];
  for (const target of deployTargets) {
    step(target.index, target.title);
    if (!shouldRun(options, target.role)) {
      log(`  skipped (--only excludes ${target.role})`);
      continue;
    }
    const host = plan.hosts.find((candidate) => candidate.roles.includes(target.role));
    if (!host) {
      throw new Error(`The plan has no ${target.role} host`);
    }
    for (const service of host.services.filter((candidate) => candidate.role === target.role)) {
      deployService({
        runner,
        host,
        service,
        config,
        pki,
        releaseTimestamp,
        keepReleases: options.keepReleases ?? config.KEEP_RELEASES,
      });
    }
  }

  // ---- Step 10: end-to-end verification ---------------------------------
  step(10, "End-to-end cross-host mTLS and health verification");
  if (options.skipVerify || options.dryRun) {
    log("  skipped");
  } else {
    const verification = verifyDeployment(runner, plan, config);
    log(renderVerification(verification));
    if (!verification.ok) {
      throw new Error("Deployment verification failed; the previous release is still on disk for a rollback");
    }
  }

  // ---- Step 11: prune ----------------------------------------------------
  step(11, "Prune old releases");
  log(`  kept the last ${options.keepReleases ?? config.KEEP_RELEASES} release(s) per host`);

  // ---- Step 12: audit summary -------------------------------------------
  step(12, "Deployment audit summary");
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

export { parseArgs, absoluteEnv, renderEnvFile, pm2Ecosystem };

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(`\nDeployment failed: ${(error as Error).message}`);
    process.exit(1);
  });
}
