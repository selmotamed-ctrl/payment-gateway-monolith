import { resolveSettingNamespace, type SettingNamespaceDef } from "./settingsSchemas";
import type { JsonObject } from "./jsonTree";

/**
 * The human-readable catalog of platform settings.
 *
 * Every key the platform reads or records MUST have one definition here.
 * `tests/unit/platform-settings.test.ts` fails when a seeded key is missing,
 * when a field has no hint, or when a catalog string has no Arabic translation.
 *
 * Adding a setting? Follow `docs/developer/platform-settings.md` and
 * `project-design/parts/03-admin-front/05-backups-settings-and-operations.md`.
 */
export type SettingSectionId = "payments" | "merchants" | "risk" | "reporting" | "governance" | "operations" | "checkout" | "advanced";

export type SettingLifecycle = "RUNTIME" | "FALLBACK" | "DECISION" | "DEPRECATED" | "MANAGED" | "SYSTEM" | "DYNAMIC";

export type SettingDisplayStatus = SettingLifecycle | "UNCONFIGURED" | "UNREGISTERED";

export type SettingRisk = "low" | "medium" | "high" | "critical";

export type BadgeTone = "success" | "warning" | "danger" | "info" | "neutral";

export type SettingSection = {
    id: SettingSectionId;
    title: string;
    description: string;
    icon: string;
};

export type SettingDefinition = {
    /** Stable catalog id. For an exact key this is the key; for a family it is the family id. */
    id: string;
    /** Exact setting key, or the family id for `gateway.go_live.*`. */
    key: string;
    /** The typed namespace used by the editor. */
    namespaceId: string;
    section: SettingSectionId;
    lifecycle: SettingLifecycle;
    /** One-line explanation used on the row. */
    summary: string;
    /** Longer explanation used in the detail drawer. */
    description: string;
    /** Which component reads it, or why nothing reads it. */
    readBy: string;
    /** When a change takes effect, or that it has no runtime effect. */
    effect: string;
    risk: SettingRisk;
    riskReason: string;
    defaults: JsonObject;
    keywords: readonly string[];
    allowEdit: boolean;
    /** Show this definition as "Using default" when no row exists. */
    showWhenUnconfigured?: boolean;
    /** Offer this definition in the New setting picker. */
    allowCreate?: boolean;
    /** A screen that owns the value when it is managed elsewhere. */
    managePath?: string;
    guideArticleId?: string;
    legacyNote?: string;
    relatedKeys?: readonly string[];
    /** Preferred fields to show in the compact row preview. */
    cardFields?: readonly string[];
    /** A visual sub-group inside its section. */
    group?: string;
    /** True for the synthetic definition of a key that is not in the catalog. */
    unregistered?: boolean;
    /** True for the `gateway.go_live.*` family. */
    dynamicFamily?: boolean;
};

export const SETTING_SECTIONS: readonly SettingSection[] = [
    {
        id: "payments",
        title: "Payments & routing",
        description: "Route health, gateway go-live evidence and recorded collection decisions.",
        icon: "mdi-credit-card-sync-outline",
    },
    {
        id: "merchants",
        title: "Merchants & onboarding",
        description: "Join-request review, KYB evidence, refresh policy and wallet defaults.",
        icon: "mdi-storefront-outline",
    },
    {
        id: "risk",
        title: "Risk & screening",
        description: "Sanctions/PEP screening, the internal watch list and self-payment controls.",
        icon: "mdi-shield-search",
    },
    {
        id: "reporting",
        title: "Reporting & compliance",
        description: "Merchant reports, regulatory reporting identity and recorded CBL decisions.",
        icon: "mdi-file-chart-outline",
    },
    {
        id: "governance",
        title: "Governance & approvals",
        description: "Recorded emergency-ratification and checker-role decisions.",
        icon: "mdi-account-check-outline",
    },
    {
        id: "operations",
        title: "Operations & data",
        description: "Retention, business holidays and system-managed markers.",
        icon: "mdi-calendar-clock-outline",
    },
    {
        id: "checkout",
        title: "Checkout & support",
        description: "Payer-visible support channels and FAQ, managed on Checkout Help.",
        icon: "mdi-lifebuoy",
    },
    {
        id: "advanced",
        title: "Advanced & unregistered",
        description: "Keys that are not in the catalog yet. Add them to the catalog and documentation before relying on them.",
        icon: "mdi-code-braces",
    },
];

export const SETTING_SECTION_BY_ID: Record<SettingSectionId, SettingSection> = Object.fromEntries(
    SETTING_SECTIONS.map((section) => [section.id, section]),
) as Record<SettingSectionId, SettingSection>;

export const SETTING_STATUS_META: Record<SettingDisplayStatus, { label: string; tone: BadgeTone; description: string }> = {
    RUNTIME: {
        label: "Live policy",
        tone: "success",
        description: "The platform reads this key at runtime. A change takes effect as described below.",
    },
    FALLBACK: {
        label: "Legacy fallback",
        tone: "warning",
        description: "The platform reads this key only when the canonical key is missing. Prefer the canonical setting.",
    },
    DECISION: {
        label: "Recorded decision",
        tone: "info",
        description: "This is a decision-register record. The platform does not read it at runtime; changing it does not change behaviour.",
    },
    DEPRECATED: {
        label: "Retired",
        tone: "neutral",
        description: "The platform no longer reads this key. It is kept for history only.",
    },
    MANAGED: {
        label: "Managed elsewhere",
        tone: "info",
        description: "Another screen owns this value. Use the link in the drawer to edit it.",
    },
    SYSTEM: {
        label: "System-managed",
        tone: "neutral",
        description: "The deploy or a seeder writes this key. It is read-only here.",
    },
    DYNAMIC: {
        label: "Gateway evidence",
        tone: "info",
        description: "The Gateway go-live wizard creates these keys. Each gateway and aspect has its own record.",
    },
    UNCONFIGURED: {
        label: "Using default",
        tone: "warning",
        description: "No value is stored yet. The platform uses the built-in default shown in this row.",
    },
    UNREGISTERED: {
        label: "Unregistered",
        tone: "danger",
        description: "This key is not in the settings catalog. The screen cannot explain its effect until it is registered.",
    },
};

const JOIN_REQUEST_FOUR_EYES_DEFAULT: JsonObject = {
    policy: "RISK_BASED",
    ownerThresholdPercent: 25,
    description: "A second reviewer is required for a risky applicant: a high risk tier, a sanctions or PEP match, a controlling beneficial owner, an adverse media flag or a high risk business category.",
};

const ROUTE_HEALTH_DEFAULT: JsonObject = {
    enabled: true,
    mode: "ENFORCE",
    sampleBucketSeconds: 300,
    windowSeconds: 900,
    minOutcomes: 10,
    degradeErrorRate: 0.3,
    openErrorRate: 0.6,
    degradeConsecutive: 3,
    openConsecutive: 6,
    recoverDegradedProbes: 2,
    recoverOpenProbes: 3,
    openCooldownSeconds: 300,
    probeIntervalSeconds: 60,
    probeBackoffMaxSeconds: 900,
    canaryPercent: 5,
    canaryMaxAmount: null,
    degradedRecoverMinOutcomes: 10,
    degradedRecoverErrorRate: 0.1,
    overrideDefaultExpiryDays: 7,
    overrideMaxExpiryDays: 30,
    overrideReviewHours: 24,
};

const DECISION_NO_READER = "None — recorded decision only";
const DECISION_NO_EFFECT = "No runtime effect. Changing this record does not change platform behaviour.";
const DECISION_RISK = "A wrong record can mislead an operator who assumes the platform reads it. Keep it aligned with the approved decision.";

const SETTING_CATALOG: readonly SettingDefinition[] = [
    {
        id: "route_health.policy",
        key: "route_health.policy",
        namespaceId: "route_health.policy",
        section: "payments",
        lifecycle: "RUNTIME",
        summary: "Automatic route degradation, breaker and canary controls.",
        description:
            "Controls automatic route health sampling, the error rates that mark a route DEGRADED or OPEN_BREAKER, the recovery probes, degraded canary traffic and how long a manual force-healthy override may last. A wrong threshold can hide a failing rail or disable a working one.",
        readBy: "Route health worker, gateway probes and the visible-rails resolver (5 s policy cache, invalidated after a settings save).",
        effect: "New samples and routing decisions pick up the value within about five seconds. Existing attempts keep their routing.",
        risk: "high",
        riskReason: "A wrong threshold can send traffic to a failing partner or remove a healthy route from rotation.",
        defaults: ROUTE_HEALTH_DEFAULT,
        keywords: ["circuit breaker", "route", "rail", "gateway", "health", "canary", "degraded", "open breaker", "probe", "failover"],
        allowEdit: true,
        guideArticleId: "b06-10",
        cardFields: ["enabled", "mode", "windowSeconds", "canaryPercent"],
    },
    {
        id: "OD-5",
        key: "OD-5",
        namespaceId: "OD-5",
        section: "payments",
        lifecycle: "DECISION",
        summary: "Recorded recommendation for the first production gateway.",
        description: "The design's recommendation for the first production internal rail. It is a recorded decision, not the live routing switch; routing lives in Gateway Routes.",
        readBy: DECISION_NO_READER,
        effect: DECISION_NO_EFFECT,
        risk: "low",
        riskReason: DECISION_RISK,
        defaults: { gatewayCode: "neompay", kind: "INTERNAL", recommendedStage: 2, description: "NeomPay is the recommended first production internal rail." },
        keywords: ["gateway", "first production", "rollout", "neompay", "decision"],
        allowEdit: true,
    },
    {
        id: "OD-7",
        key: "OD-7",
        namespaceId: "OD-7",
        section: "payments",
        lifecycle: "DECISION",
        summary: "Recorded collection time ceilings per collection mode.",
        description: "The design's platform time-to-live ceilings for OTP pull, redirect, QR and push approval. Live limits come from each rail and flow, so changing this record does not change a payment's timeout.",
        readBy: DECISION_NO_READER,
        effect: DECISION_NO_EFFECT,
        risk: "medium",
        riskReason: DECISION_RISK,
        defaults: { otpPullSeconds: 1200, redirectSeconds: 1800, qrDisplaySeconds: 900, pushApprovalSeconds: 900, description: "Platform TTL ceilings for payment collection modes." },
        keywords: ["ttl", "timeout", "collection", "otp", "redirect", "qr", "push", "decision"],
        allowEdit: true,
    },
    {
        id: "join_request.four_eyes_policy",
        key: "join_request.four_eyes_policy",
        namespaceId: "join_request.four_eyes_policy",
        section: "merchants",
        lifecycle: "RUNTIME",
        summary: "When a join request needs a second reviewer.",
        description: "The canonical four-eyes policy for merchant onboarding. It decides whether a second reviewer is required for risky applicants, every applicant or none, and which ownership threshold and business categories make an applicant risky.",
        readBy: "Join-request review and onboarding readiness (`api/internal/merchant.ts`, `lib/joinRequestOnboarding.ts`). The legacy OD-2 key is read only when this key is missing.",
        effect: "Applies to the next join-request review. Existing approvals keep the decision they were reviewed under.",
        risk: "high",
        riskReason: "A weak policy can let a risky merchant onboard without a second pair of eyes.",
        defaults: JOIN_REQUEST_FOUR_EYES_DEFAULT,
        keywords: ["four eyes", "second reviewer", "join request", "onboarding", "beneficial owner", "high risk", "risk based"],
        allowEdit: true,
        relatedKeys: ["OD-2", "OD-6"],
        guideArticleId: "b04-01",
    },
    {
        id: "OD-2",
        key: "OD-2",
        namespaceId: "OD-2",
        section: "merchants",
        lifecycle: "FALLBACK",
        summary: "Legacy fallback for the join-request four-eyes policy.",
        description: "The older decision-register key for the join-request four-eyes policy. The platform reads join_request.four_eyes_policy first and uses OD-2 only when the canonical key is missing.",
        readBy: "Join-request review, only as a fallback when join_request.four_eyes_policy is absent.",
        effect: "Editing this key has no effect while the canonical join_request.four_eyes_policy exists.",
        risk: "high",
        riskReason: "An operator may edit the fallback and believe the live policy changed.",
        defaults: { policy: "RISK_BASED", description: "Join request four-eyes decisions are selected by risk assessment." },
        keywords: ["legacy", "four eyes", "join request", "fallback", "OD-2"],
        allowEdit: true,
        legacyNote: "The canonical key is join_request.four_eyes_policy. Edit that key instead.",
        relatedKeys: ["join_request.four_eyes_policy"],
    },
    {
        id: "OD-6",
        key: "OD-6",
        namespaceId: "OD-6",
        section: "merchants",
        lifecycle: "DECISION",
        summary: "Recorded beneficial-owner threshold decision.",
        description: "The design's ownership percentage for capturing a beneficial owner. The live threshold is the ownerThresholdPercent field in join_request.four_eyes_policy.",
        readBy: DECISION_NO_READER,
        effect: DECISION_NO_EFFECT,
        risk: "medium",
        riskReason: DECISION_RISK,
        defaults: { ownerThresholdPercent: 25, description: "Beneficial owners at or above twenty-five percent are captured." },
        keywords: ["beneficial owner", "ownership", "threshold", "25%", "decision"],
        allowEdit: true,
        relatedKeys: ["join_request.four_eyes_policy"],
    },
    {
        id: "join_request.volume_threshold",
        key: "join_request.volume_threshold",
        namespaceId: "join_request.volume_threshold",
        section: "merchants",
        lifecycle: "RUNTIME",
        summary: "Expected monthly volume that forces a second reviewer.",
        description: "An applicant whose expected monthly volume is above this amount is treated as risky and needs a second reviewer.",
        readBy: "Join-request review (`api/internal/merchant.ts`).",
        effect: "Applies to the next join-request review.",
        risk: "medium",
        riskReason: "A threshold that is too high can let a high-volume applicant onboard with one reviewer.",
        defaults: { amount: 250000, currency: "LYD", description: "An expected monthly volume above this amount forces a second reviewer." },
        keywords: ["volume", "monthly", "threshold", "join request", "second reviewer"],
        allowEdit: true,
    },
    {
        id: "onboarding.required_documents",
        key: "onboarding.required_documents",
        namespaceId: "onboarding.required_documents",
        section: "merchants",
        lifecycle: "RUNTIME",
        summary: "Default KYB documents and per-category replacements.",
        description: "The documents an applicant must provide. A category entry replaces the default list for that business category.",
        readBy: "KYB readiness, join-request onboarding and the synthetic seeder.",
        effect: "Applies when readiness is next calculated. Existing documents are not deleted.",
        risk: "medium",
        riskReason: "A missing document requirement can weaken KYB evidence; an extra one can block onboarding.",
        defaults: {
            default: ["COMMERCIAL_REGISTRY", "TAX_CERTIFICATE", "BANK_LETTER", "PROOF_OF_ADDRESS"],
            byCategory: {
                CRYPTO: ["COMMERCIAL_REGISTRY", "TAX_CERTIFICATE", "BANK_LETTER", "PROOF_OF_ADDRESS", "SECTOR_LICENSE"],
                GAMBLING: ["COMMERCIAL_REGISTRY", "TAX_CERTIFICATE", "BANK_LETTER", "PROOF_OF_ADDRESS", "SECTOR_LICENSE"],
                MONEY_TRANSMISSION: ["COMMERCIAL_REGISTRY", "TAX_CERTIFICATE", "BANK_LETTER", "PROOF_OF_ADDRESS", "SECTOR_LICENSE"],
                ARMS: ["COMMERCIAL_REGISTRY", "TAX_CERTIFICATE", "BANK_LETTER", "PROOF_OF_ADDRESS", "SECTOR_LICENSE"],
            },
            description: "Required KYB evidence; a category entry replaces the default list.",
        },
        keywords: ["kyb", "documents", "evidence", "onboarding", "commercial registry", "tax certificate", "sector license"],
        allowEdit: true,
    },
    {
        id: "kyb.refresh_policy",
        key: "kyb.refresh_policy",
        namespaceId: "kyb.refresh_policy",
        section: "merchants",
        lifecycle: "RUNTIME",
        summary: "Periodic KYB re-verification and expiry handling.",
        description: "Sets the re-verification cadence for high, standard and low risk merchants, the expiry grace period, when a revalidation request is opened, and how many duplicate document reuses trigger an AML review.",
        readBy: "KYB review scheduling, the KYB expiry worker and governance checks.",
        effect: "The next review date is recalculated when a merchant's risk tier or review date is next written.",
        risk: "medium",
        riskReason: "A cadence that is too long leaves stale KYB evidence; one that is too short creates unnecessary reviews.",
        defaults: { highMonths: 12, standardMonths: 24, lowMonths: 36, expiryGraceDays: 30, revalidationDueDays: 30, duplicateAmlThreshold: 3, description: "Periodic KYB re-verification cadence, expiry grace and duplicate-reuse AML threshold." },
        keywords: ["kyb", "refresh", "re-verification", "expiry", "risk tier", "duplicate", "aml"],
        allowEdit: true,
    },
    {
        id: "OD-8",
        key: "OD-8",
        namespaceId: "OD-8",
        section: "merchants",
        lifecycle: "DECISION",
        summary: "Recorded default overdraft allowance for a new wallet.",
        description: "The design's default negative balance ceiling. Each merchant's live limit is its own negativeBalanceCeiling field on the merchant record.",
        readBy: DECISION_NO_READER,
        effect: DECISION_NO_EFFECT,
        risk: "medium",
        riskReason: DECISION_RISK,
        defaults: { negativeBalanceCeiling: "0.0000", currency: "LYD", description: "New merchants have no negative wallet balance allowance by default." },
        keywords: ["negative balance", "overdraft", "wallet", "ceiling", "decision"],
        allowEdit: true,
    },
    {
        id: "screening.watchlist",
        key: "screening.watchlist",
        namespaceId: "screening.watchlist",
        section: "risk",
        lifecycle: "RUNTIME",
        summary: "Internal watch list used by payment screening.",
        description: "The internal list of people and entities screened on the payment hot path. A published revision must carry a new version so cached screening results are invalidated.",
        readBy: "Attempt guard screening; publishing a list invalidates cached results.",
        effect: "Applies to the next payment admission after the save; cached results are invalidated by a new version.",
        risk: "high",
        riskReason: "A stale or malformed list can miss a match or create false positives on every payment.",
        defaults: { version: "internal-v1", entries: [], description: "The internal watch list the transaction hot path screens against." },
        keywords: ["sanctions", "pep", "watchlist", "watch list", "screening", "match", "internal list"],
        allowEdit: true,
        cardFields: ["version", "entries"],
    },
    {
        id: "screening.fail_closed",
        key: "screening.fail_closed",
        namespaceId: "screening.fail_closed",
        section: "risk",
        lifecycle: "RUNTIME",
        summary: "Block payments when screening is unavailable.",
        description: "When on, a screening error blocks the payment. Turning it off lets the payment continue and records the screening result as unknown; use it only as a documented emergency measure.",
        readBy: "Attempt guard pipeline on every payment admission.",
        effect: "Applies to new attempts immediately; in-flight attempts keep the decision they started with.",
        risk: "high",
        riskReason: "Turning it off can let a payment proceed without a sanctions/PEP result.",
        defaults: { failClosed: true },
        keywords: ["screening", "fail closed", "fail open", "sanctions", "pep", "outage", "unavailable"],
        allowEdit: true,
        showWhenUnconfigured: true,
        allowCreate: true,
    },
    {
        id: "SELF_PAYMENT_POLICY",
        key: "SELF_PAYMENT_POLICY",
        namespaceId: "SELF_PAYMENT_POLICY",
        section: "risk",
        lifecycle: "RUNTIME",
        summary: "Prevent a merchant from paying into its own wallet.",
        description: "Controls whether a merchant may use its own wallet or GL account as the payer on its payment link. BLOCK is the safe default; ALLOW is for documented exceptions only.",
        readBy: "Attempt guard pipeline on payment admission.",
        effect: "Applies to new attempts immediately.",
        risk: "high",
        riskReason: "Allowing self-payments can be used to manufacture volume or move money without a real payer.",
        defaults: { policy: "BLOCK" },
        keywords: ["self payment", "self dealing", "own wallet", "merchant", "abuse", "policy"],
        allowEdit: true,
        showWhenUnconfigured: true,
        allowCreate: true,
    },
    {
        id: "OD-3",
        key: "OD-3",
        namespaceId: "OD-3",
        section: "risk",
        lifecycle: "DECISION",
        summary: "Recorded screening provider decision.",
        description: "The design's screening provider and adapter record. The active adapter is deployment/code configuration, not this key.",
        readBy: DECISION_NO_READER,
        effect: DECISION_NO_EFFECT,
        risk: "medium",
        riskReason: DECISION_RISK,
        defaults: { provider: "INTERNAL_WATCHLIST", adapters: ["internal-watchlist", "mock-sandbox"], description: "Screening is provider-driven and ships with internal and sandbox adapters." },
        keywords: ["screening", "provider", "adapter", "sanctions", "pep", "decision"],
        allowEdit: true,
    },
    {
        id: "merchant_reports.policy",
        key: "merchant_reports.policy",
        namespaceId: "merchant_reports.policy",
        section: "reporting",
        lifecycle: "RUNTIME",
        summary: "Enable the merchant report Studio and asset bundles.",
        description: "A platform-wide switch for the merchant report runner/Studio and for merchant report asset .zip bundles. Turning it off blocks every merchant immediately.",
        readBy: "Merchant report runner and Studio (5 s cache, invalidated after a settings save).",
        effect: "Within about five seconds for new requests.",
        risk: "medium",
        riskReason: "Disabling reporting can interrupt a merchant's month-end process; enabling assets allows uploads.",
        defaults: { enabled: true, assetsEnabled: true, description: "Merchant report authoring and execution are enabled; merchant asset bundles are allowed up to the 2 MB limit." },
        keywords: ["merchant reports", "studio", "report runner", "assets", "zip", "policy"],
        allowEdit: true,
        guideArticleId: "b03-15",
    },
    {
        id: "goaml.rentity_id",
        key: "goaml.rentity_id",
        namespaceId: "goaml.rentity_id",
        section: "reporting",
        lifecycle: "RUNTIME",
        summary: "Reporting entity ID used in goAML XML.",
        description: "The reporting entity identifier in generated goAML XML. The seeded value is a provisional placeholder until the CBL/FIU confirms the real identity.",
        readBy: "Regulatory report XML generation (`CanonicalReportContext`).",
        effect: "Applies to the next generated report; existing outputs are not rewritten.",
        risk: "medium",
        riskReason: "A wrong identity makes a regulatory filing invalid.",
        defaults: { value: "PROVISIONAL-CBL-RENTITY" },
        keywords: ["goaml", "fiu", "cbl", "reporting entity", "regulatory", "xml", "filing"],
        allowEdit: true,
        showWhenUnconfigured: true,
        allowCreate: true,
        group: "goAML filing identity",
    },
    {
        id: "goaml.rentity_branch",
        key: "goaml.rentity_branch",
        namespaceId: "goaml.rentity_branch",
        section: "reporting",
        lifecycle: "RUNTIME",
        summary: "Reporting branch code used in goAML XML.",
        description: "The branch or office code for the reporting entity in generated goAML XML.",
        readBy: "Regulatory report XML generation (`CanonicalReportContext`).",
        effect: "Applies to the next generated report.",
        risk: "medium",
        riskReason: "A wrong branch code makes a regulatory filing invalid.",
        defaults: { value: "PROVISIONAL" },
        keywords: ["goaml", "branch", "office", "regulatory", "xml", "filing"],
        allowEdit: true,
        showWhenUnconfigured: true,
        allowCreate: true,
        group: "goAML filing identity",
    },
    {
        id: "goaml.submission_code",
        key: "goaml.submission_code",
        namespaceId: "goaml.submission_code",
        section: "reporting",
        lifecycle: "RUNTIME",
        summary: "goAML submission type code.",
        description: "The goAML submission code used in generated XML, usually E for an electronic report.",
        readBy: "Regulatory report XML generation (`CanonicalReportContext`).",
        effect: "Applies to the next generated report.",
        risk: "medium",
        riskReason: "A wrong submission code makes a regulatory filing invalid.",
        defaults: { value: "E" },
        keywords: ["goaml", "submission", "code", "electronic", "regulatory", "xml"],
        allowEdit: true,
        showWhenUnconfigured: true,
        allowCreate: true,
        group: "goAML filing identity",
    },
    {
        id: "goaml.local_currency_code",
        key: "goaml.local_currency_code",
        namespaceId: "goaml.local_currency_code",
        section: "reporting",
        lifecycle: "RUNTIME",
        summary: "Local currency code used in goAML XML.",
        description: "The three-letter local currency code used in generated goAML XML.",
        readBy: "Regulatory report XML generation (`CanonicalReportContext`).",
        effect: "Applies to the next generated report.",
        risk: "medium",
        riskReason: "A wrong currency code makes a regulatory filing invalid.",
        defaults: { value: "LYD" },
        keywords: ["goaml", "currency", "lyd", "regulatory", "xml"],
        allowEdit: true,
        showWhenUnconfigured: true,
        allowCreate: true,
        group: "goAML filing identity",
    },
    {
        id: "goaml.reporting_person_name",
        key: "goaml.reporting_person_name",
        namespaceId: "goaml.reporting_person_name",
        section: "reporting",
        lifecycle: "RUNTIME",
        summary: "Name of the person submitting goAML reports.",
        description: "The reporting person's name in generated goAML XML.",
        readBy: "Regulatory report XML generation (`CanonicalReportContext`).",
        effect: "Applies to the next generated report.",
        risk: "medium",
        riskReason: "A wrong reporting person makes a regulatory filing incomplete.",
        defaults: { value: "Compliance Officer" },
        keywords: ["goaml", "reporting person", "name", "compliance", "regulatory", "xml"],
        allowEdit: true,
        showWhenUnconfigured: true,
        allowCreate: true,
        group: "goAML filing identity",
    },
    {
        id: "goaml.reporting_person_email",
        key: "goaml.reporting_person_email",
        namespaceId: "goaml.reporting_person_email",
        section: "reporting",
        lifecycle: "RUNTIME",
        summary: "Email of the person submitting goAML reports.",
        description: "The reporting person's email in generated goAML XML.",
        readBy: "Regulatory report XML generation (`CanonicalReportContext`).",
        effect: "Applies to the next generated report.",
        risk: "medium",
        riskReason: "A wrong email makes a regulatory filing incomplete.",
        defaults: { value: "compliance@payment-gateway.internal" },
        keywords: ["goaml", "reporting person", "email", "compliance", "regulatory", "xml"],
        allowEdit: true,
        showWhenUnconfigured: true,
        allowCreate: true,
        group: "goAML filing identity",
    },
    {
        id: "OD-1",
        key: "OD-1",
        namespaceId: "OD-1",
        section: "reporting",
        lifecycle: "DECISION",
        summary: "Recorded CBL reporting-threshold decision.",
        description: "The decision register records whether the CBL reporting thresholds are provisional or confirmed. Each reporting rule carries its own mode and schema, so this key does not unblock filing by itself.",
        readBy: DECISION_NO_READER,
        effect: DECISION_NO_EFFECT,
        risk: "medium",
        riskReason: DECISION_RISK,
        defaults: { mode: "PROVISIONAL", internalOnly: true, description: "CBL reporting thresholds remain provisional until written instructions are recorded." },
        keywords: ["cbl", "regulatory", "threshold", "provisional", "confirmed", "decision"],
        allowEdit: true,
    },
    {
        id: "OD-9",
        key: "OD-9",
        namespaceId: "OD-9",
        section: "governance",
        lifecycle: "DECISION",
        summary: "Recorded emergency-suspension ratification policy.",
        description: "The decision register records who must ratify an emergency suspension and the window. The Deadline worker uses the approved automation policy; this key is the recorded decision.",
        readBy: DECISION_NO_READER,
        effect: DECISION_NO_EFFECT,
        risk: "medium",
        riskReason: DECISION_RISK,
        defaults: { ratificationWindowHours: 24, authorizedRoles: ["MLRO", "COMPLIANCE"], description: "Emergency suspensions require ratification by MLRO or a second compliance officer." },
        keywords: ["emergency", "suspension", "ratification", "mlro", "compliance", "decision"],
        allowEdit: true,
    },
    {
        id: "OD-11",
        key: "OD-11",
        namespaceId: "OD-11",
        section: "governance",
        lifecycle: "DECISION",
        summary: "Recorded checker-role decision.",
        description: "The decision register records which roles are provisioned as named checker accounts. Actual users, roles and authorities are managed in Admin Users.",
        readBy: DECISION_NO_READER,
        effect: DECISION_NO_EFFECT,
        risk: "low",
        riskReason: DECISION_RISK,
        defaults: { checkerRoles: ["MLRO", "COMPLIANCE", "FINANCE"], description: "Named organizational checker accounts are provisioned without embedded credentials." },
        keywords: ["checker", "maker checker", "roles", "mlro", "compliance", "finance", "decision"],
        allowEdit: true,
    },
    {
        id: "OD-10",
        key: "OD-10",
        namespaceId: "OD-10",
        section: "governance",
        lifecycle: "DEPRECATED",
        summary: "Retired sandbox-before-approval decision.",
        description: "The v38 execution-plane change removed this switch. Sandbox is a separate plane and database; the Live plane refuses non-ACTIVE merchants. The key is kept for history.",
        readBy: "None — retired",
        effect: "No runtime effect. Do not change it.",
        risk: "low",
        riskReason: "Editing a retired key wastes time and can mislead an operator into thinking sandbox access changed.",
        defaults: { sandboxBeforeApproval: false },
        keywords: ["sandbox", "retired", "deprecated", "pending merchant", "OD-10"],
        allowEdit: false,
        legacyNote: "Retired in v38. Sandbox is a separate execution plane.",
    },
    {
        id: "OD-4",
        key: "OD-4",
        namespaceId: "OD-4",
        section: "operations",
        lifecycle: "RUNTIME",
        summary: "Record retention period used by the retention worker.",
        description: "The retention worker (disabled by default) reads this key to decide how long KYB and related records are kept. Enabling the worker can delete evidence older than this period.",
        readBy: "Retention worker (`RetentionWorker`); the worker is disabled unless `WORKER_RETENTION_ENABLED=true`.",
        effect: "The next retention run. A shorter period can delete evidence on that run.",
        risk: "high",
        riskReason: "A short retention period can permanently delete audit and KYB evidence.",
        defaults: { kybYears: 5, description: "KYB and related records are retained for five years by default." },
        keywords: ["retention", "evidence", "kyb", "delete", "purge", "five years"],
        allowEdit: true,
        guideArticleId: "b12-06",
    },
    {
        id: "calendar.holidays",
        key: "calendar.holidays",
        namespaceId: "calendar.holidays",
        section: "operations",
        lifecycle: "RUNTIME",
        summary: "Public holidays that pause business-hour SLA clocks.",
        description: "Business-hour deadlines for cash-outs, cases and disputes skip these dates. Weekends are Sunday to Thursday by default; this key only adds public holidays.",
        readBy: "Deadline worker business-time calculation (`DeadlineWorker`, `businessTime.ts`).",
        effect: "The next deadline tick (about every five minutes).",
        risk: "medium",
        riskReason: "Wrong dates distort SLA clocks and can hide a late cash-out or case.",
        defaults: { holidays: [] },
        keywords: ["holidays", "calendar", "business days", "sla", "deadline", "cashout", "tripoli"],
        allowEdit: true,
        showWhenUnconfigured: true,
        allowCreate: true,
    },
    {
        id: "server.environment_mode",
        key: "server.environment_mode",
        namespaceId: "server.environment_mode",
        section: "operations",
        lifecycle: "SYSTEM",
        summary: "System-managed Fake Rails environment marker.",
        description: "Written by the Fake Rails seed to mark a test environment. It is not an operator control and should not be edited.",
        readBy: "Fake Rails seeding and environment guard.",
        effect: "Immediate; changing it can break the test integration.",
        risk: "low",
        riskReason: "Editing a system marker can confuse the environment guard.",
        defaults: { mode: "TEST_SANDBOX" },
        keywords: ["environment", "fake rails", "test", "system", "sandbox"],
        allowEdit: false,
    },
    {
        id: "checkout.support_config",
        key: "checkout.support_config",
        namespaceId: "checkout.support_config",
        section: "checkout",
        lifecycle: "MANAGED",
        summary: "Payer support channels, working hours and FAQ.",
        description: "The checkout help center's contact block, working hours and bilingual FAQ. It is edited on the Checkout Help screen, not here.",
        readBy: "Checkout help center (`api/internal/checkout.ts` projection).",
        effect: "The next help-center fetch, immediately for new payer sessions.",
        risk: "medium",
        riskReason: "Wrong support details send a payer to a dead phone number or email address.",
        defaults: {
            enabled: true,
            show_platform_contact: true,
            show_merchant_contact: true,
            support_phone: "",
            support_whatsapp: "",
            support_email: "",
            working_hours_en: "",
            working_hours_ar: "",
            faq_items: [],
        },
        keywords: ["checkout", "support", "help", "faq", "phone", "whatsapp", "email", "working hours"],
        allowEdit: false,
        managePath: "/settings/checkout-help",
        guideArticleId: "b07-10",
    },
];

const CATALOG_BY_KEY = new Map(SETTING_CATALOG.map((definition) => [definition.key, definition]));

export const GO_LIVE_DEFINITION: SettingDefinition = {
    id: "gateway.go_live.*",
    key: "gateway.go_live.*",
    namespaceId: "gateway.go_live.*",
    section: "payments",
    lifecycle: "DYNAMIC",
    summary: "Operator-provided go-live evidence for one gateway aspect.",
    description:
        "The Gateway go-live gate reads these keys as evidence for canary traffic, route alerts, runbooks, PCI scope and executive acceptance. Each gateway and aspect is a separate key; the wizard creates them.",
    readBy: "Gateway go-live evidence gate (`api/internal/admin.ts`).",
    effect: "The next go-live evidence check.",
    risk: "medium",
    riskReason: "Missing or stale evidence can block a gateway go-live or let an unprepared gateway through.",
    defaults: {},
    keywords: ["gateway", "go live", "canary", "route alerts", "runbook", "pci", "executive acceptance"],
    allowEdit: true,
    group: "Gateway go-live evidence",
    dynamicFamily: true,
};

export const UNREGISTERED_DEFINITION: SettingDefinition = {
    id: "unregistered",
    key: "unregistered",
    namespaceId: "unregistered",
    section: "advanced",
    lifecycle: "DYNAMIC",
    summary: "A setting key that is not in the catalog.",
    description:
        "This key exists in the database but the screen has no description, reader or field hints for it. Add it to the settings catalog and the developer documentation before relying on it.",
    readBy: "Unknown — the key is not registered.",
    effect: "Unknown. The platform may not read this key at all.",
    risk: "high",
    riskReason: "An unregistered key has no known effect and may be silently ignored.",
    defaults: {},
    keywords: ["advanced", "unregistered", "unknown"],
    allowEdit: true,
    unregistered: true,
};

/** The definitions that can be created from the New setting picker. */
export const CREATABLE_SETTING_DEFINITIONS: readonly SettingDefinition[] = SETTING_CATALOG.filter(
    (definition) => definition.allowCreate === true || definition.showWhenUnconfigured === true,
);

export const settingCatalogDefinitions = (): readonly SettingDefinition[] => SETTING_CATALOG;

export const resolveSettingDefinition = (key: string): SettingDefinition => {
    const exact = CATALOG_BY_KEY.get(key);
    if (exact) return exact;
    if (key.startsWith("gateway.go_live.")) {
        const namespace = resolveSettingNamespace(key);
        return {
            ...GO_LIVE_DEFINITION,
            id: key,
            key,
            namespaceId: key,
            summary: GO_LIVE_DEFINITION.summary,
            description: namespace?.description ?? GO_LIVE_DEFINITION.description,
        };
    }
    return {
        ...UNREGISTERED_DEFINITION,
        id: key,
        key,
        namespaceId: key,
        summary: "Unregistered setting key.",
        description: `The key ${key} is not in the settings catalog. The screen cannot explain its effect until it is registered in admin-front/src/components/builders/model/settingsCatalog.ts and documented.`,
    };
};

export const settingNamespaceFor = (definition: SettingDefinition): SettingNamespaceDef | null =>
    resolveSettingNamespace(definition.namespaceId);
