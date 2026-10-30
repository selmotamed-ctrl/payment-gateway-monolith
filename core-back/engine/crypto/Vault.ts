import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  timingSafeEqual as nodeTimingSafeEqual,
} from "node:crypto";
import { ApiError } from "../../lib/error";

export const VAULT_KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const REDACTED_VALUE = "[REDACTED]";

const SENSITIVE_FIELD_NAMES = new Set([
  "password",
  "passwd",
  "secret",
  "token",
  "accesstoken",
  "refreshtoken",
  "otp",
  "cvv",
  "pan",
  "authorization",
  "apikey",
  "webhooksecret",
  "clientsecret",
  "privatekey",
]);

/**
 * Field names are matched by PATTERN as well as by an exact list. A gateway
 * that names its secret `api_secret`, `signing_key` or `card_number` must not
 * leak it into `attempt_step_logs` or any other persisted payload.
 */
const SENSITIVE_FIELD_PATTERN =
  /(secret|token|password|passwd|passphrase|apikey|api_key|privatekey|private_key|signingkey|signing_key|signature|authorization|auth|credential|cookie|session|pan|card|cvv|cvc|otp|pin|iban|accountnumber|account_number)/i;

/**
 * A Luhn valid 12-19 digit number is treated as a card number even when the
 * field name does not say so.
 */
const looksLikePan = (value: string): boolean => {
  const digits = value.replace(/[\s-]/g, "");
  if (!/^\d{12,19}$/.test(digits)) {
    return false;
  }
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = digits.charCodeAt(index) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
};

export interface VaultKms {
  getKey(keyId: string): Promise<string | Buffer> | string | Buffer;
}

export interface VaultKeyResolver {
  resolveKey(keyId: string): Promise<Buffer> | Buffer;
}

export interface VaultOptions {
  keyResolver?: VaultKeyResolver;
  kms?: VaultKms;
  masterKey?: string | Buffer;
  environment?: Record<string, string | undefined>;
}

export interface VaultPayload {
  keyId: string;
  iv: Buffer;
  authTag: Buffer;
  ciphertext: Buffer;
}

function vaultError(code: string, message: string, statusCode = 400): ApiError {
  return new ApiError(statusCode, code, message);
}

export function assertValidVaultKeyId(keyId: string): void {
  if (typeof keyId !== "string" || !VAULT_KEY_ID_PATTERN.test(keyId)) {
    throw vaultError("INVALID_KEY_ID", "Vault key ID is invalid");
  }
}

function decodeStrictBase64(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw vaultError("INVALID_VAULT_PAYLOAD", "Vault payload contains invalid base64");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw vaultError("INVALID_VAULT_PAYLOAD", "Vault payload contains non-canonical base64");
  }
  return decoded;
}

function normalizeMasterKey(value: string | Buffer): Buffer {
  const buffer = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
  if (buffer.length === 32) {
    return buffer;
  }
  const text = buffer.toString("utf8").trim();
  if (/^[A-Za-z0-9+/]*={0,2}$/.test(text) && text.length % 4 === 0) {
    const decoded = Buffer.from(text, "base64");
    if (decoded.toString("base64") === text && decoded.length === 32) {
      return decoded;
    }
  }
  if (buffer.length === 0) {
    throw vaultError("INVALID_KMS_MASTER_KEY", "KMS master key cannot be empty");
  }
  return createHash("sha256").update(buffer).digest();
}

function deriveKey(masterKey: Buffer, keyId: string): Buffer {
  const derived = hkdfSync(
    "sha256",
    masterKey,
    Buffer.from(keyId, "utf8"),
    Buffer.from("payment-gateway:vault:aes-256-gcm:v1", "utf8"),
    32,
  );
  return Buffer.from(derived);
}

function parseEnvironmentKeys(value: string): Record<string, Buffer> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw vaultError("INVALID_KMS_KEYS", "KMS_KEYS_JSON must contain a JSON object");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw vaultError("INVALID_KMS_KEYS", "KMS_KEYS_JSON must contain a JSON object");
  }
  const keys: Record<string, Buffer> = {};
  for (const [keyId, encoded] of Object.entries(parsed)) {
    assertValidVaultKeyId(keyId);
    if (typeof encoded !== "string") {
      throw vaultError("INVALID_KMS_KEYS", "KMS key values must be base64 strings");
    }
    const key = decodeStrictBase64(encoded);
    if (key.length !== 32) {
      throw vaultError("INVALID_KMS_KEYS", "KMS key values must decode to 32 bytes");
    }
    keys[keyId] = key;
  }
  return keys;
}

class EnvironmentKeyResolver implements VaultKeyResolver {
  private readonly kms?: VaultKms;
  private readonly environment: Record<string, string | undefined>;
  private readonly explicitMasterKey?: string | Buffer;
  private resolved = false;
  private masterKey?: Buffer;
  private directKeys: Record<string, Buffer> = {};

  constructor(options: VaultOptions) {
    this.kms = options.kms;
    this.environment = options.environment ?? process.env;
    this.explicitMasterKey = options.masterKey;
  }

  async resolveKey(keyId: string): Promise<Buffer> {
    assertValidVaultKeyId(keyId);
    this.load();
    const direct = this.directKeys[keyId];
    if (direct) {
      return Buffer.from(direct);
    }
    if (this.kms) {
      const key = await this.kms.getKey(keyId);
      const resolved = normalizeMasterKey(key);
      if (resolved.length !== 32) {
        throw vaultError("INVALID_KMS_KEY", "KMS key must decode to 32 bytes");
      }
      return resolved;
    }
    if (this.masterKey) {
      return deriveKey(this.masterKey, keyId);
    }
    throw vaultError("KMS_KEY_NOT_FOUND", `No vault key is available for key ID '${keyId}'`, 404);
  }

  private load(): void {
    if (this.resolved) {
      return;
    }
    this.resolved = true;
    if (this.explicitMasterKey !== undefined) {
      this.masterKey = normalizeMasterKey(this.explicitMasterKey);
      return;
    }
    const encoded = this.environment.KMS_KEYS_JSON;
    if (encoded) {
      this.directKeys = parseEnvironmentKeys(encoded);
    }
    const master = this.environment.KMS_MASTER_KEY;
    if (!master) {
      return;
    }
    const trimmed = master.trim();
    if (trimmed.startsWith("{")) {
      this.directKeys = parseEnvironmentKeys(trimmed);
      return;
    }
    if (trimmed.includes(":")) {
      const separator = trimmed.indexOf(":");
      const keyId = trimmed.slice(0, separator);
      assertValidVaultKeyId(keyId);
      const key = decodeStrictBase64(trimmed.slice(separator + 1));
      if (key.length !== 32) {
        throw vaultError("INVALID_KMS_MASTER_KEY", "KMS key values must decode to 32 bytes");
      }
      this.directKeys[keyId] = key;
      return;
    }
    this.masterKey = normalizeMasterKey(trimmed);
  }
}

export function timingSafeStringEqual(left: string | Buffer, right: string | Buffer): boolean {
  const leftHash = createHash("sha256").update(left).digest();
  const rightHash = createHash("sha256").update(right).digest();
  return nodeTimingSafeEqual(leftHash, rightHash);
}

function normalizeFieldName(name: string): string {
  return name.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

function isSensitiveFieldName(name: string): boolean {
  const normalized = normalizeFieldName(name);
  if (SENSITIVE_FIELD_NAMES.has(normalized)) {
    return true;
  }
  return SENSITIVE_FIELD_PATTERN.test(normalized);
}

function redactText(text: string, literalSecrets: readonly string[]): string {
  const secrets = [...new Set(literalSecrets.filter((secret) => secret.length > 0))]
    .sort((left, right) => right.length - left.length);
  let redacted = text;
  for (const secret of secrets) {
    redacted = redacted.split(secret).join(REDACTED_VALUE);
  }
  // A Luhn-valid 12..19 digit card number embedded in a larger log line (JSON,
  // XML or a free-form message) is just as sensitive as a bare value.
  redacted = redacted.replace(/\d(?:[ -]?\d){11,18}/g, (candidate) =>
    looksLikePan(candidate) ? REDACTED_VALUE : candidate,
  );
  return redacted;
}

export class Vault {
  private readonly keyResolver: VaultKeyResolver;

  constructor(options: VaultOptions = {}) {
    this.keyResolver = options.keyResolver ?? new EnvironmentKeyResolver(options);
  }

  async encryptSecret(plaintext: string, keyId: string): Promise<string> {
    assertValidVaultKeyId(keyId);
    if (typeof plaintext !== "string") {
      throw vaultError("INVALID_PLAINTEXT", "Vault plaintext must be a string");
    }
    const key = await this.keyResolver.resolveKey(keyId);
    if (key.length !== 32) {
      throw vaultError("INVALID_KMS_KEY", "AES-256-GCM requires a 32-byte key");
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(keyId, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return [keyId, iv.toString("base64"), authTag.toString("base64"), ciphertext.toString("base64")].join(":");
  }

  async decryptSecret(payload: string): Promise<string> {
    if (typeof payload !== "string") {
      throw vaultError("INVALID_VAULT_PAYLOAD", "Vault payload must be a string");
    }
    const parts = payload.split(":");
    if (parts.length !== 4) {
      throw vaultError("INVALID_VAULT_PAYLOAD", "Vault payload must contain keyId:iv:authTag:ciphertext");
    }
    const [keyId, ivEncoded, authTagEncoded, ciphertextEncoded] = parts as [string, string, string, string];
    assertValidVaultKeyId(keyId);
    const iv = decodeStrictBase64(ivEncoded);
    const authTag = decodeStrictBase64(authTagEncoded);
    const ciphertext = decodeStrictBase64(ciphertextEncoded);
    if (iv.length !== 12 || authTag.length !== 16) {
      throw vaultError("INVALID_VAULT_PAYLOAD", "Vault IV or authentication tag has an invalid length");
    }
    const key = await this.keyResolver.resolveKey(keyId);
    if (key.length !== 32) {
      throw vaultError("INVALID_KMS_KEY", "AES-256-GCM requires a 32-byte key");
    }
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAAD(Buffer.from(keyId, "utf8"));
      decipher.setAuthTag(authTag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    } catch {
      throw vaultError("VAULT_AUTHENTICATION_FAILED", "Vault payload authentication failed", 400);
    }
  }

  redactPayload<T>(payload: T, literalSecrets: readonly string[] = []): T {
    const seen = new WeakMap<object, unknown>();
    const visit = (value: unknown, sensitive: boolean): unknown => {
      if (sensitive) {
        return REDACTED_VALUE;
      }
      if (typeof value === "string") {
        if (looksLikePan(value)) {
          return REDACTED_VALUE;
        }
        return redactText(value, literalSecrets);
      }
      if (value === null || typeof value !== "object") {
        return value;
      }
      if (value instanceof Date || value instanceof RegExp) {
        return value;
      }
      if (Buffer.isBuffer(value)) {
        return Buffer.from(redactText(value.toString("utf8"), literalSecrets), "utf8");
      }
      const previous = seen.get(value);
      if (previous !== undefined) {
        return "[Circular]";
      }
      if (Array.isArray(value)) {
        const output: unknown[] = [];
        seen.set(value, output);
        for (const item of value) {
          output.push(visit(item, false));
        }
        return output;
      }
      const output: Record<string, unknown> = {};
      seen.set(value, output);
      for (const [key, item] of Object.entries(value)) {
        output[key] = visit(item, isSensitiveFieldName(key));
      }
      return output as T;
    };
    return visit(payload, false) as T;
  }

  redactText(text: string, literalSecrets: readonly string[] = []): string {
    return redactText(text, literalSecrets);
  }
}

export const vault = new Vault();
