import { createHmac, timingSafeEqual } from "node:crypto";

export type FakeRailScenarioProfile = "happy" | "mixed" | "chaos";

export interface FakeRailProviderOptions {
  host: string;
  port: number;
  apiKey?: string;
  hmacSecret?: string;
  publicBaseUrl?: string;
  scenarioProfile?: FakeRailScenarioProfile;
  now?: () => Date;
}

export interface FakeRailProviderHandle {
  stop: () => void;
  port: number;
  url: string;
}

const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status });

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

const text = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : value === undefined || value === null ? fallback : String(value);

const numberText = (value: unknown, fallback = "0.0000"): string => {
  const candidate = text(value, fallback);
  return /^\d{1,14}(\.\d{1,4})?$/.test(candidate) ? candidate : fallback;
};

export class FakeRailProvider {
  private readonly options: FakeRailProviderOptions;
  private readonly secret: string;
  private server?: ReturnType<typeof Bun.serve>;

  constructor(options: FakeRailProviderOptions) {
    this.options = options;
    this.secret = options.hmacSecret || options.apiKey || "fake-rails-local-secret";
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private sign(payload: Record<string, unknown>): string {
    const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const signature = createHmac("sha256", this.secret).update(body).digest("base64url");
    return `${body}.${signature}`;
  }

  private verify(token: string): Record<string, unknown> | null {
    const [body, signature] = token.split(".");
    if (!body || !signature) return null;
    const expected = createHmac("sha256", this.secret).update(body).digest("base64url");
    const provided = Buffer.from(signature);
    const wanted = Buffer.from(expected);
    if (provided.length !== wanted.length || !timingSafeEqual(provided, wanted)) return null;
    try {
      const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as unknown;
      return asRecord(parsed);
    } catch {
      return null;
    }
  }

  private authorize(request: Request): boolean {
    if (!this.options.apiKey) return true;
    return request.headers.get("x-api-key") === this.options.apiKey;
  }

  private outcomeFor(amount: string, reference: string): "SUCCESS" | "FAILED" | "UNKNOWN" {
    if (this.options.scenarioProfile === "happy") return "SUCCESS";
    if (amount.endsWith(".13") || reference.includes("FAIL")) return "FAILED";
    if (amount.endsWith(".17") || reference.includes("UNKNOWN")) return "UNKNOWN";
    return "SUCCESS";
  }

  private statusBody(payload: Record<string, unknown>, status: "SUCCESS" | "FAILED" | "UNKNOWN" = "SUCCESS") {
    const reference = text(payload.reference, `FAKE-${Date.now()}`);
    const amount = numberText(payload.amount);
    const currency = text(payload.currency, "LYD").toUpperCase();
    return {
      status,
      reference,
      provider_reference: text(payload.provider_reference, `FAKE-PROV-${reference}`),
      amount,
      currency,
      environment: text(payload.environment, "LIVE"),
      settled_amount: amount,
      gateway_fee: "0.8000",
    };
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return json({ status: "ok", service: "fake-rails", profile: this.options.scenarioProfile ?? "mixed" });
    }
    if (!this.authorize(request)) {
      return json({ error: "UNAUTHORIZED" }, 401);
    }
    let body: Record<string, unknown> = {};
    if (request.method !== "GET") {
      try {
        body = asRecord(await request.json());
      } catch {
        body = {};
      }
    }

    switch (url.pathname) {
      case "/otp/initiate": {
        const reference = text(body.reference);
        const amount = numberText(body.amount);
        const token = this.sign({ kind: "otp", reference, amount, currency: text(body.currency, "LYD"), environment: text(body.environment, "LIVE"), iat: this.now().getTime() });
        return json({
          ...this.statusBody({ ...body, provider_reference: `FAKE-OTP-${reference}` }, "SUCCESS"),
          status: "PENDING",
          process_id: token,
          otp_reference: token,
        });
      }
      case "/otp/confirm": {
        const process = this.verify(text(body.process_id));
        if (!process) return json({ error: "INVALID_PROCESS" }, 400);
        const code = text(body.code ?? body.otp);
        const merged = { ...process, ...body };
        if (code !== "123456") {
          return json({ ...this.statusBody(merged, "FAILED"), status: "INVALID_OTP", error_code: "INVALID_OTP" });
        }
        return json(this.statusBody(merged, this.outcomeFor(numberText(merged.amount), text(merged.reference))));
      }
      case "/otp/resend":
        return json({ status: "PENDING", reference: text(body.reference) });
      case "/qr/initiate": {
        const reference = text(body.reference);
        const token = this.sign({ kind: "qr", reference, amount: numberText(body.amount), currency: text(body.currency, "LYD"), environment: text(body.environment, "LIVE"), iat: this.now().getTime() });
        return json({
          ...this.statusBody({ ...body, provider_reference: `FAKE-QR-${reference}` }, "SUCCESS"),
          status: "PENDING",
          action_type: "SHOW_QR_OR_CODE",
          qr_payload: `fake://pay/${encodeURIComponent(token)}`,
          pay_code: reference.slice(-10).toUpperCase(),
          deep_link_url: `fake://pay/${encodeURIComponent(token)}`,
          instructions_ar: "امسح رمز QR التجريبي.",
          instructions_en: "Scan the demo QR code.",
        });
      }
      case "/qr/status":
      case "/push/status":
      case "/inquiry": {
        const reference = text(body.reference);
        return json(this.statusBody(body, this.outcomeFor(numberText(body.amount), reference)));
      }
      case "/push/initiate": {
        const reference = text(body.reference);
        return json({
          ...this.statusBody({ ...body, provider_reference: `FAKE-PUSH-${reference}` }, "SUCCESS"),
          status: "PENDING",
          action_type: "SHOW_PUSH_OR_TRANSFER",
          wallet_hint: "Demo Wallet",
          destination_account: "DEMO-218-0001",
          payment_reference: reference,
          instructions_ar: "وافق على طلب الدفع التجريبي.",
          instructions_en: "Approve the demo payment request.",
        });
      }
      case "/redirect/initiate": {
        const reference = text(body.reference);
        const token = this.sign({
          kind: "redirect",
          reference,
          attempt_id: text(body.attempt_id),
          link_key: text(body.link_key),
          amount: numberText(body.amount),
          currency: text(body.currency, "LYD"),
          environment: text(body.environment, "LIVE"),
          iat: this.now().getTime(),
        });
        const base = this.options.publicBaseUrl?.replace(/\/$/, "") ?? "";
        return json({
          ...this.statusBody({ ...body, provider_reference: `FAKE-REDIRECT-${reference}` }, "SUCCESS"),
          status: "PENDING",
          action_type: "HTTP_REDIRECT",
          method: "GET",
          target: "SAME_WINDOW",
          redirect_url: base ? `${base}/pay/fake-provider/${encodeURIComponent(token)}` : `fake-provider://${token}`,
          return_token: token,
        });
      }
      case "/redirect/complete": {
        const process = this.verify(text(body.token));
        if (!process) return json({ error: "INVALID_TOKEN" }, 400);
        const decision = text(body.decision, "APPROVE").toUpperCase();
        const merged = { ...process, ...body };
        if (decision === "DECLINE" || decision === "FAIL") {
          return json({ ...this.statusBody(merged, "FAILED"), status: "FAILED" });
        }
        return json(this.statusBody(merged, this.outcomeFor(numberText(merged.amount), text(merged.reference))));
      }
      case "/refund": {
        return json({ ...this.statusBody(body, "SUCCESS"), status: "REFUNDED" });
      }
      default:
        return json({ error: "NOT_FOUND", path: url.pathname }, 404);
    }
  }

  start(): FakeRailProviderHandle {
    if (this.server) {
      return { stop: () => this.stop(), port: this.server.port ?? this.options.port, url: `http://${this.options.host}:${this.server.port ?? this.options.port}` };
    }
    this.server = Bun.serve({
      hostname: this.options.host,
      port: this.options.port,
      fetch: (request) => this.handle(request),
    });
    const port = this.server.port ?? this.options.port;
    return { stop: () => this.stop(), port, url: `http://${this.options.host}:${port}` };
  }

  stop(): void {
    this.server?.stop(true);
    this.server = undefined;
  }
}

export const startFakeRailProvider = (options: FakeRailProviderOptions): FakeRailProviderHandle => {
  const provider = new FakeRailProvider(options);
  return provider.start();
};
