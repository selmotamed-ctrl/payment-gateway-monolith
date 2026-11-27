import { useRouter } from "vue-router";
import { dc } from "../lib/dc";
import { usePgUiConfig } from "../lib/config";
import { PgIcon } from "../actions/PgIcon";

/** Root application shell: header row + optional sidebar + scrolling main. */
export const PgApp = dc(
    (_props, _expose, { attrs, slots }) => () => (
        <div {...attrs} class={["pg-app", "v-application", attrs.class].filter(Boolean).join(" ")}>
            {slots.default?.()}
        </div>
    ),
    { inheritAttrs: false },
);

export const VApp = PgApp;

export const PgAppBar = dc(
    (_props, _expose, { attrs, slots }) => () => (
        <header {...attrs} class={["pg-app-bar", attrs.class].filter(Boolean).join(" ")}>
            {slots.default?.()}
        </header>
    ),
    { inheritAttrs: false },
);
export const VAppBar = PgAppBar;

export const PgAppBarTitle = dc(
    (_props, _expose, { attrs, slots }) => () => (
        <div {...attrs} class={["pg-app-bar-title", attrs.class].filter(Boolean).join(" ")}>
            {slots.default?.()}
        </div>
    ),
    { inheritAttrs: false },
);
export const VAppBarTitle = PgAppBarTitle;

export const PgMain = dc(
    (_props, _expose, { attrs, slots }) => () => (
        <main {...attrs} class={["pg-main", attrs.class].filter(Boolean).join(" ")}>
            {slots.default?.()}
        </main>
    ),
    { inheritAttrs: false },
);
export const VMain = PgMain;

export const PgNavigationDrawer = dc(
    (props: { modelValue?: boolean; temporary?: boolean; width?: number }, _expose, { attrs, slots }) => () => (
        <aside
            {...attrs}
            hidden={props.modelValue === false}
            class={[
                "pg-nav-drawer",
                props.temporary ? "pg-nav-drawer--temporary" : "",
                props.modelValue !== false ? "v-navigation-drawer--active" : "",
                attrs.class,
            ]
                .filter(Boolean)
                .join(" ")}
            style={[{ width: props.width ? `${props.width}px` : undefined }, (attrs as { style?: any }).style]}
        >
            <div class="v-navigation-drawer__content">{slots.default?.()}</div>
        </aside>
    ),
    { props: { modelValue: { type: Boolean, default: true }, temporary: { type: Boolean, default: false }, width: { type: Number, default: undefined } }, inheritAttrs: false },
);
export const VNavigationDrawer = PgNavigationDrawer;

export const PgSpacer = dc(() => () => <div class="pg-spacer" />, {});
export const VSpacer = PgSpacer;

export const PgContainer = dc(
    (_props, _expose, { attrs, slots }) => () => (
        <div {...attrs} class={["pg-container", attrs.class].filter(Boolean).join(" ")}>
            {slots.default?.()}
        </div>
    ),
    { inheritAttrs: false },
);
export const VContainer = PgContainer;

export const PgRow = dc(
    (_props, _expose, { attrs, slots }) => () => (
        <div {...attrs} class={["pg-row", attrs.class].filter(Boolean).join(" ")}>
            {slots.default?.()}
        </div>
    ),
    { inheritAttrs: false },
);
export const VRow = PgRow;

export const PgCol = dc(
    (props: { cols?: number }, _expose, { attrs, slots }) => () => (
        <div
            {...attrs}
            class={["pg-col", attrs.class].filter(Boolean).join(" ")}
            style={[
                props.cols ? { flex: `0 0 ${(props.cols / 12) * 100}%`, maxWidth: `${(props.cols / 12) * 100}%` } : undefined,
                (attrs as { style?: any }).style,
            ]}
        >
            {slots.default?.()}
        </div>
    ),
    { props: { cols: { type: Number, default: 0 } }, inheritAttrs: false },
);
export const VCol = PgCol;

export const PgList = dc(
    (_props, _expose, { attrs, slots }) => () => (
        <ul {...attrs} class={["pg-list", attrs.class].filter(Boolean).join(" ")}>
            {slots.default?.()}
        </ul>
    ),
    { inheritAttrs: false },
);
export const VList = PgList;

export const PgListItem = dc(
    (props: { title?: string; subtitle?: string; prependIcon?: string; appendIcon?: string; to?: any; onClick?: (event: MouseEvent) => void }, _expose, { attrs, slots }) => {
        const router = useRouter();
        const config = usePgUiConfig();
        return () => {
            const itemClass = String(attrs.class ?? "")
                .split(/\s+/)
                .filter((value) => value && !["pg-drawer", "pg-nav-drawer", "v-navigation-drawer--active"].includes(value))
                .join(" ");
            const content = (
                <>
                    {props.prependIcon && <PgIcon icon={props.prependIcon} size={19} />}
                    <span class="pg-list-item-content">
                        {props.title && <span class="pg-list-item-title">{props.title}</span>}
                        {props.subtitle && <span class="pg-list-item-subtitle">{props.subtitle}</span>}
                        {slots.default?.()}
                    </span>
                    {props.appendIcon && <PgIcon icon={props.appendIcon} size={16} class="pg-list-item__append" />}
                </>
            );
            if (props.to) {
                const href = config.resolveHref?.(props.to) ?? (typeof props.to === "string" ? props.to : "");
                return (
                    <li
                        id={attrs.id}
                        role={attrs.role}
                        class={["pg-list-item", itemClass].filter(Boolean).join(" ")}
                    >
                        <a
                            href={href}
                            class="pg-list-item-link"
                            onClick={(event: MouseEvent) => {
                                event.preventDefault();
                                props.onClick?.(event);
                                void (config.navigate ?? ((to: any) => router?.push(to)))?.(props.to);
                            }}
                        >
                            {content}
                        </a>
                    </li>
                );
            }
            return (
                <li
                    id={attrs.id}
                    role={attrs.role}
                    class={["pg-list-item", itemClass].filter(Boolean).join(" ")}
                    onClick={props.onClick}
                >
                    {content}
                </li>
            );
        };
    },
    {
        props: {
            title: { type: String, default: "" },
            subtitle: { type: String, default: "" },
            prependIcon: { type: String, default: "" },
            appendIcon: { type: String, default: "" },
            to: { type: [String, Object], default: undefined },
            onClick: { type: Function as unknown as () => ((event: MouseEvent) => void) | undefined, default: undefined },
        },
        inheritAttrs: false,
    },
);
export const VListItem = PgListItem;

export const PgListItemTitle = dc(
    (_props, _expose, { attrs, slots }) => () => (
        <span {...attrs} class={["pg-list-item-title", attrs.class].filter(Boolean).join(" ")}>{slots.default?.()}</span>
    ),
    { inheritAttrs: true },
);
export const VListItemTitle = PgListItemTitle;

export const PgListItemSubtitle = dc(
    (_props, _expose, { attrs, slots }) => () => (
        <span {...attrs} class={["pg-list-item-subtitle", attrs.class].filter(Boolean).join(" ")}>{slots.default?.()}</span>
    ),
    { inheritAttrs: true },
);
export const VListItemSubtitle = PgListItemSubtitle;

export const PgListSubheader = dc(
    (_props, _expose, { attrs, slots }) => () => (
        <li {...attrs} class={["pg-list-subheader", attrs.class].filter(Boolean).join(" ")}>{slots.default?.()}</li>
    ),
    { inheritAttrs: false },
);
export const VListSubheader = PgListSubheader;

export const PgExpansionPanels = dc(
    (_props, _expose, { attrs, slots }) => () => (
        <div {...attrs} class={["pg-expansion", attrs.class].filter(Boolean).join(" ")}>{slots.default?.()}</div>
    ),
    { inheritAttrs: true },
);
export const VExpansionPanels = PgExpansionPanels;

export const PgExpansionPanel = dc(
    (props: { modelValue?: boolean }, _expose, { attrs, slots }) => () => (
        <details {...attrs} class={["pg-expansion-panel", attrs.class].filter(Boolean).join(" ")} open={Boolean(props.modelValue)}>
            {slots.default?.()}
        </details>
    ),
    { props: { modelValue: { type: Boolean, default: false } }, inheritAttrs: true },
);
export const VExpansionPanel = PgExpansionPanel;

export const PgExpansionPanelTitle = dc(
    (_props, _expose, { attrs, slots }) => () => (
        <summary {...attrs} class={["pg-expansion-title", attrs.class].filter(Boolean).join(" ")}>{slots.default?.()}</summary>
    ),
    { inheritAttrs: true },
);
export const VExpansionPanelTitle = PgExpansionPanelTitle;

export const PgExpansionPanelText = dc(
    (_props, _expose, { attrs, slots }) => () => (
        <div {...attrs} class={["pg-expansion-text", attrs.class].filter(Boolean).join(" ")}>{slots.default?.()}</div>
    ),
    { inheritAttrs: true },
);
export const VExpansionPanelText = PgExpansionPanelText;

export const PgTimeline = dc(
    (_props, _expose, { attrs, slots }) => () => (
        <div {...attrs} class={["pg-timeline", attrs.class].filter(Boolean).join(" ")}>{slots.default?.()}</div>
    ),
    { inheritAttrs: true },
);
export const VTimeline = PgTimeline;

export const PgTimelineItem = dc(
    (props: { title?: string; icon?: string; dotColor?: string }, _expose, { attrs, slots }) => () => (
        <div {...attrs} class={["pg-timeline-item", attrs.class].filter(Boolean).join(" ")}>
            <span class="pg-timeline-dot" style={{ background: props.dotColor }} />
            <div class="pg-timeline-content">
                {props.icon && <PgIcon icon={props.icon} size={16} />}
                {props.title && <div class="pg-timeline-title">{props.title}</div>}
                {slots.default?.()}
            </div>
        </div>
    ),
    { props: { title: { type: String, default: "" }, icon: { type: String, default: "" }, dotColor: { type: String, default: "" } }, inheritAttrs: true },
);
export const VTimelineItem = PgTimelineItem;

export const PgAvatar = dc(
    (props: { size?: number | string; image?: string; name?: string }, _expose, { attrs, slots }) => () => (
        <span
            {...attrs}
            class={["pg-avatar", attrs.class].filter(Boolean).join(" ")}
            style={[{ width: props.size ? (typeof props.size === "number" ? `${props.size}px` : props.size) : undefined }, (attrs as { style?: any }).style]}
        >
            {props.image ? <img src={props.image} alt={props.name ?? ""} /> : slots.default?.() ?? (props.name ? props.name.slice(0, 1) : "")}
        </span>
    ),
    { props: { size: { type: [Number, String], default: 32 }, image: { type: String, default: "" }, name: { type: String, default: "" } }, inheritAttrs: true },
);
export const VAvatar = PgAvatar;

export const PgChip = dc(
    (props: { label?: string; closable?: boolean; color?: string; size?: string }, _expose, { attrs, slots }) => () => (
        <span {...attrs} class={["pg-chip", attrs.class].filter(Boolean).join(" ")}>
            <span>{slots.default?.() ?? props.label}</span>
            {props.closable && (
                <button
                    type="button"
                    class="pg-chip__close"
                    aria-label="Remove"
                    onClick={(event: MouseEvent) => {
                        event.stopPropagation();
                        (attrs["onClick:close"] as (() => void) | undefined)?.();
                    }}
                >
                    <PgIcon icon="mdi-close" size={12} />
                </button>
            )}
        </span>
    ),
    { props: { label: { type: String, default: "" }, closable: { type: Boolean, default: false }, color: { type: String, default: "" }, size: { type: String, default: "md" } }, inheritAttrs: true },
);
export const VChip = PgChip;
export const PgTag = PgChip;

export const PgBtnToggle = dc(
    (_props, _expose, { attrs, slots }) => () => (
        <div {...attrs} class={["pg-btn-toggle", attrs.class].filter(Boolean).join(" ")}>{slots.default?.()}</div>
    ),
    { inheritAttrs: true },
);
export const VBtnToggle = PgBtnToggle;

export const PgForm = dc(
    (props: { onSubmit?: (event: Event) => void }, _expose, { attrs, slots }) => () => (
        <form
            {...attrs}
            class={["pg-form", attrs.class].filter(Boolean).join(" ")}
            onSubmit={(event: Event) => {
                event.preventDefault();
                props.onSubmit?.(event);
            }}
        >
            {slots.default?.()}
        </form>
    ),
    { props: { onSubmit: { type: Function as unknown as () => ((event: Event) => void) | undefined, default: undefined } }, inheritAttrs: true },
);
export const VForm = PgForm;

export const VCardText = dc(
    (_props, _expose, { attrs, slots }) => () => (
        <div {...attrs} class={["pg-card-text", attrs.class].filter(Boolean).join(" ")}>{slots.default?.()}</div>
    ),
    { inheritAttrs: true },
);

export const VCardActions = dc(
    (_props, _expose, { attrs, slots }) => () => (
        <div {...attrs} class={["pg-card-actions", attrs.class].filter(Boolean).join(" ")}>{slots.default?.()}</div>
    ),
    { inheritAttrs: true },
);

export const VCardTitle = dc(
    (_props, _expose, { attrs, slots }) => () => (
        <div {...attrs} class={["pg-card__title", attrs.class].filter(Boolean).join(" ")}>{slots.default?.()}</div>
    ),
    { inheritAttrs: true },
);

export const VCardSubtitle = dc(
    (_props, _expose, { attrs, slots }) => () => (
        <div {...attrs} class={["pg-card__subtitle", attrs.class].filter(Boolean).join(" ")}>{slots.default?.()}</div>
    ),
    { inheritAttrs: true },
);

export const PgSlider = dc(
    (props: { modelValue?: number; min?: number; max?: number; step?: number; disabled?: boolean }, _expose, { attrs }) => () => (
        <input
            {...attrs}
            class={["pg-slider", attrs.class].filter(Boolean).join(" ")}
            type="range"
            min={props.min ?? 0}
            max={props.max ?? 100}
            step={props.step ?? 1}
            value={props.modelValue ?? 0}
            disabled={props.disabled}
            onInput={(event: Event) => (attrs["onUpdate:modelValue"] as ((value: number) => void) | undefined)?.(Number((event.target as HTMLInputElement).value))}
        />
    ),
    { props: { modelValue: { type: Number, default: 0 }, min: { type: Number, default: 0 }, max: { type: Number, default: 100 }, step: { type: Number, default: 1 }, disabled: { type: Boolean, default: false } }, inheritAttrs: true },
);
export const VSlider = PgSlider;

export const PgCardText = VCardText;
export const PgCardActions = VCardActions;
export const PgCardTitle = VCardTitle;
export const PgCardSubtitle = VCardSubtitle;
export const SurfaceCardText = VCardText;
export const PgAvatarChip = PgChip;

/** No-op transition wrapper kept for legacy markup. */
export const PgTransition = dc((_props, _expose, { slots }) => () => slots.default?.(), {});
