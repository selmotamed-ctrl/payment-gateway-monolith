import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearToasts, dismissToast, pauseToast, resumeToast, showToast, useToasts } from "../src/feedback/toastStore";

describe("toast store", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        clearToasts();
    });
    afterEach(() => {
        clearToasts();
        vi.useRealTimers();
    });

    it("auto-dismisses a success toast after 4500 ms", () => {
        showToast({ message: "Saved", tone: "success" });
        const { toasts } = useToasts();
        expect(toasts.value).toHaveLength(1);
        vi.advanceTimersByTime(4499);
        expect(toasts.value).toHaveLength(1);
        vi.advanceTimersByTime(1);
        expect(toasts.value).toHaveLength(0);
    });

    it("gives warnings and errors a longer 6500 ms timer", () => {
        showToast({ message: "Careful", tone: "warning" });
        vi.advanceTimersByTime(4500);
        expect(useToasts().toasts.value).toHaveLength(1);
        vi.advanceTimersByTime(2000);
        expect(useToasts().toasts.value).toHaveLength(0);
    });

    it("pauses on hover and resumes with the remaining time", () => {
        const id = showToast({ message: "Copying", tone: "info" });
        vi.advanceTimersByTime(1000);
        pauseToast(id);
        vi.advanceTimersByTime(60_000);
        expect(useToasts().toasts.value).toHaveLength(1);
        resumeToast(id);
        vi.advanceTimersByTime(3499);
        expect(useToasts().toasts.value).toHaveLength(1);
        vi.advanceTimersByTime(1);
        expect(useToasts().toasts.value).toHaveLength(0);
    });

    it("stacks at most four toasts and dismisses the oldest", () => {
        const first = showToast({ message: "one", durationMs: 0 });
        showToast({ message: "two", durationMs: 0 });
        showToast({ message: "three", durationMs: 0 });
        showToast({ message: "four", durationMs: 0 });
        showToast({ message: "five", durationMs: 0 });
        const { toasts } = useToasts();
        expect(toasts.value).toHaveLength(4);
        expect(toasts.value.some((toast) => toast.id === first)).toBe(false);
        expect(toasts.value.map((toast) => toast.message)).toEqual(["two", "three", "four", "five"]);
    });

    it("dismisses explicitly and clears the timer", () => {
        const id = showToast({ message: "Done" });
        dismissToast(id);
        expect(useToasts().toasts.value).toHaveLength(0);
        vi.advanceTimersByTime(10_000);
        expect(useToasts().toasts.value).toHaveLength(0);
    });

    it("maps the legacy error tone to danger", () => {
        showToast({ message: "Boom", tone: "error" });
        expect(useToasts().toasts.value[0]!.tone).toBe("danger");
    });
});
