import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Academy progress and its queue of unsent patches belong to ONE user. A record written for user A
 * must never be flushed, merged or shown under user B's session (same browser, or same SPA session
 * after a logout and re-login).
 */
const put = vi.fn();
const get = vi.fn();
vi.mock("@/state/api", () => ({ api: { put: (...args: unknown[]) => put(...args), get: (...args: unknown[]) => get(...args) } }));

const USER_KEY = "PAYMENT_GATEWAY:ADMIN:USER";
const signIn = (id: string | null): void => {
    if (id) window.localStorage.setItem(USER_KEY, JSON.stringify({ token: `t-${id}`, userInfo: { id } }));
    else window.localStorage.removeItem(USER_KEY);
    window.dispatchEvent(new Event("pg:user-changed"));
};
const envelope = (rev: number, lessons: Record<string, unknown> = {}) => ({
    data: { data: { progress: { schema: 1, rev, lessons, guideRead: {}, labs: {}, exams: {}, badges: [] }, rev } },
});

beforeEach(() => {
    window.localStorage.clear();
    put.mockReset();
    get.mockReset();
});

describe("academy progress is scoped to the signed-in user", () => {
    test("user A's unsent patch is never sent under user B and B starts from an empty record", async () => {
        signIn("user-a");
        vi.resetModules();
        const academy = await import("@/components/academy/useAcademyProgress");
        get.mockRejectedValue(new Error("offline"));
        put.mockRejectedValue(new Error("offline"));
        await academy.loadAcademyProgress();

        // A finishes a lesson while the server is unreachable: the patch stays queued and persisted for A.
        const state = academy.useAcademyProgress();
        state.completeLesson("lesson-1", "1.0", 2);
        await vi.waitFor(() => expect(window.localStorage.getItem("pg.academy.progress")).toContain("lesson-1"));
        const stored = JSON.parse(window.localStorage.getItem("pg.academy.progress") ?? "{}");
        expect(stored.owner).toBe("user-a");

        // A logs out and B logs in, with the server reachable again.
        put.mockReset();
        signIn("user-b");
        get.mockResolvedValue(envelope(5));
        put.mockResolvedValue(envelope(6));
        await academy.loadAcademyProgress(true);
        await academy.flushAcademyProgress();

        expect(put).not.toHaveBeenCalled();
        expect(state.progress.value.lessons["lesson-1"]).toBeUndefined();
        expect(state.unsaved.value).toBe(false);
    });

    test("a record with no owner, or another user's, is dropped instead of adopted", async () => {
        window.localStorage.setItem(
            "pg.academy.progress",
            JSON.stringify({ progress: { schema: 1, rev: 3, lessons: { x: { at: "t" } } }, queue: { lessons: { x: { at: "t" } } } }),
        );
        signIn("user-b");
        vi.resetModules();
        const academy = await import("@/components/academy/useAcademyProgress");
        const state = academy.useAcademyProgress();
        expect(state.progress.value.lessons.x).toBeUndefined();
        expect(state.unsaved.value).toBe(false);
        expect(window.localStorage.getItem("pg.academy.progress")).toBeNull();
    });

    test("a request already in flight for the previous user cannot write into the next user's state", async () => {
        signIn("user-a");
        vi.resetModules();
        const academy = await import("@/components/academy/useAcademyProgress");
        get.mockResolvedValue(envelope(1));
        await academy.loadAcademyProgress();
        let release: (value: unknown) => void = () => undefined;
        get.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
        const pending = academy.loadAcademyProgress(true);
        signIn("user-b");
        release(envelope(99, { leaked: { at: "t" } }));
        await pending.catch(() => undefined);
        expect(academy.useAcademyProgress().progress.value.lessons.leaked).toBeUndefined();
    });
});
