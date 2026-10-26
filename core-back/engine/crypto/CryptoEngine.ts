import { createHash, createHmac, createSign, createVerify, timingSafeEqual as nodeTimingSafeEqual } from "node:crypto";
import { timingSafeStringEqual } from "./Vault";

export type KeyEncoding = "UTF8" | "HEX" | "BASE64";
export type HashOutputEncoding = "HEX_LOWER" | "HEX_UPPER" | "BASE64";
export type CanonicalizationMode =
  | "MOAMALAT_SECURE_HASH"
  | "DPAY_WEBHOOK_VERIFY"
  | "PLUTU_CALLBACK_HASH"
  | "MYPAY_RAW_BODY"
  | "SORTED_KEY_VALUE_AMP"
  | "TIMESTAMP_DOT_RAW_BODY"
  | "SORTED_VALUES_HASH"
  | "TEMPLATE_STRING"
  | "JSON_CANONICAL"
  | "RAW_BODY";

export type CryptoAlgorithm = "HMAC_SHA256" | "HMAC_SHA512" | "RSA_SHA256" | "SHA256";

export interface CryptoSecretResolver {
  resolveSecret(reference: string): Promise<string | Buffer> | string | Buffer;
}

export interface CanonicalizationInput {
  fields?: Record<string, unknown>;
  rawBody?: string | Buffer;
  timestamp?: string | number;
  includedFields?: readonly string[];
  excludedFields?: readonly string[];
  templateString?: string;
  valueSeparator?: string;
}

export interface CanonicalSignOptions extends CanonicalizationInput {
  keyEncoding?: KeyEncoding;
  outputEncoding?: HashOutputEncoding;
}

export interface CryptoEngineOptions {
  secretResolver?: CryptoSecretResolver;
}

function decodeHexKey(value: string): Buffer {
  if (value.length === 0 || value.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(value)) {
    throw new Error("Invalid hexadecimal HMAC key");
  }
  return Buffer.from(value, "hex");
}

function decodeBase64Key(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new Error("Invalid base64 HMAC key");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new Error("Invalid base64 HMAC key");
  }
  return decoded;
}

export function decodeCryptoKey(key: string | Buffer, encoding: KeyEncoding = "UTF8"): Buffer {
  if (typeof key !== "string" && !Buffer.isBuffer(key)) {
    throw new Error("HMAC key must be a string or buffer");
  }
  if (Buffer.isBuffer(key)) {
    return Buffer.from(key);
  }
  if (encoding === "UTF8") {
    return Buffer.from(key, "utf8");
  }
  if (encoding === "HEX") {
    return decodeHexKey(key);
  }
  return decodeBase64Key(key);
}

export function encodeHashOutput(value: Buffer, encoding: HashOutputEncoding = "HEX_LOWER"): string {
  if (encoding === "BASE64") {
    return value.toString("base64");
  }
  if (encoding === "HEX_UPPER") {
    return value.toString("hex").toUpperCase();
  }
  return value.toString("hex");
}

function canonicalValue(value: unknown): string {
  if (value === null) {
    return "";
  }
  if (value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return String(value);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return JSON.stringify(value);
}

function sortedKeyValueAmp(fields: Record<string, unknown>): string {
  return Object.keys(fields)
    .sort()
    .map((key) => `${key}=${canonicalValue(fields[key])}`)
    .join("&");
}

/**
 * Applies the `included_fields` / `excluded_fields` recipe of a crypto
 * profile. An empty inclusion list keeps every field; the exclusion list
 * always wins over the inclusion list.
 */
export function filterCanonicalFields(
  fields: Record<string, unknown>,
  includedFields?: readonly string[],
  excludedFields?: readonly string[],
): Record<string, unknown> {
  const excluded = new Set((excludedFields ?? []).map((field) => field.toLowerCase()));
  const included = includedFields && includedFields.length > 0
    ? new Set(includedFields.map((field) => field.toLowerCase()))
    : null;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(fields)) {
    const normalized = key.toLowerCase();
    if (excluded.has(normalized)) {
      continue;
    }
    if (included && !included.has(normalized)) {
      continue;
    }
    output[key] = fields[key];
  }
  return output;
}

function sortedObject(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortedObject);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    output[key] = sortedObject((value as Record<string, unknown>)[key]);
  }
  return output;
}

function readFieldPath(fields: Record<string, unknown>, path: string): unknown {
  if (Object.prototype.hasOwnProperty.call(fields, path)) {
    return fields[path];
  }
  let current: unknown = fields;
  for (const segment of path.split(".")) {
    if (!current || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function renderTemplateString(template: string, fields: Record<string, unknown>): string {
  return template.replace(
    /\{\{([A-Za-z0-9_.-]+)\}\}|\{([A-Za-z0-9_.-]+)\}/g,
    (_match, doubleKey: string | undefined, singleKey: string | undefined) => {
      const path = String(doubleKey ?? singleKey ?? "");
      const value = readFieldPath(fields, path);
      return value === undefined || value === null ? "" : canonicalValue(value);
    },
  );
}

function sortedValuesHash(
  fields: Record<string, unknown>,
  excludedFields: readonly string[],
  valueSeparator: string,
): string {
  const excluded = new Set(excludedFields.map((field) => field.toLowerCase()));
  return Object.keys(fields)
    .filter((key) => !excluded.has(key.toLowerCase()))
    .sort()
    .map((key) => canonicalValue(fields[key]))
    .join(valueSeparator);
}

export function canonicalize(
  mode: CanonicalizationMode,
  input: CanonicalizationInput = {},
): string {
  const fields = input.fields ?? {};
  if (mode === "MOAMALAT_SECURE_HASH" || mode === "SORTED_KEY_VALUE_AMP") {
    return sortedKeyValueAmp(filterCanonicalFields(fields, input.includedFields, input.excludedFields));
  }
  if (mode === "DPAY_WEBHOOK_VERIFY" || mode === "TIMESTAMP_DOT_RAW_BODY") {
    if (input.timestamp === undefined || input.rawBody === undefined) {
      throw new Error("Timestamp and raw body are required for timestamp-dot-raw-body canonicalization");
    }
    const rawBody = Buffer.isBuffer(input.rawBody) ? input.rawBody : Buffer.from(input.rawBody, "utf8");
    return `${String(input.timestamp)}.${rawBody.toString("utf8")}`;
  }
  if (mode === "PLUTU_CALLBACK_HASH" || mode === "SORTED_VALUES_HASH") {
    return sortedValuesHash(
      filterCanonicalFields(fields, input.includedFields),
      input.excludedFields ?? ["hashed"],
      input.valueSeparator ?? "",
    );
  }
  if (mode === "TEMPLATE_STRING") {
    if (input.templateString === undefined) {
      throw new Error("A template string is required for template-string canonicalization");
    }
    const source = filterCanonicalFields(fields, input.includedFields, input.excludedFields);
    return renderTemplateString(input.templateString, source);
  }
  if (mode === "JSON_CANONICAL") {
    const source = filterCanonicalFields(fields, input.includedFields, input.excludedFields);
    return JSON.stringify(sortedObject(source));
  }
  if (input.rawBody === undefined) {
    throw new Error("Raw body is required for raw-body canonicalization");
  }
  return Buffer.isBuffer(input.rawBody) ? input.rawBody.toString("utf8") : input.rawBody;
}

export class CryptoEngine {
  private readonly secretResolver?: CryptoSecretResolver;

  constructor(options: CryptoEngineOptions = {}) {
    this.secretResolver = options.secretResolver;
  }

  /**
   * The canonical form of a payload for the declarative signing recipes.
   */
  static canonicalize(mode: CanonicalizationMode, input: CanonicalizationInput = {}): string {
    return canonicalize(mode, input);
  }

  /**
   * Signs an already canonicalized payload with the algorithm of a crypto
   * profile. The secret material is resolved through the configured secret
   * resolver; `SHA256` needs no key at all.
   */
  async signCanonicalPayload(
    algorithm: CryptoAlgorithm,
    canonical: string | Buffer,
    options: {
      keyReference?: string | null;
      keyEncoding?: KeyEncoding;
      outputEncoding?: HashOutputEncoding;
    } = {},
  ): Promise<string> {
    const outputEncoding = options.outputEncoding ?? "HEX_LOWER";
    if (algorithm === "SHA256") {
      return this.sha256(canonical, outputEncoding);
    }
    if (!options.keyReference) {
      throw new Error("A secret key reference is required to sign canonical data");
    }
    if (!this.secretResolver) {
      throw new Error("A secret resolver is required to sign canonical data");
    }
    const key = await this.secretResolver.resolveSecret(options.keyReference);
    if (algorithm === "RSA_SHA256") {
      return this.rsaSha256Sign(key, canonical, outputEncoding === "BASE64" ? "BASE64" : "HEX_LOWER");
    }
    const keyEncoding = options.keyEncoding ?? "UTF8";
    return algorithm === "HMAC_SHA512"
      ? this.hmacSha512(key, canonical, keyEncoding, outputEncoding)
      : this.hmacSha256(key, canonical, keyEncoding, outputEncoding);
  }

  hmacSha256(
    key: string | Buffer,
    data: string | Buffer,
    keyEncoding: KeyEncoding = "UTF8",
    outputEncoding: HashOutputEncoding = "HEX_LOWER",
  ): string {
    const digest = createHmac("sha256", decodeCryptoKey(key, keyEncoding)).update(data).digest();
    return encodeHashOutput(digest, outputEncoding);
  }

  hmacSha512(
    key: string | Buffer,
    data: string | Buffer,
    keyEncoding: KeyEncoding = "UTF8",
    outputEncoding: HashOutputEncoding = "HEX_LOWER",
  ): string {
    const digest = createHmac("sha512", decodeCryptoKey(key, keyEncoding)).update(data).digest();
    return encodeHashOutput(digest, outputEncoding);
  }

  sha256(data: string | Buffer, outputEncoding: HashOutputEncoding = "HEX_LOWER"): string {
    return encodeHashOutput(createHash("sha256").update(data).digest(), outputEncoding);
  }

  sha512(data: string | Buffer, outputEncoding: HashOutputEncoding = "HEX_LOWER"): string {
    return encodeHashOutput(createHash("sha512").update(data).digest(), outputEncoding);
  }

  rsaSha256Sign(
    privateKey: string | Buffer,
    data: string | Buffer,
    outputEncoding: HashOutputEncoding = "BASE64",
  ): string {
    const signer = createSign("RSA-SHA256");
    signer.update(data);
    signer.end();
    const signature = signer.sign(privateKey);
    return encodeHashOutput(signature, outputEncoding);
  }

  rsaSha256Verify(
    publicKey: string | Buffer,
    data: string | Buffer,
    signature: string | Buffer,
    signatureEncoding: HashOutputEncoding = "BASE64",
  ): boolean {
    const signatureBuffer = Buffer.isBuffer(signature)
      ? signature
      : signatureEncoding === "BASE64"
        ? Buffer.from(signature, "base64")
        : Buffer.from(signature, "hex");
    const verifier = createVerify("RSA-SHA256");
    verifier.update(data);
    verifier.end();
    return verifier.verify(publicKey, signatureBuffer);
  }

  constantTimeEqual(left: string | Buffer, right: string | Buffer): boolean {
    return timingSafeStringEqual(left, right);
  }

  async signCanonical(
    mode: CanonicalizationMode,
    keyReference: string,
    input: CanonicalizationInput = {},
    options: CanonicalSignOptions = {},
  ): Promise<string> {
    if (!this.secretResolver) {
      throw new Error("A secret resolver is required to sign canonical data");
    }
    const key = await this.secretResolver.resolveSecret(keyReference);
    const canonical = canonicalize(mode, input);
    const keyEncoding = options.keyEncoding ?? "UTF8";
    const outputEncoding = options.outputEncoding ?? "HEX_LOWER";
    return mode === "DPAY_WEBHOOK_VERIFY" || mode === "TIMESTAMP_DOT_RAW_BODY"
      ? this.hmacSha256(key, canonical, keyEncoding, outputEncoding)
      : this.hmacSha256(key, canonical, keyEncoding, outputEncoding);
  }

  moamalatSecureHash(
    fields: Record<string, unknown>,
    key: string | Buffer,
    keyEncoding: KeyEncoding = "HEX",
    outputEncoding: HashOutputEncoding = "HEX_UPPER",
  ): string {
    return this.hmacSha256(
      key,
      canonicalize("MOAMALAT_SECURE_HASH", { fields }),
      keyEncoding,
      outputEncoding,
    );
  }

  dpayWebhookVerify(
    timestamp: string | number,
    rawBody: string | Buffer,
    key: string | Buffer,
    keyEncoding: KeyEncoding = "UTF8",
    outputEncoding: HashOutputEncoding = "HEX_LOWER",
  ): string {
    return this.hmacSha256(
      key,
      canonicalize("DPAY_WEBHOOK_VERIFY", { timestamp, rawBody }),
      keyEncoding,
      outputEncoding,
    );
  }

  plutuCallbackHash(
    fields: Record<string, unknown>,
    key: string | Buffer,
    keyEncoding: KeyEncoding = "UTF8",
    outputEncoding: HashOutputEncoding = "HEX_UPPER",
  ): string {
    return this.hmacSha256(
      key,
      canonicalize("PLUTU_CALLBACK_HASH", { fields }),
      keyEncoding,
      outputEncoding,
    );
  }

  mypayRawBodyHash(
    rawBody: string | Buffer,
    key: string | Buffer,
    keyEncoding: KeyEncoding = "UTF8",
    outputEncoding: HashOutputEncoding = "HEX_LOWER",
  ): string {
    return this.hmacSha256(key, rawBody, keyEncoding, outputEncoding);
  }

  verifyHmacSha256(
    key: string | Buffer,
    data: string | Buffer,
    expectedSignature: string,
    keyEncoding: KeyEncoding = "UTF8",
    signatureEncoding: HashOutputEncoding = "HEX_LOWER",
  ): boolean {
    const expected = Buffer.isBuffer(expectedSignature)
      ? expectedSignature
      : signatureEncoding === "BASE64"
        ? Buffer.from(expectedSignature, "base64")
        : Buffer.from(expectedSignature, "hex");
    const actual = createHmac("sha256", decodeCryptoKey(key, keyEncoding)).update(data).digest();
    return actual.length === expected.length && nodeTimingSafeEqual(actual, expected);
  }
}
