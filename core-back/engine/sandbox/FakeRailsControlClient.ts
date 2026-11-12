import { ApiError } from "../../lib/error";
import {
  assertFakeRailsControlAllowed,
  fakeRailsBaseUrl,
  fakeRailsControlHeaders,
} from "../../lib/plane";

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
  created_at: string;
  updated_at: string;
}

export interface CheckoutHelperSecrets {
  ourReference: string;
  providerReference: string;
  expectedOtp: string | null;
  collectionMode: string;
  boundAccountId: string | null;
  boundAccountIdentifier: string | null;
  boundAccountBalanceAfterHoldLyd: string | null;
  heldAmountLyd: string | null;
  qrPayload: string | null;
  deepLinkUrl: string | null;
  redirectUrl: string | null;
  canSimulateMobilePushOrQrApproval: boolean;
  recentWireEvents: Array<{
    phase: string;
    status: number | null;
    fault: string | null;
    durationMs: number;
    createdAt: string;
  }>;
}

export interface FakeRailsAccountMovement {
  id: string;
  account_id: string;
  transaction_id: string | null;
  direction: string;
  amount_lyd: string;
  available_before_lyd: string;
  available_after_lyd: string;
  reason: string;
  actor: string;
  created_at: string;
}

export type SandboxSimulationAction =
  | "APPROVE_PUSH_OR_QR"
  | "DECLINE_PUSH_OR_QR"
  | "APPROVE_WITH_VARIANCE"
  | "FIRE_WEBHOOK_NOW"
  | "REPLAY_DUPLICATE_WEBHOOK"
  | "FIRE_TAMPERED_WEBHOOK";

const request = async (
  path: string,
  init: RequestInit = {},
  timeoutMs = 5000,
): Promise<Response> => {
  try {
    return await fetch(`${fakeRailsBaseUrl()}${path}`, {
      ...init,
      headers: { ...fakeRailsControlHeaders(), ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new ApiError(
      503,
      "FAKE_RAILS_UNAVAILABLE",
      "The Fake Rails emulator is not reachable from this sandbox plane",
    );
  }
};

/**
 * `pg-core-sandbox` control client. It can never be used on the Live plane:
 * every method asserts the plane first (defense in depth beside the outbound
 * URL fence in `lib/plane.ts`).
 */
export class FakeRailsControlClient {
  async listAccounts(params?: {
    railCode?: string;
    gatewayCode?: string;
    merchantId?: string;
  }): Promise<FakeRailsAccount[]> {
    assertFakeRailsControlAllowed();
    const query = new URLSearchParams();
    if (params?.railCode) query.set("railCode", params.railCode);
    if (params?.gatewayCode) query.set("gatewayCode", params.gatewayCode);
    if (params?.merchantId) query.set("merchantId", params.merchantId);
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    const response = await request(`/portal-api/accounts${suffix}`);
    if (!response.ok) {
      throw new ApiError(response.status, "FAKE_RAILS_ACCOUNTS_UNAVAILABLE", "Failed to list Fake Rails test accounts");
    }
    const payload = (await response.json()) as { accounts?: FakeRailsAccount[] };
    return payload.accounts ?? [];
  }

  async patchAccount(accountId: string, payload: Record<string, unknown>): Promise<FakeRailsAccount> {
    assertFakeRailsControlAllowed();
    const response = await request(`/portal-api/accounts/${encodeURIComponent(accountId)}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new ApiError(response.status, "FAKE_RAILS_ACCOUNT_UPDATE_FAILED", "Failed to update the Fake Rails test account");
    }
    const data = (await response.json()) as { account?: FakeRailsAccount };
    if (!data.account) {
      throw new ApiError(502, "FAKE_RAILS_ACCOUNT_UPDATE_FAILED", "Fake Rails returned no account");
    }
    return data.account;
  }

  async createAccount(payload: Record<string, unknown>): Promise<FakeRailsAccount> {
    assertFakeRailsControlAllowed();
    const response = await request("/portal-api/accounts", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new ApiError(response.status, "FAKE_RAILS_ACCOUNT_CREATE_FAILED", "Failed to create the Fake Rails test account");
    }
    const data = (await response.json()) as { account?: FakeRailsAccount };
    if (!data.account) {
      throw new ApiError(502, "FAKE_RAILS_ACCOUNT_CREATE_FAILED", "Fake Rails returned no account");
    }
    return data.account;
  }

  async listAccountMovements(accountId: string): Promise<FakeRailsAccountMovement[]> {
    assertFakeRailsControlAllowed();
    const response = await request(`/portal-api/accounts/${encodeURIComponent(accountId)}/movements`);
    if (!response.ok) {
      throw new ApiError(response.status, "FAKE_RAILS_MOVEMENTS_UNAVAILABLE", "Failed to read the Fake Rails account movements");
    }
    const payload = (await response.json()) as { movements?: FakeRailsAccountMovement[] };
    return payload.movements ?? [];
  }

  async getCheckoutHelperSecrets(reference: string): Promise<CheckoutHelperSecrets | null> {    assertFakeRailsControlAllowed();
    const response = await request(`/portal-api/checkout-helper/${encodeURIComponent(reference)}`);
    if (!response.ok) return null;
    const data = (await response.json()) as { activeAttemptSecrets?: CheckoutHelperSecrets | null };
    return data.activeAttemptSecrets ?? null;
  }

  async simulateCheckoutAction(reference: string, action: SandboxSimulationAction): Promise<void> {
    assertFakeRailsControlAllowed();
    const response = await request(
      `/portal-api/checkout-helper/${encodeURIComponent(reference)}/simulate-action`,
      { method: "POST", body: JSON.stringify({ action }) },
    );
    if (!response.ok) {
      throw new ApiError(response.status, "FAKE_RAILS_SIMULATE_FAILED", "Failed to simulate the checkout action on Fake Rails");
    }
  }

  async generateStatement(params: {
    gatewayCode: string;
    from?: string;
    to?: string;
    anomalies?: Record<string, unknown>;
  }): Promise<{
    id: string;
    gatewayCode: string;
    from: string;
    to: string;
    lines: Array<Record<string, unknown>>;
  }> {
    assertFakeRailsControlAllowed();
    const response = await request("/portal-api/statements/generate", {
      method: "POST",
      body: JSON.stringify({ ...params, format: "json" }),
    });
    if (!response.ok) {
      throw new ApiError(response.status, "FAKE_RAILS_STATEMENT_FAILED", "Failed to generate the Fake Rails statement");
    }
    return (await response.json()) as {
      id: string;
      gatewayCode: string;
      from: string;
      to: string;
      lines: Array<Record<string, unknown>>;
    };
  }

  async resetAccounts(merchantId?: string | null): Promise<{ removedAccounts: number; resetAccounts: number }> {
    assertFakeRailsControlAllowed();
    const response = await request("/portal-api/accounts/reset", {
      method: "POST",
      body: JSON.stringify({ merchantId: merchantId ?? null }),
    });
    if (!response.ok) {
      throw new ApiError(response.status, "FAKE_RAILS_ACCOUNT_RESET_FAILED", "Failed to reset the Fake Rails test accounts");
    }
    return (await response.json()) as { removedAccounts: number; resetAccounts: number };
  }
}

export const fakeRailsControlClient = new FakeRailsControlClient();
