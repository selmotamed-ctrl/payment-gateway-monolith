/**
 * Landing-page motion helpers.
 *
 * Rules (see design/06-ui/merchant_landing_page_redesign.md §Motion system):
 * - Nothing is hidden unless JS + IntersectionObserver are available AND the user
 *   has not asked for reduced motion. Content is always readable without motion.
 * - `prefers-reduced-motion: reduce` removes motion entirely (no autoplay, no
 *   count-up, no reveal transitions), it does not merely shorten it.
 * - Looping work (demo autoplay, count-ups) only runs while visible and while the
 *   document is visible.
 */
import { onBeforeUnmount, onMounted, ref, type Ref } from "vue";

const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";

export const prefersReducedMotion = (): boolean =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia(REDUCED_QUERY).matches
        : true;

/** Reactive `prefers-reduced-motion` flag that follows OS changes live. */
export const useReducedMotion = (): Ref<boolean> => {
    const reduced = ref(prefersReducedMotion());
    let media: MediaQueryList | null = null;
    const onChange = (event: MediaQueryListEvent) => {
        reduced.value = event.matches;
    };
    onMounted(() => {
        if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
        media = window.matchMedia(REDUCED_QUERY);
        reduced.value = media.matches;
        media.addEventListener?.("change", onChange);
    });
    onBeforeUnmount(() => media?.removeEventListener?.("change", onChange));
    return reduced;
};

/**
 * Marks every `[data-reveal]` descendant of `root` with `data-revealed` once it
 * enters the viewport. Returns whether reveal motion is active, which the page
 * mirrors into `data-motion="on"` so CSS only hides content when it will be shown.
 */
export const useReveal = (root: Ref<HTMLElement | null>, reduced: Ref<boolean>) => {
    const active = ref(false);
    let observer: IntersectionObserver | null = null;

    const revealAll = () => {
        root.value?.querySelectorAll<HTMLElement>("[data-reveal]").forEach((el) => el.setAttribute("data-revealed", ""));
    };

    const observe = () => {
        if (!root.value || !observer) return;
        root.value
            .querySelectorAll<HTMLElement>("[data-reveal]:not([data-revealed])")
            .forEach((el) => observer?.observe(el));
    };

    onMounted(() => {
        if (reduced.value || typeof IntersectionObserver === "undefined") {
            revealAll();
            return;
        }
        observer = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    if (entry.isIntersecting) {
                        entry.target.setAttribute("data-revealed", "");
                        observer?.unobserve(entry.target);
                    }
                }
            },
            { rootMargin: "0px 0px -8% 0px", threshold: 0.12 },
        );
        observe();
        active.value = true;
    });

    onBeforeUnmount(() => observer?.disconnect());

    /** Call after lazily mounted sections render so their nodes are observed too. */
    const refresh = () => {
        if (!active.value || reduced.value) {
            revealAll();
            return;
        }
        observe();
    };

    return { active, refresh, revealAll };
};

/** True while `target` intersects the viewport (used to pause loops off-screen). */
export const useInView = (target: Ref<HTMLElement | null>, rootMargin = "0px") => {
    const inView = ref(false);
    let observer: IntersectionObserver | null = null;
    onMounted(() => {
        if (typeof IntersectionObserver === "undefined" || !target.value) {
            inView.value = true;
            return;
        }
        observer = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) inView.value = entry.isIntersecting;
            },
            { rootMargin },
        );
        observer.observe(target.value);
    });
    onBeforeUnmount(() => observer?.disconnect());
    return inView;
};

/** True while the tab is visible. */
export const usePageVisible = () => {
    const visible = ref(typeof document === "undefined" ? true : document.visibilityState !== "hidden");
    const onChange = () => {
        visible.value = document.visibilityState !== "hidden";
    };
    onMounted(() => document.addEventListener("visibilitychange", onChange));
    onBeforeUnmount(() => document.removeEventListener("visibilitychange", onChange));
    return visible;
};

/**
 * Runs a DOM mutation inside a View Transition when supported and motion is allowed;
 * otherwise runs it directly.
 */
export const withViewTransition = (mutate: () => void, reduced: boolean) => {
    const doc = typeof document !== "undefined" ? (document as Document & { startViewTransition?: (cb: () => void) => unknown }) : null;
    if (!doc?.startViewTransition || reduced) {
        mutate();
        return;
    }
    doc.startViewTransition(() => mutate());
};

/**
 * Eased 0→1 progress driven by rAF. Callers map progress to their own value
 * (money tweens multiply a Decimal by the progress, never a float amount).
 * Returns a cancel function.
 */
export const animateProgress = (durationMs: number, onFrame: (progress: number) => void): (() => void) => {
    if (typeof requestAnimationFrame === "undefined" || durationMs <= 0) {
        onFrame(1);
        return () => undefined;
    }
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
        const t = Math.min(1, (now - start) / durationMs);
        onFrame(1 - Math.pow(1 - t, 3));
        if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
};
