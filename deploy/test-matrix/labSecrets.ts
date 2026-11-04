import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LabConfig } from "./labConfig";

/**
 * Lab-internal secrets (database/Redis passwords, KMS key, backup key, Fake
 * Rails credentials, object-store credentials).
 *
 * They replace the literals the archived plan hard-coded in the repository.
 * They are generated once per lab with a CSPRNG and persisted with mode 0600
 * under the git-ignored `configs/` directory so repeated runs reuse them.
 * Object-store credentials can instead come from env vars named in the config.
 */

export interface LabSecrets {
  kmsMasterKeyHex: string;
  backupEncryptionKeyHex: string;
  pgDbPassword: string;
  pgReplicationPassword: string;
  redisPassword: string;
  auditDbPassword: string;
  logDbPassword: string;
  fakeRailsAdminPassword: string;
  fakeRailsJwtSecret: string;
  fakeRailsSeederToken: string;
  objectStoreAccessKey: string;
  objectStoreSecretKey: string;
}

const token = (bytes: number): string => randomBytes(bytes).toString("base64url");
const hex = (bytes: number): string => randomBytes(bytes).toString("hex");

export const generateLabSecrets = (): LabSecrets => ({
  kmsMasterKeyHex: hex(32),
  backupEncryptionKeyHex: hex(32),
  pgDbPassword: token(24),
  pgReplicationPassword: token(24),
  redisPassword: token(24),
  auditDbPassword: token(24),
  logDbPassword: token(24),
  // Mixed classes so any password-complexity rule is satisfied.
  fakeRailsAdminPassword: `Lab-${token(18)}-9a!`,
  fakeRailsJwtSecret: token(48),
  fakeRailsSeederToken: token(48),
  objectStoreAccessKey: `pglab${hex(6)}`,
  objectStoreSecretKey: token(30),
});

export const secretsPathFor = (config: LabConfig, directory: string): string => join(directory, `lab-secrets.${config.lab.name}.json`);

/** Every secret value, for redaction of logs/reports. */
export const secretValues = (secrets: LabSecrets, extra: string[] = []): string[] =>
  [...Object.values(secrets), ...extra].filter((value) => value.length >= 6);

export const loadOrCreateLabSecrets = (
  config: LabConfig,
  directory: string,
  env: Record<string, string | undefined> = process.env,
): LabSecrets => {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = secretsPathFor(config, directory);
  let secrets: LabSecrets;
  if (existsSync(path)) {
    secrets = { ...generateLabSecrets(), ...(JSON.parse(readFileSync(path, "utf8")) as Partial<LabSecrets>) };
  } else {
    secrets = generateLabSecrets();
  }
  writeFileSync(path, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  const store = config.services.objectStore;
  const fromEnv = (name: string | undefined, label: string): string | undefined => {
    if (!name) return undefined;
    const value = env[name];
    if (!value) throw new Error(`services.objectStore.${label} refers to ${name}, which is not set`);
    return value;
  };
  return {
    ...secrets,
    objectStoreAccessKey: fromEnv(store?.accessKeyEnv, "accessKeyEnv") ?? secrets.objectStoreAccessKey,
    objectStoreSecretKey: fromEnv(store?.secretKeyEnv, "secretKeyEnv") ?? secrets.objectStoreSecretKey,
  };
};

const SECRET_ENV_KEY = /(PASS|PASSWORD|SECRET|TOKEN|KEY_HEX|MASTER_KEY|ACCESS_KEY)/;

/**
 * Redacts secret-looking `KEY=value` lines and any known secret value. The
 * archived runner only redacted `PASSWORD=` lines and leaked KMS keys, JWT
 * secrets and S3 credentials into the certification report.
 */
export const redact = (text: string, knownSecrets: string[] = []): string => {
  let out = text.replace(/^([A-Z0-9_]+)=(.*)$/gm, (line, key: string) => (SECRET_ENV_KEY.test(key) && !key.endsWith("_PATH") && !key.endsWith("_ID") ? `${key}=***` : line));
  for (const secret of [...knownSecrets].sort((left, right) => right.length - left.length)) {
    if (secret.length >= 6) out = out.split(secret).join("***");
  }
  return out;
};
