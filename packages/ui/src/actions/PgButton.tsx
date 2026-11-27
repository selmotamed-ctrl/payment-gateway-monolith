import { computed } from "vue";
import { useRouter } from "vue-router";
import { dc } from "../lib/dc";
import { usePgUiConfig } from "../lib/config";
import { normalizeSize } from "../lib/options";
import { PgIcon } from "./PgIcon";

export type PgButtonVariant =
    | "primary"
    | "flat"
    | "secondary"
    | "tonal"
    | "outlined"
    | "text"
    | "ghost"
    | "danger"
    | "soft"
    | "plain";

export type PgButtonSize = "sm" | "md" | "lg" | "x-small" | "small" | "default" | "large" | "x-large";

const isIconOnly = (attrs: Record<string, any>): boolean =>
    attrs.icon === true || attrs.icon === "" || (typeof attrs.icon === "string" && attrs.icon.startsWith("mdi-"));

const resolvedVariant = (attrs: Record<string, any>): string => {
    if (attrs.color === "error" || attrs.color === "danger" || attrs.danger) {
        if (attrs.variant === "outlined") return "outlined-danger";
        if (attrs.variant === "text") return "text-danger";
        return "danger";
    }
    if (attrs.color === "success") return attrs.variant === "outlined" ? "outlined" : "primary";
    if (attrs.variant === "flat" || attrs.variant === "elevated") return "primary";
    if (attrs.variant === "outlined") return "outlined";
    if (attrs.variant === "text") return "text";
    if (attrs.variant === "plain") return "ghost";
    if (attrs.variant === "tonal") return "tonal";
    if (typeof attrs.variant === "string") return attrs.variant;
    if (attrs.color === "primary") return "primary";
    if (!attrs.variant) return "secondary";
    return "secondary";
};

/**
 * The single button primitive for every portal. Accepts the canonical props and
 * the Vuetify spellings the pages already use (`variant="flat"`,
 * `color="primary"`, `prependIcon`, `to`, …), so a page never needs raw HTML.
 */
export const PgButton = dc(
    (
        props: {
            variant?: string;
            color?: string;
            size?: PgButtonSize;
            density?: string;
            icon?: boolean | string;
            prependIcon?: string;
            appendIcon?: string;
            label?: string;
            loading?: boolean;
            disabled?: boolean;
            block?: boolean;
            rounded?: boolean | string;
            type?: "button" | "submit" | "reset";
            to?: any;
            href?: string;
            target?: string;
            ariaLabel?: string;
            title?: string;
            danger?: boolean;
        },
        _expose,
        { attrs, slots, emit },
    ) => {
        const router = useRouter();
        const config = usePgUiConfig();
        const size = computed(() => normalizeSize(props.size) ?? (props.density === "compact" ? "sm" : "md"));
        const variant = computed(() => resolvedVariant({ ...props, ...attrs }));
        const iconOnly = computed(() => isIconOnly({ ...props, ...attrs }));
        const leading = computed(() => (typeof props.prependIcon === "string" ? props.prependIcon : ""));
        const trailing = computed(() => (typeof props.appendIcon === "string" ? props.appendIcon : ""));
        const inlineIcon = computed(() =>
            typeof props.icon === "string" && props.icon.startsWith("mdi-") ? props.icon : "",
        );

        return () => {
            const href =
                typeof props.href === "string" && props.href
                    ? props.href
                    : props.to
                      ? (config.resolveHref?.(props.to) || safeResolve(router, props.to))
                      : "";
            const tag = href ? "a" : "button";
            const content = () => {
                if (props.label) return props.label;
                return slots.default?.();
            };
            const children = [
                (props.loading || variant.value === "loading") && (
                    <span class="pg-btn__spinner" aria-hidden="true" />
                ),
                inlineIcon.value ? <PgIcon icon={inlineIcon.value} size={size.value === "sm" ? 16 : 18} /> : null,
                leading.value ? <PgIcon icon={leading.value} size={size.value === "sm" ? 16 : 18} /> : null,
                slots.leading ? slots.leading() : null,
                iconOnly.value && !inlineIcon.value && props.icon !== true ? null : null,
                <span class="pg-btn__label">{content()}</span>,
                slots.trailing ? slots.trailing() : null,
                trailing.value ? <PgIcon icon={trailing.value} size={size.value === "sm" ? 16 : 18} /> : null,
            ].filter(Boolean);

            const classes = [
                "pg-btn",
                `pg-btn--${size.value}`,
                `pg-btn--${variant.value}`,
                iconOnly.value ? "pg-btn--icon" : "",
                props.block ? "pg-btn--block" : "",
                props.rounded ? "pg-btn--pill" : "",
                props.loading ? "pg-btn--loading" : "",
                attrs.class,
            ]
                .filter(Boolean)
                .join(" ");
            const label = props.ariaLabel ?? attrs["aria-label"] ?? (iconOnly.value ? props.title ?? undefined : undefined);
            const handleClick = (event: MouseEvent) => {
                if (props.disabled || props.loading) {
                    event.preventDefault();
                    return;
                }
                (attrs.onClick as ((event: MouseEvent) => void) | undefined)?.(event);
                emit?.("click", event);
                if (href && props.to) {
                    event.preventDefault();
                    const target = config.navigate ?? ((to: any) => router?.push(to));
                    void target?.(props.to);
                }
            };

            if (tag === "a") {
                return (
                    <a
                        class={classes}
                        href={href}
                        target={props.target || undefined}
                        rel={props.target === "_blank" ? "noreferrer" : undefined}
                        id={attrs.id}
                        role={attrs.role}
                        tabindex={attrs.tabindex}
                        title={props.title || attrs.title || undefined}
                        style={attrs.style}
                        aria-label={label}
                        aria-busy={props.loading ? true : undefined}
                        aria-disabled={props.disabled || props.loading ? true : undefined}
                        aria-expanded={attrs["aria-expanded"]}
                        aria-haspopup={attrs["aria-haspopup"]}
                        onClick={handleClick}
                    >
                        {children}
                    </a>
                );
            }
            return (
                <button
                    class={classes}
                    type={props.type ?? "button"}
                    disabled={props.disabled || props.loading}
                    id={attrs.id}
                    role={attrs.role}
                    tabindex={attrs.tabindex}
                    title={props.title || attrs.title || undefined}
                    style={attrs.style}
                    aria-label={label}
                    aria-busy={props.loading ? true : undefined}
                    aria-disabled={props.disabled || props.loading ? true : undefined}
                    aria-expanded={attrs["aria-expanded"]}
                    aria-haspopup={attrs["aria-haspopup"]}
                    onClick={handleClick}
                >
                    {children}
                </button>
            );
        };
    },
    {
        props: {
            variant: { type: String, default: "" },
            color: { type: String, default: "" },
            size: { type: String, default: "md" },
            density: { type: String, default: "" },
            icon: { type: [Boolean, String], default: false },
            prependIcon: { type: String, default: "" },
            appendIcon: { type: String, default: "" },
            label: { type: String, default: "" },
            loading: { type: Boolean, default: false },
            disabled: { type: Boolean, default: false },
            block: { type: Boolean, default: false },
            rounded: { type: [Boolean, String], default: false },
            type: { type: String, default: "button" },
            to: { type: [String, Object], default: undefined },
            href: { type: String, default: "" },
            target: { type: String, default: "" },
            ariaLabel: { type: String, default: "" },
            title: { type: String, default: "" },
            danger: { type: Boolean, default: false },
        },
        emits: ["click"],
        inheritAttrs: true,
    },
);

const safeResolve = (router: any, to: any): string => {
    try {
        return router?.resolve?.(to)?.href ?? (typeof to === "string" ? to : "");
    } catch {
        return typeof to === "string" ? to : "";
    }
};

export const VBtn = PgButton;
