import MarkdownIt, { type MarkdownIt as MarkdownItType } from "markdown-it";
import {
    computed,
    defineComponent,
    onMounted,
    ref,
    type PropType,
    type VNodeChild,
} from "vue";
import { useRouter } from "vue-router";
import {
    loadArticles,
    loadBooks,
    loadCards,
    loadGlossary,
    loadPlaybook,
    type Article,
    type Book,
    type Card,
    type Situation,
    type Term,
} from "@/content/guide";
import { createHeadingIdFactory } from "@/content/guide/slug";
import { GlossaryPopover } from "./GlossaryPopover";
import {
    ReferencePreviewPopover,
    type RefPreview,
} from "./ReferencePreviewPopover";
import {
    extractParentheticalRefs,
    firstProseParagraph,
    shortTitle,
    type CollectedRef,
} from "./markdownRefs";

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
    note: "ℹ",
    tip: "★",
    warning: "!",
    danger: "⚠",
    example: "▸",
    do: "✓",
    dont: "✕",
    summary: "◆",
    refs: "→",
};
const KIND_BADGES: Record<string, string> = {
    a: "Guide",
    c: "Screen",
    s: "Playbook",
    g: "Term",
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

interface GuideLinkResolver {
    (kind: string, id: string, customLabel?: string): GuideLink;
}

interface RenderEnvironment {
    headingIdFactory: (text: string) => string;
    usedTerms: Set<string>;
    terms: Term[];
    termsByKey: Map<string, Term>;
    termsBySlug: Map<string, Term>;
    glossaryRegex: RegExp | null;
    resolveLink: GuideLinkResolver;
    disableGlossaryLinks: boolean;
    glossaryPageSlug?: string;
    articleId?: string;
}

const normalizeKey = (value: string): string => value.trim().toLocaleLowerCase();

const makeGlossaryRegex = (terms: Term[]): RegExp | null => {
    const keys: string[] = [];
    for (const term of terms) {
        keys.push(term.term, ...term.aliases);
    }
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
            return `<a href="${escapeAttribute(link.href)}" class="guide-ref-pill guide-ref-pill--${escapeAttribute(
                ref.kind,
            )}" data-guide-link="true" data-ref-kind="${escapeAttribute(
                ref.kind,
            )}" data-ref-id="${escapeAttribute(ref.id)}" title="${escapeAttribute(
                link.title,
            )}"${
                link.external ? ' target="_blank" rel="noreferrer"' : ""
            }><span class="guide-ref-pill__badge">${escapeHtml(
                badge,
            )}</span><span class="guide-ref-pill__label">${escapeHtml(label)}</span></a>`;
        })
        .join("");

    return `<aside class="guide-section-refs" aria-label="Related guides and screens"><span class="guide-section-refs__title">Related</span><div class="guide-section-refs__list">${pills}</div></aside>`;
};

const createMarkdown = (): MarkdownItType => {    const md = new MarkdownIt({
        html: false,
        linkify: false,
        typographer: false,
        breaks: false,
    });

    md.inline.ruler.before("link", "guide_ref", (state: any, silent: boolean) => {
        const start = state.pos;
        const source = state.src;
        if (source.charCodeAt(start) !== 0x5b || source.charCodeAt(start + 1) !== 0x5b) {
            return false;
        }
        const match = /^\[\[([acgs]):([a-z0-9-]+)(?:\|([^\]]+))?\]\]/.exec(
            source.slice(start),
        );
        if (!match) return false;
        if (!silent) {
            const token = state.push("guide_ref", "", 0);
            token.meta = {
                kind: match[1],
                id: match[2],
                label: match[3] ?? "",
            };
        }
        state.pos = start + match[0].length;
        return true;
    });

    md.renderer.rules.guide_ref = (tokens, index, _options, env) => {
        const token = tokens[index]!;
        const meta = (token.meta ?? {}) as { kind: string; id: string; label?: string };
        const resolver = (env as unknown as RenderEnvironment).resolveLink;
        const link = resolver(meta.kind, meta.id, meta.label || undefined);
        const label = meta.label || shortTitle(link.title || link.label);
        return `<a href="${escapeAttribute(link.href)}" class="guide-inline-ref" data-guide-link="true" data-ref-kind="${escapeAttribute(
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
                    children.splice(index, 1, ...replacement.tokens);
                    index += replacement.tokens.length - 1;
                }
            }
            previousBlock = token.type;
        }
    });

    md.renderer.rules.guide_gloss = (tokens, index) => {
        const token = tokens[index]!;
        const meta = (token.meta ?? {}) as { slug?: string };
        return `<button type="button" class="gl-term" data-slug="${escapeAttribute(
            meta.slug ?? "",
        )}">${escapeHtml(token.content)}</button>`;
    };

    md.renderer.rules.table_open = () => '<div class="guide-table-wrap"><table>';
    md.renderer.rules.table_close = () => "</table></div>";

    const defaultFence = md.renderer.rules.fence;
    md.renderer.rules.fence = (tokens, index, options, env, self) => {
        const token = tokens[index]!;
        const language = token.info.trim().split(/\s+/)[0];
        if (language === "diagram") {
            return `<pre class="guide-diagram" dir="ltr"><code>${escapeHtml(
                token.content,
            )}</code></pre>`;
        }
        return defaultFence
            ? defaultFence(tokens, index, options, env, self)
            : `<pre><code>${escapeHtml(token.content)}</code></pre>`;
    };

    return md;
};

const linkTermsInText = (
    text: string,
    env: RenderEnvironment,
): { tokens: any[] } | null => {
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
            if (match.index + matched.length <= cursor) {
                regex.lastIndex += 1;
            }
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
        tokens.push({
            type: "text",
            content: text.slice(cursor),
            level: 0,
            children: null,
        });
    }
    return { tokens };
};

const renderSegments = (
    md: MarkdownItType,
    source: string,
    env: RenderEnvironment,
): { type: "html" | "widget"; html?: string; widgetId?: string }[] => {
    const segments: { type: "html" | "widget"; html?: string; widgetId?: string }[] = [];
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
            const type = calloutType;
            const title = callout[2]?.trim() ?? "";
            const inner: string[] = [];
            index += 1;
            while (index < lines.length && (lines[index] ?? "").trim() !== ":::") {
                const innerLine = lines[index] ?? "";
                if (type === "refs") {
                    inner.push(innerLine);
                    for (const match of innerLine.matchAll(/(\[\[([acgs]):([a-z0-9-]+)(?:\|[^\]]+)?\]\])/g)) {
                        explicitRefs.add(`${match[2]}:${match[3]}`);
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
                html: `<aside class="callout callout-${type}" role="note"><div class="callout__header"><span class="callout__icon" aria-hidden="true">${
                    CALLOUT_ICONS[type] ?? ""
                }</span><span class="callout__label">${escapeHtml(
                    CALLOUT_LABELS[type] ?? type,
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

export const MarkdownView = defineComponent({
    name: "MarkdownView",
    props: {
        source: { type: String, required: true },
        articleId: { type: String, default: "" },
        compact: { type: Boolean, default: false },
        disableGlossaryLinks: { type: Boolean, default: false },
        glossaryPageSlug: { type: String, default: "" },
        renderWidget: {
            type: Function as PropType<(widgetId: string) => VNodeChild>,
            default: undefined,
        },
    },
    setup(props) {
        const router = useRouter();
        const terms = ref<Term[]>([]);
        const articles = ref<Article[]>([]);
        const books = ref<Book[]>([]);
        const cards = ref<Card[]>([]);
        const situations = ref<Situation[]>([]);
        const selectedTerm = ref<Term | null>(null);
        const anchor = ref<DOMRect | null>(null);
        const selectedPreview = ref<RefPreview | null>(null);
        const previewAnchor = ref<DOMRect | null>(null);

        const md = createMarkdown();

        const termsBySlug = computed(() => new Map(terms.value.map((term) => [term.slug, term])));

        const resolver = computed<GuideLinkResolver>(() => {
            const articleTitles = new Map(articles.value.map((article) => [article.id, article.title]));
            const cardTitles = new Map(cards.value.map((card) => [card.id, card.title]));
            const situationTitles = new Map(situations.value.map((situation) => [situation.id, situation.title]));
            return (kind, id, customLabel) => {
                if (kind === "a") {
                    const label = customLabel || articleTitles.get(id) || id;
                    return {
                        href: `/guide/a/${id}`,
                        label,
                        title: articleTitles.get(id) || id,
                        external: false,
                    };
                }
                if (kind === "c") {
                    const label = customLabel || cardTitles.get(id) || id;
                    return {
                        href: `/guide/cards/${id}`,
                        label,
                        title: cardTitles.get(id) || id,
                        external: false,
                    };
                }
                if (kind === "s") {
                    const label = customLabel || situationTitles.get(id) || id;
                    return {
                        href: `/guide/playbook/${id}`,
                        label,
                        title: situationTitles.get(id) || id,
                        external: false,
                    };
                }
                const term = terms.value.find((entry) => entry.slug === id);
                const label = customLabel || term?.term || id;
                return {
                    href: `/guide/glossary/${id}`,
                    label,
                    title: term?.term || id,
                    external: false,
                };
            };
        });

        onMounted(async () => {
            const [loadedTerms, loadedArticles, loadedBooks, loadedCards, loadedSituations] =
                await Promise.all([
                    loadGlossary().catch(() => []),
                    loadArticles("en").catch(() => []),
                    loadBooks().catch(() => []),
                    loadCards().catch(() => []),
                    loadPlaybook().catch(() => []),
                ]);
            terms.value = loadedTerms;
            articles.value = loadedArticles;
            books.value = loadedBooks;
            cards.value = loadedCards;
            situations.value = loadedSituations;
        });

        const segments = computed(() => {
            const env: RenderEnvironment = {
                headingIdFactory: createHeadingIdFactory(),
                usedTerms: new Set<string>(),
                terms: terms.value,
                termsByKey: new Map(
                    terms.value.flatMap((term) =>
                        [term.term, ...term.aliases].map((key) => [normalizeKey(key), term] as const),
                    ),
                ),
                termsBySlug: termsBySlug.value,
                glossaryRegex: makeGlossaryRegex(terms.value),
                resolveLink: resolver.value,
                disableGlossaryLinks: props.disableGlossaryLinks,
                glossaryPageSlug: props.glossaryPageSlug || undefined,
                articleId: props.articleId || undefined,
            };
            return renderSegments(md, props.source, env);
        });

        const openReferencePreview = (kind: string, id: string, href: string): boolean => {
            if (kind === "a") {
                const article = articles.value.find((entry) => entry.id === id);
                if (!article) return false;
                const book = books.value.find((entry) => entry.id === String(article.book));
                selectedTerm.value = null;
                selectedPreview.value = {
                    kindLabel: book
                        ? `Book ${book.id} · ${book.title}`
                        : `Book ${article.book}`,
                    title: article.title,
                    subtitle: `${article.minutes} min read`,
                    body: firstProseParagraph(article.plainText || article.body),
                    href,
                };
                return true;
            }
            if (kind === "c") {
                const card = cards.value.find((entry) => entry.id === id);
                if (!card) return false;
                selectedTerm.value = null;
                selectedPreview.value = {
                    kindLabel: `Screen card · ${card.screen}`,
                    title: card.title,
                    subtitle: `${card.risk} risk${card.irreversible ? " · irreversible" : ""}`,
                    body: firstProseParagraph(card.body),
                    href,
                };
                return true;
            }
            if (kind === "s") {
                const situation = situations.value.find((entry) => entry.id === id);
                if (!situation) return false;
                selectedTerm.value = null;
                selectedPreview.value = {
                    kindLabel: "Incident playbook",
                    title: situation.title,
                    subtitle: `${situation.cases.length} linked case${
                        situation.cases.length === 1 ? "" : "s"
                    }`,
                    body: firstProseParagraph(situation.body),
                    href,
                };
                return true;
            }
            return false;
        };

        const handleClick = (event: MouseEvent) => {
            const target = event.target as HTMLElement | null;
            const glossary = target?.closest<HTMLElement>(".gl-term");
            if (glossary) {
                event.preventDefault();
                const slug = glossary.dataset.slug ?? "";
                const term = termsBySlug.value.get(slug);
                if (term) {
                    selectedPreview.value = null;
                    previewAnchor.value = null;
                    selectedTerm.value = term;
                    anchor.value = glossary.getBoundingClientRect();
                }
                return;
            }
            const link = target?.closest<HTMLAnchorElement>("a[data-guide-link]");
            if (link) {
                const href = link.getAttribute("href") ?? "";
                const refKind = link.dataset.refKind ?? "";
                const refId = link.dataset.refId ?? "";
                if (!props.compact && refKind === "g" && refId) {
                    const term = termsBySlug.value.get(refId);
                    if (term) {
                        event.preventDefault();
                        selectedPreview.value = null;
                        previewAnchor.value = null;
                        selectedTerm.value = term;
                        anchor.value = link.getBoundingClientRect();
                        return;
                    }
                }
                if (!props.compact && refKind && refId && openReferencePreview(refKind, refId, href)) {
                    event.preventDefault();
                    previewAnchor.value = link.getBoundingClientRect();
                    return;
                }
                if (href.startsWith("/guide/")) {
                    event.preventDefault();
                    void router.push(href);
                }
            }
        };

        return () => (
            <div
                class={["guide-markdown", { "guide-markdown--compact": props.compact }]}
                onClick={handleClick}
            >
                {segments.value.map((segment, index) =>
                    segment.type === "widget" && segment.widgetId ? (
                        <div key={`widget-${segment.widgetId}-${index}`} class="guide-widget-embed">
                            {props.renderWidget?.(segment.widgetId) ?? null}
                        </div>
                    ) : (
                        <div
                            key={`html-${index}`}
                            innerHTML={segment.html}
                        />
                    ),
                )}
                <GlossaryPopover
                    term={selectedTerm.value}
                    anchor={anchor.value}
                    termsBySlug={termsBySlug.value}
                    onClose={() => {
                        selectedTerm.value = null;
                        anchor.value = null;
                    }}
                />
                <ReferencePreviewPopover
                    preview={selectedPreview.value}
                    anchor={previewAnchor.value}
                    onClose={() => {
                        selectedPreview.value = null;
                        previewAnchor.value = null;
                    }}
                    onOpen={(href) => {
                        selectedPreview.value = null;
                        previewAnchor.value = null;
                        if (href.startsWith("/")) void router.push(href);
                    }}
                />
            </div>
        );
    },
});

export default MarkdownView;
