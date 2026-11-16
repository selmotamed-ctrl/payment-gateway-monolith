/**
 * Rail logo assets (core `Asset` model + `POST /assets`, admin-back `toCoreAssetCreate`):
 * PNG or SVG, 1 byte .. 5 MB, a lowercase hex SHA-256, a storage key.
 */
export const LOGO_MIMES = ["image/png", "image/svg+xml"] as const;
export const LOGO_MAX_BYTES = 5_000_000;
export const LOGO_ASSET_ERRORS = ["TYPE", "EMPTY", "TOO_LARGE", "NAME"] as const;
export type LogoFileError = (typeof LOGO_ASSET_ERRORS)[number];

export const normalizeAssetMime = (mime: string): "image/png" | "image/svg+xml" | null => {
    const clean = mime.split(";")[0]?.trim().toLowerCase() ?? "";
    return (LOGO_MIMES as readonly string[]).includes(clean) ? (clean as "image/png" | "image/svg+xml") : null;
};

/** `IMAGE_PNG` / `IMAGE_SVG_XML` (core enum) or a MIME -> MIME. */
export const assetMimeToContentType = (mime: string): string => {
    if (mime === "IMAGE_PNG") return "image/png";
    if (mime === "IMAGE_SVG_XML") return "image/svg+xml";
    return mime;
};

export const validateLogoFile = (file: { name: string; type: string; size: number }): LogoFileError | null => {
    if (!normalizeAssetMime(file.type)) return "TYPE";
    if (file.size <= 0) return "EMPTY";
    if (file.size > LOGO_MAX_BYTES) return "TOO_LARGE";
    if (!file.name.trim()) return "NAME";
    return null;
};

/** `Moamalat Logo.PNG` -> `moamalat-logo.png` (storage-key safe). */
export const slugifyAssetName = (name: string): string => {
    const dot = name.lastIndexOf(".");
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot + 1) : "";
    const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "logo";
    const cleanExt = ext.toLowerCase().replace(/[^a-z0-9]/g, "");
    return cleanExt ? `${slug}.${cleanExt}` : slug;
};

export const logoStorageKey = (sha256: string, name: string): string => `rails/logos/${sha256}/${slugifyAssetName(name)}`;

export const formatBytes = (bytes: number): string => {
    if (!Number.isFinite(bytes) || bytes < 0) return "—";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
};

export const toHex = (buffer: ArrayBuffer): string =>
    [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
