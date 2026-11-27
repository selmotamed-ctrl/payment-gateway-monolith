import type { PgUiConfig } from "@pg/ui";
import { i18n } from "@/plugins/i18n";

/** Host services the shared design system needs from the Fake Rails tester. */
export const createUiConfig = (router: any): PgUiConfig => ({
    i18n: { t: i18n.global.t as any, locale: i18n.global.locale as any },
    resolveHref: (to) => {
        try {
            return router?.resolve?.(to)?.href ?? (typeof to === "string" ? to : "");
        } catch {
            return typeof to === "string" ? to : "";
        }
    },
    navigate: (to) => router?.push?.(to),
});
