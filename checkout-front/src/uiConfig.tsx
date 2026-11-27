import type { PgUiConfig } from "@pg/ui";
import { i18n } from "@/plugins/i18n";
import { api } from "@/state/api";
import { copyToClipboard } from "@/utils/common";
import { showConfirm } from "@/utils/confirm";
import { extractApiError } from "@/utils/errors/extractor";

/** Host services the shared design system needs from the checkout portal. */
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
});
