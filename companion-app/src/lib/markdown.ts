import MarkdownIt, { type MarkdownIt as MarkdownItType } from "markdown-it";
import type { Card, Situation, Term } from "@/content/types";

const CALLOUT_TYPES = new Set([
    "note",
    "tip",
    "warning",
    "danger",
    "example",
    "do",
    "dont",
    "summary",
    "refs",
]);
const CALLOUT_LABELS: Record<string, string> = {
    note: "Note",
    tip: "Tip",
    warning: "Warning",
    danger: "Danger",
    example: "Example",
    do: "Do",
    dont: "Don't",
    summary: "In plain words",
    refs: "Where to go next",
};
const CALLOUT_ICONS: Record<string, string> = {
    note: "i",
    tip: "*",
    warning: "!",
    danger: "!",
    example: ">",
    do: "+",
    dont: "x",
    summary: "◆",
    refs: "→",
};
const WIDGET_IDS = new Set([
    "transform-sandbox",
    "crypto-lab",
    "ledger-explorer",
    "visible-rails",
    "attempt-states",
]);

const KIND_BADGES: Record<string, string> = {
    a: "Guide",
    c: "Screen",
    s: "Playbook",
    g: "Term",
};

const REF_TOKEN_SOURCE = "\\[\\[([acgs]):([a-z0-9-]+)(?:\\|([^\\]]+))?\\]\\]";
const createRefTokenRegex = (): RegExp => new RegExp(REF_TOKEN_SOURCE, "g");

export const escapeHtml = (value: string): string =>
    value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");

const escapeAttribute = (value: string): string => escapeHtml(value);

export interface CollectedRef {
    kind: string;
    id: string;
    label?: string;
}

interface GuideLink {
    href: string;
    label: string;
    title: string;
    external: boolean;
}

interface RenderEnvironment {
    headingIdFactory: (text: string) => string;
    usedTerms: Set<string>;
    termsByKey: Map<string, Term>;
    termsBySlug: Map<string, Term>;
    glossaryRegex: RegExp | null;
    resolveLink: (kind: string, id: string, customLabel?: string) => GuideLink;
    disableGlossaryLinks: boolean;
    glossaryPageSlug?: string;
    articleId?: string;
}

export interface MarkdownContext {
    articleId?: string;
    glossary?: Term[];
    articles?: {
        id: string;
        title: string;
        plainText?: string;
        minutes?: number;
        book?: number;
    }[];
    cards?: {
        id: string;
        title: string;
        body?: string;
        screen?: string;
        risk?: string;
        irreversible?: boolean;
    }[];
    situations?: {
        id: string;
        title: string;
        body?: string;
        screens?: string[];
        cases?: number[];
    }[];
    disableGlossaryLinks?: boolean;
    glossaryPageSlug?: string;
}

export interface MarkdownSegment {
    type: "html" | "widget";
    html?: string;
    widgetId?: string;
}

const normalizeKey = (value: string): string => value.trim().toLocaleLowerCase();

const makeGlossaryRegex = (terms: Term[]): RegExp | null => {
    const keys: string[] = [];
    for (const term of terms) keys.push(term.term, ...term.aliases);
    const unique = [...new Set(keys.map((key) => key.trim()).filter(Boolean))].sort(
        (left, right) => right.length - left.length,
    );
    if (unique.length === 0) return null;
    const escaped = unique.map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    try {
        return new RegExp(
            `(?<![\\p{L}\\p{N}])(${escaped.join("|")})(?![\\p{L}\\p{N}])`,
            "giu",
        );
    } catch {
        return new RegExp(`(^|[^\\p{L}\\p{N}])(${escaped.join("|")})(?![\\p{L}\\p{N}])`, "iu");
    }
};

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
        .replace(/[\s,;:.\-–—]+$/, "")
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

const renderRefTrayHtml = (
    refs: CollectedRef[],
    env: RenderEnvironment,
    explicitRefs: Set<string>,
): string => {
    const unique = new Map<string, CollectedRef>();
    for (const ref of refs) {
        if (ref.kind === "a" && ref.id === env.articleId) continue;
        const key = `${ref.kind}:${ref.id}`;
        if (explicitRefs.has(key)) continue;
        if (!unique.has(key)) unique.set(key, ref);
    }
    if (unique.size === 0) return "";

    const pills = [...unique.values()]
        .map((ref) => {
            const link = env.resolveLink(ref.kind, ref.id, ref.label);
            const label = ref.label || shortTitle(link.title || link.label);
            const badge = KIND_BADGES[ref.kind] ?? "Link";
            return `<a href="${escapeAttribute(link.href)}" class="ref-pill ref-pill--${escapeAttribute(
                ref.kind,
            )}" data-guide-link="true" data-ref-kind="${escapeAttribute(
                ref.kind,
            )}" data-ref-id="${escapeAttribute(ref.id)}" title="${escapeAttribute(
                link.title,
            )}"${
                link.external ? ' target="_blank" rel="noreferrer"' : ""
            }><span class="ref-pill__badge">${escapeHtml(
                badge,
            )}</span><span class="ref-pill__label">${escapeHtml(label)}</span></a>`;
        })
        .join("");

    return `<aside class="section-refs" aria-label="Related guides and screens"><span class="section-refs__title">Related</span><div class="section-refs__list">${pills}</div></aside>`;
};

const linkTermsInText = (text: string, env: RenderEnvironment): any[] | null => {
    const regex = env.glossaryRegex;
    if (!regex) return null;
    regex.lastIndex = 0;
    const tokens: any[] = [];
    let cursor = 0;
    let changed = false;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
        const matched = match[0];
        const term = env.termsByKey.get(normalizeKey(matched));
        if (!term || env.usedTerms.has(term.slug) || term.slug === env.glossaryPageSlug) {
            if (match.index + matched.length <= cursor) regex.lastIndex += 1;
            continue;
        }
        if (match.index > cursor) {
            tokens.push({
                type: "text",
                content: text.slice(cursor, match.index),
                level: 0,
                children: null,
            });
        }
        tokens.push({
            type: "guide_gloss",
            tag: "",
            nesting: 0,
            content: matched,
            meta: { slug: term.slug },
            level: 0,
            children: null,
        });
        env.usedTerms.add(term.slug);
        cursor = match.index + matched.length;
        changed = true;
    }
    if (!changed) return null;
    if (cursor < text.length) {
        tokens.push({ type: "text", content: text.slice(cursor), level: 0, children: null });
    }
    return tokens;
};

const createMarkdown = (): MarkdownItType => {
    const md = new MarkdownIt({ html: false, linkify: false, typographer: false, breaks: false });

    md.inline.ruler.before("link", "guide_ref", (state: any, silent: boolean) => {
        const start = state.pos;
        const source = state.src as string;
        if (source.charCodeAt(start) !== 0x5b || source.charCodeAt(start + 1) !== 0x5b) return false;
        const match = /^\[\[([acgs]):([a-z0-9-]+)(?:\|([^\]]+))?\]\]/.exec(source.slice(start));
        if (!match) return false;
        if (!silent) {
            const token = state.push("guide_ref", "", 0);
            token.meta = { kind: match[1], id: match[2], label: match[3] ?? "" };
        }
        state.pos = start + match[0].length;
        return true;
    });

    md.renderer.rules.guide_ref = (tokens, index, _options, env) => {
        const token = tokens[index]!;
        const meta = (token.meta ?? {}) as { kind: string; id: string; label?: string };
        const link = (env as unknown as RenderEnvironment).resolveLink(
            meta.kind,
            meta.id,
            meta.label || undefined,
        );
        const label = meta.label || shortTitle(link.title || link.label);
        return `<a href="${escapeAttribute(link.href)}" class="inline-guide-ref" data-guide-link="true" data-ref-kind="${escapeAttribute(
            meta.kind,
        )}" data-ref-id="${escapeAttribute(meta.id)}" title="${escapeAttribute(
            link.title,
        )}"${link.external ? ' target="_blank" rel="noreferrer"' : ""}>${escapeHtml(
            label,
        )}</a>`;
    };

    md.core.ruler.push("guide_heading_ids", (state: any) => {
        const env = state.env as unknown as RenderEnvironment;
        for (let index = 0; index < state.tokens.length; index += 1) {
            const token = state.tokens[index]!;
            if (token.type !== "heading_open") continue;
            const inline = state.tokens[index + 1];
            if (!inline || inline.type !== "inline") continue;
            token.attrSet("id", env.headingIdFactory(inline.content));
        }
    });

    md.core.ruler.push("guide_glossary_links", (state: any) => {
        const env = state.env as unknown as RenderEnvironment;
        if (env.disableGlossaryLinks || !env.glossaryRegex) return;
        let insideLink = false;
        let previousBlock = "";
        for (const token of state.tokens) {
            if (token.type === "inline") {
                const skipBlock =
                    previousBlock === "heading_open" || previousBlock === "th_open";
                insideLink = false;
                const children = token.children ?? [];
                for (let index = 0; index < children.length; index += 1) {
                    const child = children[index];
                    if (child.type === "link_open") {
                        insideLink = true;
                        continue;
                    }
                    if (child.type === "link_close") {
                        insideLink = false;
                        continue;
                    }
                    if (child.type !== "text" || insideLink || skipBlock) continue;
                    const replacement = linkTermsInText(child.content, env);
                    if (!replacement) continue;
                    children.splice(index, 1, ...replacement);
                    index += replacement.length - 1;
                }
            }
            previousBlock = token.type;
        }
    });

    md.renderer.rules.guide_gloss = (tokens, index) => {
        const token = tokens[index]!;
        const meta = (token.meta ?? {}) as { slug?: string };
        return `<button type="button" class="glossary-term" data-slug="${escapeAttribute(
            meta.slug ?? "",
        )}">${escapeHtml(token.content)}</button>`;
    };

    md.renderer.rules.table_open = () =>
        '<div class="table-wrap table-wrap--md" tabindex="0"><table>';
    md.renderer.rules.table_close = () => "</table></div>";

    const defaultFence = md.renderer.rules.fence;
    md.renderer.rules.fence = (tokens, index, options, env, self) => {
        const token = tokens[index]!;
        const language = token.info.trim().split(/\s+/)[0];
        if (language === "diagram") {
            return `<pre class="diagram" dir="ltr"><code>${escapeHtml(token.content)}</code></pre>`;
        }
        return defaultFence
            ? defaultFence(tokens, index, options, env, self)
            : `<pre><code>${escapeHtml(token.content)}</code></pre>`;
    };

    return md;
};

const renderSegments = (
    md: MarkdownItType,
    source: string,
    env: RenderEnvironment,
): MarkdownSegment[] => {
    const segments: MarkdownSegment[] = [];
    const normalized = source.replace(/\r\n/g, "\n");
    const lines = normalized.split("\n");
    let buffer: string[] = [];
    let sectionRefs: CollectedRef[] = [];
    let explicitRefs = new Set<string>();

    const flush = (includeRefTray = false) => {
        if (buffer.length > 0) {
            segments.push({ type: "html", html: md.render(buffer.join("\n"), env as any) });
            buffer = [];
        }
        if (includeRefTray) {
            const tray = renderRefTrayHtml(sectionRefs, env, explicitRefs);
            if (tray) segments.push({ type: "html", html: tray });
            sectionRefs = [];
            explicitRefs = new Set<string>();
        }
    };

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        const trimmed = line.trim();

        if (trimmed.startsWith("```")) {
            buffer.push(line);
            index += 1;
            while (index < lines.length) {
                const codeLine = lines[index] ?? "";
                buffer.push(codeLine);
                index += 1;
                if (codeLine.trim().startsWith("```")) break;
            }
            index -= 1;
            continue;
        }

        if (/^##\s+/.test(trimmed)) {
            flush(true);
            buffer.push(line);
            continue;
        }

        const callout = /^:::([a-z]+)(?:\s+(.*))?$/.exec(trimmed);
        const calloutType = callout?.[1];
        if (calloutType && CALLOUT_TYPES.has(calloutType)) {
            flush(false);
            const title = callout[2]?.trim() ?? "";
            const inner: string[] = [];
            index += 1;
            while (index < lines.length && (lines[index] ?? "").trim() !== ":::") {
                const innerLine = lines[index] ?? "";
                if (calloutType === "refs") {
                    inner.push(innerLine);
                    for (const match of innerLine.matchAll(createRefTokenRegex())) {
                        explicitRefs.add(`${match[1]}:${match[2]}`);
                    }
                } else {
                    const extracted = extractParentheticalRefs(innerLine);
                    inner.push(extracted.cleaned);
                    sectionRefs.push(...extracted.refs);
                }
                index += 1;
            }
            const innerHtml = md.render(inner.join("\n"), env as any);
            segments.push({
                type: "html",
                html: `<aside class="callout callout-${calloutType}" role="note"><div class="callout__header"><span class="callout__icon" aria-hidden="true">${
                    CALLOUT_ICONS[calloutType] ?? ""
                }</span><span class="callout__label">${escapeHtml(
                    CALLOUT_LABELS[calloutType] ?? calloutType,
                )}</span>${title ? `<span class="callout__title">${escapeHtml(title)}</span>` : ""}</div><div class="callout__body">${innerHtml}</div></aside>`,
            });
            continue;
        }

        const widget = /^\{\{widget:([a-z0-9-]+)\}\}$/.exec(trimmed);
        if (widget && WIDGET_IDS.has(widget[1] ?? "")) {
            flush(false);
            segments.push({ type: "widget", widgetId: widget[1] });
            continue;
        }

        const extracted = extractParentheticalRefs(line);
        buffer.push(extracted.cleaned);
        sectionRefs.push(...extracted.refs);
    }

    flush(true);
    return segments;
};

export const renderMarkdown = (source: string, context: MarkdownContext = {}): MarkdownSegment[] => {
    const glossary = context.glossary ?? [];
    const articles = context.articles ?? [];
    const cards = context.cards ?? [];
    const situations = context.situations ?? [];
    const articleTitles = new Map(articles.map((article) => [article.id, article.title]));
    const cardTitles = new Map(cards.map((card) => [card.id, card.title]));
    const situationTitles = new Map(situations.map((situation) => [situation.id, situation.title]));
    const termsBySlug = new Map(glossary.map((term) => [term.slug, term]));
    const termsByKey = new Map(
        glossary.flatMap((term) =>
            [term.term, ...term.aliases].map((key) => [normalizeKey(key), term] as const),
        ),
    );
    const resolveLink = (kind: string, id: string, customLabel?: string): GuideLink => {
        if (kind === "a") {
            return {
                href: `/guide/article/${id}`,
                label: customLabel || articleTitles.get(id) || id,
                title: articleTitles.get(id) || id,
                external: false,
            };
        }
        if (kind === "c") {
            return {
                href: `/guide/cards/${id}`,
                label: customLabel || cardTitles.get(id) || id,
                title: cardTitles.get(id) || id,
                external: false,
            };
        }
        if (kind === "s") {
            return {
                href: `/guide/playbook/${id}`,
                label: customLabel || situationTitles.get(id) || id,
                title: situationTitles.get(id) || id,
                external: false,
            };
        }
        const term = termsBySlug.get(id);
        return {
            href: `/guide/glossary/${id}`,
            label: customLabel || term?.term || id,
            title: term?.term || id,
            external: false,
        };
    };
    const env: RenderEnvironment = {
        headingIdFactory: createHeadingIdFactory(),
        usedTerms: new Set<string>(),
        termsByKey,
        termsBySlug,
        glossaryRegex: makeGlossaryRegex(glossary),
        resolveLink,
        disableGlossaryLinks: Boolean(context.disableGlossaryLinks),
        glossaryPageSlug: context.glossaryPageSlug,
        articleId: context.articleId,
    };
    return renderSegments(createMarkdown(), source, env);
};

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

const slugify = (value: string): string =>
    stripInline(value)
        .toLocaleLowerCase()
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^\p{L}\p{N}]+/gu, "-")
        .replace(/^-+|-+$/g, "") || "section";

export const createHeadingIdFactory = (): ((text: string) => string) => {
    const seen = new Map<string, number>();
    return (text: string) => {
        const base = slugify(text);
        const count = seen.get(base) ?? 0;
        seen.set(base, count + 1);
        return count === 0 ? base : `${base}-${count + 1}`;
    };
};

/** Academy lesson bodies end with structural sections rendered as dedicated UI. */
export const lessonProse = (body: string): string => {
    const match = /^#{2,3}[ \t]+(?:Read now|Check yourself)[ \t]*$/im.exec(body);
    return (match ? body.slice(0, match.index) : body).trimEnd();
};

export const inlineMarkdown = (value: string): string => {
    const md = new MarkdownIt({ html: false, linkify: false, typographer: false });
    return md.renderInline(value);
};
