import { api } from "@/state/api";

/** `/api/v1/merchant/sandbox/*` — always the isolated Sandbox database. */
export const sandboxPath = (path: string): string => `/v1/merchant/sandbox${path.startsWith("/") ? path : `/${path}`}`;

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

export interface SandboxWallet {
    id: string;
    name?: string | null;
    currency: string;
    status: string;
    availableBalance: string;
}

export interface SandboxOverview {
    merchantId: string;
    merchantName: string;
    counts: {
        wallets: number;
        applications: number;
        links: number;
        payments: number;
        activeTestTokens: number;
        fakeCustomerAccounts: number;
    };
    wallets: SandboxWallet[];
}

export interface FakeRailsAccount {
    id: string;
    merchant_id?: string | null;
    rail_code: string;
    gateway_code: string;
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
    status: string;
    static_otp: string | null;
}


export interface SandboxWalletDetail {
    wallet: {
        id: string;
        name: string | null;
        merchantId: string;
        currency: string;
        status: string;
        glAccountId: string;
        createdAt: string;
        updatedAt?: string;
        glAccount?: { id: string; accountType: string; currency: string; shardCount: number };
    };
    availableBalance: string;
    checkpointBalance: string;
    checkpointAt: string | null;
    checkpointStatus: string;
    shardCount: number;
    pendingLines: number;
    pendingCashouts: number;
    applications: Array<{ id: string; name: string; status: string; createdAt: string }>;
    links: Array<{ id: string; key: string; title: string | null; amount: string; currency: string; state: string; useCount: number; confirmedCount: number; createdAt: string }>;
    attempts: number;
    disputes: number;
    cashouts: Array<Record<string, unknown>>;
}

export interface SandboxLedgerLine {
    lineId: string;
    entryId: string;
    direction: string;
    amount: string;
    createdAt: string;
    refType: string;
    refId: string;
    description: string;
}

export interface SandboxPaymentDetail {
    attempt: Record<string, unknown> & {
        gatewayFeeAmount?: string | null;
        id: string;
        reference: string;
        status: string;
        substatus?: string | null;
        currency: string;
        totalChargedAmount: string;
        settledAmount: string | null;
        platformCommissionAmount: string;
        netMerchantAmount: string;
        createdAt: string;
        terminalAt?: string | null;
        providerReference?: string | null;
    };
    link?: { id: string; key: string; title?: string | null; wallet?: { id: string; name: string | null; currency: string; status: string }; application?: { id: string; name: string; status: string } } | null;
    application?: { id: string; name: string; status: string } | null;
    rail?: { code: string; nameEn: string; nameAr: string } | null;
    gateway?: { code: string; name: string } | null;
    stepLogs?: Array<Record<string, unknown>>;
    adjustments?: Array<Record<string, unknown>>;
    ledgerLines: SandboxLedgerLine[];
    refunds: Array<Record<string, unknown>>;
    disputes: Array<Record<string, unknown>>;
    refundableAmount: string;
    inspector?: {
        activeAttemptSecrets?: {
            expectedOtp?: string | null;
            boundAccountIdentifier?: string | null;
            heldAmountLyd?: string | null;
            qrPayload?: string | null;
            deepLinkUrl?: string | null;
            redirectUrl?: string | null;
            recentWireEvents?: Array<Record<string, unknown>>;
        } | null;
    } | null;
}

export interface SandboxStudioOverview {
    merchantId: string;
    merchantName: string;
    fakeRails: { ok: boolean; accounts?: number };
    reference: { rails: number; gateways: number; routes: number; commissionProfiles: number; ready: boolean };
    counts: { wallets: number; applications: number; links: number; payments: number; pendingCashouts: number; disputes: number; activeTestTokens: number; fakeCustomerAccounts: number };
    money: Record<string, string>;
    statusCounts: Record<string, number>;
    wallets: Array<{ id: string; name: string | null; currency: string; status: string; availableBalance: string; checkpointBalance: string }>;
    recentPayments: Array<{ id: string; reference: string; status: string; currency: string; amount: string; net: string; railCode: string; linkKey: string; createdAt: string }>;
    syncAudits: Array<{ id: string; syncType: string; createdAt: string; actorRole: string | null; summaryJson: unknown }>;
}

export interface SandboxListEnvelope<T> {
    rows?: T[];
    total?: number;
    page?: number;
    pageSize?: number;
}

export interface SandboxWalletRow extends SandboxWallet {
    merchantId?: string;
    glAccountId: string;
    checkpointBalance: string;
    checkpointAt: string | null;
    checkpointStatus: string;
    pendingLines: number;
    shardCount: number;
    applications: number;
    links: number;
    payments: number;
    pendingCashouts: number;
    createdAt: string;
    updatedAt: string;
}

export interface SandboxApplicationRow {
    id: string;
    name: string;
    status: string;
    assignedWalletId: string;
    walletName: string | null;
    walletCurrency: string;
    businessUseDescription: string | null;
    expectedMonthlyVolume: string;
    railWhitelist: string[] | null;
    redirectDomainAllowlist: string[] | null;
    links: number;
    payments: number;
    createdAt: string;
}

export interface SandboxLinkRow {
    id: string;
    key: string;
    linkKey: string;
    title: string | null;
    description: string | null;
    amount: string;
    currency: string;
    state: string;
    feeBearer: string;
    useCount: number;
    confirmedCount: number;
    activeLockedCount: number;
    infiniteUse: boolean;
    applicationId: string;
    applicationName: string;
    walletId: string;
    walletName: string | null;
    walletCurrency: string;
    expiresAt: string | null;
    redirectUrl: string | null;
    railWhitelist: string[] | null;
    payments: number;
    createdAt: string;
}

export interface SandboxPaymentRow {
    id: string;
    reference: string;
    createdAt: string;
    terminalAt: string | null;
    updatedAt: string;
    status: string;
    substatus: string | null;
    mode: string;
    subMode: string | null;
    env: string;
    railId: string;
    railCode: string;
    railName: string;
    gatewayCode: string;
    gatewayName: string;
    applicationId: string;
    applicationName: string;
    linkId: string;
    linkKey: string;
    linkTitle: string | null;
    walletId: string;
    requestedAmount: string;
    surchargeAmount: string;
    totalChargedAmount: string;
    settledAmount: string | null;
    gatewayFeeAmount: string | null;
    platformCommissionAmount: string;
    netMerchantAmount: string;
    refundedAmount: string;
    providerReference: string | null;
    networkReference: string | null;
    feeBearer: string;
    settlementTarget: string;
    currency: string;
    expiresAt: string | null;
}

export interface SandboxTokenRow {
    id: string;
    name: string;
    lastFour: string;
    applicationId: string;
    applicationName: string;
    scopes: string[];
    expiresAt: string | null;
    revokedAt: string | null;
    lastUsedAt: string | null;
    ipWhitelistEnabled: boolean;
    allowedCidrs: string[];
    createdAt: string;
}

export interface SandboxSummaryResponse {
    summary: Record<string, unknown>;
}
