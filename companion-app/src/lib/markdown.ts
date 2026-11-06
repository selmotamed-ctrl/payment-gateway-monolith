import MarkdownIt, { type MarkdownIt as MarkdownItType } from "markdown-it";
import type { Card, Situation, Term } from "@/content/types";

const CALLOUT_TYPES = new Set(["note", "tip", "warning", "danger", "example", "do", "dont"]);
const CALLOUT_LABELS: Record<string, string> = {
    note: "Note",
    tip: "Tip",
    warning: "Warning",
    danger: "Danger",
    example: "Example",
    do: "Do",
    dont: "Don't",
};
const CALLOUT_ICONS: Record<string, string> = {
    note: "i",
    tip: "*",
    warning: "!",
    danger: "!",
    example: ">",
    do: "+",
    dont: "x",
};
const WIDGET_IDS = new Set([
    "transform-sandbox",
    "crypto-lab",
    "ledger-explorer",
    "visible-rails",
    "attempt-states",
]);

export const escapeHtml = (value: string): string =>
    value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");

const escapeAttribute = (value: string): string => escapeHtml(value);

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
}

export interface MarkdownContext {
    articleId?: string;
    glossary?: Term[];
    articles?: { id: string; title: string }[];
    cards?: { id: string; title: string }[];
    situations?: { id: string; title: string }[];
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
        return `<a href="${escapeAttribute(link.href)}" data-guide-link="true" title="${escapeAttribute(link.title)}"${
            link.external ? ' target="_blank" rel="noreferrer"' : ""
        }>${escapeHtml(link.label)}</a>`;
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
                const skipBlock = previousBlock === "heading_open" || previousBlock === "th_open";
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

    md.renderer.rules.table_open = () => '<div class="table-wrap"><table>';
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
            tokens.push({ type: "text", content: text.slice(cursor, match.index), level: 0, children: null });
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

const renderSegments = (
    md: MarkdownItType,
    source: string,
    env: RenderEnvironment,
): MarkdownSegment[] => {
    const segments: MarkdownSegment[] = [];
    const normalized = source.replace(/\r\n/g, "\n");
    const lines = normalized.split("\n");
    let buffer: string[] = [];

    const flush = () => {
        if (buffer.length === 0) return;
        segments.push({ type: "html", html: md.render(buffer.join("\n"), env as any) });
        buffer = [];
    };

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        const callout = /^:::([a-z]+)(?:\s+(.*))?$/.exec(line.trim());
        const calloutType = callout?.[1];
        if (calloutType && CALLOUT_TYPES.has(calloutType)) {
            flush();
            const title = callout[2]?.trim() ?? "";
            const inner: string[] = [];
            index += 1;
            while (index < lines.length && (lines[index] ?? "").trim() !== ":::") {
                inner.push(lines[index] ?? "");
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
        const widget = /^\{\{widget:([a-z0-9-]+)\}\}$/.exec(line.trim());
        if (widget && WIDGET_IDS.has(widget[1] ?? "")) {
            flush();
            segments.push({ type: "widget", widgetId: widget[1] });
            continue;
        }
        buffer.push(line);
    }
    flush();
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
    };
    return renderSegments(createMarkdown(), source, env);
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
