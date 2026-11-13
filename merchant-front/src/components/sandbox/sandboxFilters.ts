import type { FilterOption, TableFilter } from "@/components/Table/filters";
import { statusTone } from "@/components/Table/statusTone";

export const WALLET_STATUS = ["PENDING", "ACTIVE", "FROZEN", "CLOSED"];
export const APPLICATION_STATUS = ["DRAFT", "PENDING", "ACTIVE", "SUSPENDED", "CLOSED"];
export const LINK_STATE = ["PENDING", "COMPLETED", "EXPIRED", "CANCELLED"];
export const PAYMENT_STATUS = ["CREATED", "INITIATING", "AWAITING_CUSTOMER", "AUTHORIZING", "VERIFYING", "UNKNOWN", "SUCCEEDED", "FAILED", "EXPIRED", "CANCELLED", "BLOCKED", "PARTIALLY_REFUNDED", "REFUNDED", "DISPUTED"];
export const ACCOUNT_STATUS = ["ACTIVE", "FROZEN", "EXPIRED", "BLOCKED"];
export const ACCOUNT_SCOPE = ["MERCHANT", "GLOBAL"];
export const ACCOUNT_TYPE = ["MOBILE_WALLET", "BANK_ACCOUNT", "CARD", "VOUCHER"];
export const TOKEN_STATUS = ["ACTIVE", "REVOKED", "EXPIRING"];

export const options = (values: string[]): FilterOption[] =>
    values.map((value) => ({ title: value.replaceAll("_", " "), value, tone: statusTone(value) }));

export const walletFilters = (): TableFilter[] => [
    { key: "status", label: "Status", type: "data-autocomplete", options: options(WALLET_STATUS), multiple: true },
    { key: "currency", label: "Currency", type: "text", placeholder: "LYD" },
    { key: "created", label: "Created", type: "date", queryFrom: "from", queryTo: "to" },
];

export const applicationFilters = (wallets: Array<{ id: string; name?: string | null; currency: string }> = []): TableFilter[] => [
    { key: "status", label: "Status", type: "data-autocomplete", options: options(APPLICATION_STATUS), multiple: true },
    ...(wallets.length > 0 ? [{ key: "assignedWalletId", label: "Wallet", type: "data-autocomplete" as const, options: wallets.map((wallet) => ({ title: wallet.name || wallet.id, value: wallet.id })) }] : []),
    { key: "created", label: "Created", type: "date", queryFrom: "from", queryTo: "to" },
];

export const linkFilters = (applications: Array<{ id: string; name: string }> = []): TableFilter[] => [
    { key: "state", label: "State", type: "data-autocomplete", options: options(LINK_STATE), multiple: true },
    ...(applications.length > 0 ? [{ key: "applicationId", label: "Application", type: "data-autocomplete" as const, options: applications.map((application) => ({ title: application.name, value: application.id })) }] : []),
    { key: "amount", label: "Amount", type: "number-range" },
    { key: "created", label: "Created", type: "date", queryFrom: "from", queryTo: "to" },
];

export const paymentFilters = (applications: Array<{ id: string; name: string }> = []): TableFilter[] => [
    { key: "status", label: "Status", type: "data-autocomplete", options: options(PAYMENT_STATUS), multiple: true },
    ...(applications.length > 0 ? [{ key: "applicationId", label: "Application", type: "data-autocomplete" as const, options: applications.map((application) => ({ title: application.name, value: application.id })) }] : []),
    { key: "amount", label: "Amount", type: "number-range" },
    { key: "created", label: "Created", type: "date", queryFrom: "from", queryTo: "to" },
];

export const accountFilters = (): TableFilter[] => [
    { key: "railCode", label: "Rail", type: "text", placeholder: "e.g. sadad" },
    { key: "gatewayCode", label: "Gateway", type: "text", placeholder: "e.g. fake-rails" },
    { key: "scope", label: "Scope", type: "data-autocomplete", options: options(ACCOUNT_SCOPE) },
    { key: "status", label: "Status", type: "data-autocomplete", options: options(ACCOUNT_STATUS) },
    { key: "instrumentType", label: "Type", type: "data-autocomplete", options: options(ACCOUNT_TYPE) },
    { key: "created", label: "Created", type: "date", queryFrom: "from", queryTo: "to" },
];

export const tokenFilters = (): TableFilter[] => [
    { key: "status", label: "Status", type: "data-autocomplete", options: options(TOKEN_STATUS) },
    { key: "created", label: "Created", type: "date", queryFrom: "from", queryTo: "to" },
];

export const paymentStatusTone = (status: string) =>
    status === "SUCCEEDED" ? "success" : ["FAILED", "BLOCKED", "CANCELLED", "REFUNDED"].includes(status) ? "danger" : ["UNKNOWN", "VERIFYING", "DISPUTED", "PARTIALLY_REFUNDED"].includes(status) ? "warning" : "info";

export const ledgerFilters = (): TableFilter[] => [
    { key: "direction", label: "Side", type: "data-autocomplete", options: options(["DEBIT", "CREDIT"]) },
    { key: "refType", label: "Reference type", type: "text", placeholder: "e.g. PAYMENT_ATTEMPT" },
    { key: "search", label: "Search", type: "text", placeholder: "Reference or description" },
    { key: "created", label: "Date", type: "date", queryFrom: "from", queryTo: "to" },
];
