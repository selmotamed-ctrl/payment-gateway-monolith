import { onBeforeUnmount, ref, watch, type Ref } from "vue";

export const isBrowser = typeof window !== "undefined" && typeof document !== "undefined";

/** Runs `handler` for pointerdown outside every supplied element. */
export const useClickOutside = (
    elements: Array<Ref<HTMLElement | null>>,
    handler: (event: PointerEvent) => void,
    enabled: Ref<boolean> | (() => boolean) = () => true,
) => {
    if (!isBrowser) return () => undefined;
    const listener = (event: PointerEvent) => {
        const active = typeof enabled === "function" ? enabled() : enabled.value;
        if (!active) return;
        const target = event.target as Node | null;
        if (!target) return;
        if (elements.some((element) => element.value?.contains(target))) return;
        handler(event);
    };
    document.addEventListener("pointerdown", listener, true);
    const stop = () => document.removeEventListener("pointerdown", listener, true);
    onBeforeUnmount(stop);
    return stop;
};

/** Escape key while `enabled` is true. */
export const useEscape = (handler: (event: KeyboardEvent) => void, enabled: Ref<boolean> | (() => boolean) = () => true) => {
    if (!isBrowser) return () => undefined;
    const listener = (event: KeyboardEvent) => {
        if (event.key !== "Escape") return;
        const active = typeof enabled === "function" ? enabled() : enabled.value;
        if (active) handler(event);
    };
    document.addEventListener("keydown", listener);
    const stop = () => document.removeEventListener("keydown", listener);
    onBeforeUnmount(stop);
    return stop;
};

let scrollLocks = 0;
let previousOverflow = "";

/** Reference-counted body scroll lock shared by dialogs and drawers. */
export const lockBodyScroll = () => {
    if (!isBrowser) return () => undefined;
    if (scrollLocks === 0) {
        previousOverflow = document.body.style.overflow;
        document.body.style.overflow = "hidden";
    }
    scrollLocks += 1;
    let released = false;
    return () => {
        if (released) return;
        released = true;
        scrollLocks = Math.max(0, scrollLocks - 1);
        if (scrollLocks === 0) document.body.style.overflow = previousOverflow;
    };
};

const FOCUSABLE =
    'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** Focus trap + initial focus + focus return for modal surfaces. */
export const useFocusTrap = (root: Ref<HTMLElement | null>, active: Ref<boolean>) => {
    if (!isBrowser) return;
    let restoreTo: HTMLElement | null = null;

    const focusables = (): HTMLElement[] => {
        const element = root.value;
        if (!element) return [];
        return [...element.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
            (candidate) => !candidate.hasAttribute("hidden") && candidate.offsetParent !== null,
        );
    };

    const onKeydown = (event: KeyboardEvent) => {
        if (event.key !== "Tab" || !active.value) return;
        const list = focusables();
        if (!list.length) {
            event.preventDefault();
            root.value?.focus();
            return;
        }
        const first = list[0]!;
        const last = list[list.length - 1]!;
        const current = document.activeElement as HTMLElement | null;
        if (event.shiftKey && (current === first || current === root.value)) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && current === last) {
            event.preventDefault();
            first.focus();
        }
    };

    const stopWatch = watch(
        active,
        (open) => {
            if (!open) {
                if (restoreTo) restoreTo.focus?.();
                restoreTo = null;
                return;
            }
            restoreTo = document.activeElement as HTMLElement | null;
            requestAnimationFrame(() => {
                const autofocus = root.value?.querySelector<HTMLElement>("[autofocus]");
                const first = autofocus ?? focusables()[0];
                (first ?? root.value)?.focus?.();
            });
            document.addEventListener("keydown", onKeydown);
        },
        { immediate: true },
    );

    onBeforeUnmount(() => {
        document.removeEventListener("keydown", onKeydown);
        stopWatch();
    });
};

/** Copies text with a hidden-textarea fallback for non-secure contexts. */
export const copyToClipboard = async (text: string): Promise<boolean> => {
    if (!isBrowser || !text) return false;
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch {
        /* fall through */
    }
    try {
        const input = document.createElement("textarea");
        input.value = text;
        input.setAttribute("readonly", "");
        input.style.position = "fixed";
        input.style.opacity = "0";
        document.body.appendChild(input);
        input.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(input);
        return ok;
    } catch {
        return false;
    }
};

/** Resolves a host route (`to`) to an href through the injected router. */
export const routeHref = (to: any, resolve?: (to: any) => string): string => {
    if (!to) return "";
    if (typeof to === "string") return to;
    try {
        return resolve?.(to) ?? "";
    } catch {
        return "";
    }
};

/**
 * Viewports where floating pickers become bottom sheets: phones in portrait,
 * and short touch screens (phones in landscape) where a popover cannot fit.
 */
export const PG_SHEET_MEDIA_QUERY =
    "(max-width: 640px), (pointer: coarse) and (max-height: 520px)";

/** Reactive `matchMedia` result; always `false` outside the browser. */
export const useMediaQuery = (query: string): Ref<boolean> => {
    const matches = ref(false);
    if (!isBrowser || typeof window.matchMedia !== "function") return matches;
    const media = window.matchMedia(query);
    matches.value = media.matches;
    const onChange = (event: MediaQueryListEvent) => {
        matches.value = event.matches;
    };
    if (typeof media.addEventListener === "function") media.addEventListener("change", onChange);
    else media.addListener?.(onChange);
    onBeforeUnmount(() => {
        if (typeof media.removeEventListener === "function") media.removeEventListener("change", onChange);
        else media.removeListener?.(onChange);
    });
    return matches;
};

/** Resolves a `sheet` prop (`"auto"` | `true` | `false`) against the viewport. */
export const useSheetMode = (prop: () => unknown): Ref<boolean> => {
    const compact = useMediaQuery(PG_SHEET_MEDIA_QUERY);
    const mode = ref(false);
    watch(
        [prop, compact],
        ([value, isCompact]) => {
            mode.value =
                value === true || value === "always"
                    ? true
                    : value === false || value === "never"
                      ? false
                      : Boolean(isCompact);
        },
        { immediate: true },
    );
    return mode;
};

/**
 * Swipe-down-to-dismiss for a bottom sheet. Bind the returned handlers to the
 * sheet's grab area; the panel follows the finger and closes past `threshold`.
 */
export const createSheetDrag = (
    panel: Ref<HTMLElement | null>,
    close: () => void,
    threshold = 72,
) => {
    let startY = 0;
    let delta = 0;
    let dragging = false;
    const reset = () => {
        const element = panel.value;
        if (!element) return;
        element.style.transition = "";
        element.style.transform = "";
    };
    return {
        onTouchstart: (event: TouchEvent) => {
            const touch = event.touches[0];
            if (!touch) return;
            dragging = true;
            startY = touch.clientY;
            delta = 0;
            if (panel.value) panel.value.style.transition = "none";
        },
        onTouchmove: (event: TouchEvent) => {
            if (!dragging) return;
            const touch = event.touches[0];
            if (!touch) return;
            delta = Math.max(0, touch.clientY - startY);
            if (panel.value) panel.value.style.transform = delta ? `translateY(${delta}px)` : "";
        },
        onTouchend: () => {
            if (!dragging) return;
            dragging = false;
            const shouldClose = delta > threshold;
            reset();
            if (shouldClose) close();
        },
        onTouchcancel: () => {
            dragging = false;
            reset();
        },
    };
};
