import { createIf } from "@vue/runtime-vapor";

/** The Vapor JSX return type is a Block at runtime; the public type is narrower. */
const branch = createIf as any;
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from "vue";
import { dc } from "../lib/dc";
import { useClickOutside, useEscape, useFocusTrap, lockBodyScroll } from "../lib/dom";
import { useLocale } from "../lib/locale";
import { PgIcon } from "../actions/PgIcon";
import { closeOverlay, isTopOverlay, openOverlay, overlayZIndex } from "../lib/overlayStack";

const SIZES = new Set(["sm", "md", "lg", "xl"]);

/**
 * Strict three-zone modal. The close button lives in the header's flex-end
 * action slot (never `position: absolute`), so it can never overlap the title,
 * an input or a badge. Header 20/24, body 24 with a 20px row gap, footer 16/24.
 *
 * The overlay root is mounted through Vapor `createIf`, never a VDOM Teleport.
 */
export const PgDialog = dc(
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

        /** Imperative API for `ref` callers (Confirm/Details build on it). */
        const hide = () => {
            setVisible(false);
            if (overlayId) closeOverlay(overlayId);
            overlayId = null;
        };
        const show = () => {
            visible.value = true;
            emit?.("update:modelValue", true);
        };
        expose?.({ show, hide, close, get open() { return visible.value; } });

        watch(
            visible,
            (open, previous) => {
                if (open) {
                    releaseScroll = lockBodyScroll();
                    overlayId = openOverlay("dialog", () => {
                        visible.value = false;
                        emit?.("update:modelValue", false);
                    });
                    overlayZ.value = overlayZIndex(overlayId);
                } else {
                    releaseScroll?.();
                    releaseScroll = null;
                    if (overlayId) closeOverlay(overlayId);
                    overlayId = null;
                    overlayZ.value = null;
                    if (previous) {
                        void nextTick(() => emit?.("afterLeave"));
                    }
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
            () => {
                if (!props.persistent) close();
            },
            () => visible.value && !props.persistent && isTopOverlay(overlayId),
        );
        onBeforeUnmount(() => {
            releaseScroll?.();
            if (overlayId) closeOverlay(overlayId);
            overlayId = null;
        });

        const widthStyle = computed(() => {
            if (props.maxWidth === undefined || props.maxWidth === null || props.maxWidth === "") return undefined;
            const value = typeof props.maxWidth === "number" ? `${props.maxWidth}px` : String(props.maxWidth);
            return { width: `min(100%, ${value})` };
        });

        const hasHeader = computed(
            () => Boolean(props.title || props.subtitle || slots.header || slots.headerActions),
        );

        return () =>
            branch(
                () => visible.value,
                () => (
                    <div class="pg-dialog-backdrop" style={{ zIndex: overlayZ.value ?? undefined }}>
                        <div
                            ref={root}
                            class={[
                                "pg-dialog",
                                `pg-dialog--${size.value}`,
                                props.bare ? "pg-dialog--bare" : "",
                                props.contentClass,
                                attrs.class,
                            ]
                                .filter(Boolean)
                                .join(" ")}
                            role={props.role ?? "dialog"}
                            aria-modal="true"
                            aria-labelledby={props.title ? titleId : undefined}
                            aria-label={!props.title ? props.ariaLabel || undefined : undefined}
                            tabindex={-1}
                            style={[widthStyle.value, attrs.style]}
                        >
                            {hasHeader.value && (
                                <div class="pg-dialog__header">
                                    <div class="pg-dialog__heading">
                                        {props.title && (
                                            <h2 id={titleId} class="pg-dialog__title">
                                                {props.title}
                                            </h2>
                                        )}
                                        {props.subtitle && <p class="pg-dialog__subtitle">{props.subtitle}</p>}
                                        {slots.header?.()}
                                    </div>
                                    <div class="pg-dialog__header-actions">
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
                            )}
                            <div class="pg-dialog__body">{slots.default?.()}</div>
                            {slots.footer && <div class="pg-dialog__footer">{slots.footer()}</div>}
                        </div>
                    </div>
                ),
            );
    },
    {
        props: {
            modelValue: { type: Boolean, default: false },
            title: { type: String, default: "" },
            subtitle: { type: String, default: "" },
            size: { type: String, default: "md" },
            maxWidth: { type: [Number, String], default: undefined },
            /** Render no dialog surface or body padding; the slot content is the card. */
            bare: { type: Boolean, default: false },
            persistent: { type: Boolean, default: false },
            showClose: { type: Boolean, default: true },
            role: { type: String, default: "dialog" },
            ariaLabel: { type: String, default: "" },
            contentClass: { type: String, default: "" },
            /** Accepted for compatibility: the body always scrolls when needed. */
            scrollable: { type: Boolean, default: false },
            transition: { type: String, default: "" },
        },
        emits: ["update:modelValue", "afterLeave"],
        slots: ["default", "header", "headerActions", "footer"],
    },
);

export const VDialog = PgDialog;
