import { describe, expect, test } from "bun:test";
import {
  buildPostgresPoolConfig,
  isPostgresUrl,
  parsePostgresUrlList,
} from "../lib/db/connectionConfig";

describe("PostgreSQL pool config", () => {
  test("parses a postgres URL into the PrismaPg pool config", () => {
    const config = buildPostgresPoolConfig(
      "postgresql://postgres:secret@127.0.0.1:55432/payment_gateway_monolith_test",
    );
    expect(config.connectionString).toBe(
      "postgresql://postgres:secret@127.0.0.1:55432/payment_gateway_monolith_test",
    );
    expect(config.max).toBe(20);
    expect(config.idleTimeoutMillis).toBeGreaterThan(0);
    expect(config.connectionTimeoutMillis).toBeGreaterThan(0);
    expect(config.application_name).toBe("pg-core-back");
  });

  test("honours a connection limit and an application name", () => {
    const config = buildPostgresPoolConfig(
      "postgres://postgres@localhost:5432/db?connection_limit=5",
      { applicationName: "exhaustive" },
    );
    expect(config.max).toBe(5);
    expect(config.application_name).toBe("exhaustive");
  });

  test("recognises postgres/postgresql URLs only", () => {
    expect(isPostgresUrl("postgresql://a:b@c:5432/d")).toBe(true);
    expect(isPostgresUrl("postgres://a:b@c:5432/d")).toBe(true);
    expect(isPostgresUrl("mysql://a:b@c:3306/d")).toBe(false);
    expect(isPostgresUrl("not a url")).toBe(false);
  });

  test("parses a comma-separated list of PostgreSQL URLs and ignores other dialects", () => {
    expect(
      parsePostgresUrlList(
        "postgresql://a@h1/db1, mysql://a@h2/db2 ,postgres://a@h3/db3,,",
      ),
    ).toEqual(["postgresql://a@h1/db1", "postgres://a@h3/db3"]);
  });
});
