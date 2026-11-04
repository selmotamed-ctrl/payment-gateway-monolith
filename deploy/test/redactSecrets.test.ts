import { describe, expect, test } from "bun:test";
import { redactSecrets, SshRunner } from "../lib/sshRunner";

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
