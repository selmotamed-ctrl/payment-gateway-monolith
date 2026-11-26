import {
    MONEY_PATTERN,
    CURRENCY_PATTERN,
    asObject,
    deepClone,
    deepEqual,
    humanizeKey,
    isPlainObject,
    toStringList,
    uniqueStrings,
    type JsonObject,
} from "./jsonTree";

/**
 * Typed editors for the platform-setting namespaces the platform actually reads,
 * plus the decision-register keys kept for audit and reference.
 *
 * Human-facing catalog metadata (section, summary, reader, effect, risk, search
 * keywords, defaults) lives in `settingsCatalog.ts`. This file owns the value
 * shape only: the JSON object contract, the form model and the validators.
 *
 * Adding a setting? Read `docs/developer/platform-settings.md` and follow the
 * checklist. Every field MUST have a hint.
 */
export type SettingFieldKind =
    | "text"
    | "longtext"
    | "integer"
    | "number"
    | "money"
    | "boolean"
    | "select"
    | "strings"
    | "stringListMap"
    | "tree";

/** A visual group inside a long setting editor (for example Sampling, Thresholds, Recovery). */
export type SettingFieldGroup = "General" | "Sampling" | "Thresholds" | "Recovery" | "Canary" | "Overrides" | "Content" | "Contact" | "Identity" | "Stored note";

export type SettingFieldDef = {
    key: string;
    kind: SettingFieldKind;
    /** English label (translated by the view). */
    label: string;
    /** Visible explanation of the field, its unit and its effect. Required for every field. */
    hint: string;
    /** Longer help shown in the detail drawer when the hint is not enough. */
    description?: string;
    options?: readonly string[];
    /** Per-option explanations shown below a select. */
    optionHints?: Readonly<Record<string, string>>;
    /** Unit shown beside the control, e.g. "seconds", "days", "LYD". */
    unit?: string;
    /** Value restored by "Reset to default"; the actual defaults also live in the catalog definition. */
    default?: unknown;
    min?: number;
    max?: number;
    required?: boolean;
    /** Alternative spellings the platform also reads (snake_case, legacy). Read and written back as found. */
    aliases?: readonly string[];
    /** Upper-case every list entry (codes, roles). */
    uppercase?: boolean;
    /** Editor group. */
    group?: SettingFieldGroup;
};

export type SettingNamespaceDef = {
    id: string;
    title: string;
    description: string;
    fields: readonly SettingFieldDef[];
};

const storedNote: SettingFieldDef = {
    key: "description",
    kind: "longtext",
    label: "Stored note",
    hint: "Optional free-text note saved with this version. Explain why the value is what it is; the catalog description above is the general explanation.",
    group: "Stored note",
};

const currency: SettingFieldDef = {
    key: "currency",
    kind: "text",
    label: "Currency",
    hint: "Three-letter currency code, for example LYD.",
    default: "LYD",
    group: "General",
};

const NAMESPACES: Record<string, SettingNamespaceDef> = {
    "OD-1": {
        id: "OD-1",
        title: "Regulatory reporting thresholds",
        description: "Recorded state of the CBL reporting-threshold decision. Reporting rules carry their own mode.",
        fields: [
            {
                key: "mode",
                kind: "select",
                label: "Mode",
                hint: "PROVISIONAL records that the CBL thresholds are not yet confirmed; CONFIRMED means written instructions are on file.",
                options: ["PROVISIONAL", "CONFIRMED"],
                optionHints: {
                    PROVISIONAL: "The baseline schemas and thresholds are still provisional; filing is blocked.",
                    CONFIRMED: "The CBL/FIU has confirmed the schema or threshold; a person may file.",
                },
                default: "PROVISIONAL",
                group: "General",
            },
            {
                key: "internalOnly",
                kind: "boolean",
                label: "Internal only",
                hint: "When on, this threshold record is staff-only and must not be shared with merchants.",
                default: true,
                group: "General",
            },
            storedNote,
        ],
    },
    "OD-2": {
        id: "OD-2",
        title: "Four-eyes policy for join requests (legacy)",
        description: "Legacy fallback for the join-request four-eyes decision. The canonical key is join_request.four_eyes_policy.",
        fields: [
            {
                key: "policy",
                kind: "select",
                label: "Policy",
                hint: "When a second reviewer is required. The canonical join_request.four_eyes_policy value is read first.",
                options: ["RISK_BASED", "ALWAYS", "NEVER"],
                optionHints: {
                    RISK_BASED: "A second reviewer is required only for risky applicants.",
                    ALWAYS: "Every join request needs a second reviewer.",
                    NEVER: "Single-reviewer onboarding; use only with a documented risk acceptance.",
                },
                aliases: ["fourEyesPolicy"],
                default: "RISK_BASED",
                group: "General",
            },
            {
                key: "ownerThresholdPercent",
                kind: "number",
                label: "Beneficial owner threshold (%)",
                hint: "An owner at or above this percentage makes the applicant risky. 25 = 25%.",
                min: 0,
                max: 100,
                aliases: ["owner_threshold_percent"],
                default: 25,
                group: "General",
            },
            {
                key: "highRiskCategories",
                kind: "strings",
                label: "High-risk business categories",
                hint: "Business category codes that require a second reviewer, for example CRYPTO, GAMBLING or ARMS. One code per chip.",
                uppercase: true,
                aliases: ["high_risk_categories"],
                group: "General",
            },
            storedNote,
        ],
    },
    "OD-3": {
        id: "OD-3",
        title: "Screening provider",
        description: "Recorded provider and adapters used for sanctions and PEP screening. The active adapter is selected in code.",
        fields: [
            {
                key: "provider",
                kind: "text",
                label: "Provider",
                hint: "Recorded provider name, for example INTERNAL_WATCHLIST. Changing this record does not switch the live provider.",
                required: true,
                default: "INTERNAL_WATCHLIST",
                group: "General",
            },
            {
                key: "adapters",
                kind: "strings",
                label: "Adapters",
                hint: "Recorded adapter names, one per chip. The live adapter list is deployment configuration.",
                default: ["internal-watchlist", "mock-sandbox"],
                group: "General",
            },
            storedNote,
        ],
    },
    "OD-4": {
        id: "OD-4",
        title: "Record retention",
        description: "How long KYB and related records are retained by the retention worker.",
        fields: [
            {
                key: "kybYears",
                kind: "integer",
                label: "Retention (years)",
                hint: "Retention period in years when no day value is set. 5 = five years.",
                min: 1,
                max: 100,
                aliases: ["retentionYears", "years"],
                default: 5,
                group: "General",
            },
            {
                key: "retentionDays",
                kind: "integer",
                label: "Retention (days)",
                hint: "Exact retention in days; takes precedence over the years value when set. Leave blank to use years.",
                min: 1,
                max: 36500,
                group: "General",
            },
            storedNote,
        ],
    },
    "OD-5": {
        id: "OD-5",
        title: "First production gateway",
        description: "Recorded recommendation for the first production internal rail. It does not change routing.",
        fields: [
            {
                key: "gatewayCode",
                kind: "text",
                label: "Gateway code",
                hint: "Gateway code from the gateway catalog, for example neompay. This is a recorded recommendation, not the live routing switch.",
                required: true,
                default: "neompay",
                group: "General",
            },
            {
                key: "kind",
                kind: "select",
                label: "Gateway kind",
                hint: "Recorded gateway type: INTERNAL for our own rail, EXTERNAL for a partner.",
                options: ["INTERNAL", "EXTERNAL"],
                default: "INTERNAL",
                group: "General",
            },
            {
                key: "recommendedStage",
                kind: "integer",
                label: "Recommended stage",
                hint: "Recorded rollout stage number from the design decision (0-20).",
                min: 0,
                max: 20,
                default: 2,
                group: "General",
            },
            storedNote,
        ],
    },
    "OD-6": {
        id: "OD-6",
        title: "Beneficial owner threshold (decision record)",
        description: "Recorded ownership percentage at which a beneficial owner is captured. The live threshold is in join_request.four_eyes_policy.",
        fields: [
            {
                key: "ownerThresholdPercent",
                kind: "number",
                label: "Beneficial owner threshold (%)",
                hint: "Recorded ownership threshold. The live join-request threshold is in join_request.four_eyes_policy.",
                min: 0,
                max: 100,
                required: true,
                default: 25,
                group: "General",
            },
            storedNote,
        ],
    },
    "OD-7": {
        id: "OD-7",
        title: "Collection time ceilings",
        description: "Recorded platform time-to-live ceilings per collection mode. Live limits come from each rail and flow.",
        fields: [
            {
                key: "otpPullSeconds",
                kind: "integer",
                label: "OTP pull (seconds)",
                hint: "Recorded maximum OTP pull collection time. 1200 = 20 minutes.",
                min: 1,
                max: 86400,
                unit: "seconds",
                default: 1200,
                group: "General",
            },
            {
                key: "redirectSeconds",
                kind: "integer",
                label: "Redirect (seconds)",
                hint: "Recorded maximum redirect collection time. 1800 = 30 minutes.",
                min: 1,
                max: 86400,
                unit: "seconds",
                default: 1800,
                group: "General",
            },
            {
                key: "qrDisplaySeconds",
                kind: "integer",
                label: "QR display (seconds)",
                hint: "Recorded maximum QR display time. 900 = 15 minutes.",
                min: 1,
                max: 86400,
                unit: "seconds",
                default: 900,
                group: "General",
            },
            {
                key: "pushApprovalSeconds",
                kind: "integer",
                label: "Push approval (seconds)",
                hint: "Recorded maximum push-approval time. 900 = 15 minutes.",
                min: 1,
                max: 86400,
                unit: "seconds",
                default: 900,
                group: "General",
            },
            storedNote,
        ],
    },
    "OD-8": {
        id: "OD-8",
        title: "Negative balance ceiling",
        description: "Recorded default overdraft allowance for a new merchant wallet. Each merchant's live limit is its own negativeBalanceCeiling field.",
        fields: [
            {
                key: "negativeBalanceCeiling",
                kind: "money",
                label: "Negative balance ceiling",
                hint: "Recorded default overdraft allowance as a decimal string, for example 0.0000. A merchant's live limit is stored on the merchant.",
                required: true,
                default: "0.0000",
                group: "General",
            },
            currency,
            storedNote,
        ],
    },
    "OD-9": {
        id: "OD-9",
        title: "Emergency suspension ratification",
        description: "Recorded policy for who must ratify an emergency suspension and how fast.",
        fields: [
            {
                key: "ratificationWindowHours",
                kind: "integer",
                label: "Ratification window (hours)",
                hint: "Hours a second officer has to ratify an emergency suspension. 24 = one day.",
                min: 1,
                max: 720,
                unit: "hours",
                default: 24,
                group: "General",
            },
            {
                key: "authorizedRoles",
                kind: "strings",
                label: "Authorised roles",
                hint: "Roles allowed to ratify, one per chip, for example MLRO or COMPLIANCE.",
                uppercase: true,
                default: ["MLRO", "COMPLIANCE"],
                group: "General",
            },
            storedNote,
        ],
    },
    "OD-10": {
        id: "OD-10",
        title: "Sandbox before approval (retired)",
        description: "Retired decision. Sandbox is now a separate execution plane and the Live plane refuses non-ACTIVE merchants.",
        fields: [
            {
                key: "sandboxBeforeApproval",
                kind: "boolean",
                label: "Allow sandbox before approval",
                hint: "Retired: this value is kept for history. Sandbox is a separate execution plane; changing it has no effect.",
                default: false,
                group: "General",
            },
            storedNote,
        ],
    },
    "OD-11": {
        id: "OD-11",
        title: "Checker roles",
        description: "Recorded roles provisioned as named checker accounts. Actual people and roles are managed in Admin Users.",
        fields: [
            {
                key: "checkerRoles",
                kind: "strings",
                label: "Checker roles",
                hint: "Roles provisioned as named checker accounts, one per chip. Actual users are managed in Admin Users.",
                uppercase: true,
                default: ["MLRO", "COMPLIANCE", "FINANCE"],
                group: "General",
            },
            storedNote,
        ],
    },
    "onboarding.required_documents": {
        id: "onboarding.required_documents",
        title: "Required KYB documents",
        description: "The default KYB document set and the per-category replacements.",
        fields: [
            {
                key: "default",
                kind: "strings",
                label: "Default documents",
                hint: "Default KYB document codes required for every applicant, one code per chip, for example COMMERCIAL_REGISTRY.",
                uppercase: true,
                default: ["COMMERCIAL_REGISTRY", "TAX_CERTIFICATE", "BANK_LETTER", "PROOF_OF_ADDRESS"],
                group: "General",
            },
            {
                key: "byCategory",
                kind: "stringListMap",
                label: "Documents per business category",
                hint: "Category code to document codes. A category entry replaces the default list for that category.",
                uppercase: true,
                group: "General",
            },
            storedNote,
        ],
    },
    "join_request.volume_threshold": {
        id: "join_request.volume_threshold",
        title: "Review volume threshold",
        description: "An expected monthly volume above this amount forces a second reviewer.",
        fields: [
            {
                key: "amount",
                kind: "number",
                label: "Amount",
                hint: "Expected monthly volume above which a second reviewer is required. Use a decimal amount, for example 250000.",
                min: 0,
                required: true,
                aliases: ["value"],
                default: 250000,
                group: "General",
            },
            currency,
            storedNote,
        ],
    },
    "kyb.refresh_policy": {
        id: "kyb.refresh_policy",
        title: "KYB refresh policy",
        description: "Periodic KYB re-verification cadence and expiry handling.",
        fields: [
            {
                key: "highMonths",
                kind: "integer",
                label: "High risk (months)",
                hint: "Months between re-verification for HIGH-risk merchants. 12 = annually.",
                min: 1,
                max: 120,
                unit: "months",
                aliases: ["high_months"],
                default: 12,
                group: "General",
            },
            {
                key: "standardMonths",
                kind: "integer",
                label: "Standard risk (months)",
                hint: "Months between re-verification for STANDARD-risk merchants. 24 = every two years.",
                min: 1,
                max: 120,
                unit: "months",
                aliases: ["standard_months"],
                default: 24,
                group: "General",
            },
            {
                key: "lowMonths",
                kind: "integer",
                label: "Low risk (months)",
                hint: "Months between re-verification for LOW-risk merchants. 36 = every three years.",
                min: 1,
                max: 120,
                unit: "months",
                aliases: ["low_months"],
                default: 36,
                group: "General",
            },
            {
                key: "expiryGraceDays",
                kind: "integer",
                label: "Expiry grace (days)",
                hint: "Days after a KYB expiry before the merchant is treated as overdue. 30 = one month.",
                min: 0,
                max: 365,
                unit: "days",
                aliases: ["expiry_grace_days"],
                default: 30,
                group: "General",
            },
            {
                key: "revalidationDueDays",
                kind: "integer",
                label: "Revalidation due (days)",
                hint: "Days before the next review when a revalidation request is opened. 30 = one month.",
                min: 1,
                max: 365,
                unit: "days",
                aliases: ["revalidation_due_days"],
                default: 30,
                group: "General",
            },
            {
                key: "duplicateAmlThreshold",
                kind: "integer",
                label: "Duplicate AML threshold",
                hint: "Number of duplicate document reuses that triggers an AML review. 3 = the third reuse.",
                min: 1,
                max: 100,
                aliases: ["duplicate_aml_threshold"],
                default: 3,
                group: "General",
            },
            storedNote,
        ],
    },
    "screening.watchlist": {
        id: "screening.watchlist",
        title: "Internal watch list",
        description: "The internal watch list the transaction hot path screens against. A published revision needs a new version.",
        fields: [
            {
                key: "version",
                kind: "text",
                label: "List version",
                hint: "Revision label. Publishing a new list with the same version keeps cached screening results; change the version to invalidate them.",
                required: true,
                default: "internal-v1",
                group: "General",
            },
            {
                key: "entries",
                kind: "tree",
                label: "Entries",
                hint: "One row per watched person or entity: entryRef, listType, listName, names[], identifiers[]. Malformed rows are ignored.",
                group: "General",
            },
            storedNote,
        ],
    },
    "screening.fail_closed": {
        id: "screening.fail_closed",
        title: "Screening fail-closed switch",
        description: "Whether a screening error blocks the payment (the safe default) or lets it pass.",
        fields: [
            {
                key: "failClosed",
                kind: "boolean",
                label: "Fail closed",
                hint: "On: block the payment when screening fails (safe default). Off: allow the payment and record the screening as unknown.",
                aliases: ["fail_closed"],
                default: true,
                group: "General",
            },
        ],
    },
    SELF_PAYMENT_POLICY: {
        id: "SELF_PAYMENT_POLICY",
        title: "Self-payment policy",
        description: "Anti-self-dealing policy: a merchant paying into its own wallet or account.",
        fields: [
            {
                key: "policy",
                kind: "select",
                label: "Policy",
                hint: "BLOCK prevents a merchant from paying into its own wallet. ALLOW is for documented exceptions only.",
                options: ["BLOCK", "ALLOW"],
                optionHints: {
                    BLOCK: "Block self-payments. This is the safe default.",
                    ALLOW: "Allow self-payments. Use only for a documented and approved exception.",
                },
                required: true,
                default: "BLOCK",
                group: "General",
            },
        ],
    },
    "route_health.policy": {
        id: "route_health.policy",
        title: "Route health policy",
        description: "Automatic route circuit breaker, canary traffic and admin override limits.",
        fields: [
            {
                key: "enabled",
                kind: "boolean",
                label: "Route health automation enabled",
                hint: "Turn automatic health sampling and circuit-breaker action on or off. Off leaves routes as they are.",
                default: true,
                group: "General",
            },
            {
                key: "mode",
                kind: "select",
                label: "Mode",
                hint: "OFF records nothing; SHADOW records health but takes no routing action; ENFORCE degrades and opens routes automatically.",
                options: ["OFF", "SHADOW", "ENFORCE"],
                optionHints: {
                    OFF: "No automatic action. Health samples may still be recorded.",
                    SHADOW: "Observe and report only; routing does not change.",
                    ENFORCE: "Automatically degrade or open a failing route.",
                },
                required: true,
                default: "ENFORCE",
                group: "General",
            },
            {
                key: "sampleBucketSeconds",
                kind: "integer",
                label: "Sample bucket (seconds)",
                hint: "How often outcomes are grouped for health math. 300 = five minutes.",
                min: 60,
                max: 3600,
                unit: "seconds",
                default: 300,
                group: "Sampling",
            },
            {
                key: "windowSeconds",
                kind: "integer",
                label: "Rolling window (seconds)",
                hint: "Rolling window used for error-rate decisions. 900 = fifteen minutes.",
                min: 300,
                max: 86400,
                unit: "seconds",
                default: 900,
                group: "Sampling",
            },
            {
                key: "minOutcomes",
                kind: "integer",
                label: "Minimum outcomes",
                hint: "Minimum attempts in the window before an error rate is trusted. 10 = ten attempts.",
                min: 1,
                max: 100000,
                default: 10,
                group: "Sampling",
            },
            {
                key: "degradeErrorRate",
                kind: "number",
                label: "Degrade error rate",
                hint: "Share of definitive failures that marks a route degraded. 0.30 = 30%.",
                min: 0,
                max: 1,
                default: 0.3,
                group: "Thresholds",
            },
            {
                key: "openErrorRate",
                kind: "number",
                label: "Open-breaker error rate",
                hint: "Share of definitive failures that opens the breaker. 0.60 = 60%.",
                min: 0,
                max: 1,
                default: 0.6,
                group: "Thresholds",
            },
            {
                key: "degradeConsecutive",
                kind: "integer",
                label: "Degrade consecutive failures",
                hint: "Consecutive failures that degrade a route even when the window rate is low. 3 = three in a row.",
                min: 1,
                max: 1000,
                default: 3,
                group: "Thresholds",
            },
            {
                key: "openConsecutive",
                kind: "integer",
                label: "Open consecutive failures",
                hint: "Consecutive failures that open the breaker. 6 = six in a row.",
                min: 1,
                max: 1000,
                default: 6,
                group: "Thresholds",
            },
            {
                key: "recoverDegradedProbes",
                kind: "integer",
                label: "Degraded recovery probes",
                hint: "Successful probes needed to leave DEGRADED. 2 = two successes.",
                min: 1,
                max: 100,
                default: 2,
                group: "Recovery",
            },
            {
                key: "recoverOpenProbes",
                kind: "integer",
                label: "Open recovery probes",
                hint: "Successful probes needed to leave OPEN_BREAKER. 3 = three successes.",
                min: 1,
                max: 100,
                default: 3,
                group: "Recovery",
            },
            {
                key: "openCooldownSeconds",
                kind: "integer",
                label: "Open cooldown (seconds)",
                hint: "How long the breaker stays open before recovery probes resume. 300 = five minutes.",
                min: 0,
                max: 86400,
                unit: "seconds",
                default: 300,
                group: "Recovery",
            },
            {
                key: "probeIntervalSeconds",
                kind: "integer",
                label: "Probe interval (seconds)",
                hint: "Delay between recovery probes. 60 = one minute.",
                min: 10,
                max: 86400,
                unit: "seconds",
                default: 60,
                group: "Recovery",
            },
            {
                key: "probeBackoffMaxSeconds",
                kind: "integer",
                label: "Probe backoff maximum (seconds)",
                hint: "Maximum delay between failed probes. 900 = fifteen minutes.",
                min: 60,
                max: 86400,
                unit: "seconds",
                default: 900,
                group: "Recovery",
            },
            {
                key: "canaryPercent",
                kind: "number",
                label: "Degraded canary cohort (%)",
                hint: "Share of traffic sent to a degraded route for observation. 5 = 5%.",
                min: 0,
                max: 100,
                unit: "%",
                default: 5,
                group: "Canary",
            },
            {
                key: "canaryMaxAmount",
                kind: "text",
                label: "Canary maximum amount",
                hint: "Optional cap on a canary payment amount, as a decimal string. Blank means no amount cap.",
                default: null,
                group: "Canary",
            },
            {
                key: "degradedRecoverMinOutcomes",
                kind: "integer",
                label: "Degraded recovery minimum outcomes",
                hint: "Minimum canary outcomes before recovery is considered. 10 = ten outcomes.",
                min: 1,
                max: 100000,
                default: 10,
                group: "Canary",
            },
            {
                key: "degradedRecoverErrorRate",
                kind: "number",
                label: "Degraded recovery error rate",
                hint: "Canary error rate that allows recovery. 0.10 = 10%.",
                min: 0,
                max: 1,
                default: 0.1,
                group: "Canary",
            },
            {
                key: "overrideDefaultExpiryDays",
                kind: "integer",
                label: "Default override expiry (days)",
                hint: "Default lifetime of a manual force-healthy override. 7 = one week.",
                min: 1,
                max: 30,
                unit: "days",
                default: 7,
                group: "Overrides",
            },
            {
                key: "overrideMaxExpiryDays",
                kind: "integer",
                label: "Maximum override expiry (days)",
                hint: "Longest override lifetime an operator may request. 30 = thirty days.",
                min: 1,
                max: 30,
                unit: "days",
                default: 30,
                group: "Overrides",
            },
            {
                key: "overrideReviewHours",
                kind: "integer",
                label: "Override review reminder (hours)",
                hint: "When to remind reviewers about an active override. 24 = one day.",
                min: 1,
                max: 720,
                unit: "hours",
                default: 24,
                group: "Overrides",
            },
            storedNote,
        ],
    },
    "merchant_reports.policy": {
        id: "merchant_reports.policy",
        title: "Merchant reporting policy",
        description: "Controls the merchant report runner/Studio and whether merchants may attach asset bundles.",
        fields: [
            {
                key: "enabled",
                kind: "boolean",
                label: "Merchant report Studio enabled",
                hint: "When off, the merchant report runner and Studio are unavailable for every merchant.",
                default: true,
                group: "General",
            },
            {
                key: "assetsEnabled",
                kind: "boolean",
                label: "Merchant report assets enabled",
                hint: "When off, merchant reports cannot declare required assets and asset .zip uploads are rejected.",
                aliases: ["assets_enabled"],
                default: true,
                group: "General",
            },
            storedNote,
        ],
    },
    "checkout.support_config": {
        id: "checkout.support_config",
        title: "Checkout support configuration",
        description: "Payer-facing support channels, working hours and FAQ. Edited on Checkout Help.",
        fields: [
            {
                key: "enabled",
                kind: "boolean",
                label: "Support enabled",
                hint: "When on, the checkout help drawer shows the contact block and FAQ.",
                default: true,
                group: "General",
            },
            {
                key: "show_platform_contact",
                kind: "boolean",
                label: "Show platform contact",
                hint: "Show the platform support phone, WhatsApp and email to the payer.",
                default: true,
                group: "Contact",
            },
            {
                key: "show_merchant_contact",
                kind: "boolean",
                label: "Show merchant contact",
                hint: "Show the merchant's own contact details when the merchant has them.",
                default: true,
                group: "Contact",
            },
            {
                key: "support_phone",
                kind: "text",
                label: "Support phone",
                hint: "Platform support phone number shown to payers, including the country code.",
                group: "Contact",
            },
            {
                key: "support_whatsapp",
                kind: "text",
                label: "Support WhatsApp",
                hint: "Platform support WhatsApp number shown to payers, including the country code.",
                group: "Contact",
            },
            {
                key: "support_email",
                kind: "text",
                label: "Support email",
                hint: "Platform support email address shown to payers.",
                group: "Contact",
            },
            {
                key: "working_hours_en",
                kind: "text",
                label: "Working hours (English)",
                hint: "English working-hours text shown to payers, for example Sunday to Thursday, 09:00-17:00.",
                group: "Content",
            },
            {
                key: "working_hours_ar",
                kind: "text",
                label: "Working hours (Arabic)",
                hint: "Arabic working-hours text shown to Arabic payers.",
                group: "Content",
            },
            {
                key: "faq_items",
                kind: "tree",
                label: "FAQ entries",
                hint: "Bilingual question/answer rows. Each row needs q_ar, a_ar, q_en and a_en.",
                group: "Content",
            },
            storedNote,
        ],
    },
    "calendar.holidays": {
        id: "calendar.holidays",
        title: "Business holiday calendar",
        description: "Public holidays that pause business-hour SLA clocks. Weekends are Sunday to Thursday by default.",
        fields: [
            {
                key: "holidays",
                kind: "strings",
                label: "Holidays",
                hint: "Public holidays in YYYY-MM-DD format, one per chip. Business-hour clocks skip these dates. Weekends are Sunday to Thursday.",
                group: "General",
            },
            storedNote,
        ],
    },
    "goaml.rentity_id": {
        id: "goaml.rentity_id",
        title: "goAML reporting entity ID",
        description: "The reporting entity identifier used in generated goAML XML.",
        fields: [
            {
                key: "value",
                kind: "text",
                label: "Value",
                hint: "Reporting entity ID assigned by the FIU. The seeded placeholder is provisional until the CBL/FIU confirms it.",
                required: true,
                default: "PROVISIONAL-CBL-RENTITY",
                group: "Identity",
            },
        ],
    },
    "goaml.rentity_branch": {
        id: "goaml.rentity_branch",
        title: "goAML reporting branch",
        description: "The branch or office code used in generated goAML XML.",
        fields: [
            {
                key: "value",
                kind: "text",
                label: "Value",
                hint: "Branch or office code for the reporting entity. The seeded placeholder is provisional.",
                default: "PROVISIONAL",
                group: "Identity",
            },
        ],
    },
    "goaml.submission_code": {
        id: "goaml.submission_code",
        title: "goAML submission code",
        description: "The goAML submission type code used in generated XML.",
        fields: [
            {
                key: "value",
                kind: "text",
                label: "Value",
                hint: "goAML submission type code, usually E for an electronic report.",
                default: "E",
                group: "Identity",
            },
        ],
    },
    "goaml.local_currency_code": {
        id: "goaml.local_currency_code",
        title: "goAML local currency code",
        description: "The local currency code used in generated goAML XML.",
        fields: [
            {
                key: "value",
                kind: "text",
                label: "Value",
                hint: "Three-letter local currency code used in reports, for example LYD.",
                default: "LYD",
                group: "Identity",
            },
        ],
    },
    "goaml.reporting_person_name": {
        id: "goaml.reporting_person_name",
        title: "goAML reporting person name",
        description: "The name of the person submitting a goAML report.",
        fields: [
            {
                key: "value",
                kind: "text",
                label: "Value",
                hint: "Full name of the person submitting the report. Used in the report header.",
                default: "Compliance Officer",
                group: "Identity",
            },
        ],
    },
    "goaml.reporting_person_email": {
        id: "goaml.reporting_person_email",
        title: "goAML reporting person email",
        description: "The email of the person submitting a goAML report.",
        fields: [
            {
                key: "value",
                kind: "text",
                label: "Value",
                hint: "Email address of the reporting person. Used in the report header.",
                default: "compliance@payment-gateway.internal",
                group: "Identity",
            },
        ],
    },
    "server.environment_mode": {
        id: "server.environment_mode",
        title: "Server environment mode",
        description: "Internal marker written by the Fake Rails seed. System-managed and should not be edited.",
        fields: [
            {
                key: "mode",
                kind: "text",
                label: "Mode",
                hint: "Internal test-environment marker. Changing it can break the Fake Rails integration; leave it as written by the deploy.",
                required: true,
                default: "TEST_SANDBOX",
                group: "General",
            },
        ],
    },
};

const GO_LIVE_PREFIX = "gateway.go_live.";

/** The canonical key reads the same value shape as the legacy OD-2 register. */
NAMESPACES["join_request.four_eyes_policy"] = {
    ...NAMESPACES["OD-2"]!,
    id: "join_request.four_eyes_policy",
    title: "Four-eyes policy for join requests",
    description: "When a second reviewer is required for a join request. The canonical key; the legacy OD-2 key is a fallback.",
};

const goLiveNamespace = (gatewayCode: string, aspect: string): SettingNamespaceDef => {
    const title = `Gateway go-live: ${aspect.replaceAll("_", " ")}`;
    const description = "Operator-provided go-live evidence for one gateway aspect. The gateway activation gate reads this key.";
    const fieldsByAspect: Record<string, SettingFieldDef[]> = {
        canary_traffic_plan: [
            {
                key: "approvedBy",
                kind: "text",
                label: "Approved by",
                hint: "Person or role who approved the canary traffic plan.",
                group: "General",
            },
            {
                key: "percent",
                kind: "number",
                label: "Canary traffic share (%)",
                hint: "Share of traffic approved for the canary plan. 5 = 5%.",
                min: 0,
                max: 100,
                unit: "%",
                group: "General",
            },
            {
                key: "notes",
                kind: "longtext",
                label: "Plan notes",
                hint: "What the canary plan covers, expected duration and rollback trigger.",
                group: "General",
            },
        ],
        route_alerts: [
            {
                key: "channel",
                kind: "select",
                label: "Alert channel",
                hint: "Where route alerts are delivered: email, chat or an on-call tool.",
                options: ["EMAIL", "CHAT", "ON_CALL"],
                group: "General",
            },
            {
                key: "recipients",
                kind: "strings",
                label: "Recipients",
                hint: "People or teams that receive route alerts, one per chip.",
                group: "General",
            },
            {
                key: "notes",
                kind: "longtext",
                label: "Alert notes",
                hint: "Which route failures should page a person and which are reviewed in business hours.",
                group: "General",
            },
        ],
        runbooks: [
            {
                key: "url",
                kind: "text",
                label: "Runbook URL",
                hint: "Link to the operational runbook for this gateway's route incidents.",
                group: "General",
            },
            {
                key: "notes",
                kind: "longtext",
                label: "Runbook notes",
                hint: "Key steps or escalation contacts for the first responder.",
                group: "General",
            },
        ],
        pci_scope_review: [
            {
                key: "reviewed",
                kind: "boolean",
                label: "PCI scope reviewed",
                hint: "On when a documented PCI scope review has been completed for this gateway.",
                default: false,
                group: "General",
            },
            {
                key: "reviewedBy",
                kind: "text",
                label: "Reviewed by",
                hint: "Person or role who completed the PCI scope review.",
                group: "General",
            },
            {
                key: "reviewedAt",
                kind: "text",
                label: "Reviewed at",
                hint: "Date of the review, preferably YYYY-MM-DD.",
                group: "General",
            },
            {
                key: "notes",
                kind: "longtext",
                label: "Review notes",
                hint: "What was reviewed and any compensating controls.",
                group: "General",
            },
        ],
        executive_acceptance: [
            {
                key: "signed",
                kind: "boolean",
                label: "Executive acceptance signed",
                hint: "On when a high-risk gateway has a signed executive acceptance.",
                default: false,
                group: "General",
            },
            {
                key: "signedBy",
                kind: "text",
                label: "Signed by",
                hint: "Executive who signed the acceptance.",
                group: "General",
            },
            {
                key: "signedAt",
                kind: "text",
                label: "Signed at",
                hint: "Date the acceptance was signed, preferably YYYY-MM-DD.",
                group: "General",
            },
            {
                key: "notes",
                kind: "longtext",
                label: "Acceptance notes",
                hint: "Scope and time limit of the acceptance.",
                group: "General",
            },
        ],
    };
    return {
        id: `${GO_LIVE_PREFIX}${gatewayCode}.${aspect}`,
        title,
        description,
        fields: fieldsByAspect[aspect] ?? [],
    };
};

/** The namespace of a key: an exact key, or the `gateway.go_live.*` family (free-form, operator provided). */
export const resolveSettingNamespace = (key: string): SettingNamespaceDef | null => {
    const exact = NAMESPACES[key];
    if (exact) return exact;
    if (key.startsWith(GO_LIVE_PREFIX)) {
        const rest = key.slice(GO_LIVE_PREFIX.length);
        const separator = rest.lastIndexOf(".");
        if (separator <= 0 || separator === rest.length - 1) {
            return {
                id: key,
                title: "Gateway go-live evidence",
                description: "Operator-provided go-live configuration of one gateway aspect.",
                fields: [],
            };
        }
        return goLiveNamespace(rest.slice(0, separator), rest.slice(separator + 1));
    }
    return null;
};

export const knownSettingKeys = (): string[] => Object.keys(NAMESPACES);

// ---------------------------------------------------------------- form model

export type SettingFormValue = string | boolean | string[] | Record<string, string[]> | unknown;
export type SettingForm = {
    /** Editable text/boolean/list value per declared field. */
    values: Record<string, SettingFormValue>;
    /** The JSON key (alias) each declared field was read from. */
    keys: Record<string, string>;
    /** The original JSON value of each declared field. */
    originals: Record<string, unknown>;
    /** Every key the namespace does not declare. */
    extras: JsonObject;
};

const fieldAliases = (field: SettingFieldDef): readonly string[] => [field.key, ...(field.aliases ?? [])];

const readText = (value: unknown): string => {
    if (typeof value === "string") return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    return "";
};

export const parseSettingForm = (def: SettingNamespaceDef | null, raw: unknown): SettingForm => {
    const source = asObject(raw);
    const form: SettingForm = { values: {}, keys: {}, originals: {}, extras: {} };
    const consumed = new Set<string>();
    for (const field of def?.fields ?? []) {
        const alias = fieldAliases(field).find((candidate) => Object.prototype.hasOwnProperty.call(source, candidate));
        const original = alias ? source[alias] : undefined;
        if (alias) {
            consumed.add(alias);
            form.keys[field.key] = alias;
            form.originals[field.key] = original;
        }
        switch (field.kind) {
            case "boolean":
                form.values[field.key] = original === true || original === "true";
                break;
            case "strings":
                form.values[field.key] = toStringList(original);
                break;
            case "stringListMap": {
                const map: Record<string, string[]> = {};
                if (isPlainObject(original)) for (const [name, list] of Object.entries(original)) map[name] = toStringList(list);
                form.values[field.key] = map;
                break;
            }
            case "tree":
                form.values[field.key] = original === undefined ? [] : deepClone(original);
                break;
            default:
                form.values[field.key] = readText(original);
        }
    }
    for (const [key, value] of Object.entries(source)) if (!consumed.has(key)) form.extras[key] = deepClone(value);
    return form;
};

const numberFromText = (text: string, original: unknown): number | string => {
    const parsed = Number(text.trim());
    if (typeof original === "string" && text.trim() === original) return original;
    return Number.isFinite(parsed) ? parsed : text.trim();
};

const listForWrite = (field: SettingFieldDef, list: string[]): string[] => uniqueStrings(field.uppercase ? list.map((entry) => entry.trim().toUpperCase()) : list);

/** The `valueJson` object the API stores. Declared fields that are blank are omitted unless they existed before. */
export const buildSettingValue = (def: SettingNamespaceDef | null, form: SettingForm): JsonObject => {
    const out: JsonObject = deepClone(form.extras);
    for (const field of def?.fields ?? []) {
        const key = form.keys[field.key] ?? field.key;
        const value = form.values[field.key];
        const original = form.originals[field.key];
        switch (field.kind) {
            case "boolean":
                if (value === true || original !== undefined) out[key] = value === true;
                break;
            case "strings": {
                const list = listForWrite(field, (value as string[]) ?? []);
                if (list.length > 0 || original !== undefined) out[key] = list;
                break;
            }
            case "stringListMap": {
                const map: JsonObject = {};
                for (const [name, list] of Object.entries((value as Record<string, string[]>) ?? {})) {
                    const clean = name.trim();
                    if (clean) map[clean] = listForWrite(field, list);
                }
                if (Object.keys(map).length > 0 || original !== undefined) out[key] = map;
                break;
            }
            case "tree":
                if (!(Array.isArray(value) && value.length === 0 && original === undefined)) out[key] = deepClone(value);
                break;
            case "integer":
            case "number":
            case "money": {
                const text = typeof value === "string" ? value : "";
                // A blank number means "removed": the key is omitted.
                if (text.trim()) out[key] = field.kind === "money" ? text.trim() : numberFromText(text, original);
                break;
            }
            default: {
                const text = typeof value === "string" ? value : "";
                if (text.trim() !== "") out[key] = text.trim();
                else if (typeof original === "string" && field.kind === "longtext") out[key] = "";
            }
        }
    }
    return out;
};

export type SettingErrorCode = "REQUIRED" | "INTEGER" | "NUMBER" | "MONEY" | "RANGE" | "OPTION" | "CURRENCY";
export type SettingError = { field: string; code: SettingErrorCode };

export const validateSettingForm = (def: SettingNamespaceDef | null, form: SettingForm): SettingError[] => {
    const errors: SettingError[] = [];
    for (const field of def?.fields ?? []) {
        const value = form.values[field.key];
        const text = typeof value === "string" ? value.trim() : "";
        const textual = ["text", "longtext", "integer", "number", "money", "select"].includes(field.kind);
        if (field.required && textual && !text) {
            errors.push({ field: field.key, code: "REQUIRED" });
            continue;
        }
        if (!text) continue;
        if (field.kind === "integer") {
            if (!/^-?\d+$/.test(text)) errors.push({ field: field.key, code: "INTEGER" });
            else if ((field.min !== undefined && Number(text) < field.min) || (field.max !== undefined && Number(text) > field.max)) errors.push({ field: field.key, code: "RANGE" });
        } else if (field.kind === "number") {
            const parsed = Number(text);
            if (!Number.isFinite(parsed)) errors.push({ field: field.key, code: "NUMBER" });
            else if ((field.min !== undefined && parsed < field.min) || (field.max !== undefined && parsed > field.max)) errors.push({ field: field.key, code: "RANGE" });
        } else if (field.kind === "money") {
            if (!MONEY_PATTERN.test(text) && !/^-\d{1,14}(\.\d{1,4})?$/.test(text)) errors.push({ field: field.key, code: "MONEY" });
        } else if (field.kind === "select" && field.options && !field.options.includes(text)) {
            // An unknown value that already exists stays editable (the select offers it); a typed-in one is rejected.
            if (form.originals[field.key] !== text) errors.push({ field: field.key, code: "OPTION" });
        } else if (field.key === "currency" && !CURRENCY_PATTERN.test(text)) {
            errors.push({ field: field.key, code: "CURRENCY" });
        }
    }
    return errors;
};

/** The options of a select: the declared ones plus the stored value when it is outside the list. */
export const selectOptions = (field: SettingFieldDef, current: unknown): string[] => {
    const options = [...(field.options ?? [])];
    if (typeof current === "string" && current && !options.includes(current)) options.push(current);
    return options;
};

export const isSettingUnchanged = (def: SettingNamespaceDef | null, form: SettingForm, original: unknown): boolean =>
    deepEqual(buildSettingValue(def, form), asObject(original));

// ---------------------------------------------------------------- read view

export type SettingSummaryRow = {
    path: string;
    label: string;
    kind: "text" | "boolean" | "list" | "empty" | "listMap";
    value: string | boolean | string[] | null;
    /** Only for `listMap`: label -> entries. */
    map?: { name: string; entries: string[] }[];
};

/** Structured read view: labelled rows for the declared fields, then every other key humanised. Never raw JSON. */
export const summarizeSetting = (key: string, value: unknown): SettingSummaryRow[] => {
    const def = resolveSettingNamespace(key);
    const source = asObject(value);
    const rows: SettingSummaryRow[] = [];
    const consumed = new Set<string>();
    for (const field of def?.fields ?? []) {
        const alias = fieldAliases(field).find((candidate) => Object.prototype.hasOwnProperty.call(source, candidate));
        if (!alias) continue;
        consumed.add(alias);
        const raw = source[alias];
        const base = { path: alias, label: field.label };
        if (field.kind === "boolean") rows.push({ ...base, kind: "boolean", value: raw === true || raw === "true" });
        else if (field.kind === "strings") {
            const list = toStringList(raw);
            rows.push(list.length ? { ...base, kind: "list", value: list } : { ...base, kind: "empty", value: null });
        } else if (field.kind === "stringListMap") {
            const map = isPlainObject(raw) ? Object.entries(raw).map(([name, list]) => ({ name, entries: toStringList(list) })) : [];
            rows.push(map.length ? { ...base, kind: "listMap", value: null, map } : { ...base, kind: "empty", value: null });
        } else if (field.kind === "tree") {
            const count = Array.isArray(raw) ? raw.length : isPlainObject(raw) ? Object.keys(raw).length : 0;
            rows.push(count ? { ...base, kind: "text", value: String(count) } : { ...base, kind: "empty", value: null });
        } else {
            const text = readText(raw);
            rows.push(text ? { ...base, kind: "text", value: text } : { ...base, kind: "empty", value: null });
        }
    }
    const rest: JsonObject = {};
    for (const [name, entry] of Object.entries(source)) if (!consumed.has(name)) rest[name] = entry;
    flattenInto(rest, [], rows);
    return rows;
};

const flattenInto = (value: unknown, prefix: string[], rows: SettingSummaryRow[]): void => {
    if (rows.length > 80) return;
    const label = prefix.map(humanizeKey).join(" · ");
    const path = prefix.join(".");
    if (isPlainObject(value)) {
        const entries = Object.entries(value);
        if (entries.length === 0 && prefix.length > 0) rows.push({ path, label, kind: "empty", value: null });
        for (const [name, entry] of entries) flattenInto(entry, [...prefix, name], rows);
    } else if (Array.isArray(value)) {
        if (value.length === 0) rows.push({ path, label, kind: "empty", value: null });
        else if (value.every((entry) => entry === null || typeof entry !== "object")) rows.push({ path, label, kind: "list", value: value.map(String) });
        else value.forEach((entry, index) => flattenInto(entry, [...prefix, String(index + 1)], rows));
    } else if (typeof value === "boolean") rows.push({ path, label, kind: "boolean", value });
    else if (value === null || value === undefined || value === "") rows.push({ path, label, kind: "empty", value: null });
    else rows.push({ path, label, kind: "text", value: String(value) });
};
