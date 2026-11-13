import { api } from "@/state/api";

export const sandboxPath = (path: string): string => `/v1/admin/sandbox${path.startsWith("/") ? path : `/${path}`}`;

export const sandboxGet = async <T>(path: string, params?: Record<string, unknown>): Promise<T> => {
    const response = await api.get(sandboxPath(path), { params });
    return (response.data?.data ?? response.data) as T;
};

export const sandboxPost = async <T>(path: string, body?: unknown): Promise<T> => {
    const response = await api.post(sandboxPath(path), body ?? {});
    return (response.data?.data ?? response.data) as T;
};

export const sandboxPatch = async <T>(path: string, body?: unknown): Promise<T> => {
    const response = await api.patch(sandboxPath(path), body ?? {});
    return (response.data?.data ?? response.data) as T;
};

export const sandboxPut = async <T>(path: string, body?: unknown): Promise<T> => {
    const response = await api.put(sandboxPath(path), body ?? {});
    return (response.data?.data ?? response.data) as T;
};

export interface AdminSandboxOverview {
    plane: string;
    planeState: { plane: string; allowFakeRails: boolean; liveSyncRevision: number } | null;
    sandbox: { merchants: number; wallets: number; applications: number; links: number; attempts: number; tokens?: number };
    reference?: { rails: number; gateways: number; routes: number; commissionProfiles: number; ready: boolean };
    fakeRails: { ok: boolean; message?: string };
    liveSyncRevision?: number;
    lastSyncedFromLive?: string | null;
    syncAudits?: Array<{ id: string; syncType: string; createdAt: string; actorRole: string | null; summaryJson: unknown }>;
}

export interface MerchantSandboxOverview {
    syncAudits?: Array<{ id: string; syncType: string; createdAt: string; actorRole: string | null; summaryJson: unknown }>;
    merchantId: string;
    counts: { wallets: number; applications: number; links: number; attempts: number; cashouts?: number; disputes?: number };
    wallets: { id: string; name?: string | null; currency: string; status: string; availableBalance: string }[];
}

export interface FakeRailsAccountRow {
    id: string;
    rail_code: string;
    gateway_code: string;
    merchant_id: string | null;
    identifier: string;
    holder_name: string;
    instrument_type: string;
    secret_pin: string;
    expiry: string | null;
    currency: string;
    available_balance_lyd: string;
    reserved_balance_lyd: string;
    daily_limit_lyd: string;
    daily_spent_lyd: string;
    daily_spent_date?: string | null;
    static_otp: string | null;
    preset_fault: string | null;
    notes: string | null;
    status: string;
    created_at?: string;
    updated_at?: string;
}


export interface FakeRailsScenario {
    railCode: string;
    gatewayCode: string;
    enabled: boolean;
    overallFailureChancePercent: number;
    latencyMs: { min: number; max: number };
    autoApproveAsyncAfterSec: number | null;
    phaseBreakdown: Record<string, number>;
    failureModeWeights: Record<string, number>;
    webhookBehavior: {
        delaySeconds: number;
        duplicateCount: number;
        outOfOrderPendingAfterPaid: boolean;
        corruptSignatureChancePercent: number;
    };
}

export interface FakeRailsTransactionRow {
    id: string;
    rail_code: string;
    gateway_code: string;
    our_reference: string;
    provider_reference: string;
    normalized_amount_lyd: string;
    currency: string;
    status: string;
    collection_mode: string;
    expected_otp: string | null;
    created_at: string;
}

export interface FakeRailsAccountPage {
    accounts: FakeRailsAccountRow[];
    total: number;
    page: number;
    pageSize: number;
}

export const sandboxFakeRails = {
    accounts: (params: Record<string, unknown>) => sandboxGet<FakeRailsAccountPage>("/fake-rails/accounts", params),
    accountsSummary: () => sandboxGet<{ summary: Record<string, unknown> }>("/fake-rails/accounts/summary"),
    adjustAccount: (id: string, body: Record<string, unknown>) => sandboxPatch(`/fake-rails/accounts/${encodeURIComponent(id)}`, body),
    createAccount: (body: Record<string, unknown>) => sandboxPost("/fake-rails/accounts", body),
    restoreAccount: (id: string) => sandboxPost(`/fake-rails/accounts/${encodeURIComponent(id)}/restore`),
    movements: (id: string) => sandboxGet<{ movements: Array<Record<string, unknown>>; holds: Array<Record<string, unknown>> }>(`/fake-rails/accounts/${encodeURIComponent(id)}/movements`),
    resetAccounts: () => sandboxPost("/fake-rails/accounts/reset", {}),
    scenarios: () => sandboxGet<{ rails: unknown[]; scenarios: FakeRailsScenario[] }>("/fake-rails/scenarios"),
    updateScenario: (railCode: string, body: Record<string, unknown>) => sandboxPut(`/fake-rails/scenarios/${encodeURIComponent(railCode)}`, body),
    preset: (railCode: string, preset: string) => sandboxPost(`/fake-rails/scenarios/preset/${encodeURIComponent(railCode)}/${encodeURIComponent(preset)}`, {}),
    globalPreset: (preset: string) => sandboxPost(`/fake-rails/scenarios/global/${encodeURIComponent(preset)}`, {}),
    resetScenarios: () => sandboxPost("/fake-rails/scenarios/reset", {}),
    transactions: (params: Record<string, unknown>) => sandboxGet<{ total: number; rows: FakeRailsTransactionRow[] }>("/fake-rails/transactions", params),
    transaction: (id: string) => sandboxGet<Record<string, unknown>>(`/fake-rails/transactions/${encodeURIComponent(id)}`),
    transactionAction: (id: string, body: Record<string, unknown>) => sandboxPost(`/fake-rails/transactions/${encodeURIComponent(id)}/action`, body),
    webhooks: (transactionId?: string) => sandboxGet<{ deliveries: Array<Record<string, unknown>> }>("/fake-rails/webhooks", transactionId ? { transactionId } : undefined),
    fireWebhook: (transactionId: string, body: Record<string, unknown>) => sandboxPost(`/fake-rails/webhooks/${encodeURIComponent(transactionId)}/fire`, body),
    replayWebhook: (deliveryId: string, tamper = false) => sandboxPost(`/fake-rails/webhooks/deliveries/${encodeURIComponent(deliveryId)}/replay?tamper=${tamper ? "true" : "false"}`, {}),
    statements: () => sandboxGet<{ statements: Array<Record<string, unknown>> }>("/fake-rails/statements"),
    generateStatement: (body: Record<string, unknown>) => sandboxPost("/fake-rails/statements/generate", body),
    clearingPools: () => sandboxGet<{ pools: Array<Record<string, unknown>> }>("/fake-rails/clearing/pools"),
    generateClearing: (body: Record<string, unknown>) => sandboxPost<Record<string, unknown>>("/fake-rails/clearing/generate-statement", body),
    settleClearing: (body: Record<string, unknown>) => sandboxPost("/fake-rails/clearing/settle", body),
    globalReset: (confirm = "RESET SANDBOX") => sandboxPost("/global-reset", { confirm }),
    merchantOverview: (merchantId: string) => sandboxGet<MerchantSandboxOverview>(`/merchants/${encodeURIComponent(merchantId)}/overview`),
    resetMerchant: (merchantId: string) => sandboxPost("/reset", { merchantId, confirm: "RESET" }),
    seedMerchant: (merchantId: string) => sandboxPost("/seed-demo", { merchantId }),
};

export interface AdminSandboxMerchantRow {
    id: string;
    tradeName: string;
    legalName: string;
    displayName?: string | null;
    status: string;
    onboardingChannel: string;
    country: string;
    createdAt: string;
    wallets: number;
    applications: number;
    payments: number;
    cashouts: number;
    availableBalance: string;
}

export interface AdminSandboxMerchantDetail {
    merchant: Record<string, unknown> & { id: string; tradeName: string; legalName: string; status: string; contactEmail?: string | null; createdAt: string };
    wallets: Array<{ id: string; name: string | null; currency: string; status: string; availableBalance: string; checkpointBalance: string; createdAt: string }>;
    applications: Array<{ id: string; name: string; status: string; assignedWalletId: string; expectedMonthlyVolume: string; createdAt: string }>;
    links: Array<{ id: string; key: string; title: string | null; amount: string; currency: string; state: string; useCount: number; confirmedCount: number; createdAt: string }>;
    payments: Array<{ id: string; reference: string; status: string; totalChargedAmount: string; netMerchantAmount: string; currency: string; createdAt: string }>;
    cashouts: Array<Record<string, unknown>>;
    disputes: Array<Record<string, unknown>>;
    accounts: FakeRailsAccountRow[];
    audits: Array<{ id: string; syncType: string; actorRole: string | null; createdAt: string; summaryJson: unknown }>;
}

export interface AdminSandboxAuditRow {
    id: string;
    syncType: string;
    merchantId: string | null;
    actorId: string | null;
    actorRole: string | null;
    summaryJson: unknown;
    createdAt: string;
}

export const adminSandbox = {
    summary: () => sandboxGet<AdminSandboxOverview>("/overview"),
    merchantsSummary: () => sandboxGet<{ summary: Record<string, unknown> }>("/merchants/summary"),
    merchants: (params: Record<string, unknown>) => sandboxGet<{ merchants: AdminSandboxMerchantRow[]; total: number }>("/merchants", params),
    merchant: (merchantId: string) => sandboxGet<AdminSandboxMerchantDetail>(`/merchants/${encodeURIComponent(merchantId)}`),
    seedMerchant: (merchantId: string) => sandboxPost(`/merchants/${encodeURIComponent(merchantId)}/seed`, {}),
    seedHistory: (merchantId: string, count = 20) => sandboxPost(`/merchants/${encodeURIComponent(merchantId)}/seed-history`, { count }),
    resetMerchant: (merchantId: string) => sandboxPost("/reset", { merchantId }),
    audits: (params: Record<string, unknown>) => sandboxGet<{ audits: AdminSandboxAuditRow[]; total: number }>("/audits", params),
    fakeAccountsSummary: () => sandboxGet<{ summary: Record<string, unknown> }>("/fake-rails/accounts/summary"),
};
