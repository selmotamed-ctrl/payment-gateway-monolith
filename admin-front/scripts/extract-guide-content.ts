#!/usr/bin/env bun
/**
 * Extract the Admin Interactive Guide content from the canonical design file.
 *
 * The extractor is intentionally deterministic. `generatedAt` defaults to the
 * Unix epoch so that re-running the extractor produces byte-identical output;
 * set SOURCE_DATE_EPOCH to stamp a reproducible build time.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const SCRIPT_DIR = import.meta.dir;
const ADMIN_FRONT_DIR = path.resolve(SCRIPT_DIR, "..");
const REPO_ROOT = path.resolve(ADMIN_FRONT_DIR, "..");
const OUTPUT_DIR =
    process.env.GUIDE_OUTPUT_DIR?.trim() ||
    path.join(ADMIN_FRONT_DIR, "src", "content", "guide", "generated");

const SOURCE_CANDIDATES = [
    process.env.GUIDE_SOURCE_FILE?.trim(),
    path.join(REPO_ROOT, "design", "07-guides-and-academy", "guide_system_design_and_content.md"),
].filter((value): value is string => Boolean(value));

const ROLES = [
    "GATEWAY_ADMIN",
    "SECURITY_ADMIN",
    "FINANCE",
    "OPERATOR",
    "COMPLIANCE",
    "MLRO",
    "SUPPORT",
] as const;
const UI_STATUSES = ["AVAILABLE", "PARTIAL", "NOT_YET"] as const;
const RISKS = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
const ALLOWED_BLOCK_KEYWORDS = new Set([
    "book",
    "article",
    "term",
    "card",
    "situation",
    "path",
    "data",
    "map",
    "faq",
]);

const ATTRIBUTE_RE = /([a-zA-Z_][\w-]*)=("((?:[^"\\]|\\.)*)"|[^\s]+)/g;

type Role = (typeof ROLES)[number];
type UiStatus = (typeof UI_STATUSES)[number];

interface AttributeMap {
    [key: string]: string;
}

interface ParsedLine {
    keyword: string;
    attrs: AttributeMap;
    rest: string;
    lineNumber: number;
}

interface SourceLine {
    text: string;
    lineNumber: number;
}

interface Book {
    id: string;
    title: string;
    audience: string;
    summary: string;
}

interface ArticleHeading {
    id: string;
    text: string;
    level: number;
}

interface Article {
    id: string;
    book: number;
    order: number;
    title: string;
    roles: "ALL" | Role[];
    minutes: number;
    ui: UiStatus;
    related: string[];
    body: string;
    headings: ArticleHeading[];
    plainText: string;
}

interface Term {
    slug: string;
    term: string;
    aliases: string[];
    ar?: string;
    related: string[];
    short: string;
}

interface Card {
    id: string;
    title: string;
    screen: string;
    risk: (typeof RISKS)[number];
    irreversible: boolean;
    body: string;
    checklist: string[];
}

interface Situation {
    id: string;
    title: string;
    screens: string[];
    cases: number[];
    articles: string[];
    body: string;
}

interface ReadingPath {
    role: "ALL" | Role;
    title: string;
    articles: string[];
}

interface Faq {
    id: string;
    article: string;
    question: string;
    answer: string;
}

interface ErrorCode {
    code: string;
    where: string;
    meaning: string;
    action: string;
}

interface EdgeCase {
    n: number;
    group: string;
    groupName: string;
    scenario: string;
    resolution: string;
    severity: "Low" | "Med" | "High";
}

interface ContextScreen {
    screenId: string;
    routeNames: string[];
    pageDir: string;
    summary: string;
    articles: string[];
    cards: string[];
    situations: string[];
}

interface ContextMap {
    fallbackScreenId: string;
    screens: ContextScreen[];
}

const fail = (message: string, lineNumber?: number): never => {
    const location = lineNumber ? ` (line ${lineNumber})` : "";
    console.error(`extract-guide-content: ${message}${location}`);
    process.exit(1);
};

const unquoteAttribute = (value: string): string => {
    if (value.startsWith('"') && value.endsWith('"')) {
        const inner = value.slice(1, -1);
        return inner.replace(/\\(["\\])/g, "$1");
    }
    return value;
};

const parseAttributes = (input: string): AttributeMap => {
    const attrs: AttributeMap = {};
    ATTRIBUTE_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = ATTRIBUTE_RE.exec(input)) !== null) {
        attrs[match[1]] = unquoteAttribute(match[2]);
    }
    return attrs;
};

const splitRequired = (line: SourceLine, keyword: string): ParsedLine => {
    const text = line.text;
    const prefix = `@@${keyword}`;
    if (!text.startsWith(prefix)) {
        fail(`expected ${prefix}`, line.lineNumber);
    }
    const remainder = text.slice(prefix.length).trim();
    const separator = remainder.indexOf(" :: ");
    const attributeText = separator >= 0 ? remainder.slice(0, separator) : remainder;
    const rest = separator >= 0 ? remainder.slice(separator + 4).trim() : "";
    return {
        keyword,
        attrs: parseAttributes(attributeText),
        rest,
        lineNumber: line.lineNumber,
    };
};

const requireAttribute = (parsed: ParsedLine, name: string): string => {
    const value = parsed.attrs[name];
    if (!value || !value.trim()) {
        fail(`@@${parsed.keyword} is missing required attribute "${name}"`, parsed.lineNumber);
    }
    return value.trim();
};

const optionalAttribute = (parsed: ParsedLine, name: string): string | undefined => {
    const value = parsed.attrs[name];
    return value === undefined ? undefined : value.trim();
};

const parseNumber = (parsed: ParsedLine, name: string, minimum: number): number => {
    const raw = requireAttribute(parsed, name);
    const value = Number(raw);
    if (!Number.isInteger(value) || value < minimum) {
        fail(`@@${parsed.keyword} "${name}" must be an integer >= ${minimum}`, parsed.lineNumber);
    }
    return value;
};

const splitList = (value: string | undefined): string[] =>
    (value ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);

const splitSemicolonList = (value: string | undefined): string[] =>
    (value ?? "")
        .split(";")
        .map((entry) => entry.trim())
        .filter(Boolean);

const assertId = (value: string, label: string, lineNumber: number): void => {
    if (!/^[a-z0-9-]+$/.test(value)) {
        fail(`${label} id "${value}" must match [a-z0-9-]+`, lineNumber);
    }
};

const assertUnique = (collection: Set<string>, id: string, label: string, lineNumber: number): void => {
    if (collection.has(id)) {
        fail(`duplicate ${label} id "${id}"`, lineNumber);
    }
    collection.add(id);
};

const stripInlineMarkdown = (value: string, resolveArticle?: (id: string) => string): string =>
    value
        .replace(/\[\[a:([a-z0-9-]+)\|([^\]]+)\]\]/g, "$2")
        .replace(/\[\[a:([a-z0-9-]+)\]\]/g, (_match, id: string) => resolveArticle?.(id) ?? id)
        .replace(/\[\[(?:c|s):([a-z0-9-]+)\|([^\]]+)\]\]/g, "$2")
        .replace(/\[\[(?:c|s):([a-z0-9-]+)\]\]/g, "$1")
        .replace(/\[\[g:([a-z0-9-]+)\|([^\]]+)\]\]/g, "$2")
        .replace(/\[\[g:([a-z0-9-]+)\]\]/g, "$1")
        .replace(/`{1,3}([^`]*)`{1,3}/g, "$1")
        .replace(/\*\*([^*]+)\*\*/g, "$1")
        .replace(/__([^_]+)__/g, "$1")
        .replace(/(^|\s)\*([^*]+)\*(?=\s|$)/g, "$1$2")
        .replace(/(^|\s)_([^_]+)_(?=\s|$)/g, "$1$2")
        .replace(/\\([\\`*_{}[\]()#+\-.!|>])/g, "$1")
        .replace(/<br\s*\/?>/gi, " ")
        .replace(/[ \t]+/g, " ")
        .trim();

const stripMarkdownForPlainText = (body: string, resolveArticle?: (id: string) => string): string =>
    body
        .replace(/```[a-zA-Z0-9_-]*\n([\s\S]*?)```/g, "$1")
        .replace(/^:::[a-z]+\s*(.*)$/gm, "$1")
        .replace(/^:::$/gm, "")
        .replace(/^\s{0,3}#{1,6}\s+/gm, "")
        .replace(/^\s*[-*+]\s+/gm, "")
        .replace(/^\s*\d+\.\s+/gm, "")
        .replace(/^\s*>\s?/gm, "")
        .replace(/\|/g, " ")
        .replace(/\{\{widget:[a-z0-9-]+\}\}/g, " ")
        .split("\n")
        .map((line) => stripInlineMarkdown(line, resolveArticle))
        .join("\n")
        .replace(/[ \t]+/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();

const slugifyHeading = (value: string): string => {
    const cleaned = stripInlineMarkdown(value)
        .toLocaleLowerCase()
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^\p{L}\p{N}]+/gu, "-")
        .replace(/^-+|-+$/g, "");
    return cleaned || "section";
};

const parseHeadings = (body: string): ArticleHeading[] => {
    const headings: ArticleHeading[] = [];
    const seen = new Map<string, number>();
    for (const line of body.split("\n")) {
        const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
        if (!match) {
            continue;
        }
        const text = stripInlineMarkdown(match[2]);
        if (!text) {
            continue;
        }
        const base = slugifyHeading(text);
        const count = seen.get(base) ?? 0;
        seen.set(base, count + 1);
        headings.push({
            id: count === 0 ? base : `${base}-${count + 1}`,
            text,
            level: match[1].length,
        });
    }
    return headings;
};

const extractLinks = (body: string): { kind: string; id: string }[] => {
    const links: { kind: string; id: string }[] = [];
    const regex = /\[\[([acgs]):([a-z0-9-]+)(?:\|[^\]]+)?\]\]/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(body)) !== null) {
        links.push({ kind: match[1], id: match[2] });
    }
    return links;
};

const ensureFencedJson = (lines: SourceLine[], lineNumber: number): unknown => {
    const openingIndex = lines.findIndex((line) => line.text.trim().startsWith("```json"));
    if (openingIndex < 0) {
        fail("data/map block must contain one fenced ```json block", lineNumber);
    }
    const opening = lines[openingIndex];
    const closingIndex = lines.findIndex(
        (line, index) => index > openingIndex && line.text.trim() === "```",
    );
    if (closingIndex < 0) {
        fail("unterminated ```json fence", opening.lineNumber);
    }
    const jsonText = lines
        .slice(openingIndex + 1, closingIndex)
        .map((line) => line.text)
        .join("\n");
    try {
        return JSON.parse(jsonText);
    } catch (error) {
        fail(`invalid JSON: ${(error as Error).message}`, opening.lineNumber);
    }
};

const parseCardChecklist = (body: string): string[] =>
    body
        .split("\n")
        .filter((line) => /^\s*-\s*\[\s*\]\s+/.test(line))
        .map((line) => line.replace(/^\s*-\s*\[\s*\]\s+/, "").trim())
        .filter(Boolean);

const validateCardHeadings = (card: Card, lineNumber: number): void => {
    const required = ["**What this does**", "**Check first**", "**Never**", "**If you made a mistake**"];
    let cursor = 0;
    for (const heading of required) {
        const index = card.body.indexOf(heading, cursor);
        if (index < 0) {
            fail(`card "${card.id}" is missing heading ${heading} in order`, lineNumber);
        }
        cursor = index + heading.length;
    }
    if (card.checklist.length === 0) {
        fail(`card "${card.id}" has no "- [ ] " checklist items`, lineNumber);
    }
};

const splitTableRow = (line: string): string[] => {
    const cells: string[] = [];
    let current = "";
    let escaped = false;
    for (const char of line) {
        if (escaped) {
            current += char;
            escaped = false;
            continue;
        }
        if (char === "\\") {
            current += char;
            escaped = true;
            continue;
        }
        if (char === "|") {
            cells.push(current);
            current = "";
            continue;
        }
        current += char;
    }
    cells.push(current);
    return cells.slice(1, -1).map((cell) => cell.trim());
};

const parseErrorCodes = (article: Article, resolveArticle: (id: string) => string): ErrorCode[] => {
    const codes: ErrorCode[] = [];
    for (const line of article.body.split("\n")) {
        if (!line.trim().startsWith("|")) {
            continue;
        }
        const cells = splitTableRow(line);
        if (cells.length < 4) {
            continue;
        }
        const codeMatch = /^`([^`]+)`$/.exec(cells[0]);
        if (!codeMatch) {
            continue;
        }
        codes.push({
            code: codeMatch[1],
            where: stripInlineMarkdown(cells[1], resolveArticle),
            meaning: stripInlineMarkdown(cells[2], resolveArticle),
            action: stripInlineMarkdown(cells[3], resolveArticle),
        });
    }
    return codes;
};

const findEdgeCaseSource = (): string => {
    const designDirectory = path.join(REPO_ROOT, "design", "90-archive", "superseded-architecture");
    const candidates = readdirSync(designDirectory)
        .filter((name) => /^payment-gateway-refined-design-v4.*\.md$/.test(name))
        .sort();
    const chosen = candidates[0];
    if (!chosen) {
        fail("could not find design/90-archive/superseded-architecture/payment-gateway-refined-design-v4*.md for edge cases");
    }
    return path.join(designDirectory, chosen);
};

const parseEdgeCases = (): EdgeCase[] => {
    const sourcePath = findEdgeCaseSource();
    const lines = readFileSync(sourcePath, "utf8").replace(/\r\n/g, "\n").split("\n");
    const joinFlat = (value: string): string =>
        value
            .replace(/\\\|/g, "|")
            .replace(/\\([\\`*_{}[\]()#+\-.!|>])/g, "$1")
            .replace(/\*\*([^*]+)\*\*/g, "$1")
            .replace(/`([^`]*)`/g, "$1")
            .replace(/\s+/g, " ")
            .trim();

    const cases: EdgeCase[] = [];
    let currentGroup = "";
    let currentGroupName = "";
    for (const line of lines) {
        const heading = /^### \*\*Group ([A-Z]): (.+?) \(Cases? \d+[–-]\d+\)\*\*\s*$/.exec(line);
        if (heading) {
            currentGroup = heading[1];
            currentGroupName = heading[2].trim();
            continue;
        }
        if (!currentGroup || !line.startsWith("|")) {
            continue;
        }
        const cells = splitTableRow(line);
        if (cells.length < 4) {
            continue;
        }
        const numberMatch = /^\*\*(\d+)\*\*$/.exec(cells[0]);
        if (!numberMatch) {
            continue;
        }
        const severity = joinFlat(cells[3]);
        if (severity !== "Low" && severity !== "Med" && severity !== "High") {
            continue;
        }
        cases.push({
            n: Number(numberMatch[1]),
            group: currentGroup,
            groupName: currentGroupName,
            scenario: joinFlat(cells[1]),
            resolution: joinFlat(cells[2]),
            severity,
        });
    }

    if (cases.length !== 140) {
        fail(`expected 140 edge cases, found ${cases.length} in ${path.basename(sourcePath)}`);
    }
    return cases;
};

const writeJson = (fileName: string, value: unknown): void => {
    writeFileSync(path.join(OUTPUT_DIR, fileName), `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const main = (): void => {
    const sourcePath = SOURCE_CANDIDATES.find((candidate) => existsSync(candidate));
    if (!sourcePath) {
        fail(
            `could not locate the guide design file. Tried:\n${SOURCE_CANDIDATES.join("\n")}`,
        );
        return;
    }

    const rawSource = readFileSync(sourcePath, "utf8");
    const source = rawSource.replace(/\r\n/g, "\n");
    const lines: SourceLine[] = source.split("\n").map((text, index) => ({
        text,
        lineNumber: index + 1,
    }));

    const versionMatch = /<!--\s*CONTENT_VERSION:\s*([0-9]+\.[0-9]+\.[0-9]+)\s*-->/.exec(source);
    if (!versionMatch) {
        fail("missing <!-- CONTENT_VERSION: x.y.z --> marker");
    }
    const contentVersion = versionMatch[1];

    const beginIndex = lines.findIndex((line) => line.text.trim() === "<!-- CONTENT:BEGIN -->");
    const endIndex = lines.findIndex((line) => line.text.trim() === "<!-- CONTENT:END -->");
    if (beginIndex < 0 || endIndex < 0 || endIndex <= beginIndex) {
        fail("missing or inverted CONTENT:BEGIN / CONTENT:END markers");
    }

    const books: Book[] = [];
    const articles: Article[] = [];
    const terms: Term[] = [];
    const cards: Card[] = [];
    const situations: Situation[] = [];
    const paths: ReadingPath[] = [];
    const faqs: Faq[] = [];
    const dataBlocks: Record<string, unknown> = {};
    let contextMap: ContextMap | null = null;

    const bookIds = new Set<string>();
    const articleIds = new Set<string>();
    const termSlugs = new Set<string>();
    const cardIds = new Set<string>();
    const situationIds = new Set<string>();
    const faqIds = new Set<string>();
    const dataIds = new Set<string>();

    for (let index = beginIndex + 1; index < endIndex; index += 1) {
        const line = lines[index];
        if (!line.text.startsWith("@@")) {
            continue;
        }
        const keywordMatch = /^@@([a-zA-Z_-]+)\b/.exec(line.text);
        if (!keywordMatch) {
            fail("malformed @@ block opening", line.lineNumber);
        }
        const keyword = keywordMatch[1];
        if (!ALLOWED_BLOCK_KEYWORDS.has(keyword)) {
            fail(`unknown @@ keyword "${keyword}"`, line.lineNumber);
        }
        const parsed = splitRequired(line, keyword);

        if (keyword === "book") {
            const id = requireAttribute(parsed, "id");
            if (!/^\d+$/.test(id)) {
                fail(`book id "${id}" must be numeric`, line.lineNumber);
            }
            assertUnique(bookIds, id, "book", line.lineNumber);
            books.push({
                id,
                title: requireAttribute(parsed, "title"),
                audience: requireAttribute(parsed, "audience"),
                summary: requireAttribute(parsed, "summary"),
            });
            continue;
        }

        if (keyword === "term") {
            const slug = requireAttribute(parsed, "slug");
            assertId(slug, "term", line.lineNumber);
            assertUnique(termSlugs, slug, "term", line.lineNumber);
            const short = parsed.rest.trim();
            if (!short) {
                fail(`term "${slug}" is missing its ":: Short definition" text`, line.lineNumber);
            }
            const term: Term = {
                slug,
                term: requireAttribute(parsed, "term"),
                aliases: splitSemicolonList(optionalAttribute(parsed, "aliases")),
                related: splitList(optionalAttribute(parsed, "related")),
                short,
            };
            const ar = optionalAttribute(parsed, "ar");
            if (ar) {
                term.ar = ar;
            }
            terms.push(term);
            continue;
        }

        if (keyword === "path") {
            const role = requireAttribute(parsed, "role");
            if (role !== "ALL" && !ROLES.includes(role as Role)) {
                fail(`path role "${role}" is not ALL or a known staff role`, line.lineNumber);
            }
            paths.push({
                role: role as "ALL" | Role,
                title: requireAttribute(parsed, "title"),
                articles: splitList(parsed.rest),
            });
            continue;
        }

        if (keyword === "data" || keyword === "map") {
            const id = requireAttribute(parsed, "id");
            if (keyword === "data") {
                assertId(id, "data", line.lineNumber);
                assertUnique(dataIds, id, "data", line.lineNumber);
            }
            const bodyLines: SourceLine[] = [];
            let cursor = index + 1;
            for (; cursor < endIndex; cursor += 1) {
                if (lines[cursor].text.trim() === "@@end") {
                    break;
                }
                bodyLines.push(lines[cursor]);
            }
            if (cursor >= endIndex) {
                fail(`missing @@end for @@${keyword} ${id}`, line.lineNumber);
            }
            const parsedJson = ensureFencedJson(bodyLines, line.lineNumber);
            if (keyword === "map") {
                if (id !== "context-map") {
                    fail(`unsupported @@map id "${id}"`, line.lineNumber);
                }
                contextMap = parsedJson as ContextMap;
            } else {
                dataBlocks[id] = parsedJson;
            }
            index = cursor;
            continue;
        }

        // Remaining block types carry a Markdown body.
        const id = requireAttribute(parsed, "id");
        assertId(id, keyword, line.lineNumber);
        const bodyLines: SourceLine[] = [];
        let cursor = index + 1;
        for (; cursor < endIndex; cursor += 1) {
            if (lines[cursor].text.trim() === "@@end") {
                break;
            }
            bodyLines.push(lines[cursor]);
        }
        if (cursor >= endIndex) {
            fail(`missing @@end for @@${keyword} ${id}`, line.lineNumber);
        }
        const body = bodyLines.map((entry) => entry.text).join("\n").trim();

        if (keyword === "article") {
            assertUnique(articleIds, id, "article", line.lineNumber);
            const roleValue = requireAttribute(parsed, "roles");
            let roles: "ALL" | Role[];
            if (roleValue === "ALL") {
                roles = "ALL";
            } else {
                const parsedRoles = splitList(roleValue);
                const invalid = parsedRoles.find((role) => !ROLES.includes(role as Role));
                if (invalid) {
                    fail(`article "${id}" has unknown role "${invalid}"`, line.lineNumber);
                }
                roles = parsedRoles as Role[];
            }
            const ui = requireAttribute(parsed, "ui");
            if (!UI_STATUSES.includes(ui as UiStatus)) {
                fail(`article "${id}" has invalid ui "${ui}"`, line.lineNumber);
            }
            if (!body) {
                fail(`article "${id}" has an empty body`, line.lineNumber);
            }
            articles.push({
                id,
                book: parseNumber(parsed, "book", 0),
                order: parseNumber(parsed, "order", 1),
                title: requireAttribute(parsed, "title"),
                roles,
                minutes: parseNumber(parsed, "minutes", 0),
                ui: ui as UiStatus,
                related: splitList(optionalAttribute(parsed, "related")),
                body,
                headings: parseHeadings(body),
                plainText: stripMarkdownForPlainText(body),
            });
        } else if (keyword === "card") {
            assertUnique(cardIds, id, "card", line.lineNumber);
            const risk = requireAttribute(parsed, "risk");
            if (!RISKS.includes(risk as (typeof RISKS)[number])) {
                fail(`card "${id}" has invalid risk "${risk}"`, line.lineNumber);
            }
            const irreversibleRaw = requireAttribute(parsed, "irreversible");
            if (irreversibleRaw !== "true" && irreversibleRaw !== "false") {
                fail(`card "${id}" has invalid irreversible "${irreversibleRaw}"`, line.lineNumber);
            }
            const card: Card = {
                id,
                title: requireAttribute(parsed, "title"),
                screen: requireAttribute(parsed, "screen"),
                risk: risk as (typeof RISKS)[number],
                irreversible: irreversibleRaw === "true",
                body,
                checklist: parseCardChecklist(body),
            };
            validateCardHeadings(card, line.lineNumber);
            cards.push(card);
        } else if (keyword === "situation") {
            assertUnique(situationIds, id, "situation", line.lineNumber);
            const cases = splitList(optionalAttribute(parsed, "cases")).map((entry) => {
                const value = Number(entry);
                if (!Number.isInteger(value) || value < 1 || value > 140) {
                    fail(`situation "${id}" case "${entry}" must be 1..140`, line.lineNumber);
                }
                return value;
            });
            situations.push({
                id,
                title: requireAttribute(parsed, "title"),
                screens: splitList(optionalAttribute(parsed, "screens")),
                cases,
                articles: splitList(optionalAttribute(parsed, "articles")),
                body,
            });
        } else if (keyword === "faq") {
            assertUnique(faqIds, id, "faq", line.lineNumber);
            const firstLine = bodyLines[0]?.text.trim() ?? "";
            if (!firstLine.startsWith("Q:")) {
                fail(`faq "${id}" must start with "Q: ..."`, line.lineNumber);
            }
            faqs.push({
                id,
                article: requireAttribute(parsed, "article"),
                question: firstLine.replace(/^Q:\s*/, "").trim(),
                answer: bodyLines
                    .slice(1)
                    .map((entry) => entry.text)
                    .join("\n")
                    .trim(),
            });
        }

        index = cursor;
    }

    const articleById = new Map(articles.map((article) => [article.id, article]));
    const resolveArticleTitle = (articleId: string): string => articleById.get(articleId)?.title ?? articleId;
    for (const article of articles) {
        article.plainText = stripMarkdownForPlainText(article.body, resolveArticleTitle);
    }

    if (contextMap === null) {
        fail("missing @@map id=context-map block");
    }
    const context = contextMap as ContextMap;

    // Cross-reference validation.
    for (const article of articles) {
        if (!bookIds.has(String(article.book))) {
            fail(`article "${article.id}" references missing book ${article.book}`);
        }
        for (const related of article.related) {
            if (!articleById.has(related)) {
                fail(`article "${article.id}" has missing related id "${related}"`);
            }
        }
        for (const link of extractLinks(article.body)) {
            if (link.kind === "a" && !articleById.has(link.id)) {
                fail(`article "${article.id}" links to missing article "${link.id}"`);
            }
            if (link.kind === "c" && !cardIds.has(link.id)) {
                fail(`article "${article.id}" links to missing card "${link.id}"`);
            }
            if (link.kind === "s" && !situationIds.has(link.id)) {
                fail(`article "${article.id}" links to missing situation "${link.id}"`);
            }
            if (link.kind === "g" && !termSlugs.has(link.id)) {
                fail(`article "${article.id}" links to missing glossary term "${link.id}"`);
            }
        }
    }
    for (const term of terms) {
        for (const related of term.related) {
            if (!termSlugs.has(related)) {
                fail(`glossary term "${term.slug}" has missing related term "${related}"`);
            }
        }
    }
    for (const situation of situations) {
        for (const articleId of situation.articles) {
            if (!articleById.has(articleId)) {
                fail(`situation "${situation.id}" references missing article "${articleId}"`);
            }
        }
    }
    for (const faq of faqs) {
        if (!articleById.has(faq.article)) {
            fail(`faq "${faq.id}" references missing article "${faq.article}"`);
        }
    }
    for (const readingPath of paths) {
        for (const articleId of readingPath.articles) {
            if (!articleById.has(articleId)) {
                fail(`path "${readingPath.role}" references missing article "${articleId}"`);
            }
        }
    }
    const contextScreenIds = new Set(context.screens.map((screen) => screen.screenId));
    if (!contextScreenIds.has(context.fallbackScreenId)) {
        fail(`context map fallbackScreenId "${context.fallbackScreenId}" is not a screen`);
    }
    for (const screen of context.screens) {
        for (const articleId of screen.articles) {
            if (!articleById.has(articleId)) {
                fail(`context screen "${screen.screenId}" references missing article "${articleId}"`);
            }
        }
        for (const cardId of screen.cards) {
            if (!cardIds.has(cardId)) {
                fail(`context screen "${screen.screenId}" references missing card "${cardId}"`);
            }
        }
        for (const situationId of screen.situations) {
            if (!situationIds.has(situationId)) {
                fail(`context screen "${screen.screenId}" references missing situation "${situationId}"`);
            }
        }
    }
    for (const link of extractLinks(context.screens.map((screen) => screen.summary).join("\n"))) {
        if (link.kind === "a" && !articleById.has(link.id)) {
            fail(`context map summary links to missing article "${link.id}"`);
        }
    }

    const errorCodes = parseErrorCodes(articleById.get("b13-01") ?? fail("missing article b13-01"), resolveArticleTitle);
    if (errorCodes.length !== 19) {
        fail(`expected 19 error codes in b13-01, found ${errorCodes.length}`);
    }
    const edgeCases = parseEdgeCases();

    const counts = {
        books: books.length,
        articles: articles.length,
        glossaryTerms: terms.length,
        safeguardCards: cards.length,
        safeguardChecklistItems: cards.reduce((total, card) => total + card.checklist.length, 0),
        situations: situations.length,
        readingPaths: paths.length,
        quickAnswers: faqs.length,
        dataBlocks: Object.keys(dataBlocks).length,
        contextMapScreens: context.screens.length,
        errorCodes: errorCodes.length,
        edgeCases: edgeCases.length,
    };

    const expectedCounts: Record<keyof typeof counts, number> = {
        books: 14,
        articles: 135,
        glossaryTerms: 151,
        safeguardCards: 25,
        safeguardChecklistItems: 112,
        situations: 32,
        readingPaths: 8,
        quickAnswers: 58,
        dataBlocks: 3,
        contextMapScreens: 26,
        errorCodes: 19,
        edgeCases: 140,
    };
    for (const [key, expected] of Object.entries(expectedCounts) as [keyof typeof counts, number][]) {
        if (counts[key] !== expected) {
            fail(`expected counts.${key}=${expected}, found ${counts[key]}`);
        }
    }

    const sourceDateEpoch = process.env.SOURCE_DATE_EPOCH?.trim();
    const generatedAt = sourceDateEpoch
        ? new Date(Number(sourceDateEpoch) * 1000).toISOString()
        : "1970-01-01T00:00:00.000Z";

    const meta = {
        contentVersion,
        generatedAt,
        counts,
        sourceSha256: createHash("sha256").update(source, "utf8").digest("hex"),
    };

    mkdirSync(OUTPUT_DIR, { recursive: true });
    writeJson("books.json", books);
    writeJson("articles.en.json", articles);
    writeJson("glossary.en.json", terms);
    writeJson("cards.en.json", cards);
    writeJson("playbook.en.json", situations);
    writeJson("paths.json", paths);
    writeJson("faq.en.json", faqs);
    writeJson("data.json", dataBlocks);
    writeJson("context-map.json", context);
    writeJson("error-codes.en.json", errorCodes);
    writeJson("edge-cases.en.json", edgeCases);
    writeJson("meta.json", meta);

    console.log(
        [
            `Guide content extracted from ${path.relative(REPO_ROOT, sourcePath)}`,
            `version ${contentVersion}`,
            `${counts.books} books, ${counts.articles} articles, ${counts.glossaryTerms} terms`,
            `${counts.safeguardCards} cards, ${counts.situations} situations, ${counts.quickAnswers} quick answers`,
            `output: ${path.relative(REPO_ROOT, OUTPUT_DIR)}`,
        ].join("\n"),
    );
};

main();
