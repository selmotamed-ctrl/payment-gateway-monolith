import { urlsMap } from "@/constants/urlsMap";
import type { FilterOption, TableServerConfig } from "../filters";
import { createOptionsLoader } from "../referenceOptions";
import { statusTone } from "../statusTone";

/**
 * Table filter configs of this area, keyed by ROUTE NAME (see tableRegistry.ts).
 * `Wallets` and `Applications` are the route names; the payment-link and POS
 * terminal tabs of the Applications page use their own keys, read by the page
 * through `tableRegistry` (they are not route names).
 */
const options = (values: string[]): FilterOption[] =>
    values.map((value) => ({ title: value.replaceAll("_", " "), value, tone: statusTone(value) }));

const merchants = createOptionsLoader("merchants");
const applications = createOptionsLoader("applications");

const WALLET_STATUS = ["PENDING", "ACTIVE", "FROZEN", "CLOSED"];
const APPLICATION_STATUS = ["DRAFT", "PENDING", "ACTIVE", "SUSPENDED", "CLOSED"];
const PAYMENT_LINK_STATE = ["PENDING", "COMPLETED", "EXPIRED", "CANCELLED"];
const POS_STATUS = ["ACTIVE", "INACTIVE", "BLOCKED"];

export const commerceTables: Record<string, TableServerConfig> = {
    Wallets: {
        url: urlsMap.walletsList,
        listKey: "wallets",
        filters: [
            { key: "status", label: "Status", type: "data-autocomplete", options: options(WALLET_STATUS), multiple: true },
            { key: "currency", label: "Currency", type: "text", placeholder: "LYD" },
            { key: "merchantId", label: "Merchant", type: "api-autocomplete", load: merchants },
            { key: "date", label: "Created", type: "date" },
        ],
        defaultSort: { key: "createdAt", direction: "desc" },
    },
    Applications: {
        url: urlsMap.applicationsList,
        listKey: "applications",
        filters: [
            { key: "status", label: "Status", type: "data-autocomplete", options: options(APPLICATION_STATUS), multiple: true },
            { key: "merchantId", label: "Merchant", type: "api-autocomplete", load: merchants },
            { key: "date", label: "Created", type: "date" },
        ],
        defaultSort: { key: "createdAt", direction: "desc" },
    },
    ApplicationPaymentLinks: {
        url: urlsMap.paymentLinksList,
        listKey: "paymentLinks",
        filters: [
            { key: "state", label: "State", type: "data-autocomplete", options: options(PAYMENT_LINK_STATE), multiple: true },
            { key: "merchantId", label: "Merchant", type: "api-autocomplete", load: merchants },
            { key: "applicationId", label: "Application", type: "api-autocomplete", load: applications },
            { key: "currency", label: "Currency", type: "text", placeholder: "LYD" },
            { key: "amount", label: "Amount", type: "number-range", queryMin: "amountMin", queryMax: "amountMax" },
            { key: "date", label: "Created", type: "date" },
        ],
        defaultSort: { key: "createdAt", direction: "desc" },
    },
    ApplicationPosTerminals: {
        url: urlsMap.posTerminalsList,
        listKey: "posTerminals",
        filters: [
            { key: "status", label: "Status", type: "data-autocomplete", options: options(POS_STATUS), multiple: true },
            { key: "merchantId", label: "Merchant", type: "api-autocomplete", load: merchants },
            { key: "applicationId", label: "Application", type: "api-autocomplete", load: applications },
            { key: "date", label: "Created", type: "date" },
        ],
        defaultSort: { key: "createdAt", direction: "desc" },
    },
};
