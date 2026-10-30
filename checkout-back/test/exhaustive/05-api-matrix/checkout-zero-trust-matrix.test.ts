/**
 * Suite 05.4 — checkout zero-trust boundary.
 *
 * The payer-facing edge must never accept money, currency, identity or status
 * from the browser; the core resolves them from the payment link. Exercises
 * the real `zReady` schemas, the monetary-field scanner and the inbound
 * environment / header translation.
 */
import { describe, expect, test } from "bun:test";
import {
  assertNoMonetaryFields,
  findForbiddenMonetaryField,
  isForbiddenMonetaryField,
  translateClientEvent,
  zAttemptId,
  zClientEvent,
  zIdempotencyKey,
  zLinkKey,
  zOtp,
  zRailCode,
} from "../../../lib/zReady/index";
import {
  INBOUND_ENVIRONMENTS,
  pickForwardableHeaders,
  translateInboundEnvironment,
} from "../../../api/public/inbound";
const errorCode = (error: unknown): string | undefined =>
  error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : undefined;

const FORBIDDEN = [
  "amount",
  "amountMinor",
  "amountMajor",
  "amountLYD",
  "amountMinorUnits",
  "currency",
  "currencyCode",
  "total",
  "totalAmount",
  "fee",
  "fees",
  "commission",
  "commissionAmount",
  "exchangeRate",
  "price",
  "netAmount",
  "grossAmount",
  "debitAmount",
  "creditAmount",
] as const;

const SAFE_FIELDS = [
  "phone",
  "otp",
  "reference",
  "customerName",
  "birthYear",
  "walletId",
  "cardLast4",
  "sessionId",
  "note",
  "language",
] as const;

describe("Suite 05 · forbidden monetary fields", () => {
  const variants = (name: string): string[] => [
    name,
    name.toUpperCase(),
    name.replace(/[A-Z]/g, (letter) => `_${letter}`).toLowerCase(),
    name.replace(/[A-Z]/g, (letter) => `-${letter}`).toLowerCase(),
  ];

  for (const name of FORBIDDEN) {
    for (const variant of variants(name)) {
      test(`'${variant}' is refused at the top level`, () => {
        expect(isForbiddenMonetaryField(variant)).toBe(true);
        let code: string | undefined;
        try {
          assertNoMonetaryFields({ [variant]: "1.0000" });
        } catch (error) {
          code = errorCode(error);
        }
        expect(code).toBe("AMOUNT_NOT_ACCEPTED");
      });
    }

    test(`'${name}' is refused when nested`, () => {
      let code: string | undefined;
      try {
        assertNoMonetaryFields({ formData: { profile: { [name]: 1 } } });
      } catch (error) {
        code = errorCode(error);
      }
      expect(code).toBe("AMOUNT_NOT_ACCEPTED");
    });

    test(`'${name}' is refused inside an array`, () => {
      let code: string | undefined;
      try {
        assertNoMonetaryFields({ items: [{ ok: true }, { [name]: 1 }] });
      } catch (error) {
        code = errorCode(error);
      }
      expect(code).toBe("AMOUNT_NOT_ACCEPTED");
    });
  }

  for (const name of SAFE_FIELDS) {
    test(`'${name}' is accepted`, () => {
      expect(isForbiddenMonetaryField(name)).toBe(false);
      expect(() => assertNoMonetaryFields({ [name]: "value" })).not.toThrow();
    });
  }

  test("findForbiddenMonetaryField reports the dotted path", () => {
    expect(findForbiddenMonetaryField({ formData: { amount: "10" } })).toBe("formData.amount");
  });

  test("findForbiddenMonetaryField returns null for a clean payload", () => {
    expect(findForbiddenMonetaryField({ formData: { phone: "0912345678" } })).toBeNull();
  });

  test("the scanner never recurses past the depth budget", () => {
    let payload: Record<string, unknown> = { amount: "1" };
    for (let index = 0; index < 20; index += 1) {
      payload = { child: payload };
    }
    expect(findForbiddenMonetaryField(payload)).toBeNull();
  });
});

describe("Suite 05 · checkout zod boundaries", () => {
  const cases: Array<{ schema: { safeParse: (value: unknown) => { success: boolean } }; valid: unknown[]; invalid: unknown[]; label: string }> = [
    {
      label: "zLinkKey",
      schema: zLinkKey,
      valid: ["LNK_123", "abcdef", "A".repeat(64)],
      invalid: ["", "abc", "A".repeat(65), "has space", "has/slash"],
    },
    {
      label: "zAttemptId",
      schema: zAttemptId,
      valid: ["ATT_123", "abcdef"],
      invalid: ["", "abc", "has space", "has/slash"],
    },
    {
      label: "zRailCode",
      schema: zRailCode,
      valid: ["MOAMALAT", "sadad", "numo_pay"],
      invalid: ["", "bad rail", "bad/rail", "x".repeat(65)],
    },
    {
      label: "zOtp",
      schema: zOtp,
      valid: ["1234", "123456", "12345678"],
      invalid: ["", "123", "123456789", "abcd"],
    },
    {
      label: "zIdempotencyKey",
      schema: zIdempotencyKey,
      valid: ["idem-00000001", "A_b.c:d-12345678"],
      invalid: ["short", "has space", "has/slash", "x".repeat(129)],
    },
  ];

  for (const entry of cases) {
    for (const value of entry.valid) {
      test(`${entry.label} accepts ${JSON.stringify(value).slice(0, 30)}`, () => {
        expect(entry.schema.safeParse(value).success).toBe(true);
      });
    }
    for (const value of entry.invalid) {
      test(`${entry.label} refuses ${JSON.stringify(value).slice(0, 30)}`, () => {
        expect(entry.schema.safeParse(value).success).toBe(false);
      });
    }
  }

  const eventAliases: Array<[string, string | undefined]> = [
    ["completeCallback", "completeCallback"],
    ["COMPLETE_CALLBACK", "completeCallback"],
    ["complete-callback", "completeCallback"],
    ["complete_callback", "completeCallback"],
    ["errorCallback", "errorCallback"],
    ["ERROR_CALLBACK", "errorCallback"],
    ["CANCEL_CALLBACK", "errorCallback"],
    ["widgetEvent", "widgetEvent"],
    ["WIDGET_READY", "widgetEvent"],
    ["WIDGET_CLOSED", "widgetEvent"],
    ["returnHint", "returnHint"],
    ["RETURN_HINT", "returnHint"],
    ["NOT_AN_EVENT", undefined],
  ];
  for (const [input, expected] of eventAliases) {
    test(`translateClientEvent(${input}) -> ${String(expected)}`, () => {
      expect(translateClientEvent(input)).toBe(expected as never);
    });
  }

  for (const event of ["completeCallback", "errorCallback", "widgetEvent", "returnHint"]) {
    test(`zClientEvent accepts ${event}`, () => {
      expect(zClientEvent.safeParse(event).success).toBe(true);
    });
  }
  test("zClientEvent refuses an unknown event", () => {
    expect(zClientEvent.safeParse("drop_tables").success).toBe(false);
  });
});

describe("Suite 05 · inbound environment & headers", () => {
  const expected: Record<string, "SANDBOX" | "LIVE"> = {
    sandbox: "SANDBOX",
    test: "SANDBOX",
    uat: "SANDBOX",
    live: "LIVE",
    production: "LIVE",
  };
  for (const [input, canonical] of Object.entries(expected)) {
    test(`translateInboundEnvironment(${input}) -> ${canonical}`, () => {
      expect(translateInboundEnvironment(input)).toBe(canonical);
      expect(translateInboundEnvironment(input.toUpperCase())).toBe(canonical);
      expect(translateInboundEnvironment(` ${input} `)).toBe(canonical);
    });
  }
  test("an unknown inbound environment is refused", () => {
    expect(errorCode((() => {
      try {
        translateInboundEnvironment("staging");
      } catch (error) {
        return error;
      }
      return undefined;
    })())).toBe("INBOUND_ENVIRONMENT_INVALID");
    expect(INBOUND_ENVIRONMENTS).toHaveLength(5);
  });

  test("pickForwardableHeaders keeps the allow-listed signature headers", () => {
    const forwarded = pickForwardableHeaders({
      "content-type": "application/json",
      "x-signature": "sig",
      "x-gateway-signature": "sig2",
      "x-hub-signature-256": "sig3",
      "x-timestamp": "1",
      "x-nonce": "n",
      "authorization": "Bearer secret",
      "cookie": "session=secret",
      "x-internal-token": "leak",
    });
    expect(forwarded["content-type"]).toBe("application/json");
    expect(forwarded["x-signature"]).toBe("sig");
    expect(forwarded["x-gateway-signature"]).toBe("sig2");
    expect(forwarded["x-hub-signature-256"]).toBe("sig3");
    expect(forwarded["x-timestamp"]).toBe("1");
    expect(forwarded["x-nonce"]).toBe("n");
    expect(forwarded.authorization).toBeUndefined();
    expect(forwarded.cookie).toBeUndefined();
    expect(forwarded["x-internal-token"]).toBeUndefined();
  });

  test("pickForwardableHeaders joins repeated header values", () => {
    const forwarded = pickForwardableHeaders({ "x-signature": ["a", "b"] });
    expect(forwarded["x-signature"]).toBe("a, b");
  });
});
