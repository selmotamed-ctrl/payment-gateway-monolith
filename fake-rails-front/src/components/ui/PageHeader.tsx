import { defineComponent, type PropType, type VNodeChild } from "vue";
import { RouterLink } from "vue-router";
import { VBtn } from "vuetify/components";
import { useLocale } from "vuetify";
import { StatusBadge, type BadgeTone } from "./StatusBadge";

export interface BreadcrumbItem {
    label: string;
    to?: string;
}

export const PageHeader = defineComponent({
    name: "PageHeader",
    props: {
        title: { type: String, required: true },
        subtitle: { type: String, default: "" },
        badge: { type: String, default: "" },
        badgeLabel: { type: String, default: "" },
        badgeTone: { type: String as PropType<BadgeTone>, default: "neutral" },
        breadcrumbs: { type: Array as PropType<BreadcrumbItem[]>, default: () => [] },
        helpChapterId: { type: String, default: "" },
        onOpenHelp: { type: Function as PropType<(chapterId: string) => void>, default: undefined },
        end: { type: Function as PropType<() => VNodeChild>, default: undefined },
    },
    setup(props, { slots }) {
        const { t } = useLocale();
        return (): VNodeChild => (
            <header
                style={{
                    display: "flex",
                    flexWrap: "wrap",
                    alignItems: "flex-start",
                    justifyContent: "space-between",
                    gap: "16px",
                    paddingBottom: "20px",
                    marginBottom: "20px",
                    borderBottom: "1px solid var(--pg-border-subtle)",
                }}
            >
                <div style={{ minWidth: "240px", flex: "1 1 auto" }}>
                    {props.breadcrumbs.length > 0 && (
                        <nav
                            aria-label={t("Breadcrumb")}
                            style={{
                                display: "flex",
                                alignItems: "center",
                                gap: "6px",
                                fontSize: "12px",
                                color: "var(--pg-ink-muted)",
                                marginBottom: "6px",
                            }}
                        >
                            <ol style={{ display: "flex", alignItems: "center", gap: "6px", listStyle: "none", margin: 0, padding: 0 }}>
                                {props.breadcrumbs.map((crumb, idx) => {
                                    const last = idx === props.breadcrumbs.length - 1;
                                    return (
                                        <li key={`${crumb.label}-${idx}`} style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                                            {idx > 0 && <span aria-hidden="true" style={{ color: "var(--pg-ink-faint)" }}>/</span>}
                                            {crumb.to && !last ? (
                                                <RouterLink to={crumb.to} style={{ color: "inherit", textDecoration: "none" }}>
                                                    {crumb.label}
                                                </RouterLink>
                                            ) : (
                                                <span aria-current={last ? "page" : undefined}>{crumb.label}</span>
                                            )}
                                        </li>
                                    );
                                })}
                            </ol>
                        </nav>
                    )}
                    <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                        <h1
                            class="pg-page-title"
                            style={{
                                fontSize: "22px",
                                fontWeight: 600,
                                color: "var(--pg-ink-primary)",
                                margin: 0,
                            }}
                        >
                            {props.title}
                        </h1>
                        {props.badge && (
                            <StatusBadge
                                status={props.badge}
                                label={props.badgeLabel || undefined}
                                toneOverride={props.badgeTone}
                            />
                        )}
                    </div>
                    {props.subtitle && (
                        <p
                            class="pg-page-subtitle"
                            style={{
                                fontSize: "13.5px",
                                color: "var(--pg-ink-secondary)",
                                margin: "4px 0 0 0",
                                maxWidth: "72ch",
                            }}
                        >
                            {props.subtitle}
                        </p>
                    )}
                </div>
                <div
                    style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "8px",
                        flexWrap: "wrap",
                        alignSelf: "center",
                    }}
                >
                    {props.helpChapterId && props.onOpenHelp && (
                        <VBtn
                            variant="outlined"
                            size="small"
                            prependIcon="mdi-book-open-page-variant-outline"
                            style={{
                                borderColor: "var(--pg-border-subtle)",
                                color: "var(--pg-ink-secondary)",
                                height: "36px",
                            }}
                            onClick={() => props.onOpenHelp?.(props.helpChapterId)}
                            aria-label={t("SOP & Help")}
                        >
                            {t("SOP & Help")}
                        </VBtn>
                    )}
                    {props.end?.()}
                    {slots.actions?.()}
                </div>
            </header>
        );
    },
});

export default PageHeader;
