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
                            aria-label="Breadcrumb"
                            style={{
                                display: "flex",
                                alignItems: "center",
                                gap: "6px",
                                fontSize: "12px",
                                color: "var(--pg-ink-muted)",
                                marginBottom: "6px",
                            }}
                        >
                            {props.breadcrumbs.map((crumb, idx) => (
                                <span key={`${crumb.label}-${idx}`} style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                                    {idx > 0 && <span style={{ color: "var(--pg-ink-faint)" }}>/</span>}
                                    {crumb.to ? (
                                        <RouterLink to={crumb.to} style={{ color: "inherit", textDecoration: "none" }}>
                                            {crumb.label}
                                        </RouterLink>
                                    ) : (
                                        <span>{crumb.label}</span>
                                    )}
                                </span>
                            ))}
                        </nav>
                    )}
                    <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                        <h1
                            style={{
                                fontSize: "22px",
                                fontWeight: 600,
                                lineHeight: 1.25,
                                color: "var(--pg-ink-primary)",
                                margin: 0,
                                letterSpacing: "-0.02em",
                            }}
                        >
                            {props.title}
                        </h1>
                        {props.badge && <StatusBadge status={props.badge} toneOverride={props.badgeTone} />}
                    </div>
                    {props.subtitle && (
                        <p
                            style={{
                                fontSize: "13.5px",
                                lineHeight: 1.5,
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
