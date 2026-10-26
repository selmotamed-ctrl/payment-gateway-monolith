import { describe, expect, test } from "bun:test";
import { createHash, createHmac, generateKeyPairSync } from "node:crypto";
import {
  CryptoEngine,
  canonicalize,
  decodeCryptoKey,
  encodeHashOutput,
} from "../../engine/crypto/CryptoEngine";
import { Vault, timingSafeStringEqual } from "../../engine/crypto/Vault";

const engine = new CryptoEngine();

describe("CryptoEngine HMAC key encodings", () => {
  const payload = "amount=100&ref=MOCK-1";

  test("UTF8, HEX and BASE64 keys are decoded to their binary material", () => {
    const material = Buffer.from("secret-key");
    const utf8 = engine.hmacSha256("secret-key", payload, "UTF8");
    const hex = engine.hmacSha256(material.toString("hex"), payload, "HEX");
    const base = engine.hmacSha256(material.toString("base64"), payload, "BASE64");
    expect(utf8).toHaveLength(64);
    expect(hex).toHaveLength(64);
    expect(base).toHaveLength(64);
    expect(utf8).toBe(hex);
    expect(utf8).toBe(base);
    expect(utf8).toBe(createHmac("sha256", material).update(payload).digest("hex"));
  });

  test("different key material produces different signatures", () => {
    const utf8 = engine.hmacSha256("secret-key", payload, "UTF8");
    const other = engine.hmacSha256("other-key", payload, "UTF8");
    const hexOfOther = engine.hmacSha256(
      Buffer.from("other-key").toString("hex"),
      payload,
      "HEX",
    );
    expect(new Set([utf8, other, hexOfOther]).size).toBe(2);
  });

  test("HMAC SHA512 produces a 128 character digest", () => {
    expect(engine.hmacSha512("secret", payload)).toHaveLength(128);
  });

  test("output encodings are honoured", () => {
    const lower = engine.hmacSha256("secret", payload, "UTF8", "HEX_LOWER");
    const upper = engine.hmacSha256("secret", payload, "UTF8", "HEX_UPPER");
    const base64 = engine.hmacSha256("secret", payload, "UTF8", "BASE64");
    expect(lower).toBe(lower.toLowerCase());
    expect(upper).toBe(lower.toUpperCase());
    expect(Buffer.from(base64, "base64").toString("hex")).toBe(lower);
  });

  test("invalid hex and base64 keys are rejected", () => {
    expect(() => decodeCryptoKey("zz", "HEX")).toThrow();
    expect(() => decodeCryptoKey("abc", "BASE64")).toThrow();
  });
});

describe("CryptoEngine digests", () => {
  test("sha256 and sha512 match the node implementation", () => {
    expect(engine.sha256("abc")).toBe(createHash("sha256").update("abc").digest("hex"));
    expect(engine.sha512("abc")).toBe(createHash("sha512").update("abc").digest("hex"));
  });

  test("encodeHashOutput supports the three output encodings", () => {
    const digest = createHash("sha256").update("abc").digest();
    expect(encodeHashOutput(digest, "HEX_LOWER")).toBe(digest.toString("hex"));
    expect(encodeHashOutput(digest, "HEX_UPPER")).toBe(digest.toString("hex").toUpperCase());
    expect(encodeHashOutput(digest, "BASE64")).toBe(digest.toString("base64"));
  });
});

describe("CryptoEngine RSA SHA256", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

  test("signs and verifies with RSASSA-PKCS1-v1_5", () => {
    const signature = engine.rsaSha256Sign(privateKey.export({ type: "pkcs8", format: "pem" }) as string, "payload");
    expect(engine.rsaSha256Verify(
      publicKey.export({ type: "spki", format: "pem" }) as string,
      "payload",
      signature,
    )).toBe(true);
    expect(engine.rsaSha256Verify(
      publicKey.export({ type: "spki", format: "pem" }) as string,
      "tampered",
      signature,
    )).toBe(false);
  });

  test("supports hex and base64 signature encodings", () => {
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    const hex = engine.rsaSha256Sign(pem, "payload", "HEX_LOWER");
    expect(engine.rsaSha256Verify(
      publicKey.export({ type: "spki", format: "pem" }) as string,
      "payload",
      hex,
      "HEX_LOWER",
    )).toBe(true);
  });
});

describe("canonicalization modes", () => {
  test("SORTED_KEY_VALUE_AMP sorts keys and joins with ampersands", () => {
    const canonical = canonicalize("SORTED_KEY_VALUE_AMP", {
      fields: { TerminalId: "T-1", Amount: "100", MerchantId: "M-1" },
    });
    expect(canonical).toBe("Amount=100&MerchantId=M-1&TerminalId=T-1");
  });

  test("MOAMALAT_SECURE_HASH uses the sorted key value amp canonical form", () => {
    const fields = { Amount: "100000", DateTimeLocalTrxn: "202603041215", MerchantReference: "REF-1" };
    expect(canonicalize("MOAMALAT_SECURE_HASH", { fields })).toBe(
      canonicalize("SORTED_KEY_VALUE_AMP", { fields }),
    );
  });

  test("TIMESTAMP_DOT_RAW_BODY signs the timestamp, a dot, and the raw body", () => {
    expect(canonicalize("DPAY_WEBHOOK_VERIFY", { timestamp: "1700000000", rawBody: '{"a":1}' }))
      .toBe('1700000000.{"a":1}');
  });

  test("SORTED_VALUES_HASH drops the hashed key and joins the sorted values", () => {
    const canonical = canonicalize("PLUTU_CALLBACK_HASH", {
      fields: { amount: "100", hashed: "IGNORED", currency: "LYD" },
      excludedFields: ["hashed"],
    });
    expect(canonical).toBe("100LYD");
  });

  test("RAW_BODY returns the body unchanged", () => {
    expect(canonicalize("MYPAY_RAW_BODY", { rawBody: "raw-bytes" })).toBe("raw-bytes");
  });
});

describe("worked cryptographic signing profiles", () => {
  test("MOAMALAT_SECURE_HASH signs with a hex decoded key and uppercase hex output", () => {
    const keyHex = Buffer.from("moamalat-secret").toString("hex");
    const fields = { Amount: "100000", MerchantId: "MID-1" };
    const signature = engine.moamalatSecureHash(fields, keyHex, "HEX", "HEX_UPPER");
    expect(signature).toBe(
      createHmac("sha256", Buffer.from("moamalat-secret")).update("Amount=100000&MerchantId=MID-1").digest("hex").toUpperCase(),
    );
  });

  test("DPAY_WEBHOOK_VERIFY signs timestamp dot raw body", () => {
    const signature = engine.dpayWebhookVerify("1700000000", '{"status":"PAID"}', "webhook-secret");
    expect(signature).toBe(
      createHmac("sha256", "webhook-secret").update('1700000000.{"status":"PAID"}').digest("hex"),
    );
  });

  test("PLUTU_CALLBACK_HASH excludes the hashed field and uppercases the digest", () => {
    const signature = engine.plutuCallbackHash(
      { amount: "100", hashed: "IGNORED", currency: "LYD" },
      "plutu-secret",
      "UTF8",
      "HEX_UPPER",
    );
    expect(signature).toBe(
      createHmac("sha256", "plutu-secret").update("100LYD").digest("hex").toUpperCase(),
    );
  });

  test("MYPAY signs the raw body", () => {
    expect(engine.mypayRawBodyHash("raw-body", "mypay-secret")).toBe(
      createHmac("sha256", "mypay-secret").update("raw-body").digest("hex"),
    );
  });
});

describe("constant time comparison", () => {
  test("equal and unequal values compare correctly", () => {
    expect(engine.constantTimeEqual("abc", "abc")).toBe(true);
    expect(engine.constantTimeEqual("abc", "abd")).toBe(false);
    expect(engine.constantTimeEqual("abc", "abcd")).toBe(false);
    expect(timingSafeStringEqual("abc", "abc")).toBe(true);
  });
});

describe("Vault AES-256-GCM", () => {
  const masterKey = Buffer.alloc(32, 7).toString("base64");
  const vault = new Vault({ environment: { KMS_MASTER_KEY: masterKey } });

  test("encrypts to keyId:iv:authTag:ciphertext and decrypts back", async () => {
    const payload = await vault.encryptSecret("super-secret", "key-1");
    const parts = payload.split(":");
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe("key-1");
    expect(Buffer.from(parts[1] as string, "base64")).toHaveLength(12);
    expect(Buffer.from(parts[2] as string, "base64")).toHaveLength(16);
    expect(await vault.decryptSecret(payload)).toBe("super-secret");
  });

  test("produces a different ciphertext for every call", async () => {
    const first = await vault.encryptSecret("value", "key-1");
    const second = await vault.encryptSecret("value", "key-1");
    expect(first).not.toBe(second);
  });

  test("rejects a tampered ciphertext", async () => {
    const payload = await vault.encryptSecret("value", "key-1");
    const parts = payload.split(":");
    const tampered = [parts[0], parts[1], parts[2], Buffer.from("tampered").toString("base64")].join(":");
    await expect(vault.decryptSecret(tampered)).rejects.toThrow();
  });

  test("rejects a payload bound to a different key id", async () => {
    const payload = await vault.encryptSecret("value", "key-1");
    const parts = payload.split(":");
    const moved = ["key-2", parts[1], parts[2], parts[3]].join(":");
    await expect(vault.decryptSecret(moved)).rejects.toThrow();
  });

  test("rejects malformed payloads and invalid key ids", async () => {
    await expect(vault.decryptSecret("a:b:c")).rejects.toThrow();
    await expect(vault.encryptSecret("x", "bad key id")).rejects.toThrow();
    await expect(vault.encryptSecret("x", "a:b")).rejects.toThrow();
  });
});

describe("Vault payload redaction", () => {
  const vault = new Vault({ environment: { KMS_MASTER_KEY: Buffer.alloc(32, 3).toString("base64") } });

  test("redacts sensitive field names recursively", () => {
    const redacted = vault.redactPayload({
      password: "p",
      nested: { apiKey: "k", otp: "123456", safe: "visible" },
      list: [{ cvv: "999", pan: "4111111111111111" }],
    });
    expect(redacted.password).toBe("[REDACTED]");
    expect(redacted.nested.apiKey).toBe("[REDACTED]");
    expect(redacted.nested.otp).toBe("[REDACTED]");
    expect(redacted.nested.safe).toBe("visible");
    expect(redacted.list[0]?.cvv).toBe("[REDACTED]");
    expect(redacted.list[0]?.pan).toBe("[REDACTED]");
  });

  test("redacts literal secret values wherever they appear", () => {
    const redacted = vault.redactPayload(
      { header: "Authorization: Bearer abc123", note: "abc123 leaked" },
      ["abc123"],
    );
    expect(redacted.header).not.toContain("abc123");
    expect(redacted.note).not.toContain("abc123");
  });

  test("does not mutate the source payload", () => {
    const source = { password: "p" };
    vault.redactPayload(source);
    expect(source.password).toBe("p");
  });
});
