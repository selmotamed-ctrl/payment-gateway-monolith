/** Shapes served by `GET /transactions`, `GET /inbound-events` and `GET /attempts/:id`. */

export interface MerchantRef {
    id: string;
    legalName: string;
    tradeName: string;
}

export interface TransactionRow {
    id: string;
    createdAt: string;
    status: string;
    requestedAmount: string | null;
    currency: string;
    merchantId: string;
    merchant: MerchantRef;
    applicationId: string;
    application: { id: string; name: string };
    railId: string;
    rail: { id: string; code: string; nameEn: string };
    gatewayId: string;
    gateway: { id: string; code: string; name: string };
    reference: string;
    gatewayReference: string | null;
    providerReference: string | null;
    networkReference: string | null;
    ledgerEntryId: string | null;
    hasOpenCase: boolean;
    redactedFields: string[];
}

export interface TransactionSummary {
    total24h: number;
    settled24h: number;
    inFlight24h: number;
    failed24h: number;
    escalated24h: number;
}

export interface InboundEventRow {
    id: string;
    receivedAt: string;
    gatewayId: string;
    gateway: { id: string; code: string; name: string };
    channelId: string;
    env: string;
    sourceIp: string;
    verified: boolean;
    verificationError: string | null;
    attemptId: string | null;
    processedAt: string | null;
    processingResult: string | null;
    dedupeKey: string;
}

export interface StepLogRow {
    id: string;
    createdAt: string;
    phase: string;
    stepId: string | null;
    stepOrder: number;
    redactedRequestJson: unknown;
    redactedResponseText: string;
    httpStatus: number | null;
    durationMs: number | null;
    outcome: string;
}

export interface AttemptDetail {
    /** The raw attempt row (ciphertext stripped; money as 4-decimal strings, `null` for SUPPORT). */
    attempt: {
        id: string;
        reference: string;
        createdAt: string;
        updatedAt: string;
        terminalAt: string | null;
        expiresAt: string | null;
        nextCheckAt: string | null;
        status: string;
        substatus: string | null;
        env: string;
        mode: string;
        subMode: string | null;
        currency: string;
        feeBearer: string | null;
        settlementTarget: string | null;
        merchantId: string;
        applicationId: string;
        ledgerEntryId: string | null;
        providerReference: string | null;
        networkReference: string | null;
        gatewayReference: string | null;
        requestedAmount: string | null;
        surchargeAmount: string | null;
        totalChargedAmount: string | null;
        settledAmount: string | null;
        gatewayFeeAmount: string | null;
        platformCommissionAmount: string | null;
        netMerchantAmount: string | null;
        otpAttempts: number | null;
        pointOfNoReturn: boolean | null;
        customerFieldsMasked: unknown;
        link: { id: string; key: string } | null;
    };
    merchant: MerchantRef;
    application: { id: string; name: string; status: string };
    rail: { id: string; code: string; nameEn: string; nameAr: string | null };
    gateway: { id: string; code: string; name: string };
    stepLogs: StepLogRow[];
    inboundEvents: InboundEventRow[];
    attemptGroup: {
        id: string;
        successCount: number;
        attempts: { id: string; status: string; railId: string; gatewayId: string; requestedAmount: string | null; createdAt: string }[];
    } | null;
    operatorCases: { id: string; kind: string; state: string; priority: string; slaDueAt: string | null }[];
    disputes: { id: string; status: string; disputedAmount: string | null; reasonCode: string | null; createdAt: string }[];
    adjustments: { id: string; type: string; state: string; amount: string | null; createdAt: string; journalEntryId: string | null }[];
    redactedFields: string[];
}
