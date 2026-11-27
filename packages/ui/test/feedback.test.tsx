import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nextTick, ref } from "vue";
import { mount, nextFrame } from "./helpers/render";
import { PgAlert } from "../src/feedback/PgAlert";
import { PgToaster } from "../src/feedback/PgToast";
import { clearToasts, dismissToast, showToast, useToasts } from "../src/feedback/toastStore";
import { PgStatusBadge, formatHumanStatus } from "../src/feedback/PgStatusBadge";
import { PgEmptyState, PgSkeleton } from "../src/feedback/PgEmptyState";
import { PgLoadingScreen, PgStateView } from "../src/feedback/PgStateView";
import { PgMetaPill } from "../src/data/PgMetaPill";
import { dc } from "../src/lib/dc";

const here = path.dirname(fileURLToPath(import.meta.url));
const feedbackCss = fs.readFileSync(path.resolve(here, "../src/tokens/parts/feedback.css"), "utf-8");

const cssBlock = (selector: string): string => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return feedbackCss.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{[^}]*\\}`, "m"))?.[0] ?? "";
};

/**
 * Root props are collected through the Vapor "dynamic source" protocol, which
 * calls function values once with no arguments. A listener supplied to the root
 * app must therefore be wrapped in a thunk so the runtime stores the listener
 * itself instead of invoking it during collection.
 */
const listener = (fn: (...args: any[]) => any) => (() => fn) as any;

describe("PgAlert", () => {
    it("renders all five tones with the exact semantic class and ARIA role", () => {
        const tones = ["info", "success", "warning", "danger", "neutral"] as const;
        for (const tone of tones) {
            const { el, unmount } = mount(PgAlert, { tone, title: "Heads up", message: "Body copy" });
            const alert = el.querySelector(".pg-alert") as HTMLElement;
            expect(alert).not.toBeNull();
            expect(alert.classList.contains(`pg-alert--${tone}`)).toBe(true);
            const assertive = tone === "danger" || tone === "warning";
            expect(alert.getAttribute("role")).toBe(assertive ? "alert" : "status");
            expect(alert.getAttribute("aria-live")).toBe(assertive ? "assertive" : "polite");
            expect(alert.querySelector(".pg-alert__title")?.textContent).toBe("Heads up");
            expect(alert.querySelector(".pg-alert__body")?.textContent).toContain("Body copy");
            unmount();
        }
        expect(cssBlock(".pg-alert")).toContain("border-inline-start: 3px solid");
        expect(cssBlock(".pg-alert__close")).toContain("width: 28px");
        expect(cssBlock(".pg-alert__close")).toContain("height: 28px");
    });

    it("renders a messages array as a bulleted list and compact density", () => {
        const { el, unmount } = mount(PgAlert, {
            tone: "warning",
            messages: ["First problem", "Second problem"],
            density: "compact",
        });
        expect(el.querySelectorAll(".pg-alert__list li")).toHaveLength(2);
        expect(el.querySelector(".pg-alert")?.classList.contains("pg-alert--compact")).toBe(true);
        unmount();
    });

    it("dismisses on the close button, hides immediately and emits model updates", async () => {
        const updates: boolean[] = [];
        const closes: number[] = [];
        const { el, unmount } = mount(PgAlert, {
            tone: "info",
            message: "Dismiss me",
            closable: true,
            "onUpdate:modelValue": listener((value: boolean) => updates.push(value)),
            onClose: listener(() => closes.push(1)),
        });
        const close = el.querySelector(".pg-alert__close") as HTMLButtonElement;
        expect(close).not.toBeNull();
        close.click();
        await nextFrame();
        expect(el.querySelector(".pg-alert")).toBeNull();
        expect(updates).toEqual([false]);
        expect(closes).toHaveLength(1);
        unmount();
    });

    it("honours a controlled open=false without requiring a close click", () => {
        const { el, unmount } = mount(PgAlert, { tone: "danger", message: "Hidden", open: false });
        expect(el.querySelector(".pg-alert")).toBeNull();
        unmount();
    });
});

describe("PgToast / PgToaster", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        clearToasts();
    });
    afterEach(() => {
        clearToasts();
        vi.useRealTimers();
    });

    it("shows a toast and auto-dismisses it at durationMs", async () => {
        const { el, unmount } = mount(PgToaster as any);
        const id = showToast({ tone: "success", message: "Saved", durationMs: 200 });
        expect(typeof id).toBe("number");
        await nextTick();
        expect(el.querySelectorAll(".pg-toast")).toHaveLength(1);
        expect(el.querySelector(".pg-toast__message")?.textContent).toBe("Saved");
        expect(el.querySelector(".pg-toast__timer")).not.toBeNull();

        vi.advanceTimersByTime(199);
        await nextTick();
        expect(el.querySelectorAll(".pg-toast")).toHaveLength(1);
        vi.advanceTimersByTime(1);
        await nextTick();
        expect(el.querySelectorAll(".pg-toast")).toHaveLength(0);
        unmount();
    });

    it("pauses on hover and resumes the remaining time", async () => {
        const { el, unmount } = mount(PgToaster as any);
        showToast({ tone: "info", message: "Hover me", durationMs: 200 });
        await nextTick();
        const card = el.querySelector(".pg-toast") as HTMLElement;
        vi.advanceTimersByTime(100);
        card.dispatchEvent(new MouseEvent("mouseenter"));
        vi.advanceTimersByTime(500);
        await nextTick();
        expect(el.querySelectorAll(".pg-toast")).toHaveLength(1);
        expect(el.querySelector(".pg-toast__timer")?.classList.contains("pg-toast__timer--paused")).toBe(true);

        card.dispatchEvent(new MouseEvent("mouseleave"));
        vi.advanceTimersByTime(99);
        await nextTick();
        expect(el.querySelectorAll(".pg-toast")).toHaveLength(1);
        vi.advanceTimersByTime(1);
        await nextTick();
        expect(el.querySelectorAll(".pg-toast")).toHaveLength(0);
        unmount();
    });

    it("gives danger and warning toasts the 6500 ms default", () => {
        showToast({ tone: "danger", message: "Boom" });
        showToast({ tone: "warning", message: "Careful" });
        vi.advanceTimersByTime(6499);
        expect(useToasts().toasts.value).toHaveLength(2);
        vi.advanceTimersByTime(1);
        expect(useToasts().toasts.value).toHaveLength(0);
    });

    it("announces danger assertively and runs the optional action", async () => {
        const { el, unmount } = mount(PgToaster as any);
        const action = vi.fn();
        showToast({ tone: "danger", message: "Boom", actionLabel: "View", onAction: action, durationMs: 0 });
        await nextTick();
        const card = el.querySelector(".pg-toast") as HTMLElement;
        expect(card.getAttribute("role")).toBe("alert");
        expect(card.getAttribute("aria-live")).toBe("assertive");
        const actionButton = el.querySelector(".pg-toast__action") as HTMLButtonElement;
        expect(actionButton.textContent).toBe("View");
        actionButton.click();
        expect(action).toHaveBeenCalledTimes(1);
        await nextTick();
        expect(el.querySelectorAll(".pg-toast")).toHaveLength(0);
        unmount();
    });

    it("caps the stack at four cards, evicting the oldest", async () => {
        const { el, unmount } = mount(PgToaster as any);
        const ids = Array.from({ length: 6 }, (_, index) => showToast({ message: `message-${index}`, durationMs: 0 }));
        await nextTick();
        const cards = el.querySelectorAll(".pg-toast");
        expect(cards).toHaveLength(4);
        expect(el.textContent).not.toContain("message-0");
        expect(el.textContent).not.toContain("message-1");
        expect(el.textContent).toContain("message-5");
        expect(useToasts().toasts.value.map((toast) => toast.message)).toEqual([
            "message-2",
            "message-3",
            "message-4",
            "message-5",
        ]);
        expect(ids).toHaveLength(6);
        unmount();
    });

    it("dismisses from the close button without a visible focus ring", async () => {
        const { el, unmount } = mount(PgToaster as any);
        showToast({ tone: "success", message: "Close me", durationMs: 0 });
        await nextTick();
        const close = el.querySelector(".pg-toast__close") as HTMLButtonElement;
        close.click();
        await nextTick();
        expect(el.querySelectorAll(".pg-toast")).toHaveLength(0);
        unmount();
    });

    it("keeps the close button borderless and transparent", () => {
        const base = cssBlock(".pg-toast__close");
        expect(base).toContain("border: 0");
        expect(base).toContain("background: transparent");
        expect(base).toContain("outline: none");
        expect(cssBlock(".pg-toast__close:focus-visible")).toContain("box-shadow: var(--pg-focus-ring)");
        expect(cssBlock(".pg-toast__timer--paused")).toContain("animation-play-state: paused");
        expect(cssBlock(".pg-toast__timer")).toContain("height: 2.5px");
        expect(cssBlock(".pg-toast-stack")).toContain("width: min(400px, calc(100vw - 32px))");
    });

    it("cleans the timer on explicit dismiss", () => {
        const id = showToast({ message: "Done", durationMs: 5000 });
        dismissToast(id);
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe("PgStatusBadge", () => {
    it("maps CRITICAL to danger and always renders a readable label", () => {
        const { el, unmount } = mount(PgStatusBadge, { status: "CRITICAL" });
        const badge = el.querySelector(".pg-badge") as HTMLElement;
        expect(badge.classList.contains("pg-badge--danger")).toBe(true);
        expect(badge.classList.contains("pg-badge--md")).toBe(true);
        expect(el.querySelector(".pg-badge__label")?.textContent).toBe(formatHumanStatus("CRITICAL"));
        expect(el.querySelector(".pg-badge__dot")).not.toBeNull();
        unmount();
    });

    it("keeps critical financial states in danger even with a tone override", () => {
        for (const status of ["CRITICAL", "FAILED", "SUSPENDED", "BLOCKED", "CHARGEBACK", "REVOKED", "HIGH_RISK"]) {
            const { el, unmount } = mount(PgStatusBadge, { status, toneOverride: "success" });
            expect(el.querySelector(".pg-badge")?.classList.contains("pg-badge--danger")).toBe(true);
            unmount();
        }
    });

    it("supports a custom label, tone, size and dot=false", () => {
        const { el, unmount } = mount(PgStatusBadge, {
            status: "PENDING",
            label: "Awaiting review",
            tone: "info",
            size: "sm",
            dot: false,
        });
        const badge = el.querySelector(".pg-badge") as HTMLElement;
        expect(badge.classList.contains("pg-badge--info")).toBe(true);
        expect(badge.classList.contains("pg-badge--sm")).toBe(true);
        expect(el.querySelector(".pg-badge__dot")).toBeNull();
        expect(el.querySelector(".pg-badge__label")?.textContent).toBe("Awaiting review");
        unmount();
    });

    it("defines the label rule in the feedback stylesheet", () => {
        expect(cssBlock(".pg-badge__label")).toContain("white-space: nowrap");
        expect(cssBlock(".pg-badge")).toContain("height: 24px");
        expect(cssBlock(".pg-badge")).toContain("border-radius: var(--pg-radius-pill)");
    });
});

describe("PgMetaPill", () => {
    it("renders every semantic tone and the key/value pair", () => {
        for (const tone of ["neutral", "brand", "info", "success", "warning", "danger"]) {
            const { el, unmount } = mount(PgMetaPill, {
                label: "Rail",
                value: "SADAD",
                tone,
                icon: "mdi-bank-outline",
            });
            const pill = el.querySelector(".pg-meta-pill") as HTMLElement;
            expect(pill.classList.contains(`pg-meta-pill--${tone}`)).toBe(true);
            expect(el.querySelector(".pg-meta-pill__label")?.textContent).toBe("Rail");
            expect(el.querySelector(".pg-meta-pill__value")?.textContent).toBe("SADAD");
            expect(el.querySelector("svg")).not.toBeNull();
            unmount();
        }
    });

    it("is only interactive when an onClick handler is supplied", () => {
        const idle = mount(PgMetaPill, { label: "Env", value: "LIVE" });
        const idlePill = idle.el.querySelector(".pg-meta-pill") as HTMLElement;
        expect(idlePill.getAttribute("role")).toBeNull();
        expect(idlePill.getAttribute("tabindex")).toBeNull();
        idle.unmount();

        const clicked = vi.fn();
        const active = mount(PgMetaPill, { label: "Env", value: "LIVE", onClick: listener(clicked) });
        const activePill = active.el.querySelector(".pg-meta-pill") as HTMLElement;
        expect(activePill.getAttribute("role")).toBe("button");
        expect(activePill.getAttribute("tabindex")).toBe("0");
        activePill.click();
        expect(clicked).toHaveBeenCalledTimes(1);
        active.unmount();
    });

    it("applies the monospace modifier and never wraps", () => {
        const { el, unmount } = mount(PgMetaPill, { label: "Amount", value: "125.000", mono: true });
        expect(el.querySelector(".pg-meta-pill")?.classList.contains("pg-meta-pill--mono")).toBe(true);
        expect(cssBlock(".pg-meta-pill")).toContain("white-space: nowrap");
        expect(cssBlock(".pg-meta-pill")).toContain("height: 24px");
        unmount();
    });
});

describe("PgEmptyState / PgSkeleton", () => {
    it("renders the medallion, copy and emits action on the CTA", () => {
        const action = vi.fn();
        const { el, unmount } = mount(PgEmptyState, {
            title: "No records yet",
            description: "Create the first record to get started.",
            actionLabel: "Create",
            onAction: listener(action),
        });
        expect(el.querySelector(".pg-empty__medallion")).not.toBeNull();
        expect(el.querySelector(".pg-empty__title")?.textContent).toBe("No records yet");
        expect(el.querySelector(".pg-empty__description")?.textContent).toContain("Create the first record");
        const button = el.querySelector(".pg-empty__actions button") as HTMLButtonElement;
        expect(button).not.toBeNull();
        expect(button.textContent).toContain("Create");
        button.click();
        expect(action).toHaveBeenCalledTimes(1);
        unmount();
    });

    it("applies compact density", () => {
        const { el, unmount } = mount(PgEmptyState, { title: "Empty", compact: true });
        expect(el.querySelector(".pg-empty")?.classList.contains("pg-empty--compact")).toBe(true);
        unmount();
    });

    it("renders count bars, marks them decorative and shortens the last text line", () => {
        const { el, unmount } = mount(PgSkeleton, { variant: "text", count: 4 });
        const bars = Array.from(el.querySelectorAll(".pg-skeleton__bar")) as HTMLElement[];
        expect(bars).toHaveLength(4);
        expect(el.querySelector(".pg-skeleton-stack")?.getAttribute("aria-hidden")).toBe("true");
        for (const bar of bars) {
            expect(bar.getAttribute("aria-hidden")).toBe("true");
            expect(bar.classList.contains("pg-skeleton--text")).toBe(true);
        }
        expect(bars[3]!.style.width).toBe("72%");
        expect(bars[0]!.style.width).toBe("100%");
        unmount();
    });

    it("supports explicit variants, sizes and reduced-motion CSS", () => {
        const circle = mount(PgSkeleton, { variant: "circle" });
        expect(circle.el.querySelector(".pg-skeleton--circle")).not.toBeNull();
        circle.unmount();

        const chart = mount(PgSkeleton, { variant: "chart", width: "320px", height: "180px" });
        const bar = chart.el.querySelector(".pg-skeleton") as HTMLElement;
        expect(bar.classList.contains("pg-skeleton--chart")).toBe(true);
        expect(bar.style.width).toBe("320px");
        expect(bar.style.height).toBe("180px");
        chart.unmount();

        expect(feedbackCss).toContain("prefers-reduced-motion: reduce");
    });
});

describe("PgStateView / PgLoadingScreen", () => {
    it("transitions loading -> error -> retry -> ready through the Vapor state machine", async () => {
        const state = ref<{ loading: boolean; error: unknown }>({ loading: true, error: "" });
        const retried = vi.fn(() => {
            state.value = { loading: false, error: "" };
        });

        const Demo = dc(
            () => () => (
                <PgStateView loading={state.value.loading} error={state.value.error} retryLabel="Retry" onRetry={retried}>
                    <div class="ready-state">Ready content</div>
                </PgStateView>
            ),
            { props: {} },
        );

        const { el, unmount } = mount(Demo as any);
        expect(el.querySelector(".pg-loading-screen")).not.toBeNull();
        expect(el.querySelector(".ready-state")).toBeNull();

        state.value = { loading: false, error: { message: "Server exploded" } };
        await nextTick();
        await nextFrame();
        expect(el.querySelector(".pg-state-view--error")).not.toBeNull();
        expect(el.querySelector(".pg-state-view--error")?.getAttribute("role")).toBe("alert");
        expect(el.querySelector(".pg-state-view__message")?.textContent).toBe("Server exploded");
        expect(el.querySelector(".ready-state")).toBeNull();

        const retry = el.querySelector(".pg-state-view__error-body button") as HTMLButtonElement;
        expect(retry).not.toBeNull();
        expect(retry.textContent).toContain("Retry");
        retry.click();
        expect(retried).toHaveBeenCalledTimes(1);
        await nextTick();
        await nextFrame();
        expect(el.querySelector(".pg-state-view--error")).toBeNull();
        expect(el.querySelector(".ready-state")?.textContent).toBe("Ready content");
        unmount();
    });

    it("extracts .message, .detail, nested and string errors without printing [object Object]", () => {
        const cases: Array<[unknown, string]> = [
            [{ message: "Plain message" }, "Plain message"],
            [{ detail: "Detailed failure" }, "Detailed failure"],
            [{ error: { message: "Nested envelope" } }, "Nested envelope"],
            [new Error("Error instance"), "Error instance"],
            ["String failure", "String failure"],
            [{ status: 500 }, ""],
        ];
        for (const [error, expected] of cases) {
            const { el, unmount } = mount(PgStateView, { error });
            expect(el.querySelector(".pg-state-view__message")?.textContent ?? "").toBe(expected);
            expect(el.textContent).not.toContain("[object Object]");
            unmount();
        }
    });

    it("renders the empty state and its action", () => {
        const { el, unmount } = mount(PgStateView, {
            empty: true,
            emptyTitle: "No cases",
            emptyDescription: "Nothing matches these filters.",
            emptyActionLabel: "Reset filters",
        });
        expect(el.querySelector(".pg-empty__title")?.textContent).toBe("No cases");
        expect(el.querySelector(".pg-empty__actions button")?.textContent).toContain("Reset filters");
        unmount();
    });

    it("renders a labelled loading screen", () => {
        const { el, unmount } = mount(PgLoadingScreen, { label: "Chargement", minHeight: "180px" });
        expect(el.querySelector(".pg-spinner")).not.toBeNull();
        expect(el.querySelector(".pg-loading-screen__label")?.textContent).toBe("Chargement");
        expect(el.querySelector(".pg-loading-screen")?.getAttribute("role")).toBe("status");
        expect((el.querySelector(".pg-loading-screen") as HTMLElement).style.minHeight).toBe("180px");
        unmount();
    });

    it("supports the fullScreen variant without the inline min-height", () => {
        const { el, unmount } = mount(PgLoadingScreen, { fullScreen: true });
        const screen = el.querySelector(".pg-loading-screen") as HTMLElement;
        expect(screen.classList.contains("pg-loading-screen--fullscreen")).toBe(true);
        expect(screen.style.minHeight).toBe("");
        unmount();
    });
});
