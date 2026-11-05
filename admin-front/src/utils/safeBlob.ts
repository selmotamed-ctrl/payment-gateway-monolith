/**
 * Whitelist for document/image blobs shown or opened in the browser.
 * SVG (scriptable) and HTML are never rendered; anything outside the list is refused.
 */
export const PREVIEWABLE_MIMES = ["image/png", "image/jpeg", "application/pdf"] as const;
export const RASTER_IMAGE_MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

const normalize = (mime: unknown): string =>
    String(mime ?? "")
        .split(";")[0]!
        .trim()
        .toLowerCase();

export const safePreviewMime = (mime: unknown): (typeof PREVIEWABLE_MIMES)[number] | null => {
    const m = normalize(mime);
    return (PREVIEWABLE_MIMES as readonly string[]).includes(m) ? (m as (typeof PREVIEWABLE_MIMES)[number]) : null;
};

export const safeRasterImageMime = (mime: unknown): (typeof RASTER_IMAGE_MIMES)[number] | null => {
    const m = normalize(mime);
    return (RASTER_IMAGE_MIMES as readonly string[]).includes(m) ? (m as (typeof RASTER_IMAGE_MIMES)[number]) : null;
};
