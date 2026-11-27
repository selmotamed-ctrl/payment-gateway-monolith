import { createSlot } from "vue";
import { dc } from "../lib/dc";

/** Page canvas: max width, desktop/mobile padding and a 28px section rhythm. */
export const PgPage = dc(
    (_props, _expose, { attrs, slots }) => () => (
        <div {...attrs} class={["pg-page", attrs.class].filter(Boolean).join(" ")}>
            {slots.default?.()}
        </div>
    ),
    { inheritAttrs: true },
);

export const ScreenContainer = PgPage;

/** Vertical stack with the shared gap scale. */
export const PgStack = dc(
    (props: { gap?: string; inline?: boolean; wrap?: boolean }, _expose, { attrs, slots }) => () => (
        <div
            {...attrs}
            class={[
                props.inline ? "pg-inline" : "pg-stack",
                props.gap === "lg" ? "pg-stack--lg" : props.gap === "sm" ? "pg-stack--sm" : "",
                props.wrap ? "pg-inline--wrap" : "",
                attrs.class,
            ]
                .filter(Boolean)
                .join(" ")}
        >
            {slots.default?.()}
        </div>
    ),
    { props: { gap: { type: String, default: "" }, inline: { type: Boolean, default: false }, wrap: { type: Boolean, default: false } }, inheritAttrs: true },
);

/** Centred surface used by auth and loading screens. */
export const PgCenter = dc(
    (_props, _expose, { attrs, slots }) => () => (
        <div {...attrs} class={["pg-center", attrs.class].filter(Boolean).join(" ")}>
            {slots.default?.()}
        </div>
    ),
    { inheritAttrs: true },
);

export const CenterView = PgCenter;

/** 1/2/3-column responsive form grid with guaranteed 20px gaps. */
export const PgFormGrid = dc(
    (props: { columns?: number }, _expose, { attrs, slots }) => () => (
        <div {...attrs} class={["pg-form-grid", attrs.class].filter(Boolean).join(" ")}>
            {slots.default?.()}
        </div>
    ),
    { props: { columns: { type: Number, default: 2 } }, inheritAttrs: true },
);

export const PgFormCol = dc(
    (props: { span?: number }, _expose, { attrs, slots }) => () => (
        <div {...attrs} class={[`pg-form-col-${props.span ?? 12}`, attrs.class].filter(Boolean).join(" ")}>
            {slots.default?.()}
        </div>
    ),
    { props: { span: { type: Number, default: 12 } }, inheritAttrs: true },
);

/** Unified card: 24px body, 18/24 header, 14/24 footer. */
export const PgCard = dc(
    (props: Record<string, any>, _expose, { attrs, slots }) => () => {
        const interactive = typeof props.onClick === "function" || typeof (attrs as any).onClick === "function";
        const tone = props.color && ["error", "warning", "success", "info", "danger"].includes(props.color) ? props.color : "";
        return (
            <div
                {...attrs}
                class={[
                    "pg-card",
                    props.noPadding ? "pg-card--flush" : "",
                    tone ? `pg-card--tone-${tone}` : "",
                    interactive ? "pg-card--interactive" : "",
                    attrs.class,
                ]
                    .filter(Boolean)
                    .join(" ")}
                role={interactive && !attrs.role ? "button" : attrs.role}
                tabindex={interactive && attrs.tabindex === undefined ? 0 : attrs.tabindex}
                onClick={(event: MouseEvent) => {
                    (attrs.onClick as ((event: MouseEvent) => void) | undefined)?.(event);
                    props.onClick?.();
                }}
                onKeydown={(event: KeyboardEvent) => {
                    if (!interactive) return;
                    if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        props.onClick?.();
                    }
                }}
            >
                {(props.title || props.subtitle || slots.headerActions) && (
                    <div class="pg-card__header">
                        <div>
                            {props.title && <h2 class="pg-card__title">{props.title}</h2>}
                            {props.subtitle && <p class="pg-card__subtitle">{props.subtitle}</p>}
                        </div>
                        {slots.headerActions && <div class="pg-inline">{slots.headerActions()}</div>}
                    </div>
                )}
                <div class="pg-card__body">{slots.default?.()}</div>
                {slots.footer && <div class="pg-card__footer">{slots.footer()}</div>}
            </div>
        );
    },
    {
        props: {
            title: { type: String, default: "" },
            subtitle: { type: String, default: "" },
            noPadding: { type: Boolean, default: false },
            variant: { type: String, default: "" },
            color: { type: String, default: "" },
            bodyGap: { type: String, default: "" },
            bodyPadding: { type: String, default: "" },
            onClick: { type: Function as unknown as () => (() => void) | undefined, default: undefined },
        },
        inheritAttrs: true,
    },
);

export const SurfaceCard = PgCard;

/** Section header + content with optional collapse. */
export const PgSection = dc(
    (props: { title?: string; description?: string; collapsible?: boolean; modelValue?: boolean }, _expose, { emit, slots }) => () => (
        <section class="pg-section">
            {(props.title || props.description || slots.actions) && (
                <div class="pg-section-header">
                    <div>
                        {props.title && <h2 class="pg-section-title">{props.title}</h2>}
                        {props.description && <p class="pg-section-description">{props.description}</p>}
                    </div>
                    {(slots.actions || props.collapsible) && (
                        <div class="pg-inline">
                            {slots.actions?.()}
                            {props.collapsible && (
                                <button
                                    type="button"
                                    class="pg-section__toggle"
                                    aria-expanded={props.modelValue === false ? "false" : "true"}
                                    onClick={() => emit?.("update:modelValue", props.modelValue === false)}
                                >
                                    {props.modelValue === false ? "Expand" : "Collapse"}
                                </button>
                            )}
                        </div>
                    )}
                </div>
            )}
            {props.modelValue === false ? null : createSlot("default")}
        </section>
    ),
    {
        props: {
            title: { type: String, default: "" },
            description: { type: String, default: "" },
            collapsible: { type: Boolean, default: false },
            modelValue: { type: Boolean, default: true },
        },
        emits: ["update:modelValue"],
        slots: ["default", "actions"],
    },
);
