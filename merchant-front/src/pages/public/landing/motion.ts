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

/* -------------------------------------------------------------------------- */
/* Pointer-driven effects (spotlight glow, stage tilt) and section tracking.   */
/* -------------------------------------------------------------------------- */

/** True on devices with a real hovering pointer (never on touch-only screens). */
export const canHover = (): boolean =>
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(hover: hover) and (pointer: fine)").matches;

/** Clamps `value` into `[min, max]`. */
export const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/**
 * Maps a pointer position inside `rect` to tilt angles. The pointer at the
 * centre gives `{0, 0}`; the edges give `±maxDeg`. `rtl` mirrors the Y axis so
 * the stage leans towards the cursor in both reading directions.
 */
export const tiltFromPoint = (
    clientX: number,
    clientY: number,
    rect: { left: number; top: number; width: number; height: number },
    maxDeg = 7,
): { rx: number; ry: number } => {
    if (rect.width <= 0 || rect.height <= 0) return { rx: 0, ry: 0 };
    const nx = clamp((clientX - rect.left) / rect.width - 0.5, -0.5, 0.5) * 2;
    const ny = clamp((clientY - rect.top) / rect.height - 0.5, -0.5, 0.5) * 2;
    // `|| 0` turns -0 (centre of the box) into 0 so CSS never receives `-0deg`.
    return { rx: Math.round(-ny * maxDeg * 100) / 100 || 0, ry: Math.round(nx * maxDeg * 100) / 100 || 0 };
};

/**
 * Cursor-following glow: writes `--mx`/`--my` (px, relative to the card) onto the
 * closest `[data-spot]` element under the pointer. One delegated listener, rAF
 * throttled; does nothing on touch devices or with reduced motion.
 */
export const useSpotlight = (root: Ref<HTMLElement | null>, reduced: Ref<boolean>) => {
    let frame = 0;
    let pending: { el: HTMLElement; x: number; y: number } | null = null;
    let host: HTMLElement | null = null;

    const flush = () => {
        frame = 0;
        if (!pending) return;
        pending.el.style.setProperty("--mx", `${pending.x}px`);
        pending.el.style.setProperty("--my", `${pending.y}px`);
        pending = null;
    };

    const onMove = (event: PointerEvent) => {
        const el = (event.target as Element | null)?.closest<HTMLElement>("[data-spot]");
        if (!el) return;
        const rect = el.getBoundingClientRect();
        pending = { el, x: Math.round(event.clientX - rect.left), y: Math.round(event.clientY - rect.top) };
        if (!frame) frame = requestAnimationFrame(flush);
    };

    onMounted(() => {
        host = root.value;
        if (!host || reduced.value || !canHover()) return;
        host.addEventListener("pointermove", onMove, { passive: true });
    });

    onBeforeUnmount(() => {
        host?.removeEventListener("pointermove", onMove);
        if (frame) cancelAnimationFrame(frame);
    });
};

/**
 * Leans the element towards the cursor by writing `--rx`/`--ry` (deg). Resets
 * smoothly when the pointer leaves. Hover-capable devices only; no-op for
 * reduced motion.
 */
export const useTilt = (target: Ref<HTMLElement | null>, reduced: Ref<boolean>, maxDeg = 6) => {
    let frame = 0;
    let el: HTMLElement | null = null;
    let next: { rx: number; ry: number } | null = null;

    const apply = () => {
        frame = 0;
        if (!el || !next) return;
        el.style.setProperty("--rx", `${next.rx}deg`);
        el.style.setProperty("--ry", `${next.ry}deg`);
    };

    const schedule = (value: { rx: number; ry: number }) => {
        next = value;
        if (!frame) frame = requestAnimationFrame(apply);
    };

    const onMove = (event: PointerEvent) => {
        if (!el) return;
        schedule(tiltFromPoint(event.clientX, event.clientY, el.getBoundingClientRect(), maxDeg));
    };

    const onLeave = () => schedule({ rx: 0, ry: 0 });

    onMounted(() => {
        el = target.value;
        if (!el || reduced.value || !canHover()) return;
        el.addEventListener("pointermove", onMove, { passive: true });
        el.addEventListener("pointerleave", onLeave, { passive: true });
    });

    onBeforeUnmount(() => {
        el?.removeEventListener("pointermove", onMove);
        el?.removeEventListener("pointerleave", onLeave);
        if (frame) cancelAnimationFrame(frame);
    });
};

/**
 * Tracks which section is under the reading line, for the nav highlight.
 * Returns the id of the active section (or "" above the first one).
 */
export const useActiveSection = (ids: readonly string[]) => {
    const active = ref("");
    let observer: IntersectionObserver | null = null;
    onMounted(() => {
        if (typeof IntersectionObserver === "undefined") return;
        observer = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    if (entry.isIntersecting) active.value = entry.target.id;
                    else if (active.value === entry.target.id) active.value = "";
                }
            },
            { rootMargin: "-42% 0px -52% 0px" },
        );
        for (const id of ids) {
            const node = document.getElementById(id);
            if (node) observer.observe(node);
        }
    });
    onBeforeUnmount(() => observer?.disconnect());
    return active;
};

/** Splits a sentence into words, preserving the original order and punctuation. */
export const splitWords = (text: string): string[] => text.trim().split(/\s+/).filter(Boolean);
