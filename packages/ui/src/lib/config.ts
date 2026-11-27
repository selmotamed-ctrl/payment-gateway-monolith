import { inject, provide, type InjectionKey } from "vue";
import { DEFAULT_CURRENCY } from "./money";
import { currentLocale } from "./locale";

/**
 * Host portal services. `@pg/ui` never imports a portal's store directly; the
 * portal supplies the API client, error extractor, route helpers and copy hook
 * once in `<PgProvider :config="…">`.
 */
export interface PgUiApiClient {
    get: (url: string, options?: any) => Promise<{ data: any }>;
    post?: (url: string, body?: any, options?: any) => Promise<{ data: any }>;
    put?: (url: string, body?: any, options?: any) => Promise<{ data: any }>;
    patch?: (url: string, body?: any, options?: any) => Promise<{ data: any }>;
    delete?: (url: string, options?: any) => Promise<{ data: any }>;
}

export interface PgUiConfig {
    api?: PgUiApiClient;
    /** Host translator/composer; keeps @pg/ui on the portal's vue-i18n instance. */
    i18n?: { t: (key: string, ...params: unknown[]) => string; locale: { value: string } };
    /** Default server page size for `PgApiTable` / `PgApiAutocomplete`. */
    defaultPageSize?: number;
    /** Default ISO-4217 code used when a payload has no currency. */
    currency?: string;
    /** Active locale getter shared with light API calls. */
    getLocale?: () => "en" | "ar";
    /** Name of the HTTP header that carries `Accept-Language` (default `Accept-Language`). */
    localeHeader?: string;
    extractApiError?: (error: unknown) => { error?: string; message?: string } | null | undefined;
    devLog?: (...args: any[]) => void;
    resolveHref?: (to: any) => string;
    navigate?: (to: any) => void | Promise<void>;
    baseUrl?: string;
    urls?: Record<string, string>;
    copyText?: (text: string) => Promise<boolean>;
    /** Standard confirmation dialog provided by the host's mounted service. */
    confirm?: (options: { title: string; message: string; type?: string; submitButtonLabel?: string }) => Promise<boolean>;
    /** Host XLSX exporter for the shared table toolbar. */
    exportXlsx?: (payload: { headers: any[]; data: any[]; title?: string }) => void | Promise<void>;
    /** Optional contextual-help trigger rendered in every page header. */
    helpButton?: () => any;
    /** Central error hook (toasts are usually wired here). */
    onError?: (error: unknown, context: string) => void;
    /** Session-expiry hook (redirect to login / clear session). */
    onUnauthorized?: () => void;
}

const CONFIG_KEY: InjectionKey<PgUiConfig> = Symbol("pg-ui-config") as InjectionKey<PgUiConfig>;

let warnedMissingProvider = false;

export const providePgUiConfig = (config: PgUiConfig) => provide(CONFIG_KEY, config);

/**
 * Returns the host configuration. In development a missing provider produces a
 * single explicit diagnostic instead of an unhandled TypeError later, and the
 * safe fallback still exposes page size/currency/locale defaults.
 */
export const usePgUiConfig = (): Required<Pick<PgUiConfig, "defaultPageSize" | "currency" | "getLocale">> & PgUiConfig => {
    const injected = inject(CONFIG_KEY, null);
    if (!injected && !warnedMissingProvider && typeof console !== "undefined") {
        warnedMissingProvider = true;
        // eslint-disable-next-line no-console
        console.warn(
            "[@pg/ui] usePgUiConfig() was called without a <PgProvider> ancestor. " +
                "API-bound components will render an error state instead of crashing.",
        );
    }
    const config = injected ?? {};
    return {
        ...config,
        defaultPageSize: config.defaultPageSize ?? 25,
        currency: config.currency ?? DEFAULT_CURRENCY,
        getLocale: config.getLocale ?? (() => (currentLocale.value === "ar" ? "ar" : "en")),
    };
};

/** Test hook: clears the one-time missing-provider warning. */
export const resetPgUiConfigWarning = () => {
    warnedMissingProvider = false;
};
