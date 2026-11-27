import {
    computed,
    nextTick,
    onBeforeUnmount,
    onMounted,
    provide,
    inject,
    ref,
    useId,
    watch,
} from "vue";
import { useRouter } from "vue-router";
import { dc } from "../lib/dc";
import { usePgUiConfig } from "../lib/config";
import { useLocale } from "../lib/locale";
import { lockBodyScroll, useEscape } from "../lib/dom";
import { providePgForm } from "../lib/formRegistry";
import { PgIcon } from "../actions/PgIcon";

/* === App shell ============================================================ */

/** Root viewport frame: app bar row + optional sidebar + scrolling main. */
export const PgApp = dc(
    (_props, _expose, { attrs, slots }) => () => (
        <div {...attrs} class={["pg-app", "v-application", attrs.class].filter(Boolean).join(" ")}>
            {slots.default?.()}
        </div>
    ),
    { inheritAttrs: true },
);

export const VApp = PgApp;

/**
 * Top navigation bar. Height defaults to the `--pg-app-bar-h` layout token
 * (60px); `prepend`, `default` and `append` are flex clusters so legacy markup
 * that renders everything in the default slot keeps working.
 */
export const PgAppBar = dc(
    (
        props: {
            height?: number | string;
            sticky?: boolean;
            density?: string;
            elevation?: number | string;
            color?: string;
            flat?: boolean;
        },
        _expose,
        { attrs, slots },
    ) => {
        const heightStyle = (): Record<string, string> | undefined => {
            if (props.height === undefined || props.height === null || props.height === "") return undefined;
            return {
                "--pg-app-bar-height":
                    typeof props.height === "number" ? `${props.height}px` : String(props.height),
            };
        };
        return () => (
            <header
                {...attrs}
                class={[
                    "pg-app-bar",
                    props.density === "compact" ? "pg-app-bar--compact" : "",
                    props.sticky === false ? "pg-app-bar--static" : "",
                    attrs.class,
                ]
                    .filter(Boolean)
                    .join(" ")}
                style={[heightStyle(), (attrs as { style?: any }).style]}
            >
                {slots.prepend && <div class="pg-app-bar__prepend">{slots.prepend()}</div>}
                <div class="pg-app-bar__main">{slots.default?.()}</div>
                {slots.append && <div class="pg-app-bar__append">{slots.append()}</div>}
            </header>
        );
    },
    {
        props: {
            height: { type: [Number, String], default: undefined },
            sticky: { type: Boolean, default: true },
            density: { type: String, default: "default" },
            elevation: { type: [Number, String], default: 0 },
            color: { type: String, default: "" },
            flat: { type: Boolean, default: false },
        },
        inheritAttrs: true,
    },
);

export const VAppBar = PgAppBar;

export const PgAppBarTitle = dc(
    (_props, _expose, { attrs, slots }) => () => (
        <div {...attrs} class={["pg-app-bar-title", attrs.class].filter(Boolean).join(" ")}>
            {slots.default?.()}
        </div>
    ),
    { inheritAttrs: true },
);

export const VAppBarTitle = PgAppBarTitle;

/** Scrollable main content canvas. Always `#pg-main-content`, `min-width: 0`. */
export const PgMain = dc(
    (props: { scrollable?: boolean; id?: string }, _expose, { attrs, slots }) => () => (
        <main
            {...attrs}
            id={(attrs as { id?: string }).id || props.id || "pg-main-content"}
            class={["pg-main", props.scrollable ? "pg-main--scrollable" : "", attrs.class]
                .filter(Boolean)
                .join(" ")}
        >
            {slots.default?.()}
        </main>
    ),
    {
        props: { scrollable: { type: Boolean, default: false }, id: { type: String, default: "" } },
        inheritAttrs: true,
    },
);

export const VMain = PgMain;

/**
 * Primary sidebar. Three-zone flex column: fixed brand header
 * (`prepend`), scrollable navigation body (`default`) and pinned footer
 * (`append`). Legacy markup that places `.pg-drawer__brand`, `.pg-nav` and
 * `.pg-drawer__footer` all inside the default slot is supported by the layout
 * CSS: `.pg-nav` becomes the scroll region and `.pg-drawer__footer` pins to the
 * bottom. Temporary drawers close on Escape and backdrop click.
 */
export const PgNavigationDrawer = dc(
    (
        props: {
            modelValue?: boolean;
            rail?: boolean;
            permanent?: boolean;
            temporary?: boolean;
            width?: number | string;
            location?: string;
            ariaLabel?: string;
        },
        _expose,
        { attrs, emit, slots },
    ) => {
        const { t } = useLocale();
        const permanent = (): boolean => props.permanent === true;
        const temporary = (): boolean => props.temporary === true && !permanent();
        const visible = (): boolean => props.modelValue !== false;
        const openTemporary = computed(() => temporary() && visible());

        let releaseScroll: (() => void) | null = null;
        watch(
            openTemporary,
            (open) => {
                if (open) releaseScroll = lockBodyScroll();
                else {
                    releaseScroll?.();
                    releaseScroll = null;
                }
            },
            { immediate: true },
        );
        onBeforeUnmount(() => {
            releaseScroll?.();
            releaseScroll = null;
        });

        const close = () => {
            if (!temporary()) return;
            emit?.("update:modelValue", false);
        };
        useEscape(close, () => temporary() && visible());

        const width = (): string | undefined => {
            if (props.rail) return undefined;
            if (props.width === undefined || props.width === null || props.width === "") return undefined;
            return typeof props.width === "number" ? `${props.width}px` : String(props.width);
        };

        return () => {
            return (
                <>
                    {temporary() && visible() && (
                        <div
                            class="pg-nav-drawer__backdrop"
                            aria-hidden="true"
                            onClick={close}
                        />
                    )}
                    <aside
                        {...attrs}
                        hidden={!visible()}
                        role={
                            (attrs as { role?: string }).role ??
                            (temporary() ? undefined : "navigation")
                        }
                        aria-label={props.ariaLabel || t("Primary navigation")}
                        aria-hidden={!visible() ? "true" : attrs["aria-hidden"]}
                        class={[
                            "pg-nav-drawer",
                            props.rail ? "pg-nav-drawer--rail" : "",
                            temporary() ? "pg-nav-drawer--temporary" : "",
                            props.location === "end" || props.location === "right"
                                ? "pg-nav-drawer--end"
                                : "",
                            visible() ? "pg-nav-drawer--active" : "",
                            attrs.class,
                        ]
                            .filter(Boolean)
                            .join(" ")}
                        style={[{ width: width() }, (attrs as { style?: any }).style]}
                    >
                        <div class="v-navigation-drawer__content">
                            {slots.prepend && (
                                <div class="pg-nav-drawer__prepend">{slots.prepend()}</div>
                            )}
                            <div
                                class={[
                                    "pg-nav-drawer__body",
                                    slots.prepend || slots.append ? "pg-nav-drawer__body--zoned" : "",
                                ]
                                    .filter(Boolean)
                                    .join(" ")}
                            >
                                {slots.default?.()}
                            </div>
                            {slots.append && <div class="pg-nav-drawer__append">{slots.append()}</div>}
                        </div>
                    </aside>
                </>
            );
        };
    },
    {
        props: {
            modelValue: { type: Boolean, default: true },
            rail: { type: Boolean, default: false },
            permanent: { type: Boolean, default: false },
            temporary: { type: Boolean, default: false },
            width: { type: [Number, String], default: undefined },
            location: { type: String, default: "start" },
            ariaLabel: { type: String, default: "" },
            color: { type: String, default: "" },
        },
        emits: ["update:modelValue"],
        inheritAttrs: false,
    },
);

export const VNavigationDrawer = PgNavigationDrawer;

export const PgSpacer = dc(() => () => <div class="pg-spacer" />, {});
export const VSpacer = PgSpacer;

export const PgContainer = dc(
    (props: { standalone?: boolean }, _expose, { attrs, slots }) => () => (
        <div
            {...attrs}
            class={[
                "pg-container",
                props.standalone ? "pg-container--standalone" : "",
                attrs.class,
            ]
                .filter(Boolean)
                .join(" ")}
        >
            {slots.default?.()}
        </div>
    ),
    { props: { standalone: { type: Boolean, default: false } }, inheritAttrs: true },
);
export const VContainer = PgContainer;

const ALIGN: Record<string, string> = {
    start: "flex-start",
    center: "center",
    end: "flex-end",
    baseline: "baseline",
    stretch: "stretch",
};

const JUSTIFY: Record<string, string> = {
    start: "flex-start",
    center: "center",
    end: "flex-end",
    "space-between": "space-between",
    "space-around": "space-around",
    "space-evenly": "space-evenly",
};

export const PgRow = dc(
    (
        props: { dense?: boolean; align?: string; justify?: string; noGutters?: boolean },
        _expose,
        { attrs, slots },
    ) => () => (
        <div
            {...attrs}
            class={["pg-row", props.dense ? "pg-row--dense" : "", props.noGutters ? "pg-row--no-gutters" : "", attrs.class]
                .filter(Boolean)
                .join(" ")}
            style={[
                props.align ? { alignItems: ALIGN[props.align] ?? props.align } : undefined,
                props.justify ? { justifyContent: JUSTIFY[props.justify] ?? props.justify } : undefined,
                (attrs as { style?: any }).style,
            ]}
        >
            {slots.default?.()}
        </div>
    ),
    {
        props: {
            dense: { type: Boolean, default: false },
            noGutters: { type: Boolean, default: false },
            align: { type: String, default: "" },
            justify: { type: String, default: "" },
        },
        inheritAttrs: true,
    },
);
export const VRow = PgRow;

export const PgCol = dc(
    (
        props: {
            cols?: number | string;
            sm?: number | string;
            md?: number | string;
            lg?: number | string;
            xl?: number | string;
        },
        _expose,
        { attrs, slots },
    ) => () => {
        const span = (value: number | string | undefined): number => {
            const parsed = typeof value === "string" ? Number(value) : value;
            return parsed && parsed >= 1 && parsed <= 12 ? Math.floor(parsed) : 0;
        };
        const classes = ["pg-col"];
        for (const [key, value] of [
            ["", props.cols],
            ["sm-", props.sm],
            ["md-", props.md],
            ["lg-", props.lg],
            ["xl-", props.xl],
        ] as const) {
            const count = span(value);
            if (count) classes.push(`pg-col--${key}${count}`);
        }
        return (
            <div {...attrs} class={[...classes, attrs.class].filter(Boolean).join(" ")}>
                {slots.default?.()}
            </div>
        );
    },
    {
        props: {
            cols: { type: [Number, String], default: 0 },
            sm: { type: [Number, String], default: 0 },
            md: { type: [Number, String], default: 0 },
            lg: { type: [Number, String], default: 0 },
            xl: { type: [Number, String], default: 0 },
        },
        inheritAttrs: true,
    },
);
export const VCol = PgCol;

/* === Lists ================================================================ */

export const PgList = dc(
    (props: { density?: string }, _expose, { attrs, slots }) => () => (
        <ul
            {...attrs}
            class={[
                "pg-list",
                props.density === "compact" ? "pg-list--compact" : "",
                attrs.class,
            ]
                .filter(Boolean)
                .join(" ")}
        >
            {slots.default?.()}
        </ul>
    ),
    { props: { density: { type: String, default: "default" } }, inheritAttrs: true },
);
export const VList = PgList;

/**
 * Structured list row. The row is always a `<li>` host so the parent `<ul>` is
 * valid; the interactive element inside is an `<a>` when `to`/`href` is set, a
 * `<button type="button">` when a click handler exists and a `<div>` otherwise.
 */
export const PgListItem = dc(
    (
        props: {
            title?: string;
            subtitle?: string;
            prependIcon?: string;
            appendIcon?: string;
            active?: boolean;
            disabled?: boolean;
            danger?: boolean;
            to?: any;
            href?: string;
            onClick?: (event: MouseEvent) => void;
        },
        _expose,
        { attrs, slots },
    ) => {
        const router = useRouter();
        const config = usePgUiConfig();

        const href = (): string => {
            if (props.href) return props.href;
            if (!props.to) return "";
            if (typeof props.to === "string") return config.resolveHref?.(props.to) ?? props.to;
            const configured = config.resolveHref?.(props.to);
            if (configured) return configured;
            try {
                return router?.resolve?.(props.to)?.href ?? "";
            } catch {
                return "";
            }
        };

        const activate = (event: MouseEvent) => {
            if (props.disabled) {
                event.preventDefault();
                return;
            }
            props.onClick?.(event);
            if (props.to && !props.href) {
                event.preventDefault();
                const target = config.navigate ?? ((destination: any) => router?.push(destination));
                void target?.(props.to);
            }
        };

        const content = () => (
            <>
                {(props.prependIcon || slots.prepend) && (
                    <span class="pg-list-item__prepend">
                        {slots.prepend ? slots.prepend() : <PgIcon icon={props.prependIcon!} size={19} />}
                    </span>
                )}
                <span class="pg-list-item-content">
                    {slots.title
                        ? slots.title()
                        : props.title && <span class="pg-list-item-title">{props.title}</span>}
                    {slots.subtitle
                        ? slots.subtitle()
                        : props.subtitle && <span class="pg-list-item-subtitle">{props.subtitle}</span>}
                    {slots.default?.()}
                </span>
                {(props.appendIcon || slots.append) && (
                    <span class="pg-list-item__append">
                        {slots.append ? slots.append() : <PgIcon icon={props.appendIcon!} size={16} />}
                    </span>
                )}
            </>
        );

        return () => {
            const interactive = Boolean(props.to || props.href || props.onClick);
            // Keep every active-dependent binding inline in JSX. Local class
            // strings are captured once by the Vapor runtime, which left the
            // first route highlighted after navigation.
            if (props.to || props.href) {
                return (
                    <li class="pg-list-item-host">
                        <a
                            {...attrs}
                            class={[
                                "pg-list-item",
                                props.active ? "pg-list-item--active" : "",
                                props.disabled ? "pg-list-item--disabled" : "",
                                props.danger ? "pg-list-item--danger" : "",
                                attrs.class,
                            ]
                                .filter(Boolean)
                                .join(" ")}
                            href={href()}
                            tabindex={props.disabled ? -1 : (attrs as any).tabindex}
                            aria-disabled={props.disabled ? "true" : (attrs as any)["aria-disabled"]}
                            aria-current={
                                props.active
                                    ? ((attrs as any)["aria-current"] ?? "page")
                                    : (attrs as any)["aria-current"]
                            }
                            onClick={activate}
                        >
                            {content()}
                        </a>
                    </li>
                );
            }
            if (interactive) {
                return (
                    <li class="pg-list-item-host">
                        <button
                            {...attrs}
                            class={[
                                "pg-list-item",
                                props.active ? "pg-list-item--active" : "",
                                props.disabled ? "pg-list-item--disabled" : "",
                                props.danger ? "pg-list-item--danger" : "",
                                attrs.class,
                            ]
                                .filter(Boolean)
                                .join(" ")}
                            type="button"
                            disabled={props.disabled}
                            aria-disabled={props.disabled ? "true" : (attrs as any)["aria-disabled"]}
                            aria-current={
                                props.active
                                    ? ((attrs as any)["aria-current"] ?? "page")
                                    : (attrs as any)["aria-current"]
                            }
                            onClick={activate}
                        >
                            {content()}
                        </button>
                    </li>
                );
            }
            return (
                <li class="pg-list-item-host">
                    <div
                        {...attrs}
                        class={[
                            "pg-list-item",
                            props.active ? "pg-list-item--active" : "",
                            props.disabled ? "pg-list-item--disabled" : "",
                            props.danger ? "pg-list-item--danger" : "",
                            attrs.class,
                        ]
                            .filter(Boolean)
                            .join(" ")}
                        aria-disabled={props.disabled ? "true" : (attrs as any)["aria-disabled"]}
                        aria-current={
                            props.active
                                ? ((attrs as any)["aria-current"] ?? "page")
                                : (attrs as any)["aria-current"]
                        }
                    >
                        {content()}
                    </div>
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
            active: { type: Boolean, default: false },
            disabled: { type: Boolean, default: false },
            danger: { type: Boolean, default: false },
            to: { type: [String, Object], default: undefined },
            href: { type: String, default: "" },
            onClick: {
                type: Function as unknown as () => ((event: MouseEvent) => void) | undefined,
                default: undefined,
            },
        },
        inheritAttrs: true,
    },
);
export const VListItem = PgListItem;

export const PgListItemTitle = dc(
    (_props, _expose, { attrs, slots }) => () => (
        <span {...attrs} class={["pg-list-item-title", attrs.class].filter(Boolean).join(" ")}>
            {slots.default?.()}
        </span>
    ),
    { inheritAttrs: true },
);
export const VListItemTitle = PgListItemTitle;

export const PgListItemSubtitle = dc(
    (_props, _expose, { attrs, slots }) => () => (
        <span {...attrs} class={["pg-list-item-subtitle", attrs.class].filter(Boolean).join(" ")}>
            {slots.default?.()}
        </span>
    ),
    { inheritAttrs: true },
);
export const VListItemSubtitle = PgListItemSubtitle;

export const PgListSubheader = dc(
    (_props, _expose, { attrs, slots }) => () => (
        <li {...attrs} class={["pg-list-subheader", attrs.class].filter(Boolean).join(" ")}>
            {slots.default?.()}
        </li>
    ),
    { inheritAttrs: true },
);
export const VListSubheader = PgListSubheader;

/* === Expansion panels ===================================================== */

type ExpansionContext = {
    multiple: () => boolean;
    isOpen: (value: string | number) => boolean;
    toggle: (value: string | number) => void;
    nextIndex: () => number;
};

const EXPANSION_KEY = Symbol("pg-expansion") as symbol;

const normalizeExpansion = (value: unknown): Array<string | number> => {
    if (Array.isArray(value)) return value.filter((entry) => entry !== undefined && entry !== null) as Array<string | number>;
    if (value === undefined || value === null || value === false) return [];
    return [value as string | number];
};

/** Accordion container. `modelValue` defaults to `undefined` → ALL COLLAPSED. */
export const PgExpansionPanels = dc(
    (
        props: {
            modelValue?: string | number | Array<string | number>;
            multiple?: boolean;
            variant?: string;
            mandatory?: boolean;
        },
        _expose,
        { attrs, emit, slots },
    ) => {
        const open = ref<Array<string | number>>(normalizeExpansion(props.modelValue));
        let counter = 0;

        watch(
            () => props.modelValue,
            (value) => {
                open.value = normalizeExpansion(value);
            },
            { deep: true },
        );

        const same = (a: string | number, b: string | number): boolean => String(a) === String(b);

        const context: ExpansionContext = {
            multiple: () => props.multiple === true,
            isOpen: (value) => open.value.some((entry) => same(entry, value)),
            toggle: (value) => {
                if (props.multiple) {
                    const index = open.value.findIndex((entry) => same(entry, value));
                    if (index >= 0) open.value.splice(index, 1);
                    else open.value.push(value);
                } else if (open.value.some((entry) => same(entry, value))) {
                    open.value = [];
                } else {
                    open.value = [value];
                }
                emit?.("update:modelValue", props.multiple ? [...open.value] : open.value[0]);
            },
            nextIndex: () => counter++,
        };

        provide(EXPANSION_KEY, context);

        return () => (
            <div
                {...attrs}
                class={[
                    "pg-expansion",
                    props.variant ? `pg-expansion--${props.variant}` : "",
                    attrs.class,
                ]
                    .filter(Boolean)
                    .join(" ")}
            >
                {slots.default?.()}
            </div>
        );
    },
    {
        props: {
            modelValue: { type: [String, Number, Array], default: undefined },
            multiple: { type: Boolean, default: false },
            variant: { type: String, default: "default" },
            mandatory: { type: Boolean, default: false },
        },
        emits: ["update:modelValue"],
        inheritAttrs: true,
    },
);
export const VExpansionPanels = PgExpansionPanels;

export const PgExpansionPanel = dc(
    (
        props: { value?: string | number; title?: string; disabled?: boolean },
        _expose,
        { attrs, slots },
    ) => {
        const context = inject<ExpansionContext | null>(EXPANSION_KEY, null);
        const index = context ? context.nextIndex() : 0;
        const fallback = ref(false);
        const panelId = useId();
        const headerId = `${panelId}-header`;
        const bodyId = `${panelId}-body`;
        const value = (): string | number => props.value ?? index;
        const isOpen = (): boolean => (context ? context.isOpen(value()) : fallback.value);
        const toggle = () => {
            if (props.disabled) return;
            if (context) context.toggle(value());
            else fallback.value = !fallback.value;
        };

        return () => (
            <div
                {...attrs}
                class={[
                    "pg-expansion-panel",
                    isOpen() ? "pg-expansion--open pg-expansion-panel--open" : "",
                    attrs.class,
                ]
                    .filter(Boolean)
                    .join(" ")}
            >
                <button
                    id={headerId}
                    type="button"
                    class="pg-expansion__header"
                    aria-expanded={isOpen() ? "true" : "false"}
                    aria-controls={isOpen() ? bodyId : undefined}
                    disabled={props.disabled}
                    onClick={toggle}
                >
                    <span class="pg-expansion__title">
                        {slots.title ? slots.title() : props.title || ""}
                    </span>
                    <PgIcon icon="mdi-chevron-down" size={18} class="pg-expansion__chevron" />
                </button>
                {isOpen() && (
                    <div
                        id={bodyId}
                        class="pg-expansion__body"
                        role="region"
                        aria-labelledby={headerId}
                    >
                        {slots.text ? slots.text() : slots.default?.()}
                    </div>
                )}
            </div>
        );
    },
    {
        props: {
            value: { type: [String, Number], default: undefined },
            title: { type: String, default: "" },
            disabled: { type: Boolean, default: false },
        },
        inheritAttrs: true,
    },
);
export const VExpansionPanel = PgExpansionPanel;

export const PgExpansionPanelTitle = dc(
    (_props, _expose, { attrs, slots }) => () => (
        <span {...attrs} class={["pg-expansion__panel-title", "pg-expansion-title", attrs.class].filter(Boolean).join(" ")}>
            {slots.default?.()}
        </span>
    ),
    { inheritAttrs: true },
);
export const VExpansionPanelTitle = PgExpansionPanelTitle;

export const PgExpansionPanelText = dc(
    (_props, _expose, { attrs, slots }) => () => (
        <div {...attrs} class={["pg-expansion__body", "pg-expansion-text", attrs.class].filter(Boolean).join(" ")}>
            {slots.default?.()}
        </div>
    ),
    { inheritAttrs: true },
);
export const VExpansionPanelText = PgExpansionPanelText;

/* === Timeline ============================================================= */

export const PgTimeline = dc(
    (props: { density?: string; side?: string; align?: string }, _expose, { attrs, slots }) => () => (
        <ol
            {...attrs}
            class={[
                "pg-timeline",
                props.density === "compact" ? "pg-timeline--compact" : "",
                attrs.class,
            ]
                .filter(Boolean)
                .join(" ")}
        >
            {slots.default?.()}
        </ol>
    ),
    {
        props: {
            density: { type: String, default: "default" },
            side: { type: String, default: "" },
            align: { type: String, default: "" },
        },
        inheritAttrs: true,
    },
);
export const VTimeline = PgTimeline;

const TIMELINE_TONES = ["success", "warning", "danger", "info", "brand", "neutral", "subtle"];

const timelineTokenTone = (value: string): string => {
    if (!value) return "";
    if (value === "error") return "danger";
    if (value === "primary") return "brand";
    return TIMELINE_TONES.includes(value) ? value : "";
};

export const PgTimelineItem = dc(
    (
        props: {
            title?: string;
            timestamp?: string;
            icon?: string;
            dotColor?: string;
            tone?: string;
            size?: string;
        },
        _expose,
        { attrs, slots },
    ) => {
        const tokenTone = (): string => timelineTokenTone(props.dotColor || "");
        const tone = (): string => {
            const value = tokenTone() || props.tone || "neutral";
            if (value === "error") return "danger";
            return TIMELINE_TONES.includes(value) ? value : "neutral";
        };
        const dotStyle = (): Record<string, string> | undefined =>
            props.dotColor && !tokenTone() ? { background: props.dotColor } : undefined;
        return () => (
            <li {...attrs} class={["pg-timeline__item", attrs.class].filter(Boolean).join(" ")}>
                <span class="pg-timeline__track" aria-hidden="true">
                    <span
                        class={["pg-timeline__dot", `pg-timeline__dot--${tone()}`]
                            .filter(Boolean)
                            .join(" ")}
                        style={dotStyle()}
                    >
                        {props.icon && <PgIcon icon={props.icon} size={10} />}
                    </span>
                </span>
                <div class="pg-timeline__content">
                    {(props.timestamp || slots.opposite) && (
                        <div class="pg-timeline__opposite">
                            {slots.opposite ? slots.opposite() : props.timestamp}
                        </div>
                    )}
                    {slots.icon?.()}
                    {slots.title
                        ? slots.title()
                        : props.title && <div class="pg-timeline__title">{props.title}</div>}
                    {slots.default?.()}
                </div>
            </li>
        );
    },
    {
        props: {
            title: { type: String, default: "" },
            timestamp: { type: String, default: "" },
            icon: { type: String, default: "" },
            dotColor: { type: String, default: "" },
            tone: { type: String, default: "neutral" },
            size: { type: String, default: "" },
        },
        inheritAttrs: true,
    },
);
export const VTimelineItem = PgTimelineItem;

/* === Identity & metadata atoms =========================================== */

const AVATAR_SIZES = ["xs", "sm", "md", "lg"];

const initialsOf = (name: string): string => {
    const parts = String(name || "")
        .trim()
        .split(/\s+/)
        .filter(Boolean);
    if (parts.length === 0) return "";
    if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
    return `${parts[0]![0] ?? ""}${parts[parts.length - 1]![0] ?? ""}`.toUpperCase();
};

/** Monogram avatar with a graceful image-error fallback. */
export const PgAvatar = dc(
    (
        props: {
            size?: string | number;
            src?: string;
            image?: string;
            name?: string;
            shape?: string;
            tone?: string;
        },
        _expose,
        { attrs, slots },
    ) => {
        const failed = ref(false);
        watch(
            () => props.src || props.image,
            () => {
                failed.value = false;
            },
        );
        return () => {
            const source = props.src || props.image || "";
            const named = typeof props.size === "string" && AVATAR_SIZES.includes(props.size);
            const numeric = typeof props.size === "number" ? props.size : undefined;
            return (
                <span
                    {...attrs}
                    class={[
                        "pg-avatar",
                        named ? `pg-avatar--${props.size}` : !props.size ? "pg-avatar--md" : "",
                        props.shape === "rounded" ? "pg-avatar--rounded" : "pg-avatar--circle",
                        props.tone ? `pg-avatar--tone-${props.tone === "error" ? "danger" : props.tone}` : "",
                        attrs.class,
                    ]
                        .filter(Boolean)
                        .join(" ")}
                    style={[
                        numeric ? { width: `${numeric}px`, height: `${numeric}px` } : undefined,
                        (attrs as { style?: any }).style,
                    ]}
                    role={props.name ? "img" : undefined}
                    aria-label={props.name || undefined}
                >
                    {source && !failed.value ? (
                        <img
                            class="pg-avatar__image"
                            src={source}
                            alt=""
                            onError={() => {
                                failed.value = true;
                            }}
                        />
                    ) : (
                        <span class="pg-avatar__initials" aria-hidden="true">
                            {slots.default?.() ?? initialsOf(props.name || "")}
                        </span>
                    )}
                </span>
            );
        };
    },
    {
        props: {
            size: { type: [String, Number], default: "md" },
            src: { type: String, default: "" },
            image: { type: String, default: "" },
            name: { type: String, default: "" },
            shape: { type: String, default: "circle" },
            tone: { type: String, default: "" },
        },
        inheritAttrs: true,
    },
);
export const VAvatar = PgAvatar;

const chipTone = (tone: string, color: string): string => {
    const value = tone || color;
    if (!value) return "";
    if (value === "error") return "danger";
    if (value === "primary") return "brand";
    if (value === "success" || value === "warning" || value === "danger" || value === "info") return value;
    if (value === "brand" || value === "neutral") return value;
    return "";
};

const chipVariant = (variant: string): string => {
    if (variant === "outlined") return "outlined";
    if (variant === "solid" || variant === "flat") return "solid";
    return "tonal";
};

/** Removable filter/selection pill. Close stops propagation by contract. */
export const PgChip = dc(
    (
        props: {
            label?: string;
            closable?: boolean;
            color?: string;
            tone?: string;
            variant?: string;
            size?: string;
            prependIcon?: string;
            disabled?: boolean;
        },
        _expose,
        { attrs, emit, slots },
    ) => {
        const { t } = useLocale();

        const fireClose = (event: Event) => {
            event.stopPropagation();
            emit?.("close", event);
            const legacy = (attrs as Record<string, unknown>)["onClick:close"];
            if (typeof legacy === "function") (legacy as (event: Event) => void)(event);
        };

        return () => (
            <span
                {...attrs}
                class={[
                    "pg-chip",
                    `pg-chip--${chipVariant(props.variant || "")}`,
                    chipTone(props.tone || "", props.color || "")
                        ? `pg-chip--${chipTone(props.tone || "", props.color || "")}`
                        : "",
                    props.size === "small" || props.size === "sm" ? "pg-chip--sm" : "",
                    props.closable ? "pg-chip--closable" : "",
                    props.disabled ? "pg-chip--disabled" : "",
                    attrs.class,
                ]
                    .filter(Boolean)
                    .join(" ")}
                tabindex={
                    props.disabled
                        ? undefined
                        : props.closable
                          ? ((attrs as any).tabindex ?? 0)
                          : (attrs as any).tabindex
                }
                aria-disabled={props.disabled ? "true" : (attrs as any)["aria-disabled"]}
                onKeydown={(event: KeyboardEvent) => {
                    if (!props.closable || props.disabled) return;
                    if (event.target !== event.currentTarget) return;
                    if (event.key !== "Backspace" && event.key !== "Delete") return;
                    event.preventDefault();
                    fireClose(event);
                }}
            >
                {props.prependIcon && (
                    <span class="pg-chip__prepend" aria-hidden="true">
                        <PgIcon icon={props.prependIcon} size={14} />
                    </span>
                )}
                <span class="pg-chip__label">{slots.default?.() ?? props.label}</span>
                {slots.append?.()}
                {props.closable && !props.disabled && (
                    <button
                        type="button"
                        class="pg-chip__close"
                        aria-label={t("Remove")}
                        onClick={fireClose}
                    >
                        <PgIcon icon="mdi-close" size={12} />
                    </button>
                )}
            </span>
        );
    },
    {
        props: {
            label: { type: String, default: "" },
            closable: { type: Boolean, default: false },
            color: { type: String, default: "" },
            tone: { type: String, default: "" },
            variant: { type: String, default: "" },
            size: { type: String, default: "md" },
            prependIcon: { type: String, default: "" },
            disabled: { type: Boolean, default: false },
        },
        emits: ["close"],
        inheritAttrs: true,
    },
);
export const VChip = PgChip;
export const PgAvatarChip = PgChip;

export const PgTag = dc(
    (props: { label?: string; tone?: string; color?: string }, _expose, { attrs, slots }) => () => {
        const tone = chipTone(props.tone || "", props.color || "");
        return (
            <span
                {...attrs}
                class={["pg-tag", tone ? `pg-tag--${tone}` : "", attrs.class].filter(Boolean).join(" ")}
            >
                {slots.default?.() ?? props.label}
            </span>
        );
    },
    {
        props: {
            label: { type: String, default: "" },
            tone: { type: String, default: "" },
            color: { type: String, default: "" },
        },
        inheritAttrs: true,
    },
);

/* === Grouped toggle ======================================================= */

const TOGGLE_ITEM_SELECTOR = "[data-pg-toggle-value], .pg-btn[value], button[value]";

const toggleValue = (element: HTMLElement): string =>
    element.getAttribute("data-pg-toggle-value") ?? element.getAttribute("value") ?? "";

const coerceToggleValue = (raw: string): string | number => {
    const trimmed = raw.trim();
    if (!trimmed) return raw;
    const numeric = Number(trimmed);
    return !Number.isNaN(numeric) && String(numeric) === trimmed ? numeric : raw;
};

/**
 * Segmented button group. Works with `<PgButton value="…">` children (the
 * button primitive forwards `value` as an attribute) and keeps
 * `aria-pressed` in sync. Mandatory by default, so re-clicking the active
 * segment never clears the selection.
 */
export const PgBtnToggle = dc(
    (
        props: {
            modelValue?: string | number | Array<string | number>;
            mandatory?: boolean;
            multiple?: boolean;
            disabled?: boolean;
            density?: string;
            variant?: string;
            divided?: boolean;
        },
        _expose,
        { attrs, emit, slots },
    ) => {
        const root = ref<HTMLElement | null>(null);
        const items = (): HTMLElement[] =>
            root.value ? Array.from(root.value.querySelectorAll<HTMLElement>(TOGGLE_ITEM_SELECTOR)) : [];

        const selected = (value: string): boolean => {
            if (Array.isArray(props.modelValue)) {
                return props.modelValue.some((entry) => String(entry) === value);
            }
            if (props.modelValue === undefined || props.modelValue === null) return false;
            return String(props.modelValue) === value;
        };

        const sync = () => {
            for (const item of items()) {
                const on = selected(toggleValue(item));
                item.setAttribute("aria-pressed", on ? "true" : "false");
                item.classList.toggle("pg-btn-toggle__item--active", on);
                if (props.disabled) item.setAttribute("aria-disabled", "true");
                else if (item.getAttribute("aria-disabled") === "true" && !item.hasAttribute("disabled")) {
                    item.removeAttribute("aria-disabled");
                }
            }
        };

        onMounted(() => nextTick(sync));
        watch(
            () => [props.modelValue, props.disabled],
            () => nextTick(sync),
            { deep: true, flush: "post" },
        );

        const select = (value: string) => {
            if (props.disabled) return;
            const current = props.modelValue;
            if (props.multiple) {
                const list = Array.isArray(current)
                    ? [...current]
                    : current === undefined || current === null
                      ? []
                      : [current];
                const index = list.findIndex((entry) => String(entry) === value);
                if (index >= 0) {
                    if (props.mandatory !== false && list.length <= 1) return;
                    list.splice(index, 1);
                } else {
                    list.push(coerceToggleValue(value));
                }
                emit?.("update:modelValue", list);
            } else if (String(current) === value) {
                if (props.mandatory !== false) return;
                emit?.("update:modelValue", undefined);
            } else {
                emit?.("update:modelValue", coerceToggleValue(value));
            }
            void nextTick(sync);
        };

        const onClick = (event: MouseEvent) => {
            if (props.disabled) return;
            const target = (event.target as HTMLElement | null)?.closest?.(TOGGLE_ITEM_SELECTOR);
            if (!target || !root.value?.contains(target)) return;
            select(toggleValue(target as HTMLElement));
        };

        const onKeydown = (event: KeyboardEvent) => {
            if (props.disabled) return;
            const key = event.key;
            if (!["ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown", "Home", "End"].includes(key)) return;
            const enabled = items().filter(
                (item) => !item.hasAttribute("disabled") && item.getAttribute("aria-disabled") !== "true",
            );
            if (!enabled.length) return;
            const target = (event.target as HTMLElement | null)?.closest?.(TOGGLE_ITEM_SELECTOR);
            let index = target ? enabled.indexOf(target as HTMLElement) : -1;
            if (index < 0) index = key === "End" ? -1 : 0;
            const rtl = typeof document !== "undefined" && document.documentElement.dir === "rtl";
            let next = index;
            if (key === "Home") next = 0;
            else if (key === "End") next = enabled.length - 1;
            else {
                const forward =
                    key === "ArrowDown" || (key === "ArrowRight" && !rtl) || (key === "ArrowLeft" && rtl);
                next = (index + (forward ? 1 : -1) + enabled.length) % enabled.length;
            }
            event.preventDefault();
            enabled[next]?.focus();
        };

        return () => (
            <div
                {...attrs}
                ref={root}
                role={attrs.role ?? "group"}
                class={[
                    "pg-btn-toggle",
                    props.density === "compact" ? "pg-btn-toggle--compact" : "",
                    props.disabled ? "pg-btn-toggle--disabled" : "",
                    attrs.class,
                ]
                    .filter(Boolean)
                    .join(" ")}
                aria-disabled={props.disabled ? "true" : undefined}
                inert={props.disabled ? true : undefined}
                onClick={onClick}
                onKeydown={onKeydown}
            >
                {slots.default?.()}
            </div>
        );
    },
    {
        props: {
            modelValue: { type: [String, Number, Array], default: undefined },
            mandatory: { type: Boolean, default: true },
            multiple: { type: Boolean, default: false },
            disabled: { type: Boolean, default: false },
            density: { type: String, default: "default" },
            variant: { type: String, default: "" },
            divided: { type: Boolean, default: false },
        },
        emits: ["update:modelValue"],
        inheritAttrs: true,
    },
);
export const VBtnToggle = PgBtnToggle;

/* === Slider =============================================================== */

const decimalsOf = (step: number): number => {
    const text = String(step);
    const dot = text.indexOf(".");
    return dot >= 0 ? text.length - dot - 1 : 0;
};

/** Fully styled native range input with numeric, clamped emissions. */
export const PgSlider = dc(
    (
        props: {
            modelValue?: number;
            min?: number;
            max?: number;
            step?: number;
            label?: string;
            unit?: string;
            showValue?: boolean;
            disabled?: boolean;
            ariaLabel?: string;
            hideDetails?: boolean;
        },
        _expose,
        { attrs, emit },
    ) => {
        const inputId = useId();
        const input = ref<HTMLInputElement | null>(null);

        const step = (): number => (Number.isFinite(props.step) && Number(props.step) > 0 ? Number(props.step) : 1);
        const min = (): number => (Number.isFinite(props.min) ? Number(props.min) : 0);
        const max = (): number => {
            const value = Number.isFinite(props.max) ? Number(props.max) : 100;
            return value > min() ? value : min() + step();
        };
        const round = (value: number): number => {
            const decimals = Math.min(6, decimalsOf(step()));
            return Number(value.toFixed(decimals));
        };
        const clamp = (value: number): number => {
            if (!Number.isFinite(value)) return min();
            return round(Math.min(max(), Math.max(min(), value)));
        };
        const current = (): number => clamp(Number(props.modelValue ?? 0));
        const percent = (): number => {
            const span = max() - min();
            return span <= 0 ? 0 : ((current() - min()) / span) * 100;
        };
        const display = (): string => String(current());

        const update = (value: number, notifyChange = false) => {
            const next = clamp(value);
            if (input.value) input.value.value = String(next);
            emit?.("update:modelValue", next);
            if (notifyChange) emit?.("change", next);
        };

        const onInput = (event: Event) => {
            update(Number((event.target as HTMLInputElement).value));
        };

        const onChange = (event: Event) => {
            const next = clamp(Number((event.target as HTMLInputElement).value));
            emit?.("change", next);
        };

        const onKeydown = (event: KeyboardEvent) => {
            if (props.disabled) return;
            const base = current();
            let next: number | null = null;
            switch (event.key) {
                case "ArrowRight":
                case "ArrowUp":
                    next = base + step();
                    break;
                case "ArrowLeft":
                case "ArrowDown":
                    next = base - step();
                    break;
                case "PageUp":
                    next = base + step() * 10;
                    break;
                case "PageDown":
                    next = base - step() * 10;
                    break;
                case "Home":
                    next = min();
                    break;
                case "End":
                    next = max();
                    break;
                default:
                    return;
            }
            event.preventDefault();
            update(next, true);
        };

        return () => (
            <div
                {...attrs}
                class={[
                    "pg-slider",
                    props.disabled ? "pg-slider--disabled" : "",
                    attrs.class,
                ]
                    .filter(Boolean)
                    .join(" ")}
            >
                {(props.label || props.showValue !== false) && (
                    <div class="pg-slider__head">
                        {props.label && (
                            <label class="pg-slider__label" for={inputId}>
                                {props.label}
                            </label>
                        )}
                        {props.showValue !== false && (
                            <span class="pg-slider__value" aria-live="off">
                                {display()}
                                {props.unit || ""}
                            </span>
                        )}
                    </div>
                )}
                <div class="pg-slider__track">
                    <span class="pg-slider__fill" style={{ width: `${percent()}%` }} aria-hidden="true" />
                    <input
                        ref={input}
                        id={inputId}
                        class="pg-slider__native"
                        type="range"
                        min={min()}
                        max={max()}
                        step={step()}
                        value={current()}
                        disabled={props.disabled}
                        aria-label={props.ariaLabel || props.label || undefined}
                        aria-valuetext={`${display()}${props.unit || ""}`}
                        onInput={onInput}
                        onChange={onChange}
                        onKeydown={onKeydown}
                    />
                </div>
            </div>
        );
    },
    {
        props: {
            modelValue: { type: Number, default: 0 },
            min: { type: Number, default: 0 },
            max: { type: Number, default: 100 },
            step: { type: Number, default: 1 },
            label: { type: String, default: "" },
            unit: { type: String, default: "" },
            showValue: { type: Boolean, default: true },
            disabled: { type: Boolean, default: false },
            ariaLabel: { type: String, default: "" },
            hideDetails: { type: Boolean, default: false },
        },
        emits: ["update:modelValue", "change"],
        inheritAttrs: true,
    },
);
export const VSlider = PgSlider;

/* === Form coordinator ===================================================== */

/**
 * `<form class="pg-form" novalidate>` coordinator. Registers child controls
 * through `providePgForm`, validates before submitting, exposes
 * `validate` / `resetValidation` / `reset` and emits `submit` only when valid.
 */
export const PgForm = dc(
    (
        props: {
            modelValue?: boolean;
            disabled?: boolean;
            fastFail?: boolean;
            ariaLabel?: string;
        },
        _expose,
        { attrs, emit, expose, slots },
    ) => {
        const api = providePgForm();

        const validate = async (): Promise<{ valid: boolean; errors: Array<{ id: string; errorMessages: string[] }> }> => {
            if (!props.fastFail) return api.validate();
            const errors: Array<{ id: string; errorMessages: string[] }> = [];
            for (const control of api.controls.values()) {
                let result: { valid: boolean; message: string };
                try {
                    result = control.validate();
                } catch {
                    result = { valid: false, message: "Invalid value" };
                }
                if (!result.valid) {
                    errors.push({ id: control.id, errorMessages: [result.message || "Invalid value"] });
                    try {
                        control.focus();
                    } catch {
                        /* focus is best effort */
                    }
                    break;
                }
            }
            return { valid: errors.length === 0, errors };
        };

        const resetValidation = () => {
            api.resetValidation();
        };

        const reset = () => {
            api.reset();
            api.resetValidation();
        };

        expose({ validate, reset, resetValidation });

        const onSubmit = (event: Event) => {
            event.preventDefault();
            if (props.disabled) return;
            void (async () => {
                const result = await validate();
                emit?.("update:modelValue", result.valid);
                if (!result.valid) return;
                emit?.("submit", event);
            })();
        };

        return () => (
            <form
                {...attrs}
                class={[
                    "pg-form",
                    props.disabled ? "pg-form--disabled" : "",
                    attrs.class,
                ]
                    .filter(Boolean)
                    .join(" ")}
                novalidate
                aria-disabled={props.disabled ? "true" : undefined}
                inert={props.disabled ? true : undefined}
                aria-label={props.ariaLabel || (attrs as { "aria-label"?: string })["aria-label"]}
                onSubmit={onSubmit}
            >
                {slots.default?.()}
            </form>
        );
    },
    {
        props: {
            modelValue: { type: Boolean, default: undefined },
            disabled: { type: Boolean, default: false },
            fastFail: { type: Boolean, default: false },
            ariaLabel: { type: String, default: "" },
        },
        emits: ["submit", "update:modelValue"],
        inheritAttrs: true,
    },
);
export const VForm = PgForm;

/* === Motion =============================================================== */

/**
 * CSS-driven motion wrapper. There is deliberately no VDOM `<Transition>`:
 * the preset becomes a class and reduced-motion users get an instant render.
 */
export const PgTransition = dc(
    (props: { name?: string; duration?: number }, _expose, { attrs, slots }) => () => (
        <div
            {...attrs}
            class={[
                "pg-transition",
                `pg-transition--${props.name ?? "fade"}`,
                attrs.class,
            ]
                .filter(Boolean)
                .join(" ")}
            style={[
                { "--pg-transition-duration": `${props.duration ?? 160}ms` },
                (attrs as { style?: any }).style,
            ]}
        >
            {slots.default?.()}
        </div>
    ),
    {
        props: {
            name: { type: String, default: "fade" },
            duration: { type: Number, default: 160 },
        },
        inheritAttrs: true,
    },
);

/* === Card sub-primitives ================================================== */

export const VCardText = dc(
    (_props, _expose, { attrs, slots }) => () => (
        <div {...attrs} class={["pg-card-text", attrs.class].filter(Boolean).join(" ")}>
            {slots.default?.()}
        </div>
    ),
    { inheritAttrs: true },
);

export const VCardActions = dc(
    (_props, _expose, { attrs, slots }) => () => (
        <div {...attrs} class={["pg-card-actions", attrs.class].filter(Boolean).join(" ")}>
            {slots.default?.()}
        </div>
    ),
    { inheritAttrs: true },
);

export const VCardTitle = dc(
    (_props, _expose, { attrs, slots }) => () => (
        <div {...attrs} class={["pg-card__title", attrs.class].filter(Boolean).join(" ")}>
            {slots.default?.()}
        </div>
    ),
    { inheritAttrs: true },
);

export const VCardSubtitle = dc(
    (_props, _expose, { attrs, slots }) => () => (
        <div {...attrs} class={["pg-card__subtitle", attrs.class].filter(Boolean).join(" ")}>
            {slots.default?.()}
        </div>
    ),
    { inheritAttrs: true },
);

export const PgCardText = VCardText;
export const PgCardActions = VCardActions;
export const PgCardTitle = VCardTitle;
export const PgCardSubtitle = VCardSubtitle;
export const SurfaceCardText = VCardText;
