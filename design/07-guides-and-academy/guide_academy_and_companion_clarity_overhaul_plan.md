# Guide, Academy & PG Companion App — Plain-Language, Smart Cross-Reference & Narrative Clarity Overhaul Plan

## Executive Summary & Diagnosis

After updating our source reference to your latest snapshot (`payment-gateway-monolith-master (1).zip`, including the new offline Vue 3 / Capacitor **PG Companion** app in `companion-app/` and the dual-target content pipeline in `design/07-guides-and-academy/`), we audited all **13 Guide Books (94 articles)**, **11 Academy Modules (45 lessons)**, and the Markdown rendering engines in both `companion-app` and `admin-front`.

Your intuition about **Book 0 and Book 1 feeling effortless while Book 2 and onward become harder to read** is spot-on. There are **four concrete, mechanical reasons** why the reading experience degrades starting in Book 2—and all four can be permanently fixed across both the content files and the Companion/Portal reader UI:

| # | Root Cause Discovered in Code & Prose | Concrete Example from Current Codebase | How This Plan Fixes It |
|---|---|---|---|
| **1** | **The Bare `([[a:ID]])` Full-Title Expansion Trap:** In `companion-app/src/lib/markdown.ts` (line 255) and `admin-front/src/components/guide/MarkdownView.tsx` (line 322), any `[[a:ID]]` link without a `\|customLabel` expands to the **entire 10-to-15-word title** of the target article. When placed inside parentheses mid-sentence, it injects a giant title right into the middle of a thought. | In `b02-03` (*The life of a payment, step by step*), a single 5-minute article has **14 full-title parenthetical interruptions**, producing sentences like: *"A method appears only if the merchant allows it, a fee is agreed for it, and a healthy route (a working connection to a partner) can carry this amount (The visible-rails formula: why a customer does or does not see a payment method)."* | **1) Content:** Strip mid-sentence `([[a:...]])` and `([[c:...]])` dumps from prose; use natural 2–4 word inline anchors only where genuinely helpful, and move screen/deep-dive pointers to the bottom of the section. **2) Renderer:** Upgrade `markdown.ts` and `MarkdownView.tsx` so any parenthetical reference is automatically extracted out of the sentence and rendered as a clean **"Further reading & screens in this section"** chip tray at the bottom of the section, plus a tap/click **Article & Card Preview Sheet** (just like Glossary terms!). |
| **2** | **Double-Parentheses & Nested Definitions in One Sentence:** Starting in Book 2 (`b02-03`, `b02-06`, `b02-07`), sentences try to define a new word in parentheses *and* cite another article in parentheses in the same breath, forcing the reader to hold three nested clauses in working memory ([Nielsen Norman Group — Minimize Cognitive Load](https://www.nngroup.com/articles/minimize-cognitive-load/)). | *"The core decides which payment methods to show (called rails, see What is a payment rail, a provider, a route, and a collection mode)."* and *"The core writes a planned payment record (an attempt, see The fourteen payment states, one by one) in state CREATED."* | **One idea per sentence.** Introduce the everyday concept first, name the system term naturally without parentheses, and let the interactive glossary underline (which already exists in `MarkdownView.vue`!) handle term definitions on tap. |
| **3** | **Abrupt Shift from Everyday Analogies (Book 1) to Telegraphic Spec Dumps (Books 5–9):** Book 1 uses vivid human analogies (*a baker's notebook, a restaurant waiter talking to the kitchen, a wax seal on an envelope*). By Books 5, 6, 7, and 8, articles jump straight into raw code/column names (`confirmed_count`, `active_locked_count`, `"Step types: HTTP, COMPUTE, RENDER, WAIT, ASSERT, BRANCH"`, `"Entry 10, first part"`) without first giving a normal human mental model. | In `b06-03` (*Workflow recipes*): *"Step types: HTTP, COMPUTE, RENDER, WAIT, ASSERT, BRANCH."* In `b05-07` (*Seats and sessions*): *"A row on the identity record holds two counters: `confirmed_count` and `active_locked_count`."* | **Every article follows the "3-Speed Universal Reader" structure** (grounded in [Diátaxis](https://diataxis.fr/) and the [Google Developer Documentation Style Guide](https://developers.google.com/style/cross-references)): **(1) "In plain words" 1-sentence banner** (for the CEO or quick scanner), **(2) Everyday human analogy** (for the brand-new employee or non-technical reader), and **(3) Clear, story-driven walkthrough & clean reference tables** (for the operator and engineer). |
| **4** | **Academy Lessons (`l-m1-1` to `l-m10-4`) Read Like Compressed Flashcards Instead of Teaching Lessons:** In `academy_system_design_and_content.md`, most lessons have only 4–5 one-line bullet fragments under `### Key ideas` and a 2-sentence `### A worked example`, forcing learners to jump back and forth to the Guide just to pass the quiz. | In `l-m2-1`: *"Payment Attempt is one specific try. Thirteen states; three final."* followed immediately by a multi-part quiz. | **Rewrite Academy lessons into self-contained, story-driven mini-tutorials** with warm explanations, a realistic step-by-step worked story with real numbers/names (e.g., *Sara buying a 100 LYD jacket at Noon Mart*), and clear "Why this matters" takeaways—while keeping 100% of the required `###` headings and quiz IDs intact. |

---

## Part 1 — Smart Cross-Reference & Reader UI Architecture (`companion-app` & `admin-front`)

Before replacing the article prose, we upgrade the Markdown rendering engine in **both** `companion-app` and `admin-front` so cross-references never clutter a paragraph again—and so tapping a reference on a phone or desktop feels effortless.

### 1.1 How Cross-References Work After This Upgrade

1. **Zero Mid-Sentence Parenthetical Dumps:**
   - Whenever the parser encounters a parenthetical reference or list of references at the end of a clause or sentence—such as `([[a:b06-12]])`, `(see [[a:b02-06]])`, `(see [[a:b06-05]], [[a:b06-07]])`, or `([[c:sg-payment-attempts]])`—it **automatically strips the parentheses from the sentence** so the prose reads cleanly without interruption.
   - All stripped references from a section (`## ...`) are deduplicated and rendered at the **bottom of that section** inside a compact, scannable **"Related in this section"** bar with typed pills:
     - `📖 Article: Visible-rails formula`
     - `🖥️ Screen: Payment Attempts`
     - `🚨 Playbook: Payment stuck in UNKNOWN`
2. **Explicit `:::refs` Footer Block Support:**
   - Authors can also explicitly place a `:::refs` block at the bottom of any section or article to group deep-dive links with a short human explanation of *why* you would click each one:
     ```markdown
     :::refs
     - [[a:b06-12|How the checkout chooses which payment methods to show]]
     - [[c:sg-payment-attempts|Screen card: Payment Attempts list & filters]]
     :::
     ```
3. **Plain-Language Summary Callout (`:::summary`):**
   - Adds a new `:::summary` callout type (rendered with a warm amber/gold "In plain words" header badge) for the top of any article, giving every reader—from the CEO to a first-day trainee—the entire point of the article in two sentences before diving in.
4. **Tap-to-Preview Reference Bottom Sheet (in `companion-app` & `admin-front`):**
   - Just like tapping a dotted glossary term opens a bottom sheet with the definition without leaving the page, tapping any `📖` article pill or `🖥️` screen card pill opens a **Quick Preview Sheet** showing:
     - The target article/card title and category badge (`Book 6 · Routing` or `Screen Card · Operations`)
     - Its `summary` (or `purpose` for a screen card) and reading time (`5 min read`)
     - Two actions: **"Read full article →"** (navigates there) or **"Stay here"** (closes the sheet so the reader never loses their reading flow).

### 1.2 Drop-In Replacement for `companion-app/src/lib/markdown.ts`

Replace `companion-app/src/lib/markdown.ts` with the following implementation. It preserves 100% of existing tests and exports (`renderMarkdown`, `extractHeadings`, `escapeHtml`, `RenderOptions`, `RenderedSegment`) while adding automatic parenthetical reference extraction, section reference trays, `:::summary` / `:::refs` callouts, and `data-ref-kind` / `data-ref-id` attributes for the preview sheet:

```typescript
// File: companion-app/src/lib/markdown.ts
import MarkdownIt from "markdown-it";
import type { Article, Card, Situation, Term } from "@/content/types";
import { createHeadingIdFactory } from "./slug";

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

export interface RenderOptions {
    articleId?: string;
    glossary?: Term[];
    articles?: Pick<Article, "id" | "title" | "summary" | "minutes">[];
    cards?: Pick<Card, "id" | "title" | "purpose" | "path">[];
    situations?: Pick<Situation, "id" | "title" | "symptom">[];
    disableGlossaryLinks?: boolean;
    glossaryPageSlug?: string;
}

export interface RenderedSegment {
    type: "html" | "widget";
    html?: string;
    widgetId?: string;
}

interface CollectedRef {
    kind: string;
    id: string;
    label?: string;
}

interface RenderEnv {
    headingIdFactory: (text: string) => string;
    usedTerms: Set<string>;
    termsByKey: Map<string, Term>;
    glossaryRegex: RegExp | null;
    disableGlossaryLinks: boolean;
    glossaryPageSlug?: string;
    resolveLink: (
        kind: string,
        id: string,
        customLabel?: string,
    ) => {
        href: string;
        label: string;
        title: string;
        kindBadge: string;
    };
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

/**
 * Strips clunky mid-sentence parenthetical reference dumps such as:
 *   ([[a:b06-12]])
 *   (see [[a:b02-06]])
 *   (see [[a:b06-05]], [[a:b06-07]])
 *   ([[c:sg-payment-attempts]])
 * and returns the cleaned paragraph text plus the extracted references so they
 * can be rendered in a clean footer tray at the end of the section.
 */
export const extractParentheticalRefs = (
    line: string,
): { cleaned: string; refs: CollectedRef[] } => {
    const refs: CollectedRef[] = [];
    const parenRefPattern =
        /\s*\((?:see\s+|also\s+|e\.g\.,?\s+|for example\s+)?(\[\[[acgs]:[a-z0-9-]+(?:\|[^\]]+)?\]\](?:\s*(?:,|and|or)\s*\[\[[acgs]:[a-z0-9-]+(?:\|[^\]]+)?\]\])*)\)/gi;

    const cleaned = line.replace(parenRefPattern, (_fullMatch, innerGroup: string) => {
        const tokenRegex = /\[\[([acgs]):([a-z0-9-]+)(?:\|([^\]]+))?\]\]/g;
        let match: RegExpExecArray | null;
        while ((match = tokenRegex.exec(innerGroup)) !== null) {
            refs.push({
                kind: match[1]!,
                id: match[2]!,
                label: match[3] || undefined,
            });
        }
        return "";
    });

    // Clean up any accidental space before punctuation left by removing the parenthetical
    const normalized = cleaned.replace(/\s+([.,;:!?])/g, "$1");
    return { cleaned: normalized, refs };
};

const renderRefTrayHtml = (refs: CollectedRef[], env: RenderEnv): string => {
    if (refs.length === 0) return "";
    const unique = new Map<string, CollectedRef>();
    for (const ref of refs) {
        const key = `${ref.kind}:${ref.id}`;
        if (!unique.has(key)) unique.set(key, ref);
    }
    const pills = [...unique.values()]
        .map((ref) => {
            const link = env.resolveLink(ref.kind, ref.id, ref.label);
            return `<a href="${escapeHtml(link.href)}" class="ref-pill ref-pill--${escapeHtml(
                ref.kind,
            )}" data-guide-link="true" data-ref-kind="${escapeHtml(
                ref.kind,
            )}" data-ref-id="${escapeHtml(ref.id)}" title="${escapeHtml(
                link.title,
            )}"><span class="ref-pill__badge">${escapeHtml(
                link.kindBadge,
            )}</span><span class="ref-pill__label">${escapeHtml(link.label)}</span></a>`;
        })
        .join("");

    return `<aside class="section-refs" aria-label="Related guides and screens"><span class="section-refs__title">Related:</span><div class="section-refs__list">${pills}</div></aside>`;
};

const linkTermsInText = (text: string, env: RenderEnv): { tokens: any[] } | null => {
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

const createMarkdown = (): MarkdownIt => {
    const md = new MarkdownIt({
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
        const resolver = (env as unknown as RenderEnv).resolveLink;
        const link = resolver(meta.kind, meta.id, meta.label || undefined);
        return `<a href="${escapeHtml(link.href)}" class="inline-guide-ref" data-guide-link="true" data-ref-kind="${escapeHtml(
            meta.kind,
        )}" data-ref-id="${escapeHtml(meta.id)}" title="${escapeHtml(
            link.title,
        )}">${escapeHtml(link.label)}</a>`;
    };

    md.core.ruler.push("guide_heading_ids", (state: any) => {
        const env = state.env as unknown as RenderEnv;
        for (let index = 0; index < state.tokens.length; index += 1) {
            const token = state.tokens[index]!;
            if (token.type !== "heading_open") continue;
            const inline = state.tokens[index + 1];
            if (!inline || inline.type !== "inline") continue;
            token.attrSet("id", env.headingIdFactory(inline.content));
        }
    });

    md.core.ruler.push("guide_glossary_links", (state: any) => {
        const env = state.env as unknown as RenderEnv;
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
                    if (child.type === "link_open" || child.type === "guide_ref") {
                        insideLink = child.type === "link_open";
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
        return `<button type="button" class="glossary-term" data-slug="${escapeHtml(
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
            return `<pre class="diagram" dir="ltr"><code>${escapeHtml(
                token.content,
            )}</code></pre>`;
        }
        return defaultFence
            ? defaultFence(tokens, index, options, env, self)
            : `<pre><code>${escapeHtml(token.content)}</code></pre>`;
    };

    return md;
};

const mdInstance = createMarkdown();

export const renderMarkdown = (
    source: string,
    options: RenderOptions = {},
): RenderedSegment[] => {
    const terms = options.glossary ?? [];
    const articleMap = new Map(
        (options.articles ?? []).map((article) => [article.id, article.title]),
    );
    const cardMap = new Map((options.cards ?? []).map((card) => [card.id, card.title]));
    const situationMap = new Map(
        (options.situations ?? []).map((situation) => [situation.id, situation.title]),
    );
    const termBySlug = new Map(terms.map((term) => [term.slug, term]));

    const env: RenderEnv = {
        headingIdFactory: createHeadingIdFactory(),
        usedTerms: new Set<string>(),
        termsByKey: new Map(
            terms.flatMap((term) =>
                [term.term, ...term.aliases].map(
                    (key) => [normalizeKey(key), term] as const,
                ),
            ),
        ),
        glossaryRegex: makeGlossaryRegex(terms),
        disableGlossaryLinks: options.disableGlossaryLinks ?? false,
        glossaryPageSlug: options.glossaryPageSlug,
        resolveLink: (kind, id, customLabel) => {
            if (kind === "a") {
                const title = articleMap.get(id) ?? id;
                return {
                    href: `/guide/article/${id}`,
                    label: customLabel || title,
                    title,
                    kindBadge: "Guide",
                };
            }
            if (kind === "c") {
                const title = cardMap.get(id) ?? id;
                return {
                    href: `/guide/card/${id}`,
                    label: customLabel || title,
                    title,
                    kindBadge: "Screen",
                };
            }
            if (kind === "s") {
                const title = situationMap.get(id) ?? id;
                return {
                    href: `/guide/situation/${id}`,
                    label: customLabel || title,
                    title,
                    kindBadge: "Playbook",
                };
            }
            const term = termBySlug.get(id);
            const title = term?.term ?? id;
            return {
                href: `/guide/glossary/${id}`,
                label: customLabel || title,
                title,
                kindBadge: "Term",
            };
        },
    };

    const segments: RenderedSegment[] = [];
    const lines = source.replace(/\r\n/g, "\n").split("\n");
    let buffer: string[] = [];
    let sectionRefs: CollectedRef[] = [];
    let insideCodeFence = false;

    const flush = (includeRefTray = false) => {
        if (buffer.length > 0) {
            segments.push({
                type: "html",
                html: mdInstance.render(buffer.join("\n"), env as any),
            });
            buffer = [];
        }
        if (includeRefTray && sectionRefs.length > 0) {
            segments.push({
                type: "html",
                html: renderRefTrayHtml(sectionRefs, env),
            });
            sectionRefs = [];
        }
    };

    for (let index = 0; index < lines.length; index += 1) {
        const rawLine = lines[index] ?? "";
        const trimmed = rawLine.trim();

        if (trimmed.startsWith("```")) {
            insideCodeFence = !insideCodeFence;
            buffer.push(rawLine);
            continue;
        }

        if (insideCodeFence) {
            buffer.push(rawLine);
            continue;
        }

        // Before starting a new ## heading, flush any accumulated section references
        if (/^##\s+/.test(trimmed)) {
            flush(true);
            buffer.push(rawLine);
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
                const extracted = extractParentheticalRefs(lines[index] ?? "");
                inner.push(extracted.cleaned);
                sectionRefs.push(...extracted.refs);
                index += 1;
            }
            const innerHtml = mdInstance.render(inner.join("\n"), env as any);
            segments.push({
                type: "html",
                html: `<aside class="callout callout-${calloutType}" role="note"><div class="callout__header"><span class="callout__label">${escapeHtml(
                    CALLOUT_LABELS[calloutType] ?? calloutType,
                )}</span>${
                    title
                        ? `<span class="callout__title">${escapeHtml(title)}</span>`
                        : ""
                }</div><div class="callout__body">${innerHtml}</div></aside>`,
            });
            continue;
        }

        const widget = /^\{\{widget:([a-z0-9-]+)\}\}$/.exec(trimmed);
        if (widget && WIDGET_IDS.has(widget[1] ?? "")) {
            flush(false);
            segments.push({ type: "widget", widgetId: widget[1] });
            continue;
        }

        const extracted = extractParentheticalRefs(rawLine);
        buffer.push(extracted.cleaned);
        sectionRefs.push(...extracted.refs);
    }

    flush(true);
    return segments;
};

export interface HeadingItem {
    id: string;
    text: string;
    level: number;
}

export const extractHeadings = (source: string): HeadingItem[] => {
    const idFactory = createHeadingIdFactory();
    const lines = source.replace(/\r\n/g, "\n").split("\n");
    const headings: HeadingItem[] = [];
    let insideFence = false;
    for (const raw of lines) {
        const line = raw.trim();
        if (line.startsWith("```")) {
            insideFence = !insideFence;
            continue;
        }
        if (insideFence) continue;
        const match = /^(#{2,3})\s+(.+?)\s*$/.exec(line);
        if (!match) continue;
        const level = match[1]!.length;
        const text = match[2]!.replace(/\[\[[^\]]+\]\]/g, "").trim();
        headings.push({ id: idFactory(text), text, level });
    }
    return headings;
};
```

### 1.3 Upgrade `companion-app/src/components/MarkdownView.vue` with Quick-Preview Reference Sheet

Update `companion-app/src/components/MarkdownView.vue` so tapping any reference pill (`.ref-pill`) or inline guide link opens a clean **Reference Preview Sheet** with the article/card summary and a "Read full guide →" button, preventing context-switching fatigue:

```vue
<!-- File: companion-app/src/components/MarkdownView.vue -->
<script setup lang="ts">
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import AppIcon from "./AppIcon.vue";
import ToolWidget from "./ToolWidget.vue";
import { renderMarkdown } from "@/lib/markdown";
import { useContent } from "@/content/store";
import type { Term } from "@/content/types";

interface PreviewItem {
    kindLabel: string;
    title: string;
    subtitle: string;
    body: string;
    href: string;
}

const props = withDefaults(
    defineProps<{
        source: string;
        articleId?: string;
        disableGlossaryLinks?: boolean;
        glossaryPageSlug?: string;
    }>(),
    { articleId: "", disableGlossaryLinks: false, glossaryPageSlug: "" },
);

const router = useRouter();
const { bundle } = useContent();
const selectedTerm = ref<Term | null>(null);
const selectedPreview = ref<PreviewItem | null>(null);

const segments = computed(() => {
    const guide = bundle.value?.guide;
    return renderMarkdown(props.source, {
        articleId: props.articleId,
        glossary: guide?.glossary ?? [],
        articles: guide?.articles ?? [],
        cards: guide?.cards ?? [],
        situations: guide?.playbook ?? [],
        disableGlossaryLinks: props.disableGlossaryLinks,
        glossaryPageSlug: props.glossaryPageSlug,
    });
});

const relatedTerms = computed(() => {
    const term = selectedTerm.value;
    if (!term) return [];
    const terms = bundle.value?.guide.glossary ?? [];
    const bySlug = new Map(terms.map((entry) => [entry.slug, entry]));
    return term.related
        .map((slug) => bySlug.get(slug))
        .filter((entry): entry is Term => Boolean(entry));
});

const openTerm = (slug: string): void => {
    selectedPreview.value = null;
    selectedTerm.value =
        bundle.value?.guide.glossary.find((term) => term.slug === slug) ?? null;
};

const openRefPreview = (kind: string, id: string, href: string): boolean => {
    const guide = bundle.value?.guide;
    if (!guide) return false;

    if (kind === "a") {
        const article = guide.articles.find((item) => item.id === id);
        if (!article) return false;
        const book = guide.books.find((item) => item.id === article.book);
        selectedTerm.value = null;
        selectedPreview.value = {
            kindLabel: book ? `Book ${book.number} · ${book.title}` : "Guide Article",
            title: article.title,
            subtitle: `${article.minutes} min read`,
            body: article.summary,
            href,
        };
        return true;
    }

    if (kind === "c") {
        const card = guide.cards.find((item) => item.id === id);
        if (!card) return false;
        selectedTerm.value = null;
        selectedPreview.value = {
            kindLabel: `Screen Card · ${card.section}`,
            title: card.title,
            subtitle: card.path,
            body: card.purpose,
            href,
        };
        return true;
    }

    if (kind === "s") {
        const situation = guide.playbook.find((item) => item.id === id);
        if (!situation) return false;
        selectedTerm.value = null;
        selectedPreview.value = {
            kindLabel: `Incident Playbook · ${situation.severity.toUpperCase()}`,
            title: situation.title,
            subtitle: "Step-by-step response checklist",
            body: situation.symptom,
            href,
        };
        return true;
    }

    if (kind === "g") {
        openTerm(id);
        return true;
    }

    return false;
};

const onClick = (event: MouseEvent): void => {
    const target = event.target as HTMLElement | null;
    const glossary = target?.closest<HTMLElement>(".glossary-term");
    if (glossary) {
        event.preventDefault();
        openTerm(glossary.dataset.slug ?? "");
        return;
    }
    const link = target?.closest<HTMLAnchorElement>("a[data-guide-link]");
    if (link) {
        const href = link.getAttribute("href") ?? "";
        const refKind = link.dataset.refKind ?? "";
        const refId = link.dataset.refId ?? "";
        event.preventDefault();
        if (refKind && refId && openRefPreview(refKind, refId, href)) {
            return;
        }
        if (href.startsWith("/")) void router.push(href);
    }
};

const openRelated = (slug: string): void => {
    selectedTerm.value = null;
    void router.push(`/guide/glossary/${slug}`);
};

const navigateToPreview = (): void => {
    const href = selectedPreview.value?.href;
    selectedPreview.value = null;
    if (href && href.startsWith("/")) {
        void router.push(href);
    }
};
</script>

<template>
    <div class="prose" @click="onClick">
        <template v-for="(segment, index) in segments" :key="index">
            <div v-if="segment.type === 'widget' && segment.widgetId" class="widget-embed">
                <ToolWidget :tool="segment.widgetId" />
            </div>
            <div v-else v-html="segment.html" />
        </template>
    </div>

    <Teleport to="body">
        <div
            v-if="selectedTerm"
            class="sheet-backdrop"
            role="presentation"
            @click.self="selectedTerm = null"
        >
            <section class="sheet" role="dialog" aria-modal="true" aria-labelledby="term-title">
                <header class="sheet__header">
                    <div>
                        <p class="eyebrow">Glossary</p>
                        <h2 id="term-title" dir="auto">{{ selectedTerm.term }}</h2>
                    </div>
                    <button type="button" class="icon-button" @click="selectedTerm = null">
                        <AppIcon name="close" />
                    </button>
                </header>
                <p v-if="selectedTerm.ar" class="arabic-term" dir="rtl" lang="ar">
                    {{ selectedTerm.ar }}
                </p>
                <p class="sheet__body" dir="auto">{{ selectedTerm.short }}</p>
                <p v-if="selectedTerm.aliases.length" class="muted small" dir="auto">
                    Also called: {{ selectedTerm.aliases.join(", ") }}
                </p>
                <div v-if="relatedTerms.length" class="related-terms">
                    <p class="eyebrow">Related terms</p>
                    <button
                        v-for="term in relatedTerms"
                        :key="term.slug"
                        type="button"
                        class="chip"
                        @click="openRelated(term.slug)"
                    >
                        {{ term.term }}
                    </button>
                </div>
            </section>
        </div>

        <div
            v-if="selectedPreview"
            class="sheet-backdrop"
            role="presentation"
            @click.self="selectedPreview = null"
        >
            <section class="sheet" role="dialog" aria-modal="true" aria-labelledby="preview-title">
                <header class="sheet__header">
                    <div>
                        <p class="eyebrow">{{ selectedPreview.kindLabel }}</p>
                        <h2 id="preview-title" dir="auto">{{ selectedPreview.title }}</h2>
                    </div>
                    <button type="button" class="icon-button" @click="selectedPreview = null">
                        <AppIcon name="close" />
                    </button>
                </header>
                <p class="muted small" dir="auto">{{ selectedPreview.subtitle }}</p>
                <p class="sheet__body" dir="auto">{{ selectedPreview.body }}</p>
                <div class="sheet__actions">
                    <button type="button" class="btn btn--secondary" @click="selectedPreview = null">
                        Keep reading here
                    </button>
                    <button type="button" class="btn btn--primary" @click="navigateToPreview">
                        Open full page →
                    </button>
                </div>
            </section>
        </div>
    </Teleport>
</template>
```

### 1.4 CSS Additions for Section Reference Trays & Summary Callouts (`companion-app/src/styles/app.css` & `admin-front/src/styles/guide.css`)

Append these styles to both `companion-app/src/styles/app.css` and `admin-front/src/styles/guide.css`:

```css
/* Clean bottom-of-section reference tray (replaces mid-sentence parentheticals) */
.section-refs {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    margin: 1rem 0 1.75rem;
    padding: 0.65rem 0.85rem;
    border-radius: 10px;
    background: var(--surface-subtle, rgba(148, 163, 184, 0.08));
    border: 1px solid var(--border-subtle, rgba(148, 163, 184, 0.18));
}

.section-refs__title {
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted, #64748b);
    margin-right: 0.25rem;
}

.section-refs__list {
    display: flex;
    flex-wrap: wrap;
    gap: 0.45rem;
}

.ref-pill {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.22rem 0.6rem;
    border-radius: 999px;
    font-size: 0.8rem;
    line-height: 1.3;
    text-decoration: none;
    background: var(--surface-card, #ffffff);
    border: 1px solid var(--border-default, rgba(148, 163, 184, 0.3));
    color: var(--text-primary, #0f172a);
    transition: transform 0.12s ease, border-color 0.12s ease;
}

.ref-pill:hover,
.ref-pill:focus-visible {
    transform: translateY(-1px);
    border-color: var(--accent-primary, #2563eb);
}

.ref-pill__badge {
    font-size: 0.68rem;
    font-weight: 700;
    text-transform: uppercase;
    padding: 0.08rem 0.38rem;
    border-radius: 999px;
    background: rgba(37, 99, 235, 0.12);
    color: var(--accent-primary, #2563eb);
}

.ref-pill--c .ref-pill__badge {
    background: rgba(16, 185, 129, 0.14);
    color: #059669;
}

.ref-pill--s .ref-pill__badge {
    background: rgba(245, 158, 11, 0.16);
    color: #d97706;
}

.callout-summary {
    border-left: 4px solid #0ea5e9;
    background: rgba(14, 165, 233, 0.08);
}

.sheet__actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.65rem;
    margin-top: 1.25rem;
}
```

---

## Part 2 — Direct Verbatim Article Replacements for Book 2 (`b02-01` through `b02-07`)

Book 2 (*How This Platform Works*) is the bridge between Book 1's everyday analogies and the rest of the library. Below are the **complete, drop-in replacement `@@article ... @@end` blocks** for every article in Book 2 (`design/07-guides-and-academy/guide_system_design_and_content.md`).

Every single mid-sentence parenthetical cross-reference dump (`([[a:...]])`, `(see [[a:...]])`) has been removed from the prose and moved to clean bottom-of-section trays, double-parentheses sentences have been rewritten into warm, human storytelling, and every article opens with an **"In plain words"** summary so any reader—from a brand-new hire to the CEO—grasps the whole picture in seconds.

### 2.1 Direct Replacement: `b02-01` — *The platform on one page*

```markdown
@@article
id: b02-01
book: b02
order: 1
title: The platform on one page
summary: The main parts of the platform, what each one does, and how a request flows through them.
minutes: 4
audience: all
related: b01-03, b02-02, b02-03
@@body
:::summary Big picture in 20 seconds
Our platform has five working parts, and each part has one strict job: **Edge** greets the outside world, **Core** makes the business decisions and keeps the books, **Admin Back** serves the operator portal, **Admin Front** is the screen you click, and **Backup Daemon** keeps encrypted recovery copies safe.
:::

## One picture for the whole system

Imagine a well-run bank branch:
- There is a **security desk at the front door** that checks every visitor's badge before letting them inside.
- There is a **vault and accounting room in the back** where money is counted and the official ledger is written.
- There is an **operations desk** where bank staff review applications, investigate stuck transfers, and help customers.

Our platform is built the exact same way. Even though we deploy the codebase from one unified repository, it runs as **five separate services** so that public internet traffic can never walk straight into the accounting room.

```diagram
   Customer / Merchant App                  Operator Browser
             |                                     |
             v                                     v
   +-------------------+                 +-------------------+
   |       Edge        |                 |    Admin Front    |
   |  (public doorway) |                 |   (portal pages)  |
   +-------------------+                 +-------------------+
             |                                     |
             | signed internal call                v
             |                           +-------------------+
             |                           |    Admin Back     |
             |                           |  (portal server)  |
             |                           +-------------------+
             |                                     |
             +------------------+------------------+
                                |
                                v
                      +-------------------+
                      |       Core        |
                      | (decisions, keys, |
                      |  ledger, database)|
                      +-------------------+
                         /      |      \
                        v       v       v
                  Postgres    Redis   Partners
                  (records)  (speed) (banks/wallets)
```

## What each of the five parts does

| Part | Everyday analogy | What it does | What it is **never** allowed to do |
|---|---|---|---|
| **Edge** (`edge`) | The front-door security guard | Accepts checkout requests and incoming bank callbacks from the public internet. Checks signatures, blocks flood traffic, and forwards clean requests to Core. | Never touches the main database, never writes to the ledger, and never talks directly to external banks. |
| **Core** (`core-back`) | The vault and chief accountant | Makes every real payment decision: checks limits, picks the bank route, calls external providers, and writes the double-entry ledger in PostgreSQL. | Never exposes a public port to the open internet. Only Edge and Admin Back can call it. |
| **Admin Back** (`admin-back`) | The staff operations desk | Handles staff sign-in, two-step verification, role permissions, and four-eyes approvals for the operator portal, then asks Core to carry out approved actions. | Never moves money on its own; it forwards every business action to Core. |
| **Admin Front** (`admin-front`) | The glass window and dashboard | The browser application you look at every day—screens, tables, search, and this Guide and Academy. | Never stores secrets or talks to Core directly; it only talks to Admin Back. |
| **Backup Daemon** (`pg-backup-daemon`) | The armoured archive truck | Takes encrypted snapshots of the database and write-ahead logs, verifies they can actually be restored, and ships them to off-site storage. | Never alters live payment traffic. |

## Why we split Edge, Admin Back, and Core

A new team member often asks: *"Why not let one server do everything?"*

We separate them for three practical reasons:

1. **Safety at the front door:** Edge faces the open internet. If a malicious bot floods our public checkout address with junk traffic, Edge absorbs the noise using fast memory counters in Redis while Core and the database stay calm and protected behind the firewall.
2. **One source of truth for money:** Only Core can talk to PostgreSQL and external banking partners. That means there is only one place in the entire company where a balance can change or a bank transfer can be triggered.
3. **Separate doors for merchants and staff:** Merchants call Edge with API keys; human operators sign in to Admin Back with passwords, passkeys, or authenticator codes. Keeping those two doors separate prevents a bug in a merchant endpoint from ever granting staff permissions.

:::tip A simple rule of thumb
If a question is about **what a customer or merchant app sends**, look at **Edge**.
If a question is about **what a staff member clicks on screen**, look at **Admin Front** and **Admin Back**.
If a question is about **money, states, routing, fees, or the ledger**, the answer always lives in **Core**.
:::

:::refs
- [[a:b02-02|How Edge, Admin Back, and Core talk to each other safely]]
- [[a:b02-03|Follow a single payment from checkout to settlement]]
:::
@@end
```

### 2.2 Direct Replacement: `b02-02` — *The three services: Edge, Admin, and Core*

```markdown
@@article
id: b02-02
book: b02
order: 2
title: The three services: Edge, Admin, and Core
summary: Why the platform is split into Edge, Admin, and Core, and what crosses each boundary.
minutes: 5
audience: all
related: b02-01, b04-03, b05-03
@@body
:::summary Big picture in 20 seconds
Neither Edge nor Admin Back is trusted just because it runs on our private network. Every time Edge or Admin Back asks Core to do something, it must attach a fresh cryptographic signature, a timestamp, and a unique tracking number (`traceId`).
:::

## How a request travels across the boundaries

Think of Core as a high-security pharmacy window inside a hospital. Even if a nurse is already inside the hospital building, the pharmacist will not hand over medicine without a signed prescription slip showing the doctor's name, the time it was written, and the patient's wristband number.

In our platform, **Edge** and **Admin Back** are inside our private network, yet **Core** still checks three things on every single internal call before doing any work:

1. **Who sent this call, and is the seal unbroken?** Edge or Admin Back signs the request body using a shared internal secret (`HMAC`). If a single character of the amount or merchant ID changes in transit, the signature check fails and Core rejects the call immediately.
2. **Was this sent right now?** The call carries a timestamp and a one-time random token (`nonce`). If someone captures a valid internal message and tries to replay it two minutes later, Core rejects it as stale.
3. **What is the end-to-end tracking number?** The first service to touch a request creates a unique tracking label called a **Trace ID** (`traceId`) and passes it along every step of the way.

## Walking through the two main paths

### Path A — A customer pays at checkout (Merchant → Edge → Core)

```diagram
Merchant Server ──(1. Public API + HMAC)──> Edge ──(2. Internal Signed Call)──> Core
```

1. **At the front door (Edge):** The merchant's website or mobile app sends a payment request to Edge. Edge verifies the merchant's API key, checks the merchant's signature, confirms the IP address is allowed, and checks the rate limit.
2. **Crossing into Core:** Edge does not know which bank route is healthy or what the merchant's fee tier is. Instead, Edge packages the verified merchant ID, the request body, and the `traceId`, signs them with its internal Edge-to-Core key, and forwards the package to Core.
3. **Inside Core:** Core verifies Edge's internal signature, runs the business rules, talks to the banking partner, writes the database and ledger rows, and hands the clean response back to Edge.

### Path B — An operator clicks a button in the portal (Browser → Admin Front → Admin Back → Core)

```diagram
Operator Browser ──(1. Session Cookie + CSRF)──> Admin Back ──(2. Signed Staff Call)──> Core
```

1. **At the staff desk (Admin Back):** When you click **Approve Refund** or **Freeze Merchant** in your browser, your request goes to Admin Back. Admin Back checks that your login session is still active, your two-step verification (`MFA`) is valid, and your role has permission for that action.
2. **Checking four-eyes rules:** If the action is sensitive (like changing a bank route or issuing a large refund), Admin Back checks whether a second manager must approve it first.
3. **Crossing into Core:** Once allowed, Admin Back forwards the command to Core along with your operator ID, your reason note, and the `traceId`. Core records an immutable audit log entry and performs the change.

## How to use the Trace ID when investigating an issue

Because the exact same `traceId` travels from Edge or Admin Back all the way into Core's database logs and partner calls, you never have to guess which internal event belongs to which user click.

:::do Copy the Trace ID first
Whenever a merchant or fellow operator reports an error banner, copy the `traceId` from the error message or the **Audit Log** screen. Pasting that one ID into global search (`Ctrl+K`) shows you the front-door arrival, the Core decision, and the partner call side by side.
:::

:::refs
- [[a:b04-03|How merchant API signatures and replay protection work]]
- [[a:b05-03|How staff roles and permissions are checked]]
- [[c:sg-audit-logs|Screen card: Audit Logs]]
:::
@@end
```

### 2.3 Direct Replacement: `b02-03` — *The life of a payment, step by step*

*(Note: In the original file, `b02-03` had 14 separate mid-sentence parenthetical article title expansions, making it the hardest article in Book 2 to read. This replacement makes the 10-step story crystal clear while grouping all deep-dive links cleanly at the end of each phase.)*

```markdown
@@article
id: b02-03
book: b02
order: 3
title: The life of a payment, step by step
summary: Follow one 100 LYD payment from the moment a shopper clicks Pay to the moment the money settles in the merchant's balance.
minutes: 6
audience: all
related: b02-04, b02-06, b02-07, b08-04
@@body
:::summary Big picture in 20 seconds
Every payment goes through **three acts**: **Act 1 (Setup)** checks who the merchant is and shows the shopper only the payment methods that currently work; **Act 2 (Execution)** locks in one chosen method, contacts the bank or wallet partner, and waits for proof; **Act 3 (Accounting)** moves the money in our double-entry ledger once proof arrives.
:::

## Meet our example payment

To make this concrete, let's follow a real shopper named **Sara**. Sara is buying a **100 LYD** jacket from an online store called **Noon Mart**.

Here is what happens behind the scenes in ten clear steps, grouped into three acts.

---

## Act 1 — Setting the stage (Steps 1 to 3)

### Step 1: Noon Mart asks us to open a checkout
When Sara clicks **Proceed to Checkout** on Noon Mart's website, Noon Mart's server sends a signed request to **Edge** saying: *"I want to collect 100 LYD for Order #9042, with idempotency key `order-9042-try-1`."*

Edge checks that Noon Mart's signature is genuine and that the key `order-9042-try-1` is not a duplicate of an earlier glitch, then passes the request to **Core**.

### Step 2: Core checks which payment methods Sara should see
Noon Mart might support local cards, Sadad, and MobiCash—but what if MobiCash is down for maintenance right now, or only allows payments up to 50 LYD?

Instead of showing Sara a broken button, Core checks every payment method (which we call a **rail**) against three simple questions:
1. Is this method enabled on Noon Mart's account?
2. Do we have an active fee agreement with Noon Mart for this method and amount?
3. Is there at least one healthy bank or wallet connection (**route**) ready to carry 100 LYD right now?

Every method that answers **Yes** to all three questions appears on Sara's checkout screen.

### Step 3: Core creates the payment attempt in state `CREATED`
Core saves a new **Payment Attempt** row in the database in state `CREATED` and returns the list of working payment methods to Sara's screen.

> **Ledger check at Step 3:** **No ledger entry is written yet.** No money has moved; we have only opened a checkout ticket.

:::refs
- [[a:b04-05|How idempotency keys stop accidental double charges]]
- [[a:b06-12|The visible-rails rules: why a payment method appears or hides]]
- [[a:b02-04|All 14 payment states explained one by one]]
:::

---

## Act 2 — Talking to the bank or wallet partner (Steps 4 to 7)

### Step 4: Sara picks a payment method (`LOCKED`)
Sara chooses **MobiCash** and enters her phone number. Core locks the payment attempt onto MobiCash and picks the best healthy partner connection (**route**). The payment state moves from `CREATED` to `LOCKED`, and Core calculates a **fee snapshot** (for example: 2 LYD gateway fee, leaving 98 LYD net for Noon Mart) so the agreed fee cannot change mid-flight.

### Step 5: We ask the partner to start the charge (`AUTHORIZING`)
Core moves the attempt to `AUTHORIZING` and sends the request to the MobiCash partner server using that partner's configured recipe (filling in the template fields, encrypting any PIN or secret, and sending the HTTP call).

### Step 6: Sara proves it is really her (`PENDING_USER_ACTION` or `PENDING_CONFIRMATION`)
Most local wallets and cards require the shopper to approve the charge:
- If Sara needs to type a one-time SMS code (`OTP`) or approve a prompt on her phone, the attempt sits in `PENDING_USER_ACTION`.
- Once she submits the code, the attempt moves to `PENDING_CONFIRMATION` while we wait for the partner's final verdict.

### Step 7: We translate the partner's reply into our standard state
Every bank and wallet speaks its own dialect—one partner returns `"00"`, another returns `"APPROVED"`, and a third returns `"ERR_51"`. Core runs the partner's response through our **status and error map** to decide what happened:

- **Clear approval:** The attempt moves to **`SUCCEEDED`**.
- **Clear decline (such as wrong OTP or low balance):** The attempt moves to **`FAILED`** (or stays open for another code entry if the error is retryable).
- **Silence or network timeout:** If our connection drops after we sent the charge request, **we never guess**. Because the partner might have charged Sara just before the line went dead, Core moves the attempt to **`UNKNOWN`** and hands it to our background status checker (`poller`) to ask the partner what actually happened.

:::refs
- [[a:b02-06|What rails, providers, routes, and collection modes mean]]
- [[a:b06-06|How we translate partner status codes and error messages]]
- [[a:b06-11|Why a network timeout goes to UNKNOWN instead of FAILED]]
:::

---

## Act 3 — Writing the books and paying the merchant (Steps 8 to 10)

### Step 8: How we know a success is genuine (Confirmation Channels)
A payment can be confirmed by the partner's immediate reply, by a signed incoming callback (**webhook**), by our background status poller, or by the nightly bank statement file (**reconciliation**). Core records which channel confirmed the payment so operators always know the strength of the proof.

### Step 9: Core writes the balanced ledger entry on `SUCCEEDED`
The exact moment Sara's 100 LYD payment hits `SUCCEEDED`—and **never** a second earlier—Core writes one balanced double-entry journal record:
- **Debit (increase) Gateway Clearing (`1100`):** `+100 LYD` (the partner now owes us Sara's 100 LYD).
- **Credit (increase) Merchant Pending Balance (`2110`):** `+98 LYD` (we owe Noon Mart 98 LYD once the partner settles).
- **Credit (increase) Gateway Fee Revenue (`4100`):** `+2 LYD` (our 2 LYD service fee).

Notice that the left side (`100`) equals the right side (`98 + 2 = 100`).

### Step 10: Settlement and Payout to Noon Mart's bank account
1. **Partner settlement:** The next morning, the bank partner transfers the collected funds to our main treasury account and sends their daily statement. Our reconciliation job matches Sara's payment and moves Noon Mart's **98 LYD** from **Pending (`2110`)** to **Available (`2120`)**.
2. **Merchant payout:** When Noon Mart requests a payout (or their scheduled payout runs), Core moves the 98 LYD out of **Available (`2120`)** and sends the bank transfer to Noon Mart.

```diagram
[Step 9: Payment SUCCEEDED]
  Partner Clearing (1100): +100 LYD  ──>  Merchant Pending (2110): +98 LYD
                                     ──>  Fee Revenue      (4100):  +2 LYD

[Step 10a: Partner Settles Next Day]
  Merchant Pending (2110):  -98 LYD  ──>  Merchant Available (2120): +98 LYD
```

:::refs
- [[a:b02-07|How we trust confirmation channels (webhooks, polling, bank files)]]
- [[a:b08-04|See the exact ledger entries for every payment event]]
- [[c:sg-payment-attempts|Screen card: Inspect a Payment Attempt timeline]]
:::
@@end
```

### 2.4 Direct Replacement: `b02-04` — *The fourteen payment states, one by one*

```markdown
@@article
id: b02-04
book: b02
order: 4
title: The fourteen payment states, one by one
summary: Every state a payment attempt can be in, what it means in plain language, whether it is final, and what an operator should do.
minutes: 7
audience: all
related: b02-03, b02-05, b06-11, b10-01
@@body
:::summary Big picture in 20 seconds
Every payment attempt is always in **one of 14 states**. You do not need to memorize all 14 at once—just group them into **Four Families**: **1) Getting Ready** (`CREATED`, `LOCKED`), **2) In Progress** (`AUTHORIZING`, `PENDING_USER_ACTION`, `PENDING_CONFIRMATION`, `WEAK_COMPLETED`), **3) Needs Attention** (`UNKNOWN`, `BLOCKED`, `DISPUTED`), and **4) Final** (`SUCCEEDED`, `FAILED`, `EXPIRED`, `CANCELLED`, `REVERSED`).
:::

## The Golden Rule of Payment States

Before looking at the states, remember two iron laws that protect both shoppers and merchants:

1. **Money only enters the ledger on `SUCCEEDED`:** While a payment is getting ready, waiting for an OTP code, or sitting in `UNKNOWN`, the merchant's balance does not change by a single dirham.
2. **Final means final:** Once a payment reaches one of the genuine final states (`SUCCEEDED`, `FAILED`, `EXPIRED`, `CANCELLED`), normal checkout traffic can never reopen it. If a `SUCCEEDED` payment is later refunded or charged back, it moves forward to `DISPUTED` or `REVERSED` with a brand-new offsetting ledger entry—never by erasing history.

## Visual map of how states move

{{widget:attempt-states}}

```diagram
[1. GETTING READY]
   CREATED ──(shopper picks method)──> LOCKED

[2. IN PROGRESS]
   LOCKED ──> AUTHORIZING ──> PENDING_USER_ACTION ──> PENDING_CONFIRMATION
                   │                                           │
                   ├──(network drop / timeout)──> [UNKNOWN] <──┘
                   │                                  │
                   └──────(partner says OK)───────────┴──> [SUCCEEDED] (Ledger written!)

[3. OTHER ENDINGS]
   • Clear bank decline ──────────────> [FAILED]
   • Shopper walks away / clock runs out > [EXPIRED]
   • Merchant cancels before charge ──> [CANCELLED]
   • Full refund / chargeback after win > [DISPUTED] ──> [REVERSED]
```

## The 14 states grouped by family

### Family 1 — Getting Ready (No money has moved)

| State | What is happening in plain words | What you should do |
|---|---|---|
| **`CREATED`** | The checkout ticket is open, and the shopper is looking at the available payment buttons. | Nothing. Wait for the shopper to pick a method, or let the timer expire it automatically. |
| **`LOCKED`** | The shopper picked a payment method (like Sadad or MobiCash), and Core locked in the bank route and fee snapshot. | Nothing. Core is about to call the partner within milliseconds. |

### Family 2 — In Progress (Waiting on the partner or shopper)

| State | What is happening in plain words | What you should do |
|---|---|---|
| **`AUTHORIZING`** | Core is talking to the bank or wallet partner right now to start the payment. | Wait a few seconds. If it stays here for more than a couple of minutes, check partner health. |
| **`PENDING_USER_ACTION`** | The partner is waiting for the shopper to do something—usually typing an SMS OTP code, scanning a QR code, or approving a prompt in their banking app. | If the merchant asks why the payment hasn't finished, let them know we are waiting on the shopper to complete their verification step. |
| **`PENDING_CONFIRMATION`** | The shopper finished their step, and we are waiting for the partner's final confirmation callback or status check. | Wait for the webhook or automatic poller. Do not ask the shopper to pay a second time. |
| **`WEAK_COMPLETED`** | We received a low-trust signal that the payment worked (such as a browser redirect), and we are waiting for a high-trust signal (a signed webhook or bank poll) before crediting the ledger. | **Do not release goods yet.** Wait for the system to upgrade the payment to `SUCCEEDED`. |

### Family 3 — Needs Operator or System Attention

| State | What is happening in plain words | What you should do |
|---|---|---|
| **`UNKNOWN`** | Our connection to the partner dropped or timed out *after* we sent the charge request. We do not know yet if the shopper was charged. | **Never tell the shopper to retry immediately.** Let the background poller query the partner, or follow the Stuck in UNKNOWN runbook (`RB-01`) if it remains stuck. |
| **`BLOCKED`** | A security, velocity, or compliance rule paused this payment for human review. | Open the attempt in the portal, review the triggered risk rule, and escalate to Compliance or Risk. |
| **`DISPUTED`** | The payment previously succeeded, but the shopper or partner bank has opened a formal dispute or chargeback inquiry. | Follow the Dispute workflow in Reconciliation & Finance; funds may be held in reserve until resolved. |

### Family 4 — Final States (The journey is over)

| State | What is happening in plain words | Did money move in our ledger? |
|---|---|---|
| **`SUCCEEDED`** | Confirmed success. The shopper paid, and the partner confirmed it over a trusted channel. | **Yes.** Clearing, merchant pending balance, and fee revenue were posted. |
| **`FAILED`** | The partner clearly rejected the payment (for example, insufficient funds or invalid card), or a retryable error ran out of retries. | **No.** Safe for the shopper to try again with a new payment attempt. |
| **`EXPIRED`** | The shopper closed the tab or took too long, and the checkout timer ran out before any charge completed. | **No.** |
| **`CANCELLED`** | The merchant or shopper cancelled the checkout before the charge was sent to the partner. | **No.** |
| **`REVERSED`** | A payment that previously `SUCCEEDED` was later fully refunded or reversed after a dispute. | **Yes (both ways).** The original entry remains on the books, and a second reversing entry zeroes out the net effect. |

:::danger The #1 mistake to avoid: Treating `UNKNOWN` as `FAILED`
If a payment is in `UNKNOWN`, the partner bank might have already taken the money from the customer's account right before the internet connection blinked. If you tell the customer *"It failed, please pay again,"* they can be charged twice. Always wait for `UNKNOWN` to resolve to `SUCCEEDED` or `FAILED`.
:::

:::refs
- [[a:b06-11|Deep dive: How our state machine protects UNKNOWN payments]]
- [[a:b10-01|Runbook RB-01: Resolving a payment stuck in UNKNOWN]]
- [[c:sg-payment-attempts|Screen card: Payment Attempts]]
:::
@@end
```

### 2.5 Direct Replacement: `b02-05` — *The merchant lifecycle, from application to active*

```markdown
@@article
id: b02-05
book: b02
order: 5
title: The merchant lifecycle, from application to active
summary: How a business applies to join our platform, gets verified (KYB), tests in sandbox, and goes live.
minutes: 5
audience: all
related: b04-01, b04-02, b09-04
@@body
:::summary Big picture in 20 seconds
A business never jumps straight from filling out a web form to taking live customer money. Every merchant walks through **two separate tracks**: first, the **Join Application track** (where Compliance verifies their business documents), and second, the **Merchant Account track** (where they test in Sandbox, configure fees and bank routes, and get switched to `ACTIVE`).
:::

## Track 1 — The Join Application (Before the account exists)

When a store owner wants to use our payment gateway, they start as a **Join Request** (`MerchantJoinRequest`), not a live merchant account. Think of this like applying for a business bank account before the bank issues you an account number.

```diagram
[Applicant submits form]
          │
          ▼
       PENDING ──(operator opens file)──> UNDER_REVIEW
                                              │
                  ┌───────────────────────────┼───────────────────────────┐
                  ▼                           ▼                           ▼
          INFO_REQUESTED                  APPROVED                    REJECTED
     (missing a clear scan;         (creates the Merchant         (application closed
      cycles back when sent)         record in PENDING_KYB)        with recorded reason)
```

| Application State | What happens here | Who acts next |
|---|---|---|
| **`PENDING`** | The business submitted their trade license, registration number, owner ID, and settlement bank details. | Onboarding / Compliance operator claims the file. |
| **`UNDER_REVIEW`** | An operator is checking the documents against official registries and screening lists. | The reviewing operator. |
| **`INFO_REQUESTED`** | A document is blurry, expired, or incomplete. The applicant receives a secure link to upload the missing item. | The business applicant. |
| **`APPROVED`** | Documents check out. Approving the application automatically creates the actual **Merchant** record. | System creates the merchant and notifies Operations. |
| **`REJECTED`** | The business does not meet legal or risk requirements. | None (closed permanently with an audit note). |

## Track 2 — The Live Merchant Account (From Sandbox to Active)

Once the application is approved, the merchant record exists in our database, starting in **`PENDING_KYB`**. Here is how the account progresses:

```diagram
PENDING_KYB ──(final compliance sign-off + fees + routes)──> ACTIVE
                                                               │
                            ┌──────────────────────────────────┼──────────────────┐
                            ▼                                  ▼                  ▼
                        SUSPENDED                          FROZEN             TERMINATED
                 (new checkouts paused;             (checkouts AND payouts   (contract ended;
                  admin portal still readable)       paused during inquiry)   permanently closed)
```

### Why Sandbox keys work before Live keys
While a merchant is still setting up their website (`PENDING_KYB`), their developers can already use **Sandbox** API keys to run test payments against our built-in partner simulator. However, **Live** API keys cannot process real money until three things are in place:
1. Compliance gives final verification sign-off.
2. Finance sets up at least one **Fee Agreement** (`FeeConfig`) so the system knows what fee to charge.
3. Operations enables at least one **Payment Rail** (`MerchantMethod`) for the store.

### Understanding `SUSPENDED` vs. `FROZEN`
New operators often ask what the difference is between suspending and freezing a merchant:
- **`SUSPENDED` (Pause incoming sales):** Stops new customer checkouts immediately, but allows already-settled payouts and portal access to continue unless specified otherwise. Useful when a merchant's website is broken or their trade license needs a routine renewal upload.
- **`FROZEN` (Lock the vault door):** Stops **both** new checkouts **and** all outgoing payouts while Compliance or Risk investigates suspected fraud or a legal hold.

:::refs
- [[a:b04-01|Step-by-step guide to reviewing a Join Request and KYB file]]
- [[a:b04-02|What happens when you suspend, freeze, or terminate a merchant]]
- [[c:sg-join-requests|Screen card: Join Requests queue]]
- [[c:sg-merchants|Screen card: Merchants directory]]
:::
@@end
```

### 2.6 Direct Replacement: `b02-06` — *What is a payment rail, a provider, a route, and a collection mode*

```markdown
@@article
id: b02-06
book: b02
order: 6
title: What is a payment rail, a provider, a route, and a collection mode
summary: Four words you will hear every day—rail, provider, route, and collection mode—explained with a simple highway analogy.
minutes: 5
audience: all
related: b02-03, b06-01, b06-02, b06-07
@@body
:::summary Big picture in 20 seconds
Think of shipping a package: the **Rail** is what the customer chooses at checkout (*"Pay with Sadad"*), the **Provider** is the partner company we connect to (*"Al-Madar Gateway"*), the **Route** is the specific technical highway connecting us to that partner for that rail, and the **Collection Mode** is the shape of the customer's experience (*typing an SMS code, scanning a QR code, or redirecting to a bank page*).
:::

## Why these four words matter

In everyday conversation, people often mix up *"payment method"*, *"bank"*, and *"connection"*. Inside a payment gateway, mixing them up causes confusion because **one payment button can use two different partner companies**, and **one partner company can power three different payment buttons**.

Let's separate the four concepts using a travel analogy:

| System Term | Everyday Analogy | Who sees it? | Example in our platform |
|---|---|---|---|
| **1. Payment Rail** (`PaymentMethod`) | **The type of vehicle** the shopper chooses (*Bus, Train, or Ferry*) | **The Shopper & Merchant** on the checkout screen | `SADAD`, `MOBICASH`, `LOCAL_CARD`, `LYPAY` |
| **2. Provider** (`Provider`) | **The transport company** operating behind the scenes | **Operators & Engineers** (hidden from the shopper) | *Masarat*, *Moamalat*, *Tadawul*, *Internal Simulator* |
| **3. Route** (`GatewayRoute`) | **The specific highway lane** connecting a Rail to a Provider, with its own speed limit and health sign | **Core Routing Engine & Operators** | `MOBICASH via Masarat Primary (Priority 10, Limit 5,000 LYD)` |
| **4. Collection Mode** (`CollectionMode`) | **How the passenger boards** (*Show a paper ticket, tap a card, or scan a phone QR*) | **The Shopper** (determines what screen steps they follow) | `OTP_CHALLENGE`, `QR_DISPLAY`, `REDIRECT_3DS`, `USSD_PUSH` |

```diagram
Shopper sees:          Core picks the best lane:             Partner company:
+--------------+       +-------------------------------+     +------------------+
|  Rail:       | ----> | Route A (Priority 10, Healthy)| --> | Provider:        |
|  LOCAL_CARD  |       +-------------------------------+     | Moamalat Switch  |
+--------------+       | Route B (Priority 20, Backup) | --> +------------------+
                       +-------------------------------+     | Provider:        |
                                                             | Backup Acquirer  |
                                                             +------------------+
```

## Why separating Rail from Route saves the day during an outage

Suppose **Local Cards** (`LOCAL_CARD`) can be processed through two different partner switches: **Route A (Primary)** and **Route B (Backup)**.

- To the shopper and merchant, there is still just one button on the checkout screen: **Pay by Card**.
- If Route A starts timing out at 2:00 PM, our automatic circuit breaker marks Route A unhealthy and steers traffic onto **Route B**.
- Because the **Rail** (`LOCAL_CARD`) is separate from the **Route**, the merchant never has to change a single line of code on their website, and shoppers keep paying without noticing a hiccup.

## The nine Collection Modes at a glance

Even when two partners offer wallet payments, the steps the customer takes on their phone might differ. Rather than writing custom checkout code for every bank in the country, Core uses **nine standard Collection Modes** to tell the checkout screen what to show next:

1. **`OTP_CHALLENGE`** — Shopper enters their phone/account number, receives a one-time code by SMS, and types the code into our screen.
2. **`USSD_PUSH`** — We ask the partner to pop a confirmation prompt directly onto the shopper's phone screen; the shopper taps *Approve* on their handset.
3. **`QR_DISPLAY`** — Our checkout displays a QR code; the shopper opens their mobile banking app and scans it.
4. **`REDIRECT_3DS`** — Our checkout sends the shopper's browser to their bank's 3-D Secure page and brings them back when finished.
5. **`VOUCHER_CODE`** — The shopper types a pre-purchased voucher or scratch-card PIN.
6. **`IBAN_TRANSFER`** — The checkout shows a reference code and IBAN for a bank transfer.
7. **`POS_TERMINAL`** — Used when matching an in-person terminal transaction.
8. **`DIRECT_DEBIT`** — Used for pre-authorized recurring pulls.
9. **`HOSTED_FIELDS`** — Card or credential fields collected inside a locked iframe.

:::refs
- [[a:b06-01|Full catalog of all 9 Collection Modes and how each one flows]]
- [[a:b06-02|How providers, routes, and workflows fit together]]
- [[a:b06-07|How route priority, cost, and health scoring pick the winning lane]]
:::
@@end
```

### 2.7 Direct Replacement: `b02-07` — *Confirmation channels and how much each one is trusted*

```markdown
@@article
id: b02-07
book: b02
order: 7
title: Confirmation channels and how much each one is trusted
summary: How Core decides whether a "payment succeeded" message is strong enough to credit the merchant's balance.
minutes: 5
audience: all
related: b02-03, b02-04, b06-06, b09-01
@@body
:::summary Big picture in 20 seconds
Not all "Success!" messages are equally trustworthy. A shopper's browser coming back to a `?status=paid` URL can be faked in five seconds, whereas a cryptographically signed server-to-server call from a bank cannot. Core grades every confirmation channel by **trust level** and only writes money to the ledger when a **strong** channel confirms the charge.
:::

## The problem: Why we cannot just trust the shopper's browser

Imagine a store that hands out expensive laptops whenever a customer walks up to the pickup counter holding a sticky note that says *"I paid at the cashier."* Anyone with a pen and a pad of sticky notes could walk out with a free laptop.

On the internet, a **browser redirect** (where the customer's browser returns from a bank page to `https://merchant.ly/return?status=success`) is just like that sticky note. A clever user can type that URL into their browser address bar without paying a single dirham.

To protect merchants and our treasury, Core tracks **how** we learned about a payment outcome—called the **Confirmation Channel**—and separates **strong channels** (which can move a payment to `SUCCEEDED` and credit the ledger) from **weak channels** (which only move a payment to `WEAK_COMPLETED` until a strong channel backs them up).

## The seven confirmation channels, ranked from strongest to weakest

| Channel | How the message arrives | Trust Level | Can it credit the ledger (`SUCCEEDED`) on its own? |
|---|---|---|---|
| **1. `RECONCILIATION_FILE`** | The bank's official next-day settlement statement shows the money arrived in our account. | **Highest (Bank Statement)** | **Yes.** This is the ultimate proof of funds. |
| **2. `SYNC_API_RESPONSE`** | Core called the partner's server directly over a mutually encrypted connection and got a signed approval back immediately. | **High (Direct Server Call)** | **Yes.** |
| **3. `SIGNED_WEBHOOK`** | The partner's server sent an asynchronous callback to Edge with a verified cryptographic signature (`HMAC` or `mTLS`). | **High (Signed Server Callback)** | **Yes.** |
| **4. `ACTIVE_POLL`** | Our background status checker (`poller`) called the partner's inquiry endpoint and confirmed the transaction succeeded. | **High (Direct Server Inquiry)** | **Yes.** |
| **5. `OPERATOR_MANUAL_VERIFY`** | A human operator verified the transaction on the partner's official bank portal, uploaded evidence, and obtained four-eyes manager approval. | **Controlled Human Override** | **Yes (with mandatory evidence & audit trail).** |
| **6. `UNSIGNED_WEBHOOK`** | A callback arrived from an IP address without a cryptographic signature, or with a weak shared token. | **Low (Weak Signal)** | **No.** Moves attempt to `WEAK_COMPLETED` and triggers an immediate `ACTIVE_POLL` to verify. |
| **7. `BROWSER_REDIRECT`** | The shopper's web browser returned from the bank page claiming the payment succeeded. | **Lowest (Untrusted Client)** | **No.** Moves attempt to `WEAK_COMPLETED` while Core asks the bank server directly. |

```diagram
[Browser Redirect arrives claiming "Paid!"]
          │
          ▼
  State: WEAK_COMPLETED  (No ledger entry yet! Shopper sees "Confirming with your bank...")
          │
          ├──> Core triggers immediate ACTIVE_POLL / waits for SIGNED_WEBHOOK
          │
          ▼
[Partner server confirms "Yes, Tx #8821 is Paid"]
          │
          ▼
  State: SUCCEEDED       (Ledger entry posted! Merchant notified.)
```

## What to tell a merchant who sees `WEAK_COMPLETED`

If a merchant calls support saying, *"My customer showed me a screenshot of their browser return page, why is the order still `WEAK_COMPLETED`?"*, you now have a clear, reassuring answer:

- Explain that `WEAK_COMPLETED` means the customer finished their browser step, and our system is taking a few extra seconds to confirm the payment directly with the bank's server so the merchant is protected from spoofed browser links.
- In 99% of cases, the signed webhook or automatic poll upgrades `WEAK_COMPLETED` to `SUCCEEDED` within a few seconds. If the partner's webhook is delayed, our background poller checks the partner automatically.

:::refs
- [[a:b06-06|How partner responses and webhooks are verified]]
- [[a:b09-01|How next-day bank reconciliation works]]
- [[a:b10-01|Runbook RB-01: Investigating an unconfirmed payment]]
:::
@@end
```

---

## Part 3 — Direct Verbatim Replacements for the Highest-Friction Articles in Books 5, 6, 7, 8, and 9

Beyond Book 2, our audit identified the specific articles in Books 5, 6, 7, 8, and 9 where the prose abruptly drops into raw database column names, unexplained step-type enums, or numbered ledger entries without plain-language context. Below are the direct verbatim replacements for those key articles.

### 3.1 Direct Replacement: `b05-07` — *Seats, active sessions, and why we lock compromised accounts immediately*

```markdown
@@article
id: b05-07
book: b05
order: 7
title: Seats, active sessions, and how account lockouts work
summary: How the platform limits how many devices a staff member or merchant user can sign in from, and how to revoke access in one click.
minutes: 4
audience: all
related: b05-01, b05-03, b05-08
@@body
:::summary Big picture in 20 seconds
Every user account has a **seat limit** (how many browsers or phones can stay signed in at the same time) and an **instant emergency brake**. If an operator leaves their laptop unlocked at a café, a supervisor can revoke all their active sessions in one second without waiting for their login cookie to expire.
:::

## Why we track active sessions ("seats")

Imagine a building that issues plastic keycards. If an employee loses three keycards in a week and just keeps asking for new ones while the old cards still open the door, anyone who finds one of those lost cards can walk inside.

To prevent shared logins and stray open browsers, our platform tracks every active login session in two places:
- **In PostgreSQL** (the permanent record of who signed in, from which device and IP address, and whether the session is still allowed).
- **In Redis** (our high-speed memory cache, so Admin Back can check in less than a millisecond whether a session was just revoked).

## How seat limits work in plain words

Each identity record keeps track of how many active devices are signed in right now:

1. **Normal sign-in:** Most staff accounts allow a small number of simultaneous sessions (for example, your office desktop and your work phone).
2. **When you sign out:** Your session is marked ended immediately in both the database and Redis.
3. **When too many devices sign in or suspicious activity occurs:** If someone tries to open more simultaneous sessions than their role allows, or triggers repeated failed two-step verification checks, the system locks the extra session and alerts Security.

## What happens when you click "Revoke Sessions" or "Lock Operator"

When a security administrator clicks **Revoke All Sessions** or **Suspend Operator** in the portal:
1. Core immediately marks every open session for that user as revoked in PostgreSQL.
2. Core deletes the active session keys from Redis.
3. The very next time that user's browser clicks *any* button or refreshes a page—even one second later—Admin Back sees the session is gone and returns them to the sign-in screen.

:::do When a staff laptop or phone is lost
Do not just reset the password—always click **Revoke All Sessions** on the operator's profile as well. Resetting a password stops *future* sign-ins, whereas revoking sessions kicks out any browser that is *already* signed in.
:::

:::refs
- [[a:b05-01|How staff sign-in and two-step verification (MFA) work]]
- [[a:b05-08|How to read the Audit Log after a security action]]
- [[c:sg-operators|Screen card: Operators & Sessions management]]
:::
@@end
```

### 3.2 Direct Replacement: `b06-03` — *Workflow recipes: how Core talks to any bank without new code*

```markdown
@@article
id: b06-03
book: b06
order: 3
title: Workflow recipes: how Core talks to any bank without new code
summary: How our data-driven workflow engine runs multi-step bank calls using six simple building blocks instead of hardcoded partner scripts.
minutes: 6
audience: all
related: b06-01, b06-02, b06-04, b06-05
@@body
:::summary Big picture in 20 seconds
Every bank and mobile wallet has its own quirky sequence of API calls. Instead of writing custom TypeScript code every time we add a new bank, Core uses a **Workflow Recipe** (`WorkflowDefinition`) made of **six simple building blocks**—like LEGO bricks—stored in configuration.
:::

## The problem with hardcoding bank integrations

In traditional payment gateways, adding a new local wallet means a software engineer has to write hundreds of lines of custom code, test it, and redeploy the whole server. Worse, if the bank changes one field name six months later, you need another code deployment just to fix it.

In our platform, Core treats a bank integration like a **cooking recipe**. A recipe is just a numbered list of steps stored in the database. Each step uses one of **six standard actions**.

## The six building blocks of a workflow recipe

Think of how a human assistant would process a payment over the phone. They would calculate the total, fill out a form, call the bank, check the bank's answer, and decide what to show the customer. Our six step types do those exact six jobs:

| Step Type | Everyday Analogy | What it does inside Core | Example in a real payment |
|---|---|---|---|
| **1. `COMPUTE`** | **Jotting down a calculation** on a notepad | Formats a number, generates a timestamp, or computes a cryptographic signature (`HMAC` or hash) before calling the partner. | Convert `100 LYD` into `"100000"` dirhams and sign it with the partner's secret key. |
| **2. `HTTP`** | **Making the phone call** to the partner bank | Sends an outbound `POST` or `GET` request to the partner's URL using our transform template, and captures the partner's reply. | Call `POST /v2/mobicash/initiate` with the customer's phone number and amount. |
| **3. `ASSERT`** | **Checking that the reply makes sense** | Verifies a condition that *must* be true to continue (for example, checking that the partner returned a valid transaction reference). | Verify that `response.status == 200` and `response.txId` is not empty. |
| **4. `BRANCH`** | **A fork in the road** (*"If X, do A; otherwise do B"*) | Chooses the next step based on what the partner replied. | If the partner says `"OTP_SENT"`, go to the `RENDER` step; if `"INSUFFICIENT_FUNDS"`, fail immediately. |
| **5. `RENDER`** | **Showing a prompt on the customer's screen** | Tells the checkout UI what screen to show the shopper next based on the collection mode. | Tell the checkout screen: *"Show the 6-digit SMS code box (`OTP_CHALLENGE`)."* |
| **6. `WAIT`** | **Pausing until the customer or partner replies** | Safely parks the workflow in the database until the shopper submits their OTP code or the partner sends a webhook. | Pause at `PENDING_USER_ACTION` until the shopper submits the SMS code. |

## Following a real 4-step OTP recipe

Here is how those blocks snap together when Sara pays with a mobile wallet that requires an SMS code:

```diagram
[Phase 1: Initiate Charge]
  Step 1 (COMPUTE) ──> Build partner signature & timestamp
  Step 2 (HTTP)    ──> Call Partner "/initiate" endpoint
  Step 3 (BRANCH)  ──> Did partner send SMS?
                         ├── No  ──> Map error & stop (FAILED)
                         └── Yes ──> Step 4 (RENDER "Enter 6-digit SMS code")
                                     Step 5 (WAIT for shopper input)

[Phase 2: Confirm OTP]
  Step 6 (HTTP)    ──> Send shopper's OTP to Partner "/confirm"
  Step 7 (ASSERT)  ──> Confirm partner returned final receipt ID
  Done!            ──> Move payment to SUCCEEDED
```

## Why operators love workflow recipes

Because every step is recorded as structured data, when you open a payment attempt in the portal, you do not have to ask an engineer to read server code. You can see **which step number** ran, how many milliseconds the `HTTP` call took, and which `BRANCH` the payment followed.

:::refs
- [[a:b06-04|How request and response templates (transforms) reshape JSON fields]]
- [[a:b06-05|How partner secrets and PIN encryption work inside a workflow]]
- [[c:sg-workflows|Screen card: Workflows & Recipes viewer]]
:::
@@end
```

### 3.3 Direct Replacement: `b06-12` — *The visible-rails formula: why a customer does or does not see a payment method*

```markdown
@@article
id: b06-12
book: b06
order: 12
title: The visible-rails formula: why a customer does or does not see a payment method
summary: The five-gate checklist Core runs to decide which payment buttons appear on a customer's checkout screen—and how to troubleshoot a missing button in 30 seconds.
minutes: 5
audience: all
related: b02-03, b02-06, b06-07, b08-08
@@body
:::summary Big picture in 20 seconds
One of the most common merchant support questions is: *"Why isn't Sadad (or Local Card) showing up on my checkout page for a 250 LYD order?"* Core shows a payment button **only** when it passes **all five gates** below. If even one gate is closed, the button hides automatically so the shopper never clicks a dead end.
:::

## Try it live in the simulator

Before reading the five gates, you can toggle them on and off right here to see how the checkout screen reacts:

{{widget:visible-rails}}

## The Five Gates every payment method must pass

Think of a payment method (a **rail**, like `SADAD` or `LOCAL_CARD`) walking through five consecutive checkpoints before it is allowed onto the shopper's screen. If any checkpoint says **No**, that method stays backstage for this checkout:

```diagram
Gate 1: Is the Rail turned ON platform-wide?
   │ Yes
   ▼
Gate 2: Is the Rail enabled for THIS merchant?
   │ Yes
   ▼
Gate 3: Does the order amount fit the merchant's per-rail min/max limits?
   │ Yes
   ▼
Gate 4: Is there an active Fee Agreement covering this rail, currency, and amount?
   │ Yes
   ▼
Gate 5: Is there at least ONE healthy partner Route whose limits also fit this amount?
   │ Yes
   ▼
[SHOWN ON CHECKOUT SCREEN!]
```

### How to check each gate in 30 seconds when a merchant calls

| Gate | Question Core asks | Common reason it fails | Where to check in the portal |
|---|---|---|---|
| **Gate 1 — Platform Rail Switch** | Is this payment method active across the whole platform (`PaymentMethod.isActive`)? | Operations turned off the entire rail during a nationwide provider maintenance window. | **Routing & Rails → Payment Methods** |
| **Gate 2 — Merchant Rail Switch** | Has this specific merchant been approved and enabled for this rail (`MerchantMethod.isEnabled`)? | The merchant was just onboarded, and Operations enabled Cards but forgot to toggle on Sadad. | **Merchants → [Merchant] → Payment Methods tab** |
| **Gate 3 — Merchant Per-Rail Limits** | Does the checkout amount fall between the merchant's minimum and maximum allowed ticket size for this rail? | The shopper is trying to pay **2,500 LYD**, but the merchant's Sadad limit is capped at **1,000 LYD** per transaction. | **Merchants → [Merchant] → Payment Methods tab** |
| **Gate 4 — Active Fee Agreement** | Is there an active, non-expired `FeeConfig` row for this merchant, rail, and currency whose amount brackets cover this order? | Finance set up a fee tier for `1–500 LYD`, and the shopper's cart is `650 LYD` (falling outside the fee bracket). | **Merchants → [Merchant] → Fee Configs tab** |
| **Gate 5 — Healthy Partner Route** | Is there at least one active `GatewayRoute` for this rail whose circuit breaker is **healthy** (`CLOSED`) and whose partner min/max limits fit this amount? | The primary partner route tripped its circuit breaker after repeated timeouts, and no backup route is configured. | **Routing & Rails → Routes & Circuit Breakers** |

:::tip Why hiding a rail is better than showing an error after the click
If we showed the **MobiCash** button when no fee was configured or when the MobiCash bank route was down, the shopper would type their phone number, click Pay, and hit an ugly failure message. By checking all five gates *before* rendering the checkout, the shopper only sees buttons that can actually complete their purchase right now.
:::

:::refs
- [[a:b06-07|How Core picks the best route when two healthy routes pass Gate 5]]
- [[a:b08-08|How fee brackets and fee snapshots work]]
- [[c:sg-routing-rules|Screen card: Routing Rules & Visible Rails inspector]]
:::
@@end
```

### 3.4 Direct Replacement: `b08-04` — *The twelve canonical ledger entries, with real numbers*

```markdown
@@article
id: b08-04
book: b08
order: 4
title: The twelve standard ledger entries, with real numbers
summary: Every way money can move in our platform—from a 100 LYD sale to a settlement, payout, refund, or dispute—shown with simple 100 LYD examples.
minutes: 8
audience: all
related: b08-01, b08-02, b08-03, b08-09
@@body
:::summary Big picture in 20 seconds
No human and no piece of code can invent a custom ledger entry on the fly. Every financial movement in the entire platform uses one of **12 standard accounting templates**. Below, we walk through the main ones using the exact same **100 LYD sale (with a 2 LYD fee)** so you can trace every dirham from start to finish.
:::

## How to read the examples below

To keep the math effortless, every example below uses **Sara's 100 LYD purchase at Noon Mart**, where our gateway fee is **2 LYD** and Noon Mart's net share is **98 LYD**.

Remember the four core accounts you will see most often:
- **`1100` Gateway Clearing (Asset):** Money the bank partner has collected from shoppers and owes to us.
- **`1010` Treasury Bank (Asset):** Real cash sitting in our platform's bank account.
- **`2110` Merchant Pending (Liability):** Money we owe Noon Mart *after* the bank partner settles with us.
- **`2120` Merchant Available (Liability):** Settled money Noon Mart can withdraw right now.
- **`4100` Fee Revenue (Revenue):** Our 2 LYD service fee.

{{widget:ledger-explorer}}

---

## Group A — Everyday Sales, Settlement, and Payouts (Entries 1 to 4)

### Entry 1: Shopper's payment succeeds (`SUCCEEDED`)
*When it happens:* The moment Sara's 100 LYD payment is confirmed over a trusted channel.

| Account | Direction | Amount | Plain-language meaning |
|---|---|---|---|
| `1100` Gateway Clearing | **Debit** (increases what partner owes us) | **100 LYD** | The partner bank now holds 100 LYD for us. |
| `2110` Merchant Pending | **Credit** (increases what we owe Noon Mart later) | **98 LYD** | Noon Mart will get 98 LYD once the partner bank settles. |
| `4100` Fee Revenue | **Credit** (increases our earned fee) | **2 LYD** | We earned our 2 LYD gateway fee. |

### Entry 2: Partner bank settles the cash into our Treasury the next morning
*When it happens:* The bank partner wires yesterday's batch into our Treasury bank account, and reconciliation matches Sara's transaction. Two things happen together: cash moves from Clearing (`1100`) to Treasury (`1010`), and Noon Mart's 98 LYD moves from Pending (`2110`) to Available (`2120`).

| Account | Direction | Amount | Plain-language meaning |
|---|---|---|---|
| `1010` Treasury Bank | **Debit** (cash in our bank goes up) | **100 LYD** | The 100 LYD is now real cash in our Treasury account. |
| `1100` Gateway Clearing | **Credit** (partner no longer owes us) | **100 LYD** | We clear the partner's IOUs for this transaction. |
| `2110` Merchant Pending | **Debit** (pending promise goes down) | **98 LYD** | Noon Mart's 98 LYD is no longer waiting on the bank. |
| `2120` Merchant Available | **Credit** (withdrawable balance goes up) | **98 LYD** | Noon Mart can now withdraw their 98 LYD. |

### Entry 3: We lock funds when Noon Mart requests a payout
*When it happens:* Noon Mart requests a 98 LYD payout to their business bank account. Before sending the wire, we move the 98 LYD out of `Available` into `Payout Reserve (`2130`)` so they cannot accidentally withdraw the same 98 LYD twice while the bank wire is in flight.

| Account | Direction | Amount | Plain-language meaning |
|---|---|---|---|
| `2120` Merchant Available | **Debit** (reduces withdrawable balance) | **98 LYD** | Takes 98 LYD out of Noon Mart's spendable balance. |
| `2130` Payout Reserve | **Credit** (holds funds for in-flight wire) | **98 LYD** | Holds the 98 LYD safely while the bank transfer runs. |

### Entry 4: The payout wire to Noon Mart completes
*When it happens:* Our bank confirms the 98 LYD wire reached Noon Mart's bank account. (If the wire fails at the bank instead, **Entry 4b** simply moves the 98 LYD from `2130` Payout Reserve right back to `2120` Merchant Available!)

| Account | Direction | Amount | Plain-language meaning |
|---|---|---|---|
| `2130` Payout Reserve | **Debit** (clears the in-flight hold) | **98 LYD** | We no longer owe Noon Mart this 98 LYD—it is paid. |
| `1010` Treasury Bank | **Credit** (cash leaves our Treasury) | **98 LYD** | 98 LYD of cash left our Treasury bank account. |

---

## Group B — Refunds, Disputes, and Rolling Reserves (Entries 5 to 12)

What if Sara returns the jacket for a refund, or opens a dispute? Here is how the remaining standard entries handle every exception cleanly:

| Entry # | Event | What moves in plain words |
|---|---|---|
| **Entry 5 — Refund before partner settlement** | Noon Mart refunds Sara on the same day *before* the partner bank has settled the batch. | Pulls 98 LYD back from `2110` Merchant Pending (and 2 LYD from `4100` Fee Revenue if fees are refunded) and reduces `1100` Gateway Clearing by 100 LYD. |
| **Entry 6 — Refund after partner settlement** | Noon Mart refunds Sara three days later, *after* the 98 LYD is already in Noon Mart's `2120` Available balance. | Deducts from `2120` Merchant Available and sends the refund back through the partner clearing account. |
| **Entry 7 — Holding a Rolling Reserve** | Risk policy holds 10% of Noon Mart's sales for 30 days as a safety cushion (`2140` Rolling Reserve). | Moves `9.80 LYD` from `2120` Merchant Available into `2140` Rolling Reserve until the 30-day release date. |
| **Entry 8 — Releasing a Rolling Reserve** | The 30-day hold period finishes with no issues. | Moves the `9.80 LYD` from `2140` Rolling Reserve right back into `2120` Merchant Available. |
| **Entry 9 — Opening a Dispute Hold** | A customer's bank opens a formal chargeback inquiry on a 100 LYD payment. | Freezes the disputed amount out of the merchant's balance into `2150` Dispute Reserve while the case is reviewed. |
| **Entry 10 — Dispute Won or Lost** | If the merchant **wins** the dispute, the frozen funds return to `2120` Merchant Available. If the merchant **loses**, the frozen funds clear out against the partner's chargeback deduction. | Resolves `2150` Dispute Reserve either back to the merchant (win) or back to the partner bank (loss). |
| **Entry 11 — Suspense Account (`1900` / `2900`)** | The bank statement shows an unexpected credit or debit that does not match any known payment attempt yet. | Parks the mystery item in **Suspense** so our daily books still balance to the dirham while Reconciliation investigates and matches it. |
| **Entry 12 — Manual Finance Adjustment** | A rare, four-eyes approved accounting correction (for example, recording a bank wire fee or resolving a suspense item). | Moves funds between the specified accounts with two manager signatures and an attached evidence file. |

:::refs
- [[a:b08-01|Why double-entry bookkeeping makes lost money impossible]]
- [[a:b08-02|Complete directory of our 10 General Ledger accounts]]
- [[a:b08-09|Detailed walk-through of refunds, disputes, and reserve holds]]
- [[c:sg-ledger|Screen card: Ledger & Journal Entries explorer]]
:::
@@end
```

---

## Part 4 — Direct Verbatim Academy Lesson Replacements (`academy_system_design_and_content.md`)

In `design/07-guides-and-academy/academy_system_design_and_content.md`, modules `m1` through `m10` currently use ultra-compressed, 1-line bullet fragments under `### Key ideas` and `### A worked example`.

Below are direct replacements for the core foundational lessons (`l-m1-1`, `l-m1-2`, `l-m1-3`, `l-m2-1`, `l-m2-2`, `l-m2-3`, `l-m2-4`, `l-m4-1`, `l-m4-2`, `l-m5-1`, `l-m6-1`) plus an automated upgrade script in **Part 5** that upgrades all 45 lessons while preserving 100% of the structural headers (`### You will be able to`, `### Key ideas`, `### A worked example`, `### Common mistakes`, `### Read now`, `### Check yourself`) and quiz question IDs required by `extract-academy-content.ts` and `companion-app/scripts/build-bundle.ts`.

### 4.1 Direct Replacements for Module 1 (`l-m1-1`, `l-m1-2`, `l-m1-3`) & Module 2 (`l-m2-1` to `l-m2-4`)

```markdown
@@lesson
id: l-m1-1
module: m1
order: 1
title: Why a payment gateway exists
minutes: 10
articles: b01-01, b01-02, b01-03
cards: sg-overview
@@body
### You will be able to
- Explain in everyday words why a store uses one payment gateway instead of connecting to ten banks one by one.
- Name the four groups of people involved in every payment (the customer, the merchant, the payment partners, and our platform).
- Explain the golden rule that separates **promising** money (authorization) from **moving** real cash (settlement).

### Key ideas
- **When you pay with paper cash in a bakery, two things happen at once:** the baker knows the money is real, and the paper bills are already in their hand. With digital money, those two events are separated by hours or days.
- **Step 1 is Authorization (the promise):** When a customer clicks *Pay*, their bank or mobile wallet checks their balance, locks the amount, and sends back a digital promise saying *"Yes, this money is reserved for you."* That happens in a few seconds.
- **Step 2 is Settlement (the actual bank transfer):** At the end of the business day or the next morning, the bank partner transfers the collected batch of real money into our treasury account and sends an official statement list.
- **Why merchants need us in the middle:** Without a payment gateway, an online store in Libya would have to sign separate technical contracts, build separate security systems, and reconcile separate spreadsheets for local cards, Sadad, MobiCash, and LyPay. Our platform gives the merchant **one clean checkout integration** and **one unified ledger**, while we handle all the bank dialects behind the scenes.

### A worked example
Imagine **Noon Mart**, an online clothing store selling a **100 LYD** jacket to a customer named **Sara**:
1. **At 2:15 PM (Authorization):** Sara pays 100 LYD using MobiCash on Noon Mart's checkout. Within three seconds, MobiCash confirms the charge. Our platform marks the payment **`SUCCEEDED`** and adds **98 LYD** (after our 2 LYD fee) to Noon Mart's **Pending** balance so Noon Mart can safely pack and ship Sara's jacket.
2. **At 9:00 AM the next morning (Settlement):** MobiCash transfers yesterday's collected money to our Treasury bank account and sends their daily settlement file. Our reconciliation job matches Sara's 100 LYD payment and moves Noon Mart's **98 LYD** from **Pending** to **Available**, ready to be paid out to Noon Mart's bank account.

### Common mistakes
- **Confusing a "Succeeded" checkout with settled cash in the bank:** A `SUCCEEDED` payment means the partner bank confirmed the charge and owes us the funds (`Gateway Clearing`), so the merchant's *Pending* balance goes up. However, the merchant cannot withdraw that money until the partner bank actually settles the funds (`Available` balance).
- **Guessing when a network connection drops:** If our internet line to a bank partner goes silent right after we ask them to charge Sara, we never guess whether it worked or failed—we mark the attempt **`UNKNOWN`** and ask the bank directly.

### Read now
- [[a:b01-01|Why money on the internet is harder than handing over cash]]
- [[a:b01-02|What a payment gateway actually does]]
- [[a:b01-03|The four players in every payment]]

### Check yourself
@@quiz
id: q-m1-1-1
kind: single
prompt: When a customer's 100 LYD payment is approved at 2:15 PM, what has actually happened at that exact moment?
* The partner bank or wallet has reserved the funds and given us a confirmed promise to pay, while the actual bank-to-bank cash settlement happens later.
- 100 LYD of physical cash has already arrived in the merchant's commercial bank account.
- No record is written in our ledger until the end of the month.
- The customer can no longer ever ask for a refund.
explain: At checkout time, authorization reserves the funds and gives us a trusted confirmation (which we record in Gateway Clearing and Merchant Pending). Actual bank settlement arrives in the daily settlement cycle.
@@endquiz

@@quiz
id: q-m1-1-2
kind: single
prompt: Why does a merchant integrate with our payment gateway instead of connecting directly to each bank and wallet provider on their own?
* They write one integration with us and get access to multiple payment rails, unified security, automatic failover, and one consolidated accounting ledger.
- Because banks are legally forbidden from having APIs.
- Because a payment gateway eliminates all transaction fees.
- Because the gateway lets the merchant skip business verification (KYB).
explain: A gateway abstracts away each provider's different protocols, encryption rules, error codes, and settlement files behind one reliable API and portal.
@@endquiz
@@end

@@lesson
id: l-m2-1
module: m2
order: 1
title: Services and the life of a payment
minutes: 15
articles: b02-01, b02-02, b02-03, b02-06
cards: sg-payment-attempts
@@body
### You will be able to
- Draw the path of a payment request across **Edge**, **Core**, and **Admin Back**, and state what each service is responsible for.
- Distinguish between a **Payment Rail**, a **Provider**, a **Route**, and a **Collection Mode**.
- Trace the ten steps of a payment from checkout creation to final ledger settlement.

### Key ideas
- **Three core runtime services, three clear boundaries:**
  - **Edge** is the public front door for merchant API calls and partner webhooks. It verifies signatures and rate limits, then forwards signed internal calls to Core. It never touches PostgreSQL or the ledger.
  - **Admin Back** is the staff operations server behind the operator browser portal (`Admin Front`). It handles operator login, MFA, role permissions, and four-eyes approvals before calling Core.
  - **Core** is the private brain and vault. Only Core talks to PostgreSQL, calculates fees, picks bank routes, calls external providers, and writes ledger entries.
- **Four everyday routing terms you should never mix up:**
  - **Payment Rail (`PaymentMethod`):** The button the customer chooses on screen (such as `SADAD`, `MOBICASH`, or `LOCAL_CARD`).
  - **Provider (`Provider`):** The external company or bank switch behind the scenes (such as *Moamalat* or *Masarat*).
  - **Route (`GatewayRoute`):** The specific highway lane connecting a Rail to a Provider, with its own priority, cost, and health status.
  - **Collection Mode (`CollectionMode`):** How the shopper completes the challenge on screen (such as typing an SMS code in `OTP_CHALLENGE` or scanning a code in `QR_DISPLAY`).
- **One Trace ID (`traceId`) connects the whole story:** Created at the very first doorway (Edge or Admin Back), the `traceId` is stamped onto every log line, partner call, and audit entry.

### A worked example
Suppose **Sara** clicks *Pay 100 LYD* at **Noon Mart**:
1. Noon Mart calls **Edge** (`POST /api/v1/payments/initiate`). Edge checks Noon Mart's HMAC signature and creates `traceId: tr_8841`.
2. Edge forwards the verified request to **Core**. Core checks which **Rails** pass the five visibility gates for Noon Mart and opens a Payment Attempt in state **`CREATED`**.
3. Sara selects **MobiCash**. Core locks the attempt (`LOCKED`), picks the healthiest MobiCash **Route**, snapshots the 2 LYD fee, and moves to **`AUTHORIZING`**.
4. Because this route uses the **`OTP_CHALLENGE`** collection mode, the workflow sends Sara an SMS code and waits in **`PENDING_USER_ACTION`**.
5. Sara enters the code, the partner confirms approval, Core moves the attempt to **`SUCCEEDED`**, and Core posts the balanced 100 LYD journal entry in the ledger.

### Common mistakes
- **Looking in Edge logs for a routing or fee calculation decision:** Edge only validates the front door; all routing, fee, and state decisions happen inside **Core**.
- **Saying "the MobiCash provider" when you mean "the MobiCash rail":** Remember that one **Rail** (what the customer clicks) can be carried by more than one **Provider** via primary and backup **Routes**.

### Read now
- [[a:b02-01|The platform on one page]]
- [[a:b02-02|The three services: Edge, Admin, and Core]]
- [[a:b02-03|The life of a payment, step by step]]
- [[a:b02-06|What is a payment rail, a provider, a route, and a collection mode]]

### Check yourself
@@quiz
id: q-m2-1-1
kind: single
prompt: Which service is the ONLY one allowed to write to the PostgreSQL database, post ledger entries, and talk to external banking partners?
* Core (`core-back`)
- Edge (`edge`)
- Admin Back (`admin-back`)
- Admin Front (`admin-front`)
explain: Core is the sole owner of PostgreSQL, the double-entry ledger, and outbound provider connections. Edge and Admin Back must call Core over signed internal endpoints.
@@endquiz

@@quiz
id: q-m2-1-2
kind: single
prompt: A shopper sees "Pay with Local Card" on the checkout screen, and when they click it, the system sends the transaction through Moamalat Switch using a 3-D Secure browser redirect. How do our four routing terms map to this scenario?
* "Local Card" is the Rail, "Moamalat Switch" is the Provider, the connection between them is the Route, and "REDIRECT_3DS" is the Collection Mode.
- "Local Card" is the Provider, "Moamalat Switch" is the Rail, and "REDIRECT_3DS" is the Route.
- All four terms mean the exact same thing and are interchangeable.
- "REDIRECT_3DS" is the Provider and "Local Card" is the Collection Mode.
explain: The Rail is the payment method shown to the customer, the Provider is the partner company, the Route links the Rail to the Provider, and the Collection Mode defines the user interaction flow.
@@endquiz
@@end
```

---

## Part 5 — Automated Clarity & Reference-Cleansing Script for All 94 Articles & 45 Lessons

To ensure OpenCode does not have to manually edit 94 articles and 45 lessons by hand—and to guarantee zero broken cross-references or failed completeness tests—create and run `scripts/overhaul-guide-and-academy-clarity.ts`.

### What This Script Does Automatically Across the Entire Repository

1. **Applies all verbatim article replacements** for Book 2 (`b02-01`–`b02-07`) and key high-friction articles (`b05-07`, `b06-03`, `b06-12`, `b08-04`, etc.).
2. **Sweeps all 94 articles in `guide_system_design_and_content.md` and all 45 lessons in `academy_system_design_and_content.md`** for any remaining mid-sentence parenthetical reference clutter:
   - Converts `(see [[a:b06-12]])`, `([[a:b02-04]])`, `([[c:sg-payment-attempts]])`, and multi-link parentheticals `([[a:b06-05]], [[a:b06-07]])` out of the middle of sentences and appends them as a clean, deduplicated `:::refs` block at the bottom of that section.
   - Replaces awkward unlabelled inline `[[a:ID]]` tokens that appear mid-sentence (like `"as explained in [[a:b06-12]]"`) with natural, human-readable anchor labels (`[[a:b06-12|the visible-rails guide]]`) so no 14-word article title is ever injected mid-sentence again!
3. **Re-runs the dual-target content compilers and test suites** (`bun run content:guide`, `bun run content:academy`, `cd companion-app && bun run content:sync && bun run content:check && bun run test`) to verify 100% schema and test compliance.

### Step-by-Step Execution Commands for OpenCode

```bash
# 1. Update companion-app/src/lib/markdown.ts and companion-app/src/components/MarkdownView.vue
#    with the drop-in implementations from Part 1.2 and Part 1.3 above.

# 2. Update admin-front/src/components/guide/MarkdownView.tsx to use the same
#    extractParentheticalRefs() pre-pass and CALLOUT_TYPES ("summary", "refs").

# 3. Apply the direct article and lesson replacements in:
#    - design/07-guides-and-academy/guide_system_design_and_content.md
#    - design/07-guides-and-academy/academy_system_design_and_content.md

# 4. Regenerate compiled content bundles for both Admin Portal and PG Companion App:
cd admin-front
bun run content:guide
bun run content:academy
bun test src/content/__tests__/content-completeness.test.ts

cd ../companion-app
bun run content:sync
bun run content:check
bun run test
```


---

## Part 6 — Additional Verbatim Replacements Across Books 4, 6, 7, 8, 9, 10 & Academy Modules 3–10

Below are the remaining high-impact verbatim replacements for the articles and lessons that previously suffered from heavy mid-sentence parenthetical references or overly compressed technical shorthand, followed by the full source code for `scripts/overhaul-guide-and-academy-clarity.ts`.

### 6.1 Direct Replacement: `b04-03` — *Signing requests: how we know a call really came from the merchant*

```markdown
@@article
id: b04-03
book: b04
order: 3
title: Signing requests: how we know a call really came from the merchant
summary: How a merchant proves every API request is genuine, untampered, and sent right now—explained without heavy math.
minutes: 5
audience: all
related: b01-09, b04-04, b04-05
@@body
:::summary Big picture in 20 seconds
An API key ID tells us **who** is knocking at the door, and a cryptographic signature (`HMAC-SHA256`) proves **the message was not changed on the way** and **was sent within the last few minutes**. Even if an attacker intercepts a valid payment call, they cannot change the amount or replay it later.
:::

## Why an API key alone is never enough

Imagine sending a paper cheque through the mail with your account number printed at the bottom, but **no signature** and **no date**. Anyone who opens the envelope could erase "100 LYD", write "10,000 LYD", or photocopy the cheque and cash it five times.

On the internet, sending a plain API key header without a request signature has the exact same weakness. Instead, our merchants never send their secret key over the internet. They keep their secret key locked inside their own server and use it to stamp a **one-time digital wax seal** onto each request.

{{widget:crypto-lab}}

## The four ingredients of every signed merchant call

When a merchant's server calls **Edge** (`POST /api/v1/payments/initiate`), it attaches four small headers alongside the JSON body:

| Header | Everyday Analogy | Why Edge checks it |
|---|---|---|
| **`X-Key-Id`** | The account number printed on the envelope | Tells Edge which merchant API key record to look up (for example, `mk_live_noonmart_01`). |
| **`X-Timestamp`** | The date and time stamped on the letter | Must be within **5 minutes** of our server's clock. Stops an attacker from saving an old request and re-sending it hours later. |
| **`X-Nonce`** | A unique serial number used only once | Stored in Redis for the duration of the timestamp window. Stops an attacker from re-sending the exact same request twice within the same second. |
| **`X-Signature`** | The wax seal pressed over the entire letter | Calculated over the HTTP method, path, timestamp, nonce, and exact request body using the merchant's secret key. |

```diagram
Merchant joins 5 pieces together:
  [Method: POST] + [Path: /api/v1/payments/initiate] + [Timestamp] + [Nonce] + [JSON Body]
          │
          ▼  (Sealed with Merchant Secret Key via HMAC-SHA256)
  X-Signature: "8f3c9a..."  ──(Sent to Edge)──>  Edge recomputes the exact same seal.
                                                  • Match?    ──> Forward to Core!
                                                  • Mismatch? ──> Reject (401 Invalid Signature)
```

## Troubleshooting the three most common merchant signature errors

When a merchant developer contacts support saying *"My API calls are getting rejected with 401"*, check these three things in order:

1. **Clock drift (`TIMESTAMP_EXPIRED`):** The merchant's server clock is more than 5 minutes fast or slow. Ask them to turn on standard network time synchronization (`NTP`) on their server.
2. **Formatting changes after signing (`INVALID_SIGNATURE`):** The merchant signed the JSON string, and then their HTTP library reformatted the spaces or reordered the keys before sending. Remind them to sign the **exact raw byte string** they put on the wire.
3. **Mixing up Sandbox and Live keys (`KEY_ENVIRONMENT_MISMATCH`):** The developer is sending a `mk_test_...` key to the live production URL, or using an old rotated secret that has already expired.

:::refs
- [[a:b01-09|Plain-language introduction to hashes, signatures, and encryption]]
- [[a:b04-04|How merchants rotate API keys with zero downtime]]
- [[a:b04-05|How idempotency keys work alongside request signatures]]
:::
@@end
```

### 6.2 Direct Replacement: `b06-07` — *How the router picks a winner: priority, cost, health, and limits*

```markdown
@@article
id: b06-07
book: b06
order: 7
title: How the router picks a winner: priority, cost, health, and limits
summary: When two partner routes can both carry a payment, here is how Core chooses the winning lane—and how it switches lanes automatically during an outage.
minutes: 5
audience: all
related: b02-06, b06-08, b06-12
@@body
:::summary Big picture in 20 seconds
Suppose a shopper clicks **Local Card** for a 200 LYD purchase, and we have **two** card partner connections (Route A and Route B). Core first throws out any route that is unhealthy or outside its amount limits, and then picks the winner by checking **Merchant Override → Priority Number → Lowest Partner Cost**.
:::

## Step 1: Filter out routes that cannot carry this payment right now

Before comparing two routes, Core removes any route that fails basic safety checks:
- **Is the route turned on?** (`isActive = true`)
- **Does the amount fit?** (A 200 LYD checkout cannot use a route capped at 100 LYD.)
- **Is the circuit breaker healthy?** If a partner connection has been timing out or returning server errors, its circuit breaker opens (`OPEN`) so we stop sending customers into a broken lane.

## Step 2: Rank the healthy survivors

If two or more healthy routes remain for that payment rail, Core ranks them using three simple tie-breakers:

```diagram
[Healthy Candidate Routes for LOCAL_CARD]
          │
          ▼
1. Does this Merchant have a pinned/preferred route rule?
   ├── Yes ──> Use the merchant's pinned route!
   └── No
        │
        ▼
2. Pick the route with the lowest Priority number (Priority 10 beats Priority 20)
        │
        ▼
3. Still tied? Pick the route with the lowest partner cost / healthiest recent success rate
```

| Tie-Breaker | How it works | Real-world example |
|---|---|---|
| **1. Merchant Routing Rule** | Operations can pin a specific merchant (or transaction size) to a dedicated route. | A large supermarket chain has a negotiated direct acquirer route (`Priority 1`). |
| **2. Route Priority (`1` = highest)** | Every route has a priority number (`10`, `20`, `30`). Lower numbers go first. | **Route A (Moamalat Primary)** is set to `Priority 10`; **Route B (Backup Switch)** is set to `Priority 20`. Under normal conditions, 100% of traffic uses Route A. |
| **3. Partner Cost & Health Score** | If two routes share the exact same priority number (`10` and `10`), Core prefers the route with the lower partner fee or higher live success rate. | Used when load-balancing across two equal partner connections. |

## What happens if the primary route stumbles mid-day?

Suppose **Route A (`Priority 10`)** starts timing out at 1:00 PM because the partner bank's fiber line is down:
1. After a small threshold of consecutive network/server failures, Core's **Circuit Breaker** trips Route A from `CLOSED` (healthy) to `OPEN` (paused for cooldown).
2. On the very next customer checkout one millisecond later, Route A is filtered out in Step 1, and **Route B (`Priority 20`)** automatically wins Step 2.
3. After the cooldown timer expires, Core lets one test transaction through (`HALF_OPEN`). If it succeeds, Route A returns to normal duty automatically.

:::refs
- [[a:b06-08|How circuit breakers (`CLOSED`, `OPEN`, `HALF_OPEN`) protect checkout traffic]]
- [[a:b06-12|The five gates of the visible-rails formula]]
- [[c:sg-gateway-routes|Screen card: Gateway Routes & Priority configuration]]
:::
@@end
```

### 6.3 Direct Replacement: `b06-11` — *Why a network timeout goes to UNKNOWN, never FAILED*

```markdown
@@article
id: b06-11
book: b06
order: 11
title: Why a network timeout goes to UNKNOWN, never FAILED
summary: The most important safety rule in payment engineering: why silence from a bank is never treated as a decline, and how our poller resolves the mystery safely.
minutes: 5
audience: all
related: b02-04, b02-07, b10-01
@@body
:::summary Big picture in 20 seconds
When you ask a bank to charge a customer and the internet connection drops before the bank answers, **two completely different things** might have happened: either the bank never got your message, **or** the bank charged the customer and the connection broke while sending the receipt back. Because guessing wrong would double-charge the customer, our platform **always** parks a post-send timeout in **`UNKNOWN`** until we verify the truth with the bank.
:::

## The two-generals problem in everyday life

Imagine you are ordering a 100 LYD cake over the phone, and right after you read out your payment confirmation code, your phone battery dies:
- Did the bakery hear your code and charge your wallet?
- Or did the phone cut out a second before you spoke?

If you immediately grab a friend's phone and place a **second** order without checking whether the first one went through, you might end up paying **200 LYD for two cakes**.

```diagram
Core sends "Charge Sara 100 LYD" ──> [Partner Bank Charges Sara 100 LYD!]
                                              │
                     ✗  Connection drops!  <──┘ (Receipt lost on the wire)
                     │
                     ▼
   WRONG SYSTEM: Marks attempt FAILED ──> Sara clicks Pay again ──> CHARGED TWICE (200 LYD)!
   OUR PLATFORM: Marks attempt UNKNOWN ──> Poller asks Partner "Did Tx #9042 go through?"
                                              └── Partner says "Yes, Paid!" ──> Moves to SUCCEEDED!
```

## When a network error CAN fail immediately vs. when it MUST go to `UNKNOWN`

Core distinguishes between a failure *before* the charge left the station and silence *after* the charge was sent:

| Moment the error happened | Could the partner have deducted the shopper's money? | State Core assigns | Why |
|---|---|---|---|
| **Before the charge step** (for example, template validation failed or the circuit breaker blocked the call before opening a socket) | **No.** We never sent the charge instruction to the partner. | **`FAILED`** | Safe for the shopper to try again right away. |
| **During or after the charge / confirm HTTP step** (socket timeout, connection reset, `502 Bad Gateway`, `504 Gateway Timeout`, or unparseable partner reply) | **Maybe Yes.** The partner server may have processed the debit right before the connection broke. | **`UNKNOWN`** | **Protects the shopper from double charges.** Triggers background status polling. |

## How a payment leaves `UNKNOWN`

Once an attempt enters `UNKNOWN`, three safeguards work to resolve it:
1. **Automatic Background Poller (`ACTIVE_POLL`):** Core's background worker queries the partner's transaction-status API on a smart backoff schedule (after a few seconds, then a minute, then several minutes).
2. **Late-Arriving Partner Webhook (`SIGNED_WEBHOOK`):** Often the partner bank recovers a minute later and delivers the signed webhook callback, which cleanly transitions `UNKNOWN` to `SUCCEEDED` or `FAILED`.
3. **Next-Day Bank Statement (`RECONCILIATION_FILE`) or Operator Runbook (`RB-01`):** If the partner's status API is also down, the nightly bank statement (or an operator checking the partner portal under four-eyes verification) closes the loop.

:::refs
- [[a:b02-04|Review all 14 payment states]]
- [[a:b10-01|Runbook RB-01: Step-by-step instructions when a payment stays in UNKNOWN]]
- [[s:sit-unknown-spike|Playbook: What to do when many payments enter UNKNOWN at once]]
:::
@@end
```

### 6.4 Complete Automated Clarity & Reference-Upgrader Script (`scripts/overhaul-guide-and-academy-clarity.ts`)

Save the script below as `scripts/overhaul-guide-and-academy-clarity.ts` at the root of the repository and run it with `bun run scripts/overhaul-guide-and-academy-clarity.ts`.

It performs three deterministic passes across `design/07-guides-and-academy/guide_system_design_and_content.md` and `design/07-guides-and-academy/academy_system_design_and_content.md`:
1. **Pass 1 (Verbatim Article & Lesson Replacements):** Replaces `b02-01` through `b02-07`, `b04-03`, `b05-07`, `b06-03`, `b06-07`, `b06-11`, `b06-12`, `b08-04`, and the foundational Academy lessons with the warm, story-driven versions above.
2. **Pass 2 (Global Parenthetical Reference Sweep across all 94 Articles & 45 Lessons):** Scans every remaining article and lesson for mid-sentence parenthetical references like `([[a:b06-12]])`, `(see [[a:b02-06]])`, `([[a:b06-05]], [[a:b06-07]])`, or `([[c:sg-payment-attempts]])`, removes them from the middle of sentences so the prose flows naturally, and groups them into a clean `:::refs` footer block at the end of the section.
3. **Pass 3 (Short Natural Labels for Inline Links):** Wherever an unlabelled `[[a:ID]]` or `[[c:ID]]` link remains inline inside a sentence (such as `"see [[a:b06-12]]"`), attaches a concise, natural 3–5 word human label (`[[a:b06-12|the visible-rails guide]]`) so the 14-word formal article title is never dumped mid-sentence.

```typescript
// File: scripts/overhaul-guide-and-academy-clarity.ts
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const GUIDE_PATH = resolve(
    ROOT,
    "design/07-guides-and-academy/guide_system_design_and_content.md",
);
const ACADEMY_PATH = resolve(
    ROOT,
    "design/07-guides-and-academy/academy_system_design_and_content.md",
);

/**
 * Builds a lookup table of short, conversational link labels for every article
 * and screen card so inline references never dump a 14-word title mid-sentence.
 */
function buildShortTitleMap(guideRaw: string): Map<string, string> {
    const map = new Map<string, string>();
    const articleRegex = /@@article\s*\n([\s\S]*?)@@body/g;
    let match: RegExpExecArray | null;
    while ((match = articleRegex.exec(guideRaw)) !== null) {
        const header = match[1]!;
        const id = /^id:\s*(.+)$/m.exec(header)?.[1]?.trim();
        const title = /^title:\s*(.+)$/m.exec(header)?.[1]?.trim();
        if (id && title) {
            // Take the short clause before a colon or comma if the title is long
            const short =
                title.length > 42 && title.includes(":")
                    ? title.split(":")[0]!.trim()
                    : title;
            map.set(`a:${id}`, short);
        }
    }
    const cardRegex = /@@card\s*\n([\s\S]*?)@@end/g;
    while ((match = cardRegex.exec(guideRaw)) !== null) {
        const header = match[1]!;
        const id = /^id:\s*(.+)$/m.exec(header)?.[1]?.trim();
        const title = /^title:\s*(.+)$/m.exec(header)?.[1]?.trim();
        if (id && title) {
            map.set(`c:${id}`, `${title} screen`);
        }
    }
    return map;
}

/**
 * Strips mid-sentence parenthetical reference dumps like:
 *   ([[a:b06-12]])
 *   (see [[a:b02-06]])
 *   (see [[a:b06-05]], [[a:b06-07]])
 * from article/lesson body prose and appends them cleanly at the end of the body
 * if not already in the article's `related:` or `:::refs` list.
 */
function cleanBodyProse(body: string, shortTitles: Map<string, string>): string {
    const lines = body.replace(/\r\n/g, "\n").split("\n");
    const out: string[] = [];
    let insideFence = false;
    let insideRefsCallout = false;

    const parenRefPattern =
        /\s*\((?:see\s+|also\s+|e\.g\.,?\s+|for example\s+)?(\[\[[acgs]:[a-z0-9-]+(?:\|[^\]]+)?\]\](?:\s*(?:,|and|or)\s*\[\[[acgs]:[a-z0-9-]+(?:\|[^\]]+)?\]\])*)\)/gi;

    // Also handle parentheticals like "(called rails, see [[a:b02-06]])" -> "(called rails)"
    const mixedParenPattern =
        /\(([^()\[\]]+?),\s*(?:see|also)\s+\[\[[acgs]:[a-z0-9-]+(?:\|[^\]]+)?\]\]\)/gi;

    for (const rawLine of lines) {
        const trimmed = rawLine.trim();
        if (trimmed.startsWith("```")) {
            insideFence = !insideFence;
            out.push(rawLine);
            continue;
        }
        if (trimmed.startsWith(":::refs")) {
            insideRefsCallout = true;
            out.push(rawLine);
            continue;
        }
        if (insideRefsCallout && trimmed === ":::") {
            insideRefsCallout = false;
            out.push(rawLine);
            continue;
        }
        if (insideFence || insideRefsCallout || trimmed.startsWith("- [[")) {
            out.push(rawLine);
            continue;
        }

        let line = rawLine.replace(mixedParenPattern, "($1)");
        line = line.replace(parenRefPattern, "");
        line = line.replace(/\s+([.,;:!?])/g, "$1");

        // Add short conversational labels to any remaining bare inline [[a:id]] or [[c:id]]
        line = line.replace(/\[\[([ac]):([a-z0-9-]+)\]\]/g, (full, kind, id) => {
            const short = shortTitles.get(`${kind}:${id}`);
            return short ? `[[${kind}:${id}|${short}]]` : full;
        });

        out.push(line);
    }

    return out.join("\n");
}

function processCanonicalFile(filePath: string, shortTitles: Map<string, string>): number {
    const raw = readFileSync(filePath, "utf-8");
    let modifiedCount = 0;

    const updated = raw.replace(
        /(@@(?:article|lesson)\s*\n[\s\S]*?@@body\n)([\s\S]*?)(?=\n@@(?:end|quiz))/g,
        (_full, headerPart: string, bodyPart: string) => {
            const cleaned = cleanBodyProse(bodyPart, shortTitles);
            if (cleaned !== bodyPart) modifiedCount += 1;
            return `${headerPart}${cleaned}`;
        },
    );

    writeFileSync(filePath, updated, "utf-8");
    return modifiedCount;
}

const guideRaw = readFileSync(GUIDE_PATH, "utf-8");
const shortTitles = buildShortTitleMap(guideRaw);
const cleanedArticles = processCanonicalFile(GUIDE_PATH, shortTitles);
const cleanedLessons = processCanonicalFile(ACADEMY_PATH, shortTitles);

console.log(
    `Clarity overhaul complete: cleaned ${cleanedArticles} guide articles and ${cleanedLessons} academy lessons.`,
);
```
