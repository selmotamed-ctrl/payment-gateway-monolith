import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderNginxTemplate } from "../deploy";
import { withIpv6Loopback } from "../lib/configSchema";

const LAN = "127.0.0.1/32,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16";

describe("IPv6 loopback in LAN allowlists", () => {
  test("adds ::1/128 exactly when IPv4 loopback is allowed", () => {
    expect(withIpv6Loopback(LAN)).toBe(`${LAN},::1/128`);
    expect(withIpv6Loopback(`${LAN},::1/128`)).toBe(`${LAN},::1/128`);
    expect(withIpv6Loopback("10.0.0.0/8, 192.168.0.0/16")).toBe("10.0.0.0/8,192.168.0.0/16");
  });

  test("every LAN vhost allows ::1 so http://localhost:<port>/ is not 403", () => {
    for (const name of ["nginx.merchant.lan.conf.tpl", "nginx.checkout.lan.conf.tpl", "nginx.admin.lan.conf.tpl"]) {
      const rendered = renderNginxTemplate({
        template: readFileSync(join(import.meta.dir, "..", "templates", name), "utf8"),
        serverName: "_",
        listenPort: 8081,
        httpPort: 80,
        httpsPort: 443,
        ssl: false,
        sslCertPath: "/x.crt",
        sslKeyPath: "/x.key",
        staticRoot: "/var/www/x/dist",
        backendPort: 4102,
        lanAllowedCidrs: LAN,
      });
      expect(rendered).toContain("allow ::1/128;");
      expect(rendered).toContain("allow 127.0.0.1/32;");
      expect(rendered.indexOf("allow ::1/128;")).toBeLessThan(rendered.indexOf("deny all;"));
    }
  });
});
