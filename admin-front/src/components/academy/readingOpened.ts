/** Tiny local record of Guide articles the learner opened from a lesson (`pg.academy.opened`). */
import { ref } from "vue";

const KEY = "pg.academy.opened";

const load = (): Set<string> => {
    try {
        const parsed = JSON.parse(window.localStorage.getItem(KEY) ?? "[]") as unknown;
        return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : []);
    } catch {
        return new Set();
    }
};

const opened = ref<Set<string>>(typeof window === "undefined" ? new Set() : load());

if (typeof window !== "undefined") {
    // Another tab (the Guide article opens in a new tab from a lesson) may have added ids.
    window.addEventListener("storage", (event) => {
        if (event.key === KEY) opened.value = load();
    });
}

export const markArticleOpened = (articleId: string): void => {
    if (!articleId || opened.value.has(articleId)) return;
    const next = new Set(load());
    for (const id of opened.value) next.add(id);
    next.add(articleId);
    opened.value = next;
    try {
        window.localStorage.setItem(KEY, JSON.stringify([...next]));
    } catch {
        // storage unavailable: the in-memory set still works for this session.
    }
};

/** Reactive when called inside a render function or computed. */
export const isArticleOpened = (articleId: string): boolean => opened.value.has(articleId);
