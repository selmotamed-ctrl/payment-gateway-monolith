import { createIf } from "@vue/runtime-vapor";

/** The Vapor JSX return type is a Block at runtime; the public type is narrower. */
const branch = createIf as any;
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from "vue";
import { dc } from "../lib/dc";
import { lockBodyScroll, useClickOutside, useEscape, useFocusTrap } from "../lib/dom";
import { useLocale } from "../lib/locale";
import { PgIcon } from "../actions/PgIcon";
import { closeOverlay, isTopOverlay, openOverlay, overlayZIndex } from "../lib/overlayStack";

const SIZES = new Set(["sm", "md", "lg", "xl"]);

/**
 * End-side slide-over inspector. Drawers may stack on top of one another (the
 * last opened is always on top); opening a command palette closes them so the
 * two navigation surfaces can never overlap.
 *
 * The body is the only scroll container (`min-height: 0; flex: 1 1 auto`) so a
 * long record never pushes the header or footer out of the viewport.
 */
export const PgDrawer = dc(
    (props: Record<string, any>, expose, { attrs, emit, slots }) => {
        const { t } = useLocale();
        const root = ref<HTMLElement | null>(null);
        const titleId = useId();
        const visible = ref(Boolean(props.modelValue));
        const size = computed(() => (SIZES.has(String(props.size)) ? String(props.size) : "md"));
        let releaseScroll: (() => void) | null = null;
        let overlayId: string | null = null;
        const overlayZ = ref<number | null>(null);

        watch(
            () => props.modelValue,
            (value) => {
                if (value !== undefined) visible.value = Boolean(value);
            },
        );

        const setVisible = (next: boolean, notify = true) => {
            if (visible.value === next) return;
            visible.value = next;
            if (notify) emit?.("update:modelValue", next);
        };
        const close = () => {
            if (props.persistent) return;
            setVisible(false);
        };

        expose?.({
            close,
            show: () => {
                visible.value = true;
                emit?.("update:modelValue", true);
            },
            hide: () => setVisible(false),
            get open() {
                return visible.value;
            },
        });

        watch(
            visible,
            (open, previous) => {
                if (open) {
                    if (props.scrim !== false) releaseScroll = lockBodyScroll();
                    overlayId = openOverlay("drawer", () => setVisible(false));
                    overlayZ.value = overlayZIndex(overlayId);
                } else {
                    releaseScroll?.();
                    releaseScroll = null;
                    if (overlayId) closeOverlay(overlayId);
                    overlayId = null;
                    overlayZ.value = null;
                    if (previous) void nextTick(() => emit?.("afterLeave"));
                }
            },
            { immediate: true },
        );

        useFocusTrap(root, visible);
        useEscape(
            (event) => {
                if (props.persistent) return;
                event?.stopPropagation?.();
                close();
            },
            visible,
        );
        useClickOutside(
            [root],
            () => close(),
            () => visible.value && props.scrim !== false && !props.persistent && isTopOverlay(overlayId),
        );
        onBeforeUnmount(() => {
            releaseScroll?.();
            if (overlayId) closeOverlay(overlayId);
            overlayId = null;
        });

        const widthStyle = computed(() => {
            if (!props.width) return undefined;
            const value = typeof props.width === "number" ? `${props.width}px` : String(props.width);
            return { width: `min(100vw, ${value})` };
        });

        return () =>
            branch(
                () => visible.value,
                () => (
                    <div
                        style={{ zIndex: overlayZ.value ?? undefined }}
                        class={[
                            "pg-drawer-backdrop",
                            props.scrim === false ? "pg-drawer-backdrop--no-scrim" : "pg-drawer-backdrop--scrim",
                        ]
                            .filter(Boolean)
                            .join(" ")}
                    >
                        <aside
                            ref={root}
                            class={["pg-slideover", `pg-slideover--${size.value}`, props.contentClass, attrs.class]
                                .filter(Boolean)
                                .join(" ")}
                            role={props.role ?? "complementary"}
                            aria-modal={props.role === "dialog" ? "true" : undefined}
                            aria-labelledby={props.title ? titleId : undefined}
                            aria-label={!props.title ? props.ariaLabel || undefined : undefined}
                            tabindex={-1}
                            style={[widthStyle.value, attrs.style]}
                        >
                            <div class="pg-slideover__header">
                                <div class="pg-slideover__heading">
                                    {props.eyebrow && <p class="pg-slideover__eyebrow">{props.eyebrow}</p>}
                                    {props.title && (
                                        <h2 id={titleId} class="pg-dialog__title pg-slideover__title">
                                            {props.title}
                                        </h2>
                                    )}
                                    {props.subtitle && <p class="pg-dialog__subtitle">{props.subtitle}</p>}
                                    {slots.header?.()}
                                </div>
                                <div class="pg-slideover__header-actions">
                                    {slots.headerActions?.()}
                                    {props.showClose !== false && (
                                        <button
                                            type="button"
                                            class="pg-dialog__close pg-icon-btn"
                                            aria-label={t("Close")}
                                            disabled={Boolean(props.persistent)}
                                            onClick={close}
                                        >
                                            <PgIcon icon="mdi-close" size={18} />
                                        </button>
                                    )}
                                </div>
                            </div>
                            <div class="pg-slideover__body">{slots.default?.()}</div>
                            {slots.footer && <div class="pg-slideover__footer">{slots.footer()}</div>}
                        </aside>
                    </div>
                ),
            );
    },
    {
        props: {
            modelValue: { type: Boolean, default: false },
            title: { type: String, default: "" },
            subtitle: { type: String, default: "" },
            eyebrow: { type: String, default: "" },
            size: { type: String, default: "md" },
            /** Optional pixel width for legacy callers; overrides the size token. */
            width: { type: [Number, String], default: undefined },
            scrim: { type: Boolean, default: true },
            persistent: { type: Boolean, default: false },
            showClose: { type: Boolean, default: true },
            role: { type: String, default: "complementary" },
            ariaLabel: { type: String, default: "" },
            contentClass: { type: String, default: "" },
        },
        emits: ["update:modelValue", "afterLeave"],
        slots: ["default", "header", "headerActions", "footer"],
    },
);

export const SlideOverDrawer = PgDrawer;
