export interface HighlightSegment {
    text: string;
    highlighted: boolean;
}

export function splitHighlightSegments(
    text: string | undefined,
    query: string,
): HighlightSegment[] {
    if (!text) {
        return [];
    }

    const cleanQuery = query.trim();
    if (cleanQuery.length < 2) {
        return [{ text, highlighted: false }];
    }

    const escaped = cleanQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`(${escaped})`, "gi");
    const parts = text.split(regex);

    return parts
        .filter((part) => part.length > 0)
        .map((part, index) => ({
            text: part,
            highlighted: index % 2 === 1,
        }));
}
