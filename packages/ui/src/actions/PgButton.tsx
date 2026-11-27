import { computed } from "vue";
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
    | "plain"
    | "outlined-danger"
    | "text-danger"
    | "outlined-success"
    | "outlined-warning"
    | "text-warning";

export type PgButtonSize = "sm" | "md" | "lg" | "x-small" | "small" | "default" | "large" | "x-large";

const CANONICAL_VARIANTS = new Set([
    "primary",
    "secondary",
    "outlined",
    "tonal",
    "ghost",
    "text",
    "danger",
    "outlined-danger",
    "text-danger",
    "outlined-success",
    "outlined-warning",
    "text-warning",
]);
const WARNED_ICON_ONLY = new Set<string>();

const devConsole = (): ((...args: any[]) => void) | null => {
    try {
        const dev = Boolean((import.meta as any).env?.DEV);
        return dev && typeof console !== "undefined" ? console.warn.bind(console) : null;
    } catch {
        return null;
    }
};

/**
 * Resolves the canonical 2026 hierarchy from the canonical names **and** the
 * Vuetify-era spellings still present in the portals (`flat`, `soft`, `plain`,
 * `elevated`, `color="error"`, `danger`). Unknown names fall back to the safe
 * `secondary` tier so a typo can never render an unstyled button.
 */
export const resolveButtonVariant = (input: {
    variant?: string;
    color?: string;
    danger?: boolean;
}): string => {
    const variant = (input.variant ?? "").trim();
    const color = (input.color ?? "").trim();
    const danger = input.danger === true || color === "error" || color === "danger";

    if (danger) {
        // `tonal` is the quiet utility tier. A danger utility (Review attention,
        // Reject, Repair, Lift hold) must be an outlined danger control, never a
        // filled red block. Only an explicit danger/flat button stays filled.
        if (variant === "outlined" || variant === "secondary" || variant === "tonal" || variant === "soft")
            return "outlined-danger";
        if (variant === "text" || variant === "ghost" || variant === "plain") return "text-danger";
        return "danger";
    }
    if (color === "success") {
        if (variant === "outlined" || variant === "secondary" || variant === "tonal" || variant === "soft")
            return "outlined-success";
        if (variant === "text" || variant === "ghost" || variant === "plain") return "text";
        return "primary";
    }
    if (color === "warning") {
        if (variant === "outlined" || variant === "secondary" || variant === "tonal" || variant === "soft")
            return "outlined-warning";
        if (variant === "text" || variant === "ghost" || variant === "plain") return "text-warning";
        return "primary";
    }
    if (variant === "elevated") return "primary";
    if (variant === "soft") return "tonal";
    if (variant === "plain") return "ghost";
    if (variant === "flat") return "primary";
    if (CANONICAL_VARIANTS.has(variant)) return variant;
    if (color === "primary") return "primary";
    if (!variant) return "secondary";
    return "secondary";
};

const canNavigate = (to: any): boolean => to !== undefined && to !== null && to !== "";

/**
 * The single button primitive for every portal.
 *
 * Canonical 2026 API plus the Vuetify-era spellings the pages already use
 * (`variant="flat"`, `icon`, `prependIcon`, `to`, `aria-label`, …).
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
            pill?: boolean;
            type?: "button" | "submit" | "reset";
            to?: any;
            href?: string;
            target?: string;
            ariaLabel?: string;
            title?: string;
            danger?: boolean;
            height?: number | string;
        },
        _expose,
        { attrs, slots, emit },
    ) => {
        const config = usePgUiConfig();
        const size = computed(() => normalizeSize(props.size) ?? (props.density === "compact" ? "sm" : "md"));
        const variant = computed(() =>
            resolveButtonVariant({ variant: props.variant, color: props.color, danger: props.danger }),
        );
        const iconOnly = computed(() => props.icon === true || (typeof props.icon === "string" && props.icon.length > 0));
        const inlineIcon = computed(() =>
            typeof props.icon === "string" && props.icon.trim() ? props.icon.trim() : "",
        );
        const pill = computed(() => props.pill === true || props.rounded === "pill" || props.rounded === "circle" || props.rounded === true);
        const iconSize = computed(() => (size.value === "sm" ? 15 : size.value === "lg" ? 18 : 16));
        const buttonStyle = () => {
            const height = props.height;
            const heightStyle =
                height === undefined || height === null || height === ""
                    ? undefined
                    : { height: typeof height === "number" ? `${height}px` : String(height) };
            return [heightStyle, (attrs as { style?: any }).style];
        };
        const accessibleLabel = (): string | undefined =>
            props.ariaLabel ||
            (attrs["aria-label"] as string | undefined) ||
            (iconOnly.value ? props.title || (attrs.title as string | undefined) : undefined);

        const warnMissingLabel = () => {
            if (!iconOnly.value || accessibleLabel()) return;
            const key = inlineIcon.value || "icon-only";
            if (WARNED_ICON_ONLY.has(key)) return;
            WARNED_ICON_ONLY.add(key);
            devConsole()?.(
                `[@pg/ui] PgButton icon-only "${key}" has no ariaLabel/title. ` +
                    "Provide an accessible name so assistive technology can announce it.",
            );
        };

        return () => {
            warnMissingLabel();
            const routeLink = !props.href && canNavigate(props.to);
            const linkHref = () =>
                (typeof props.href === "string" && props.href) ||
                (routeLink ? config.resolveHref?.(props.to) || (typeof props.to === "string" ? props.to : "") : "");
            const tag = linkHref() || routeLink ? "a" : "button";
            const labelContent = () => (props.label ? props.label : slots.default?.());

            const handleClick = (event: MouseEvent) => {
                if (props.disabled || props.loading) {
                    event.preventDefault();
                    event.stopImmediatePropagation();
                    event.stopPropagation();
                    return;
                }
                (attrs.onClick as ((event: MouseEvent) => void) | undefined)?.(event);
                emit?.("click", event);
                if (props.href || !canNavigate(props.to) || event.defaultPrevented) return;
                // Ctrl/Cmd/Shift/Alt + click and middle click must keep the
                // native anchor behaviour so the browser opens a new tab.
                const opensNewTab =
                    event.metaKey ||
                    event.ctrlKey ||
                    event.shiftKey ||
                    event.altKey ||
                    event.button !== 0 ||
                    props.target === "_blank";
                if (opensNewTab) return;
                event.preventDefault();
                if (config.navigate) void config.navigate(props.to);
                else if (typeof window !== "undefined" && typeof props.to === "string") window.location.assign(props.to);
            };

            if (tag === "a") {
                return (
                    <a
                        class={[
                            "pg-btn",
                            `pg-btn--${size.value}`,
                            `pg-btn--${variant.value}`,
                            iconOnly.value ? "pg-btn--icon" : "",
                            props.block ? "pg-btn--block" : "",
                            pill.value ? "pg-btn--pill" : "",
                            props.loading ? "pg-btn--loading" : "",
                            attrs.class,
                        ]
                            .filter(Boolean)
                            .join(" ")}
                        href={linkHref() || undefined}
                        target={props.target || undefined}
                        rel={props.target === "_blank" ? "noreferrer" : undefined}
                        draggable="false"
                        id={attrs.id}
                        role={attrs.role}
                        tabindex={attrs.tabindex}
                        title={props.title || attrs.title || undefined}
                        style={buttonStyle()}
                        aria-label={accessibleLabel()}
                        aria-busy={props.loading ? "true" : undefined}
                        aria-disabled={props.disabled || props.loading ? "true" : undefined}
                        aria-expanded={attrs["aria-expanded"]}
                        aria-haspopup={attrs["aria-haspopup"]}
                        aria-controls={attrs["aria-controls"]}
                        aria-pressed={attrs["aria-pressed"]}
                        data-pg-btn={variant.value}
                        onClick={handleClick}
                    >
                        {props.loading ? <span class="pg-btn__spinner" aria-hidden="true" /> : null}
                        {!props.loading && typeof props.icon === "string" && props.icon.trim() ? (
                            <PgIcon icon={props.icon} size={iconSize.value} />
                        ) : null}
                        {!props.loading && props.prependIcon ? (
                            <PgIcon icon={props.prependIcon} size={iconSize.value} />
                        ) : null}
                        {!props.loading && slots.leading ? slots.leading() : null}
                        <span class="pg-btn__label">{labelContent()}</span>
                        {slots.trailing ? slots.trailing() : null}
                        {props.appendIcon ? <PgIcon icon={props.appendIcon} size={iconSize.value} /> : null}
                    </a>
                );
            }
            return (
                <button
                    class={[
                        "pg-btn",
                        `pg-btn--${size.value}`,
                        `pg-btn--${variant.value}`,
                        iconOnly.value ? "pg-btn--icon" : "",
                        props.block ? "pg-btn--block" : "",
                        pill.value ? "pg-btn--pill" : "",
                        props.loading ? "pg-btn--loading" : "",
                        attrs.class,
                    ]
                        .filter(Boolean)
                        .join(" ")}
                    id={attrs.id}
                    role={attrs.role}
                    tabindex={attrs.tabindex}
                    title={props.title || attrs.title || undefined}
                    style={buttonStyle()}
                    aria-label={accessibleLabel()}
                    aria-busy={props.loading ? "true" : undefined}
                    aria-disabled={props.disabled || props.loading ? "true" : undefined}
                    aria-expanded={attrs["aria-expanded"]}
                    aria-haspopup={attrs["aria-haspopup"]}
                    aria-controls={attrs["aria-controls"]}
                    aria-pressed={attrs["aria-pressed"]}
                    data-pg-btn={variant.value}
                    type={props.type ?? "button"}
                    disabled={props.disabled || props.loading}
                    onClick={handleClick}
                >
                    {props.loading ? <span class="pg-btn__spinner" aria-hidden="true" /> : null}
                    {!props.loading && typeof props.icon === "string" && props.icon.trim() ? (
                        <PgIcon icon={props.icon} size={iconSize.value} />
                    ) : null}
                    {!props.loading && props.prependIcon ? (
                        <PgIcon icon={props.prependIcon} size={iconSize.value} />
                    ) : null}
                    {!props.loading && slots.leading ? slots.leading() : null}
                    <span class="pg-btn__label">{labelContent()}</span>
                    {slots.trailing ? slots.trailing() : null}
                    {props.appendIcon ? <PgIcon icon={props.appendIcon} size={iconSize.value} /> : null}
                </button>
            );
        };
    },
    {
        props: {
            variant: { type: String, default: "" },
            color: { type: String, default: "" },
            size: { type: String, default: "" },
            density: { type: String, default: "" },
            icon: { type: [Boolean, String], default: false },
            prependIcon: { type: String, default: "" },
            appendIcon: { type: String, default: "" },
            label: { type: String, default: "" },
            loading: { type: Boolean, default: false },
            disabled: { type: Boolean, default: false },
            block: { type: Boolean, default: false },
            rounded: { type: [Boolean, String], default: false },
            pill: { type: Boolean, default: false },
            type: { type: String, default: "button" },
            to: { type: [String, Object], default: undefined },
            href: { type: String, default: "" },
            target: { type: String, default: "" },
            ariaLabel: { type: String, default: "" },
            title: { type: String, default: "" },
            danger: { type: Boolean, default: false },
            height: { type: [Number, String], default: undefined },
        },
        emits: ["click"],
        inheritAttrs: true,
    },
);

export const VBtn = PgButton;
export const Button = PgButton;
