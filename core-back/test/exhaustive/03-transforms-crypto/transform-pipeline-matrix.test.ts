/**
 * Suite 03.1 — the closed transform library.
 *
 * Every operation is exercised in isolation, inside chains, and through the
 * save-time validator of the real `TransformPipeline`.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { generateKeyPairSync } from "node:crypto";
import {
  TransformPipeline,
  TRANSFORM_OPERATIONS,
  type TransformOperation,
  type TransformPipe,
} from "../../../engine/transforms/TransformPipeline";
import { CryptoEngine } from "../../../engine/crypto/CryptoEngine";
import { Xoshiro128StarStar } from "../_harness";

const FIXED_NOW = new Date("2026-01-02T03:04:05.000Z");
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const secrets: Record<string, string> = {
  "test-key": "secret",
  "rsa-key": privateKey,
};

const pipeline = new TransformPipeline({
  secretResolver: { resolveSecret: (reference) => secrets[reference] ?? "" },
  now: () => FIXED_NOW,
  randomUuid: () => "fixed-uuid",
  randomInt: () => 7,
});

interface Sample {
  input: unknown;
  pipes: TransformPipe[];
  expected: unknown;
  objectInput?: boolean;
  chainable?: boolean;
}

const ARABIC_DIGITS = "٠٩١٢٣٤٥٦٧٨";

const SAMPLES: Record<TransformOperation, Sample> = {
  scale: { input: "10.50", pipes: [{ op: "scale", args: [1000] }], expected: "10500" },
  MUL_INT: { input: "10.50", pipes: [{ op: "MUL_INT", args: [10] }], expected: "105" },
  DIV_DECIMAL: { input: "10", pipes: [{ op: "DIV_DECIMAL", args: ["2", 2] }], expected: "5" },
  round: { input: "76.255", pipes: [{ op: "round", args: ["NEAREST", 2] }], expected: "76.26" },
  format_decimal: { input: "76.255", pipes: [{ op: "format_decimal", args: [2] }], expected: "76.25" },
  to_int: { input: "10.9", pipes: [{ op: "to_int" }], expected: 10 },
  to_number: { input: "10.50", pipes: [{ op: "to_number" }], expected: 10.5 },
  to_string: { input: 123, pipes: [{ op: "to_string" }], expected: "123" },
  concat: { input: "AB", pipes: [{ op: "concat", args: ["C", "D"] }], expected: "ABCD" },
  template: {
    input: "ignored",
    pipes: [{ op: "template", args: ["{{name}}-{id}"] }],
    expected: "x-2",
  },
  lowercase: { input: "ABC", pipes: [{ op: "lowercase" }], expected: "abc" },
  uppercase: { input: "abc", pipes: [{ op: "uppercase" }], expected: "ABC" },
  trim: { input: "  x  ", pipes: [{ op: "trim" }], expected: "x" },
  pad_left: { input: "7", pipes: [{ op: "pad_left", args: [3, "0"] }], expected: "007" },
  pad_right: { input: "7", pipes: [{ op: "pad_right", args: [3, "0"] }], expected: "700" },
  substring: { input: "abcdef", pipes: [{ op: "substring", args: [1, 4] }], expected: "bcd" },
  mask: { input: "1234567890", pipes: [{ op: "mask", args: [4, 4] }], expected: "1234**7890" },
  prepend: { input: "world", pipes: [{ op: "prepend", args: ["test-key"] }], expected: "secretworld" },
  arabic_digits_to_ascii: {
    input: ARABIC_DIGITS,
    pipes: [{ op: "arabic_digits_to_ascii" }],
    expected: "0912345678",
  },
  phone_normalize: {
    input: "0912345678",
    pipes: [{ op: "phone_normalize", args: ["INTL_218"] }],
    expected: "218912345678",
  },
  sort_keys: { input: { b: 2, a: 1 }, pipes: [{ op: "sort_keys" }], expected: { a: 1, b: 2 }, objectInput: true },
  values_only: { input: { b: 2, a: 1 }, pipes: [{ op: "values_only" }], expected: [2, 1], objectInput: true },
  join_pairs: {
    input: { b: 2, a: 1 },
    pipes: [{ op: "join_pairs", args: ["=", "&"] }],
    expected: "a=1&b=2",
    objectInput: true,
  },
  format_date: {
    input: FIXED_NOW,
    pipes: [{ op: "format_date", args: ["YYYYMMDDHHmm", "Africa/Tripoli"] }],
    expected: "202601020504",
  },
  epoch_seconds: { input: FIXED_NOW, pipes: [{ op: "epoch_seconds" }], expected: Math.floor(FIXED_NOW.getTime() / 1000) },
  epoch_millis: { input: FIXED_NOW, pipes: [{ op: "epoch_millis" }], expected: FIXED_NOW.getTime() },
  uuid: { input: null, pipes: [{ op: "uuid" }], expected: "fixed-uuid" },
  numeric_random: { input: null, pipes: [{ op: "numeric_random", args: [6] }], expected: "777777" },
  base64_encode: { input: "hello", pipes: [{ op: "base64_encode" }], expected: "aGVsbG8=" },
  hex_lower: { input: "A", pipes: [{ op: "hex_lower" }], expected: "41" },
  hex_upper: { input: "ab", pipes: [{ op: "hex_upper" }], expected: "6162" },
  url_encode: { input: "a b&c", pipes: [{ op: "url_encode" }], expected: "a%20b%26c" },
  json_encode: { input: { a: 1 }, pipes: [{ op: "json_encode" }], expected: '{"a":1}', objectInput: true },
  xml_escape: {
    input: `<a>&"'`,
    pipes: [{ op: "xml_escape" }],
    expected: "&lt;a&gt;&amp;&quot;&apos;",
  },
  sha256: { input: "abc", pipes: [{ op: "sha256" }], expected: new CryptoEngine().sha256("abc") },
  sha512: { input: "abc", pipes: [{ op: "sha512" }], expected: new CryptoEngine().sha512("abc") },
  hmac_sha256: {
    input: "data",
    pipes: [{ op: "hmac_sha256", args: ["test-key"] }],
    expected: createHmac("sha256", "secret").update("data").digest("hex"),
  },
  hmac_sha512: {
    input: "data",
    pipes: [{ op: "hmac_sha512", args: ["test-key"] }],
    expected: createHmac("sha512", "secret").update("data").digest("hex"),
  },
  rsa_sha256_sign: {
    input: "data",
    pipes: [{ op: "rsa_sha256_sign", args: ["rsa-key"] }],
    expected: "verified",
  },
};

const context = { templateValues: { name: "x", id: 2 } };

afterAll(() => {
  // No shared state.
});

describe("Suite 03 · transform library completeness", () => {
  test(`the closed library exposes ${TRANSFORM_OPERATIONS.length} operations`, () => {
    expect(TRANSFORM_OPERATIONS.length).toBe(39);
    expect(Object.keys(SAMPLES).length).toBe(TRANSFORM_OPERATIONS.length);
  });
});

describe("Suite 03 · every operation in isolation", () => {
  for (const operation of TRANSFORM_OPERATIONS) {
    test(`${operation} produces its documented result`, async () => {
      const sample = SAMPLES[operation];
      const result = await pipeline.apply(sample.input, sample.pipes, context);
      if (operation === "rsa_sha256_sign") {
        const engine = new CryptoEngine();
        expect(engine.rsaSha256Verify(publicKey, "data", String(result), "BASE64")).toBe(true);
        return;
      }
      expect(result).toEqual(sample.expected);
    });

    test(`${operation} passes the save-time validator`, () => {
      const sample = SAMPLES[operation];
      expect(pipeline.validate(sample.pipes).valid).toBe(true);
    });
  }
});

describe("Suite 03 · three-to-six step chains", () => {
  for (const operation of TRANSFORM_OPERATIONS) {
    const sample = SAMPLES[operation];

    test(`${operation} survives a trailing to_string`, async () => {
      const result = await pipeline.apply(sample.input, [...sample.pipes, { op: "to_string" }], context);
      expect(typeof result).toBe("string");
    });

    test(`${operation} survives a trailing json_encode + sha256`, async () => {
      const result = await pipeline.apply(
        sample.input,
        [...sample.pipes, { op: "json_encode" }, { op: "sha256" }],
        context,
      );
      expect(String(result)).toMatch(/^[0-9a-f]{64}$/);
    });

    test(`${operation} survives a trailing base64_encode`, async () => {
      const result = await pipeline.apply(sample.input, [...sample.pipes, { op: "base64_encode" }], context);
      expect(typeof result).toBe("string");
    });

    if (!sample.objectInput) {
      test(`${operation} survives a leading to_string`, async () => {
        const result = await pipeline.apply(sample.input, [{ op: "to_string" }, ...sample.pipes], context);
        expect(result).toBeDefined();
      });
    }
  }
});

describe("Suite 03 · amount scaling & rounding examples", () => {
  const cases: Array<{ input: string; pipes: TransformPipe[]; expected: string }> = [
    { input: "10.50", pipes: [{ op: "scale", args: [1000] }, { op: "to_int" }, { op: "to_string" }], expected: "10500" },
    { input: "76.255", pipes: [{ op: "round", args: ["NEAREST", 2] }, { op: "format_decimal", args: [2] }], expected: "76.26" },
    { input: "76.255", pipes: [{ op: "round", args: ["DOWN", 2] }], expected: "76.25" },
    { input: "76.251", pipes: [{ op: "round", args: ["UP", 2] }], expected: "76.26" },
    { input: "10.505", pipes: [{ op: "format_decimal", args: [3] }], expected: "10.505" },
    { input: "0.0001", pipes: [{ op: "scale", args: [10000] }, { op: "to_string" }], expected: "1" },
    { input: "99999999999999.9999", pipes: [{ op: "format_decimal", args: [4] }], expected: "99999999999999.9999" },
  ];

  for (const entry of cases) {
    test(`${entry.input} |> ${entry.pipes.map((pipe) => pipe.op).join(" |> ")} === ${entry.expected}`, async () => {
      expect(await pipeline.apply(entry.input, entry.pipes, context)).toBe(entry.expected);
    });
  }
});

describe("Suite 03 · Libyan phone normalization", () => {
  const cases: Array<{ input: string; style: "LOCAL_09" | "INTL_218" | "E164"; expected: string }> = [
    { input: "+218912345678", style: "LOCAL_09", expected: "0912345678" },
    { input: "00218912345678", style: "LOCAL_09", expected: "0912345678" },
    { input: "912345678", style: "LOCAL_09", expected: "0912345678" },
    { input: "0912345678", style: "INTL_218", expected: "218912345678" },
    { input: "+218912345678", style: "E164", expected: "+218912345678" },
  ];
  for (const entry of cases) {
    test(`${entry.input} -> ${entry.style} === ${entry.expected}`, async () => {
      expect(await pipeline.apply(entry.input, [{ op: "phone_normalize", args: [entry.style] }], context)).toBe(entry.expected);
    });
  }
});

describe("Suite 03 · Arabic-Indic digit normalization", () => {
  const cases = [
    { input: "٠٩١٢٣٤٥٦٧٨", expected: "0912345678" },
    { input: "۰۹۱۲۳٤٥٦٧٨", expected: "0912345678" },
    { input: "mixed ٠٩ abc ۸۹", expected: "mixed 09 abc 89" },
  ];
  for (const entry of cases) {
    test(`${entry.input} normalizes to ${entry.expected}`, async () => {
      expect(await pipeline.apply(entry.input, [{ op: "arabic_digits_to_ascii" }], context)).toBe(entry.expected);
    });
  }
});

describe("Suite 03 · timezone & historical instants", () => {
  const instants = [
    new Date("2024-02-29T23:59:59.000Z"),
    new Date("2026-01-01T00:00:00.000Z"),
    new Date("2011-02-17T00:00:00.000Z"),
  ];
  for (const instant of instants) {
    test(`${instant.toISOString()} formats in Africa/Tripoli`, async () => {
      const result = String(await pipeline.apply(instant, [
        { op: "format_date", args: ["YYYY-MM-DD HH:mm", "Africa/Tripoli"] },
      ], context));
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    });
  }
});

describe("Suite 03 · destination-aware escaping", () => {
  test("xml_escape neutralizes every XML metacharacter", async () => {
    expect(await pipeline.apply(`<script>&"'`, [{ op: "xml_escape" }], context)).toBe(
      "&lt;script&gt;&amp;&quot;&apos;",
    );
  });
  test("json_encode escapes quotes", async () => {
    expect(await pipeline.apply({ x: 'a"b' }, [{ op: "json_encode" }], context)).toBe('{"x":"a\\"b"}');
  });
  test("url_encode encodes a header injection payload", async () => {
    expect(await pipeline.apply("a\r\nX: 1", [{ op: "url_encode" }], context)).toBe("a%0D%0AX%3A%201");
  });
});

describe("Suite 03 · save-time validation rules", () => {
  const invalidPipes: Array<{ op: TransformOperation; pipes: TransformPipe[] }> = [
    { op: "scale", pipes: [{ op: "scale", args: [] }] },
    { op: "scale", pipes: [{ op: "scale", args: [0] }] },
    { op: "round", pipes: [{ op: "round", args: ["SIDEWAYS"] }] },
    { op: "round", pipes: [{ op: "round", args: ["NEAREST", 19] }] },
    { op: "pad_left", pipes: [{ op: "pad_left", args: [3, "xx"] }] },
    { op: "phone_normalize", pipes: [{ op: "phone_normalize", args: ["MARS"] }] },
    { op: "format_date", pipes: [{ op: "format_date", args: ["YYYY", "Not/AZone"] }] },
    { op: "concat", pipes: [{ op: "concat" }] },
    { op: "hmac_sha256", pipes: [{ op: "hmac_sha256", args: [""] }] },
  ];

  for (const entry of invalidPipes) {
    test(`${entry.op} rejects invalid arguments`, () => {
      expect(pipeline.validate(entry.pipes).valid).toBe(false);
    });
  }

  test("to_number is refused on monetary step outputs", () => {
    const result = pipeline.validateForStore([{ op: "to_number" }], "SETTLED_AMOUNT");
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.op).toBe("to_number");
  });

  test("to_number is refused on PROVIDER_FEE outputs", () => {
    expect(pipeline.validateForStore([{ op: "to_number" }], "PROVIDER_FEE").valid).toBe(false);
  });

  test("to_number is allowed on non-monetary outputs", () => {
    expect(pipeline.validateForStore([{ op: "to_number" }], "PUBLIC").valid).toBe(true);
  });

  test("an unknown operation is refused", () => {
    expect(pipeline.validate([{ op: "drop_tables" as TransformOperation }]).valid).toBe(false);
  });

  test("the validator reports the failing pipe index", () => {
    const result = pipeline.validate([{ op: "trim" }, { op: "scale", args: [0] }]);
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.index).toBe(1);
  });
});

describe("Suite 03 · deterministic fuzz of the amount operations", () => {
  const prng = new Xoshiro128StarStar("transforms-exhaustive");
  for (let index = 0; index < 120; index += 1) {
    const value = prng.decimalString(0.0001, 250000, 4);
    const factor = prng.int(1, 1000);
    test(`scale(${factor}) round-trips ${value}`, async () => {
      const scaled = await pipeline.apply(value, [{ op: "scale", args: [factor] }, { op: "to_string" }], context);
      expect(String(scaled)).toMatch(/^-?\d+(\.\d{1,4})?$/);
      const back = await pipeline.apply(
        String(scaled),
        [{ op: "DIV_DECIMAL", args: [String(factor), 4] }, { op: "format_decimal", args: [4] }],
        context,
      );
      expect(String(back)).toBe(value);
    });
  }
});
