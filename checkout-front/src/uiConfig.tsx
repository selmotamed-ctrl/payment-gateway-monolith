import type { PgUiConfig } from "@pg/ui";
import { api } from "@/state/api";
import { copyToClipboard } from "@/utils/common";
import { showConfirm } from "@/utils/confirm";
import { extractApiError } from "@/utils/errors/extractor";

/** Host services the shared design system needs from the checkout portal. */
export const createUiConfig = (router: any): PgUiConfig => ({
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
