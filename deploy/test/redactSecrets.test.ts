import { describe, expect, test } from "bun:test";
import { collectSecretValues, redactSecrets, SshRunner } from "../lib/sshRunner";

describe("redactSecrets", () => {
  test("masks inline credential assignments but keeps the command readable", () => {
    expect(redactSecrets(`PGPASSWORD="abc 123" pg_dump -h 127.0.0.1 -U gw`)).toBe(`PGPASSWORD=<redacted> pg_dump -h 127.0.0.1 -U gw`);
    expect(redactSecrets(`REDISCLI_AUTH='s3cret' redis-cli PING`)).toBe(`REDISCLI_AUTH=<redacted> redis-cli PING`);
    expect(redactSecrets(`KMS_MASTER_KEY=abcdef0123 FOO=bar run`)).toBe(`KMS_MASTER_KEY=<redacted> FOO=bar run`);
    expect(redactSecrets(`export DB_PASSWORD=x; echo ok`)).toBe(`export DB_PASSWORD=<redacted>; echo ok`);
  });

  test("leaves commands without secrets untouched", () => {
    const command = `systemctl restart postgresql@18-main && pg_isready -p 5432`;
    expect(redactSecrets(command)).toBe(command);
  });

  test("the runner logger never emits a secret value", () => {
    const lines: string[] = [];
    const runner = new SshRunner({ dryRun: true, logger: (message) => lines.push(message) });
    runner.run({ host: "10.0.0.5", user: "ops", port: 22, keyPath: "~/.ssh/id_ed25519" } as never, `PGPASSWORD="topsecret" psql -c 'select 1'`, { sudo: false });
    expect(lines.join("\n")).not.toContain("topsecret");
    expect(lines.join("\n")).toContain("PGPASSWORD=<redacted>");
  });
});

describe("literal secret values", () => {
  const target = { host: "127.0.0.1", port: 22, user: "x", keyPath: "/none", sudoPassword: "" };

  test("collectSecretValues picks credential keys by name and skips short values", () => {
    const values = collectSecretValues({
      PG_DB_PASSWORD: "ultra-strong-pg-K7p2Zq9w",
      REDIS_PASSWORD: "short",
      KMS_MASTER_KEY: "kms-master-key-value-1234",
      BACKUP_PRIMARY_S3_SECRET_KEY: "miniosecret-K7p2Zq9w",
      PG_DB_NAME: "payment_gateway_prod",
      DEPLOY_ENV: "development",
    });
    expect(values).toContain("ultra-strong-pg-K7p2Zq9w");
    expect(values).toContain("kms-master-key-value-1234");
    expect(values).toContain("miniosecret-K7p2Zq9w");
    expect(values).not.toContain("short");
    expect(values).not.toContain("payment_gateway_prod");
  });

  test("a pgpass line or URL (no NAME=value form) is masked in logs, timings and errors", () => {
    const logs: string[] = [];
    const runner = new SshRunner({ logger: (message: string) => logs.push(message), verbose: true });
    runner.addSecrets(["ultra-strong-pg-K7p2Zq9w"]);
    runner.run(target, "printf '%s' '127.0.0.1:5432:db:user:ultra-strong-pg-K7p2Zq9w' >/dev/null");
    expect(logs.join("\n")).not.toContain("ultra-strong-pg-K7p2Zq9w");
    expect(runner.timings[0]!.command).not.toContain("ultra-strong-pg-K7p2Zq9w");
    let message = "";
    try {
      runner.run(target, "echo postgresql://u:ultra-strong-pg-K7p2Zq9w@h/db >&2; exit 4");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("exit 4");
    expect(message).not.toContain("ultra-strong-pg-K7p2Zq9w");
    expect(message).toContain("<redacted>");
  });
});
