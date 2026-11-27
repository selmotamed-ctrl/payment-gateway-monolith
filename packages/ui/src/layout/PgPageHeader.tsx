import { createSlot } from "vue";
import { useRouter } from "vue-router";
import { dc } from "../lib/dc";
import { usePgUiConfig } from "../lib/config";
import { useLocale } from "../lib/locale";
import { PgButton } from "../actions/PgButton";
import { PgStatusBadge } from "../feedback/PgStatusBadge";

export interface PgBreadcrumb {
    label: string;
    to?: string;
}

/**
 * Page header: breadcrumbs, title, status badge, subtitle and one action slot.
 * The automatic admin Guide help button is supplied by the admin wrapper's
 * `help` slot, so this component stays host-agnostic.
 */
export const PgPageHeader = dc(
    (props: Record<string, any>, _expose, { slots }) => {
        const { t } = useLocale();
        const config = usePgUiConfig();
        const router = useRouter();
        const navigate = (to: any, event: MouseEvent) => {
            event.preventDefault();
            void router?.push(to);
        };
        return () => (
            <header class="pg-page-header">
                <div class="pg-page-header__main">
                    {props.breadcrumbs?.length > 0 && (
                        <nav class="pg-breadcrumbs" aria-label={t("Breadcrumb")}>
                            <ol>
                                {props.breadcrumbs.map((crumb: PgBreadcrumb, index: number) => {
                                    const last = index === props.breadcrumbs.length - 1;
                                    return (
                                        <li key={`${crumb.label}-${index}`}>
                                            {index > 0 && <span class="pg-breadcrumbs__sep" aria-hidden="true">/</span>}
                                            {crumb.to && !last ? (
                                                <a href={crumb.to} onClick={(event: MouseEvent) => navigate(crumb.to, event)}>
                                                    {crumb.label}
                                                </a>
                                            ) : (
                                                <span aria-current={last ? "page" : undefined}>{crumb.label}</span>
                                            )}
                                        </li>
                                    );
                                })}
                            </ol>
                        </nav>
                    )}
                    <div class="pg-page-header__title-row">
                        <h1 class="pg-page-title">{props.title}</h1>
                        {props.badge && (
                            <PgStatusBadge
                                status={props.badge}
                                label={props.badgeLabel || undefined}
                                toneOverride={props.badgeTone}
                            />
                        )}
                    </div>
                    {props.subtitle && <p class="pg-page-subtitle">{props.subtitle}</p>}
                </div>
                <div class="pg-page-header__actions">
                    {config.helpButton?.()}
                    {slots.help?.()}
                    {props.helpChapterId && props.onOpenHelp && (
                        <PgButton
                            variant="outlined"
                            size="sm"
                            prependIcon="mdi-book-open-page-variant-outline"
                            onClick={() => props.onOpenHelp?.(props.helpChapterId)}
                            ariaLabel={t("SOP & Help")}
                        >
                            {t("SOP & Help")}
                        </PgButton>
                    )}
                    {createSlot("default")}
                </div>
            </header>
        );
    },
    {
        props: {
            title: { type: String, required: true },
            subtitle: { type: String, default: "" },
            badge: { type: String, default: "" },
            badgeLabel: { type: String, default: "" },
            badgeTone: { type: String, default: "neutral" },
            breadcrumbs: { type: Array as () => PgBreadcrumb[], default: () => [] },
            helpChapterId: { type: String, default: "" },
            onOpenHelp: { type: Function as unknown as () => ((chapterId: string) => void) | undefined, default: undefined },
        },
        slots: ["default", "help"],
    },
);

export const PageHeader = PgPageHeader;

/** Small section title used above groups of cards/fields. */
export const PgSubHeader = dc(
    (props: { title?: string; subtitle?: string }, _expose, { slots }) => () => (
        <div class="pg-subheader">
            <div>
                {props.title && <h2 class="pg-subheader__title">{props.title}</h2>}
                {props.subtitle && <p class="pg-subheader__subtitle">{props.subtitle}</p>}
            </div>
            {slots.default?.()}
        </div>
    ),
    { props: { title: { type: String, default: "" }, subtitle: { type: String, default: "" } } },
);

export const SubHeader = PgSubHeader;

/** Plain typography surface (replaces `ThemedText`). */
export const PgText = dc(
    (props: { type?: string; as?: string; muted?: boolean }, _expose, { attrs, slots }) => () => {
        const tag = props.as ?? "span";
        return (
            <tag
                {...attrs}
                class={[
                    "pg-text",
                    props.type === "defaultSemiBold" ? "pg-text--semibold" : "",
                    props.type === "title" ? "pg-text--title" : "",
                    props.muted ? "pg-text--muted" : "",
                    attrs.class,
                ]
                    .filter(Boolean)
                    .join(" ")}
            >
                {slots.default?.()}
            </tag>
        );
    },
    { props: { type: { type: String, default: "" }, as: { type: String, default: "span" }, muted: { type: Boolean, default: false } }, inheritAttrs: true },
);

export const ThemedText = PgText;

/** Plain layout surface (replaces `ThemedView`). */
export const PgView = dc(
    (_props, _expose, { attrs, slots }) => () => (
        <div {...attrs} class={["pg-view", attrs.class].filter(Boolean).join(" ")}>
            {slots.default?.()}
        </div>
    ),
    { inheritAttrs: true },
);

export const ThemedView = PgView;
