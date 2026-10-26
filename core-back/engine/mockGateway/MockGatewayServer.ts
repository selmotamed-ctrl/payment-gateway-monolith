import { createHash } from "node:crypto";
import { ApiConsumerError } from "../apiConsumer/ApiConsumer";
import { decimal, type DecimalInput } from "../ledger/LedgerPoster";
import type {
  AdapterAttempt,
  AdapterClientAction,
  AdapterEngineResult,
  AdapterEvidence,
  AdapterFormData,
  NativeAdapter,
} from "../flow/NativeAdapterRegistry";

export const MOCK_SCENARIOS = [
  "HAPPY_PATH",
  "WRONG_OTP_RETRY_SUCCESS",
  "EXPIRED_OTP",
  "INSUFFICIENT_FUNDS",
  "CUSTOMER_LIMIT_HIT",
  "CANCEL",
  "CONFIRM_5XX",
  "CONFIRM_TIMEOUT",
  "MALFORMED_RESPONSE",
  "DUPLICATE_WEBHOOK",
  "OUT_OF_ORDER_WEBHOOK",
  "LATE_WEBHOOK_AFTER_EXPIRY",
  "AMOUNT_MISMATCH",
  "THREE_DECIMAL_ROUNDING",
  "CROSS_ENVIRONMENT_WEBHOOK",
] as const;

export type MockScenario = (typeof MOCK_SCENARIOS)[number];

export interface MockGatewayOptions {
  timeoutSimulationMs?: number;
  webhookSecret?: string;
}

export interface MockScenarioResult {
  scenario: MockScenario;
  outcome:
    | "SUCCEEDED"
    | "AWAITING_CUSTOMER"
    | "FAILED"
    | "CANCELLED"
    | "UNKNOWN"
    | "DUPLICATE"
    | "LATE_SUCCESS";
  reference: string;
  amount: string;
  currency: string;
  environment: string;
}

export class MockGatewayServer implements NativeAdapter {
  private readonly wrongOtpAttempts = new Map<string, number>();
  private readonly seenWebhookKeys = new Set<string>();
  private readonly options: MockGatewayOptions;
  private server?: { stop(force?: boolean): void; url: URL; port?: number };

  constructor(options: MockGatewayOptions = {}) {
    this.options = options;
  }

  async preInitiate(attempt: AdapterAttempt, _formData: AdapterFormData): Promise<AdapterEngineResult> {
    return {
      attempt,
      status: attempt.status,
      outputs: { preflight: true },
    };
  }

  async initiate(attempt: AdapterAttempt, formData: AdapterFormData): Promise<AdapterEngineResult> {
    const scenario = this.scenarioFor(attempt);
    if (scenario === "CANCEL") {
      attempt.status = "CANCELLED";
      return { attempt, status: "CANCELLED", outputs: { cancelled: true } };
    }
    const reference = this.referenceFor(attempt);
    attempt.gatewayReference = reference;
    attempt.status = "AWAITING_CUSTOMER";
    const clientAction: AdapterClientAction = {
      type: "SHOW_OTP_FORM",
      payload: {
        otp_length: 4,
        max_attempts: attempt.maxOtpAttempts ?? 3,
        resend_cooldown_seconds: 30,
        expires_at: (attempt.expiresAt ?? new Date(Date.now() + 600000)).toISOString(),
        masked_phone: maskPhone(formData.phone ?? formData.customer_mobile),
      },
    };
    return {
      attempt,
      status: "AWAITING_CUSTOMER",
      clientAction,
      outputs: {
        reference,
        scenario,
        public: { reference },
      },
    };
  }

  async confirm(attempt: AdapterAttempt, evidence: AdapterEvidence): Promise<AdapterEngineResult> {
    const scenario = this.scenarioFor(attempt);
    if (scenario === "CONFIRM_5XX") {
      throw new ApiConsumerError("Mock gateway returned HTTP 500", {
        status: 500,
        retryable: true,
        moneyUncertain: true,
      });
    }
    if (scenario === "CONFIRM_TIMEOUT") {
      await this.delay(this.options.timeoutSimulationMs ?? 5);
      throw new ApiConsumerError("Mock gateway confirmation timed out", {
        retryable: true,
        moneyUncertain: true,
      });
    }
    if (scenario === "EXPIRED_OTP") {
      attempt.status = "FAILED";
      return { attempt, status: "FAILED", canonicalError: "OTP_EXPIRED", outputs: { scenario } };
    }
    if (scenario === "INSUFFICIENT_FUNDS") {
      attempt.status = "FAILED";
      return { attempt, status: "FAILED", canonicalError: "INSUFFICIENT_FUNDS", outputs: { scenario } };
    }
    if (scenario === "CUSTOMER_LIMIT_HIT") {
      attempt.status = "FAILED";
      return { attempt, status: "FAILED", canonicalError: "CUSTOMER_LIMIT_HIT", outputs: { scenario } };
    }
    if (scenario === "CANCEL") {
      attempt.status = "CANCELLED";
      return { attempt, status: "CANCELLED", outputs: { scenario } };
    }
    if (scenario === "WRONG_OTP_RETRY_SUCCESS") {
      const count = this.wrongOtpAttempts.get(attempt.id) ?? 0;
      if (count === 0) {
        this.wrongOtpAttempts.set(attempt.id, 1);
        attempt.status = "AWAITING_CUSTOMER";
        return {
          attempt,
          status: "AWAITING_CUSTOMER",
          canonicalError: "RETRYABLE_OTP",
          outputs: { scenario, otp_attempts: 1 },
        };
      }
    }
    if (scenario === "MALFORMED_RESPONSE") {
      attempt.status = "UNKNOWN";
      return {
        attempt,
        status: "UNKNOWN",
        canonicalError: "MALFORMED_RESPONSE",
        outputs: { scenario, malformed: true },
      };
    }
    const reference = attempt.gatewayReference ?? this.referenceFor(attempt);
    const amount = scenario === "AMOUNT_MISMATCH"
      ? decimal(attempt.totalChargedAmount).plus("0.01")
      : decimal(attempt.totalChargedAmount);
    attempt.gatewayReference = reference;
    attempt.status = "SUCCEEDED";
    return {
      attempt,
      status: "SUCCEEDED",
      outputs: {
        scenario,
        response: {
          status: "SUCCESS",
          reference,
          amount: amount.toFixed(4),
          currency: attempt.currency,
          environment: attempt.env,
        },
      },
    };
  }

  async verifyCallback(channel: string, rawRequest: unknown): Promise<AdapterEngineResult> {
    const request = rawRequest && typeof rawRequest === "object" ? rawRequest as Record<string, unknown> : {};
    const attemptId = String(request.attemptId ?? request.attempt_id ?? "mock-attempt");
    const scenario = this.scenarioFromRequest(request);
    const dedupeKey = String(request.dedupeKey ?? request.dedupe_key ?? `${channel}:${attemptId}`);
    if (this.seenWebhookKeys.has(dedupeKey)) {
      return {
        attempt: { id: attemptId, status: "SUCCEEDED", env: "SANDBOX", currency: "LYD", requestedAmount: "0", totalChargedAmount: "0" },
        status: "SUCCEEDED",
        outputs: { duplicate: true, scenario: "DUPLICATE_WEBHOOK" },
      };
    }
    this.seenWebhookKeys.add(dedupeKey);
    if (scenario === "OUT_OF_ORDER_WEBHOOK") {
      return {
        attempt: { id: attemptId, status: "VERIFYING", env: "SANDBOX", currency: "LYD", requestedAmount: "0", totalChargedAmount: "0" },
        status: "VERIFYING",
        outputs: { outOfOrder: true, scenario },
      };
    }
    if (scenario === "CROSS_ENVIRONMENT_WEBHOOK") {
      return {
        attempt: { id: attemptId, status: "UNKNOWN", env: "SANDBOX", currency: "LYD", requestedAmount: "0", totalChargedAmount: "0" },
        status: "UNKNOWN",
        canonicalError: "ENVIRONMENT_MISMATCH",
        outputs: { scenario },
      };
    }
    return {
      attempt: { id: attemptId, status: "SUCCEEDED", env: "SANDBOX", currency: "LYD", requestedAmount: "0", totalChargedAmount: "0" },
      status: "SUCCEEDED",
      outputs: {
        scenario,
        response: {
          status: "SUCCESS",
          reference: request.reference,
          amount: request.amount,
          currency: request.currency ?? "LYD",
          environment: request.environment ?? "SANDBOX",
        },
      },
    };
  }

  async inquire(attempt: AdapterAttempt): Promise<AdapterEngineResult> {
    const scenario = this.scenarioFor(attempt);
    if (scenario === "INSUFFICIENT_FUNDS" || scenario === "CUSTOMER_LIMIT_HIT" || scenario === "EXPIRED_OTP") {
      attempt.status = "FAILED";
      return { attempt, status: "FAILED", canonicalError: scenario, outputs: { scenario } };
    }
    const reference = attempt.gatewayReference ?? this.referenceFor(attempt);
    attempt.status = "SUCCEEDED";
    return {
      attempt,
      status: "SUCCEEDED",
      outputs: {
        scenario,
        response: {
          status: "SUCCESS",
          reference,
          amount: decimal(attempt.totalChargedAmount).toFixed(4),
          currency: attempt.currency,
          environment: attempt.env,
        },
      },
    };
  }

  async refund(attempt: AdapterAttempt, amount: DecimalInput, adjustmentId: string): Promise<AdapterEngineResult> {
    const scenario = this.scenarioFor(attempt);
    if (scenario === "CONFIRM_5XX" || scenario === "CONFIRM_TIMEOUT") {
      attempt.status = "UNKNOWN";
      return {
        attempt,
        status: "UNKNOWN",
        canonicalError: "REFUND_OUTCOME_UNKNOWN",
        outputs: { scenario, adjustmentId },
      };
    }
    const refundAmount = decimal(amount);
    attempt.status = refundAmount.eq(decimal(attempt.totalChargedAmount)) ? "REFUNDED" : "PARTIALLY_REFUNDED";
    return {
      attempt,
      status: attempt.status,
      outputs: { scenario, adjustmentId, refundAmount: refundAmount.toFixed(4) },
    };
  }

  runScenario(scenario: MockScenario, attempt: AdapterAttempt): MockScenarioResult {
    const reference = this.referenceFor(attempt);
    const failed = ["EXPIRED_OTP", "INSUFFICIENT_FUNDS", "CUSTOMER_LIMIT_HIT"];
    const unknown = ["CONFIRM_5XX", "CONFIRM_TIMEOUT", "MALFORMED_RESPONSE"];
    const cancelled = scenario === "CANCEL";
    const duplicate = scenario === "DUPLICATE_WEBHOOK";
    const late = scenario === "LATE_WEBHOOK_AFTER_EXPIRY";
    const environment = scenario === "CROSS_ENVIRONMENT_WEBHOOK" ? "LIVE" : attempt.env;
    const amount = scenario === "AMOUNT_MISMATCH"
      ? decimal(attempt.totalChargedAmount).plus("0.01")
      : decimal(attempt.totalChargedAmount);
    return {
      scenario,
      outcome: failed.includes(scenario)
        ? "FAILED"
        : unknown.includes(scenario)
          ? "UNKNOWN"
          : cancelled
            ? "CANCELLED"
            : duplicate
              ? "DUPLICATE"
              : late
                ? "LATE_SUCCESS"
                : "SUCCEEDED",
      reference,
      amount: amount.toFixed(4),
      currency: attempt.currency,
      environment,
    };
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const body = request.method === "GET" ? {} : await request.json() as Record<string, unknown>;
    const attempt = this.attemptFromBody(body);
    let result: AdapterEngineResult;
    if (url.pathname.endsWith("/pre-initiate")) {
      result = await this.preInitiate(attempt, body);
    } else if (url.pathname.endsWith("/initiate")) {
      result = await this.initiate(attempt, body);
    } else if (url.pathname.endsWith("/confirm")) {
      result = await this.confirm(attempt, body);
    } else if (url.pathname.endsWith("/inquire")) {
      result = await this.inquire(attempt);
    } else if (url.pathname.endsWith("/refund")) {
      result = await this.refund(attempt, String(body.amount ?? "0"), String(body.adjustmentId ?? "mock-adjustment"));
    } else if (url.pathname.endsWith("/webhook")) {
      result = await this.verifyCallback(String(body.channel ?? "webhook"), body);
    } else {
      return new Response(JSON.stringify({ error: "not_found" }), { status: 404, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify(result), {
      status: result.status === "SUCCEEDED" ? 200 : result.status === "FAILED" ? 422 : 202,
      headers: { "content-type": "application/json" },
    });
  }

  start(port = 0): { url: URL; port: number; stop: (force?: boolean) => void } {
    if (this.server) {
      return { url: this.server.url, port: this.server.port ?? port, stop: (force?: boolean) => this.server?.stop(force) };
    }
    this.server = Bun.serve({
      port,
      hostname: "127.0.0.1",
      fetch: (request) => this.handle(request),
    });
    return {
      url: this.server.url,
      port: this.server.port ?? port,
      stop: (force?: boolean) => this.server?.stop(force),
    };
  }

  stop(): void {
    this.server?.stop(true);
    this.server = undefined;
  }

  private scenarioFor(attempt: AdapterAttempt): MockScenario {
    const context = attempt.context ?? {};
    const candidate = context.scenario ?? context.mock_scenario;
    if (typeof candidate === "string" && MOCK_SCENARIOS.includes(candidate as MockScenario)) {
      return candidate as MockScenario;
    }
    return "HAPPY_PATH";
  }

  private scenarioFromRequest(request: Record<string, unknown>): MockScenario {
    const candidate = request.scenario;
    if (typeof candidate === "string" && MOCK_SCENARIOS.includes(candidate as MockScenario)) {
      return candidate as MockScenario;
    }
    return "HAPPY_PATH";
  }

  private attemptFromBody(body: Record<string, unknown>): AdapterAttempt {
    return {
      id: String(body.attemptId ?? body.id ?? "mock-attempt"),
      reference: String(body.reference ?? "mock-reference"),
      gatewayReference: body.gatewayReference ? String(body.gatewayReference) : undefined,
      status: "CREATED",
      env: String(body.env ?? "SANDBOX"),
      currency: String(body.currency ?? "LYD"),
      requestedAmount: String(body.requestedAmount ?? body.amount ?? "0"),
      totalChargedAmount: String(body.totalChargedAmount ?? body.amount ?? "0"),
      maxOtpAttempts: Number(body.maxOtpAttempts ?? 3),
      context: { scenario: body.scenario ?? "HAPPY_PATH" },
    };
  }

  private referenceFor(attempt: AdapterAttempt): string {
    const source = `${attempt.id}:${attempt.env}:${attempt.totalChargedAmount.toString()}`;
    const digest = createHash("sha256").update(source).digest("hex").slice(0, 16).toUpperCase();
    return `MOCK-${digest}`;
  }

  private delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
}

function maskPhone(value: unknown): string {
  const text = String(value ?? "");
  if (!text) {
    return "";
  }
  return `${"*".repeat(Math.max(0, text.length - 4))}${text.slice(-4)}`;
}
