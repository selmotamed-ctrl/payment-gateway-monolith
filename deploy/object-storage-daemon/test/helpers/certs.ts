import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** True when the test environment has the openssl CLI used to build ephemeral mTLS material. */
export const opensslAvailable = (() => {
  try {
    return spawnSync("openssl", ["version"]).status === 0;
  } catch {
    return false;
  }
})();

export interface TestCertificates {
  dir: string;
  ca: string;
  serverCert: string;
  serverKey: string;
  allowedCert: string;
  allowedKey: string;
  deniedCert: string;
  deniedKey: string;
  untrustedCert: string;
  untrustedKey: string;
  cleanup: () => void;
}

/**
 * Creates a throwaway CA, a `127.0.0.1`/`localhost` server certificate, an
 * allowed client, a CA-signed client with an unlisted CN, and a client signed
 * by a second untrusted CA. The same layout is used by the raw TLS and SDK
 * tests so the two layers are proven against identical material.
 */
export const createTestCertificates = (): TestCertificates => {
  const dir = mkdtempSync(join(tmpdir(), "object-daemon-mtls-"));
  const run = (args: string[]): void => {
    const result = spawnSync("openssl", args, {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, MSYS_NO_PATHCONV: "1" },
    });
    if (result.status !== 0) {
      rmSync(dir, { recursive: true, force: true });
      throw new Error(`openssl ${args.join(" ")} failed: ${result.stderr}`);
    }
  };

  try {
    run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.crt", "-days", "2", "-subj", "/CN=Object Storage Test CA"]);
    writeFileSync(join(dir, "ext.cnf"), "subjectAltName=DNS:localhost,IP:127.0.0.1\n");
    for (const [name, cn] of [
      ["server", "object-storage-daemon.internal"],
      ["allowed-client", "object-storage-client"],
      ["denied-client", "admin-back"],
    ] as const) {
      run(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", `${name}.key`, "-out", `${name}.csr`, "-subj", `/CN=${cn}`]);
      run(["x509", "-req", "-in", `${name}.csr`, "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", `${name}.crt`, "-days", "2", "-extfile", "ext.cnf"]);
    }

    run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "untrusted-ca.key", "-out", "untrusted-ca.crt", "-days", "2", "-subj", "/CN=Untrusted Test CA"]);
    run(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "untrusted-client.key", "-out", "untrusted-client.csr", "-subj", "/CN=object-storage-client"]);
    run(["x509", "-req", "-in", "untrusted-client.csr", "-CA", "untrusted-ca.crt", "-CAkey", "untrusted-ca.key", "-CAcreateserial", "-out", "untrusted-client.crt", "-days", "2", "-extfile", "ext.cnf"]);

    return {
      dir,
      ca: join(dir, "ca.crt"),
      serverCert: join(dir, "server.crt"),
      serverKey: join(dir, "server.key"),
      allowedCert: join(dir, "allowed-client.crt"),
      allowedKey: join(dir, "allowed-client.key"),
      deniedCert: join(dir, "denied-client.crt"),
      deniedKey: join(dir, "denied-client.key"),
      untrustedCert: join(dir, "untrusted-client.crt"),
      untrustedKey: join(dir, "untrusted-client.key"),
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
};

/** Reads a material file from the certificate directory. */
export const readCert = (certs: TestCertificates, name: string): Buffer => readFileSync(join(certs.dir, name));
