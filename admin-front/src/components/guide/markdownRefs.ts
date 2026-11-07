export interface CollectedRef {
    kind: string;
    id: string;
    label?: string;
}

const REF_TOKEN_SOURCE = "\\[\\[([acgs]):([a-z0-9-]+)(?:\\|([^\\]]+))?\\]\\]";

export const createRefTokenRegex = (): RegExp => new RegExp(REF_TOKEN_SOURCE, "g");

/** A short, natural label for an inline reference or a tray pill. */
export const shortTitle = (value: string): string => {
    const trimmed = value.trim();
    if (!trimmed) return "";
    const colon = trimmed.indexOf(":");
    if (colon > 0) return trimmed.slice(0, colon).trim();
    const words = trimmed.split(/\s+/);
    return words.length > 12 ? words.slice(0, 12).join(" ") : trimmed;
};

const POINTER_PATTERNS = [
    /^(?:see|also|e\.g\.?|for example|details?|more|further|below|above|here|there)$/i,
    /^(?:and|or|but|in|on|at|from|with|to|of|for|by|as)$/i,
    /\b(?:is|are|was|were)\s+(?:in|found in|described in|explained in|covered in|introduced in|mentioned in|shown in)\s*$/i,
    /^(?:you met|as (?:described|explained|shown)|the (?:rules?|details?|story|meaning|definition|explanation|full (?:explanation|details?)|guide|article|screen|playbook|section|chapter))\b/i,
    /^how to .*\b(?:is|are) in$/i,
    /^where .*\b(?:is|are) in$/i,
    /^(?:for|about|because|since|why|as)\b(?:\s+\w+){0,3}$/i,
];
const POINTER_WORDS = new Set([
    "a",
    "above",
    "also",
    "an",
    "and",
    "are",
    "article",
    "as",
    "at",
    "be",
    "because",
    "below",
    "but",
    "by",
    "chapter",
    "could",
    "covered",
    "definition",
    "described",
    "detail",
    "details",
    "e.g",
    "eg",
    "example",
    "explained",
    "explanation",
    "for",
    "from",
    "further",
    "guide",
    "her",
    "here",
    "him",
    "how",
    "in",
    "introduced",
    "is",
    "it",
    "its",
    "meaning",
    "mentioned",
    "more",
    "of",
    "on",
    "or",
    "our",
    "playbook",
    "read",
    "records",
    "rule",
    "rules",
    "same",
    "screen",
    "section",
    "see",
    "shown",
    "since",
    "story",
    "that",
    "the",
    "their",
    "themselves",
    "there",
    "these",
    "they",
    "this",
    "those",
    "to",
    "us",
    "was",
    "we",
    "were",
    "what",
    "when",
    "where",
    "which",
    "why",
    "with",
    "you",
]);

const cleanupResidue = (value: string): string =>
    value
        .replace(/^[\s,;:.\-–—]+/, "")
        .replace(/[\s,;:.\-–—]+$/, "")
        .replace(/^(?:see|also|e\.g\.?|for example|details?|more)\b[,:]?\s*/i, "")
        .replace(/\s*,?\s*(?:see|also)$/i, "")
        .trim();

const isPointerResidue = (value: string): boolean => {
    const normalized = value.replace(/\s+/g, " ").trim();
    if (!normalized) return true;
    if (POINTER_PATTERNS.some((pattern) => pattern.test(normalized))) return true;
    const words = normalized
        .toLocaleLowerCase()
        .replace(/[^\p{L}\p{N}\s-]/gu, " ")
        .split(/\s+/)
        .filter(Boolean);
    if (words.length === 0) return true;
    return words.every((word) => POINTER_WORDS.has(word));
};

/**
 * Strips clunky mid-sentence parenthetical reference dumps such as
 *   ([[a:b06-12]])
 *   (see [[a:b02-06]])
 *   (see [[a:b06-05]], [[a:b06-07]])
 *   (called rails, see [[a:b02-06]])
 * and returns the cleaned prose plus the extracted references. Parenthetical
 * prose that carries meaning ("called rails") is preserved; pure pointers are
 * moved to the section reference tray by the renderer.
 */
export const extractParentheticalRefs = (
    line: string,
): { cleaned: string; refs: CollectedRef[] } => {
    if (!line.includes("[[") || !line.includes("(")) return { cleaned: line, refs: [] };

    const refs: CollectedRef[] = [];
    let output = "";
    let cursor = 0;
    let index = 0;

    while (index < line.length) {
        const open = line.indexOf("(", index);
        if (open < 0) break;
        const before = line.slice(0, open);
        if ((before.match(/`/g) ?? []).length % 2 === 1) {
            index = open + 1;
            continue;
        }
        const close = line.indexOf(")", open + 1);
        if (close < 0) break;
        const inner = line.slice(open + 1, close);
        if (!inner.includes("[[")) {
            index = close + 1;
            continue;
        }

        const tokenRegex = createRefTokenRegex();
        const matches = [...inner.matchAll(tokenRegex)];
        if (matches.length === 0) {
            index = close + 1;
            continue;
        }
        for (const match of matches) {
            refs.push({
                kind: match[1]!,
                id: match[2]!,
                label: match[3] || undefined,
            });
        }

        tokenRegex.lastIndex = 0;
        const residue = inner.replace(tokenRegex, " ").replace(/\s+/g, " ").trim();
        const cleanedResidue = cleanupResidue(residue);
        if (cleanedResidue && !isPointerResidue(cleanedResidue)) {
            output += `${line.slice(cursor, open)}(${cleanedResidue})`;
        } else {
            output += line.slice(cursor, open);
        }
        cursor = close + 1;
        index = close + 1;
    }

    output += line.slice(cursor);
    const cleaned = output
        .replace(/[ \t]+([.,;:!?])/g, "$1")
        .replace(/\(\s*\)/g, "")
        .replace(/[ \t]{2,}/g, " ")
        .trimEnd();
    return { cleaned, refs };
};

/** First readable paragraph of a markdown document, for reference previews. */
export const firstProseParagraph = (source: string, maxLength = 240): string => {
    const stripped = source
        .replace(/```[a-zA-Z0-9_-]*\n[\s\S]*?```/g, "\n\n")
        .replace(/^:::[a-z]+\s*.*$/gm, "")
        .replace(/^:::$/gm, "")
        .replace(/^\s{0,3}#{1,6}\s+.*$/gm, "")
        .replace(/^\s*\*\*[^*]+\*\*\s*$/gm, "")
        .replace(/^\s*[-*+]\s+\[[ x]\]\s+.*$/gm, "")
        .replace(/^\s*[-*+]\s+/gm, "")
        .replace(/^\s*\d+\.\s+/gm, "")
        .replace(/^\s*\|\s*/gm, "")
        .replace(/\{\{widget:[a-z0-9-]+\}\}/g, "")
        .replace(/\[\[[acgs]:([a-z0-9-]+)\|([^\]]+)\]\]/g, "$2")
        .replace(/\[\[[acgs]:([a-z0-9-]+)\]\]/g, "$1")
        .replace(/\|/g, " ")
        .replace(/\*\*([^*]+)\*\*/g, "$1")
        .replace(/`([^`]+)`/g, "$1");
    const paragraphs = stripped
        .split(/\n\s*\n/)
        .map((paragraph) =>
            paragraph
                .replace(/\s+/g, " ")
                .replace(/\s+([.,;:!?])/g, "$1")
                .trim(),
        )
        .filter((paragraph) => paragraph.length >= 20);
    const paragraph = paragraphs[0] ?? stripped.replace(/\s+/g, " ").trim();
    if (paragraph.length <= maxLength) return paragraph;
    return `${paragraph.slice(0, maxLength - 1).trimEnd()}…`;
};
