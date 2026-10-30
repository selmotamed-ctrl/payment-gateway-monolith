import { afterEach, describe, expect, test } from "bun:test";
import { startFakeRailProvider, type FakeRailProviderHandle } from "../engine/fakeRails/provider";

let provider: FakeRailProviderHandle | undefined;

afterEach(() => {
  provider?.stop();
  provider = undefined;
});

const start = (publicBaseUrl = "https://pay.example.test") => {
  provider = startFakeRailProvider({
    host: "127.0.0.1",
    port: 0,
    apiKey: "test-key",
    hmacSecret: "test-secret",
    publicBaseUrl,
    scenarioProfile: "happy",
  });
  return provider;
};

const post = (url: string, body: unknown) =>
  fetch(`${url}${url.endsWith("/") ? "" : ""}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "test-key" },
    body: JSON.stringify(body),
  });

describe("fake rail provider", () => {
  test("exposes a health endpoint without authentication", async () => {
    const started = start();
    const response = await fetch(`${started.url}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok", service: "fake-rails" });
  });

  test("requires the configured API key", async () => {
    const started = start();
    const response = await fetch(`${started.url}/otp/initiate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(401);
  });

  test("completes the OTP happy path with 123456", async () => {
    const started = start();
    const initiated = await post(`${started.url}/otp/initiate`, {
      reference: "SYNTH-PA-1",
      amount: "100.0000",
      currency: "LYD",
      environment: "LIVE",
    });
    const session = await initiated.json() as { process_id: string; provider_reference: string };
    expect(session.process_id).toBeTruthy();

    const wrong = await post(`${started.url}/otp/confirm`, {
      process_id: session.process_id,
      code: "000000",
      reference: "SYNTH-PA-1",
      amount: "100.0000",
      currency: "LYD",
      environment: "LIVE",
    });
    expect((await wrong.json() as { status: string }).status).toBe("INVALID_OTP");

    const confirmed = await post(`${started.url}/otp/confirm`, {
      process_id: session.process_id,
      code: "123456",
      reference: "SYNTH-PA-1",
      amount: "100.0000",
      currency: "LYD",
      environment: "LIVE",
    });
    expect((await confirmed.json() as { status: string }).status).toBe("SUCCESS");
  });

  test("returns QR data and a successful status", async () => {
    const started = start();
    const initiated = await post(`${started.url}/qr/initiate`, {
      reference: "SYNTH-PA-2",
      amount: "50.0000",
      currency: "LYD",
      environment: "LIVE",
    });
    const body = await initiated.json() as { qr_payload: string; pay_code: string };
    expect(body.qr_payload).toContain("fake://pay/");
    expect(body.pay_code).toBeTruthy();
    const status = await post(`${started.url}/qr/status`, {
      reference: "SYNTH-PA-2",
      amount: "50.0000",
      currency: "LYD",
      environment: "LIVE",
    });
    expect((await status.json() as { status: string }).status).toBe("SUCCESS");
  });

  test("builds a redirect URL and completes it", async () => {
    const started = start("https://pay.example.test");
    const initiated = await post(`${started.url}/redirect/initiate`, {
      reference: "SYNTH-PA-3",
      attempt_id: "att_3",
      link_key: "link_3",
      amount: "75.0000",
      currency: "LYD",
      environment: "LIVE",
    });
    const body = await initiated.json() as { redirect_url: string; return_token: string; action_type: string };
    expect(body.action_type).toBe("HTTP_REDIRECT");
    expect(body.redirect_url).toContain("https://pay.example.test/pay/fake-provider/");
    const token = body.return_token;
    const completed = await post(`${started.url}/redirect/complete`, {
      token,
      decision: "APPROVE",
      reference: "SYNTH-PA-3",
      amount: "75.0000",
      currency: "LYD",
      environment: "LIVE",
    });
    expect((await completed.json() as { status: string }).status).toBe("SUCCESS");
  });
});
