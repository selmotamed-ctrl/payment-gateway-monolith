/**
 * Deterministic inputs for every golden-vector file.
 *
 * Everything here is a literal or a pure function of a literal: no clock, no randomness, no
 * environment. The random payloads of `vault.json` and `pgos1.json` are produced by the TypeScript
 * implementation itself and stored in the vector (see `generate.ts`).
 */

export const SHARD_COUNTS = [1, 2, 16, 32, 128, 256] as const;

/**
 * 20 ledger reference ids covering ASCII, Arabic, astral (emoji / U+10348), a NUL byte, long
 * strings and the empty string. FNV-1a in `shardBalances.ts` iterates UTF-16 code units.
 */
export const FNV_REFERENCES: readonly string[] = [
  "",
  "a",
  "foobar",
  "ref-1",
  "attempt-0192f0a0-1c2d-7e3f-8a4b-5c6d7e8f9012",
  "payment:link:pl_8f14e45fceea167a",
  "route-1:link-abc",
  "merchant:0192f0a0-0000-7000-8000-00000000abcd",
  "مرحبا",
  "الدفع الإلكتروني",
  "فاتورة-12345",
  "مبلغ ١٢٣٤٥ دينار",
  "😀",
  "😀😀😀",
  "𐍈",
  "a😀b",
  "x".repeat(300),
  "عقد".repeat(120),
  "  spaces and\ttab\nnewline  ",
  "nul\u0000byte",
];

/** 30 decimal strings: zero, negative, 4-dp edge, numeric(18,4) bounds and exponent forms. */
export const DECIMAL_INPUTS: readonly string[] = [
  "0",
  "-0",
  "0.0000",
  "-0.0000",
  "0.0001",
  "-0.0001",
  "0.00001",
  "0.00005",
  "1",
  "-1",
  "1.5",
  "-1.5",
  "1.2300",
  "100.0000",
  "12345678901234.1234",
  "12345678901234.1235",
  "-12345678901234.1234",
  "99999999999999.9999",
  "0.1234",
  "0.12345",
  "1.23445",
  "2.34555",
  "1e3",
  "1e-3",
  "1e20",
  "1e21",
  "1e-7",
  "1.5e-7",
  "9.999999999999999e20",
  "12.3456789012345678",
];

export const ROUNDING_MODES = [
  "HALF_UP",
  "HALF_EVEN",
  "HALF_DOWN",
  "UP",
  "DOWN",
  "CEILING",
  "FLOOR",
] as const;

export type RoundingModeName = (typeof ROUNDING_MODES)[number];

/** Midpoint, odd-midpoint and negative-midpoint so every mode has a distinct result. */
export const ROUNDING_VALUES = ["0.12345", "1.23445", "-2.34555"] as const;

/**
 * Aliases accepted by `roundingModeOf` (`core-back/api/internal/checkout.ts:368-387`) and the
 * fallback for unknown values. Copied from the source because the module cannot be imported
 * (it boots the Prisma client and validates the whole environment at import time).
 */
export const ROUNDING_ALIASES: ReadonlyArray<{ mode: string; target: RoundingModeName }> = [
  { mode: "BANKERS", target: "HALF_EVEN" },
  { mode: "CEIL", target: "CEILING" },
  { mode: "ROUND_UP", target: "UP" },
  { mode: "NONSENSE", target: "HALF_UP" },
];

export type DateCase =
  | { id: string; kind: "epochMs"; input: number }
  | { id: string; kind: "iso"; input: string }
  | { id: string; kind: "invalid" };

/** 12 valid Date constructions plus one rejected one. */
export const DATE_CASES: readonly DateCase[] = [
  { id: "epoch-zero", kind: "epochMs", input: 0 },
  { id: "epoch-plus-one-ms", kind: "epochMs", input: 1 },
  { id: "before-epoch-minus-one-ms", kind: "epochMs", input: -1 },
  { id: "year-1900", kind: "epochMs", input: -2208988800000 },
  { id: "2023-11-14T22-13-20Z", kind: "epochMs", input: 1700000000000 },
  { id: "2023-11-14T22-13-20-123Z", kind: "epochMs", input: 1700000000123 },
  { id: "iso-fraction-one-digit", kind: "iso", input: "2026-11-28T10:20:30.1Z" },
  { id: "iso-fraction-two-digits", kind: "iso", input: "2026-11-28T10:20:30.12Z" },
  { id: "iso-fraction-six-digits", kind: "iso", input: "2026-11-28T10:20:30.123456Z" },
  { id: "iso-date-only", kind: "iso", input: "2026-11-28" },
  { id: "year-9999", kind: "epochMs", input: 253402300799999 },
  { id: "max-date", kind: "epochMs", input: 8640000000000000 },
  { id: "invalid-nan", kind: "invalid" },
];

export interface KeyOrderCase {
  id: string;
  /** Insertion pairs; nested values are plain JSON and keep their literal key order. */
  pairs: ReadonlyArray<readonly [string, unknown]>;
}

/** 10 nested objects exercising the JS integer-like key rule (chapter 2 §13). */
export const KEY_ORDER_CASES: readonly KeyOrderCase[] = [
  {
    id: "mixed-basic",
    pairs: [
      ["b", 1],
      ["10", 2],
      ["2", 3],
      ["a", 4],
      ["0", 5],
    ],
  },
  {
    id: "non-canonical-indices",
    pairs: [
      ["01", 1],
      ["4294967295", 2],
      ["4294967294", 3],
    ],
  },
  {
    id: "nested-index-object",
    pairs: [
      ["z", 0],
      ["outer", { b: 1, "10": 2, "2": 3, a: 4, "0": 5 }],
    ],
  },
  {
    id: "nested-in-array",
    pairs: [
      ["list", [{ "2": "b", "1": "a", x: true }, "tail"]],
      ["1", 0],
    ],
  },
  {
    id: "reverse-indices",
    pairs: [
      ["10", 10],
      ["9", 9],
      ["8", 8],
      ["3", 3],
      ["2", 2],
      ["1", 1],
      ["0", 0],
      ["ten", "10"],
    ],
  },
  {
    id: "near-index-strings",
    pairs: [
      ["1.0", 1],
      ["-1", 2],
      [" 1", 3],
      ["1 ", 4],
      ["10", 5],
      ["0", 6],
    ],
  },
  {
    id: "unicode-keys",
    pairs: [
      ["مفتاح", 1],
      ["😀", 2],
      ["0", 3],
      ["�", 4],
      ["z", 5],
    ],
  },
  {
    id: "deep-nesting",
    pairs: [
      [
        "level1",
        {
          "2": "two",
          level2: { "10": "ten", "0": "zero", leaf: { "1": 1, b: 2 } },
        },
      ],
      ["a", "first"],
    ],
  },
  {
    id: "index-boundary",
    pairs: [
      ["4294967294", "max-index"],
      ["4294967295", "not-index"],
      ["4294967296", "not-index"],
      ["0", "zero"],
    ],
  },
  {
    id: "arrays-and-empty",
    pairs: [
      ["empty", {}],
      ["arr", []],
      ["nested", [{ "2": 2, "1": 1 }, []]],
      ["2", "two"],
    ],
  },
];

export interface CanonicalCase {
  id: string;
  mode: string;
  fields: Record<string, unknown>;
  includedFields?: readonly string[];
  excludedFields?: readonly string[];
  templateString?: string;
  valueSeparator?: string;
}

/**
 * 17 canonicalisation cases: 3 per requested mode plus include/exclude variants of
 * `SORTED_KEY_VALUE_AMP` and two default-behaviour cases (`hashed` exclusion, literal braces).
 * Every field value is JSON-representable, which is exactly what `pg_crypto::canonical` accepts.
 */
export const CANONICAL_CASES: readonly CanonicalCase[] = [
  {
    id: "skv-basic",
    mode: "SORTED_KEY_VALUE_AMP",
    fields: { b: "2", a: "x", C: null, amount: "10.0000" },
  },
  {
    id: "skv-nested-and-empty",
    mode: "SORTED_KEY_VALUE_AMP",
    fields: { meta: { z: 1, a: 2 }, note: "a b", empty: "" },
  },
  {
    id: "skv-unicode-keys",
    mode: "SORTED_KEY_VALUE_AMP",
    fields: { مبلغ: "10", "😀": "e", "�": "r" },
  },
  {
    id: "svh-joined",
    mode: "SORTED_VALUES_HASH",
    fields: { a: "2", b: "1" },
  },
  {
    id: "svh-separator",
    mode: "SORTED_VALUES_HASH",
    fields: { z: "9", a: "1", m: "5" },
    valueSeparator: "|",
  },
  {
    id: "svh-included",
    mode: "SORTED_VALUES_HASH",
    fields: { amount: "5", currency: "LYD", secret: "x" },
    includedFields: ["amount", "currency"],
  },
  {
    id: "svh-default-hashed-exclusion",
    mode: "SORTED_VALUES_HASH",
    fields: { a: "1", hashed: "x" },
  },
  {
    id: "json-nested",
    mode: "JSON_CANONICAL",
    fields: { b: { z: 1, a: 2 }, a: [{ y: 1, x: 2 }] },
  },
  {
    // JS re-orders canonical array indices numerically when it stringifies the sorted object;
    // this is the case that requires `js_object_order` after sorting.
    id: "json-integer-like-keys",
    mode: "JSON_CANONICAL",
    fields: { "10": "ten", "2": "two", b: 1, "0": "zero" },
  },
  {
    id: "json-unicode-null-number",
    mode: "JSON_CANONICAL",
    fields: { مفتاح: "قيمة", "😀": true, n: null, num: 1.5 },
  },
  {
    id: "tpl-double-and-single",
    mode: "TEMPLATE_STRING",
    fields: { amount: "10.0000", currency: "LYD", missing: null },
    templateString: "{{amount}}|{currency}|{{missing}}",
  },
  {
    id: "tpl-nested-and-missing",
    mode: "TEMPLATE_STRING",
    fields: { a: { b: 7, c: "x" } },
    templateString: "{a.b}-{a.c}-{nope.here}",
  },
  {
    id: "tpl-included-fields",
    mode: "TEMPLATE_STRING",
    fields: { id: 42, m: { amount: "9" }, ignored: "x" },
    includedFields: ["id", "m"],
    templateString: "id={{id}}&m={m.amount}",
  },
  {
    id: "tpl-literal-braces",
    mode: "TEMPLATE_STRING",
    fields: { a: 1 },
    templateString: "{a}|{not valid!}|{ }|{{a}}",
  },
  {
    id: "skv-included",
    mode: "SORTED_KEY_VALUE_AMP",
    fields: { amount: "1", currency: "LYD", secret: "s" },
    includedFields: ["amount", "currency"],
  },
  {
    id: "skv-excluded-case-insensitive",
    mode: "SORTED_KEY_VALUE_AMP",
    fields: { amount: "1", secret: "s", token: "t" },
    excludedFields: ["SECRET", "Token"],
  },
  {
    id: "skv-included-and-excluded",
    mode: "SORTED_KEY_VALUE_AMP",
    fields: { a: "1", b: "2", c: "3", d: "4" },
    includedFields: ["a", "b", "c"],
    excludedFields: ["b"],
  },
];

export interface WebhookCase {
  id: string;
  webhookId: string;
  timestampSeconds: number;
  body: string;
}

/** 5 signing cases: empty-ish JSON, a realistic event, Arabic, astral emoji and a long body. */
export const WEBHOOK_CASES: readonly WebhookCase[] = [
  { id: "webhook-empty-object", webhookId: "evt_00000000000000000000000000000001", timestampSeconds: 1700000000, body: "{}" },
  {
    id: "webhook-payment-succeeded",
    webhookId: "evt_0192f0a0-1c2d-7e3f-8a4b-5c6d7e8f9012",
    timestampSeconds: 1700000001,
    body: JSON.stringify({
      id: "evt_0192f0a0-1c2d-7e3f-8a4b-5c6d7e8f9012",
      type: "payment.succeeded",
      created: 1700000001,
      data: { attemptId: "0192f0a0-0000-7000-8000-000000000002", amount: "10.0000", currency: "LYD" },
    }),
  },
  {
    id: "webhook-arabic-body",
    webhookId: "evt_0192f0a0-1c2d-7e3f-8a4b-5c6d7e8f9013",
    timestampSeconds: 1700000002,
    body: JSON.stringify({ type: "cashout.paid", data: { note: "تم الدفع بنجاح", amount: "250.5000" } }),
  },
  {
    id: "webhook-emoji-body",
    webhookId: "evt_0192f0a0-1c2d-7e3f-8a4b-5c6d7e8f9014",
    timestampSeconds: 1700000003,
    body: JSON.stringify({ type: "dispute.opened", data: { reason: "😀 chargeback 😀", reference: "DIS-1" } }),
  },
  {
    id: "webhook-long-body",
    webhookId: "evt_0192f0a0-1c2d-7e3f-8a4b-5c6d7e8f9015",
    timestampSeconds: 1700000004,
    body: JSON.stringify({ type: "link.expired", data: { note: "x".repeat(1000) } }),
  },
];

export interface VaultEncryptCase {
  id: string;
  keyId: string;
  plaintext: string;
  /** `explicit` = `new Vault({ masterKey })`; `env` = `new Vault()` reading `KMS_MASTER_KEY`. */
  resolution: "explicit" | "env";
}

/** 8 encrypt cases (4 key ids, including an empty plaintext) plus one env-resolution case. */
export const VAULT_ENCRYPT_CASES: readonly VaultEncryptCase[] = [
  { id: "vault-encrypt-test-key-basic", keyId: "test-key", plaintext: "hello vault", resolution: "explicit" },
  { id: "vault-encrypt-test-key-empty", keyId: "test-key", plaintext: "", resolution: "explicit" },
  { id: "vault-encrypt-mfa-sms-code", keyId: "mfa-sms", plaintext: "483920", resolution: "explicit" },
  {
    id: "vault-encrypt-mfa-sms-arabic",
    keyId: "mfa-sms",
    plaintext: "رمز التحقق ٤٨٣٩٢٠",
    resolution: "explicit",
  },
  {
    id: "vault-encrypt-credential-set-json",
    keyId: "credential-set",
    plaintext: JSON.stringify({ apiKey: "sk_live_test_0123456789", merchant: "مرحبا", enabled: true }),
    resolution: "explicit",
  },
  {
    id: "vault-encrypt-credential-set-long",
    keyId: "credential-set",
    plaintext: "credential-".repeat(200),
    resolution: "explicit",
  },
  {
    id: "vault-encrypt-reporting-xml",
    keyId: "reporting-xml",
    plaintext: '<?xml version="1.0" encoding="UTF-8"?><Report><Memo>😀 تقرير</Memo></Report>',
    resolution: "explicit",
  },
  {
    id: "vault-encrypt-test-key-long-arabic",
    keyId: "test-key",
    plaintext: "عقد الدفع الإلكتروني ".repeat(15),
    resolution: "explicit",
  },
  {
    id: "vault-encrypt-env-master-key",
    keyId: "test-key",
    plaintext: "resolved from KMS_MASTER_KEY",
    resolution: "env",
  },
];

/** Deterministic `Vault.sign` cases; Rust reproduces the hex HMAC-SHA256 exactly. */
export const VAULT_SIGN_CASES: ReadonlyArray<{ id: string; keyId: string; data: string }> = [
  { id: "vault-sign-audit-anchor", keyId: "audit-anchor-v1", data: "audit-anchor/v1|42|abc123|10" },
  { id: "vault-sign-audit-anchor-empty", keyId: "audit-anchor-v1", data: "" },
  { id: "vault-sign-test-key", keyId: "test-key", data: "the quick brown fox" },
  { id: "vault-sign-mfa-sms", keyId: "mfa-sms", data: "user:0192f0a0-0000-7000-8000-000000000001" },
  { id: "vault-sign-webhook-secret", keyId: "webhook-secret", data: "evt_0192f0a0|1700000000|{}" },
  { id: "vault-sign-arabic", keyId: "reporting-xml", data: "تقرير شهري ٢٠٢٦" },
];

export interface Pgos1Case {
  id: string;
  byteLength: number;
  /** `pattern` = `(index * 31 + 7) & 0xff`; `zero` = a single 0x00 byte. */
  fill: "pattern" | "zero";
  chunkSize: number;
}

/**
 * 5 payload shapes at a 4096-byte chunk: 1 byte, exactly one chunk, chunk + 1, 5000 bytes and
 * 200000 bytes (49 chunks).
 */
export const PGOS1_CASES: readonly Pgos1Case[] = [
  { id: "pgos1-1-byte", byteLength: 1, fill: "zero", chunkSize: 4096 },
  { id: "pgos1-exactly-one-chunk", byteLength: 4096, fill: "pattern", chunkSize: 4096 },
  { id: "pgos1-chunk-plus-one", byteLength: 4097, fill: "pattern", chunkSize: 4096 },
  { id: "pgos1-5000-bytes", byteLength: 5000, fill: "pattern", chunkSize: 4096 },
  { id: "pgos1-200000-bytes", byteLength: 200000, fill: "pattern", chunkSize: 4096 },
];

export const buildPatternPayload = (byteLength: number, fill: "pattern" | "zero"): Uint8Array => {
  const bytes = new Uint8Array(byteLength);
  if (fill === "zero") {
    return bytes;
  }
  for (let index = 0; index < byteLength; index += 1) {
    bytes[index] = (index * 31 + 7) & 0xff;
  }
  return bytes;
};
