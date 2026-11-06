import { afterAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { promises as nodeFs } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  DecryptStream,
  EncryptStream,
  HEADER_BYTES,
  IV_BYTES,
  SALT_BYTES,
  TAG_BYTES,
  derivePayloadKey,
  deriveManifestKey,
  masterKeyFromHex,
  openToBuffer,
  openToFile,
  sealBuffer,
  sealFile,
  signManifest,
  signText,
  verifyManifestSignature,
  verifyTextSignature,
  type BackupManifest,
} from "../src/cryptoEnvelope";
import { ENCRYPTION_KEY_HEX, tempDir } from "./helpers";

const master = masterKeyFromHex(ENCRYPTION_KEY_HEX);
const dirs: string[] = [];
const scratch = async (): Promise<string> => {
  const dir = await tempDir("bd-crypto-");
  dirs.push(dir);
  return dir;
};
afterAll(async () => {
  for (const dir of dirs) await nodeFs.rm(dir, { recursive: true, force: true });
});

const context = (target = "postgres_core", id = "bkp_1") => ({ master, target, id });

describe("HKDF key derivation", () => {
  test("is deterministic for identical inputs", () => {
    const salt = Buffer.alloc(SALT_BYTES, 7);
    expect(derivePayloadKey(master, salt, "postgres_core", "bkp_1").equals(derivePayloadKey(master, salt, "postgres_core", "bkp_1"))).toBe(true);
    expect(derivePayloadKey(master, salt, "postgres_core", "bkp_1")).toHaveLength(32);
  });

  test("is domain separated by target, backup id, salt and master key", () => {
    const salt = Buffer.alloc(SALT_BYTES, 7);
    const base = derivePayloadKey(master, salt, "postgres_core", "bkp_1");
    const variants = [
      derivePayloadKey(master, salt, "audit_db", "bkp_1"),
      derivePayloadKey(master, salt, "redis", "bkp_1"),
      derivePayloadKey(master, salt, "postgres_core", "bkp_2"),
      derivePayloadKey(master, Buffer.alloc(SALT_BYTES, 8), "postgres_core", "bkp_1"),
      derivePayloadKey(randomBytes(32), salt, "postgres_core", "bkp_1"),
    ];
    for (const variant of variants) expect(variant.equals(base)).toBe(false);
    expect(new Set(variants.map((key) => key.toString("hex"))).size).toBe(variants.length);
  });

  test("the manifest signing key is distinct from every payload key", () => {
    expect(deriveManifestKey(master).equals(derivePayloadKey(master, Buffer.alloc(SALT_BYTES), "catalog", "x"))).toBe(false);
  });

  test("rejects short or malformed master keys", () => {
    expect(() => masterKeyFromHex("abcd")).toThrow();
    expect(() => masterKeyFromHex("zz".repeat(16))).toThrow();
    expect(() => masterKeyFromHex("a".repeat(33))).toThrow();
  });
});

describe("streaming encrypt / decrypt round trip", () => {
  test("a multi-megabyte, partly compressible payload survives seal + open and is not visible in the ciphertext", async () => {
    const dir = await scratch();
    const plain = Buffer.concat([randomBytes(3 * 1024 * 1024), Buffer.alloc(2 * 1024 * 1024, 0x41), Buffer.from("TAIL-MARKER-0123456789")]);
    const src = join(dir, "plain.bin");
    await nodeFs.writeFile(src, plain);
    const sealed = join(dir, "plain.bin.enc");
    const result = await sealFile(src, sealed, context());

    expect(result.uncompressedBytes).toBe(plain.length);
    expect(result.compressedBytes).toBeLessThan(plain.length); // the 2 MiB of 'A' compressed away
    expect(result.compressedBytes).toBe((await nodeFs.stat(sealed)).size);
    expect(result.ivHex).toHaveLength(IV_BYTES * 2);
    expect(result.authTagHex).toHaveLength(TAG_BYTES * 2);
    expect(result.sha256Plaintext).toHaveLength(64);
    const ciphertext = await nodeFs.readFile(sealed);
    expect(ciphertext.includes(Buffer.from("TAIL-MARKER"))).toBe(false);

    const restored = join(dir, "restored.bin");
    const opened = await openToFile(sealed, restored, context());
    expect(opened.sha256Plaintext).toBe(result.sha256Plaintext);
    expect((await nodeFs.readFile(restored)).equals(plain)).toBe(true);
  });

  test("two seals of the same data differ (fresh salt and IV every time)", async () => {
    const dir = await scratch();
    const a = join(dir, "a.enc");
    const b = join(dir, "b.enc");
    const first = await sealBuffer(Buffer.from("same data"), a, context());
    const second = await sealBuffer(Buffer.from("same data"), b, context());
    expect(first.saltHex).not.toBe(second.saltHex);
    expect((await nodeFs.readFile(a)).equals(await nodeFs.readFile(b))).toBe(false);
  });

  test("handles empty and tiny payloads, with and without compression", async () => {
    const dir = await scratch();
    for (const compress of [true, false]) {
      for (const payload of [Buffer.alloc(0), Buffer.from("x"), randomBytes(17)]) {
        const file = join(dir, `t-${compress}-${payload.length}.enc`);
        await sealBuffer(payload, file, { ...context(), compress });
        expect((await openToBuffer(file, { ...context(), compress })).equals(payload)).toBe(true);
      }
    }
  });

  test("the envelope has the documented layout", async () => {
    const dir = await scratch();
    const file = join(dir, "layout.enc");
    await sealBuffer(Buffer.from("hello"), file, { ...context(), compress: false });
    const bytes = await nodeFs.readFile(file);
    expect(bytes.subarray(0, 6).toString("ascii")).toBe("PGBKv2");
    expect(bytes[6]).toBe(2);
    expect(bytes.length).toBe(HEADER_BYTES + 5 + TAG_BYTES);
  });

  test("a failed seal leaves neither a partial destination nor a temp file", async () => {
    const dir = await scratch();
    const dest = join(dir, "never.enc");
    const failing = new Readable({ read() { this.destroy(new Error("source exploded")); } });
    const { sealStream } = await import("../src/cryptoEnvelope");
    await expect(sealStream(failing, dest, context())).rejects.toThrow("source exploded");
    expect(await nodeFs.readdir(dir)).toEqual([]);
  });
});

describe("tampering fails closed (no plaintext is ever accepted)", () => {
  const sealOne = async (): Promise<{ file: string; bytes: Buffer; dir: string }> => {
    const dir = await scratch();
    const file = join(dir, "victim.enc");
    await sealBuffer(randomBytes(200_000), file, context());
    return { file, bytes: await nodeFs.readFile(file), dir };
  };

  const flipBit = (bytes: Buffer, offset: number): Buffer => {
    const copy = Buffer.from(bytes);
    copy[offset] = copy[offset]! ^ 0x01;
    return copy;
  };

  const expectRejected = async (file: string, bytes: Buffer, options = context()): Promise<void> => {
    await nodeFs.writeFile(file, bytes);
    await expect(openToBuffer(file, options)).rejects.toThrow();
  };

  test("a 1-bit flip in the ciphertext body is detected", async () => {
    const { file, bytes } = await sealOne();
    await expectRejected(file, flipBit(bytes, HEADER_BYTES + 100));
  });

  test("a 1-bit flip in the IV is detected", async () => {
    const { file, bytes } = await sealOne();
    await expectRejected(file, flipBit(bytes, 7 + SALT_BYTES + 3));
  });

  test("a 1-bit flip in the salt (different derived key) is detected", async () => {
    const { file, bytes } = await sealOne();
    await expectRejected(file, flipBit(bytes, 7 + 1));
  });

  test("a 1-bit flip in the authentication tag is detected", async () => {
    const { file, bytes } = await sealOne();
    await expectRejected(file, flipBit(bytes, bytes.length - 3));
  });

  test("a damaged magic or version is refused", async () => {
    const { file, bytes } = await sealOne();
    await expectRejected(file, flipBit(bytes, 0));
    await expectRejected(file, flipBit(bytes, 6));
  });

  test("a truncated envelope is refused, as is one cut inside the header", async () => {
    const { file, bytes } = await sealOne();
    await expectRejected(file, bytes.subarray(0, bytes.length - 1));
    await expectRejected(file, bytes.subarray(0, bytes.length - TAG_BYTES));
    await expectRejected(file, bytes.subarray(0, 10));
    await expectRejected(file, Buffer.alloc(0));
  });

  test("appended garbage is refused", async () => {
    const { file, bytes } = await sealOne();
    await expectRejected(file, Buffer.concat([bytes, Buffer.from("extra")]));
  });

  test("the wrong master key, target or backup id cannot open it (ciphertext cannot be moved between artifacts)", async () => {
    const { file, bytes } = await sealOne();
    await nodeFs.writeFile(file, bytes);
    await expect(openToBuffer(file, { master: randomBytes(32), target: "postgres_core", id: "bkp_1" })).rejects.toThrow();
    await expect(openToBuffer(file, context("audit_db", "bkp_1"))).rejects.toThrow();
    await expect(openToBuffer(file, context("postgres_core", "bkp_2"))).rejects.toThrow();
    // ...but the right context still works, so the failures above are real.
    expect((await openToBuffer(file, context())).length).toBe(200_000);
  });

  test("openToFile never leaves a partial plaintext file behind on failure", async () => {
    const { file, bytes, dir } = await sealOne();
    await nodeFs.writeFile(file, flipBit(bytes, HEADER_BYTES + 5000));
    const dest = join(dir, "should-not-exist.bin");
    await expect(openToFile(file, dest, context())).rejects.toThrow();
    await expect(nodeFs.access(dest)).rejects.toThrow();
    expect((await nodeFs.readdir(dir)).filter((name) => name !== "victim.enc")).toEqual([]);
  });

  test("DecryptStream and EncryptStream compose directly", async () => {
    const enc = new EncryptStream(context());
    const dec = new DecryptStream(context());
    const out: Buffer[] = [];
    dec.on("data", (chunk) => out.push(chunk));
    await new Promise<void>((resolve, reject) => {
      dec.on("end", resolve);
      dec.on("error", reject);
      enc.pipe(dec);
      enc.end(Buffer.from("composed"));
    });
    expect(Buffer.concat(out).toString()).toBe("composed");
  });
});

describe("signed manifests", () => {
  const unsigned = (): Omit<BackupManifest, "signature"> => ({
    schemaVersion: 2,
    backupId: "bkp_20261106T020000Z_core_full",
    target: "postgres_core",
    kind: "full",
    engine: "pg-native",
    clusterTopology: "shared-audit",
    startedAt: "2026-11-06T02:00:00.000Z",
    completedAt: "2026-11-06T02:01:14.210Z",
    startLsn: "0/18000028",
    endLsn: "0/180001A0",
    uncompressedBytes: 148291584,
    compressedBytes: 19482112,
    sha256Plaintext: "a".repeat(64),
    sha256Ciphertext: "b".repeat(64),
    encryption: { algorithm: "AES-256-GCM", kdf: "HKDF-SHA256", saltHex: "00", ivHex: "11", authTagHex: "22" },
    pgVerifyBackup: { verified: true, manifestChecksumAlgorithm: "SHA256", detail: "backup successfully verified" },
    storageTargets: ["local-repo", "primary-s3"],
  });

  test("a signed manifest verifies; the signature is a 64-hex HMAC", () => {
    const signed = signManifest(unsigned(), master);
    expect(signed.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyManifestSignature(signed, master)).toBe(true);
  });

  test("changing ANY field (including nested ones) invalidates the signature", () => {
    const signed = signManifest(unsigned(), master);
    const mutations: Array<(manifest: BackupManifest) => void> = [
      (manifest) => { manifest.backupId = "bkp_other"; },
      (manifest) => { manifest.kind = "delta"; },
      (manifest) => { manifest.endLsn = "0/FFFFFFFF"; },
      (manifest) => { manifest.sha256Ciphertext = "c".repeat(64); },
      (manifest) => { manifest.compressedBytes += 1; },
      (manifest) => { manifest.encryption.ivHex = "ff"; },
      (manifest) => { manifest.encryption.authTagHex = "ff"; },
      (manifest) => { manifest.pgVerifyBackup!.verified = false; },
      (manifest) => { manifest.storageTargets.push("evil"); },
      (manifest) => { manifest.parentBackupId = "bkp_planted"; },
    ];
    for (const mutate of mutations) {
      const copy = structuredClone(signed);
      mutate(copy);
      expect(verifyManifestSignature(copy, master)).toBe(false);
    }
  });

  test("a missing, truncated, non-hex or wrong-key signature fails closed", () => {
    const signed = signManifest(unsigned(), master);
    expect(verifyManifestSignature({ ...signed, signature: undefined }, master)).toBe(false);
    expect(verifyManifestSignature({ ...signed, signature: "" }, master)).toBe(false);
    expect(verifyManifestSignature({ ...signed, signature: signed.signature!.slice(0, 32) }, master)).toBe(false);
    expect(verifyManifestSignature({ ...signed, signature: "zz".repeat(32) }, master)).toBe(false);
    expect(verifyManifestSignature(signed, randomBytes(32))).toBe(false);
  });

  test("key order in the JSON does not matter (canonical form)", () => {
    const signed = signManifest(unsigned(), master);
    const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(signed).reverse()))) as BackupManifest;
    expect(verifyManifestSignature(reordered, master)).toBe(true);
  });

  test("text signatures (catalog mirror) verify and reject tampering", () => {
    const signature = signText('{"runs":[]}', master);
    expect(verifyTextSignature('{"runs":[]}', signature, master)).toBe(true);
    expect(verifyTextSignature('{"runs":[1]}', signature, master)).toBe(false);
    expect(verifyTextSignature('{"runs":[]}', signature.slice(0, 20), master)).toBe(false);
  });
});
