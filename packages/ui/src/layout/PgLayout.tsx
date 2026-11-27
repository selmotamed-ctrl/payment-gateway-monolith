import { useId } from "vue";
import { dc } from "../lib/dc";

type PageSize = "narrow" | "default" | "wide" | "fluid";

const pageSizeClass = (size: string): string => (size && size !== "default" ? `pg-page--${size}` : "");

/**
 * Page canvas: centered responsive container with the global 2026 spacing
 * policy. Padding is delegated entirely to `parts/layout.css` (the layout
 * policy tokens) so pages never invent outer gutters. A nested `PgPage`
 * automatically collapses its padding to zero.
 */
export const PgPage = dc(
    (props: { size?: PageSize | string; gap?: string }, _expose, { attrs, slots }) => () => (
        <div
            {...attrs}
            class={[
                "pg-page",
                // Legacy alias kept for portal CSS and existing layout tests.
                "pg-screen-container",
                pageSizeClass(props.size ?? "default"),
                `pg-page--gap-${props.gap ?? "md"}`,
                attrs.class,
            ]
                .filter(Boolean)
                .join(" ")}
        >
            {slots.default?.()}
        </div>
    ),
    {
        props: {
            size: { type: String, default: "default" },
            gap: { type: String, default: "md" },
        },
        inheritAttrs: true,
    },
);

export const ScreenContainer = PgPage;

/** Vertical/horizontal flex stack with the shared gap scale. */
export const PgStack = dc(
    (
        props: {
            gap?: string;
            direction?: string;
            inline?: boolean;
            wrap?: boolean;
            align?: string;
            justify?: string;
        },
        _expose,
        { attrs, slots },
    ) => () => {
        const row = props.direction === "row" || props.inline === true;
        return (
            <div
                {...attrs}
                class={[
                    "pg-stack",
                    row ? "pg-stack--row" : "",
                    props.gap ? `pg-stack--gap-${props.gap}` : "",
                    props.wrap ? "pg-stack--wrap" : "",
                    attrs.class,
                ]
                    .filter(Boolean)
                    .join(" ")}
                style={[
                    {
                        alignItems: props.align || undefined,
                        justifyContent: props.justify || undefined,
                        flexWrap: props.wrap ? "wrap" : undefined,
                    },
                    (attrs as { style?: any }).style,
                ]}
            >
                {slots.default?.()}
            </div>
        );
    },
    {
        props: {
            gap: { type: String, default: "" },
            direction: { type: String, default: "column" },
            inline: { type: Boolean, default: false },
            wrap: { type: Boolean, default: false },
            align: { type: String, default: "" },
            justify: { type: String, default: "" },
        },
        inheritAttrs: true,
    },
);

/** Centered surface used by auth, empty and loading screens. */
export const PgCenter = dc(
    (props: { minHeight?: number | string }, _expose, { attrs, slots }) => () => (
        <div
            {...attrs}
            class={["pg-center", attrs.class].filter(Boolean).join(" ")}
            style={[
                props.minHeight !== undefined
                    ? {
                          minHeight:
                              typeof props.minHeight === "number" ? `${props.minHeight}px` : props.minHeight,
                      }
                    : undefined,
                (attrs as { style?: any }).style,
            ]}
        >
            {slots.default?.()}
        </div>
    ),
    {
        props: { minHeight: { type: [Number, String], default: undefined } },
        inheritAttrs: true,
    },
);

export const CenterView = PgCenter;

/** 12-column responsive form grid (columns collapse to one below 768px). */
export const PgFormGrid = dc(
    (props: { columns?: number; gap?: string }, _expose, { attrs, slots }) => () => (
        <div
            {...attrs}
            class={[
                "pg-form-grid",
                props.gap ? `pg-form-grid--gap-${props.gap}` : "",
                attrs.class,
            ]
                .filter(Boolean)
                .join(" ")}
            style={[
                { "--pg-form-columns": String(props.columns ?? 12) },
                (attrs as { style?: any }).style,
            ]}
        >
            {slots.default?.()}
        </div>
    ),
    {
        props: {
            columns: { type: Number, default: 12 },
            gap: { type: String, default: "md" },
        },
        inheritAttrs: true,
    },
);

const colClass = (prefix: string, value: unknown): string =>
    typeof value === "number" && value >= 1 && value <= 12 ? `pg-form-col--${prefix}${value}` : "";

export const PgFormCol = dc(
    (props: { span?: number; sm?: number; md?: number; lg?: number }, _expose, { attrs, slots }) => () => (
        <div
            {...attrs}
            class={[
                "pg-form-col",
                colClass("span-", props.span ?? 12),
                colClass("sm-", props.sm),
                colClass("md-", props.md),
                colClass("lg-", props.lg),
                attrs.class,
            ]
                .filter(Boolean)
                .join(" ")}
        >
            {slots.default?.()}
        </div>
    ),
    {
        props: {
            span: { type: Number, default: 12 },
            sm: { type: Number, default: undefined },
            md: { type: Number, default: undefined },
            lg: { type: Number, default: undefined },
        },
        inheritAttrs: true,
    },
);

const cardTone = (tone: string, color: string): string => {
    // `tone` defaults to "default"; a caller-supplied `color` must still win.
    const value = (tone && tone !== "default" ? tone : "") || color;
    if (!value || value === "default") return "";
    if (value === "error") return "danger";
    if (value === "success") return "success";
    if (["subtle", "info", "warning", "danger"].includes(value)) return value;
    return "";
};

/** True when the event target is an actionable child inside the card. */
const interactiveChild = (event: Event): boolean => {
    const target = event.target as HTMLElement | null;
    if (!target || target === event.currentTarget) return false;
    const control = target.closest?.("a,button,input,select,textarea,[role='button'],[role='link']");
    return Boolean(control && control !== event.currentTarget);
};

/**
 * Canonical elevated surface. Header/body/footer rhythm comes from the layout
 * policy; `divided` owns the hairlines, `padding` owns the body inset and
 * `interactive` turns the whole surface into a focusable action.
 */
export const PgCard = dc(
    (props: Record<string, any>, _expose, { attrs, slots }) => {
        const interactive = (): boolean =>
            Boolean(
                props.interactive ||
                    typeof props.onClick === "function" ||
                    typeof (attrs as { onClick?: unknown }).onClick === "function",
            );

        const activate = (event: MouseEvent) => {
            if (props.disabled) return;
            if (interactiveChild(event)) return;
            (attrs as { onClick?: (event: MouseEvent) => void }).onClick?.(event);
            props.onClick?.(event);
        };

        const onKeydown = (event: KeyboardEvent) => {
            if (!interactive() || props.disabled) return;
            if (event.target !== event.currentTarget) return;
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            (attrs as { onClick?: (event: MouseEvent) => void }).onClick?.(event as unknown as MouseEvent);
            props.onClick?.(event as unknown as MouseEvent);
        };

        const hasHeader = (): boolean =>
            Boolean(
                slots.header ||
                    slots.title ||
                    slots.subtitle ||
                    slots.actions ||
                    slots.headerActions ||
                    props.title ||
                    props.subtitle,
            );

        return () => {
            const action = interactive();
            const tone = cardTone(props.tone, props.color) || (props.subtle ? "subtle" : "");
            const padding = props.padding || (props.noPadding ? "none" : "md");
            const requestedVariant = String(props.variant ?? "").trim();
            const variant =
                requestedVariant === "tonal" || requestedVariant === "soft"
                    ? "tone-subtle"
                    : requestedVariant === "outlined" || requestedVariant === "flat" || requestedVariant === "elevated"
                      ? requestedVariant
                      : "";
            const bodyStyle: Record<string, string> = {};
            if (props.bodyPadding) bodyStyle.padding = String(props.bodyPadding);
            if (props.bodyGap) {
                bodyStyle.display = "flex";
                bodyStyle.flexDirection = "column";
                bodyStyle.gap = String(props.bodyGap);
            }
            return (
                <div
                    {...attrs}
                    class={[
                        "pg-card",
                        `pg-card--pad-${padding}`,
                        tone ? `pg-card--tone-${tone}` : "",
                        !tone && variant ? `pg-card--${variant}` : "",
                        action ? "pg-card--interactive" : "",
                        props.divided ? "pg-card--divided" : "",
                        props.disabled ? "pg-card--disabled" : "",
                        attrs.class,
                    ]
                        .filter(Boolean)
                        .join(" ")}
                    role={action ? (attrs.role ?? "button") : attrs.role}
                    tabindex={action ? (attrs.tabindex ?? (props.disabled ? -1 : 0)) : attrs.tabindex}
                    aria-disabled={action && props.disabled ? "true" : attrs["aria-disabled"]}
                    onClick={activate}
                    onKeydown={onKeydown}
                >
                    {hasHeader() && (
                        <div class="pg-card__header">
                            <div class="pg-card__heading">
                                {slots.header
                                    ? slots.header()
                                    : [
                                          slots.title
                                              ? slots.title()
                                              : props.title
                                                ? <h2 class="pg-card__title">{props.title}</h2>
                                                : null,
                                          slots.subtitle
                                              ? slots.subtitle()
                                              : props.subtitle
                                                ? <p class="pg-card__subtitle">{props.subtitle}</p>
                                                : null,
                                      ]}
                            </div>
                            {(slots.actions || slots.headerActions) && (
                                <div class="pg-card__actions pg-inline">
                                    {slots.actions?.()}
                                    {slots.headerActions?.()}
                                </div>
                            )}
                        </div>
                    )}
                    <div class="pg-card__body" style={Object.keys(bodyStyle).length ? bodyStyle : undefined}>
                        {slots.default?.()}
                    </div>
                    {slots.footer && <div class="pg-card__footer">{slots.footer()}</div>}
                </div>
            );
        };
    },
    {
        props: {
            title: { type: String, default: "" },
            subtitle: { type: String, default: "" },
            padding: { type: String, default: "" },
            noPadding: { type: Boolean, default: false },
            variant: { type: String, default: "" },
            color: { type: String, default: "" },
            tone: { type: String, default: "default" },
            subtle: { type: Boolean, default: false },
            divided: { type: Boolean, default: false },
            interactive: { type: Boolean, default: false },
            disabled: { type: Boolean, default: false },
            bodyGap: { type: String, default: "" },
            bodyPadding: { type: String, default: "" },
            onClick: {
                type: Function as unknown as () => ((event?: MouseEvent) => void) | undefined,
                default: undefined,
            },
        },
        inheritAttrs: true,
    },
);

export const SurfaceCard = PgCard;

/** Section with an optional semantic header, actions and collapsible body. */
export const PgSection = dc(
    (
        props: {
            title?: string;
            subtitle?: string;
            description?: string;
            gap?: string;
            collapsible?: boolean;
            modelValue?: boolean;
        },
        _expose,
        { attrs, emit, slots },
    ) => {
        const titleId = useId();
        const bodyId = `${titleId}-body`;
        const expanded = (): boolean => props.modelValue !== false;

        return () => (
            <section
                {...attrs}
                class={[
                    "pg-section",
                    props.gap ? `pg-section--gap-${props.gap}` : "",
                    attrs.class,
                ]
                    .filter(Boolean)
                    .join(" ")}
                aria-labelledby={props.title ? titleId : attrs["aria-labelledby"]}
            >
                {(props.title ||
                    props.subtitle ||
                    props.description ||
                    slots.title ||
                    slots.actions ||
                    props.collapsible) && (
                    <div class="pg-section-header pg-section__header">
                        <div class="pg-section__heading">
                            {slots.title
                                ? slots.title()
                                : props.title && (
                                      <h2 id={titleId} class="pg-section-title pg-section__title">
                                          {props.title}
                                      </h2>
                                  )}
                            {(props.subtitle || props.description) && (
                                <p class="pg-section-description pg-section__subtitle">
                                    {props.subtitle || props.description}
                                </p>
                            )}
                        </div>
                        {(slots.actions || props.collapsible) && (
                            <div class="pg-section__actions pg-inline">
                                {slots.actions?.()}
                                {props.collapsible && (
                                    <button
                                        type="button"
                                        class="pg-section__toggle"
                                        aria-expanded={expanded() ? "true" : "false"}
                                        aria-controls={bodyId}
                                        onClick={() => emit?.("update:modelValue", !expanded())}
                                    >
                                        {expanded() ? "Collapse" : "Expand"}
                                    </button>
                                )}
                            </div>
                        )}
                    </div>
                )}
                {expanded() && (
                    <div id={bodyId} class="pg-section__body">
                        {slots.default?.()}
                    </div>
                )}
            </section>
        );
    },
    {
        props: {
            title: { type: String, default: "" },
            subtitle: { type: String, default: "" },
            description: { type: String, default: "" },
            gap: { type: String, default: "" },
            collapsible: { type: Boolean, default: false },
            modelValue: { type: Boolean, default: true },
        },
        emits: ["update:modelValue"],
        inheritAttrs: true,
    },
);
