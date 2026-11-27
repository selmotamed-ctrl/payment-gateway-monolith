import { createIf } from "@vue/runtime-vapor";

/** The Vapor JSX return type is a Block at runtime; the public type is narrower. */
const branch = createIf as any;
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from "vue";
import { dc } from "../lib/dc";
import { useEscape } from "../lib/dom";
import { closeOverlay, openOverlay } from "../lib/overlayStack";

const VIEWPORT_MARGIN = 8;
const FLIP_TOP = 48;

const readDirection = () => {
    if (typeof document === "undefined") return "ltr";
    return document.documentElement.getAttribute("dir") === "rtl" ? "rtl" : "ltr";
};

const coarsePointer = () => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
    try {
        return window.matchMedia("(hover: none)").matches;
    } catch {
        return false;
    }
};

/**
 * Delayed hover/focus tooltip rendered through Vapor `createIf` and fixed
 * positioning, so it escapes every `overflow: hidden` ancestor and stacks above
 * modals through `--pg-z-tooltip`.
 *
 * Hover waits 220ms; keyboard focus is immediate. It hides on Escape,
 * mouseleave, scroll, click and focusout, never steals focus, and links the
 * trigger through `aria-describedby` only while visible.
 */
export const PgTooltip = dc(
    (props: Record<string, any>, _expose, { attrs, slots }) => {
        const anchor = ref<HTMLElement | null>(null);
        const panel = ref<HTMLElement | null>(null);
        const visible = ref(false);
        const maxWidth = computed(() => {
            if (props.compact) return 260;
            const value = Number(props.maxWidth ?? 320);
            return Number.isFinite(value) && value > 0 ? value : 320;
        });
        const style = ref<Record<string, string>>({
            position: "fixed",
            zIndex: "var(--pg-z-tooltip)",
            maxWidth: `${maxWidth.value}px`,
        });
        const tooltipId = useId();
        let timer: ReturnType<typeof setTimeout> | undefined;
        let overlayId: string | null = null;
        let described: Array<{ element: HTMLElement; previous: string | null }> = [];
        let pointerInside = false;
        let keyboardActivation = false;

        const describedTargets = (): HTMLElement[] => {
            const root = anchor.value;
            if (!root) return [];
            const focusable = root.querySelector<HTMLElement>("button, a[href], input, textarea, select, [tabindex]");
            return [focusable, root].filter((element, index, all): element is HTMLElement => Boolean(element) && all.indexOf(element) === index);
        };

        const setDescribedBy = (on: boolean) => {
            if (on) {
                described = [];
                for (const element of describedTargets()) {
                    const previous = element.getAttribute("aria-describedby");
                    element.setAttribute("aria-describedby", [previous, tooltipId].filter(Boolean).join(" "));
                    described.push({ element, previous });
                }
                return;
            }
            for (const entry of described) {
                if (entry.previous) entry.element.setAttribute("aria-describedby", entry.previous);
                else entry.element.removeAttribute("aria-describedby");
            }
            described = [];
        };

        const close = () => {
            if (timer) clearTimeout(timer);
            timer = undefined;
            if (!visible.value) return;
            visible.value = false;
            setDescribedBy(false);
            if (overlayId) closeOverlay(overlayId);
            overlayId = null;
        };

        const viewportWidth = () => (typeof window === "undefined" ? 1024 : window.innerWidth);
        const viewportHeight = () => (typeof window === "undefined" ? 768 : window.innerHeight);
        const tooltipWidth = () => {
            const element = panel.value;
            if (!element) return Math.min(maxWidth.value, 240);
            const rect = element.getBoundingClientRect();
            return rect.width || element.offsetWidth || Math.min(maxWidth.value, 240);
        };
        const tooltipHeight = () => {
            const element = panel.value;
            if (!element) return 34;
            const rect = element.getBoundingClientRect();
            return rect.height || element.offsetHeight || 34;
        };

        const updatePosition = () => {
            const element = anchor.value;
            if (!element || typeof window === "undefined") return;
            const rect = element.getBoundingClientRect();
            const width = tooltipWidth();
            const height = tooltipHeight();
            const location = String(props.location ?? "top").toLowerCase();
            const rtl = readDirection() === "rtl";
            let left: number;
            let top: number;

            if (location === "start" || location === "end") {
                const inlineStart = location === "start" ? !rtl : rtl;
                left = inlineStart ? rect.left - width - VIEWPORT_MARGIN : rect.right + VIEWPORT_MARGIN;
                top = rect.top + rect.height / 2 - height / 2;
                if (inlineStart && left < VIEWPORT_MARGIN && rect.right + width + VIEWPORT_MARGIN < viewportWidth()) {
                    left = rect.right + VIEWPORT_MARGIN;
                } else if (!inlineStart && left + width > viewportWidth() - VIEWPORT_MARGIN && rect.left - width - VIEWPORT_MARGIN > 0) {
                    left = rect.left - width - VIEWPORT_MARGIN;
                }
            } else {
                let above = location !== "bottom";
                if (above && rect.top < FLIP_TOP) above = false;
                if (!above && rect.bottom + height + VIEWPORT_MARGIN > viewportHeight() && rect.top > height + FLIP_TOP) above = true;
                top = above ? rect.top - height - VIEWPORT_MARGIN : rect.bottom + VIEWPORT_MARGIN;
                left = rect.left + rect.width / 2 - width / 2;
            }

            left = Math.max(VIEWPORT_MARGIN, Math.min(left, Math.max(VIEWPORT_MARGIN, viewportWidth() - width - VIEWPORT_MARGIN)));
            top = Math.max(VIEWPORT_MARGIN, Math.min(top, Math.max(VIEWPORT_MARGIN, viewportHeight() - height - VIEWPORT_MARGIN)));
            const widthLimit = Math.min(maxWidth.value, viewportWidth() < 640 ? 260 : maxWidth.value, viewportWidth() - VIEWPORT_MARGIN * 2);

            style.value = {
                position: "fixed",
                left: `${Math.round(left)}px`,
                top: `${Math.round(top)}px`,
                maxWidth: `${Math.max(80, widthLimit)}px`,
                zIndex: "var(--pg-z-tooltip)",
            };
        };

        const reveal = () => {
            if (visible.value || props.disabled) return;
            visible.value = true;
            overlayId = openOverlay("tooltip", close);
            setDescribedBy(true);
            void nextTick(updatePosition);
            if (typeof window !== "undefined") {
                window.addEventListener("scroll", close, true);
            }
        };

        const show = (delayMs = Number(props.delay ?? props.openDelay ?? 220)) => {
            if (props.disabled) return;
            if (timer) clearTimeout(timer);
            timer = undefined;
            if (delayMs <= 0) {
                reveal();
                return;
            }
            timer = setTimeout(reveal, delayMs);
        };

        const hide = () => close();

        useEscape((event) => {
            event?.stopPropagation?.();
            hide();
        });

        watch(visible, (open) => {
            if (!open && typeof window !== "undefined") {
                window.removeEventListener("scroll", close, true);
            }
        });
        watch(
            () => props.disabled,
            (disabled) => {
                if (disabled) hide();
            },
        );

        onBeforeUnmount(() => {
            if (timer) clearTimeout(timer);
            if (typeof window !== "undefined") window.removeEventListener("scroll", close, true);
            setDescribedBy(false);
            if (overlayId) closeOverlay(overlayId);
            overlayId = null;
        });

        return () => (
            <span
                ref={anchor}
                class={["pg-tooltip-anchor", attrs.class].filter(Boolean).join(" ")}
                onMouseenter={() => {
                    if (coarsePointer()) return;
                    pointerInside = true;
                    show(Number(props.delay ?? props.openDelay ?? 220));
                }}
                onMouseover={() => {
                    if (pointerInside || coarsePointer()) return;
                    pointerInside = true;
                    show(Number(props.delay ?? props.openDelay ?? 220));
                }}
                onMouseleave={() => {
                    pointerInside = false;
                    hide();
                }}
                onFocusin={() => {
                    if (coarsePointer()) return;
                    show(0);
                }}
                onFocusout={hide}
                onPointerdown={(event: PointerEvent) => {
                    keyboardActivation = false;
                    if (event.pointerType && event.pointerType !== "mouse") hide();
                }}
                onKeydown={(event: KeyboardEvent) => {
                    if (event.key === "Enter" || event.key === " ") keyboardActivation = true;
                }}
                onClick={() => {
                    if (keyboardActivation) {
                        keyboardActivation = false;
                        return;
                    }
                    hide();
                }}
            >
                {slots.default?.()}
                {branch(
                    () => visible.value,
                    () => (
                        <span
                            ref={panel}
                            id={tooltipId}
                            class="pg-tooltip pg-z-tooltip"
                            role="tooltip"
                            style={style.value}
                        >
                            {slots.content ? slots.content() : props.text || props.content}
                        </span>
                    ),
                )}
            </span>
        );
    },
    {
        props: {
            text: { type: String, default: "" },
            content: { type: String, default: "" },
            location: { type: String, default: "top" },
            delay: { type: Number, default: undefined },
            openDelay: { type: Number, default: undefined },
            maxWidth: { type: Number, default: 320 },
            compact: { type: Boolean, default: false },
            disabled: { type: Boolean, default: false },
        },
        slots: ["default", "content"],
        inheritAttrs: true,
    },
);

export const VTooltip = PgTooltip;
