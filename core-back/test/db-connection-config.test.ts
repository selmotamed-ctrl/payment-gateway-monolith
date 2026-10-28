import { describe, expect, test } from "bun:test";
import { buildMariaDbPoolConfig, isMysqlUrl } from "../lib/db/connectionConfig";

describe("MariaDB pool config", () => {
  test("parses a mysql URL and enables public key retrieval", () => {
    const config = buildMariaDbPoolConfig("mysql://cn_user:p%40ss@192.168.1.222:3306/payment_gateway_prod");
    expect(config).toMatchObject({
      host: "192.168.1.222",
      port: 3306,
      user: "cn_user",
      password: "p@ss",
      database: "payment_gateway_prod",
      allowPublicKeyRetrieval: true,
    });
  });

  test("defaults the port and honours a connection limit", () => {
    const config = buildMariaDbPoolConfig("mariadb://admin:admin@localhost/db?connectionLimit=5");
    expect(config.port).toBe(3306);
    expect(config.connectionLimit).toBe(5);
    expect(config.allowPublicKeyRetrieval).toBe(true);
  });

  test("recognises mysql/mariadb URLs only", () => {
    expect(isMysqlUrl("mysql://a:b@c:3306/d")).toBe(true);
    expect(isMysqlUrl("mariadb://a:b@c:3306/d")).toBe(true);
    expect(isMysqlUrl("postgresql://a:b@c:5432/d")).toBe(false);
    expect(isMysqlUrl("not a url")).toBe(false);
  });

  test("rejects a URL without a database", () => {
    expect(() => buildMariaDbPoolConfig("mysql://a:b@c:3306/")).toThrow(/database name/);
  });
});
