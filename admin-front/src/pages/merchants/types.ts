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
