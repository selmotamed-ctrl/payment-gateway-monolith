import { computed, ref } from "vue";

/**
 * Responsive helpers for the design system. Kept dependency-free (a resize
 * listener only) so a package primitive never pulls in a UI framework.
 */
const width = ref(typeof window === "undefined" ? 1280 : window.innerWidth);
let listening = false;

const ensureResize = () => {
    if (listening || typeof window === "undefined") return;
    listening = true;
    window.addEventListener("resize", () => {
        width.value = window.innerWidth;
    });
};

const readDirection = (): boolean =>
    typeof document !== "undefined" && document.documentElement.getAttribute("dir") === "rtl";

export const useRtl = () => computed(readDirection);

export const useDisplay = () => {
    ensureResize();
    return {
        width,
        mobile: computed(() => width.value < 600),
        sm: computed(() => width.value >= 600 && width.value < 960),
        md: computed(() => width.value >= 960 && width.value < 1280),
        lg: computed(() => width.value >= 1280 && width.value < 1920),
        xl: computed(() => width.value >= 1920),
        smAndDown: computed(() => width.value < 960),
        smAndUp: computed(() => width.value >= 600),
        mdAndDown: computed(() => width.value < 1280),
        mdAndUp: computed(() => width.value >= 960),
        lgAndUp: computed(() => width.value >= 1280),
    };
};
