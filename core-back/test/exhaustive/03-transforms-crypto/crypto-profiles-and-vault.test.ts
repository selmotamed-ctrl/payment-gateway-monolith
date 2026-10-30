/**
 * Suite 03.3 — canonicalization, signing and the AES-256-GCM vault.
 *
 * The signing matrix is 10 canonicalization modes × 4 algorithms × 3 key
 * encodings × 3 output encodings × 4 payloads = 1,440 independent signatures,
 * each compared against an independent Node.js oracle.
 */
import { describe, expect, test } from "bun:test";
import { createHash, createHmac, createSign, generateKeyPairSync } from "node:crypto";
import {
  CryptoEngine,
  canonicalize,
  filterCanonicalFields,
  type CanonicalizationMode,
  type CryptoAlgorithm,
  type HashOutputEncoding,
  type KeyEncoding,
} from "../../../engine/crypto/CryptoEngine";
import {
  REDACTED_VALUE,
  Vault,
  assertValidVaultKeyId,
  timingSafeStringEqual,
} from "../../../engine/crypto/Vault";

const MODES: readonly CanonicalizationMode[] = [
  "SORTED_KEY_VALUE_AMP",
  "SORTED_VALUES_HASH",
  "TEMPLATE_STRING",
  "JSON_CANONICAL",
  "RAW_BODY",
  "TIMESTAMP_DOT_RAW_BODY",
  "MOAMALAT_SECURE_HASH",
  "DPAY_WEBHOOK_VERIFY",
  "PLUTU_CALLBACK_HASH",
  "MYPAY_RAW_BODY",
];

const ALGORITHMS: readonly CryptoAlgorithm[] = ["HMAC_SHA256", "HMAC_SHA512", "RSA_SHA256", "SHA256"];
const KEY_ENCODINGS: readonly KeyEncoding[] = ["UTF8", "HEX", "BASE64"];
const OUTPUT_ENCODINGS: readonly HashOutputEncoding[] = ["HEX_LOWER", "HEX_UPPER", "BASE64"];

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const SECRET = "secret";

interface Payload {
  name: string;
  fields: Record<string, unknown>;
  rawBody: string;
  timestamp: string;
  templateString: string;
  includedFields?: string[];
  excludedFields?: string[];
}

const PAYLOADS: readonly Payload[] = [
  {
    name: "basic",
    fields: { b: "two", a: 1, c: "three" },
    rawBody: '{"a":1,"b":"two"}',
    timestamp: "1700000000",
    templateString: "{{a}}-{{b}}-{{c}}",
  },
  {
    name: "nested",
    fields: { z: { b: 2, a: 1 }, m: [1, 2], a: "x", hashed: "IGNORED" },
    rawBody: '{"z":{"b":2,"a":1}}',
    timestamp: "1700000123",
    templateString: "{{z.a}}-{{a}}",
    excludedFields: ["hashed"],
  },
  {
    name: "unicode",
    fields: { name: "مرحبا", amount: "100.0000", empty: "" },
    rawBody: "raw-مرحبا",
    timestamp: "1700000456",
    templateString: "{{name}}:{{amount}}",
  },
  {
    name: "excluded",
    fields: { a: "1", secret: "s", hashed: "h", nested: { keep: true } },
    rawBody: "a=1&secret=s",
    timestamp: "1700000789",
    templateString: "{{a}}/{{nested.keep}}",
    includedFields: ["a", "nested", "hashed"],
    excludedFields: ["secret", "hashed"],
  },
];

const encodedKeys: Record<KeyEncoding, string> = {
  UTF8: SECRET,
  HEX: Buffer.from(SECRET, "utf8").toString("hex"),
  BASE64: Buffer.from(SECRET, "utf8").toString("base64"),
};

const decodeKey = (encoding: KeyEncoding): Buffer =>
  encoding === "UTF8"
    ? Buffer.from(SECRET)
    : encoding === "HEX"
      ? Buffer.from(encodedKeys.HEX, "hex")
      : Buffer.from(encodedKeys.BASE64, "base64");

const canonicalValue = (value: unknown): string => {
  if (value === null || value === undefined) {
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
};

const sortedObject = (value: unknown): unknown => {
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
};

const readPath = (fields: Record<string, unknown>, path: string): unknown => {
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
};

const oracleCanonical = (mode: CanonicalizationMode, payload: Payload): string => {
  const filtered = filterCanonicalFields(payload.fields, payload.includedFields, payload.excludedFields);
  switch (mode) {
    case "SORTED_KEY_VALUE_AMP":
    case "MOAMALAT_SECURE_HASH":
      return Object.keys(filtered)
        .sort()
        .map((key) => `${key}=${canonicalValue(filtered[key])}`)
        .join("&");
    case "SORTED_VALUES_HASH":
    case "PLUTU_CALLBACK_HASH": {
      const excluded = new Set([...(payload.excludedFields ?? ["hashed"])].map((key) => key.toLowerCase()));
      return Object.keys(filtered)
        .filter((key) => !excluded.has(key.toLowerCase()))
        .sort()
        .map((key) => canonicalValue(filtered[key]))
        .join("");
    }
    case "TEMPLATE_STRING":
      return payload.templateString.replace(/\{\{([A-Za-z0-9_.-]+)\}\}|\{([A-Za-z0-9_.-]+)\}/g, (_m, a, b) => {
        const value = readPath(filtered, String(a ?? b));
        return value === undefined || value === null ? "" : canonicalValue(value);
      });
    case "JSON_CANONICAL":
      return JSON.stringify(sortedObject(filtered));
    case "RAW_BODY":
    case "MYPAY_RAW_BODY":
      return payload.rawBody;
    case "TIMESTAMP_DOT_RAW_BODY":
    case "DPAY_WEBHOOK_VERIFY":
      return `${payload.timestamp}.${payload.rawBody}`;
    default:
      throw new Error(`Unhandled mode ${mode}`);
  }
};

const encode = (digest: Buffer, encoding: HashOutputEncoding): string =>
  encoding === "BASE64"
    ? digest.toString("base64")
    : encoding === "HEX_UPPER"
      ? digest.toString("hex").toUpperCase()
      : digest.toString("hex");

const oracleSignature = (
  algorithm: CryptoAlgorithm,
  canonical: string,
  keyEncoding: KeyEncoding,
  outputEncoding: HashOutputEncoding,
): string => {
  if (algorithm === "SHA256") {
    return encode(createHash("sha256").update(canonical).digest(), outputEncoding);
  }
  if (algorithm === "RSA_SHA256") {
    const signer = createSign("RSA-SHA256");
    signer.update(canonical);
    signer.end();
    const signature = signer.sign(privateKey);
    const effectiveEncoding = outputEncoding === "BASE64" ? "BASE64" : "HEX_LOWER";
    return encode(signature, effectiveEncoding);
  }
  const digestAlgorithm = algorithm === "HMAC_SHA512" ? "sha512" : "sha256";
  return encode(
    createHmac(digestAlgorithm, decodeKey(keyEncoding)).update(canonical).digest(),
    outputEncoding,
  );
};

const resolverFor = (keyEncoding: KeyEncoding) => ({
  resolveSecret: (reference: string): string => {
    if (reference === "private-key") {
      return privateKey;
    }
    return encodedKeys[keyEncoding];
  },
});

describe("Suite 03 · canonicalization modes", () => {
  for (const mode of MODES) {
    for (const payload of PAYLOADS) {
      test(`${mode} · ${payload.name} matches the independent canonical form`, () => {
        const actual = canonicalize(mode, {
          fields: payload.fields,
          rawBody: payload.rawBody,
          timestamp: payload.timestamp,
          templateString: payload.templateString,
          includedFields: payload.includedFields,
          excludedFields: payload.excludedFields,
        });
        expect(actual).toBe(oracleCanonical(mode, payload));
      });
    }
  }

  test("timestamp-dot-raw-body requires both inputs", () => {
    expect(() => canonicalize("TIMESTAMP_DOT_RAW_BODY", { rawBody: "x" })).toThrow();
  });

  test("template-string requires a template", () => {
    expect(() => canonicalize("TEMPLATE_STRING", { fields: {} })).toThrow();
  });

  test("raw-body requires a raw body", () => {
    expect(() => canonicalize("RAW_BODY", {})).toThrow();
  });
});

describe("Suite 03 · signing matrix (10 × 4 × 3 × 3 × 4)", () => {
  test("the matrix expands to 1,440 signatures", () => {
    expect(MODES.length * ALGORITHMS.length * KEY_ENCODINGS.length * OUTPUT_ENCODINGS.length * PAYLOADS.length).toBe(1440);
  });

  for (const mode of MODES) {
    for (const algorithm of ALGORITHMS) {
      for (const keyEncoding of KEY_ENCODINGS) {
        for (const outputEncoding of OUTPUT_ENCODINGS) {
          for (const payload of PAYLOADS) {
            test(`${mode} · ${algorithm} · key=${keyEncoding} · out=${outputEncoding} · ${payload.name}`, async () => {
              const engine = new CryptoEngine({ secretResolver: resolverFor(keyEncoding) });
              const canonical = oracleCanonical(mode, payload);
              const actual = await engine.signCanonicalPayload(
                algorithm,
                canonical,
                algorithm === "SHA256"
                  ? { outputEncoding }
                  : {
                    keyReference: algorithm === "RSA_SHA256" ? "private-key" : "test-key",
                    keyEncoding,
                    outputEncoding,
                  },
              );
              expect(actual).toBe(oracleSignature(algorithm, canonical, keyEncoding, outputEncoding));
            });
          }
        }
      }
    }
  }
});

describe("Suite 03 · official-style crypto helpers", () => {
  test("Moamalat secure hash uses a hex-decoded key and upper-case output", () => {
    const engine = new CryptoEngine();
    const key = Buffer.from(SECRET).toString("hex");
    const actual = engine.moamalatSecureHash({ b: "two", a: 1 }, key, "HEX", "HEX_UPPER");
    const expected = createHmac("sha256", Buffer.from(SECRET))
      .update("a=1&b=two")
      .digest("hex")
      .toUpperCase();
    expect(actual).toBe(expected);
  });

  test("DPay signs timestamp.raw_body and rejects a tampered timestamp", () => {
    const engine = new CryptoEngine();
    const signature = engine.dpayWebhookVerify("1700000000", "body", SECRET);
    expect(signature).toBe(createHmac("sha256", SECRET).update("1700000000.body").digest("hex"));
    expect(engine.dpayWebhookVerify("1700000001", "body", SECRET)).not.toBe(signature);
  });

  test("Plutu SORTED_VALUES_HASH excludes the hashed field", () => {
    const engine = new CryptoEngine();
    const actual = engine.plutuCallbackHash({ b: "two", a: 1, hashed: "IGNORED" }, SECRET);
    expect(actual).toBe(
      createHmac("sha256", SECRET).update("1two").digest("hex").toUpperCase(),
    );
  });

  test("MyPay signs the raw body", () => {
    const engine = new CryptoEngine();
    expect(engine.mypayRawBodyHash("raw", SECRET)).toBe(
      createHmac("sha256", SECRET).update("raw").digest("hex"),
    );
  });

  test("HMAC verification accepts the right signature and refuses a tampered body", () => {
    const engine = new CryptoEngine();
    const signature = engine.hmacSha256(SECRET, "body", "UTF8", "BASE64");
    expect(engine.verifyHmacSha256(SECRET, "body", signature, "UTF8", "BASE64")).toBe(true);
    expect(engine.verifyHmacSha256(SECRET, "body-tampered", signature, "UTF8", "BASE64")).toBe(false);
  });

  test("RSA signatures round-trip through the production verifier", () => {
    const engine = new CryptoEngine();
    const signature = engine.rsaSha256Sign(privateKey, "payload", "BASE64");
    expect(engine.rsaSha256Verify(publicKey, "payload", signature, "BASE64")).toBe(true);
    expect(engine.rsaSha256Verify(publicKey, "payload-tampered", signature, "BASE64")).toBe(false);
  });

  test("an invalid hex HMAC key is refused", () => {
    const engine = new CryptoEngine();
    expect(() => engine.hmacSha256("zz", "data", "HEX")).toThrow();
  });

  test("an invalid base64 HMAC key is refused", () => {
    const engine = new CryptoEngine();
    expect(() => engine.hmacSha256("not base64!!", "data", "BASE64")).toThrow();
  });
});

describe("Suite 03 · AES-256-GCM vault", () => {
  const masterKey = Buffer.alloc(32, 7);
  const vault = new Vault({ masterKey });

  for (const keyId of ["v1", "v2", "v3"]) {
    test(`encrypt/decrypt round-trip with key ${keyId}`, async () => {
      const plaintext = `secret-${keyId}-مرحبا-${"x".repeat(100)}`;
      const payload = await vault.encryptSecret(plaintext, keyId);
      expect(payload.startsWith(`${keyId}:`)).toBe(true);
      expect(await vault.decryptSecret(payload)).toBe(plaintext);
    });

    test(`a tampered IV under key ${keyId} is refused`, async () => {
      const payload = await vault.encryptSecret("data", keyId);
      const [id, iv, tag, cipher] = payload.split(":");
      const tampered = [id, Buffer.from(Buffer.from(iv as string, "base64").reverse()).toString("base64"), tag, cipher].join(":");
      await expect(vault.decryptSecret(tampered)).rejects.toThrow();
    });

    test(`a tampered auth tag under key ${keyId} is refused`, async () => {
      const payload = await vault.encryptSecret("data", keyId);
      const [id, iv, tag, cipher] = payload.split(":");
      const tagBuffer = Buffer.from(tag as string, "base64");
      tagBuffer[0] = (tagBuffer[0] ?? 0) ^ 0xff;
      await expect(vault.decryptSecret([id, iv, tagBuffer.toString("base64"), cipher].join(":"))).rejects.toThrow();
    });

    test(`a tampered ciphertext under key ${keyId} is refused`, async () => {
      const payload = await vault.encryptSecret("data", keyId);
      const [id, iv, tag, cipher] = payload.split(":");
      const cipherBuffer = Buffer.from(cipher as string, "base64");
      cipherBuffer[0] = (cipherBuffer[0] ?? 0) ^ 0xff;
      await expect(vault.decryptSecret([id, iv, tag, cipherBuffer.toString("base64")].join(":"))).rejects.toThrow();
    });

    test(`re-labelling the key id under ${keyId} breaks the AAD`, async () => {
      const payload = await vault.encryptSecret("data", keyId);
      const [, iv, tag, cipher] = payload.split(":");
      const other = keyId === "v1" ? "v2" : "v1";
      await expect(vault.decryptSecret([other, iv, tag, cipher].join(":"))).rejects.toThrow();
    });
  }

  test("a different master key cannot decrypt the payload", async () => {
    const payload = await vault.encryptSecret("data", "v1");
    const other = new Vault({ masterKey: Buffer.alloc(32, 9) });
    await expect(other.decryptSecret(payload)).rejects.toThrow();
  });

  test("a rotated vault with the same master key decrypts", async () => {
    const payload = await vault.encryptSecret("rotated", "v1");
    const rotated = new Vault({ masterKey });
    expect(await rotated.decryptSecret(payload)).toBe("rotated");
  });

  const directKeys = {
    v1: Buffer.alloc(32, 1).toString("base64"),
    v2: Buffer.alloc(32, 2).toString("base64"),
  };
  const environmentVault = new Vault({
    environment: { KMS_KEYS_JSON: JSON.stringify(directKeys) },
  });
  for (const keyId of ["v1", "v2"]) {
    test(`KMS_KEYS_JSON resolver supports ${keyId}`, async () => {
      const payload = await environmentVault.encryptSecret("env", keyId);
      expect(await environmentVault.decryptSecret(payload)).toBe("env");
    });
  }

  test("a malformed payload is refused", async () => {
    await expect(vault.decryptSecret("not-a-payload")).rejects.toThrow();
  });

  test("an invalid key id is refused", () => {
    for (const keyId of ["", " ", "has:colon", "../x", "a".repeat(65)]) {
      expect(() => assertValidVaultKeyId(keyId)).toThrow();
    }
  });

  test("timingSafeStringEqual compares correctly", () => {
    expect(timingSafeStringEqual("abc", "abc")).toBe(true);
    expect(timingSafeStringEqual("abc", "abd")).toBe(false);
  });
});

describe("Suite 03 · vault redaction", () => {
  const vault = new Vault({ masterKey: Buffer.alloc(32, 7) });
  const sensitiveKeys = [
    "password",
    "passwd",
    "secret",
    "token",
    "accessToken",
    "refresh_token",
    "otp",
    "cvv",
    "pan",
    "authorization",
    "apiKey",
    "webhook_secret",
    "client_secret",
    "private_key",
    "api_secret",
    "signing_key",
    "card_number",
    "iban",
    "pin",
    "session",
  ];

  for (const key of sensitiveKeys) {
    test(`field '${key}' is redacted`, () => {
      const redacted = vault.redactPayload({ [key]: "super-secret-value", keep: "visible" }, []);
      expect((redacted as Record<string, unknown>)[key]).toBe(REDACTED_VALUE);
      expect((redacted as Record<string, unknown>).keep).toBe("visible");
    });
  }

  const literalSecrets = ["hunter2", "sk_live_abcdef", "my-signing-secret"];
  for (const secret of literalSecrets) {
    test(`literal secret '${secret}' is scrubbed from nested values`, () => {
      const redacted = vault.redactPayload(
        { a: `prefix ${secret} suffix`, nested: { b: [secret, "safe"] } },
        literalSecrets,
      ) as { a: string; nested: { b: string[] } };
      expect(redacted.a).not.toContain(secret);
      expect(redacted.nested.b[0]).toBe(REDACTED_VALUE);
      expect(redacted.nested.b[1]).toBe("safe");
    });
  }

  const pans = [
    "4111111111111111",
    "5500005555555559",
    "4012888888881881",
    "5555555555554444",
    "378282246310005",
    "6011111111111117",
    "3530111333300000",
    "4222222222222",
    "4111 1111 1111 1111",
    "4111-1111-1111-1111",
  ];
  for (const pan of pans) {
    test(`Luhn-valid PAN ${pan} is redacted inside a nested payload`, () => {
      const redacted = vault.redactPayload({ note: `card=${pan}`, nested: [pan] }, []) as {
        note: string;
        nested: string[];
      };
      expect(redacted.note).not.toContain(pan);
      expect(redacted.nested[0]).toBe(REDACTED_VALUE);
    });
  }

  test("a PAN inside an XML log line is redacted", () => {
    const xml = `<log><pan>4111111111111111</pan><amount>100</amount></log>`;
    const redacted = vault.redactText(xml, []);
    expect(redacted).not.toContain("4111111111111111");
  });

  test("a non-Luhn number is not treated as a PAN", () => {
    const redacted = vault.redactPayload({ note: "order 123456789012" }, []) as { note: string };
    expect(redacted.note).toBe("order 123456789012");
  });

  test("circular payloads are redacted without infinite recursion", () => {
    const node: Record<string, unknown> = { password: "x" };
    node.self = node;
    const redacted = vault.redactPayload(node, []) as Record<string, unknown>;
    expect(redacted.password).toBe(REDACTED_VALUE);
    expect(redacted.self).toBe("[Circular]");
  });

  test("buffers are scrubbed", () => {
    const redacted = vault.redactPayload({ data: Buffer.from("token hunter2") }, ["hunter2"]) as {
      data: Buffer;
    };
    expect(redacted.data.toString("utf8")).not.toContain("hunter2");
  });
});
