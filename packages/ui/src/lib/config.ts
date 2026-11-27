import { inject, provide, type InjectionKey } from "vue";

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
}

const CONFIG_KEY: InjectionKey<PgUiConfig> = Symbol("pg-ui-config") as InjectionKey<PgUiConfig>;

export const providePgUiConfig = (config: PgUiConfig) => provide(CONFIG_KEY, config);

export const usePgUiConfig = (): PgUiConfig => inject(CONFIG_KEY, {});
