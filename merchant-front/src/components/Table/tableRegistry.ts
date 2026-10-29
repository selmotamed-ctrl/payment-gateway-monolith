import { urlsMap } from "@/constants/urlsMap";
import type { FilterOption, TableServerConfig } from "./filters";
import { createOptionsLoader } from "./referenceOptions";
import { rowTone, statusTone } from "./statusTone";

export type { TableServerConfig };

const options = (values: string[]): FilterOption[] =>
    values.map((value) => ({ title: value.replaceAll("_", " "), value, tone: statusTone(value) }));

const applications = createOptionsLoader("applications");
const wallets = createOptionsLoader("wallets");
const rails = createOptionsLoader("rails");
const gateways = createOptionsLoader("gateways");

const APPLICATION_STATUS = ["DRAFT", "PENDING", "ACTIVE", "SUSPENDED", "CLOSED"];
const LINK_STATUS = ["PENDING", "COMPLETED", "EXPIRED", "CANCELLED"];
const PAYMENT_STATUS = ["CREATED", "INITIATING", "AWAITING_CUSTOMER", "AUTHORIZING", "VERIFYING", "UNKNOWN", "SUCCEEDED", "FAILED", "EXPIRED", "CANCELLED", "BLOCKED", "PARTIALLY_REFUNDED", "REFUNDED", "DISPUTED"];
const DISPUTE_STATUS = ["OPENED", "EVIDENCE_REQUESTED", "EVIDENCE_SUBMITTED", "WON", "LOST", "EXPIRED", "WITHDRAWN"];
const CASHOUT_STATE = ["PENDING", "REJECTED", "PROCESSING", "COMPLETE", "SUBTRACTED"];
const WALLET_STATUS = ["PENDING", "ACTIVE", "FROZEN", "CLOSED"];
const CREDENTIAL_STATUS = ["UNTESTED", "VERIFIED", "FAILING", "REVOKED"];
const SETTLEMENT_TARGET = ["PLATFORM_CLEARING", "MERCHANT_DIRECT", "PROVIDER_HELD"];
const TEAM_ROLE = ["MERCHANT_ADMIN", "MERCHANT_STAFF", "MERCHANT_CASHIER"];
const USER_STATUS = ["INVITED", "ACTIVE", "SUSPENDED", "DISABLED"];
const POS_STATUS = ["ACTIVE", "INACTIVE", "BLOCKED"];

export const tableRegistry: Record<string, TableServerConfig> = {
    Wallets: {
        url: urlsMap.walletsList,
        listKey: "wallets",
        filters: [
            { key: "status", label: "Status", type: "data-autocomplete", options: options(WALLET_STATUS), multiple: true },
            { key: "currency", label: "Currency", type: "text", placeholder: "LYD" },
            { key: "from", label: "Created", type: "date", queryFrom: "from", queryTo: "to" },
        ],
        defaultSort: { key: "createdAt", direction: "desc" },
    },
    Applications: {
        url: urlsMap.applicationsList,
        listKey: "applications",
        filters: [
            { key: "status", label: "Status", type: "data-autocomplete", options: options(APPLICATION_STATUS), multiple: true },
            { key: "assignedWalletId", label: "Wallet", type: "api-autocomplete", load: wallets },
            { key: "from", label: "Created", type: "date", queryFrom: "from", queryTo: "to" },
        ],
        defaultSort: { key: "createdAt", direction: "desc" },
    },
    Links: {
        url: urlsMap.linksList,
        listKey: "links",
        filters: [
            { key: "state", label: "Status", type: "data-autocomplete", options: options(LINK_STATUS) },
            { key: "railId", label: "Rail", type: "api-autocomplete", load: rails, query: "railId" },
            { key: "applicationId", label: "Application", type: "api-autocomplete", load: applications },
            { key: "amount", label: "Amount", type: "number-range" },
            { key: "from", label: "Created", type: "date", queryFrom: "from", queryTo: "to" },
            { key: "expiry", label: "Expires", type: "date", queryFrom: "dateFrom", queryTo: "dateTo" },
        ],
        defaultSort: { key: "createdAt", direction: "desc" },
    },
    Payments: {
        url: urlsMap.paymentsList,
        listKey: "payments",
        filters: [
            { key: "status", label: "Status", type: "data-autocomplete", options: options(PAYMENT_STATUS), multiple: true },
            { key: "railId", label: "Rail", type: "api-autocomplete", load: rails, query: "railId" },
            { key: "applicationId", label: "Application", type: "api-autocomplete", load: applications },
            { key: "amount", label: "Amount", type: "number-range" },
            { key: "commission", label: "Commission", type: "number-range" },
            { key: "net", label: "Net", type: "number-range" },
            { key: "from", label: "Created", type: "date", queryFrom: "from", queryTo: "to" },
            { key: "confirmed", label: "Confirmed", type: "date", queryFrom: "dateFrom", queryTo: "dateTo" },
        ],
        defaultSort: { key: "createdAt", direction: "desc" },
    },
    Disputes: {
        url: urlsMap.disputesList,
        listKey: "disputes",
        filters: [
            { key: "status", label: "Status", type: "data-autocomplete", options: options(DISPUTE_STATUS), multiple: true },
            { key: "amount", label: "Amount", type: "number-range" },
            { key: "from", label: "Opened", type: "date", queryFrom: "from", queryTo: "to" },
            { key: "evidence", label: "Evidence due", type: "date", queryFrom: "dateFrom", queryTo: "dateTo" },
        ],
        defaultSort: { key: "openedAt", direction: "desc" },
    },
    Cashouts: {
        url: urlsMap.cashoutsList,
        listKey: "cashouts",
        filters: [
            { key: "state", label: "State", type: "data-autocomplete", options: options(CASHOUT_STATE), multiple: true },
            { key: "walletId", label: "Wallet", type: "api-autocomplete", load: wallets },
            { key: "amount", label: "Amount", type: "number-range" },
            { key: "from", label: "Requested", type: "date", queryFrom: "from", queryTo: "to" },
        ],
        defaultSort: { key: "requestedAt", direction: "desc" },
    },
    Credentials: {
        url: urlsMap.credentialSetsList,
        listKey: "credentialSets",
        filters: [
            { key: "gatewayId", label: "Gateway", type: "api-autocomplete", load: gateways, query: "gatewayId" },
            { key: "env", label: "Environment", type: "data-autocomplete", options: options(["SANDBOX", "LIVE"]) },
            { key: "settlementTarget", label: "Settlement target", type: "data-autocomplete", options: options(SETTLEMENT_TARGET) },
            { key: "status", label: "Status", type: "data-autocomplete", options: options(CREDENTIAL_STATUS), multiple: true },
            { key: "from", label: "Created", type: "date", queryFrom: "from", queryTo: "to" },
        ],
        defaultSort: { key: "createdAt", direction: "desc" },
    },
    DeveloperTokens: {
        url: urlsMap.tokensList,
        listKey: "tokens",
        filters: [
            { key: "ipWhitelistEnabled", label: "IP whitelist", type: "boolean" },
            { key: "revoked", label: "Revoked", type: "boolean" },
            { key: "from", label: "Created", type: "date", queryFrom: "from", queryTo: "to" },
            { key: "lastUsed", label: "Last used", type: "date", queryFrom: "dateFrom", queryTo: "dateTo" },
        ],
        defaultSort: { key: "createdAt", direction: "desc" },
    },
    Team: {
        url: urlsMap.usersList,
        listKey: "users",
        filters: [
            { key: "role", label: "Role", type: "data-autocomplete", options: options(TEAM_ROLE) },
            { key: "status", label: "Status", type: "data-autocomplete", options: options(USER_STATUS), multiple: true },
            { key: "from", label: "Created", type: "date", queryFrom: "from", queryTo: "to" },
        ],
        defaultSort: { key: "createdAt", direction: "desc" },
    },
    PosTerminals: {
        url: urlsMap.posTerminals,
        listKey: "terminals",
        filters: [
            { key: "status", label: "Status", type: "data-autocomplete", options: options(POS_STATUS), multiple: true },
            { key: "from", label: "Created", type: "date", queryFrom: "from", queryTo: "to" },
        ],
        defaultSort: { key: "createdAt", direction: "desc" },
    },
};

export const rowToneFor = rowTone;
