import { urlsMap } from "@/constants/urlsMap";
import type { FilterOption, TableFilter, TableServerConfig } from "../filters";
import { createOptionsLoader } from "../referenceOptions";
import { statusTone } from "../statusTone";

/**
 * Table filter configs of the ledger & operations area, keyed by ROUTE NAME (see tableRegistry.ts).
 * Pages with several tables (Transactions, JobsOutbox) read the extra filter lists below explicitly.
 */

const options = (values: readonly string[]): FilterOption[] =>
    values.map((value) => ({ title: value.replaceAll("_", " "), value, tone: statusTone(value) }));

const merchants = createOptionsLoader("merchants");
const rails = createOptionsLoader("rails");
const gateways = createOptionsLoader("gateways");
const applications = createOptionsLoader("applications");

const ATTEMPT_STATUS = [
    "CREATED",
    "INITIATING",
    "AWAITING_CUSTOMER",
    "AUTHORIZING",
    "VERIFYING",
    "UNKNOWN",
    "SUCCEEDED",
    "FAILED",
    "EXPIRED",
    "CANCELLED",
    "BLOCKED",
    "PARTIALLY_REFUNDED",
    "REFUNDED",
    "DISPUTED",
];
const JOURNAL_REF_TYPE = [
    "PAYMENT_ATTEMPT",
    "ADJUSTMENT",
    "AML_RELEASE",
    "AML_VOID",
    "SETTLEMENT_SWEEP",
    "FEE_VARIANCE",
    "COMMISSION_NETTING",
    "DISPUTE_OUTCOME",
];
const JOB_STATE = ["QUEUED", "RUNNING", "SUCCEEDED", "FAILED"];
const JOB_TYPE = ["RECONCILIATION_RUN", "ADJUSTMENT_EXECUTION"];
const NOTIFICATION_STATUS = ["FAILED", "QUEUED", "SENT", "DELIVERED", "SUPPRESSED", "ALL"];
const NOTIFICATION_CHANNEL = ["SMS", "EMAIL", "IN_APP"];
const CREDENTIAL_STATUS = ["UNTESTED", "VERIFIED", "FAILING", "REVOKED"];

export const transactionFilters: TableFilter[] = [
    { key: "status", label: "Status", type: "data-autocomplete", options: options(ATTEMPT_STATUS), multiple: true },
    { key: "railId", label: "Rail", type: "api-autocomplete", load: rails },
    { key: "gatewayId", label: "Gateway", type: "api-autocomplete", load: gateways },
    { key: "merchantId", label: "Merchant", type: "api-autocomplete", load: merchants },
    { key: "applicationId", label: "Application", type: "api-autocomplete", load: applications },
    { key: "currency", label: "Currency", type: "text", placeholder: "LYD" },
    { key: "amount", label: "Amount", type: "number-range" },
    { key: "date", label: "Created", type: "date", queryFrom: "from", queryTo: "to" },
];

export const inboundEventFilters: TableFilter[] = [
    { key: "gatewayId", label: "Gateway", type: "api-autocomplete", load: gateways },
    { key: "verified", label: "Signature", type: "boolean", trueLabel: "Verified", falseLabel: "Unverified" },
    { key: "unmatchedOnly", label: "Unmatched only", type: "boolean", trueLabel: "Unmatched", falseLabel: "All" },
    { key: "date", label: "Received", type: "date", queryFrom: "from", queryTo: "to" },
];

export const journalEntryFilters: TableFilter[] = [
    { key: "refType", label: "Reference type", type: "data-autocomplete", options: options(JOURNAL_REF_TYPE), multiple: true },
    { key: "glAccountId", label: "GL account ID", type: "text", placeholder: "GL account UUID" },
    { key: "date", label: "Posted", type: "date", queryFrom: "from", queryTo: "to" },
];

export const credentialSetFilters: TableFilter[] = [
    { key: "gatewayCode", label: "Gateway code", type: "text", placeholder: "e.g. almadar" },
    { key: "env", label: "Environment", type: "data-autocomplete", options: options(["SANDBOX", "LIVE"]) },
    { key: "ownerType", label: "Owner", type: "data-autocomplete", options: options(["PLATFORM", "MERCHANT"]) },
    { key: "status", label: "Status", type: "data-autocomplete", options: options(CREDENTIAL_STATUS), multiple: true },
    { key: "date", label: "Created", type: "date", queryFrom: "from", queryTo: "to" },
];

export const jobFilters: TableFilter[] = [
    { key: "state", label: "State", type: "data-autocomplete", options: options(JOB_STATE), multiple: true },
    { key: "jobType", label: "Job type", type: "data-autocomplete", options: options(JOB_TYPE), multiple: true },
    { key: "date", label: "Created", type: "date", queryFrom: "from", queryTo: "to" },
];

export const outboxFilters: TableFilter[] = [
    { key: "published", label: "Published", type: "boolean", trueLabel: "Published", falseLabel: "Unpublished" },
    { key: "topic", label: "Topic", type: "text", placeholder: "e.g. payment.succeeded" },
    { key: "aggregateType", label: "Aggregate type", type: "text", placeholder: "e.g. PAYMENT_ATTEMPT" },
    { key: "date", label: "Created", type: "date", queryFrom: "from", queryTo: "to" },
];

export const auditOutboxFilters: TableFilter[] = [
    { key: "shipped", label: "Shipped", type: "boolean", trueLabel: "Shipped", falseLabel: "Queued" },
    { key: "action", label: "Action", type: "text", placeholder: "e.g. APPROVAL" },
    { key: "entityType", label: "Entity type", type: "text", placeholder: "e.g. MERCHANT" },
    { key: "date", label: "Created", type: "date", queryFrom: "from", queryTo: "to" },
];

export const notificationFilters: TableFilter[] = [
    { key: "status", label: "Status", type: "data-autocomplete", options: options(NOTIFICATION_STATUS) },
    { key: "channel", label: "Channel", type: "data-autocomplete", options: options(NOTIFICATION_CHANNEL), multiple: true },
    { key: "templateCode", label: "Template code", type: "text", placeholder: "e.g. OTP_LOGIN" },
    { key: "date", label: "Created", type: "date", queryFrom: "from", queryTo: "to" },
];

export const ledgerOpsTables: Record<string, TableServerConfig> = {
    Transactions: {
        url: urlsMap.transactionsList,
        listKey: "transactions",
        filters: transactionFilters,
        defaultSort: { key: "createdAt", direction: "desc" },
    },
    JournalEntries: {
        url: urlsMap.financeJournalEntries,
        listKey: "journalEntries",
        filters: journalEntryFilters,
        defaultSort: { key: "createdAt", direction: "desc" },
    },
    CredentialSets: {
        url: urlsMap.credentialSetsList,
        listKey: "credentialSets",
        filters: credentialSetFilters,
        defaultSort: { key: "createdAt", direction: "desc" },
    },
    // The jobs-outbox page has four tables; the registry entry is the background jobs one.
    JobsOutbox: {
        url: urlsMap.systemJobsList,
        listKey: "jobs",
        filters: jobFilters,
        defaultSort: { key: "createdAt", direction: "desc" },
    },
};
