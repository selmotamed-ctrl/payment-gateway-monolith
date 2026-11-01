export type MerchantStatus = "PENDING" | "ACTIVE" | "SUSPENDED" | "REJECTED" | "CLOSED";
export type KybStatus = "UNVERIFIED" | "PENDING" | "VERIFIED" | "REJECTED";

export type LatestJoinRequest = {
    id: string;
    status: string;
    submittedAt: string | null;
    proposedRiskTier: string;
    createdAt: string;
};

export type MerchantSummary = {
    id: string;
    version: number;
    createdAt: string;
    updatedAt: string;
    legalName: string;
    tradeName: string;
    displayName: string;
    logoUrl: string | null;
    supportEmail: string | null;
    supportPhone: string | null;
    country: string;
    status: MerchantStatus;
    onboardingChannel: string;
    contactEmail: string | null;
    contactPhone: string | null;
    activatedAt: string | null;
    suspendedAt: string | null;
    closedAt: string | null;
    suspensionReasonCode: string | null;
    suspensionReasonRedacted: boolean;
    closedReasonCode: string | null;
    taxId?: string | null;
    registrationNo?: string | null;
    businessCategory?: string | null;
    riskTier?: string | null;
    kybStatus?: KybStatus | null;
    nextKybReviewAt?: string | null;
    suspensionNotes?: string | null;
    closedNotes?: string | null;
    payoutBankDetailsJson?: Record<string, unknown> | null;
    commissionReceivableCeiling?: string | number | null;
    negativeBalanceCeiling?: string | number | null;
    walletCount: number;
    applicationCount: number;
    userCount: number;
    tokenCount: number;
    joinRequestCount: number;
    kybDocumentCount: number;
    latestJoinRequest: LatestJoinRequest | null;
    pendingApprovalCount: number;
    redactedFields: string[];
};

export type MerchantJoinRequest = {
    id: string;
    status: string;
    onboardingChannel: string;
    proposedRiskTier: string;
    submittedAt: string | null;
    slaDueAt: string;
    slaPausedAt: string | null;
    createdAt: string;
    decision: string | null;
    decisionReasonCode: string | null;
    fourEyesRequired: boolean;
};

export type MerchantKybDocument = {
    id: string;
    docType: string;
    status: string;
    avStatus: string;
    originalFileName: string | null;
    expiresOn: string | null;
    reviewedAt: string | null;
    createdAt: string;
};

export type MerchantOwner = {
    id: string;
    fullNameAr: string;
    fullNameEn: string | null;
    nationality: string;
    ownershipPercent: string | null;
    role: string;
    pepDeclared: boolean;
    screeningStatus: string;
    active: boolean;
};

export type MerchantRevalidation = {
    id: string;
    docType: string;
    status: string;
    reasonCode: string;
    message: string;
    dueAt: string | null;
    requestedAt: string;
};

export type MerchantAmlCase = {
    id: string;
    triggerReason: string;
    severity: string;
    status: string;
    slaDueAt: string | null;
    createdAt: string;
    confidential: boolean;
};

export type MerchantWallet = {
    id: string;
    currency: string;
    status: string;
    createdAt: string;
};

export type MerchantWalletBalance = {
    balance: string;
    wallets: Array<{ id: string; walletId: string; currency: string; status: string; balance: string }>;
};

export type MerchantApplication = {
    id: string;
    name: string;
    status: string;
    expectedMonthlyVolume: string;
    assignedWalletId: string;
    createdAt: string;
};

export type MerchantUser = {
    id: string;
    email: string;
    phone: string | null;
    role: string;
    status: string;
    isMaker: boolean;
    isChecker: boolean;
    mfaRequired: boolean;
    createdAt: string;
};

export type MerchantToken = {
    id: string;
    applicationId: string;
    name: string;
    lastFour: string;
    scopes: unknown;
    ipWhitelistEnabled: boolean;
    revokedAt: string | null;
    lastUsedAt: string | null;
    createdAt: string;
};

export type MerchantCredentialSet = {
    id: string;
    gatewayId: string;
    env: string;
    ownerType: string;
    settlementTarget: string;
    status: string;
    lastVerifiedAt: string | null;
    expiresAt: string | null;
};

export type MerchantPendingChange = {
    id: string;
    state: string;
    mode: string;
    baseVersion: number | null;
    makerUserId: string;
    makerReason: string | null;
    payloadDiffJson: Record<string, unknown> | unknown[] | null;
    createdAt: string;
    expiresAt: string | null;
    maker?: { email: string } | null;
};

export type MerchantDetailChange = {
    id: string;
    createdAt: string;
    actorId: string;
    actorEmail?: string | null;
    entityType: string;
    entityId: string;
    fieldName: string;
    oldValue: string | null;
    newValue: string | null;
    source: string;
    requestId: string;
    approvalRequestId: string | null;
    redacted?: boolean;
};

export type MerchantMetrics = {
    status: string;
    count: number;
    chargedAmount: string;
};

export type MerchantDetail = MerchantSummary & {
    joinRequests?: MerchantJoinRequest[];
    kybDocuments?: MerchantKybDocument[];
    beneficialOwners?: MerchantOwner[];
    revalidations?: MerchantRevalidation[];
    amlCases?: MerchantAmlCase[];
    pendingChanges?: MerchantPendingChange[];
    fieldHistory: MerchantDetailChange[];
    wallets?: MerchantWallet[];
    applications?: MerchantApplication[];
    users?: MerchantUser[];
    accessTokens?: MerchantToken[];
    credentialSets?: MerchantCredentialSet[];
    walletBalance?: MerchantWalletBalance;
    metrics?: MerchantMetrics[];
    openDisputes?: number;
    pendingCashouts?: number;
};

export type MerchantOperatorCaseRef = {
    id: string;
    kind: string;
    state: string;
    priority: string;
    slaDueAt: string;
};

export type MerchantTransaction = {
    id: string;
    reference: string;
    createdAt: string;
    updatedAt: string;
    terminalAt: string | null;
    status: string;
    substatus: string | null;
    env: string;
    mode: string;
    subMode: string | null;
    currency: string;
    application: { id: string; name: string };
    rail: { id: string; code: string; nameEn: string };
    gateway: { id: string; code: string; name: string };
    link: { id: string; key: string } | null;
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
    operatorCases: MerchantOperatorCaseRef[];
    inquiryEligible: boolean;
    inquiryEligibilityReason: string;
    redactedFields: string[];
};

export type MerchantApplicationRow = {
    id: string;
    name: string;
    status: string;
    expectedMonthlyVolume: string | null;
    assignedWallet: { id: string; currency: string; status: string };
    accessTokenCount: number;
    paymentLinkCount: number;
    posTerminalCount: number;
    railWhitelistMode: string;
    railWhitelistCount: number;
    redirectDomainCount: number;
    redirectDomains: string[];
    createdAt: string;
    redactedFields: string[];
};

export type MerchantWalletRow = {
    id: string;
    currency: string;
    status: string;
    glAccountId: string;
    balance: string | null;
    checkpointBalance: string | null;
    applicationCount: number;
    paymentLinkCount: number;
    cashoutCount: number;
    pendingCashoutCount: number;
    createdAt: string;
    redactedFields: string[];
};

export type MerchantCashout = {
    id: string;
    amount: string;
    currency: string;
    state: string;
    wallet: { id: string; currency: string; status: string };
    destination: Record<string, unknown>;
    adjustmentId: string | null;
    adjustment: { id: string; state: string; journalEntryId: string | null } | null;
    createdAt: string;
};

export type MerchantDispute = {
    id: string;
    externalDisputeRef: string;
    source: string;
    reasonCode: string | null;
    amount: string;
    currency: string;
    status: string;
    openedAt: string;
    evidenceDueAt: string | null;
    outcomeAt: string | null;
    adjustmentId: string | null;
    attempt: { id: string; reference: string; status: string };
    gateway: { id: string; code: string; name: string };
    rail: { id: string; code: string; nameEn: string };
    adjustment: { id: string; state: string; journalEntryId: string | null } | null;
};

export type MerchantAdjustment = {
    id: string;
    type: string;
    amount: string;
    currency: string;
    reverseCommission: boolean;
    reason: string;
    externalDisputeRef: string | null;
    providerRefundRef: string | null;
    state: string;
    journalEntryId: string | null;
    createdAt: string;
    targetGlAccount: { id: string; accountType: string; currency: string; ownerId: string | null };
    sourceAttempt: { id: string; reference: string; status: string; currency: string } | null;
    dispute: { id: string; externalDisputeRef: string; status: string } | null;
};

export type MerchantNotification = {
    id: string;
    templateCode: string;
    channel: string;
    lang: string;
    status: string;
    attempts: number;
    addressMasked: string;
    nextAttemptAt: string | null;
    createdAt: string;
};

export type MerchantAuditEvent = {
    id: string;
    action: string;
    role: string;
    entityType: string;
    entityId: string;
    actorEmail: string;
    approvalRequestId: string | null;
    before: unknown;
    after: unknown;
    createdAt: string;
    redacted: boolean;
};

export type MerchantStats = {
    period: string;
    since: string;
    totals: {
        attemptCount: number;
        successfulCount: number;
        successRate: number;
        grossVolume: string;
        netCredited: string;
        commission: string;
        averageTicket: string;
        failedCount: number;
        expiredCount: number;
        blockedCount: number;
        unknownCount: number;
    };
    statuses: Array<{ status: string; count: number; chargedAmount: string }>;
    walletBalance: { balance: string; wallets: Array<{ id: string; walletId: string; currency: string; status: string; balance: string }> };
    negativeBalanceCeiling: string;
    pendingCashouts: { count: number; amount: string };
    openDisputes: number;
    pendingApprovals: number;
    nextKybReviewAt: string | null;
};
