/**
 * Shared overlay registry.
 *
 * Every floating surface in `@pg/ui` (dialog, drawer, command palette, menu,
 * tooltip) announces itself here when it opens. The registry:
 *
 * 1. closes peer surfaces that must never stack (a command palette over a help
 *    drawer, a second menu, …),
 * 2. dispatches one DOM-free callback plus the public `pg:overlay-open`
 *    `CustomEvent`, so an application can observe overlay changes without
 *    importing any component state.
 *
 * The module never touches `window` at import time, so it is safe during SSR.
 */

export type PgOverlayKind = "dialog" | "drawer" | "palette" | "menu" | "tooltip";

export type PgOverlayOpenDetail = {
    /** Unique per mounted surface. */
    id: string;
    kind: PgOverlayKind;
};

export const PG_OVERLAY_OPEN_EVENT = "pg:overlay-open";

type Registration = {
    kind: PgOverlayKind;
    close: () => void;
};

/**
 * Which already-open surfaces a newly opened surface supersedes. Drawers may
 * stack on their own (a merchant drawer opens an application drawer), and a
 * dialog may open on top of a drawer, so neither closes its own kind.
 */
const PEER_CLOSES: Record<PgOverlayKind, PgOverlayKind[]> = {
    palette: ["palette", "drawer", "menu", "tooltip"],
    dialog: ["palette", "menu", "tooltip"],
    drawer: ["palette", "menu", "tooltip"],
    menu: ["menu", "tooltip"],
    tooltip: [],
};

const registry = new Map<string, Registration>();
const listeners = new Set<(detail: PgOverlayOpenDetail) => void>();
let sequence = 0;

const hasWindow = () => typeof window !== "undefined" && typeof window.addEventListener === "function";

const dispatch = (detail: PgOverlayOpenDetail) => {
    listeners.forEach((listener) => {
        try {
            listener(detail);
        } catch {
            /* one faulty observer must not break the overlay stack */
        }
    });
    if (!hasWindow() || typeof window.CustomEvent !== "function") return;
    try {
        window.dispatchEvent(new CustomEvent<PgOverlayOpenDetail>(PG_OVERLAY_OPEN_EVENT, { detail }));
    } catch {
        /* CustomEvent can be missing in a minimal test environment */
    }
};

/**
 * Registers an open surface and closes every peer kind it supersedes. Returns
 * the unique id (useful for ignoring one's own `pg:overlay-open` event).
 */
export const openOverlay = (kind: PgOverlayKind, close: () => void): string => {
    sequence += 1;
    const id = `pg-overlay-${sequence}`;
    registry.set(id, { kind, close });

    for (const [peerId, entry] of [...registry.entries()]) {
        if (peerId === id) continue;
        if (!PEER_CLOSES[kind].includes(entry.kind)) continue;
        registry.delete(peerId);
        try {
            entry.close();
        } catch {
            /* the surface was already unmounting */
        }
    }

    dispatch({ id, kind });
    return id;
};

/**
 * True when no later surface was registered on top of `id`. Outside-click
 * handlers use this so clicking inside a dialog never closes the drawer that
 * opened it (and a menu never closes its parent dialog).
 */
export const overlayZIndex = (id: string | null | undefined): number => {
    if (!id) return 1000;
    let rank = 0;
    for (const [key, entry] of registry) {
        // Menus/tooltips live in the 1200+ layer; only modal surfaces stack in
        // the 1000s, and only while they are open. The rank is therefore small
        // no matter how many menus a long session opens.
        if (entry.kind === "dialog" || entry.kind === "drawer" || entry.kind === "palette") rank += 1;
        if (key === id) return 1000 + rank;
    }
    return 1000;
};

export const isTopOverlay = (id: string | null | undefined): boolean => {
    if (!id) return true;
    let last: string | null = null;
    for (const key of registry.keys()) last = key;
    return last === id;
};

/** Removes a surface from the registry (called on close or unmount). */
export const closeOverlay = (id: string | null | undefined): void => {
    if (!id) return;
    registry.delete(id);
};

/** Closes every currently open surface of the supplied kinds. */
export const closeOpenOverlays = (kinds: PgOverlayKind[], exceptId?: string | null): void => {
    for (const [id, entry] of [...registry.entries()]) {
        if (id === exceptId) continue;
        if (!kinds.includes(entry.kind)) continue;
        registry.delete(id);
        try {
            entry.close();
        } catch {
            /* the surface was already unmounting */
        }
    }
};

/**
 * Subscribes to overlay-open notifications. In the browser it listens to the
 * public `pg:overlay-open` window event; in SSR it falls back to the in-process
 * listener set. Returns an idempotent unsubscribe function.
 */
export const subscribeOverlayOpen = (listener: (detail: PgOverlayOpenDetail) => void): (() => void) => {
    if (!hasWindow() || typeof window.CustomEvent !== "function") {
        listeners.add(listener);
        return () => listeners.delete(listener);
    }
    const onEvent = (event: Event) => {
        const detail = (event as CustomEvent<PgOverlayOpenDetail>).detail;
        if (!detail?.id || !detail?.kind) return;
        listener(detail);
    };
    window.addEventListener(PG_OVERLAY_OPEN_EVENT, onEvent);
    return () => window.removeEventListener(PG_OVERLAY_OPEN_EVENT, onEvent);
};

/** Test/diagnostic helper: a snapshot of open surfaces. */
export const openOverlaySnapshot = (): PgOverlayOpenDetail[] =>
    [...registry.entries()].map(([id, entry]) => ({ id, kind: entry.kind }));

/** Test helper: drops every registration without calling close callbacks. */
export const resetOverlayStack = (): void => {
    registry.clear();
    listeners.clear();
};
