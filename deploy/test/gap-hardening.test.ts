import { describe, expect, test } from "bun:test";
import {
  bootstrapCommands,
  pgHbaSnippet,
  pgTlsCommands,
  pgClusterFor,
  pgbouncerIni,
  postgresMainConfigSnippet,
  provisionPostgres18,
  replicaCommands,
  replicaPgpassContent,
} from "../provisioners/postgres18Provisioner";
import { backupDaemonSystemdUnit, backupDaemonUser } from "../provisioners/backupEngineProvisioner";
import { looksLikeCardPan, loadDeployConfig, panRailGuardProblems } from "../lib/configSchema";
import { readFileSync } from "node:fs";

const SECRET = "ultra-strong-repl-K7p2Zq9w";
const SOURCE = readFileSync(new URL("../deploy.env.example", import.meta.url), "utf8");

const loaded = () => {
  const r = loadDeployConfig(SOURCE);
  if (!r.ok || !r.config) return null;
  return r.config;
};

describe("GAP-022 TLS + hostssl + backup user", () => {
  test("hba has hostssl rules only for TCP", () => {
    const hba = pgHbaSnippet({} as never, ["10.0.0.5", "10.0.0.6"]);
    const tcp = hba.split("\n").filter((l) => /^host/.test(l));
    expect(tcp.length).toBeGreaterThan(0);
    for (const line of tcp) expect(line.startsWith("hostssl")).toBe(true);
    expect(hba).not.toMatch(/^host\s/m);
  });
  test("server config enables ssl, UTC timezone", () => {
    const cluster = pgClusterFor({ PG_VERSION: "18" } as never, "primary", { privateIp: "10.0.0.5", servicePort: 5432 });
    const conf = postgresMainConfigSnippet({ PG_VERSION: "18" }, cluster, "10.0.0.5");
    expect(conf).toContain("ssl = on");
    expect(conf).toContain("ssl_cert_file = ");
    expect(conf).toContain("ssl_key_file = ");
    expect(conf).toContain("timezone = 'UTC'");
    expect(conf).toContain("log_timezone = 'UTC'");
    expect(pgTlsCommands(cluster, "10.0.0.5").join("\n")).toContain("openssl req -x509");
    expect(pgTlsCommands(cluster, "10.0.0.5").join("\n")).toContain("chmod 0600");
  });
  test("pgbouncer requires TLS to server", () => {
    const cfg = loaded();
    if (cfg) expect(pgbouncerIni(cfg)).toContain("server_tls_sslmode = require");
  });
  test("backup daemon account follows the engine: barman keeps pgbackup, wal-g runs as postgres", () => {
    // wal-g backup-push reads PGDATA (0700 postgres) and connects over the socket as postgres (peer auth);
    // a dedicated account cannot do either, so the earlier pgbackup-for-wal-g change broke base backups.
    expect(backupDaemonUser({ BACKUP_ENGINE_MODE: "barman" })).toBe("pgbackup");
    expect(backupDaemonUser({ BACKUP_ENGINE_MODE: "wal-g" })).toBe("postgres");
    const cfg = loaded();
    if (!cfg) return;
    const unit = backupDaemonSystemdUnit(cfg);
    expect(unit).toContain(`User=${backupDaemonUser(cfg)}`);
  });
  test("backup daemon unit has a private writable /tmp so the mTLS front can create its unix socket", () => {
    const cfg = loaded();
    if (!cfg) return;
    const unit = backupDaemonSystemdUnit(cfg);
    // ProtectSystem=strict makes /tmp read-only; the daemon mkdtemp()s there at start-up in mTLS mode.
    expect(unit).toContain("ProtectSystem=strict");
    expect(unit).toContain("PrivateTmp=true");
  });
});

describe("GAP-028 replica pgpass", () => {
  test("password not in any replica command; pgpass content is a stdin file", () => {
    const cfg = { PG_VERSION: "18", PG_REPLICATION_USER: "pg_replicator", PG_REPLICATION_PASSWORD: SECRET } as never;
    const cmds = replicaCommands("10.0.0.5", "10.0.0.6", cfg).join("\n");
    expect(cmds).not.toContain(SECRET);
    expect(cmds).not.toContain("printf '%s\n'");
    expect(replicaPgpassContent("10.0.0.5", cfg)).toBe(`10.0.0.5:5432:*:pg_replicator:${SECRET}\n`);
  });
  test("provisioning writes .pgpass via writeRemoteFile and keeps secret out of runs", () => {
    const cfg = loaded();
    if (!cfg) return;
    const runs: string[] = [];
    const writes: Array<{ path: string; mode?: number }> = [];
    const runner = {
      dryRun: true,
      run: (_t: unknown, c: string) => void runs.push(c),
      capture: () => "",
      writeRemoteFile: (i: { path: string; mode?: number }) => void writes.push(i),
    } as never;
    provisionPostgres18({ runner, config: cfg, dryRun: true });
    expect(writes.some((w) => w.path === "/var/lib/postgresql/.pgpass" && w.mode === 0o600)).toBe(true);
    expect(runs.join("\n")).not.toContain(cfg.PG_REPLICATION_PASSWORD ?? "NONE");
  });
  void bootstrapCommands;
});

describe("GAP-026 PAN-rail guard", () => {
  test("Luhn PAN detection", () => {
    expect(looksLikeCardPan("4111111111111111")).toBe(true);
    expect(looksLikeCardPan("4111 1111 1111 1111")).toBe(true);
    expect(looksLikeCardPan("4111111111111112")).toBe(false);
    expect(looksLikeCardPan("a9f3" + "4111111111111111" + "bc")).toBe(false);
    expect(looksLikeCardPan("1.2.3.4:5432")).toBe(false);
  });
  test("refuses PAN rail keys and PAN-shaped values", () => {
    expect(panRailGuardProblems({ PAN_RAIL_URL: "x" }).length).toBe(1);
    expect(panRailGuardProblems({ CARD_NUMBER: "x" }).length).toBe(1);
    expect(panRailGuardProblems({ NOTE: "4111111111111111" }).length).toBe(1);
    expect(panRailGuardProblems({ DEPLOY_ENV: "staging", PG_PORT: "5432" })).toEqual([]);
    const r = loadDeployConfig(`${SOURCE}\nDEPLOY_NOTE=4111111111111111\n`);
    expect(r.ok).toBe(false);
    expect(r.problems.join(" ")).toContain("PAN_RAIL_GUARD");
  });
});
