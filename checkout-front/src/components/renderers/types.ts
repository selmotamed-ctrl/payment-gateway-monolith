export type RailFieldInputType = "text" | "numeric" | "phone" | "wallet_id" | "otp" | "select";

export type RailFieldDescriptor = {
    key: string;
    labelAr: string;
    labelEn: string;
    inputType: RailFieldInputType;
    required: boolean;
    regex?: string | null;
    minLength?: number | null;
    maxLength?: number | null;
    options?: string[];
    sensitivity?: "NORMAL" | "SENSITIVE" | "PAN";
    placeholderAr?: string | null;
    placeholderEn?: string | null;
};

export type RailDescriptor = {
    code: string;
    displayNameAr: string;
    displayNameEn: string;
    collectionMode: string;
    minAmount?: string | null;
    maxAmount?: string | null;
    currency?: string | null;
    icon?: string | null;
    fields: RailFieldDescriptor[];
};

export type FeeBearerMode = "MERCHANT_ABSORBS" | "PAYER_SURCHARGE" | "SPLIT";

export type PayLinkSummary = {
    linkKey: string;
    merchantTradeName: string;
    merchantLogoUrl?: string | null;
    description?: string | null;
    amount: string;
    currency: string;
    feeBearerMode: FeeBearerMode;
    baseAmount: string;
    feeAmount: string;
    totalAmount: string;
    merchantAmount: string;
    splitPercent?: string | null;
    visibleRails: RailDescriptor[];
    expiresAt?: string | null;
    status: string;
    redirectUrl?: string | null;
    allowlistedRedirectHosts?: string[];
};

export type AttemptStatus =
    | "CREATED"
    | "INITIATING"
    | "AWAITING_CUSTOMER"
    | "AUTHORIZING"
    | "VERIFYING"
    | "UNKNOWN"
    | "SUCCEEDED"
    | "FAILED"
    | "EXPIRED"
    | "CANCELLED"
    | "BLOCKED"
    | "PARTIALLY_REFUNDED"
    | "REFUNDED"
    | "DISPUTED";

export type OtpClientAction = {
    kind: "SHOW_OTP_FORM";
    otp_length: number;
    max_attempts: number;
    resend_cooldown_seconds: number;
    expires_at: string;
    masked_phone?: string | null;
};

export type RedirectClientAction = {
    kind: "HTTP_REDIRECT";
    method: "GET" | "POST_FORM";
    url: string;
    form_fields?: Record<string, string>;
    target?: string | null;
    return_token?: string | null;
};

export type EmbeddedClientAction = {
    kind: "RENDER_EMBEDDED";
    sdk_driver: string;
    script_urls: string[];
    script_sri_hashes: string[];
    config: Record<string, unknown>;
    allowed_origins: string[];
    iframe_sandbox: string;
    iframe_src?: string | null;
};

export type QrOrCodeClientAction = {
    kind: "SHOW_QR_OR_CODE";
    qr_payload: string;
    pay_code?: string | null;
    instructions_ar: string;
    instructions_en: string;
    expires_at: string;
    deep_link_url?: string | null;
};

export type PushOrTransferClientAction = {
    kind: "SHOW_PUSH_OR_TRANSFER";
    wallet_hint: string;
    destination_account: string;
    payment_reference: string;
    instructions_ar: string;
    instructions_en: string;
    proof_upload_allowed: boolean;
    expires_at: string;
    cancel_supported: boolean;
};

export type ClientAction =
    | OtpClientAction
    | RedirectClientAction
    | EmbeddedClientAction
    | QrOrCodeClientAction
    | PushOrTransferClientAction;

export type AttemptSnapshot = {
    attemptId: string;
    reference: string;
    status: AttemptStatus;
    clientAction?: ClientAction | null;
    publicOutputs?: Record<string, unknown>;
    createdAt?: string;
    updatedAt?: string;
};

export type InitiateResponse = {
    attemptId: string;
    reference: string;
    status: AttemptStatus;
    clientAction: ClientAction;
};

export const TERMINAL_STATUSES: AttemptStatus[] = [
    "SUCCEEDED",
    "FAILED",
    "EXPIRED",
    "CANCELLED",
    "BLOCKED",
    "PARTIALLY_REFUNDED",
    "REFUNDED",
];

export const PENDING_STATUSES: AttemptStatus[] = [
    "CREATED",
    "INITIATING",
    "AWAITING_CUSTOMER",
    "AUTHORIZING",
    "VERIFYING",
    "UNKNOWN",
];
