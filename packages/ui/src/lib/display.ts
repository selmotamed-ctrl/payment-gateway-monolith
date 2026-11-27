import { computed, ref } from "vue";
import { isRtlLocale } from "./locale";

/**
 * Responsive helpers for the design system. One shared, rAF-throttled resize
 * listener feeds every mounted component (never N listeners for N components).
 * SSR/jsdom safe: the default viewport is 1280×800 (`lg`, not mobile).
 */
const SSR_WIDTH = 1280;
const SSR_HEIGHT = 800;

const readWidth = () => (typeof window === "undefined" ? SSR_WIDTH : window.innerWidth || SSR_WIDTH);
const readHeight = () => (typeof window === "undefined" ? SSR_HEIGHT : window.innerHeight || SSR_HEIGHT);

const width = ref(readWidth());
const height = ref(readHeight());

let listening = false;
let frame = 0;

const measure = () => {
    frame = 0;
    width.value = readWidth();
    height.value = readHeight();
};

const ensureResize = () => {
    if (listening || typeof window === "undefined") return;
    listening = true;
    window.addEventListener(
        "resize",
        () => {
            if (frame) return;
            frame = requestAnimationFrame(measure);
        },
        { passive: true },
    );
};

const breakpointName = computed<"xs" | "sm" | "md" | "lg" | "xl">(() => {
    if (width.value < 600) return "xs";
    if (width.value < 960) return "sm";
    if (width.value < 1280) return "md";
    if (width.value < 1920) return "lg";
    return "xl";
});

/**
 * Text direction follows the reactive locale store (not a one-off
 * `document.dir` read), so chevrons, drawer anchors and floats flip the moment
 * the operator switches language.
 */
export const useRtl = () => computed(() => isRtlLocale.value);

export const useDisplay = () => {
    ensureResize();
    return {
        width,
        height,
        name: breakpointName,
        xs: computed(() => width.value < 600),
        sm: computed(() => width.value >= 600 && width.value < 960),
        md: computed(() => width.value >= 960 && width.value < 1280),
        lg: computed(() => width.value >= 1280 && width.value < 1920),
        xl: computed(() => width.value >= 1920),
        smAndDown: computed(() => width.value < 960),
        smAndUp: computed(() => width.value >= 600),
        mdAndDown: computed(() => width.value < 1280),
        mdAndUp: computed(() => width.value >= 960),
        lgAndDown: computed(() => width.value < 1920),
        lgAndUp: computed(() => width.value >= 1280),
        /** Below 960 px the shell swaps the permanent rail for an overlay drawer. */
        mobile: computed(() => width.value < 960),
        isRtl: computed(() => isRtlLocale.value),
    };
};

export type PgDisplay = ReturnType<typeof useDisplay>;

/** Test/reset hook: forces a viewport measurement outside a browser resize. */
export const setDisplayViewport = (nextWidth: number, nextHeight = readHeight()) => {
    width.value = nextWidth;
    height.value = nextHeight;
};
