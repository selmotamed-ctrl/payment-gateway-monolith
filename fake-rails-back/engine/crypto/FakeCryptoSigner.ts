import { createHash, createHmac, createSign, createVerify, timingSafeEqual } from "node:crypto";

export type CryptoAlgorithm = "HMAC_SHA256" | "HMAC_SHA512" | "RSA_SHA256" | "SHA256";
export type SecretKeyEncoding = "UTF8" | "HEX" | "BASE64";
export type CanonicalizationMode =
  | "SORTED_KEY_VALUE_AMP"
  | "SORTED_VALUES_HASH"
  | "TEMPLATE_STRING"
  | "JSON_CANONICAL"
  | "RAW_BODY"
  | "TIMESTAMP_DOT_RAW_BODY";
export type OutputEncoding = "HEX_LOWER" | "HEX_UPPER" | "BASE64";

export interface SigningRecipe {
  algorithm: CryptoAlgorithm;
  canonicalizationMode: CanonicalizationMode;
  secret: string | Buffer;
  secretKeyEncoding?: SecretKeyEncoding;
  outputEncoding?: OutputEncoding;
  templateString?: string;
  includedFields?: string[];
  excludedFields?: string[];
}

const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
};

const toPairs = (payload: Record<string, unknown>): Array<[string, string]> =>
  Object.entries(payload)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => [key, typeof value === "object" ? JSON.stringify(value) : String(value)]);

export const canonicalize = (
  mode: CanonicalizationMode,
  payload: unknown,
  options: { rawBody?: string; timestamp?: string; template?: string; includedFields?: string[]; excludedFields?: string[] } = {},
): string => {
  const record =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : { value: payload };
  const excluded = new Set(options.excludedFields ?? []);
  const filtered =
    options.includedFields && options.includedFields.length > 0
      ? Object.fromEntries(Object.entries(record).filter(([key]) => options.includedFields!.includes(key)))
      : Object.fromEntries(Object.entries(record).filter(([key]) => !excluded.has(key)));

  switch (mode) {
    case "SORTED_KEY_VALUE_AMP":
      return toPairs(filtered)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => `${key}=${value}`)
        .join("&");
    case "SORTED_VALUES_HASH":
      return toPairs(filtered)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, value]) => value)
        .join("");
    case "TEMPLATE_STRING":
      return (options.template ?? "").replace(/\{\{?([A-Za-z0-9_.-]+)\}?\}/g, (_match, key: string) =>
        String(key.split(".").reduce<unknown>((value, part) => (value as Record<string, unknown>)?.[part], filtered) ?? ""),
      );
    case "JSON_CANONICAL":
      return JSON.stringify(sortKeys(filtered));
    case "TIMESTAMP_DOT_RAW_BODY":
      return `${options.timestamp ?? ""}.${options.rawBody ?? (typeof payload === "string" ? payload : JSON.stringify(payload))}`;
    case "RAW_BODY":
    default:
      return options.rawBody ?? (typeof payload === "string" ? payload : JSON.stringify(payload));
  }
};

const secretBuffer = (secret: string | Buffer, encoding: SecretKeyEncoding = "UTF8"): Buffer => {
  if (Buffer.isBuffer(secret)) return secret;
  switch (encoding) {
    case "HEX": return Buffer.from(secret, "hex");
    case "BASE64": return Buffer.from(secret, "base64");
    case "UTF8":
    default: return Buffer.from(secret, "utf8");
  }
};

const encodeOutput = (value: Buffer, encoding: OutputEncoding = "HEX_LOWER"): string => {
  switch (encoding) {
    case "HEX_UPPER": return value.toString("hex").toUpperCase();
    case "BASE64": return value.toString("base64");
    case "HEX_LOWER":
    default: return value.toString("hex");
  }
};

export const sign = (
  recipe: SigningRecipe,
  payload: unknown,
  options: { rawBody?: string; timestamp?: string } = {},
): string => {
  const canonical = canonicalize(recipe.canonicalizationMode, payload, {
    rawBody: options.rawBody,
    timestamp: options.timestamp,
    template: recipe.templateString,
    includedFields: recipe.includedFields,
    excludedFields: recipe.excludedFields,
  });
  const key = secretBuffer(recipe.secret, recipe.secretKeyEncoding);

  switch (recipe.algorithm) {
    case "HMAC_SHA256":
      return encodeOutput(createHmac("sha256", key).update(canonical).digest(), recipe.outputEncoding);
    case "HMAC_SHA512":
      return encodeOutput(createHmac("sha512", key).update(canonical).digest(), recipe.outputEncoding);
    case "RSA_SHA256": {
      const signer = createSign("RSA-SHA256");
      signer.update(canonical);
      signer.end();
      return encodeOutput(signer.sign(key), recipe.outputEncoding ?? "BASE64");
    }
    case "SHA256":
    default:
      return encodeOutput(createHash("sha256").update(canonical).digest(), recipe.outputEncoding);
  }
};

export const verify = (
  recipe: SigningRecipe,
  payload: unknown,
  expected: string,
  options: { rawBody?: string; timestamp?: string } = {},
): boolean => {
  try {
    const canonical = canonicalize(recipe.canonicalizationMode, payload, {
      rawBody: options.rawBody,
      timestamp: options.timestamp,
      template: recipe.templateString,
      includedFields: recipe.includedFields,
      excludedFields: recipe.excludedFields,
    });
    if (recipe.algorithm === "RSA_SHA256") {
      const verifier = createVerify("RSA-SHA256");
      verifier.update(canonical);
      verifier.end();
      return verifier.verify(recipe.secret, Buffer.from(expected, "base64"));
    }
    const computed = sign(recipe, payload, options);
    const left = Buffer.from(computed);
    const right = Buffer.from(expected);
    return left.length === right.length && timingSafeEqual(left, right);
  } catch {
    return false;
  }
};

/**
 * Deterministic secret derivation shared with `core-back`'s `seedFakeRails.ts`.
 * Both sides derive the same gateway/webhook secret from the seeder token, so
 * signatures computed by the gateway verify here and vice versa — with no
 * bypassed security check on either side.
 */
export const deriveSecret = (seederToken: string, gatewayCode: string, purpose: string): string =>
  createHmac("sha256", seederToken)
    .update(`fake-rails:${gatewayCode}:${purpose}`)
    .digest("hex");

export const deriveOtp = (seed: string, railCode: string, reference: string, length: number): string => {
  const digest = createHash("sha256").update(`${seed}:${railCode}:${reference}`).digest("hex");
  const numeric = BigInt(`0x${digest.slice(0, 16)}`).toString().padStart(length, "0");
  return numeric.slice(0, length);
};
