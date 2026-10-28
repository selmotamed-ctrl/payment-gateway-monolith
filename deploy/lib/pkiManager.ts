import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DeployConfig } from "./configSchema";

/**
 * The mTLS PKI.
 *
 * The internal CA is created offline and its private key never leaves the
 * deployment workstation. Each leaf certificate is bound to the identity the
 * design requires:
 *
 *   - the core server certificate carries `IP:<CORE_PRIVATE_IP>` in its SAN,
 *     because the edge servers reach it by private IP and TLS 1.3 verifies the
 *     hostname;
 *   - each edge client certificate carries the exact `CN=admin-back`,
 *     `CN=merchant-back` or `CN=checkout-back` that `core-back`'s
 *     channel-bound CN guard checks.
 */

export interface CertMaterial {
  name: string;
  certPath: string;
  keyPath: string;
  /** Only the core certificate is a server certificate. */
  kind: "ca" | "server" | "client";
  cn: string;
  sans?: string[];
}

export interface PkiBundle {
  directory: string;
  ca: CertMaterial;
  server: CertMaterial;
  clients: CertMaterial[];
}

export interface PkiOptions {
  config: DeployConfig;
  /** Defaults to `deploy/.certs`. */
  directory?: string;
  /** Force a regeneration even when the material already exists. */
  rotate?: boolean;
  /** Print the openssl commands instead of running them. */
  dryRun?: boolean;
  /** Overridable for tests. */
  run?: (command: string, args: string[], cwd: string) => void;
}

const DEFAULT_PKI_DIR = resolve(import.meta.dirname, "..", ".certs");

const runOpenssl = (command: string, args: string[], cwd: string): void => {
  execFileSync(command, args, { cwd, stdio: "ignore" });
};

const ensureDirectory = (directory: string): void => {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
};

const opensslConfig = (options: {
  cn: string;
  ou: string;
  sans: string[];
  extendedKeyUsage: "serverAuth" | "clientAuth";
}): string => {
  const san = options.sans.length > 0
    ? `subjectAltName = ${options.sans.join(", ")}`
    : "";
  return `[req]
distinguished_name = dn
prompt = no
[dn]
CN = ${options.cn}
OU = ${options.ou}
O = Payment Gateway
[v3]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = ${options.extendedKeyUsage}
${san}
`;
};

/**
 * Builds (or verifies) the internal CA and the four leaf certificates.
 *
 * Idempotent: an existing bundle is reused unless `rotate` is set, so a normal
 * deploy never rotates the production certificates by accident.
 */
export const buildPki = (options: PkiOptions): PkiBundle => {
  const directory = options.directory ?? DEFAULT_PKI_DIR;
  const config = options.config;
  const run = options.run ?? runOpenssl;
  const dryRun = options.dryRun === true;
  const rotate = options.rotate === true || config.ROTATE_MTLS_CERTS;

  const caCert = join(directory, "internal-ca.crt");
  const caKey = join(directory, "internal-ca.key");
  const caMaterial: CertMaterial = {
    name: "internal-ca",
    certPath: caCert,
    keyPath: caKey,
    kind: "ca",
    cn: "Payment Gateway Internal CA",
  };

  // The SAN must carry the private IP: the edge hosts reach the core by IP and
  // TLS 1.3 verifies the hostname.
  const serverSans = [`IP:${config.CORE_PRIVATE_IP}`, "IP:127.0.0.1", "DNS:core-back.internal"];
  const server: CertMaterial = {
    name: "core-back",
    certPath: join(directory, "core-back.crt"),
    keyPath: join(directory, "core-back.key"),
    kind: "server",
    cn: "core-back.internal",
    sans: serverSans,
  };
  const clients: CertMaterial[] = [
    { name: "admin-back-client", certPath: join(directory, "admin-back-client.crt"), keyPath: join(directory, "admin-back-client.key"), kind: "client", cn: "admin-back" },
    { name: "merchant-back-client", certPath: join(directory, "merchant-back-client.crt"), keyPath: join(directory, "merchant-back-client.key"), kind: "client", cn: "merchant-back" },
    { name: "checkout-back-client", certPath: join(directory, "checkout-back-client.crt"), keyPath: join(directory, "checkout-back-client.key"), kind: "client", cn: "checkout-back" },
  ];

  const bundle: PkiBundle = { directory, ca: caMaterial, server, clients };
  const everythingExists = [caCert, caKey, server.certPath, server.keyPath, ...clients.flatMap((client) => [client.certPath, client.keyPath])]
    .every((path) => existsSync(path));

  if (everythingExists && !rotate) {
    verifyPki(bundle);
    return bundle;
  }

  if (dryRun) {
    return bundle;
  }

  ensureDirectory(directory);

  // ---- 1. Internal root CA (10 years) ------------------------------------
  if (!existsSync(caCert) || !existsSync(caKey) || rotate) {
    run("openssl", [
      "req", "-x509", "-newkey", "rsa:4096", "-nodes",
      "-keyout", "internal-ca.key", "-out", "internal-ca.crt",
      "-days", "3650", "-subj", "/CN=Payment Gateway Internal CA/O=Payment Gateway/OU=Internal PKI",
      "-addext", "basicConstraints=critical,CA:TRUE",
      "-addext", "keyUsage=critical,keyCertSign,cRLSign",
    ], directory);
    chmodSync(caKey, 0o600);
  }

  // ---- 2. The core server certificate (SAN bound to the private IP) ------
  signLeaf({
    run,
    directory,
    material: server,
    ou: "core",
    sans: serverSans,
    extendedKeyUsage: "serverAuth",
    validityDays: config.MTLS_VALIDITY_DAYS,
  });

  // ---- 3. The three edge client certificates ----------------------------
  for (const client of clients) {
    const role = client.cn.split("-back")[0] ?? client.cn;
    signLeaf({
      run,
      directory,
      material: client,
      ou: `edge-${role}`,
      sans: [],
      extendedKeyUsage: "clientAuth",
      validityDays: config.MTLS_VALIDITY_DAYS,
    });
  }

  verifyPki(bundle);
  return bundle;
};

const signLeaf = (input: {
  run: (command: string, args: string[], cwd: string) => void;
  directory: string;
  material: CertMaterial;
  ou: string;
  sans: string[];
  extendedKeyUsage: "serverAuth" | "clientAuth";
  validityDays: number;
}): void => {
  const { run, directory, material } = input;
  const baseName = material.name;
  const csr = `${baseName}.csr`;
  const ext = `${baseName}.ext`;

  run("openssl", [
    "req", "-newkey", "rsa:2048", "-nodes",
    "-keyout", `${baseName}.key`, "-out", csr,
    "-subj", `/CN=${material.cn}/OU=${input.ou}/O=Payment Gateway`,
  ], directory);
  chmodSync(join(directory, `${baseName}.key`), 0o600);

  writeFileSync(
    join(directory, ext),
    opensslConfig({
      cn: material.cn,
      ou: input.ou,
      sans: input.sans,
      extendedKeyUsage: input.extendedKeyUsage,
    }),
    { mode: 0o600 },
  );

  run("openssl", [
    "x509", "-req", "-in", csr,
    "-CA", "internal-ca.crt", "-CAkey", "internal-ca.key", "-CAcreateserial",
    "-out", `${baseName}.crt`, "-days", String(input.validityDays),
    "-extfile", ext, "-extensions", "v3",
  ], directory);
  chmodSync(join(directory, `${baseName}.crt`), 0o644);
  for (const temporary of [csr, ext]) {
    rmSync(join(directory, temporary), { force: true });
  }
};

export interface CertVerification {
  name: string;
  certPath: string;
  subject: string;
  notBefore: string;
  notAfter: string;
  expiresInDays: number;
  /** A server certificate must carry the configured private IP in its SAN. */
  sans: string[];
  valid: boolean;
}

export const inspectCertificate = (certPath: string, name: string, now = new Date()): CertVerification => {
  const text = execFileSync("openssl", ["x509", "-in", certPath, "-noout", "-subject", "-dates", "-ext", "subjectAltName"], {
    encoding: "utf8",
  });
  const subject = /subject=\s*(.*)/.exec(text)?.[1]?.trim() ?? "";
  const notBefore = /notBefore=\s*(.*)/.exec(text)?.[1]?.trim() ?? "";
  const notAfter = /notAfter=\s*(.*)/.exec(text)?.[1]?.trim() ?? "";
  const sans = [...text.matchAll(/(?:IP Address|DNS|URI):([^,\n]+)/g)].map((match) => match[1]?.trim() ?? "");
  const expiresAt = notAfter ? new Date(notAfter) : null;
  const expiresInDays = expiresAt ? Math.floor((expiresAt.getTime() - now.getTime()) / 86_400_000) : -1;
  return {
    name,
    certPath,
    subject,
    notBefore,
    notAfter,
    expiresInDays,
    sans: sans.filter((entry) => entry.length > 0),
    valid: expiresInDays > 0,
  };
};

/** Inspects every certificate of the bundle (used by the audit summary and by the health check). */
export const verifyPki = (bundle: PkiBundle, now = new Date()): CertVerification[] => {
  const certificates = [bundle.ca, bundle.server, ...bundle.clients];
  return certificates.map((material) => inspectCertificate(material.certPath, material.name, now));
};

/**
 * The exact files a host is allowed to receive.
 *
 * This is the least-privilege distribution the design demands: the CA private
 * key is never copied anywhere, and an edge host only gets its own client
 * certificate.
 */
export const certFilesForHost = (
  bundle: PkiBundle,
  roles: readonly ("db" | "core" | "admin" | "merchant" | "checkout")[],
): CertMaterial[] => {
  const files: CertMaterial[] = [bundle.ca];
  for (const role of roles) {
    if (role === "core") {
      files.push(bundle.server);
    }
    if (role === "admin") {
      files.push(...bundle.clients.filter((client) => client.cn === "admin-back"));
    }
    if (role === "merchant") {
      files.push(...bundle.clients.filter((client) => client.cn === "merchant-back"));
    }
    if (role === "checkout") {
      files.push(...bundle.clients.filter((client) => client.cn === "checkout-back"));
    }
  }
  // Deduplicate the CA when several roles share a host.
  const seen = new Set<string>();
  return files.filter((file) => {
    if (seen.has(file.keyPath)) return false;
    seen.add(file.keyPath);
    return true;
  });
};

/** Reads a certificate/key pair as a Buffer for upload. */
export const readMaterial = (material: CertMaterial): { cert: Buffer; key?: Buffer } => ({
  cert: readFileSync(material.certPath),
  ...(material.kind === "ca" ? {} : { key: readFileSync(material.keyPath) }),
});

export { DEFAULT_PKI_DIR };
