import type { PgUiConfig } from "@pg/ui";
import { i18n } from "@/plugins/i18n";
import { ContextHelpButton } from "@/components/guide/ContextHelpButton";
import { api } from "@/state/api";
import { copyToClipboard } from "@/utils/common";
import { showConfirm } from "@/utils/confirm";
import { extractApiError } from "@/utils/errors/extractor";
import { xlsxUIPipeline } from "@/utils/xlsx";

/** Host services the shared design system needs from the admin portal. */
export const createUiConfig = (router: any): PgUiConfig => ({
    i18n: { t: i18n.global.t as any, locale: i18n.global.locale as any },
    api: api as any,
    extractApiError: (error) => extractApiError(error),
    confirm: (options) => showConfirm(options as any),
    copyText: async (text) => {
        copyToClipboard(text);
        return true;
    },
    resolveHref: (to) => {
        try {
            return router?.resolve?.(to)?.href ?? (typeof to === "string" ? to : "");
        } catch {
            return typeof to === "string" ? to : "";
        }
    },
    navigate: (to) => router?.push?.(to),
    helpButton: () => <ContextHelpButton />,
    exportXlsx: async ({ headers, data, title }) => {
        const translated = (headers ?? [])
            .filter((header) => !!header.value)
            .map((header) => ({
                key: header.key,
                text: typeof header.label === "string" ? header.label : header.key,
                type: "string",
                required: false,
                originalHeader: header,
            }));
        await xlsxUIPipeline.downloadXlsxFromHeadersAndData({
            color: "var(--pg-accent-brand)",
            headers: translated as any,
            title: title ?? "Export",
            data: (data ?? []).map((row: any, index: number) => {
                const item: Record<string, any> = {};
                for (const header of translated) {
                    item[header.key] =
                        typeof (header as any).originalHeader.value === "function"
                            ? (header as any).originalHeader.value(row, index)
                            : "";
                }
                return item;
            }),
        });
    },
});
