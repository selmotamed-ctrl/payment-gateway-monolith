import { urlsMap } from "@/constants/urlsMap";
import type { FilterOption, TableFilter, TableServerConfig } from "./filters";
import { createOptionsLoader } from "./referenceOptions";
import { rowTone, statusTone } from "./statusTone";

export type { TableServerConfig };

const options = (values: string[]): FilterOption[] =>
    values.map((value) => ({ title: value.replaceAll("_", " "), value, tone: statusTone(value) }));

const merchants = createOptionsLoader("merchants");
const rails = createOptionsLoader("rails");
const gateways = createOptionsLoader("gateways");
const users = createOptionsLoader("users");
const wallets = createOptionsLoader("wallets");

const GATEWAY_STATUS = ["DRAFT", "SANDBOX_VERIFIED", "PENDING_APPROVAL", "LIVE", "SUSPENDED", "RETIRED"];
const MERCHANT_STATUS = ["PENDING", "ACTIVE", "SUSPENDED", "REJECTED", "CLOSED"];
const KYB_STATUS = ["UNVERIFIED", "PENDING", "VERIFIED", "REJECTED"];
const RISK_TIER = ["LOW", "STANDARD", "HIGH"];
const COLLECTION_MODES = ["OTP_PULL", "REDIRECT", "EMBEDDED", "PUSH_APPROVAL", "QR_DISPLAY", "PAY_CODE", "DEEP_LINK", "MANUAL", "HYBRID"];
const JOIN_STATUS = ["DRAFT", "SUBMITTED", "IN_REVIEW", "INFO_REQUESTED", "PENDING_CHECKER", "APPROVED", "REJECTED", "WITHDRAWN", "EXPIRED"];
const APPROVAL_STATE = ["DRAFT", "PENDING_REVIEW", "APPROVED", "EXECUTED", "REJECTED"];
const AML_CASE_STATUS = ["OPEN", "IN_REVIEW", "PENDING_CHECKER", "RELEASED", "REJECTED_VOID", "FROZEN", "ESCALATED_STR"];
const AML_SEVERITY = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
const SCREENING_RESULT = ["CLEAR", "POTENTIAL_MATCH", "CONFIRMED_MATCH", "ERROR"];
const DISPUTE_STATUS = ["OPENED", "EVIDENCE_REQUESTED", "EVIDENCE_SUBMITTED", "WON", "LOST", "EXPIRED", "WITHDRAWN"];
const ADJUSTMENT_STATE = ["DRAFT", "PENDING_REVIEW", "APPROVED", "EXECUTING", "EXECUTED", "REJECTED"];
const ADJUSTMENT_TYPE = ["CHARGEBACK", "REFUND", "MANUAL_CREDIT", "MANUAL_DEBIT", "CORRECTION", "CASHOUT_SUBTRACTION"];
const CASHOUT_STATE = ["PENDING", "REJECTED", "PROCESSING", "COMPLETE", "SUBTRACTED"];
const OPERATOR_STATE = ["OPEN", "IN_PROGRESS", "PENDING_CHECKER", "RESOLVED"];
const OPERATOR_KIND = ["UNKNOWN", "HELD", "CONFLICT", "MISMATCH", "LATE_SUCCESS", "MANUAL_REVIEW", "UNMATCHED_STATEMENT"];
const REPORT_TYPE = ["LARGE_TRANSACTION", "SUSPICIOUS_ACTIVITY", "PERIODIC_RETURN"];
const REPORT_STATUS = ["DRAFT", "PENDING_CHECKER", "APPROVED", "SUBMITTED", "ACKNOWLEDGED", "REJECTED_BY_AUTHORITY"];
const RULE_TYPES = ["SINGLE_AMOUNT", "CUMULATIVE_WINDOW", "STRUCTURING", "RISK_TIER", "COUNTERPARTY_COUNTRY", "RAIL", "MERCHANT_DIRECT_AMOUNT"];
const RULE_ACTIONS = ["HOLD", "FLAG", "BLOCK", "CASE_ONLY"];
const ROUTE_STATUS = ["ACTIVE", "PAUSED", "DRAINING"];
const ROUTE_HEALTH = ["HEALTHY", "DEGRADED", "DOWN"];
const CREDENTIAL_POLICY = ["PLATFORM", "MERCHANT_REQUIRED", "MERCHANT_OR_PLATFORM"];

export const tableRegistry: Record<string, TableServerConfig> = {
    Gateways: {
        url: urlsMap.gatewaysList,
        listKey: "gateways",
        filters: [
            { key: "country", label: "Country", type: "text", placeholder: "e.g. LY" },
            { key: "kind", label: "Kind", type: "data-autocomplete", options: options(["DIRECT", "AGGREGATOR", "NATIVE_ADAPTER", "INTERNAL"]) },
            { key: "verificationState", label: "Verification", type: "data-autocomplete", options: options(["VERIFIED", "UNVERIFIED"]) },
            { key: "status", label: "Status", type: "data-autocomplete", options: options(GATEWAY_STATUS), multiple: true },
            { key: "riskClass", label: "Risk class", type: "data-autocomplete", options: options(["NORMAL", "HIGH_RISK"]) },
            { key: "date", label: "Created", type: "date" },
        ],
        defaultSort: { key: "code", direction: "asc" },
    },
    Rails: {
        url: urlsMap.railsList,
        listKey: "rails",
        filters: [
            { key: "collectionMode", label: "Type", type: "data-autocomplete", options: options(COLLECTION_MODES) },
            { key: "currency", label: "Currency", type: "text", placeholder: "LYD" },
            { key: "blocked", label: "Status", type: "boolean", trueLabel: "Blocked", falseLabel: "Active" },
            { key: "amount", label: "Minimum amount", type: "number-range" },
            { key: "date", label: "Created", type: "date" },
        ],
        defaultSort: { key: "code", direction: "asc" },
    },
    GatewayRoutes: {
        url: urlsMap.routesList,
        listKey: "routes",
        filters: [
            { key: "railId", label: "Rail", type: "api-autocomplete", load: rails },
            { key: "gatewayId", label: "Gateway", type: "api-autocomplete", load: gateways },
            { key: "credentialPolicy", label: "Credential policy", type: "data-autocomplete", options: options(CREDENTIAL_POLICY) },
            { key: "status", label: "Status", type: "data-autocomplete", options: options(ROUTE_STATUS), multiple: true },
            { key: "healthState", label: "Health", type: "data-autocomplete", options: options(ROUTE_HEALTH) },
            { key: "amount", label: "Minimum amount", type: "number-range" },
        ],
        defaultSort: { key: "priority", direction: "asc" },
    },
    Merchants: {
        url: urlsMap.merchantsList,
        listKey: "merchants",
        filters: [
            { key: "status", label: "Status", type: "data-autocomplete", options: options(MERCHANT_STATUS), multiple: true },
            { key: "kybStatus", label: "KYB", type: "data-autocomplete", options: options(KYB_STATUS) },
            { key: "riskTier", label: "Risk tier", type: "data-autocomplete", options: options(RISK_TIER) },
            { key: "from", label: "Created", type: "date", queryFrom: "from", queryTo: "to" },
        ],
        defaultSort: { key: "createdAt", direction: "desc" },
    },
    JoinRequests: {
        url: urlsMap.joinRequestsList,
        listKey: "joinRequests",
        filters: [
            { key: "status", label: "Status", type: "data-autocomplete", options: options(JOIN_STATUS), multiple: true },
            { key: "riskTier", label: "Risk tier", type: "data-autocomplete", options: options(RISK_TIER), query: "proposedRiskTier" },
            { key: "merchantId", label: "Merchant", type: "api-autocomplete", load: merchants },
            { key: "reviewer", label: "Reviewer", type: "api-autocomplete", load: users, query: "assignedReviewerId" },
            { key: "submitted", label: "Submitted", type: "date", queryFrom: "from", queryTo: "to" },
            { key: "sla", label: "SLA due", type: "date", queryFrom: "dateFrom", queryTo: "dateTo" },
        ],
        defaultSort: { key: "submittedAt", direction: "desc" },
    },
    KybReview: {
        url: urlsMap.joinRequestsList,
        listKey: "joinRequests",
        filters: [
            { key: "merchantId", label: "Merchant", type: "api-autocomplete", load: merchants },
            { key: "status", label: "Status", type: "data-autocomplete", options: options(JOIN_STATUS), multiple: true },
            { key: "from", label: "Submitted", type: "date", queryFrom: "from", queryTo: "to" },
        ],
        defaultSort: { key: "submittedAt", direction: "desc" },
    },
    Approvals: {
        url: urlsMap.approvalsList,
        listKey: "approvals",
        filters: [
            { key: "state", label: "State", type: "data-autocomplete", options: options(APPROVAL_STATE), multiple: true },
            { key: "subjectType", label: "Subject", type: "text" },
            { key: "makerUserId", label: "Maker", type: "api-autocomplete", load: users },
            { key: "checkerUserId", label: "Checker", type: "api-autocomplete", load: users },
            { key: "from", label: "Created", type: "date", queryFrom: "from", queryTo: "to" },
        ],
        defaultSort: { key: "createdAt", direction: "desc" },
    },
    AmlCases: {
        url: urlsMap.amlCases,
        listKey: "cases",
        filters: [
            { key: "status", label: "Status", type: "data-autocomplete", options: options(AML_CASE_STATUS), multiple: true },
            { key: "severity", label: "Severity", type: "data-autocomplete", options: options(AML_SEVERITY) },
            { key: "subjectType", label: "Subject", type: "text" },
            { key: "from", label: "Opened", type: "date", queryFrom: "from", queryTo: "to" },
            { key: "sla", label: "SLA due", type: "date", queryFrom: "dateFrom", queryTo: "dateTo" },
        ],
        defaultSort: { key: "openedAt", direction: "desc" },
    },
    AmlScreenings: {
        url: urlsMap.amlScreenings,
        listKey: "screenings",
        filters: [
            { key: "result", label: "Result", type: "data-autocomplete", options: options(SCREENING_RESULT), multiple: true },
            { key: "subjectType", label: "Subject", type: "text" },
            { key: "providerCode", label: "Provider", type: "text" },
            { key: "score", label: "Score", type: "number-range" },
            { key: "from", label: "Screened", type: "date", queryFrom: "from", queryTo: "to" },
        ],
        defaultSort: { key: "screenedAt", direction: "desc" },
    },
    AmlRules: {
        url: urlsMap.amlRules,
        listKey: "rules",
        filters: [
            { key: "ruleType", label: "Type", type: "data-autocomplete", options: options(RULE_TYPES) },
            { key: "action", label: "Action", type: "data-autocomplete", options: options(RULE_ACTIONS) },
            { key: "baseSeverity", label: "Severity", type: "data-autocomplete", options: options(AML_SEVERITY) },
            { key: "active", label: "Active", type: "boolean" },
            { key: "from", label: "Effective from", type: "date", queryFrom: "from", queryTo: "to" },
        ],
        defaultSort: { key: "code", direction: "asc" },
    },
    AmlReports: {
        url: urlsMap.amlReports,
        listKey: "reports",
        filters: [
            { key: "reportType", label: "Type", type: "data-autocomplete", options: options(REPORT_TYPE) },
            { key: "authority", label: "Authority", type: "text" },
            { key: "status", label: "Status", type: "data-autocomplete", options: options(REPORT_STATUS), multiple: true },
            { key: "from", label: "Created", type: "date", queryFrom: "from", queryTo: "to" },
            { key: "submitted", label: "Submitted", type: "date", queryFrom: "dateFrom", queryTo: "dateTo" },
        ],
        defaultSort: { key: "createdAt", direction: "desc" },
    },
    Adjustments: {
        url: urlsMap.adjustmentsList,
        listKey: "adjustments",
        filters: [
            { key: "type", label: "Type", type: "data-autocomplete", options: options(ADJUSTMENT_TYPE) },
            { key: "state", label: "State", type: "data-autocomplete", options: options(ADJUSTMENT_STATE), multiple: true },
            { key: "amount", label: "Amount", type: "number-range" },
            { key: "draftedBySystem", label: "Drafted by system", type: "boolean" },
            { key: "from", label: "Created", type: "date", queryFrom: "from", queryTo: "to" },
        ],
        defaultSort: { key: "createdAt", direction: "desc" },
    },
    CashOuts: {
        url: urlsMap.cashoutsList,
        listKey: "cashouts",
        filters: [
            { key: "state", label: "State", type: "data-autocomplete", options: options(CASHOUT_STATE), multiple: true },
            { key: "merchantId", label: "Merchant", type: "api-autocomplete", load: merchants },
            { key: "walletId", label: "Wallet", type: "api-autocomplete", load: wallets },
            { key: "amount", label: "Amount", type: "number-range" },
            { key: "from", label: "Requested", type: "date", queryFrom: "from", queryTo: "to" },
        ],
        defaultSort: { key: "requestedAt", direction: "desc" },
    },
    Disputes: {
        url: urlsMap.disputesList,
        listKey: "disputes",
        filters: [
            { key: "status", label: "Status", type: "data-autocomplete", options: options(DISPUTE_STATUS), multiple: true },
            { key: "railId", label: "Rail", type: "api-autocomplete", load: rails, query: "railId" },
            { key: "amount", label: "Amount", type: "number-range" },
            { key: "from", label: "Opened", type: "date", queryFrom: "from", queryTo: "to" },
            { key: "evidence", label: "Evidence due", type: "date", queryFrom: "dateFrom", queryTo: "dateTo" },
        ],
        defaultSort: { key: "openedAt", direction: "desc" },
    },
    OperatorCases: {
        url: urlsMap.operatorCases,
        listKey: "cases",
        filters: [
            { key: "kind", label: "Type", type: "data-autocomplete", options: options(OPERATOR_KIND) },
            { key: "state", label: "State", type: "data-autocomplete", options: options(OPERATOR_STATE), multiple: true },
            { key: "priority", label: "Priority", type: "data-autocomplete", options: options(["P1", "P2", "P3"]) },
            { key: "assigneeUserId", label: "Assignee", type: "api-autocomplete", load: users },
            { key: "from", label: "Opened", type: "date", queryFrom: "from", queryTo: "to" },
            { key: "sla", label: "SLA due", type: "date", queryFrom: "dateFrom", queryTo: "dateTo" },
        ],
        defaultSort: { key: "priority", direction: "asc" },
    },
    Reconciliation: {
        url: urlsMap.reconciliationSources,
        listKey: "sources",
        filters: [{ key: "from", label: "Created", type: "date", queryFrom: "from", queryTo: "to" }],
        defaultSort: { key: "createdAt", direction: "desc" },
        storageKey: "pg.admin.reconciliation.sources",
    },
};

export const rowToneFor = rowTone;
