const stripInline = (value: string): string =>
    value
        .replace(/\[\[(?:a|c|s|g):([a-z0-9-]+)\|([^\]]+)\]\]/g, "$2")
        .replace(/\[\[(?:a|c|s|g):([a-z0-9-]+)\]\]/g, "$1")
        .replace(/`{1,3}([^`]*)`{1,3}/g, "$1")
        .replace(/\*\*([^*]+)\*\*/g, "$1")
        .replace(/__([^_]+)__/g, "$1")
        .replace(/(^|\s)\*([^*]+)\*(?=\s|$)/g, "$1$2")
        .replace(/(^|\s)_([^_]+)_(?=\s|$)/g, "$1$2")
        .replace(/\\([\\`*_{}[\]()#+\-.!|>])/g, "$1")
        .replace(/<br\s*\/?>/gi, " ")
        .replace(/[ \t]+/g, " ")
        .trim();

export const slugifyHeading = (value: string): string => {
    const cleaned = stripInline(value)
        .toLocaleLowerCase()
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^\p{L}\p{N}]+/gu, "-")
        .replace(/^-+|-+$/g, "");
    return cleaned || "section";
};

export const createHeadingIdFactory = (): ((text: string) => string) => {
    const seen = new Map<string, number>();
    return (text: string) => {
        const base = slugifyHeading(text);
        const count = seen.get(base) ?? 0;
        seen.set(base, count + 1);
        return count === 0 ? base : `${base}-${count + 1}`;
    };
};
