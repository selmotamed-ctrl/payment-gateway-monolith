import type { TableFilter } from "@/components/Table/filters";
import { statusTone } from "@/components/Table/statusTone";

const options = (values: string[]) =>
    values.map((value) => ({ title: value.replaceAll("_", " "), value, tone: statusTone(value) }));

export const TRANSACTION_STATUS = [
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
export const ENVIRONMENTS = ["SANDBOX", "LIVE"];
export const APPLICATION_STATUS = ["DRAFT", "PENDING", "ACTIVE", "SUSPENDED", "CLOSED"];
export const WALLET_STATUS = ["PENDING", "ACTIVE", "FROZEN", "CLOSED"];
export const CASHOUT_STATE = ["PENDING", "REJECTED", "PROCESSING", "COMPLETE", "SUBTRACTED"];
export const DISPUTE_STATUS = ["OPENED", "EVIDENCE_REQUESTED", "EVIDENCE_SUBMITTED", "WON", "LOST", "EXPIRED", "WITHDRAWN"];
export const ADJUSTMENT_TYPE = ["CHARGEBACK", "REFUND", "MANUAL_CREDIT", "MANUAL_DEBIT", "CORRECTION", "CASHOUT_SUBTRACTION"];
export const ADJUSTMENT_STATE = ["DRAFT", "PENDING_REVIEW", "APPROVED", "EXECUTING", "EXECUTED", "REJECTED"];
export const NOTIFICATION_STATUS = ["QUEUED", "SENT", "DELIVERED", "FAILED", "SUPPRESSED"];
export const NOTIFICATION_CHANNEL = ["SMS", "EMAIL", "IN_APP"];
export const NOTIFICATION_LANG = ["AR", "EN"];

export const transactionFilters = (applications: Array<{ id: string; name: string }>): TableFilter[] => [
    { key: "status", label: "Status", type: "data-autocomplete", options: options(TRANSACTION_STATUS), multiple: true },
    { key: "env", label: "Environment", type: "data-autocomplete", options: options(ENVIRONMENTS) },
    ...(applications.length > 0
        ? [{
              key: "applicationId",
              label: "Application",
              type: "data-autocomplete" as const,
              options: applications.map((application) => ({ title: application.name, value: application.id })),
          }]
        : []),
    { key: "amount", label: "Amount", type: "number-range" },
    { key: "created", label: "Created", type: "date", queryFrom: "from", queryTo: "to" },
];

export const applicationFilters = (wallets: Array<{ id: string; currency: string }>): TableFilter[] => [
    { key: "status", label: "Status", type: "data-autocomplete", options: options(APPLICATION_STATUS), multiple: true },
    ...(wallets.length > 0
        ? [{
              key: "walletId",
              label: "Wallet",
              type: "data-autocomplete" as const,
              options: wallets.map((wallet) => ({ title: `${wallet.currency} · ${wallet.id}`, value: wallet.id })),
          }]
        : []),
    { key: "created", label: "Created", type: "date", queryFrom: "from", queryTo: "to" },
];

export const walletFilters = (): TableFilter[] => [
    { key: "status", label: "Status", type: "data-autocomplete", options: options(WALLET_STATUS), multiple: true },
    { key: "currency", label: "Currency", type: "text", placeholder: "LYD" },
    { key: "created", label: "Created", type: "date", queryFrom: "from", queryTo: "to" },
];

export const cashoutFilters = (wallets: Array<{ id: string; currency: string }>): TableFilter[] => [
    { key: "state", label: "State", type: "data-autocomplete", options: options(CASHOUT_STATE), multiple: true },
    ...(wallets.length > 0
        ? [{
              key: "walletId",
              label: "Wallet",
              type: "data-autocomplete" as const,
              options: wallets.map((wallet) => ({ title: `${wallet.currency} · ${wallet.id}`, value: wallet.id })),
          }]
        : []),
    { key: "amount", label: "Amount", type: "number-range" },
    { key: "created", label: "Created", type: "date", queryFrom: "from", queryTo: "to" },
];

export const disputeFilters = (): TableFilter[] => [
    { key: "status", label: "Status", type: "data-autocomplete", options: options(DISPUTE_STATUS), multiple: true },
    { key: "amount", label: "Amount", type: "number-range" },
    { key: "opened", label: "Opened", type: "date", queryFrom: "openedFrom", queryTo: "openedTo" },
    { key: "due", label: "Evidence due", type: "date", queryFrom: "dueFrom", queryTo: "dueTo" },
];

export const adjustmentFilters = (): TableFilter[] => [
    { key: "type", label: "Type", type: "data-autocomplete", options: options(ADJUSTMENT_TYPE) },
    { key: "state", label: "State", type: "data-autocomplete", options: options(ADJUSTMENT_STATE), multiple: true },
    { key: "amount", label: "Amount", type: "number-range" },
    { key: "created", label: "Created", type: "date", queryFrom: "from", queryTo: "to" },
];

export const notificationFilters = (): TableFilter[] => [
    { key: "status", label: "Status", type: "data-autocomplete", options: options(NOTIFICATION_STATUS), multiple: true },
    { key: "channel", label: "Channel", type: "data-autocomplete", options: options(NOTIFICATION_CHANNEL) },
    { key: "lang", label: "Language", type: "data-autocomplete", options: options(NOTIFICATION_LANG) },
    { key: "created", label: "Created", type: "date", queryFrom: "from", queryTo: "to" },
];

export const auditFilters = (): TableFilter[] => [
    { key: "action", label: "Action", type: "text", placeholder: "e.g. MERCHANT_SUSPENDED" },
    { key: "role", label: "Role", type: "text", placeholder: "e.g. COMPLIANCE" },
    { key: "created", label: "Created", type: "date", queryFrom: "from", queryTo: "to" },
];
