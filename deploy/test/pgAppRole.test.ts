import { describe, expect, test } from "bun:test";
import {
  applicationCredentials,
  effectiveDatabase,
  leaderElectionDatabaseUrl,
  loadDeployConfig,
  pgAppRoleEnabled,
  type DeployConfig,
} from "../lib/configSchema";
import { planHosts, type HostPlan } from "../lib/hostPlanner";
import { runAsDatabaseOwner } from "../deploy";
import type { SshRunner } from "../lib/sshRunner";
import {
  PGBOUNCER_TLS_CERT,
  PGBOUNCER_TLS_KEY,
  pgbouncerIni,
  pgbouncerTlsCommand,
  pgbouncerUserlist,
  primaryBootstrapSql,
} from "../provisioners/postgres18Provisioner";

/**
 * The application must not run as the database OWNER: the append-only ledger triggers cannot stop an owner from
 * dropping them. These tests pin the split (set `PG_APP_PASSWORD`) and the secrets that must stay out of the
 * runtime environment. The behaviour was also verified against a real PostgreSQL 18 + PgBouncer.
 */
const OWNER_PW = "owner-strong-pw-K7p2Zq9w";
const APP_PW = "app-strong-pw-K7p2Zq9wXy";

const BASE = `
DB_MANAGE_VIA_SSH="false"
DB_NAME="gateway"
DB_USER="gw"
DB_PASSWORD="ultra-strong-db-K7p2Zq9w"
DATABASE_URL="postgresql://gw:ultra-strong-db-K7p2Zq9w@10.10.10.10:5432/gateway"
DB_ENGINE="postgresql"
CORE_NODES="core-1@10.10.1.11:22:10.10.1.11:4000"
CORE_SSH_KEY_PATH="~/.ssh/core"
ADMIN_NODES="admin-1@10.10.2.11:22:10.10.2.11:4101"
ADMIN_SSH_KEY_PATH="~/.ssh/admin"
MERCHANT_NODES="merch-1@10.10.3.11:22:10.10.3.11:4102"
MERCHANT_SSH_KEY_PATH="~/.ssh/merchant"
MERCHANT_DOMAIN="merchant.example.ly"
CHECKOUT_NODES="chk-1@10.10.4.11:22:10.10.4.11:4103"
CHECKOUT_SSH_KEY_PATH="~/.ssh/checkout"
CHECKOUT_DOMAIN="pay.example.ly"
KMS_MASTER_KEY="kms-Q7x9Lm2Zr4Vb8Nc1Wd5Tg3Hy6Jp0Sa2"
PG_MANAGE_VIA_SSH="true"
PG_PRIMARY_NODE="pg-pri@10.10.10.10:22:10.10.10.10:5432"
PG_REPLICA_NODES="pg-rep-1@10.10.10.11:22:10.10.10.11:5432"
PG_SSH_KEY_PATH="~/.ssh/pg"
PG_DB_USER="gw_core_user"
PG_DB_PASSWORD="${OWNER_PW}"
PG_REPLICATION_PASSWORD="ultra-strong-repl-K7p2Zq9w"
PGBOUNCER_ENABLED="true"
`;

const load = (extra = ""): DeployConfig => {
  const result = loadDeployConfig(`${BASE}\n${extra}`);
  if (!result.ok || !result.config) throw new Error(result.problems.join("; "));
  return result.config;
};
const split = (): DeployConfig => load(`PG_APP_USER="pgw_app_login"\nPG_APP_PASSWORD="${APP_PW}"`);

const coreEnv = (config: DeployConfig): Record<string, string> => {
  const plan = planHosts(config);
  return plan.hosts.flatMap((host) => host.services).find((service) => service.role === "core")!.env;
};

describe("the application role is opt-in and distinct from the owner", () => {
  test("without PG_APP_PASSWORD the runtime stays the legacy owner, while migrations use the session endpoint", () => {
    const config = load();
    expect(pgAppRoleEnabled(config)).toBe(false);
    expect(applicationCredentials(config)).toEqual({ user: "gw_core_user", password: OWNER_PW });
    const database = effectiveDatabase(config);
    // The service keeps the transaction-pooled application database (legacy single role).
    expect(database.url).toContain("gw_core_user:");
    expect(database.url).toContain("/payment_gateway_prod?");
    expect(coreEnv(config).DATABASE_URL).toContain("gw_core_user");
    expect(coreEnv(config).DATABASE_URL).toContain("/payment_gateway_prod?");
    // Migrations never take the lock through the transaction pool.
    expect(database.ownerUrl).toContain("/pgw_session?");
  });

  test("legacy without PgBouncer has no separate owner URL", () => {
    const database = effectiveDatabase(load('PGBOUNCER_ENABLED="false"'));
    expect(database.ownerUrl).toBe(database.url);
  });

  test("with PG_APP_PASSWORD the runtime connects as the app role everywhere it connects", () => {
    const config = split();
    expect(pgAppRoleEnabled(config)).toBe(true);
    const env = coreEnv(config);
    for (const url of [env.DATABASE_URL, env.LEADER_ELECTION_DATABASE_URL, env.DATABASE_REPLICA_URLS]) {
      expect(url).toContain("pgw_app_login:");
      expect(url).not.toContain("gw_core_user");
    }
    expect(env.PG_DB_USER).toBe("pgw_app_login");
    expect(env.PG_DB_PASSWORD).toBe(APP_PW);
  });

  test("the owner's password never reaches the runtime environment of any service", () => {
    const plan = planHosts(split());
    for (const service of plan.hosts.flatMap((host) => host.services)) {
      for (const [key, value] of Object.entries(service.env)) {
        expect([service.role, key, value.includes(OWNER_PW)]).toEqual([service.role, key, false]);
        expect([service.role, key, value.includes("gw_core_user")]).toEqual([service.role, key, false]);
      }
    }
  });

  test("the owner URL (migrations, seeders) is derived separately and requests TLS", () => {
    const database = effectiveDatabase(split());
    expect(database.ownerUrl).toContain(`gw_core_user:${OWNER_PW}@`);
    expect(database.ownerUrl).toMatch(/\?sslmode=no-verify$/);
    // Prisma Migrate's session advisory lock must not run on the transaction pool.
    expect(database.ownerUrl).toContain("/pgw_session?");
    expect(database.url).toContain("pgw_app_login:");
    expect(database.url).toMatch(/\?sslmode=no-verify$/);
    expect(leaderElectionDatabaseUrl(split())).toContain("pgw_app_login:");

    const direct = effectiveDatabase({ ...split(), PGBOUNCER_ENABLED: false } as DeployConfig);
    expect(direct.ownerUrl).toContain(":5432/payment_gateway_prod");
    expect(direct.ownerUrl).not.toContain("pgw_session");

    // An externally managed pooler still needs the same session route the core leader election uses. Without an
    // explicit override the deploy derives the documented pgw_session alias rather than guessing a different route.
    const externalPooler = effectiveDatabase({ ...split(), PG_MANAGE_VIA_SSH: false } as DeployConfig);
    expect(externalPooler.ownerUrl).toContain(":6432/pgw_session");
    expect(externalPooler.ownerUrl).not.toContain("sslmode");
  });

  test("an explicit leader URL is reused for migrations with the owner's credentials", () => {
    const config = load('LEADER_ELECTION_DATABASE_URL="postgresql://leader:leader-pw@db.example:6432/session_db?sslmode=require"');
    const database = effectiveDatabase(config);
    expect(database.ownerUrl).toBe(
      `postgresql://gw_core_user:${OWNER_PW}@db.example:6432/session_db?sslmode=require`,
    );
    expect(database.ownerUrl).not.toContain("leader-pw");
    expect(leaderElectionDatabaseUrl(config)).toBe(
      "postgresql://leader:leader-pw@db.example:6432/session_db?sslmode=require",
    );
  });

  test("an explicit leader URL without a path falls back to the configured database name", () => {
    const config = load('LEADER_ELECTION_DATABASE_URL="postgresql://leader@db.example:6432"');
    const database = effectiveDatabase(config);
    expect(database.ownerUrl).toContain("/payment_gateway_prod");
    expect(database.ownerUrl).toContain("sslmode=no-verify");
    expect(database.ownerUrl).not.toContain("leader@");
  });

  test("a leader URL that is the transaction-pooled runtime endpoint is refused", () => {
    const result = loadDeployConfig(
      `${BASE}\nLEADER_ELECTION_DATABASE_URL="postgresql://leader@10.10.10.10:6432/payment_gateway_prod"`,
    );
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toContain("transaction-pooled DATABASE_URL");
  });

  test("invalid combinations are refused", () => {
    const reject = (extra: string) => {
      const result = loadDeployConfig(`${BASE}\n${extra}`);
      expect(result.ok).toBe(false);
      return result.problems.join(" | ");
    };
    expect(reject(`PG_APP_PASSWORD="${APP_PW}"\nPG_APP_USER="gw_core_user"`)).toContain("must differ from PG_DB_USER");
    expect(reject(`PG_APP_PASSWORD="${OWNER_PW}"`)).toContain("must differ from PG_DB_PASSWORD");
    expect(reject(`PG_APP_PASSWORD="short-pw-12"`)).toContain("at least 12 characters");
    expect(reject(`PG_APP_PASSWORD="${APP_PW}"\nPG_APP_USER="gw_replicator"`)).toContain("must differ from PG_REPLICATION_USER");
    expect(reject(`PG_APP_PASSWORD="change-me-please-now-123"`)).toMatch(/placeholder|change-me/i);
    expect(reject(`PG_APP_USER="postgres"\nPG_APP_PASSWORD="${APP_PW}"`)).toContain("already a privileged or group role");
    expect(reject(`PG_APP_USER="pgw_app"\nPG_APP_PASSWORD="${APP_PW}"`)).toContain("already a privileged or group role");
    expect(reject(`PG_APP_USER="pg_signal"\nPG_APP_PASSWORD="${APP_PW}"`)).toMatch(/pg_/);
  });
});

describe("bootstrap SQL and PgBouncer follow the split", () => {
  test("the app role is a LOGIN member of pgw_app with no powers of its own", () => {
    const sql = primaryBootstrapSql(split(), []);
    expect(sql).toContain("CREATE ROLE pgw_app NOLOGIN");
    expect(sql).toMatch(/CREATE ROLE "?pgw_app_login"? LOGIN PASSWORD '[^']+' NOSUPERUSER NOCREATEDB NOCREATEROLE/);
    expect(sql).toMatch(/ALTER ROLE "?pgw_app_login"? PASSWORD '[^']+' NOSUPERUSER NOCREATEDB NOCREATEROLE/);
    expect(sql).toMatch(/GRANT pgw_app TO "?pgw_app_login"?;/);
    // The owner role and the database owner are unchanged.
    expect(sql).toContain("CREATE DATABASE");
    expect(sql).toMatch(/OWNER "?gw_core_user"?/);
  });

  test("without the split no extra role is created", () => {
    const sql = primaryBootstrapSql(load(), []);
    expect(sql).not.toContain("pgw_app");
  });

  test("PgBouncer no longer forces the owner for every session and carries no credentials", () => {
    const ini = pgbouncerIni(split());
    expect(ini).not.toMatch(/user=|password/);
    expect(ini).not.toContain(OWNER_PW);
    expect(ini).not.toContain(APP_PW);
    expect(ini).toMatch(/^pgw_session = host=127\.0\.0\.1 port=5432 dbname='[^']+' pool_mode=session/m);
  });

  test("PgBouncer requires TLS from its clients with the certificate the provisioner installs", () => {
    const ini = pgbouncerIni(split());
    expect(ini).toContain("client_tls_sslmode = require");
    expect(ini).toContain(`client_tls_key_file = ${PGBOUNCER_TLS_KEY}`);
    expect(ini).toContain(`client_tls_cert_file = ${PGBOUNCER_TLS_CERT}`);
    const command = pgbouncerTlsCommand("10.10.10.10");
    // Created only when missing (a re-deploy does not rotate it), private key 0600, owned by the PgBouncer account.
    expect(command).toContain("if [ ! -s");
    expect(command).toContain(`chmod 0600 ${PGBOUNCER_TLS_KEY}`);
    expect(command).toContain('chown "$pgbouncer_owner:"');
    expect(command).toContain("-subj '/CN=10.10.10.10'");
    expect(pgbouncerTlsCommand("evil'; rm -rf /; echo '")).not.toContain("rm -rf");
  });

  test("the auth file lists the owner, the app role (only when enabled) and the replication user", () => {
    const names = (config: DeployConfig) => pgbouncerUserlist(config).split("\n").filter(Boolean).map((line) => line.split(" ")[0]);
    expect(names(load())).toEqual(['"gw_core_user"', '"gw_replicator"']);
    expect(names(split())).toEqual(['"gw_core_user"', '"pgw_app_login"', '"gw_replicator"']);
  });
});

describe("migrations and seeders get the owner only through a temporary file", () => {
  interface Call { kind: "write" | "run"; path?: string; content?: string; mode?: number; command?: string }
  const fakeRunner = (fail = false) => {
    const calls: Call[] = [];
    const runner = {
      dryRun: false,
      writeRemoteFile: (input: { path: string; content: string | Buffer; mode?: number }) => {
        calls.push({ kind: "write", path: input.path, content: input.content.toString(), mode: input.mode });
        return true;
      },
      run: (_target: unknown, command: string) => {
        calls.push({ kind: "run", command });
        if (fail && command.includes("migrate-deploy")) throw new Error("migration failed");
        return { stdout: "" };
      },
    };
    return { runner: runner as unknown as SshRunner, calls };
  };
  const host = { ssh: { host: "10.10.1.11", port: 22, user: "deploy", keyPath: "" } } as unknown as HostPlan;
  const bun = "bun";

  test("with the split: a 0600 file with the owner URL, used via --env-file, removed afterwards", () => {
    const { runner, calls } = fakeRunner();
    runAsDatabaseOwner(runner, host, "/srv/core/releases/1/core-back", split(), (flag) => () =>
      (runner as unknown as { run: (t: unknown, c: string) => unknown }).run(host.ssh, `${bun} ${flag} run migrate-deploy`));
    expect(calls.map((call) => call.kind)).toEqual(["write", "run", "run"]);
    expect(calls[0]).toMatchObject({ path: "/srv/core/releases/1/core-back/.env.owner", mode: 0o600 });
    expect(calls[0]!.content).toContain(`DATABASE_URL="postgresql://gw_core_user:${OWNER_PW}@`);
    expect(calls[0]!.content).toContain('WORKER_ENABLED="false"');
    expect(calls[1]!.command).toBe("bun --env-file=.env.owner run migrate-deploy");
    expect(calls[2]!.command).toContain("rm -f '/srv/core/releases/1/core-back/.env.owner'");
  });

  test("the file is removed even when the command fails", () => {
    const { runner, calls } = fakeRunner(true);
    expect(() =>
      runAsDatabaseOwner(runner, host, "/srv/app", split(), (flag) => () => runner.run(host.ssh, `${bun} ${flag} run migrate-deploy`)),
    ).toThrow("migration failed");
    expect(calls.at(-1)!.command).toContain("rm -f '/srv/app/.env.owner'");
  });

  test("legacy + PgBouncer writes the session endpoint, then removes it", () => {
    const { runner, calls } = fakeRunner();
    runAsDatabaseOwner(runner, host, "/srv/app", load(), (flag) => () =>
      (runner as unknown as { run: (t: unknown, c: string) => unknown }).run(host.ssh, `${bun} ${flag} run migrate-deploy`));
    expect(calls.map((call) => call.kind)).toEqual(["write", "run", "run"]);
    expect(calls[0]!.content).toContain("/pgw_session");
    expect(calls[0]!.content).toContain('WORKER_ENABLED="false"');
    expect(calls[1]!.command).toBe("bun --env-file=.env.owner run migrate-deploy");
    expect(calls[2]!.command).toContain("rm -f '/srv/app/.env.owner'");
  });

  test("legacy without PgBouncer runs the command unchanged", () => {
    const { runner, calls } = fakeRunner();
    runAsDatabaseOwner(runner, host, "/srv/app", load('PGBOUNCER_ENABLED="false"'), (flag) => () =>
      runner.run(host.ssh, `${bun} ${flag} run migrate-deploy`.replace("  ", " ")));
    expect(calls).toEqual([{ kind: "run", command: "bun run migrate-deploy" }]);
  });
});
