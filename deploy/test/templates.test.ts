import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { absoluteEnv, parseArgs, pm2Ecosystem, renderEnvFile, renderNginxTemplate } from "../deploy";

const TEMPLATES = join(import.meta.dirname, "..", "templates");
const template = (name: string): string => readFileSync(join(TEMPLATES, name), "utf8");

describe("deploy CLI arguments", () => {
  test("defaults to deploy/deploy.env and no role filter", () => {
    const options = parseArgs([]);
    expect(options.envPath.endsWith("deploy/deploy.env")).toBe(true);
    expect(options.only.size).toBe(0);
    expect(options.dryRun).toBe(false);
  });

  test("parses --only, --dry-run, --fresh, --update and --env", () => {
    const options = parseArgs(["--only=core,checkout", "--dry-run", "--fresh", "--update", "--env=deploy/other.env", "--keep=3"]);
    expect([...options.only].sort()).toEqual(["checkout", "core"]);
    expect(options.dryRun).toBe(true);
    expect(options.fresh).toBe(true);
    expect(options.update).toBe(true);
    expect(options.envPath.endsWith("deploy/other.env")).toBe(true);
    expect(options.keepReleases).toBe(3);
  });

  test("rejects an unknown role and an unknown flag", () => {
    expect(() => parseArgs(["--only=database"])).toThrow(/Unknown --only role/);
    expect(() => parseArgs(["--nope"])).toThrow(/Unknown option/);
  });
});

describe("environment rendering", () => {
  test("quotes every value so a secret with spaces survives", () => {
    const rendered = renderEnvFile({ A: "plain", B: "with space", C: 'quote"inside' });
    expect(rendered).toContain('A="plain"');
    expect(rendered).toContain('B="with space"');
    expect(rendered).toContain('C="quote\\"inside"');
    expect(rendered.endsWith("\n")).toBe(true);
  });

  test("rewrites the relative certificate paths to absolute ones", () => {
    const env = absoluteEnv(
      {
        MTLS_CA_CERT_PATH: "shared/certs/internal-ca.crt",
        MTLS_SERVER_CERT_PATH: "shared/certs/core-back.crt",
        DATABASE_URL: "mysql://user:pass@host/db",
      },
      "/var/www/pg-core",
    );
    expect(env.MTLS_CA_CERT_PATH).toBe("/var/www/pg-core/shared/certs/internal-ca.crt");
    expect(env.MTLS_SERVER_CERT_PATH).toBe("/var/www/pg-core/shared/certs/core-back.crt");
    expect(env.DATABASE_URL).toBe("mysql://user:pass@host/db");
  });
});

describe("pm2 ecosystem", () => {
  test("names the app, pins bun and points at the release directory", () => {
    const source = pm2Ecosystem(
      {
        name: "pg-core-back",
        role: "core",
        sourceDir: "core-back",
        remoteDir: "/var/www/pg-core",
        port: 4000,
        env: {},
      },
      "/var/www/pg-core/releases/20261028000000",
    );
    expect(source).toContain('name: "pg-core-back"');
    expect(source).toContain('interpreter: "/usr/local/bin/bun"');
    expect(source).toContain('cwd: "/var/www/pg-core/releases/20261028000000/core-back"');
    expect(source).toContain("autorestart: true");
    // It must be a valid CommonJS module.
    expect(source).toContain("module.exports = {");
    expect(source.trimEnd().endsWith("};")).toBe(true);
  });
});

describe("nginx templates", () => {
  const render = (name: string, overrides: Partial<Parameters<typeof renderNginxTemplate>[0]> = {}) =>
    renderNginxTemplate({
      template: template(name),
      serverName: "example.ly",
      listenPort: 443,
      sslCertPath: "/etc/ssl/example.ly.crt",
      sslKeyPath: "/etc/ssl/example.ly.key",
      staticRoot: "/var/www/example/current/app/dist",
      backendPort: 4102,
      lanAllowedCidrs: "10.0.0.0/8,192.168.0.0/16",
      ...overrides,
    });

  test("no template leaves a placeholder behind", () => {
    for (const name of ["nginx.admin.lan.conf.tpl", "nginx.merchant.ssl.conf.tpl", "nginx.checkout.ssl.conf.tpl"]) {
      const rendered = render(name);
      expect(rendered).not.toContain("{{");
      expect(rendered).not.toContain("}}");
    }
  });

  test("the admin vhost is LAN-only and terminates TLS 1.3", () => {
    const rendered = render("nginx.admin.lan.conf.tpl", {
      serverName: "admin.internal",
      listenPort: 8443,
      backendPort: 4101,
    });
    expect(rendered).toContain("listen 8443 ssl;");
    expect(rendered).toContain("server_name admin.internal;");
    expect(rendered).toContain("allow 10.0.0.0/8;");
    expect(rendered).toContain("allow 192.168.0.0/16;");
    expect(rendered).toContain("deny all;");
    expect(rendered).toContain("ssl_protocols TLSv1.3;");
    expect(rendered).toContain("proxy_pass http://127.0.0.1:4101;");
    expect(rendered).toContain("X-Real-Client-IP $remote_addr");
  });

  test("the merchant vhost redirects 80 to 443 and unbuffers the POS stream", () => {
    const rendered = render("nginx.merchant.ssl.conf.tpl", {
      serverName: "merchant.example.ly",
      backendPort: 4102,
    });
    expect(rendered).toContain("server_name merchant.example.ly;");
    expect(rendered).toContain("return 308 https://$host$request_uri;");
    expect(rendered).toContain("listen 443 ssl;");
    expect(rendered).toContain("pos/screens/[^/]+/stream");
    expect(rendered).toContain("proxy_buffering off;");
    expect(rendered).toContain("proxy_read_timeout 3600s;");
  });

  test("the checkout vhost unbuffers the payer SSE stream", () => {
    const rendered = render("nginx.checkout.ssl.conf.tpl", {
      serverName: "pay.example.ly",
      backendPort: 4103,
    });
    expect(rendered).toContain("server_name pay.example.ly;");
    expect(rendered).toContain("logs/[^/]+/status");
    expect(rendered).toContain("proxy_buffering off;");
    expect(rendered).toContain("Content-Security-Policy");
    expect(rendered).toContain("proxy_pass http://127.0.0.1:4103;");
  });
});
