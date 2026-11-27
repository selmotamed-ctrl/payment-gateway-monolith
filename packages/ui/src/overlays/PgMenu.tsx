import { createIf } from "@vue/runtime-vapor";

/** The Vapor JSX return type is a Block at runtime; the public type is narrower. */
const branch = createIf as any;
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { dc } from "../lib/dc";
import { useClickOutside, useEscape } from "../lib/dom";
import { closeOverlay, openOverlay } from "../lib/overlayStack";

const MENU_ITEM = '[role="menuitem"]:not([disabled]):not([aria-disabled="true"])';
const FOCUSABLE_ITEM = `${MENU_ITEM}, button:not([disabled]), a[href]`;
const MIN_WIDTH = 190;
const VIEWPORT_MARGIN = 8;

const readDirection = () => {
    if (typeof document === "undefined") return "ltr";
    return document.documentElement.getAttribute("dir") === "rtl" ? "rtl" : "ltr";
};

/**
 * Viewport-aware action menu with no VDOM Teleport: the panel is a fixed
 * sibling inside the anchor's Vapor `createIf` branch, so it escapes
 * `overflow: hidden` ancestors and stacks above every surface through
 * `--pg-z-popover`.
 *
 * `activator` receives `{ props }` (onClick, ref, aria-expanded,
 * aria-haspopup) and may spread it onto its button. The menu supports
 * controlled (`v-model` / `:open`) and uncontrolled use, bottom/top ×
 * start/end alignment, ArrowUp/ArrowDown navigation, Escape and outside-click.
 */
export const PgMenu = dc(
    (props: Record<string, any>, expose, { attrs, emit, slots }) => {
        const anchor = ref<HTMLElement | null>(null);
        const trigger = ref<HTMLElement | null>(null);
        const panel = ref<HTMLElement | null>(null);
        const controlled = computed<boolean | null>(() => {
            if (props.modelValue !== undefined && props.modelValue !== null) return Boolean(props.modelValue);
            if (props.open !== undefined && props.open !== null) return Boolean(props.open);
            return null;
        });
        const openState = ref(Boolean(controlled.value));
        const style = ref<Record<string, string>>({ position: "fixed", zIndex: "var(--pg-z-popover)" });
        let overlayId: string | null = null;
        let closeTimer: ReturnType<typeof setTimeout> | undefined;
        let openTimer: ReturnType<typeof setTimeout> | undefined;
        let restoreFocus = false;
        /** Plain mirror so the activator slot is not re-rendered by open state. */
        let openMirror = openState.value;

        watch(
            controlled,
            (value) => {
                if (value === null || value === openState.value) return;
                openState.value = value;
            },
        );

        const isOpen = () => openState.value;
        const setOpen = (next: boolean, notify = true) => {
            if (openState.value === next) return;
            openState.value = next;
            if (!notify) return;
            emit?.("update:modelValue", next);
            emit?.("update:open", next);
        };

        const activatorElement = (): HTMLElement | null => {
            const root = trigger.value;
            if (!root) return anchor.value;
            return root.querySelector<HTMLElement>('button, a, [role="button"], [tabindex]') ?? root;
        };

        const decorateActivator = () => {
            const element = activatorElement();
            if (!element) return;
            element.setAttribute("aria-haspopup", "menu");
            element.setAttribute("aria-expanded", isOpen() ? "true" : "false");
            if (typeof element.focus === "function") element.setAttribute("data-pg-menu-trigger", "");
        };

        const panelWidth = () => {
            const element = panel.value;
            if (!element) return MIN_WIDTH;
            const rect = element.getBoundingClientRect();
            return rect.width || element.offsetWidth || MIN_WIDTH;
        };
        const panelHeight = () => {
            const element = panel.value;
            if (!element) return 0;
            const rect = element.getBoundingClientRect();
            return rect.height || element.offsetHeight || 0;
        };

        const updatePosition = () => {
            const element = anchor.value;
            if (!element || typeof window === "undefined") return;
            const rect = element.getBoundingClientRect();
            const width = Math.min(panelWidth(), Math.max(0, window.innerWidth - VIEWPORT_MARGIN * 2));
            const height = panelHeight();
            const location = String(props.location ?? "bottom start").trim().toLowerCase();
            const [verticalRaw, alignRaw] = location.split(/\s+/);
            const vertical = verticalRaw === "top" ? "top" : "bottom";
            const align = alignRaw === "end" ? "end" : "start";
            const rtl = readDirection() === "rtl";
            const offset = Number(props.offset ?? 6);
            const spaceBelow = window.innerHeight - rect.bottom;
            const spaceAbove = rect.top;

            let top: number;
            let placement = vertical;
            if (vertical === "bottom" && spaceBelow < 240) {
                top = rect.top - height - offset;
                placement = "top";
            } else if (vertical === "top" && spaceAbove < height + offset + VIEWPORT_MARGIN && spaceBelow > spaceAbove) {
                top = rect.bottom + offset;
                placement = "bottom";
            } else {
                top = vertical === "top" ? rect.top - height - offset : rect.bottom + offset;
            }
            top = Math.max(VIEWPORT_MARGIN, Math.min(top, Math.max(VIEWPORT_MARGIN, window.innerHeight - height - VIEWPORT_MARGIN)));

            let left: number;
            if (align === "end") left = rtl ? rect.left : rect.right - width;
            else left = rtl ? rect.right - width : rect.left;
            left = Math.max(VIEWPORT_MARGIN, Math.min(left, Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN)));

            style.value = {
                position: "fixed",
                top: `${Math.round(top)}px`,
                left: `${Math.round(left)}px`,
                zIndex: "var(--pg-z-popover)",
            };
            panel.value?.setAttribute("data-placement", `${placement} ${align}`);
        };

        const menuItems = (): HTMLElement[] => {
            const list = panel.value;
            if (!list) return [];
            return [...list.querySelectorAll<HTMLElement>(FOCUSABLE_ITEM)].filter(
                (item) => !item.hasAttribute("disabled") && item.getAttribute("aria-disabled") !== "true",
            );
        };

        const focusItem = (index: number) => {
            const list = menuItems();
            if (!list.length) return;
            const next = (index + list.length) % list.length;
            list[next]?.focus();
        };

        const focusFirst = () => {
            const list = menuItems();
            const first = panel.value?.querySelector<HTMLElement>(MENU_ITEM) ?? list[0];
            (first ?? panel.value)?.focus?.();
        };

        const clearTimers = () => {
            if (closeTimer) clearTimeout(closeTimer);
            if (openTimer) clearTimeout(openTimer);
            closeTimer = undefined;
            openTimer = undefined;
        };

        const close = (restore = true) => {
            if (!restore) restoreFocus = false;
            setOpen(false);
        };

        const openPanel = (keyboard = false) => {
            if (isOpen()) return;
            restoreFocus = keyboard;
            setOpen(true);
        };

        const toggle = (keyboard = false) => {
            if (isOpen()) close();
            else void openPanel(keyboard);
        };

        watch(
            openState,
            (open, previous) => {
                openMirror = open;
                clearTimers();
                if (open) {
                    overlayId = openOverlay("menu", () => setOpen(false, true));
                } else if (overlayId) {
                    closeOverlay(overlayId);
                    overlayId = null;
                }
                if (open) {
                    void nextTick(() => {
                        updatePosition();
                        decorateActivator();
                        if (restoreFocus) focusFirst();
                        if (typeof window !== "undefined") {
                            window.addEventListener("resize", updatePosition, { passive: true });
                            window.addEventListener("scroll", updatePosition, true);
                        }
                    });
                } else {
                    if (typeof window !== "undefined") {
                        window.removeEventListener("resize", updatePosition);
                        window.removeEventListener("scroll", updatePosition, true);
                    }
                    decorateActivator();
                    if (previous && restoreFocus) activatorElement()?.focus?.();
                    restoreFocus = false;
                }
            },
            { immediate: true },
        );

        watch(
            () => props.location,
            () => {
                if (isOpen()) void nextTick(updatePosition);
            },
        );

        useEscape(
            (event) => {
                event?.stopPropagation?.();
                close();
            },
            () => isOpen(),
        );
        useClickOutside([anchor, panel], () => close(false), () => isOpen());

        const onActivatorClick = (event: MouseEvent) => {
            event?.stopPropagation?.();
            clearTimers();
            if (props.openOnClick === false) return;
            toggle(event.detail === 0);
        };

        const onPanelKeydown = (event: KeyboardEvent) => {
            if (event.key === "ArrowDown") {
                event.preventDefault();
                const list = menuItems();
                const current = list.indexOf(document.activeElement as HTMLElement);
                focusItem(current < 0 ? 0 : current + 1);
            } else if (event.key === "ArrowUp") {
                event.preventDefault();
                const list = menuItems();
                const current = list.indexOf(document.activeElement as HTMLElement);
                focusItem(current <= 0 ? list.length - 1 : current - 1);
            }
        };

        const activatorProps = () => ({
            onClick: onActivatorClick,
            ref: (instance: any) => {
                const node = instance?.$el ?? instance;
                if (node instanceof HTMLElement) decorateActivator();
            },
            "aria-expanded": openMirror ? "true" : "false",
            "aria-haspopup": "menu",
        });

        void nextTick(decorateActivator);

        onBeforeUnmount(() => {
            clearTimers();
            if (overlayId) closeOverlay(overlayId);
            overlayId = null;
            if (typeof window !== "undefined") {
                window.removeEventListener("resize", updatePosition);
                window.removeEventListener("scroll", updatePosition, true);
            }
        });

        return () => (
            <span
                ref={anchor}
                class={["pg-menu-anchor", attrs.class].filter(Boolean).join(" ")}
                onClick={(event: MouseEvent) => {
                    if (panel.value?.contains(event.target as Node)) return;
                    if (props.openOnClick === false) return;
                    toggle(event.detail === 0);
                }}
                onKeydown={(event: KeyboardEvent) => {
                    if (isOpen()) return;
                    if (event.key === "ArrowDown") {
                        event.preventDefault();
                        void openPanel(true);
                    }
                }}
                onMouseenter={() => {
                    if (!props.openOnHover) return;
                    clearTimers();
                    if (isOpen()) return;
                    openTimer = setTimeout(() => void openPanel(false), 0);
                }}
                onMouseleave={() => {
                    if (!props.openOnHover || !isOpen()) return;
                    clearTimers();
                    closeTimer = setTimeout(() => close(), Number(props.closeDelay ?? 120));
                }}
                aria-expanded={isOpen() ? "true" : "false"}
            >
                <span class="pg-menu-trigger" ref={trigger}>
                    {slots.activator?.({ props: activatorProps() })}
                </span>
                {branch(
                    () => isOpen(),
                    () => (
                        <div
                            ref={panel}
                            class="pg-menu-panel pg-z-popover"
                            role="menu"
                            tabindex={-1}
                            style={style.value}
                            onClick={(event: MouseEvent) => {
                                event.stopPropagation();
                                close(false);
                            }}
                            onKeydown={onPanelKeydown}
                            onFocusin={() => {
                                restoreFocus = true;
                            }}
                            onMouseenter={() => {
                                if (closeTimer) clearTimeout(closeTimer);
                            }}
                            onMouseleave={() => {
                                if (!props.openOnHover) return;
                                closeTimer = setTimeout(() => close(), Number(props.closeDelay ?? 120));
                            }}
                        >
                            {slots.default?.()}
                        </div>
                    ),
                )}
            </span>
        );
    },
    {
        props: {
            modelValue: { type: Boolean, default: null },
            open: { type: Boolean, default: null },
            location: { type: String, default: "bottom start" },
            offset: { type: Number, default: 6 },
            openOnClick: { type: Boolean, default: true },
            openOnHover: { type: Boolean, default: false },
            closeDelay: { type: Number, default: 120 },
        },
        emits: ["update:modelValue", "update:open"],
        slots: ["activator", "default"],
        inheritAttrs: true,
    },
);

export const VMenu = PgMenu;
