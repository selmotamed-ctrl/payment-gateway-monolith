/**
 * AUTO-28 internal mTLS leaf renewal with real openssl in a temp directory: a normal deploy re-issues, with the SAME CA,
 * exactly the leaves that expire within MTLS_RENEW_WITHIN_DAYS and nothing else; the report says what needs a CA rotation.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDeployConfig } from "../lib/configSchema";
import { buildPki, checkPkiExpiry, inspectCertificate, pkiRenewalReport } from "../lib/pkiManager";

const SOURCE = `
DB_MANAGE_VIA_SSH="false"
DB_NAME="gateway"
DB_USER="gw"
DB_PASSWORD="ultra-strong-db-K7p2Zq9w"
DATABASE_URL="postgresql://gw:ultra-strong-db-K7p2Zq9w@10.10.0.10:5432/gateway"
DB_ENGINE="postgresql"
CORE_SSH_HOST="10.10.0.20"
CORE_SSH_KEY_PATH="~/.ssh/core"
CORE_PRIVATE_IP="10.10.0.20"
ADMIN_SSH_HOST="10.10.0.30"
ADMIN_SSH_KEY_PATH="~/.ssh/admin"
ADMIN_PRIVATE_IP="10.10.0.30"
MERCHANT_SSH_HOST="203.0.113.10"
MERCHANT_SSH_KEY_PATH="~/.ssh/merchant"
MERCHANT_PRIVATE_IP="10.10.0.40"
MERCHANT_DOMAIN="merchant.example.ly"
CHECKOUT_SSH_HOST="203.0.113.20"
CHECKOUT_SSH_KEY_PATH="~/.ssh/checkout"
CHECKOUT_PRIVATE_IP="10.10.0.50"
CHECKOUT_DOMAIN="pay.example.ly"
KMS_MASTER_KEY="kms-Q7x9Lm2Zr4Vb8Nc1Wd5Tg3Hy6Jp0Sa2"
`;

const configWith = (extra = "") => {
  const result = loadDeployConfig(`${SOURCE}\n${extra}\n`);
  if (!result.ok || !result.config) throw new Error(result.problems.join("; "));
  return result.config;
};

const dirs: string[] = [];
const freshDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "pg-pki-renew-"));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const bytes = (dir: string, file: string): string => readFileSync(join(dir, file), "utf8");

/** Re-signs a leaf with the directory's CA for only `days` days (an old certificate about to run out). */
const shorten = (dir: string, name: string, days: number): void => {
  execFileSync("openssl", ["req", "-new", "-key", `${name}.key`, "-out", `${name}.csr`, "-subj", `/CN=${name}`], { cwd: dir });
  execFileSync(
    "openssl",
    ["x509", "-req", "-in", `${name}.csr`, "-CA", "internal-ca.crt", "-CAkey", "internal-ca.key", "-CAcreateserial", "-out", `${name}.crt`, "-days", String(days)],
    { cwd: dir, stdio: "ignore" },
  );
};

describe("mTLS leaf renewal (AUTO-28)", () => {
  test("a deploy re-issues only the leaf that is about to expire, with the same CA, and leaves everything else byte-identical", () => {
    const dir = freshDir();
    const config = configWith();
    expect(config.MTLS_RENEW_WITHIN_DAYS).toBe(30);
    const first = buildPki({ config, directory: dir });
    expect(first.renewed).toEqual([]);
    const caBefore = bytes(dir, "internal-ca.crt");
    const serverBefore = bytes(dir, "core-back.crt");
    const merchantBefore = bytes(dir, "merchant-back-client.crt");
    const adminBefore = bytes(dir, "admin-back-client.crt");

    shorten(dir, "admin-back-client", 5);
    expect(inspectCertificate(join(dir, "admin-back-client.crt"), "x").expiresInDays).toBeLessThanOrEqual(5);

    const second = buildPki({ config, directory: dir });
    expect(second.renewed).toEqual(["admin-back-client"]);
    expect(bytes(dir, "internal-ca.crt")).toBe(caBefore);
    expect(bytes(dir, "core-back.crt")).toBe(serverBefore);
    expect(bytes(dir, "merchant-back-client.crt")).toBe(merchantBefore);
    expect(bytes(dir, "admin-back-client.crt")).not.toBe(adminBefore);
    expect(inspectCertificate(join(dir, "admin-back-client.crt"), "x").expiresInDays).toBeGreaterThan(800);
    // the renewed certificate still chains to the unchanged CA
    execFileSync("openssl", ["verify", "-CAfile", join(dir, "internal-ca.crt"), join(dir, "admin-back-client.crt")], { stdio: "pipe" });

    // and a third deploy has nothing to do
    expect(buildPki({ config, directory: dir }).renewed).toEqual([]);
    expect(bytes(dir, "admin-back-client.crt")).not.toBe(adminBefore);
  });

  test("an expiring server leaf is re-issued (and its SANs kept), the clients are not touched", () => {
    const dir = freshDir();
    const config = configWith();
    buildPki({ config, directory: dir });
    const clientBefore = bytes(dir, "merchant-back-client.crt");
    const sansBefore = inspectCertificate(join(dir, "core-back.crt"), "core").sans;
    shorten(dir, "core-back", 3);
    const renewed = buildPki({ config, directory: dir });
    expect(renewed.renewed).toEqual(["core-back"]);
    expect(bytes(dir, "merchant-back-client.crt")).toBe(clientBefore);
    const after = inspectCertificate(join(dir, "core-back.crt"), "core");
    expect(after.expiresInDays).toBeGreaterThan(800);
    expect(after.sans).toEqual(expect.arrayContaining(sansBefore));
    expect(after.sans).toContain("10.10.0.20");
  });

  test("MTLS_RENEW_WITHIN_DAYS=0 turns the renewal off", () => {
    const dir = freshDir();
    const config = configWith('MTLS_RENEW_WITHIN_DAYS="0"');
    buildPki({ config, directory: dir });
    shorten(dir, "admin-back-client", 2);
    const before = bytes(dir, "admin-back-client.crt");
    expect(buildPki({ config, directory: dir }).renewed).toEqual([]);
    expect(bytes(dir, "admin-back-client.crt")).toBe(before);
  });

  test("a dry run reports what would be renewed and writes nothing", () => {
    const dir = freshDir();
    const config = configWith();
    buildPki({ config, directory: dir });
    shorten(dir, "merchant-back-client", 4);
    const before = bytes(dir, "merchant-back-client.crt");
    expect(buildPki({ config, directory: dir, dryRun: true }).renewed).toEqual(["merchant-back-client"]);
    expect(bytes(dir, "merchant-back-client.crt")).toBe(before);
  });

  test("--rotate-certs still replaces the CA and everything", () => {
    const dir = freshDir();
    const config = configWith();
    buildPki({ config, directory: dir });
    const caBefore = bytes(dir, "internal-ca.crt");
    const serverBefore = bytes(dir, "core-back.crt");
    buildPki({ config, directory: dir, rotate: true });
    expect(bytes(dir, "internal-ca.crt")).not.toBe(caBefore);
    expect(bytes(dir, "core-back.crt")).not.toBe(serverBefore);
  });

  test("the renewal report: leaves renew on deploy, a CA near expiry needs a rotation, an expired certificate is flagged", () => {
    const dir = freshDir();
    const bundle = buildPki({ config: configWith(), directory: dir });
    expect(pkiRenewalReport(bundle, 30)).toEqual([]);
    shorten(dir, "admin-back-client", 5);
    const report = pkiRenewalReport(bundle, 30);
    expect(report.map((row) => `${row.name}:${row.action}`)).toEqual(["admin-back-client:renew-on-deploy"]);
    // a window longer than the CA's life reports the CA as needing a rotation (not a renewal)
    const caDays = inspectCertificate(join(dir, "internal-ca.crt"), "ca").expiresInDays;
    const wide = pkiRenewalReport(bundle, caDays + 1);
    expect(wide.find((row) => row.name === "internal-ca")?.action).toBe("rotate-ca");
    expect(pkiRenewalReport(bundle, 30, new Date(Date.now() + 2 * 86_400_000)).find((row) => row.name === "admin-back-client")?.action).toBe("renew-on-deploy");
    // seen from after its end date the same certificate is expired
    expect(pkiRenewalReport(bundle, 30, new Date(Date.now() + 10 * 86_400_000)).find((row) => row.name === "admin-back-client")?.action).toBe("expired");
  });

  test("--check-certs: ok when everything is valid, RENEW for a leaf in the window, ROTATE-CA for the CA, MISSING and EXPIRED reported", () => {
    const dir = freshDir();
    const bundle = buildPki({ config: configWith(), directory: dir });
    const healthy = checkPkiExpiry(bundle, 30);
    expect(healthy.ok).toBe(true);
    expect(healthy.lines.every((line) => line.startsWith("ok"))).toBe(true);

    shorten(dir, "merchant-back-client", 6);
    const renew = checkPkiExpiry(bundle, 30);
    expect(renew.ok).toBe(false);
    expect(renew.lines.filter((line) => !line.startsWith("ok")).map((line) => line.split(/\s+/)[0])).toEqual(["RENEW"]);

    const caDays = inspectCertificate(join(dir, "internal-ca.crt"), "ca").expiresInDays;
    const wide = checkPkiExpiry(bundle, caDays + 1);
    expect(wide.lines.some((line) => line.startsWith("ROTATE-CA"))).toBe(true);

    const future = checkPkiExpiry(bundle, 30, new Date(Date.now() + 30 * 86_400_000));
    expect(future.lines.some((line) => line.startsWith("EXPIRED") && line.includes("merchant-back-client"))).toBe(true);

    rmSync(join(dir, "admin-back-client.crt"));
    const missing = checkPkiExpiry(bundle, 30);
    expect(missing.ok).toBe(false);
    expect(missing.lines.some((line) => line.startsWith("MISSING") && line.includes("admin-back-client"))).toBe(true);
  });
});
