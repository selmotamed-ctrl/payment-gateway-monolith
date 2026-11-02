export type InquiryEligibility = {
    eligible: boolean;
    reason: string;
};

export type OperatorCaseLinkSlot = {
    id: string;
    key?: string | null;
    state?: string | null;
    useCount?: number | null;
    confirmedCount?: number | null;
    activeLockedCount?: number | null;
    infiniteUse?: boolean | null;
};

export type OperatorCaseApproval = {
    id: string;
    state: string;
    subjectType?: string;
    createdAt?: string;
    payloadDiffJson?: unknown;
    rejectionReason?: string | null;
    expiresAt?: string | null;
    makerUserId?: string;
    checkerUserId?: string | null;
    maker?: { id: string; email: string; role: string } | null;
    checker?: { id: string; email: string; role: string } | null;
};

export type GatewayInquiryScheduleStatus =
    | "SCHEDULED"
    | "RUNNING"
    | "RETRYING"
    | "COMPLETED"
    | "FAILED"
    | "CANCELLED"
    | "EXPIRED";

export type GatewayInquirySchedule = {
    id: string;
    status: GatewayInquiryScheduleStatus;
    source: string;
    operatorCaseId: string | null;
    caseRef: string | null;
    caseState: string | null;
    casePriority: string | null;
    caseType: string | null;
    attemptId: string;
    attemptReference: string | null;
    attemptStatus: string | null;
    attemptSubstatus: string | null;
    attemptTerminal: boolean;
    merchantId: string | null;
    merchantName: string;
    railCode: string | null;
    railName: string | null;
    gatewayId: string | null;
    gatewayCode: string | null;
    gatewayName: string | null;
    gatewaySupportsStatusCheck: boolean;
    amount: string | null;
    currency: string | null;
    providerReference: string | null;
    scheduledByEmail: string | null;
    scheduledAt: string;
    previousNextCheckAt: string | null;
    windowStartedAt: string | null;
    nextRunAt: string;
    lastRunAt: string | null;
    attempts: number;
    lastResult: string | null;
    lastError: string | null;
    completedAt: string | null;
    cancelledAt: string | null;
    cancelledByEmail: string | null;
    cancelReason: string | null;
    isOverdue: boolean;
    canCancel: boolean;
    canRunNow: boolean;
    canRetry: boolean;
};

export type GatewayInquiryScheduleSummary = {
    total: number;
    scheduled: number;
    running: number;
    retrying: number;
    completed: number;
    failed: number;
    cancelled: number;
    expired: number;
    overdue: number;
    byStatus: Record<string, number>;
};

export type OperatorCaseSummary = {
    id: string;
    caseId: string;
    caseRef: string;
    caseReferenceSource: string;
    caseType: string;
    kind: string;
    priority: string;
    state: string;
    attemptId: string | null;
    attemptReference: string | null;
    attemptStatus: string | null;
    attemptSubstatus: string | null;
    merchantId: string | null;
    merchantTradeName: string;
    merchantLegalName: string;
    merchantName: string;
    merchantStatus: string | null;
    merchantRiskTier: string | null;
    railId: string | null;
    railCode: string;
    railNameEn: string;
    gatewayId: string | null;
    gatewayCode: string;
    gatewayName: string;
    routeId: string | null;
    requestedAmount: string | null;
    chargedAmount: string | null;
    settledAmount: string | null;
    statementAmount: string | null;
    statementFee: string | null;
    currency: string | null;
    providerReference: string | null;
    gatewayReference: string | null;
    linkSlot: OperatorCaseLinkSlot | null;
    reconciliationItemId: string | null;
    reconciliationResult: string | null;
    approvalRequestId: string | null;
    approvalState: string | null;
    assigneeUserId: string | null;
    assigneeEmail: string | null;
    openedAt: string;
    createdAt: string;
    slaDueAt: string;
    gatewaySupportsStatusCheck: boolean;
    inquiryEligibility: InquiryEligibility;
    resolutionNotes?: string | null;
    latestInquirySchedule?: (Partial<GatewayInquirySchedule> & { createdAt?: string }) | null;
};

export type OperatorCaseAttempt = {
    id: string;
    reference: string;
    createdAt: string;
    updatedAt: string;
    linkId: string;
    attemptGroupId: string;
    applicationId: string;
    merchantId: string;
    railId: string;
    routeId: string;
    credentialSetId: string;
    gatewayVersionId: string;
    commissionProfileId: string;
    env: string;
    mode: string;
    subMode: string | null;
    status: string;
    substatus: string | null;
    gatewayReference: string | null;
    providerReference: string | null;
    networkReference: string | null;
    requestedAmount: string;
    surchargeAmount: string;
    totalChargedAmount: string;
    settledAmount: string | null;
    gatewayFeeAmount: string | null;
    platformCommissionAmount: string;
    netMerchantAmount: string;
    feeBearer: string;
    settlementTarget: string;
    currency: string;
    pointOfNoReturn: boolean;
    expiresAt: string;
    graceExpiresAt: string;
    nextCheckAt: string | null;
    ledgerEntryId: string | null;
    terminalAt: string | null;
    merchant?: {
        id: string;
        tradeName: string;
        legalName: string;
        status: string;
        kybStatus: string;
        riskTier: string;
        contactEmail: string | null;
        contactPhone: string | null;
        country: string;
    } | null;
    application?: {
        id: string;
        name: string;
        status: string;
        assignedWalletId: string;
        expectedMonthlyVolume: string;
    } | null;
    rail?: {
        id: string;
        code: string;
        nameEn: string;
        nameAr: string;
        collectionMode: string;
        currency: string;
    } | null;
    route?: {
        id: string;
        status: string;
        healthState: string;
        gateway?: { id: string; code: string; name: string; kind: string; status: string } | null;
    } | null;
    gatewayVersion?: {
        id: string;
        versionNumber: number;
        state: string;
        gatewayId: string;
        setting?: {
            id: string;
            supportsStatusCheck: boolean;
            timeoutMs: number;
            statusCheckMinAgeSeconds: number | null;
        } | null;
    } | null;
    link?: {
        id: string;
        key: string;
        applicationId: string;
        walletId: string;
        amount: string;
        currency: string;
        feeBearer: string;
        infiniteUse: boolean;
        useCount: number;
        confirmedCount: number;
        activeLockedCount: number;
        state: string;
        expiresAt: string | null;
        createdAt: string;
    } | null;
    stepLogs?: Array<{
        id: string;
        createdAt: string;
        gatewayVersionId: string;
        phase: string;
        stepId: string | null;
        stepOrder: number;
        redactedRequestJson: unknown;
        redactedResponseText: string;
        httpStatus: number | null;
        durationMs: number | null;
        outcome: string;
    }>;
    inboundEvents?: Array<{
        id: string;
        channelId: string;
        gatewayId: string;
        env: string;
        redactedHeadersJson: unknown;
        sourceIp: string;
        verified: boolean;
        verificationError: string | null;
        dedupeKey: string;
        attemptId: string | null;
        receivedAt: string;
        processedAt: string | null;
        processingResult: string | null;
        rawBodyPreview: string;
    }>;
    adjustments?: Array<Record<string, unknown>>;
    disputes?: Array<Record<string, unknown>>;
    reconciliationItems?: Array<Record<string, unknown>>;
};

export type OperatorCaseDetail = OperatorCaseSummary & {
    updatedAt: string;
    inquirySchedules?: Array<Partial<GatewayInquirySchedule> & { createdAt?: string }>;
    assignee?: { id: string; email: string; role: string } | null;
    attempt?: OperatorCaseAttempt | null;
    approvalRequest?: OperatorCaseApproval | null;
    reconciliationItem?: {
        id: string;
        result: string;
        ourReference: string;
        providerReference: string;
        statementAmount: string;
        statementFee: string;
        runId: string;
        run?: {
            id: string;
            fileName: string | null;
            windowStart: string;
            windowEnd: string;
            fileHash: string;
            statsJson: unknown;
            statementSource?: {
                id: string;
                type: string;
                settlementLagDays: number;
                gatewayId: string;
                gateway?: { id: string; code: string; name: string } | null;
            } | null;
        } | null;
    } | null;
    auditTrail?: Array<{
        id: string;
        createdAt: string;
        actorId: string;
        role: string;
        action: string;
        entityType: string;
        entityId: string;
        beforeJson: unknown;
        afterJson: unknown;
        approvalRequestId: string | null;
        actor?: { id: string; email: string; role: string } | null;
    }>;
};

export type BulkInquiryResult = {
    requested: number;
    scheduled: number;
    skipped: number;
    results: Array<{
        caseId: string;
        caseRef?: string;
        attemptId?: string | null;
        attemptReference?: string | null;
        scheduleId?: string;
        status: "SCHEDULED" | "SKIPPED";
        reason: string;
        message: string;
    }>;
};
