import { env } from "../../lib/env";
import { ApiError } from "../../lib/error";

/**
 * Client of the Fake Rails v2 control plane.
 *
 * The sandbox core plane is the only caller. It talks to the emulator over
 * plain HTTP on the private network (or loopback in development) and presents
 * the shared `x-fake-rails-control-token` when one is configured. The client
 * never touches the live rails and never exposes the token to a browser.
 */

export interface FakeRailsAccount {
  id: string;
  rail_code: string;
  gateway_code: string;
  merchant_id: string | null;
  instrument_type: string;
  identifier: string;
  holder_name: string;
  secret_pin: string;
  expiry: string | null;
  currency: string;
  available_balance_lyd: string;
  reserved_balance_lyd: string;
  daily_limit_lyd: string;
  daily_spent_lyd: string;
  status: string;
  static_otp: string | null;
  preset_fault: string | null;
  notes: string | null;
  daily_spent_date?: string | null;
  created_at: string;
  updated_at: string;
}

export interface FakeRailsAccountPage {
  accounts: FakeRailsAccount[];
  total: number;
  page: number;
  pageSize: number;
}

export interface FakeRailsScenario {
  railCode: string;
  gatewayCode: string;
  enabled: boolean;
  overallFailureChancePercent: number;
  phaseBreakdown: Record<string, number>;
  failureModeWeights: Record<string, number>;
  latencyMs: { min: number; max: number };
  autoApproveAsyncAfterSec: number | null;
  webhookBehavior: {
    delaySeconds: number;
    duplicateCount: number;
    outOfOrderPendingAfterPaid: boolean;
    corruptSignatureChancePercent: number;
  };
}

export interface FakeRailsTransaction {
  id: string;
  gateway_code: string;
  rail_code: string;
  our_reference: string;
  provider_reference: string;
  normalized_amount_lyd: string;
  currency: string;
  collection_mode: string;
  expected_otp: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
}

export interface FakeRailsCheckoutHelper {
  activeAttemptSecrets: {
    ourReference: string;
    providerReference: string;
    expectedOtp: string | null;
    collectionMode: string;
    boundAccountIdentifier: string | null;
    boundAccountBalanceAfterHoldLyd: string | null;
    heldAmountLyd: string | null;
    canSimulateMobilePushOrQrApproval: boolean;
    recentWireEvents: Array<{
      phase: string;
      status: number;
      fault: string | null;
      durationMs: number;
      createdAt: string;
    }>;
  } | null;
}

const controlBaseUrl = (): string => {
  const configured = String(env.FAKE_RAILS_CONTROL_URL ?? "").trim();
  if (configured) return configured.replace(/\/$/, "");
  const publicUrl = String(env.FAKE_RAILS_PUBLIC_BASE_URL ?? "").trim();
  if (publicUrl) return publicUrl.replace(/\/$/, "");
  return "http://127.0.0.1:4104";
};

const request = async <T>(
  path: string,
  options: { method?: "GET" | "POST" | "PUT" | "PATCH"; body?: unknown } = {},
): Promise<T> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${controlBaseUrl()}/control${path}`, {
      method: options.method ?? "GET",
      headers: {
        accept: "application/json",
        ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(env.FAKE_RAILS_CONTROL_TOKEN
          ? { "x-fake-rails-control-token": env.FAKE_RAILS_CONTROL_TOKEN }
          : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
    const text = await response.text();
    const payload = text.trim().length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!response.ok) {
      const code = typeof payload.code === "string"
        ? payload.code
        : typeof payload.error === "string"
          ? payload.error
          : "FAKE_RAILS_CONTROL_ERROR";
      const message = typeof payload.message === "string" ? payload.message : `Fake Rails answered ${response.status}`;
      throw new ApiError(
        response.status === 404 ? 404 : response.status >= 500 ? 502 : response.status,
        code,
        message,
      );
    }
    return payload as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      502,
      "FAKE_RAILS_UNAVAILABLE",
      `The Fake Rails emulator is unreachable: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timer);
  }
};

export class FakeRailsControlClient {
  async listAccounts(filters: {
    merchantId?: string;
    railCode?: string;
    gatewayCode?: string;
  } = {}): Promise<FakeRailsAccount[]> {
    const query = new URLSearchParams();
    if (filters.merchantId) query.set("merchantId", filters.merchantId);
    if (filters.railCode) query.set("railCode", filters.railCode);
    if (filters.gatewayCode) query.set("gatewayCode", filters.gatewayCode);
    const suffix = query.toString() ? `?${query.toString()}` : "";
    const payload = await request<{ accounts: FakeRailsAccount[] }>(`/accounts${suffix}`);
    return payload.accounts ?? [];
  }

  async listAccountsPage(filters: {
    merchantId?: string;
    railCode?: string;
    gatewayCode?: string;
    status?: string;
    instrumentType?: string;
    scope?: string;
    createdFrom?: string;
    createdTo?: string;
    search?: string;
    includeGlobal?: boolean;
    page?: number;
    pageSize?: number;
  } = {}): Promise<FakeRailsAccountPage> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
    }
    const suffix = query.toString() ? `?${query.toString()}` : "";
    return request<FakeRailsAccountPage>(`/accounts${suffix}`);
  }

  async getAccount(accountId: string): Promise<FakeRailsAccount | null> {
    const payload = await request<{ account: FakeRailsAccount }>(`/accounts/${encodeURIComponent(accountId)}`);
    return payload.account ?? null;
  }

  async accountMovements(accountId: string, limit = 100): Promise<unknown[]> {
    const payload = await request<{ movements: unknown[] }>(
      `/accounts/${encodeURIComponent(accountId)}/movements?limit=${encodeURIComponent(String(limit))}`,
    );
    return payload.movements ?? [];
  }

  async accountHolds(accountId: string, limit = 100): Promise<unknown[]> {
    const payload = await request<{ holds: unknown[] }>(
      `/accounts/${encodeURIComponent(accountId)}/holds?limit=${encodeURIComponent(String(limit))}`,
    );
    return payload.holds ?? [];
  }

  async restorePreset(accountId: string): Promise<FakeRailsAccount> {
    const payload = await request<{ account: FakeRailsAccount }>(
      `/accounts/${encodeURIComponent(accountId)}/restore`,
      { method: "POST", body: {} },
    );
    return payload.account;
  }

  private async assertMerchantAccount(accountId: string, merchantId?: string): Promise<FakeRailsAccount> {
    const account = await this.getAccount(accountId);
    if (!account) {
      throw new ApiError(404, "FAKE_ACCOUNT_NOT_FOUND", `Fake account ${accountId} not found`);
    }
    if (merchantId) {
      if (!account.merchant_id) {
        throw new ApiError(
          403,
          "FAKE_ACCOUNT_GLOBAL_READONLY",
          "The shared Fake Rails preset is read-only; duplicate it into the merchant sandbox before editing",
        );
      }
      if (account.merchant_id !== merchantId) {
        throw new ApiError(403, "FAKE_ACCOUNT_FORBIDDEN", "The test account belongs to another merchant");
      }
    }
    return account;
  }

  async createAccount(input: Record<string, unknown>): Promise<FakeRailsAccount> {
    const payload = await request<{ account: FakeRailsAccount }>("/accounts", {
      method: "POST",
      body: input,
    });
    return payload.account;
  }

  async adjustAccount(
    accountId: string,
    patch: Record<string, unknown>,
    merchantId?: string,
  ): Promise<FakeRailsAccount> {
    await this.assertMerchantAccount(accountId, merchantId);
    const payload = await request<{ account: FakeRailsAccount }>(`/accounts/${encodeURIComponent(accountId)}`, {
      method: "PATCH",
      body: patch,
    });
    return payload.account;
  }

  async resetAccounts(input: { merchantId?: string } = {}): Promise<{ ok: boolean; removed: number }> {
    return request<{ ok: boolean; removed: number }>("/accounts/reset", {
      method: "POST",
      body: { merchantId: input.merchantId ?? null },
    });
  }

  async checkoutHelper(reference: string): Promise<FakeRailsCheckoutHelper> {
    return request<FakeRailsCheckoutHelper>(`/checkout-helper/${encodeURIComponent(reference)}`);
  }

  async simulateAction(reference: string, action: string): Promise<{ ok: boolean; transactionId: string }> {
    return request<{ ok: boolean; transactionId: string }>(
      `/checkout-helper/${encodeURIComponent(reference)}/simulate-action`,
      { method: "POST", body: { action } },
    );
  }

  async clearingPools(): Promise<{ pools: unknown[] }> {
    return request<{ pools: unknown[] }>("/clearing/pools");
  }

  async generateStatement(input: {
    from?: string;
    to?: string;
    gatewayCode?: string;
    merchantId?: string;
    includeSettled?: boolean;
    includeIncluded?: boolean;
  } = {}): Promise<unknown> {
    return request("/clearing/generate-statement", { method: "POST", body: input });
  }

  async settleClearing(input: { gatewayCode?: string } = {}): Promise<unknown> {
    return request("/clearing/settle", { method: "POST", body: input });
  }

  async markClearingIncluded(input: { entryIds: string[]; runId: string }): Promise<unknown> {
    return request("/clearing/mark-included", { method: "POST", body: input });
  }

  async listScenarios(): Promise<{ rails: unknown[]; scenarios: FakeRailsScenario[] }> {
    return request<{ rails: unknown[]; scenarios: FakeRailsScenario[] }>("/scenarios");
  }

  async updateScenario(railCode: string, patch: Record<string, unknown>): Promise<FakeRailsScenario> {
    const payload = await request<{ scenario: FakeRailsScenario }>(
      `/scenarios/${encodeURIComponent(railCode)}`,
      { method: "PUT", body: patch },
    );
    return payload.scenario;
  }

  async applyScenarioPreset(railCode: string, preset: string): Promise<FakeRailsScenario> {
    const payload = await request<{ scenario: FakeRailsScenario }>(
      `/scenarios/preset/${encodeURIComponent(railCode)}/${encodeURIComponent(preset)}`,
      { method: "POST", body: {} },
    );
    return payload.scenario;
  }

  async applyGlobalScenarioPreset(preset: string): Promise<FakeRailsScenario[]> {
    const payload = await request<{ scenarios: FakeRailsScenario[] }>(
      `/scenarios/global/${encodeURIComponent(preset)}`,
      { method: "POST", body: {} },
    );
    return payload.scenarios ?? [];
  }

  async resetScenarios(): Promise<FakeRailsScenario[]> {
    const payload = await request<{ scenarios: FakeRailsScenario[] }>("/scenarios/reset", {
      method: "POST",
      body: {},
    });
    return payload.scenarios ?? [];
  }

  async listTransactions(query: {
    railCode?: string;
    gatewayCode?: string;
    status?: string;
    reference?: string;
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<{ total: number; rows: FakeRailsTransaction[] }> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
    }
    const suffix = params.toString() ? `?${params.toString()}` : "";
    return request<{ total: number; rows: FakeRailsTransaction[] }>(`/transactions${suffix}`);
  }

  async transactionSummary(): Promise<Record<string, unknown>> {
    return request<Record<string, unknown>>("/transactions/summary");
  }

  async transaction(transactionId: string): Promise<Record<string, unknown>> {
    return request<Record<string, unknown>>(`/transactions/${encodeURIComponent(transactionId)}`);
  }

  async transactionAction(
    transactionId: string,
    body: { action: string; phase?: string; failureMode?: string },
  ): Promise<Record<string, unknown>> {
    return request<Record<string, unknown>>(`/transactions/${encodeURIComponent(transactionId)}/action`, {
      method: "POST",
      body,
    });
  }

  async webhookDeliveries(transactionId?: string): Promise<unknown[]> {
    const suffix = transactionId ? `?transactionId=${encodeURIComponent(transactionId)}` : "";
    const payload = await request<{ deliveries: unknown[] }>(`/webhooks${suffix}`);
    return payload.deliveries ?? [];
  }

  async fireWebhook(transactionId: string, body: Record<string, unknown>): Promise<unknown> {
    return request(`/webhooks/${encodeURIComponent(transactionId)}/fire`, { method: "POST", body });
  }

  async replayWebhook(deliveryId: string, tamper = false): Promise<unknown> {
    return request(`/webhooks/${encodeURIComponent(deliveryId)}/replay?tamper=${tamper ? "true" : "false"}`, {
      method: "POST",
      body: {},
    });
  }

  async sendWebhookNow(deliveryId: string): Promise<unknown> {
    return request(`/webhooks/${encodeURIComponent(deliveryId)}/send-now`, { method: "POST", body: {} });
  }

  async disputeWebhook(transactionId: string): Promise<unknown> {
    return request(`/webhooks/${encodeURIComponent(transactionId)}/dispute`, { method: "POST", body: {} });
  }

  async listStatements(): Promise<unknown[]> {
    const payload = await request<{ statements: unknown[] }>("/statements");
    return payload.statements ?? [];
  }

  /** Generates the tester statement in JSON form (the download formats stay in the legacy portal). */
  async generateTesterStatement(input: {
    gatewayCode: string;
    from?: string;
    to?: string;
    anomalies?: Record<string, unknown>;
  }): Promise<unknown> {
    return request("/statements/generate", {
      method: "POST",
      body: { ...input, format: "json", anomalies: input.anomalies ?? {} },
    });
  }
}
