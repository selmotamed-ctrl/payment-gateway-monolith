import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const previous = { ...process.env };
process.env.NODE_ENV = "test";
process.env.FAKE_RAILS_CONTROL_URL = "http://fake-rails.lab.internal:4104";
process.env.FAKE_RAILS_CONTROL_TOKEN = "control-token-very-secret";
process.env.FAKE_RAILS_PUBLIC_BASE_URL = "http://fake-rails.lab.internal:8444";

const realFetch = globalThis.fetch;
type ClientModule = typeof import("../engine/rails/FakeRailsControlClient");
let FakeRailsControlClient: ClientModule["FakeRailsControlClient"];

beforeAll(async () => {
  ({ FakeRailsControlClient } = await import("../engine/rails/FakeRailsControlClient"));
});

afterAll(() => {
  globalThis.fetch = realFetch;
  for (const key of Object.keys(process.env)) {
    if (!(key in previous)) delete process.env[key];
  }
  Object.assign(process.env, previous);
});

const account = {
  id: "acc-1",
  rail_code: "sadad",
  gateway_code: "sadad",
  merchant_id: null,
  instrument_type: "MOBILE_WALLET",
  identifier: "0911111111",
  holder_name: "Test",
  secret_pin: "1234",
  expiry: "12/28",
  currency: "LYD",
  available_balance_lyd: "100.0000",
  reserved_balance_lyd: "0.0000",
  daily_limit_lyd: "1000.0000",
  daily_spent_lyd: "0.0000",
  status: "ACTIVE",
  static_otp: null,
  preset_fault: null,
  notes: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

const mockFetch = (handler: (input: FetchInput, init?: FetchInit) => Promise<Response>) => {
  globalThis.fetch = Object.assign(
    async (input: FetchInput, init?: FetchInit) => handler(input, init),
    { preconnect: realFetch.preconnect },
  );
};

describe("Fake Rails control client", () => {
  test("lists accounts with the control token", async () => {
    let seenUrl = "";
    let seenToken = "";
    mockFetch(async (input, init) => {
      seenUrl = String(input);
      seenToken = String((init?.headers as Record<string, string>)?.["x-fake-rails-control-token"] ?? "");
      return new Response(JSON.stringify({ accounts: [account] }), { status: 200 });
    });
    const client = new FakeRailsControlClient();
    const accounts = await client.listAccounts({ merchantId: "m-1", railCode: "sadad" });
    expect(accounts).toHaveLength(1);
    expect(seenUrl).toContain("http://fake-rails.lab.internal:4104/control/accounts");
    expect(seenUrl).toContain("merchantId=m-1");
    expect(seenUrl).toContain("railCode=sadad");
    expect(seenToken).toBe("control-token-very-secret");
  });

  test("maps a control error to an ApiError and never leaks the token", async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({ code: "FAKE_ACCOUNT_NOT_FOUND", message: "missing" }), { status: 404 }),
    );
    const client = new FakeRailsControlClient();
    try {
      await client.adjustAccount("missing", { status: "FROZEN" }, "merchant-1");
      throw new Error("expected a failure");
    } catch (error) {
      expect((error as { statusCode?: number }).statusCode).toBe(404);
      expect((error as { code?: string }).code).toBe("FAKE_ACCOUNT_NOT_FOUND");
      expect(String((error as Error).message)).not.toContain("control-token");
    }
  });

  test("refuses to adjust an account owned by another merchant", async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({ account: { ...account, merchant_id: "other-merchant" } }), { status: 200 }),
    );
    const client = new FakeRailsControlClient();
    try {
      await client.adjustAccount("acc-1", { status: "FROZEN" }, "merchant-1");
      throw new Error("expected a failure");
    } catch (error) {
      expect((error as { statusCode?: number }).statusCode).toBe(403);
      expect((error as { code?: string }).code).toBe("FAKE_ACCOUNT_FORBIDDEN");
    }
  });

  test("maps an unreachable emulator to 502", async () => {
    mockFetch(async () => {
      throw new Error("connect ECONNREFUSED");
    });
    const client = new FakeRailsControlClient();
    try {
      await client.listAccounts();
      throw new Error("expected a failure");
    } catch (error) {
      expect((error as { statusCode?: number }).statusCode).toBe(502);
      expect((error as { code?: string }).code).toBe("FAKE_RAILS_UNAVAILABLE");
    }
  });

  test("simulates a customer action and reads the checkout helper", async () => {
    const calls: Array<{ url: string; method?: string; body?: string }> = [];
    mockFetch(async (input, init) => {
      calls.push({
        url: String(input),
        method: init?.method,
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      return new Response(
        JSON.stringify({ ok: true, transactionId: "tx-1", activeAttemptSecrets: null }),
        { status: 200 },
      );
    });
    const client = new FakeRailsControlClient();
    await client.simulateAction("REF-1", "APPROVE_PUSH_OR_QR");
    await client.checkoutHelper("REF-1");
    expect(calls[0]?.url).toContain("/control/checkout-helper/REF-1/simulate-action");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toContain("APPROVE_PUSH_OR_QR");
    expect(calls[1]?.url).toContain("/control/checkout-helper/REF-1");
    expect(calls[1]?.method).toBe("GET");
  });
});
