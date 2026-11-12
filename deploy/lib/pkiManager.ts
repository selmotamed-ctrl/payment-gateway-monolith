import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  auditDbConfigured,
  backupStorageConfigured,
  logDbConfigured,
  objectStorageConfigured,
  parseNodeList,
  pgStorageConfigured,
  redisStorageConfigured,
  type DeployConfig,
  type HostRole,
} from "./configSchema";

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
  /** The Fake Rails Nginx server certificate (CA-signed, SAN-bound). */
  fakeRails: CertMaterial;
  /** The pg-backup-daemon mTLS server certificate. */
  backup: CertMaterial;
  /** The pg-object-storage-daemon mTLS server certificate. */
  objectStorage: CertMaterial;
  clients: CertMaterial[];
  /** Optional client certificates for storage/backup mTLS links. */
  storageClients: CertMaterial[];
  /** Leaf certificates this call re-issued because they were about to expire (AUTO-28). */
  renewed?: string[];
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

/** CN and file stem of the WAL-archive-only client certificate. */
export const WAL_ARCHIVE_CLIENT = "wal-archive-client";

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
  extendedKeyUsage: "serverAuth" | "clientAuth" | "serverAuth,clientAuth";
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

  // The SAN must carry every core private IP: the edge hosts reach the core
  // nodes by IP and TLS 1.3 verifies the hostname.
  const coreNodeIps = parseNodeList(config.CORE_NODES).map((node) => node.privateIp);
  const coreIps = [...new Set(coreNodeIps.length > 0
    ? coreNodeIps
    : (config.CORE_PRIVATE_IP ? [config.CORE_PRIVATE_IP] : []))];
  const serverSans = [
    ...coreIps.map((ip) => `IP:${ip}`),
    "IP:127.0.0.1",
    "DNS:core-back.internal",
  ];
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
  const backupIp = parseNodeList(config.BACKUP_NODE)[0]?.privateIp;
  const backup: CertMaterial = {
    name: "backup-daemon",
    certPath: join(directory, "backup-daemon.crt"),
    keyPath: join(directory, "backup-daemon.key"),
    kind: "server",
    cn: "backup-daemon.internal",
    sans: [
      ...(backupIp ? [`IP:${backupIp}`] : []),
      "IP:127.0.0.1",
      "DNS:backup-daemon.internal",
    ],
  };
  const objectStorageIp = parseNodeList(config.OBJECT_STORAGE_NODE)[0]?.privateIp;
  const objectStorage: CertMaterial = {
    name: "object-storage-daemon",
    certPath: join(directory, "object-storage-daemon.crt"),
    keyPath: join(directory, "object-storage-daemon.key"),
    kind: "server",
    cn: "object-storage-daemon.internal",
    sans: [
      ...(objectStorageIp ? [`IP:${objectStorageIp}`] : []),
      "IP:127.0.0.1",
      "DNS:object-storage-daemon.internal",
    ],
  };
  const storageClients: CertMaterial[] = [];
  for (const [name, enabled] of [
    ["pg-client", pgStorageConfigured(config)],
    ["redis-client", redisStorageConfigured(config)],
    ["audit-db-client", auditDbConfigured(config)],
    ["log-db-client", logDbConfigured(config)],
  ] as const) {
    if (!enabled) continue;
    storageClients.push({
      name,
      certPath: join(directory, `${name}.crt`),
      keyPath: join(directory, `${name}.key`),
      kind: "client",
      cn: name,
    });
  }
  if (objectStorageConfigured(config) && !storageClients.some((client) => client.name === "object-storage-client")) {
    storageClients.push({
      name: "object-storage-client",
      certPath: join(directory, "object-storage-client.crt"),
      keyPath: join(directory, "object-storage-client.key"),
      kind: "client",
      cn: "object-storage-client",
    });
  }
  if (backupStorageConfigured(config) && !storageClients.some((client) => client.name === "backup-client")) {
    storageClients.push({
      name: "backup-client",
      certPath: join(directory, "backup-client.crt"),
      keyPath: join(directory, "backup-client.key"),
      kind: "client",
      cn: "backup-client",
    });
  }

  // Least-privilege WAL ingest client: lets PostgreSQL's archive_command PUT WAL
  // to the backup daemon and nothing else. Only pg-primary / audit-db hosts get it.
  if (backupStorageConfigured(config)) {
    storageClients.push({
      name: WAL_ARCHIVE_CLIENT,
      certPath: join(directory, `${WAL_ARCHIVE_CLIENT}.crt`),
      keyPath: join(directory, `${WAL_ARCHIVE_CLIENT}.key`),
      kind: "client",
      cn: WAL_ARCHIVE_CLIENT,
    });
  }

  const fakeRails: CertMaterial = {
    name: "fake-rails",
    certPath: join(directory, "fake-rails.crt"),
    keyPath: join(directory, "fake-rails.key"),
    kind: "server",
    cn: config.FAKE_RAILS_DOMAIN === "_" ? "fakerails.internal" : config.FAKE_RAILS_DOMAIN,
    sans: [
      `DNS:${config.FAKE_RAILS_DOMAIN === "_" ? "fakerails.internal" : config.FAKE_RAILS_DOMAIN}`,
      ...(config.FAKE_RAILS_PRIVATE_IP ? [`IP:${config.FAKE_RAILS_PRIVATE_IP}`] : []),
      "IP:127.0.0.1",
    ],
  };
  const bundle: PkiBundle = { directory, ca: caMaterial, server, fakeRails, backup, objectStorage, clients, storageClients, renewed: [] };
  const everythingExists = [caCert, caKey, server.certPath, server.keyPath, fakeRails.certPath, fakeRails.keyPath, backup.certPath, backup.keyPath, ...(objectStorageConfigured(config) ? [objectStorage.certPath, objectStorage.keyPath] : []), ...[...clients, ...storageClients].flatMap((client) => [client.certPath, client.keyPath])]
    .every((path) => existsSync(path));

  // AUTO-28: leaves that expire within the renewal window are re-issued by the CA that is already trusted, so a
  // routine deploy keeps the certificates alive without the disruption of a CA rotation.
  const renewNames = new Set<string>();
  const renewWithin = config.MTLS_RENEW_WITHIN_DAYS;
  if (everythingExists && !rotate && renewWithin > 0) {
    for (const leaf of [server, backup, ...(objectStorageConfigured(config) ? [objectStorage] : []), fakeRails, ...clients, ...storageClients]) {
      if (inspectCertificate(leaf.certPath, leaf.name).expiresInDays < renewWithin) renewNames.add(leaf.name);
    }
  }

  // The three server leaves are all re-signed on a fresh/partial PKI, a rotation, or when a SAN drifted (a staging box
  // that moves to another LAN); otherwise only the ones that are about to expire.
  let sanDrift = false;
  if (everythingExists && !rotate) {
    // The private IP is part of the server certificate SAN. A staging box that
    // moves to a different LAN must get new server certificates for the core,
    // the backup daemon and Fake Rails, otherwise TLS clients reject them.
    // Re-sign the leaves (the CA stays stable) only when a SAN actually drifts.
    const certificateCoversSans = (material: CertMaterial): boolean => {
      const current = inspectCertificate(material.certPath, material.name);
      return (material.sans ?? [])
        .map((san) => san.replace(/^(IP|DNS|URI):/i, ""))
        .every((san) => current.sans.includes(san));
    };
    sanDrift = ![server, backup, ...(objectStorageConfigured(config) ? [objectStorage] : []), fakeRails].every(certificateCoversSans);
    if (!sanDrift && renewNames.size === 0) {
      verifyPki(bundle);
      return bundle;
    }
  }

  if (dryRun) {
    bundle.renewed = [...renewNames];
    return bundle;
  }

  ensureDirectory(directory);

  // ---- 1. Internal root CA (10 years) ------------------------------------
  const regenerateCa = !existsSync(caCert) || !existsSync(caKey) || rotate;
  if (regenerateCa) {
    run("openssl", [
      "req", "-x509", "-newkey", "rsa:4096", "-nodes",
      "-keyout", "internal-ca.key", "-out", "internal-ca.crt",
      "-days", "3650", "-subj", "/CN=Payment Gateway Internal CA/O=Payment Gateway/OU=Internal PKI",
      "-addext", "basicConstraints=critical,CA:TRUE",
      "-addext", "keyUsage=critical,keyCertSign,cRLSign",
    ], directory);
    chmodSync(caKey, 0o600);
  }

  const signAllServers = !everythingExists || rotate || regenerateCa || sanDrift;
  const signServer = (material: CertMaterial): boolean => signAllServers || renewNames.has(material.name);

  // ---- 2. The core server certificate (SAN bound to the private IP) ------
  if (signServer(server)) signLeaf({
    run,
    directory,
    material: server,
    ou: "core",
    sans: serverSans,
    // Also usable as a client so the core host can probe its own /health.
    extendedKeyUsage: "serverAuth,clientAuth",
    validityDays: config.MTLS_VALIDITY_DAYS,
  });

  // ---- 2a. The backup daemon server certificate --------------------------
  if (signServer(backup)) signLeaf({
    run,
    directory,
    material: backup,
    ou: "backup",
    sans: backup.sans ?? [],
    extendedKeyUsage: "serverAuth,clientAuth",
    validityDays: config.MTLS_VALIDITY_DAYS,
  });

  // ---- 2b. The object-storage-daemon mTLS server certificate -------------
  if (objectStorageConfigured(config) && signServer(objectStorage)) signLeaf({
    run,
    directory,
    material: objectStorage,
    ou: "object-storage",
    sans: objectStorage.sans ?? [],
    extendedKeyUsage: "serverAuth,clientAuth",
    validityDays: config.MTLS_VALIDITY_DAYS,
  });

  // ---- 2c. The Fake Rails Nginx server certificate -----------------------
  if (signServer(fakeRails)) signLeaf({
    run,
    directory,
    material: fakeRails,
    ou: "fake-rails",
    sans: fakeRails.sans ?? [],
    extendedKeyUsage: "serverAuth",
    validityDays: config.MTLS_VALIDITY_DAYS,
  });

  // ---- 3. Optional storage/backup client certificates --------------------
  // Existing client leaves are kept (unless the CA or a rotation says
  // otherwise) so adding one new client certificate does not re-issue the rest.
  for (const client of storageClients) {
    if (!regenerateCa && !renewNames.has(client.name) && existsSync(client.certPath) && existsSync(client.keyPath)) continue;
    signLeaf({
      run,
      directory,
      material: client,
      ou: "storage-client",
      sans: [],
      extendedKeyUsage: "clientAuth",
      validityDays: config.MTLS_VALIDITY_DAYS,
    });
  }

  // ---- 4. The three edge client certificates ----------------------------
  for (const client of clients) {
    if (!regenerateCa && !renewNames.has(client.name) && existsSync(client.certPath) && existsSync(client.keyPath)) continue;
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

  bundle.renewed = [...renewNames];
  verifyPki(bundle);
  return bundle;
};

/**
 * The certificates of the bundle that expire within `withinDays` days (AUTO-28), with what to do about each: a leaf is
 * re-issued by the next deploy (`MTLS_RENEW_WITHIN_DAYS`); the CA is not, because replacing it is a rotation of every
 * certificate (`--rotate-certs`).
 */
export const pkiRenewalReport = (
  bundle: PkiBundle,
  withinDays: number,
  now = new Date(),
): Array<{ name: string; expiresInDays: number; action: "renew-on-deploy" | "rotate-ca" | "expired" }> =>
  verifyPki(bundle, now)
    .filter((certificate) => certificate.expiresInDays < withinDays)
    .map((certificate) => ({
      name: certificate.name,
      expiresInDays: certificate.expiresInDays,
      action: certificate.expiresInDays <= 0 ? "expired" : certificate.name === bundle.ca.name ? "rotate-ca" : "renew-on-deploy",
    }));

const signLeaf = (input: {
  run: (command: string, args: string[], cwd: string) => void;
  directory: string;
  material: CertMaterial;
  ou: string;
  sans: string[];
  extendedKeyUsage: "serverAuth" | "clientAuth" | "serverAuth,clientAuth";
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
  const certificates = [
    bundle.ca,
    bundle.server,
    bundle.fakeRails,
    bundle.backup,
    ...(existsSync(bundle.objectStorage.certPath) ? [bundle.objectStorage] : []),
    ...bundle.clients,
    ...bundle.storageClients,
  ];
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
  roles: readonly HostRole[],
): CertMaterial[] => {
  const files: CertMaterial[] = [bundle.ca];
  for (const role of roles) {
    if (role === "core") {
      // Everything except the WAL ingest client, which is for PostgreSQL hosts only.
      files.push(bundle.server, ...bundle.storageClients.filter((client) => client.name !== WAL_ARCHIVE_CLIENT));
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
    if (role === "fake-rails") {
      files.push(bundle.fakeRails);
    }
    if (role === "pg-primary" || role === "pg-replica" || role === "pgbouncer") {
      files.push(...bundle.storageClients.filter((client) => client.name === "pg-client"));
    }
    if (role === "pg-primary" || role === "audit-db") {
      files.push(...bundle.storageClients.filter((client) => client.name === WAL_ARCHIVE_CLIENT));
    }
    if (role === "redis") {
      files.push(...bundle.storageClients.filter((client) => client.name === "redis-client"));
    }
    if (role === "audit-db") {
      files.push(...bundle.storageClients.filter((client) => client.name === "audit-db-client"));
    }
    if (role === "log-db") {
      files.push(...bundle.storageClients.filter((client) => client.name === "log-db-client"));
    }
    if (role === "backup") {
      files.push(
        bundle.backup,
        ...bundle.storageClients.filter(
          (client) =>
            client.name === "pg-client"
            || client.name === "backup-client"
            || client.name === "object-storage-client",
        ),
      );
    }
    if (role === "object-storage") {
      files.push(
        bundle.objectStorage,
        ...bundle.storageClients.filter((client) => client.name === "object-storage-client"),
      );
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


/**
 * `deploy.ts --check-certs`: the certificate expiry table for cron or an alert hook (AUTO-28). Reads only; a missing
 * file is reported, not thrown. `ok` is false when anything is missing, expired or inside the renewal window.
 */
export const checkPkiExpiry = (
  bundle: PkiBundle,
  withinDays: number,
  now = new Date(),
  includeObjectStorage = existsSync(bundle.objectStorage.certPath),
): { ok: boolean; lines: string[] } => {
  const lines: string[] = [];
  let ok = true;
  const materials = [
    bundle.ca,
    bundle.server,
    bundle.fakeRails,
    bundle.backup,
    ...(includeObjectStorage ? [bundle.objectStorage] : []),
    ...bundle.clients,
    ...bundle.storageClients,
  ];
  for (const material of materials) {
    if (!existsSync(material.certPath)) {
      ok = false;
      lines.push(`MISSING   ${material.name}  (${material.certPath})`);
      continue;
    }
    const certificate = inspectCertificate(material.certPath, material.name, now);
    const state =
      certificate.expiresInDays <= 0
        ? "EXPIRED"
        : certificate.expiresInDays < withinDays
          ? material.name === bundle.ca.name
            ? "ROTATE-CA"
            : "RENEW"
          : "ok";
    if (state !== "ok") ok = false;
    lines.push(`${state.padEnd(9)} ${material.name}  expires ${certificate.notAfter} (${certificate.expiresInDays} day(s))`);
  }
  return { ok, lines };
};
