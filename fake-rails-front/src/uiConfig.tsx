import type { PgUiConfig } from "@pg/ui";

/** Host services the shared design system needs from the Fake Rails tester. */
export const createUiConfig = (router: any): PgUiConfig => ({
    resolveHref: (to) => {
        try {
            return router?.resolve?.(to)?.href ?? (typeof to === "string" ? to : "");
        } catch {
            return typeof to === "string" ? to : "";
        }
    },
    navigate: (to) => router?.push?.(to),
});
