import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultOutputDirectory = resolve(scriptDirectory, "../certs");
const outputDirectory = resolve(process.env.MTLS_CERT_DIR ?? defaultOutputDirectory);
const certificateDays = Number.parseInt(process.env.MTLS_CERT_DAYS ?? "825", 10);

if (!Number.isInteger(certificateDays) || certificateDays < 1) {
  throw new Error("MTLS_CERT_DAYS must be a positive integer");
}

const runOpenSsl = (argumentsList: string[]) => {
  execFileSync("openssl", argumentsList, {
    stdio: ["ignore", "pipe", "pipe"],
  });
};

const writePrivateKey = (path: string) => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 4096,
    publicKeyEncoding: {
      type: "spki",
      format: "pem",
    },
    privateKeyEncoding: {
      type: "pkcs8",
      format: "pem",
    },
  });
  writeFileSync(path, privateKey, { mode: 0o600 });
  chmodSync(path, 0o600);
};

const writeExtensions = (directory: string, name: string, contents: string) => {
  const path = join(directory, name);
  writeFileSync(path, contents, { mode: 0o600 });
  return path;
};

const createSignedCertificate = (options: {
  name: string;
  subject: string;
  extensions: string;
  certificatePath: string;
  keyPath: string;
  caCertificatePath: string;
  caKeyPath: string;
  workDirectory: string;
}) => {
  writePrivateKey(options.keyPath);
  const requestPath = join(options.workDirectory, `${options.name}.csr`);
  runOpenSsl([
    "req",
    "-new",
    "-key",
    options.keyPath,
    "-out",
    requestPath,
    "-subj",
    options.subject,
  ]);

  const extensionPath = writeExtensions(
    options.workDirectory,
    `${options.name}.extensions`,
    options.extensions,
  );
  runOpenSsl([
    "x509",
    "-req",
    "-in",
    requestPath,
    "-CA",
    options.caCertificatePath,
    "-CAkey",
    options.caKeyPath,
    "-CAcreateserial",
    "-out",
    options.certificatePath,
    "-days",
    String(certificateDays),
    "-sha256",
    "-extfile",
    extensionPath,
  ]);
  chmodSync(options.certificatePath, 0o644);
};

const main = () => {
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  const workDirectory = mkdtempSync(join(tmpdir(), "payment-gateway-mtls-"));
  const caCertificatePath = join(outputDirectory, "internal-ca.crt");
  const caKeyPath = join(outputDirectory, "internal-ca.key");

  try {
    writePrivateKey(caKeyPath);
    runOpenSsl([
      "req",
      "-x509",
      "-new",
      "-key",
      caKeyPath,
      "-sha256",
      "-days",
      String(certificateDays * 4),
      "-out",
      caCertificatePath,
      "-subj",
      "/CN=payment-gateway-internal-ca",
      "-addext",
      "basicConstraints=critical,CA:TRUE,pathlen:0",
      "-addext",
      "keyUsage=critical,keyCertSign,cRLSign",
      "-addext",
      "subjectKeyIdentifier=hash",
    ]);
    chmodSync(caCertificatePath, 0o644);

    const serverExtensions = [
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature,keyEncipherment",
      "extendedKeyUsage=serverAuth",
      "subjectAltName=DNS:core-back.internal,DNS:core-back,IP:127.0.0.1",
      "subjectKeyIdentifier=hash",
      "authorityKeyIdentifier=keyid,issuer",
    ].join("\n");

    createSignedCertificate({
      name: "core-back",
      subject: "/CN=core-back",
      extensions: serverExtensions,
      certificatePath: join(outputDirectory, "core-back.crt"),
      keyPath: join(outputDirectory, "core-back.key"),
      caCertificatePath,
      caKeyPath,
      workDirectory,
    });

    const clientExtensions = [
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature,keyEncipherment",
      "extendedKeyUsage=clientAuth",
      "subjectKeyIdentifier=hash",
      "authorityKeyIdentifier=keyid,issuer",
    ].join("\n");

    for (const client of [
      { name: "admin-back", ou: "edge-admin" },
      { name: "merchant-back", ou: "edge-merchant" },
      { name: "checkout-back", ou: "edge-checkout" },
    ]) {
      createSignedCertificate({
        name: `${client.name}-client`,
        subject: `/CN=${client.name}/OU=${client.ou}`,
        extensions: clientExtensions,
        certificatePath: join(outputDirectory, `${client.name}-client.crt`),
        keyPath: join(outputDirectory, `${client.name}-client.key`),
        caCertificatePath,
        caKeyPath,
        workDirectory,
      });
    }
  } finally {
    rmSync(workDirectory, { recursive: true, force: true });
  }

  process.stdout.write(
    `Generated internal CA and mTLS certificates in ${outputDirectory}\n` +
      "Private keys were written only to the local certificate directory and are not logged.\n",
  );
};

main();
