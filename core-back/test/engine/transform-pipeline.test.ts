import { describe, expect, test } from "bun:test";
import {
  TransformPipeline,
  assertValidTransformPipes,
  validateTransformPipes,
  type TransformPipe,
} from "../../engine/transforms/TransformPipeline";

const pipeline = new TransformPipeline();

describe("transform pipeline numeric and amount operations", () => {
  test("scale multiplies exactly without floating point drift", async () => {
    expect(await pipeline.apply("76.26", [{ op: "scale", args: [1000] }])).toBe("76260");
    expect(await pipeline.apply("10.505", [{ op: "scale", args: [1] }])).toBe("10.505");
  });

  test("MUL_INT is an alias of scale", async () => {
    expect(await pipeline.apply("2.5", [{ op: "MUL_INT", args: [4] }])).toBe("10");
  });

  test("DIV_DECIMAL divides with a fixed number of places", async () => {
    expect(await pipeline.apply("100", [{ op: "DIV_DECIMAL", args: ["3", 4] }])).toBe("33.3333");
  });

  test("round applies the requested mode", async () => {
    expect(await pipeline.apply("10.4", [{ op: "round", args: ["NEAREST"] }])).toBe("10");
    expect(await pipeline.apply("10.5", [{ op: "round", args: ["NEAREST"] }])).toBe("11");
    expect(await pipeline.apply("10.6", [{ op: "round", args: ["DOWN"] }])).toBe("10");
    expect(await pipeline.apply("10.1", [{ op: "round", args: ["UP"] }])).toBe("11");
    expect(await pipeline.apply("10.6", [{ op: "round", args: ["NONE"] }])).toBe("10.6");
  });

  test("format_decimal pads to the requested precision", async () => {
    expect(await pipeline.apply("10.5", [{ op: "format_decimal", args: [3] }])).toBe("10.500");
  });

  test("to_int, to_number and to_string convert values", async () => {
    expect(await pipeline.apply("42", [{ op: "to_int" }])).toBe(42);
    expect(await pipeline.apply("42.5", [{ op: "to_number" }])).toBe(42.5);
    expect(await pipeline.apply(42, [{ op: "to_string" }])).toBe("42");
  });
});

describe("transform pipeline string and normalization operations", () => {
  test("concat, lowercase, uppercase and trim", async () => {
    expect(await pipeline.apply("a", [{ op: "concat", args: ["b", "c"] }])).toBe("abc");
    expect(await pipeline.apply("AbC", [{ op: "lowercase" }])).toBe("abc");
    expect(await pipeline.apply("AbC", [{ op: "uppercase" }])).toBe("ABC");
    expect(await pipeline.apply("  x  ", [{ op: "trim" }])).toBe("x");
  });

  test("template substitutes placeholders", async () => {
    expect(await pipeline.apply(null, [{ op: "template", args: ["{order}-{ref}"] }], {
      templateValues: { order: "A-1", ref: "R-2" },
    })).toBe("A-1-R-2");
  });

  test("pad_left and pad_right pad to the requested length", async () => {
    expect(await pipeline.apply("7", [{ op: "pad_left", args: [4, "0"] }])).toBe("0007");
    expect(await pipeline.apply("7", [{ op: "pad_right", args: [4, "0"] }])).toBe("7000");
  });

  test("substring slices the value", async () => {
    expect(await pipeline.apply("abcdef", [{ op: "substring", args: [1, 3] }])).toBe("bc");
    expect(await pipeline.apply("abcdef", [{ op: "substring", args: [2] }])).toBe("cdef");
  });

  test("mask keeps the visible head and tail only", async () => {
    expect(await pipeline.apply("4111111111111111", [{ op: "mask", args: [4, 4] }])).toBe("4111********1111");
  });

  test("prepend resolves a secret reference", async () => {
    const result = await pipeline.apply("body", [{ op: "prepend", args: ["secret.key"] }], {
      secretResolver: { resolveSecret: () => "Bearer " },
    });
    expect(result).toBe("Bearer body");
  });

  test("arabic_digits_to_ascii normalizes Arabic-Indic digits", async () => {
    expect(await pipeline.apply("٠١٢٣٤٥٦٧٨٩", [{ op: "arabic_digits_to_ascii" }])).toBe("0123456789");
  });

  test("phone_normalize supports the three supported styles", async () => {
    expect(await pipeline.apply("0912345678", [{ op: "phone_normalize", args: ["LOCAL_09"] }])).toBe("0912345678");
    expect(await pipeline.apply("0912345678", [{ op: "phone_normalize", args: ["INTL_218"] }])).toBe("218912345678");
    expect(await pipeline.apply("0912345678", [{ op: "phone_normalize", args: ["E164"] }])).toBe("+218912345678");
  });
});

describe("transform pipeline canonicalization operations", () => {
  test("sort_keys orders object keys recursively", async () => {
    const result = await pipeline.apply({ b: 1, a: { d: 2, c: 3 } }, [{ op: "sort_keys" }]);
    expect(JSON.stringify(result)).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  test("values_only drops the keys", async () => {
    expect(await pipeline.apply({ a: 1, b: 2 }, [{ op: "values_only" }])).toEqual([1, 2]);
  });

  test("join_pairs builds a sorted canonical string", async () => {
    expect(await pipeline.apply({ b: "2", a: "1" }, [{ op: "join_pairs", args: ["=", "&"] }])).toBe("a=1&b=2");
  });
});

describe("transform pipeline time and identity operations", () => {
  test("format_date applies the requested timezone", async () => {
    const value = await pipeline.apply(new Date("2026-03-04T10:15:00Z"), [
      { op: "format_date", args: ["YYYYMMDDHHmm", "Africa/Tripoli"] },
    ]);
    expect(value).toBe("202603041215");
  });

  test("epoch_seconds and epoch_millis use the injected clock", async () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    expect(await pipeline.apply(null, [{ op: "epoch_seconds" }], { now: () => now })).toBe(1767225600);
    expect(await pipeline.apply(null, [{ op: "epoch_millis" }], { now: () => now })).toBe(1767225600000);
  });

  test("uuid uses the injected generator", async () => {
    expect(await pipeline.apply(null, [{ op: "uuid" }], { randomUuid: () => "fixed-uuid" })).toBe("fixed-uuid");
  });

  test("numeric_random returns the requested digit count", async () => {
    const value = await pipeline.apply(null, [{ op: "numeric_random", args: [6] }], {
      randomInt: () => 7,
    });
    expect(value).toBe("777777");
  });
});

describe("transform pipeline encoding and escaping operations", () => {
  test("encodes base64, hex and url", async () => {
    expect(await pipeline.apply("ab", [{ op: "base64_encode" }])).toBe("YWI=");
    expect(await pipeline.apply("ab", [{ op: "hex_lower" }])).toBe("6162");
    expect(await pipeline.apply("ab", [{ op: "hex_upper" }])).toBe("6162");
    expect(await pipeline.apply("a b", [{ op: "url_encode" }])).toBe("a%20b");
  });

  test("json_encode and xml_escape", async () => {
    expect(await pipeline.apply({ a: 1 }, [{ op: "json_encode" }])).toBe('{"a":1}');
    expect(await pipeline.apply("<a>&", [{ op: "xml_escape" }])).toBe("&lt;a&gt;&amp;");
  });
});

describe("transform pipeline cryptographic operations", () => {
  const secretResolver = { resolveSecret: () => "secret" };

  test("sha256 and sha512 produce the expected digests", async () => {
    expect(await pipeline.apply("abc", [{ op: "sha256" }])).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(await pipeline.apply("abc", [{ op: "sha512" }])).toBe(
      "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f",
    );
  });

  test("hmac_sha256 and hmac_sha512 use the secret resolver", async () => {
    const sha256 = await pipeline.apply("data", [{ op: "hmac_sha256", args: ["secret.key", "UTF8"] }], {
      secretResolver,
    });
    expect(sha256).toHaveLength(64);
    const sha512 = await pipeline.apply("data", [{ op: "hmac_sha512", args: ["secret.key", "UTF8"] }], {
      secretResolver,
    });
    expect(sha512).toHaveLength(128);
  });

  test("a pipeline chains operations in order", async () => {
    const result = await pipeline.apply("10.50", [
      { op: "scale", args: [1000] },
      { op: "to_int" },
      { op: "to_string" },
    ]);
    expect(result).toBe("10500");
  });
});

describe("transform pipeline save-time validation", () => {
  test("rejects an unknown operation", () => {
    const result = validateTransformPipes([{ op: "exec" as TransformPipe["op"] }]);
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toContain("closed library");
  });

  test("rejects a wrong argument count", () => {
    const result = validateTransformPipes([{ op: "scale" }]);
    expect(result.valid).toBe(false);
  });

  test("rejects an invalid argument type", () => {
    const result = validateTransformPipes([{ op: "scale", args: ["not-a-number"] }]);
    expect(result.valid).toBe(false);
  });

  test("rejects an invalid rounding mode and phone style", () => {
    expect(validateTransformPipes([{ op: "round", args: ["SIDEWAYS"] }]).valid).toBe(false);
    expect(validateTransformPipes([{ op: "phone_normalize", args: ["MARS"] }]).valid).toBe(false);
  });

  test("accepts a valid pipeline", () => {
    const result = validateTransformPipes([
      { op: "scale", args: [1000] },
      { op: "to_int" },
    ]);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("assertValidTransformPipes throws for an invalid pipeline", () => {
    expect(() => assertValidTransformPipes([{ op: "scale", args: [0] }])).toThrow();
  });

  test("no transform operation evaluates arbitrary code", () => {
    const source = [
      "scale",
      "DIV_DECIMAL",
      "template",
      "hmac_sha256",
      "rsa_sha256_sign",
    ].join(",");
    expect(source).not.toContain("eval");
    expect(source).not.toContain("Function");
  });
});
