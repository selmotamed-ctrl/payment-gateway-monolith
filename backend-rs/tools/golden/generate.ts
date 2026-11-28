/**
 * Golden-vector generator (P0-T06).
 *
 * Produces the cross-implementation vectors under `backend-rs/tests/golden-vectors/` by calling
 * the REAL TypeScript modules of `core-back` — never a re-implementation:
 *
 * | file               | TypeScript source                                              |
 * | :----------------- | :------------------------------------------------------------- |
 * | fnv-shares.json    | `lib/storageEngine/shardBalances.ts` (`fnv1aHash`)              |
 * | money-decimal.json | `decimal.js` + Prisma `Decimal` (the classes the API emits)     |
 * | js-key-order.json  | the JavaScript engine itself (`Object.keys`/`JSON.stringify`)   |
 * | js-dates.json      | the JavaScript engine itself (`Date#toISOString`)               |
 * | vault.json         | `engine/crypto/Vault.ts` (`encryptSecret`/`sign`)               |
 * | webhooks.json      | `lib/webhooks/standardWebhooks.ts`                              |
 * | canonical.json     | `engine/crypto/CryptoEngine.ts` (`canonicalize`)                |
 * | pgos1.json         | `lib/objectStorageSdk/crypto.ts` (`encryptBufferToPgos1`)       |
 *
 * Output is deterministic: cases are sorted by id, there are no timestamps and the only random
 * bytes are inside the `vault`/`pgos1` payloads, which ARE the vector. Those payloads are reused
 * from the previous file on regeneration (and decrypted to prove they still open); pass
 * `--refresh-random` to mint new ones, which is the only way the committed bytes change.
 *
 * Usage (from the repo root):
 *   bun backend-rs/tools/golden/generate.ts
 *   bun backend-rs/tools/golden/generate.ts --out /tmp/vectors --refresh-random
 */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import * as decimalJsModule from "../../../core-back/node_modules/decimal.js/decimal.js";
import { Prisma } from "../../../core-back/generated/prisma/client.ts";
import { canonicalize } from "../../../core-back/engine/crypto/CryptoEngine.ts";
import { Vault } from "../../../core-back/engine/crypto/Vault.ts";
import {
  decryptPgos1ToBuffer,
  encryptBufferToPgos1,
  InMemoryKeyProvider,
} from "../../../core-back/lib/objectStorageSdk/crypto.ts";
import { fnv1aHash, shardIdForAttempt } from "../../../core-back/lib/storageEngine/shardBalances.ts";
import {
  buildWebhookHeaders,
  signWebhookWithSecret,
} from "../../../core-back/lib/webhooks/standardWebhooks.ts";

import {
  buildPatternPayload,
  CANONICAL_CASES,
  DATE_CASES,
  DECIMAL_INPUTS,
  FNV_REFERENCES,
  KEY_ORDER_CASES,
  PGOS1_CASES,
  ROUNDING_ALIASES,
  ROUNDING_MODES,
  ROUNDING_VALUES,
  SHARD_COUNTS,
  VAULT_ENCRYPT_CASES,
  VAULT_SIGN_CASES,
  WEBHOOK_CASES,
} from "./lib/inputs.ts";
import {
  defaultVectorDir,
  loadPreviousCases,
  type VectorCase,
  writeVector,
} from "./lib/io.ts";

/** `Prisma.Decimal` is a second copy of decimal.js; both must agree. */
const Decimal = (decimalJsModule as unknown as { Decimal: any }).Decimal ??
  (decimalJsModule as unknown as { default: { Decimal: any } }).default.Decimal;

const GENERATOR = "backend-rs/tools/golden/generate.ts";

/** Exactly 32 ASCII bytes: the master key is used as-is (no base64/SHA-256 step). */
export const KMS_MASTER_KEY = "0123456789abcdef0123456789abcdef";

export interface GenerateFileResult {
  name: string;
  path: string;
  bytes: number;
  cases: number;
}

export interface GenerateResult {
  outDir: string;
  files: GenerateFileResult[];
}

export interface GenerateOptions {
  /** Destination directory (default `backend-rs/tests/golden-vectors/`). */
  outDir?: string;
  /** Directory holding the committed vectors whose random payloads are reused. */
  reuseFrom?: string;
  /**
   * Mint fresh vault/pgos1 payloads instead of reusing committed ones. Random payloads from an
   * older snapshot are otherwise reused after decryption proves they still open, so the committed
   * files stay byte-stable.
   */
  refreshRandom?: boolean;
}

const explicitVault = new Vault({ masterKey: KMS_MASTER_KEY });
let envVault: Vault | undefined;

/** `env` mode exercises `new Vault()` reading `KMS_MASTER_KEY` (KMS_KEYS_JSON cleared). */
const vaultFor = (resolution: "explicit" | "env"): Vault => {
  if (resolution === "explicit") {
    return explicitVault;
  }
  if (!envVault) {
    delete process.env.KMS_KEYS_JSON;
    process.env.KMS_MASTER_KEY = KMS_MASTER_KEY;
    envVault = new Vault();
  }
  return envVault;
};

const base64 = (bytes: Uint8Array | Buffer): string => Buffer.from(bytes).toString("base64");

const fnvCases = (): VectorCase[] =>
  FNV_REFERENCES.map((value, index) => {
    const hash = fnv1aHash(value);
    const shards: Record<string, number> = {};
    for (const count of SHARD_COUNTS) {
      shards[String(count)] = shardIdForAttempt(value, "SYSTEM", count);
      if (shards[String(count)] !== hash % count) {
        throw new Error(`shard mismatch for ${JSON.stringify(value)} at ${count}`);
      }
    }
    return {
      id: `fnv-${String(index + 1).padStart(2, "0")}`,
      value,
      utf16CodeUnits: value.length,
      fnv1a32: hash,
      fnv1a32Hex: hash.toString(16).padStart(8, "0"),
      walletShard16: shardIdForAttempt(value, "MERCHANT_WALLET", 16),
      shards,
    };
  });

/**
 * Copy of `roundingModeOf` (`api/internal/checkout.ts:368-387`). The module itself cannot be
 * imported: importing it boots Prisma and validates the entire core environment (it calls
 * `process.exit(1)` without DATABASE_URL/MTLS/KMS). The mapping is part of the contract and is
 * re-stated here verbatim.
 */
const decimalRoundingModeOf = (
  mode: unknown,
): { name: string; constant: number; normalized: string } => {
  const normalized = String(mode ?? "HALF_UP")
    .toUpperCase()
    .replace(/^ROUND_/, "");
  switch (normalized) {
    case "HALF_EVEN":
    case "BANKERS":
      return { name: "ROUND_HALF_EVEN", constant: Decimal.ROUND_HALF_EVEN, normalized };
    case "HALF_DOWN":
      return { name: "ROUND_HALF_DOWN", constant: Decimal.ROUND_HALF_DOWN, normalized };
    case "UP":
      return { name: "ROUND_UP", constant: Decimal.ROUND_UP, normalized };
    case "DOWN":
      return { name: "ROUND_DOWN", constant: Decimal.ROUND_DOWN, normalized };
    case "CEILING":
    case "CEIL":
      return { name: "ROUND_CEIL", constant: Decimal.ROUND_CEIL, normalized };
    case "FLOOR":
      return { name: "ROUND_FLOOR", constant: Decimal.ROUND_FLOOR, normalized };
    default:
      return { name: "ROUND_HALF_UP", constant: Decimal.ROUND_HALF_UP, normalized };
  }
};

const moneyCases = (): VectorCase[] => {
  const cases: VectorCase[] = [];
  DECIMAL_INPUTS.forEach((input, index) => {
    const decimal = new Decimal(input);
    const prisma = new Prisma.Decimal(input);
    const decimalToString = decimal.toString();
    if (prisma.toString() !== decimalToString) {
      throw new Error(`Prisma.Decimal disagrees with decimal.js for ${input}`);
    }
    cases.push({
      id: `decimal-${String(index + 1).padStart(2, "0")}`,
      kind: "decimal",
      input,
      decimalToString,
      toFixed4: decimal.toFixed(4),
      prismaJson: JSON.parse(JSON.stringify({ v: prisma })),
    });
  });

  let roundingIndex = 0;
  for (const value of ROUNDING_VALUES) {
    for (const mode of ROUNDING_MODES) {
      roundingIndex += 1;
      const resolved = decimalRoundingModeOf(mode);
      const rounded = new Decimal(value).toDecimalPlaces(4, resolved.constant);
      cases.push({
        id: `rounding-${String(roundingIndex).padStart(2, "0")}`,
        kind: "rounding",
        value,
        mode,
        decimalMode: resolved.name,
        decimalModeConstant: resolved.constant,
        rounded: rounded.toFixed(4),
        roundedToString: rounded.toString(),
      });
    }
  }

  // 2469.13 * 0.005 = 12.34565 exactly: the 5th decimal is a true midpoint, so every mode
  // produces a distinguishable result (12.3456 vs 12.3457).
  const commissionAmount = new Decimal("2469.13");
  const commissionRate = new Decimal("0.005");
  ROUNDING_MODES.forEach((mode, index) => {
    const resolved = decimalRoundingModeOf(mode);
    const raw = commissionAmount.mul(commissionRate);
    const commission = raw.toDecimalPlaces(4, resolved.constant);
    cases.push({
      id: `commission-${String(index + 1).padStart(2, "0")}`,
      kind: "commission",
      amount: commissionAmount.toString(),
      percentageRate: commissionRate.toString(),
      mode,
      decimalMode: resolved.name,
      raw: raw.toString(),
      commission: commission.toFixed(4),
      commissionToString: commission.toString(),
    });
  });

  ROUNDING_ALIASES.forEach((alias, index) => {
    const resolved = decimalRoundingModeOf(alias.mode);
    const rounded = new Decimal("1.23445").toDecimalPlaces(4, resolved.constant);
    cases.push({
      id: `rounding-alias-${String(index + 1).padStart(2, "0")}`,
      kind: "roundingAlias",
      inputMode: alias.mode,
      resolvedMode: alias.target,
      decimalMode: resolved.name,
      decimalModeConstant: resolved.constant,
      value: "1.23445",
      rounded: rounded.toFixed(4),
    });
  });

  return cases;
};

const keyOrderCases = (): VectorCase[] => {
  return KEY_ORDER_CASES.map((entry) => {
    const value: Record<string, unknown> = {};
    for (const [key, item] of entry.pairs) {
      value[key] = item;
    }
    return {
      id: entry.id,
      insertion: entry.pairs.map(([key, item]) => [key, item]),
      objectKeys: Object.keys(value),
      stringified: JSON.stringify(value),
    };
  });
};

const dateCases = (): VectorCase[] => {
  const cases: VectorCase[] = [];
  for (const entry of DATE_CASES) {
    if (entry.kind === "invalid") {
      let error = "RangeError";
      try {
        new Date(Number.NaN).toISOString();
        error = "no error";
      } catch (caught) {
        error = caught instanceof Error ? caught.name : String(caught);
      }
      cases.push({ id: entry.id, kind: "invalid", input: null, error });
      continue;
    }
    const date = new Date(entry.input);
    const iso = date.toISOString();
    const epochMs = date.getTime();
    if (!Number.isFinite(epochMs)) {
      throw new Error(`invalid date case ${entry.id}`);
    }
    cases.push({
      id: entry.id,
      kind: entry.kind,
      input: entry.input,
      epochMs,
      iso,
    });
  }
  return cases;
};

const webhookSecretBytes = Array.from({ length: 32 }, (_, index) => (index * 7 + 3) & 0xff);
const webhookRotationBytes = Array.from({ length: 32 }, (_, index) => (255 - index * 5) & 0xff);
export const WEBHOOK_SECRET = `whsec_${Buffer.from(webhookSecretBytes).toString("base64")}`;
export const WEBHOOK_ROTATION_SECRET = `whsec_${Buffer.from(webhookRotationBytes).toString("base64")}`;

const webhookCases = (): VectorCase[] => {
  const cases: VectorCase[] = WEBHOOK_CASES.map((entry) => ({
    id: entry.id,
    kind: "sign",
    webhookId: entry.webhookId,
    timestampSeconds: entry.timestampSeconds,
    body: entry.body,
    secret: WEBHOOK_SECRET,
    signature: signWebhookWithSecret({
      id: entry.webhookId,
      timestampSeconds: entry.timestampSeconds,
      body: entry.body,
      secret: WEBHOOK_SECRET,
    }),
  }));

  const rotation = WEBHOOK_CASES[1]!;
  const secrets = [WEBHOOK_SECRET, WEBHOOK_ROTATION_SECRET];
  cases.push({
    id: "webhook-multi-secret-headers",
    kind: "headers",
    webhookId: rotation.webhookId,
    timestampSeconds: rotation.timestampSeconds,
    body: rotation.body,
    secrets,
    headers: buildWebhookHeaders({
      id: rotation.webhookId,
      timestampSeconds: rotation.timestampSeconds,
      body: rotation.body,
      secrets,
    }),
  });
  return cases;
};

const canonicalCases = (): VectorCase[] => {
  return CANONICAL_CASES.map((entry) => {
    const input: Record<string, unknown> = { fields: entry.fields };
    if (entry.includedFields) input.includedFields = entry.includedFields;
    if (entry.excludedFields) input.excludedFields = entry.excludedFields;
    if (entry.templateString !== undefined) input.templateString = entry.templateString;
    if (entry.valueSeparator !== undefined) input.valueSeparator = entry.valueSeparator;
    const expected = canonicalize(entry.mode as never, input as never);
    return {
      id: entry.id,
      mode: entry.mode,
      fields: entry.fields,
      ...(entry.includedFields ? { includedFields: entry.includedFields } : {}),
      ...(entry.excludedFields ? { excludedFields: entry.excludedFields } : {}),
      ...(entry.templateString !== undefined ? { templateString: entry.templateString } : {}),
      ...(entry.valueSeparator !== undefined ? { valueSeparator: entry.valueSeparator } : {}),
      expected,
    };
  });
};

interface PreviousVaultCase extends VectorCase {
  keyId?: string;
  plaintext?: string;
  payload?: string;
}

const vaultCases = async (previous: Map<string, VectorCase>): Promise<VectorCase[]> => {
  const cases: VectorCase[] = [];
  for (const entry of VAULT_ENCRYPT_CASES) {
    let payload: string | undefined;
    const existing = previous.get(entry.id) as PreviousVaultCase | undefined;
    if (
      existing &&
      typeof existing.payload === "string" &&
      existing.keyId === entry.keyId &&
      existing.plaintext === entry.plaintext
    ) {
      try {
        if ((await vaultFor(entry.resolution).decryptSecret(existing.payload)) === entry.plaintext) {
          payload = existing.payload;
        }
      } catch {
        payload = undefined;
      }
    }
    if (!payload) {
      payload = await vaultFor(entry.resolution).encryptSecret(entry.plaintext, entry.keyId);
    }
    const opened = await vaultFor(entry.resolution).decryptSecret(payload);
    if (opened !== entry.plaintext) {
      throw new Error(`vault payload for ${entry.id} does not decrypt`);
    }
    cases.push({
      id: entry.id,
      kind: "encrypt",
      keyId: entry.keyId,
      plaintext: entry.plaintext,
      resolution: entry.resolution,
      payload,
    });
  }

  for (const entry of VAULT_SIGN_CASES) {
    const signature = await explicitVault.sign(entry.data, entry.keyId);
    if (!/^[0-9a-f]{64}$/.test(signature)) {
      throw new Error(`vault signature for ${entry.id} is not hex`);
    }
    if (!(await explicitVault.verifySignature(entry.data, signature, entry.keyId))) {
      throw new Error(`vault signature for ${entry.id} does not verify`);
    }
    cases.push({ id: entry.id, kind: "sign", keyId: entry.keyId, data: entry.data, signature });
  }
  return cases;
};

/** Fixed 32-byte KEK (hex) and object id shared by every pgos1 case. */
export const PGOS1_KEK_HEX = "a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff00";
export const PGOS1_KEYRING = `v1:${PGOS1_KEK_HEX}`;
export const PGOS1_OBJECT_ID = "0192f0a0-1c2d-7e3f-8a4b-5c6d7e8f9012";

interface Pgos1Metadata {
  kek_version: number;
  wrapped_dek: string;
  dek_nonce: string;
  stream_prefix: string;
  chunk_size: number;
  chunk_count: number;
  plaintext_sha256: string;
  plaintext_size: number;
}

interface PreviousPgos1Case extends VectorCase {
  objectId?: string;
  plaintextBase64?: string;
  streamBase64?: string;
  metadata?: Pgos1Metadata;
}

/** Read the TS frame lengths so the Rust side can assert the framing directly. */
const frameLengthsOf = (stream: Buffer, chunkSize: number, plaintextLength: number): number[] => {
  const lengths: number[] = [];
  let offset = 5; // magic
  while (offset < stream.length) {
    if (offset + 4 > stream.length) {
      throw new Error("truncated pgos1 frame header");
    }
    const declared = stream.readUInt32BE(offset);
    offset += 4;
    if (offset + declared + 16 > stream.length) {
      throw new Error("truncated pgos1 frame body");
    }
    offset += declared + 16;
    lengths.push(declared);
  }
  if (offset !== stream.length) {
    throw new Error("pgos1 stream has trailing bytes");
  }
  const expectedFrames = Math.ceil(plaintextLength / chunkSize);
  if (lengths.length !== expectedFrames) {
    throw new Error(`pgos1 has ${lengths.length} frames, expected ${expectedFrames}`);
  }
  if (lengths.reduce((total, length) => total + length, 0) !== plaintextLength) {
    throw new Error("pgos1 frame lengths do not add up to the plaintext length");
  }
  for (let index = 0; index < lengths.length - 1; index += 1) {
    if (lengths[index] !== chunkSize) {
      throw new Error(`non-final pgos1 frame ${index} is ${lengths[index]}, expected ${chunkSize}`);
    }
  }
  return lengths;
};

const pgos1Cases = (previous: Map<string, VectorCase>): VectorCase[] => {
  const provider = new InMemoryKeyProvider({
    activeVersion: 1,
    keysByVersion: new Map([[1, Buffer.from(PGOS1_KEK_HEX, "hex")]]),
  });
  const cases: VectorCase[] = [];

  for (const entry of PGOS1_CASES) {
    const plaintext = buildPatternPayload(entry.byteLength, entry.fill);
    const plaintextBase64 = base64(plaintext);
    const plaintextSha256 = createHash("sha256").update(plaintext).digest("hex");

    let streamBase64: string | undefined;
    let metadata: Pgos1Metadata | undefined;
    const existing = previous.get(entry.id) as PreviousPgos1Case | undefined;
    if (
      existing &&
      existing.objectId === PGOS1_OBJECT_ID &&
      existing.plaintextBase64 === plaintextBase64 &&
      typeof existing.streamBase64 === "string" &&
      existing.metadata
    ) {
      try {
        const stored = existing.metadata;
        const opened = decryptPgos1ToBuffer({
          ciphertext: Buffer.from(existing.streamBase64, "base64"),
          objectId: PGOS1_OBJECT_ID,
          kekKeyVersion: stored.kek_version,
          wrappedDek: Buffer.from(stored.wrapped_dek, "base64"),
          dekNonce: Buffer.from(stored.dek_nonce, "base64"),
          streamNoncePrefix: Buffer.from(stored.stream_prefix, "base64"),
          expectedChunkCount: stored.chunk_count,
          expectedByteSize: BigInt(stored.plaintext_size),
          expectedSha256Hex: stored.plaintext_sha256,
          keyProvider: provider,
        });
        if (base64(opened) === plaintextBase64 && stored.plaintext_sha256 === plaintextSha256) {
          streamBase64 = existing.streamBase64;
          metadata = stored;
        }
      } catch {
        streamBase64 = undefined;
        metadata = undefined;
      }
    }

    if (!streamBase64 || !metadata) {
      const sealed = encryptBufferToPgos1(plaintext, PGOS1_OBJECT_ID, provider, entry.chunkSize);
      streamBase64 = base64(sealed.ciphertextBytes);
      metadata = {
        kek_version: sealed.kekKeyVersion,
        wrapped_dek: base64(sealed.wrappedDek),
        dek_nonce: base64(sealed.dekNonce),
        stream_prefix: base64(sealed.streamNoncePrefix),
        chunk_size: sealed.chunkSizeBytes,
        chunk_count: sealed.chunkCount,
        plaintext_sha256: sealed.plaintextSha256Hex,
        plaintext_size: Number(sealed.plaintextByteSize),
      };
    }

    const stream = Buffer.from(streamBase64, "base64");
    const opened = decryptPgos1ToBuffer({
      ciphertext: stream,
      objectId: PGOS1_OBJECT_ID,
      kekKeyVersion: metadata.kek_version,
      wrappedDek: Buffer.from(metadata.wrapped_dek, "base64"),
      dekNonce: Buffer.from(metadata.dek_nonce, "base64"),
      streamNoncePrefix: Buffer.from(metadata.stream_prefix, "base64"),
      expectedChunkCount: metadata.chunk_count,
      expectedByteSize: BigInt(metadata.plaintext_size),
      expectedSha256Hex: metadata.plaintext_sha256,
      keyProvider: provider,
    });
    if (base64(opened) !== plaintextBase64) {
      throw new Error(`pgos1 payload for ${entry.id} does not decrypt`);
    }

    cases.push({
      id: entry.id,
      objectId: PGOS1_OBJECT_ID,
      keyring: PGOS1_KEYRING,
      chunkSizeBoundary: entry.chunkSize,
      plaintextBase64,
      streamBase64,
      frameLengths: frameLengthsOf(stream, metadata.chunk_size, plaintext.length),
      metadata,
    });
  }
  return cases;
};

const readText = (path: string): string => readFileSync(path, "utf8");

/**
 * Build every vector file into `outDir`. Exported so `check.ts` can regenerate into a temp
 * directory without spawning a process.
 */
export const generate = async (options: GenerateOptions = {}): Promise<GenerateResult> => {
  const outDir = options.outDir ?? defaultVectorDir;
  const reuseFrom = options.refreshRandom ? undefined : options.reuseFrom ?? outDir;
  const files: GenerateFileResult[] = [];

  const write = (
    name: string,
    contract: string,
    cases: readonly VectorCase[],
    extras: Record<string, unknown> = {},
    notes?: readonly string[],
  ): void => {
    const path = writeVector(outDir, name, GENERATOR, contract, cases, extras, notes);
    files.push({ name, path, bytes: Buffer.byteLength(readText(path), "utf8"), cases: cases.length });
  };

  write(
    "fnv-shares.json",
    "FNV-1a 32-bit over UTF-16 code units (core-back/lib/storageEngine/shardBalances.ts): offset 0x811c9dc5, prime 0x01000193, charCodeAt per unit. shards[count] = fnv1a32 % count; MERCHANT_WALLET is pinned to shard 0 (walletShard16).",
    fnvCases(),
  );

  write(
    "money-decimal.json",
    "decimal.js (the class behind Prisma.Decimal) at default precision 20. decimalToString = Decimal#toString (negative zero prints '0'); toFixed4 = Decimal#toFixed(4) with the default ROUND_HALF_UP; prismaJson.v = JSON.stringify(Prisma.Decimal) (negative zero prints '-0'). Rounding = toDecimalPlaces(4, mode) with the commission mapping of core-back/api/internal/checkout.ts:368-387.",
    moneyCases(),
    {},
    [
      "decimal.js accepts exponent notation and negative zero; rust_decimal 1.43 FromStr falls back to from_scientific_lossy for e/E inputs (seven cases), and Decimal::from_scientific is the exact route.",
      "toFixed(4) is decimal.js ROUND_HALF_UP at 4 dp and never prints the sign of zero; rust_decimal round_dp defaults to MidpointNearestEven and keeps -0.",
    ],
  );

  write(
    "js-key-order.json",
    "JavaScript object key order: canonical array indices (decimal digits without a leading zero, <= 4294967294) first in ascending numeric order, then string keys in insertion order. stringified = JSON.stringify of the object built from insertion pairs; objectKeys = Object.keys of the same object.",
    keyOrderCases(),
  );

  write(
    "js-dates.json",
    "JavaScript Date#toISOString(): UTC, exactly three fraction digits (milliseconds, truncated), 'Z' suffix, expanded six-digit years outside 0000-9999. invalid cases throw RangeError. iso-date-only is parsed as UTC midnight per ECMA-262.",
    dateCases(),
  );

  write(
    "vault.json",
    "Vault column encryption (core-back/engine/crypto/Vault.ts): payload = keyId:b64(iv12):b64(tag16):b64(ct), AES-256-GCM with AAD = utf8(keyId); key = HKDF-SHA256(masterKey, salt = utf8(keyId), info = 'payment-gateway:vault:aes-256-gcm:v1', 32). masterKey is the 32 ASCII bytes of KMS_MASTER_KEY used as-is. sign = hex HMAC-SHA256(data) under the same derived key.",
    await vaultCases(loadPreviousCases(reuseFrom, "vault.json")),
    { kmsMasterKey: KMS_MASTER_KEY, keyEncoding: "utf8-32-bytes" },
    [
      "encrypt payloads contain a random 12-byte IV by construction; the generator reuses the committed payload after proving it decrypts, so regeneration is byte-stable. --refresh-random mints new ones.",
      "resolution=env uses new Vault() with KMS_MASTER_KEY set and KMS_KEYS_JSON cleared; resolution=explicit uses new Vault({ masterKey }).",
    ],
  );

  write(
    "webhooks.json",
    "Standard Webhooks (core-back/lib/webhooks/standardWebhooks.ts): webhook-signature = 'v1,' + base64(HMAC-SHA256(base64decode(secret after 'whsec_'), '<webhook-id>.<timestamp-seconds>.<body>')). Multi-secret headers join one 'v1,...' per active secret with a single space.",
    webhookCases(),
    { signingSecret: WEBHOOK_SECRET, rotationSecret: WEBHOOK_ROTATION_SECRET },
  );

  write(
    "canonical.json",
    "CryptoEngine canonicalisation (core-back/engine/crypto/CryptoEngine.ts:193-230): SORTED_KEY_VALUE_AMP sorts keys with JS .sort() (UTF-16 code units) and renders key=value joined by '&' (null/undefined -> '', objects -> JSON.stringify); SORTED_VALUES_HASH sorts keys then joins values with valueSeparator (default '') and hides 'hashed' unless excludedFields is given; JSON_CANONICAL recursively sorts and JSON.stringify's; TEMPLATE_STRING replaces {{a.b}} and {a.b}. include/exclude match field names case-insensitively and exclusion wins.",
    canonicalCases(),
    {},
    [
      "json-integer-like-keys asserts JS's own re-ordering of canonical array indices during JSON.stringify after the recursive sort.",
    ],
  );

  write(
    "pgos1.json",
    "pgos1 object envelope (core-back/lib/objectStorageSdk/crypto.ts:169-221): magic 'pgos1' | frames u32be(plaintextLen) | ciphertext(plaintextLen) | tag(16) to EOF; chunk nonce = prefix[0..7] | u32be(index) | u8(final); AAD = uuidBytes(objectId)[16] | u32be(index) | u8(final); DEK 32 random bytes wrapped AES-256-GCM under KEK vN with nonce12 and AAD 'dek:<objectId>:v<N>', stored as ct(32) | tag(16). metadata uses the pg-objstore ObjectCryptoMetadata field names (snake_case).",
    pgos1Cases(loadPreviousCases(reuseFrom, "pgos1.json")),
    { keyring: PGOS1_KEYRING, activeKekVersion: 1, objectId: PGOS1_OBJECT_ID },
    [
      "streams contain a random DEK, 7-byte nonce prefix and wrapped-DEK nonce by construction; the generator reuses the committed stream after proving it decrypts. --refresh-random mints new ones.",
      "frameLengths lists the u32be value of every frame in order: the plaintext length of that chunk (16-byte GCM tag is not included).",
    ],
  );

  return { outDir, files };
};

interface CliOptions extends GenerateOptions {
  help?: boolean;
}

const parseArgs = (argv: readonly string[]): CliOptions => {
  const options: CliOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--out") {
      const value = argv[++index];
      if (!value) throw new Error("--out needs a directory");
      options.outDir = value;
    } else if (argument === "--reuse-from") {
      const value = argv[++index];
      if (!value) throw new Error("--reuse-from needs a directory");
      options.reuseFrom = value;
    } else if (argument === "--refresh-random") {
      options.refreshRandom = true;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  return options;
};

const main = async (): Promise<void> => {
  let options: CliOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
    return;
  }
  if (options.help) {
    console.log(
      [
        "usage: bun backend-rs/tools/golden/generate.ts [--out DIR] [--reuse-from DIR] [--refresh-random]",
        "",
        "  --out DIR          destination (default backend-rs/tests/golden-vectors/)",
        "  --reuse-from DIR   reuse random vault/pgos1 payloads from DIR (default: --out)",
        "  --refresh-random   mint new vault/pgos1 payloads (changes the committed bytes)",
      ].join("\n"),
    );
    return;
  }

  const result = await generate(options);
  let totalBytes = 0;
  let totalCases = 0;
  for (const file of result.files) {
    totalBytes += file.bytes;
    totalCases += file.cases;
    console.log(`${file.name.padEnd(20)} ${String(file.cases).padStart(4)} cases ${String(file.bytes).padStart(9)} bytes`);
  }
  console.log(
    `${"total".padEnd(20)} ${String(totalCases).padStart(4)} cases ${String(totalBytes).padStart(9)} bytes -> ${result.outDir}`,
  );
};

if (import.meta.main) {
  await main();
}
