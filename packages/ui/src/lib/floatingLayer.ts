/**
 * Root floating layer.
 *
 * Fixed-position panels rendered inside a table cell still inherit that
 * ancestor's stacking context. `position: sticky` creates one even with
 * `z-index: auto`, so a row menu can render below a sticky header or the app
 * bar. Moving the panel to a body-level host lets its `--pg-z-popover` value
 * participate at the document root instead.
 *
 * The layer is created lazily and reused for every floating panel. Vapor still
 * owns the panel node, so closing the surface removes it as usual.
 */
let host: HTMLElement | null = null;

export const floatingLayerHost = (): HTMLElement | null => {
    if (typeof document === "undefined") return null;
    if (host && host.isConnected) return host;
    host = document.createElement("div");
    host.className = "pg-floating-layer";
    host.setAttribute("data-pg-floating-layer", "");
    document.body.appendChild(host);
    return host;
};

export const adoptFloatingElement = (element: HTMLElement | null | undefined): void => {
    if (!element) return;
    const layer = floatingLayerHost();
    if (layer && element.parentElement !== layer) layer.appendChild(element);
};
