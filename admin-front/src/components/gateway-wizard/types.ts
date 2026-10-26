export type WizardIdentity = {
    code: string;
    name: string;
    operator: string;
    country: string;
    aliases: string[];
    kind: "DIRECT" | "AGGREGATOR" | "NATIVE_ADAPTER" | "INTERNAL";
    verificationState: "VERIFIED" | "UNVERIFIED";
    riskClass: "NORMAL" | "HIGH_RISK";
};

export type WizardEnvironment = {
    env: "SANDBOX" | "LIVE";
    baseUrl: string;
    allowedHosts: string[];
    inboundIpAllowlist: string[];
    enabled: boolean;
};

export type WizardAuth = {
    method:
        | "NONE"
        | "API_KEY"
        | "PERMANENT_TOKEN"
        | "TOKEN_ENDPOINT"
        | "REFRESH_TOKEN"
        | "USERNAME_PASSWORD"
        | "BASIC"
        | "REQUEST_SIGNATURE"
        | "OAUTH2_CLIENT_CREDENTIALS"
        | "MUTUAL_TLS";
    username: string;
    keyRef: string;
    tokenUrl: string;
    clientIdRef: string;
    clientSecretRef: string;
    extraHeaders: { key: string; value: string }[];
};

export type WizardCredentialSet = {
    id?: string;
    label: string;
    ownerType: "PLATFORM" | "MERCHANT";
    settlementTarget: "PLATFORM_CLEARING" | "MERCHANT_DIRECT" | "PROVIDER_HELD";
    env: "SANDBOX" | "LIVE";
    secret: string;
    secretRef: string;
};

export type WizardRailField = {
    id?: string;
    fieldKey: string;
    labelAr: string;
    labelEn: string;
    inputType: "text" | "numeric" | "phone" | "wallet_id" | "otp" | "select";
    required: boolean;
    regex: string;
    minLength: number | null;
    maxLength: number | null;
    normalizer: "NONE" | "ARABIC_DIGITS_TO_ASCII" | "PHONE_NORMALIZE_LOCAL_09" | "PHONE_NORMALIZE_INTL_218" | "PHONE_NORMALIZE_E164";
    sensitivity: "NORMAL" | "SENSITIVE" | "PAN";
    options: string[];
};

export type WizardRail = {
    id?: string;
    code: string;
    nameAr: string;
    nameEn: string;
    collectionMode: string;
    currency: string;
    minAmount: string;
    maxAmount: string;
    capabilities: string[];
    fields: WizardRailField[];
};

export type WizardCryptoProfile = {
    id?: string;
    name: string;
    direction: "OUTBOUND_SIGN" | "INBOUND_VERIFY";
    algorithm: "HMAC_SHA256" | "HMAC_SHA512" | "RSA_SHA256";
    keyEncoding: "utf8" | "hex" | "base64";
    canonicalization: "SORTED_KEY_VALUE_AMP" | "TIMESTAMP_DOT_RAW_BODY" | "SORTED_VALUES_HASH" | "RAW_BODY";
    secretRef: string;
    fields: string[];
    toleranceSeconds: number;
};

export type WizardTransform = {
    op: string;
    args: string[];
};

export type WizardFlowStep = {
    id?: string;
    phase:
        | "CREDENTIAL_CHECK"
        | "PRE_INITIATE"
        | "INITIATE"
        | "SUBMIT"
        | "VERIFY"
        | "CANCEL"
        | "REFUND"
        | "VOID"
        | "CAPTURE"
        | "SETTLEMENT_FETCH";
    order: number;
    type: "HTTP" | "COMPUTE" | "RENDER" | "WAIT" | "ASSERT" | "BRANCH";
    name: string;
    method: string;
    url: string;
    sideEffect: "READ_ONLY" | "SAFE_WITH_COOLDOWN" | "SENDS_NOTIFICATION" | "MOVES_MONEY";
    retryPolicy: "NEVER" | "SAFE" | "IDEMPOTENT";
    idempotencyConfig: string;
    pointOfNoReturn: boolean;
    transforms: WizardTransform[];
    assertExpression: string;
    outputName: string;
};

export type WizardFlow = {
    id?: string;
    phase: WizardFlowStep["phase"];
    steps: WizardFlowStep[];
};

export type WizardClientAction = {
    id?: string;
    kind: "SHOW_OTP_FORM" | "HTTP_REDIRECT" | "RENDER_EMBEDDED" | "SHOW_QR_OR_CODE" | "SHOW_PUSH_OR_TRANSFER";
    name: string;
    scriptUrls: string[];
    scriptSriHashes: string[];
    allowedOrigins: string[];
    iframeSandbox: string;
    otpLength: number;
    maxOtpAttempts: number;
    resendCooldownSeconds: number;
    redirectMethod: "GET" | "POST_FORM";
    redirectUrl: string;
    qrPayload: string;
    payCode: string;
    instructionsAr: string;
    instructionsEn: string;
    deepLinkUrl: string;
    walletHint: string;
    destinationAccount: string;
};

export type WizardConfirmationChannel = {
    id?: string;
    kind:
        | "SYNC_RESPONSE"
        | "WEBHOOK"
        | "INQUIRY_POLL"
        | "RETURN_URL"
        | "BROWSER_CALLBACK"
        | "STATEMENT"
        | "OPERATOR";
    name: string;
    eventMap: { event: string; canonical: string }[];
    secretRef: string;
    ipAllowlist: string[];
    mustInquire: boolean;
    timestampToleranceSeconds: number;
};

export type WizardPollPolicy = {
    id?: string;
    name: string;
    intervalSeconds: number;
    backoffSchedule: number[];
    maxAttempts: number;
    timeoutSeconds: number;
};

export type WizardStatusRule = {
    id?: string;
    gatewayCode: string;
    canonicalStatus: string;
    messageAr: string;
    messageEn: string;
    terminal: boolean;
};

export type WizardErrorMap = {
    id?: string;
    gatewayCode: string;
    canonicalStatus: string;
    retryable: boolean;
    otpRetryable: boolean;
    messageAr: string;
    messageEn: string;
};

export type WizardAmountPipeline = {
    scale: number;
    precision: number;
    rounding: "NONE" | "NEAREST" | "UP" | "DOWN";
    currency: string;
};

export type WizardCostModel = {
    model: "FLAT" | "PERCENT" | "FLAT_PLUS_PERCENT";
    flatFee: string;
    percentFee: string;
    minFee: string;
    maxFee: string;
    currency: string;
};

export type WizardStatementMapping = {
    sourceId: string;
    format: "CSV" | "XLSX" | "JSON";
    delimiter: string;
    columnMapping: { source: string; target: string }[];
};

export type WizardDraft = {
    id?: string;
    versionId?: string;
    identity: WizardIdentity;
    environments: WizardEnvironment[];
    auth: WizardAuth;
    credentialSets: WizardCredentialSet[];
    rails: WizardRail[];
    cryptoProfiles: WizardCryptoProfile[];
    flows: WizardFlow[];
    clientActions: WizardClientAction[];
    confirmationChannels: WizardConfirmationChannel[];
    pollPolicies: WizardPollPolicy[];
    statusRules: WizardStatusRule[];
    errorMaps: WizardErrorMap[];
    amountPipeline: WizardAmountPipeline;
    costModel: WizardCostModel;
    statementMapping: WizardStatementMapping;
    rollbackVersionId: string | null;
};

export const FLOW_PHASES: WizardFlowStep["phase"][] = [
    "CREDENTIAL_CHECK",
    "PRE_INITIATE",
    "INITIATE",
    "SUBMIT",
    "VERIFY",
    "CANCEL",
    "REFUND",
    "VOID",
    "CAPTURE",
    "SETTLEMENT_FETCH",
];

export const emptyDraft = (): WizardDraft => ({
    identity: {
        code: "",
        name: "",
        operator: "",
        country: "LY",
        aliases: [],
        kind: "DIRECT",
        verificationState: "UNVERIFIED",
        riskClass: "NORMAL",
    },
    environments: [
        {
            env: "SANDBOX",
            baseUrl: "",
            allowedHosts: [],
            inboundIpAllowlist: [],
            enabled: true,
        },
        {
            env: "LIVE",
            baseUrl: "",
            allowedHosts: [],
            inboundIpAllowlist: [],
            enabled: false,
        },
    ],
    auth: {
        method: "API_KEY",
        username: "",
        keyRef: "",
        tokenUrl: "",
        clientIdRef: "",
        clientSecretRef: "",
        extraHeaders: [],
    },
    credentialSets: [],
    rails: [],
    cryptoProfiles: [],
    flows: FLOW_PHASES.map((phase) => ({ phase, steps: [] })),
    clientActions: [],
    confirmationChannels: [],
    pollPolicies: [],
    statusRules: [],
    errorMaps: [],
    amountPipeline: { scale: 1, precision: 3, rounding: "NONE", currency: "LYD" },
    costModel: { model: "FLAT", flatFee: "0", percentFee: "0", minFee: "0", maxFee: "0", currency: "LYD" },
    statementMapping: { sourceId: "", format: "CSV", delimiter: ",", columnMapping: [] },
    rollbackVersionId: null,
});
