import {
  createCipheriv,
  createDecipheriv,
  type DecipherGCM,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream, promises as nodeFs } from "node:fs";
import { dirname } from "node:path";
import { Duplex, Readable, Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import { stableJson, tempSibling } from "./util";

/**
 * Authenticated encryption for every backup artifact and WAL segment.
 *
 * File layout (self-describing, no sidecar needed to decrypt):
 *
 *   magic "PGBKv2" (6) | version (1) | salt (16) | iv (12) | ciphertext ... | authTag (16)
 *
 * Key hierarchy (HKDF-SHA256, RFC 5869):
 *   payload key  = HKDF(master, salt = random 16 bytes, info = "pg-backup-v2:payload:<target>:<id>")
 *   manifest key = HKDF(master, salt = "pg-backup-v2-catalog", info = "manifest-hmac-sha256")
 *
 * The header plus a `<target>:<id>` context string are bound as GCM additional
 * authenticated data, so a valid ciphertext cannot be moved to another artifact
 * or have its header swapped. Compression (zstd) happens BEFORE encryption.
 */

export const ENVELOPE_MAGIC = Buffer.from("PGBKv2", "ascii");
export const ENVELOPE_VERSION = 2;
export const SALT_BYTES = 16;
export const IV_BYTES = 12;
export const TAG_BYTES = 16;
export const HEADER_BYTES = ENVELOPE_MAGIC.length + 1 + SALT_BYTES + IV_BYTES;

export class EnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvelopeError";
  }
}

export const masterKeyFromHex = (hex: string): Buffer => {
  const normalized = hex.trim();
  if (!/^[0-9a-fA-F]+$/.test(normalized) || normalized.length % 2 !== 0 || normalized.length < 32) {
    throw new EnvelopeError("encryption key must be an even-length hex string of at least 16 bytes");
  }
  return Buffer.from(normalized, "hex");
};

const hkdf = (ikm: Buffer, salt: Buffer | string, info: string): Buffer =>
  Buffer.from(hkdfSync("sha256", ikm, typeof salt === "string" ? Buffer.from(salt, "utf8") : salt, Buffer.from(info, "utf8"), 32));

export const derivePayloadKey = (master: Buffer, salt: Buffer, target: string, id: string): Buffer =>
  hkdf(master, salt, `pg-backup-v2:payload:${target}:${id}`);

export const deriveManifestKey = (master: Buffer): Buffer =>
  hkdf(master, "pg-backup-v2-catalog", "manifest-hmac-sha256");

const aad = (header: Buffer, target: string, id: string): Buffer =>
  Buffer.concat([header, Buffer.from(`|${target}:${id}`, "utf8")]);

export interface EnvelopeContext {
  master: Buffer;
  target: string;
  id: string;
}

export interface EnvelopeMeta {
  saltHex: string;
  ivHex: string;
  authTagHex: string;
}

/** Encrypts a byte stream into the envelope format. `meta` is populated when the stream ends. */
export class EncryptStream extends Transform {
  public meta: EnvelopeMeta | undefined;
  private readonly cipher;
  private readonly header: Buffer;
  private headerSent = false;
  private readonly salt: Buffer;
  private readonly iv: Buffer;

  constructor(context: EnvelopeContext) {
    super();
    this.salt = randomBytes(SALT_BYTES);
    this.iv = randomBytes(IV_BYTES);
    this.header = Buffer.concat([ENVELOPE_MAGIC, Buffer.from([ENVELOPE_VERSION]), this.salt, this.iv]);
    const key = derivePayloadKey(context.master, this.salt, context.target, context.id);
    this.cipher = createCipheriv("aes-256-gcm", key, this.iv, { authTagLength: TAG_BYTES });
    this.cipher.setAAD(aad(this.header, context.target, context.id));
  }

  public override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      if (!this.headerSent) {
        this.push(this.header);
        this.headerSent = true;
      }
      const encrypted = this.cipher.update(chunk);
      if (encrypted.length > 0) this.push(encrypted);
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  public override _flush(callback: TransformCallback): void {
    try {
      if (!this.headerSent) {
        this.push(this.header);
        this.headerSent = true;
      }
      const tail = this.cipher.final();
      if (tail.length > 0) this.push(tail);
      const tag = this.cipher.getAuthTag();
      this.push(tag);
      this.meta = {
        saltHex: this.salt.toString("hex"),
        ivHex: this.iv.toString("hex"),
        authTagHex: tag.toString("hex"),
      };
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }
}

/**
 * Decrypts an envelope stream. The auth tag is verified when the stream ends:
 * plaintext emitted before that point is UNTRUSTED, so callers must discard
 * their result if the stream errors (all callers here write to a temp file or
 * an extraction directory that is removed on failure).
 */
export class DecryptStream extends Transform {
  private pending: Buffer = Buffer.alloc(0);
  private decipher: DecipherGCM | undefined;

  constructor(private readonly context: EnvelopeContext) {
    super();
  }

  public override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
      if (!this.decipher) {
        if (this.pending.length < HEADER_BYTES) return callback();
        const header = this.pending.subarray(0, HEADER_BYTES);
        if (!header.subarray(0, ENVELOPE_MAGIC.length).equals(ENVELOPE_MAGIC)) {
          throw new EnvelopeError("not a pg-backup v2 envelope (bad magic)");
        }
        if (header[ENVELOPE_MAGIC.length] !== ENVELOPE_VERSION) {
          throw new EnvelopeError(`unsupported envelope version ${header[ENVELOPE_MAGIC.length]}`);
        }
        const saltStart = ENVELOPE_MAGIC.length + 1;
        const salt = header.subarray(saltStart, saltStart + SALT_BYTES);
        const iv = header.subarray(saltStart + SALT_BYTES, HEADER_BYTES);
        const key = derivePayloadKey(this.context.master, Buffer.from(salt), this.context.target, this.context.id);
        this.decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv), { authTagLength: TAG_BYTES }) as DecipherGCM;
        this.decipher.setAAD(aad(Buffer.from(header), this.context.target, this.context.id));
        this.pending = Buffer.from(this.pending.subarray(HEADER_BYTES));
      }
      // Always hold back the last TAG_BYTES: they are the authentication tag.
      if (this.pending.length > TAG_BYTES) {
        const cipherPart = this.pending.subarray(0, this.pending.length - TAG_BYTES);
        this.pending = Buffer.from(this.pending.subarray(this.pending.length - TAG_BYTES));
        const plain = this.decipher.update(cipherPart);
        if (plain.length > 0) this.push(plain);
      }
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  public override _flush(callback: TransformCallback): void {
    try {
      if (!this.decipher || this.pending.length !== TAG_BYTES) {
        throw new EnvelopeError("cipher authentication failed: envelope is truncated");
      }
      this.decipher.setAuthTag(this.pending);
      const tail = this.decipher.final();
      if (tail.length > 0) this.push(tail);
      callback();
    } catch (error) {
      callback(
        error instanceof EnvelopeError
          ? error
          : new EnvelopeError("cipher authentication failed: ciphertext, header or context was modified"),
      );
    }
  }
}

/** Counts bytes and hashes whatever passes through. */
export class HashPassThrough extends Transform {
  public bytes = 0;
  private readonly hash = createHash("sha256");
  private digestHex: string | undefined;

  public override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.bytes += chunk.length;
    this.hash.update(chunk);
    callback(null, chunk);
  }

  public get sha256(): string {
    this.digestHex ??= this.hash.digest("hex");
    return this.digestHex;
  }
}

/** Streams data through an external filter process (`zstd`), with proper exit-code propagation. */
export class ProcessFilter extends Duplex {
  private readonly child;
  private stderr = "";

  constructor(command: string, args: string[]) {
    super();
    this.child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.child.stderr.on("data", (chunk: Buffer) => {
      if (this.stderr.length < 4000) this.stderr += chunk.toString("utf8");
    });
    this.child.stdin.on("error", () => undefined);
    this.child.stdout.on("data", (chunk: Buffer) => {
      if (!this.push(chunk)) this.child.stdout.pause();
    });
    this.child.on("error", (error) => this.destroy(new Error(`${command} could not start: ${error.message}`)));
    this.child.on("close", (code) => {
      if (code === 0) this.push(null);
      else this.destroy(new Error(`${command} exited with code ${code}: ${this.stderr.trim().slice(0, 300)}`));
    });
  }

  public override _read(): void {
    this.child.stdout.resume();
  }

  public override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.child.stdin.write(chunk, (error) => callback(error ?? null));
  }

  public override _final(callback: (error?: Error | null) => void): void {
    this.child.stdin.end();
    callback();
  }

  public override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (this.child.exitCode === null) this.child.kill("SIGKILL");
    callback(error);
  }
}

export const zstdCompress = (level = 6): ProcessFilter => new ProcessFilter("zstd", ["-q", `-${level}`, "-T0", "-c"]);
export const zstdDecompress = (): ProcessFilter => new ProcessFilter("zstd", ["-d", "-q", "-c"]);

export interface SealResult extends EnvelopeMeta {
  sha256Plaintext: string;
  sha256Ciphertext: string;
  uncompressedBytes: number;
  /** Size of the encrypted file on disk. */
  compressedBytes: number;
}

export interface SealOptions extends EnvelopeContext {
  compress?: boolean;
  level?: number;
  mode?: number;
}

/**
 * source -> sha256(plain) -> [zstd] -> AES-256-GCM -> sha256(cipher) -> temp file -> fsync -> rename.
 * The destination only ever holds a complete, authenticated artifact.
 */
export const sealStream = async (source: Readable, destPath: string, options: SealOptions): Promise<SealResult> => {
  await nodeFs.mkdir(dirname(destPath), { recursive: true });
  const tmp = tempSibling(destPath);
  const plainHash = new HashPassThrough();
  const cipherHash = new HashPassThrough();
  const encrypt = new EncryptStream(options);
  const stages: Array<Readable | Duplex | NodeJS.WritableStream> = [source, plainHash];
  if (options.compress !== false) stages.push(zstdCompress(options.level ?? 6));
  stages.push(encrypt, cipherHash);
  const out = createWriteStream(tmp, { mode: options.mode ?? 0o600 });
  stages.push(out);
  try {
    await pipeline(stages as [Readable, ...Duplex[], NodeJS.WritableStream]);
    const handle = await nodeFs.open(tmp, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await nodeFs.rename(tmp, destPath);
  } catch (error) {
    await nodeFs.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
  if (!encrypt.meta) throw new EnvelopeError("encryption did not finish");
  return {
    ...encrypt.meta,
    sha256Plaintext: plainHash.sha256,
    sha256Ciphertext: cipherHash.sha256,
    uncompressedBytes: plainHash.bytes,
    compressedBytes: cipherHash.bytes,
  };
};

export const sealFile = (srcPath: string, destPath: string, options: SealOptions): Promise<SealResult> =>
  sealStream(createReadStream(srcPath), destPath, options);

export const sealBuffer = async (data: Uint8Array, destPath: string, options: SealOptions): Promise<SealResult> =>
  sealStream(Readable.from([Buffer.from(data)]), destPath, options);

/** Returns a readable of the PLAINTEXT of an envelope file (decrypt, then decompress). */
export const openStream = (source: Readable, options: Omit<SealOptions, "mode">): Readable => {
  const stages: Array<Readable | Duplex> = [source, new DecryptStream(options)];
  if (options.compress !== false) stages.push(zstdDecompress());
  const last = stages[stages.length - 1] as Readable;
  // Propagate failures of earlier stages to the consumer of the last stage.
  for (let index = 0; index < stages.length - 1; index += 1) {
    const stage = stages[index] as Readable;
    const next = stages[index + 1] as Duplex;
    stage.on("error", (error) => next.destroy(error));
    stage.pipe(next);
  }
  return last;
};

export const openFile = (srcPath: string, options: Omit<SealOptions, "mode">): Readable =>
  openStream(createReadStream(srcPath), options);

export interface OpenToFileResult {
  sha256Plaintext: string;
  bytes: number;
}

/** Decrypts to a temp file and renames it into place only after authentication succeeds. */
export const openToFile = async (
  srcPath: string,
  destPath: string,
  options: Omit<SealOptions, "mode">,
): Promise<OpenToFileResult> => {
  await nodeFs.mkdir(dirname(destPath), { recursive: true });
  const tmp = tempSibling(destPath);
  const hash = new HashPassThrough();
  try {
    await pipeline(openFile(srcPath, options), hash, createWriteStream(tmp, { mode: 0o600 }));
    await nodeFs.rename(tmp, destPath);
  } catch (error) {
    await nodeFs.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
  return { sha256Plaintext: hash.sha256, bytes: hash.bytes };
};

export const openToBuffer = async (srcPath: string, options: Omit<SealOptions, "mode">): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of openFile(srcPath, options)) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

// ---------------------------------------------------------------------------
// Signed manifests
// ---------------------------------------------------------------------------

export interface BackupManifest {
  schemaVersion: 2;
  backupId: string;
  target: string;
  kind: "full" | "delta";
  engine: string;
  clusterTopology: string;
  startedAt: string;
  completedAt: string;
  startLsn?: string;
  endLsn?: string;
  walSegmentStart?: string;
  walSegmentEnd?: string;
  /** Backup chain: the manifest id this incremental backup was taken against. */
  parentBackupId?: string;
  uncompressedBytes: number;
  compressedBytes: number;
  sha256Plaintext: string;
  sha256Ciphertext: string;
  encryption: {
    algorithm: "AES-256-GCM";
    kdf: "HKDF-SHA256";
    saltHex: string;
    ivHex: string;
    authTagHex: string;
  };
  pgVerifyBackup?: { verified: boolean; manifestChecksumAlgorithm: string; detail: string };
  /** Companion artifacts (logical dumps) recorded as file name -> sha256 of ciphertext. */
  artifacts?: Record<string, { sha256Ciphertext: string; bytes: number }>;
  storageTargets: string[];
  signature?: string;
}

const manifestPayload = (manifest: Omit<BackupManifest, "signature"> | BackupManifest): string => {
  const { signature: _signature, ...rest } = manifest as BackupManifest;
  return stableJson(rest);
};

export const signManifest = (manifest: Omit<BackupManifest, "signature">, master: Buffer): BackupManifest => ({
  ...manifest,
  signature: createHmac("sha256", deriveManifestKey(master)).update(manifestPayload(manifest), "utf8").digest("hex"),
});

export const verifyManifestSignature = (manifest: BackupManifest, master: Buffer): boolean => {
  if (typeof manifest.signature !== "string" || manifest.signature.length === 0) return false;
  const expected = createHmac("sha256", deriveManifestKey(master)).update(manifestPayload(manifest), "utf8").digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(manifest.signature, "hex");
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};

/** Signs arbitrary catalog JSON text (used for catalog mirroring). */
export const signText = (text: string, master: Buffer): string =>
  createHmac("sha256", deriveManifestKey(master)).update(text, "utf8").digest("hex");

export const verifyTextSignature = (text: string, signature: string, master: Buffer): boolean => {
  const expected = Buffer.from(signText(text, master), "hex");
  const actual = Buffer.from(signature.replace(/[^0-9a-fA-F]/g, ""), "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};
