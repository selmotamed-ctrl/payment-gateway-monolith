import { useRouter } from "vue-router";
import { dc } from "../lib/dc";
import { usePgUiConfig } from "../lib/config";
import { useLocale } from "../lib/locale";
import { PgButton } from "../actions/PgButton";
import { PgStatusBadge } from "../feedback/PgStatusBadge";

export interface PgBreadcrumb {
    label: string;
    to?: string | Record<string, unknown>;
}

/**
 * Page header: breadcrumbs, primary `<h1>` title, optional status badge,
 * subtitle and an end-aligned action cluster. The automatic admin Guide help
 * button is supplied by the host's `help` slot, so this component stays
 * host-agnostic.
 */
export const PgPageHeader = dc(
    (props: Record<string, any>, _expose, { attrs, slots }) => {
        const { t } = useLocale();
        const config = usePgUiConfig();
        const router = useRouter();
        const crumbLabel = (): string => props.breadcrumbLabel || t("Breadcrumb");

        const navigate = (to: any, event: MouseEvent) => {
            event.preventDefault();
            const target = config.navigate ?? ((destination: any) => router?.push(destination));
            void target?.(to);
        };

        const hrefFor = (to: any): string => {
            if (!to) return "";
            if (typeof to === "string") return to;
            const configured = config.resolveHref?.(to);
            if (configured) return configured;
            try {
                return router?.resolve?.(to)?.href ?? "";
            } catch {
                return "";
            }
        };

        const openHelp = () => {
            if (!props.helpChapterId) return;
            props.onOpenHelp?.(props.helpChapterId);
        };

        return () => (
            <header {...attrs} class={["pg-page-header", attrs.class].filter(Boolean).join(" ")}>
                <div class="pg-page-header__main">
                    {Array.isArray(props.breadcrumbs) && props.breadcrumbs.length > 0 && (
                        <nav class="pg-breadcrumbs" aria-label={crumbLabel()}>
                            <ol>
                                {props.breadcrumbs.map((crumb: PgBreadcrumb, index: number) => {
                                    const last = index === props.breadcrumbs.length - 1;
                                    const linkable = Boolean(crumb.to) && !last;
                                    return (
                                        <li key={`${crumb.label}-${index}`}>
                                            {index > 0 && (
                                                <span class="pg-breadcrumbs__sep" aria-hidden="true">
                                                    /
                                                </span>
                                            )}
                                            {linkable ? (
                                                <a
                                                    href={hrefFor(crumb.to)}
                                                    onClick={(event: MouseEvent) => navigate(crumb.to, event)}
                                                >
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
                        <h1 class="pg-page-title">{slots.title ? slots.title() : props.title}</h1>
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
                            onClick={openHelp}
                            ariaLabel={t("SOP & Help")}
                        >
                            {t("SOP & Help")}
                        </PgButton>
                    )}
                    {slots.actions?.()}
                    {slots.default?.()}
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
            breadcrumbLabel: { type: String, default: "" },
            helpChapterId: { type: String, default: "" },
            onOpenHelp: {
                type: Function as unknown as () => ((chapterId: string) => void) | undefined,
                default: undefined,
            },
        },
        slots: ["default", "actions", "help", "title"],
        inheritAttrs: true,
    },
);

export const PageHeader = PgPageHeader;

/** Small section title used above groups of cards/fields. */
export const PgSubHeader = dc(
    (props: { title?: string; subtitle?: string; divided?: boolean }, _expose, { attrs, slots }) => () => (
        <div
            {...attrs}
            class={["pg-subheader", props.divided ? "pg-subheader--divided" : "", attrs.class]
                .filter(Boolean)
                .join(" ")}
        >
            <div class="pg-subheader__heading">
                {slots.title
                    ? slots.title()
                    : props.title && <h2 class="pg-subheader__title">{props.title}</h2>}
                {props.subtitle && <p class="pg-subheader__subtitle">{props.subtitle}</p>}
            </div>
            {(slots.actions || slots.default) && (
                <div class="pg-subheader__actions">
                    {slots.actions?.()}
                    {slots.default?.()}
                </div>
            )}
        </div>
    ),
    {
        props: {
            title: { type: String, default: "" },
            subtitle: { type: String, default: "" },
            divided: { type: Boolean, default: false },
        },
        inheritAttrs: true,
    },
);

export const SubHeader = PgSubHeader;

const TEXT_VARIANTS = ["display", "title", "subtitle", "body", "label", "caption", "overline", "mono"];
const TEXT_TONES = [
    "primary",
    "secondary",
    "muted",
    "faint",
    "success",
    "warning",
    "danger",
    "info",
    "brand",
];
const TEXT_WEIGHTS = ["regular", "medium", "semibold", "bold"];

const normalizeVariant = (variant: string, type: string): string => {
    if (variant) return TEXT_VARIANTS.includes(variant) ? variant : "";
    if (type === "title" || type === "subtitle" || type === "mono" || type === "caption" || type === "overline") {
        return type;
    }
    if (type === "defaultSemiBold") return "body";
    return "body";
};

const normalizeTone = (tone: string, color: string, muted: boolean): string => {
    const value = tone || color;
    if (value === "error") return "danger";
    if (value === "primary" || value === "secondary" || value === "muted" || value === "faint") return value;
    if (TEXT_TONES.includes(value)) return value;
    return muted ? "muted" : "primary";
};

const normalizeWeight = (weight: string, type: string): string => {
    if (weight && TEXT_WEIGHTS.includes(weight)) return weight;
    if (type === "defaultSemiBold") return "semibold";
    return "";
};

/**
 * Semantic typography primitive. Variant, tone, weight, truncation and line
 * clamp all resolve to layout-policy classes; `as` selects the semantic tag.
 */
export const PgText = dc(
    (
        props: {
            type?: string;
            variant?: string;
            tone?: string;
            color?: string;
            weight?: string;
            as?: string;
            muted?: boolean;
            truncate?: boolean;
            clamp?: number;
        },
        _expose,
        { attrs, slots },
    ) => {
        return () => {
            const Tag: any = props.as || "span";
            const variant = normalizeVariant(props.variant || "", props.type || "");
            const tone = normalizeTone(props.tone || "", props.color || "", props.muted === true);
            const weight = normalizeWeight(props.weight || "", props.type || "");
            const clamp = typeof props.clamp === "number" && props.clamp > 0 ? props.clamp : 0;
            return (
                <Tag
                    {...attrs}
                    class={[
                        "pg-text",
                        variant ? `pg-text--${variant}` : "",
                        tone ? `pg-text--tone-${tone}` : "",
                        weight ? `pg-text--weight-${weight}` : "",
                        props.muted ? "pg-text--muted" : "",
                        props.truncate ? "pg-text--truncate" : "",
                        clamp ? "pg-text--clamp" : "",
                        attrs.class,
                    ]
                        .filter(Boolean)
                        .join(" ")}
                    style={[
                        clamp ? { "--pg-text-clamp": String(clamp) } : undefined,
                        (attrs as { style?: any }).style,
                    ]}
                >
                    {slots.default?.()}
                </Tag>
            );
        };
    },
    {
        props: {
            type: { type: String, default: "" },
            variant: { type: String, default: "" },
            tone: { type: String, default: "" },
            color: { type: String, default: "" },
            weight: { type: String, default: "" },
            as: { type: String, default: "span" },
            muted: { type: Boolean, default: false },
            truncate: { type: Boolean, default: false },
            clamp: { type: Number, default: undefined },
        },
        inheritAttrs: true,
    },
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
