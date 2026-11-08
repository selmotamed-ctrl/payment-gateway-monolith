#!/usr/bin/env bun
/**
 * Extract the Employee Academy content from the canonical design file.
 *
 *   bun scripts/extract-academy-content.ts
 *
 * Source: design/07-guides-and-academy/academy_system_design_and_content.md
 * (the region between the CONTENT:BEGIN / CONTENT:END marker lines).
 *
 * Two outputs, because answer keys must never reach the browser (spec Part 0 rule 3):
 *   1. admin-front/src/content/academy/generated/   learner content. Lesson checks and labs
 *      are PRACTICE and carry their keys on purpose; exam-pool questions are NOT here.
 *   2. core-back/content/academy/exam-bank.json     exam-pool questions WITH keys and the
 *      exam blueprints. Never served to a client.
 *
 * Deterministic: stable ordering, no wall-clock time (generatedAt = SOURCE_DATE_EPOCH or the
 * Unix epoch), so two runs produce byte-identical files.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import MarkdownIt from "markdown-it";

const SCRIPT_DIR = import.meta.dir;
const ADMIN_FRONT_DIR = path.resolve(SCRIPT_DIR, "..");
const REPO_ROOT = path.resolve(ADMIN_FRONT_DIR, "..");
const OUTPUT_DIR =
    process.env.ACADEMY_OUTPUT_DIR?.trim() ||
    path.join(ADMIN_FRONT_DIR, "src", "content", "academy", "generated");
const EXAM_BANK_PATH =
    process.env.ACADEMY_EXAM_BANK_PATH?.trim() ||
    path.join(REPO_ROOT, "core-back", "content", "academy", "exam-bank.json");
const CATALOG_PATH =
    process.env.ACADEMY_CATALOG_PATH?.trim() ||
    path.join(REPO_ROOT, "core-back", "content", "academy", "catalog.json");
const SOURCE_PATH =
    process.env.ACADEMY_SOURCE_FILE?.trim() ||
    path.join(REPO_ROOT, "design", "07-guides-and-academy", "academy_system_design_and_content.md");
const GUIDE_SOURCE_PATH =
    process.env.GUIDE_SOURCE_FILE?.trim() ||
    path.join(REPO_ROOT, "design", "07-guides-and-academy", "guide_system_design_and_content.md");

const CONTENT_VERSION = "1.0.0";
const RECERTIFY_FROM = "1.0.0";

const TRACK_IDS = [
    "FOUNDATION",
    "OPERATOR",
    "SUPPORT",
    "FINANCE",
    "COMPLIANCE",
    "MLRO",
    "GATEWAY_ADMIN",
    "SECURITY_ADMIN",
] as const;
type TrackId = (typeof TRACK_IDS)[number];

const BLOCK_KINDS = new Set(["track", "module", "lesson", "q", "lab", "exam", "drill", "page"]);
const ONE_LINE_KINDS = new Set(["track", "module"]);
const Q_TYPES = new Set(["single", "multi", "order", "number", "truefalse"]);
const LESSON_SECTIONS = [
    "You will be able to",
    "Key ideas",
    "A worked example",
    "Common mistakes",
    "Read now",
    "Check yourself",
];
const LAB_KINDS = new Set(["choice", "multi", "ledger", "order", "checklist", "numeric"]);

/** Counts the content test asserts (spec II-2.5). A change here needs the spec table updated too. */
export const EXPECTED_COUNTS = {
    tracks: 8,
    modules: 11,
    lessons: 50,
    lessonChecks: 100,
    examPoolQuestions: 223,
    examPoolSingle: 208,
    examPoolNumber: 13,
    examPoolOrder: 2,
    criticalExamPoolQuestions: 43,
    labs: 16,
    labTasks: 92,
    exams: 8,
    drills: 11,
    pages: 7,
} as const;

interface SourceLine {
    text: string;
    n: number;
}

function fail(message: string, line?: number): never {
    console.error(`extract-academy-content: ${message}${line ? ` (line ${line})` : ""}`);
    process.exit(1);
}

// ---------------------------------------------------------------------------------------
// Attribute parsing
// ---------------------------------------------------------------------------------------

const ATTRIBUTE_RE = /([a-zA-Z_][\w-]*)=("((?:[^"\\]|\\.)*)"|[^\s]+)/g;

const parseAttributes = (input: string): Record<string, string> => {
    const attrs: Record<string, string> = {};
    ATTRIBUTE_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = ATTRIBUTE_RE.exec(input)) !== null) {
        const raw = match[2];
        attrs[match[1]] = raw.startsWith('"') ? raw.slice(1, -1).replace(/\\(["\\])/g, "$1") : raw;
    }
    return attrs;
};

interface Header {
    kind: string;
    attrs: Record<string, string>;
    rest: string;
    n: number;
}

const parseHeader = (line: SourceLine): Header => {
    const match = /^@@([a-zA-Z_-]+)\b(.*)$/.exec(line.text);
    if (!match) return fail("malformed @@ block opening", line.n);
    const kind = match[1];
    if (!BLOCK_KINDS.has(kind)) return fail(`unknown @@ block kind "${kind}"`, line.n);
    const remainder = match[2].trim();
    const sep = remainder.indexOf(" :: ");
    return {
        kind,
        attrs: parseAttributes(sep >= 0 ? remainder.slice(0, sep) : remainder),
        rest: sep >= 0 ? remainder.slice(sep + 4).trim() : "",
        n: line.n,
    };
};

const need = (h: Header, name: string): string => {
    const value = h.attrs[name];
    if (value === undefined || value.trim() === "") fail(`@@${h.kind} is missing "${name}"`, h.n);
    return value.trim();
};

const needInt = (h: Header, name: string, min: number): number => {
    const value = Number(need(h, name));
    if (!Number.isInteger(value) || value < min) fail(`@@${h.kind} "${name}" must be an integer >= ${min}`, h.n);
    return value;
};

const list = (value: string | undefined): string[] =>
    (value ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);

const needBool = (h: Header, name: string): boolean => {
    const value = need(h, name);
    if (value !== "true" && value !== "false") fail(`@@${h.kind} "${name}" must be true or false`, h.n);
    return value === "true";
};

// ---------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------

interface QuestionOption {
    id: string;
    text: string;
    correct?: boolean;
    note?: string;
}

interface Question {
    id: string;
    module: string;
    type: string;
    difficulty: 1 | 2 | 3;
    critical: boolean;
    exam: boolean;
    lesson?: string;
    tracks: string[];
    refs: string[];
    stem: string;
    options: QuestionOption[];
    answer?: string;
    tolerance?: string;
    why: string;
}

interface Block {
    header: Header;
    body: SourceLine[];
}

// ---------------------------------------------------------------------------------------
// Guide reference index (article ids, glossary slugs)
// ---------------------------------------------------------------------------------------

const loadGuideIndex = (): { articles: Map<string, string>; terms: Set<string> } => {
    if (!existsSync(GUIDE_SOURCE_PATH)) fail(`guide design file not found: ${GUIDE_SOURCE_PATH}`);
    const text = readFileSync(GUIDE_SOURCE_PATH, "utf8").replace(/\r\n/g, "\n");
    const articles = new Map<string, string>();
    const terms = new Set<string>();
    for (const line of text.split("\n")) {
        if (line.startsWith("@@article ")) {
            const attrs = parseAttributes(line.slice("@@article ".length));
            if (attrs.id) articles.set(attrs.id, attrs.title ?? attrs.id);
        } else if (line.startsWith("@@term ")) {
            const attrs = parseAttributes(line.slice("@@term ".length));
            if (attrs.slug) terms.add(attrs.slug);
            else if (attrs.id) terms.add(attrs.id);
        }
    }
    if (articles.size === 0) fail("no @@article blocks found in the guide design file");
    return { articles, terms };
};

// ---------------------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------------------

const md = new MarkdownIt({ html: false, linkify: false, typographer: false });
const escapeHtml = (value: string): string =>
    value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const resolveLinks = (
    body: string,
    guide: { articles: Map<string, string>; terms: Set<string> },
    where: string,
    n: number,
): string => {
    const withArticles = body.replace(/\[\[a:([a-z0-9-]+)(?:\|([^\]]+))?\]\]/g, (_m, id: string, label?: string) => {
        const title = guide.articles.get(id);
        if (!title) fail(`${where}: unresolved Guide article "[[a:${id}]]"`, n);
        return `[${label ?? title}](/guide/a/${id})`;
    });
    return withArticles.replace(/\[\[g:([a-z0-9-]+)(?:\|([^\]]+))?\]\]/g, (_m, slug: string, label?: string) => {
        if (!guide.terms.has(slug)) fail(`${where}: unresolved Guide glossary term "[[g:${slug}]]"`, n);
        return `[${label ?? slug}](/guide/glossary/${slug})`;
    });
};

/** Callouts `:::note|tip|warning|danger` … `:::` become styled wrappers; the rest is markdown-it. */
const renderMarkdown = (body: string): string => {
    const out: string[] = [];
    let buffer: string[] = [];
    let callout: string | null = null;
    const flush = (): void => {
        if (buffer.length === 0) return;
        const html = md.render(buffer.join("\n"));
        out.push(callout ? `<div class="academy-callout academy-callout-${callout}">${html}</div>` : html);
        buffer = [];
    };
    for (const line of body.split("\n")) {
        const open = /^:::(note|tip|warning|danger)\s*$/.exec(line);
        if (open && callout === null) {
            flush();
            callout = open[1];
            continue;
        }
        if (line.trim() === ":::" && callout !== null) {
            flush();
            callout = null;
            continue;
        }
        buffer.push(line);
    }
    flush();
    return out.join("");
};

const plainText = (body: string): string =>
    body
        .replace(/^:::[a-z]*\s*$/gm, "")
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        .replace(/[*_`#>]/g, "")
        .replace(/^\s*[-*]\s+/gm, "")
        .replace(/\s+/g, " ")
        .trim();

// ---------------------------------------------------------------------------------------
// Question parsing
// ---------------------------------------------------------------------------------------

const parseQuestion = (block: Block): Question => {
    const h = block.header;
    const id = need(h, "id");
    const type = need(h, "type");
    if (!Q_TYPES.has(type)) fail(`question ${id}: unknown type "${type}"`, h.n);
    const difficulty = needInt(h, "difficulty", 1);
    if (difficulty > 3) fail(`question ${id}: difficulty must be 1..3`, h.n);

    let stemLines: string[] = [];
    const options: QuestionOption[] = [];
    let why = "";
    let answer: string | undefined;
    let tolerance: string | undefined;
    let mode: "stem" | "why" | "options" = "stem";
    let sawStem = false;
    let optionCounter = 0;

    for (const { text, n } of block.body) {
        const option = /^- \[( |x|X)\] (.*)$/.exec(text);
        const numbered = /^(\d+)\. (.*)$/.exec(text);
        if (text.startsWith("Stem:")) {
            sawStem = true;
            mode = "stem";
            stemLines = [text.slice("Stem:".length).trim()];
        } else if (option) {
            mode = "options";
            const [label, note] = splitNote(option[2]);
            optionCounter += 1;
            options.push({
                id: `o${optionCounter}`,
                text: label,
                correct: option[1].toLowerCase() === "x",
                ...(note ? { note } : {}),
            });
        } else if (numbered && type === "order") {
            mode = "options";
            optionCounter += 1;
            const [label] = splitNote(numbered[2]);
            options.push({ id: `o${optionCounter}`, text: label });
        } else if (text.startsWith("Answer:")) {
            answer = text.slice("Answer:".length).trim();
        } else if (text.startsWith("Tolerance:")) {
            tolerance = text.slice("Tolerance:".length).trim();
        } else if (text.startsWith("Why:")) {
            mode = "why";
            why = text.slice("Why:".length).trim();
        } else if (mode === "why") {
            why += `${why ? "\n" : ""}${text}`;
        } else if (mode === "stem") {
            stemLines.push(text);
        } else if (text.trim() !== "") {
            fail(`question ${id}: unexpected line "${text}"`, n);
        }
    }

    if (!sawStem || stemLines.join("").trim() === "") fail(`question ${id}: missing Stem:`, h.n);
    if (why.trim() === "") fail(`question ${id}: missing Why:`, h.n);

    const correctCount = options.filter((o) => o.correct).length;
    if (type === "single" && correctCount !== 1) fail(`question ${id}: single needs exactly one [x] (found ${correctCount})`, h.n);
    if (type === "multi" && correctCount < 2) fail(`question ${id}: multi needs at least two [x]`, h.n);
    if ((type === "single" || type === "multi") && (options.length < 3 || options.length > 5)) {
        fail(`question ${id}: ${type} needs 3 to 5 options (found ${options.length})`, h.n);
    }
    if (type === "truefalse") {
        if (options.length !== 2 || correctCount !== 1) fail(`question ${id}: truefalse needs two options with one [x]`, h.n);
    }
    if (type === "order" && options.length < 3) fail(`question ${id}: order needs at least 3 items`, h.n);
    if (type === "number") {
        if (!answer) fail(`question ${id}: number question needs "Answer:"`, h.n);
        if (!/^-?\d+(\.\d+)?$/.test(answer ?? "")) fail(`question ${id}: Answer "${answer}" is not a decimal`, h.n);
        if (tolerance !== undefined && !/^\d+(\.\d+)?$/.test(tolerance)) fail(`question ${id}: bad Tolerance "${tolerance}"`, h.n);
        if (options.length > 0) fail(`question ${id}: number question must not have options`, h.n);
    }

    const lesson = h.attrs.lesson?.trim() || undefined;
    return {
        id,
        module: need(h, "module"),
        type,
        difficulty: difficulty as 1 | 2 | 3,
        critical: needBool(h, "critical"),
        exam: needBool(h, "exam"),
        ...(lesson ? { lesson } : {}),
        tracks: list(need(h, "tracks")),
        refs: list(h.attrs.refs),
        stem: stemLines.join("\n").trim(),
        options,
        ...(answer !== undefined ? { answer } : {}),
        ...(tolerance !== undefined ? { tolerance } : {}),
        why: why.trim(),
    };
};

const splitNote = (value: string): [string, string | undefined] => {
    const sep = value.indexOf(" :: ");
    return sep >= 0 ? [value.slice(0, sep).trim(), value.slice(sep + 4).trim()] : [value.trim(), undefined];
};

// ---------------------------------------------------------------------------------------
// Fenced JSON blocks (labs, exams, lab-vectors)
// ---------------------------------------------------------------------------------------

const fencedJson = (block: Block): unknown => {
    const body = block.body;
    const open = body.findIndex((line) => /^```json\s*$/.test(line.text));
    const close = body.findIndex((line, index) => index > open && /^```\s*$/.test(line.text));
    if (open < 0 || close < 0) return fail(`@@${block.header.kind} ${block.header.attrs.id} needs a fenced json block`, block.header.n);
    try {
        return JSON.parse(body.slice(open + 1, close).map((line) => line.text).join("\n"));
    } catch (error) {
        return fail(`@@${block.header.kind} ${block.header.attrs.id}: invalid JSON (${(error as Error).message})`, block.header.n);
    }
};

// ---------------------------------------------------------------------------------------
// Lab validation (deep: the runner trusts this shape)
// ---------------------------------------------------------------------------------------

const isObj = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const validateLab = (lab: Record<string, unknown>, where: string, n: number): number => {
    for (const key of ["id", "module", "title", "briefing"]) {
        if (typeof lab[key] !== "string" || !(lab[key] as string).trim()) fail(`${where}: lab.${key} must be a non-empty string`, n);
    }
    if (typeof lab.minutes !== "number" || typeof lab.passPercent !== "number") fail(`${where}: lab.minutes and lab.passPercent must be numbers`, n);
    if (!Array.isArray(lab.tasks) || lab.tasks.length === 0) fail(`${where}: lab.tasks must be a non-empty array`, n);
    const taskIds = new Set<string>();
    for (const raw of lab.tasks as unknown[]) {
        if (!isObj(raw)) {
            fail(`${where}: a task is not an object`, n);
            continue;
        }
        const tid = `${where}/${String(raw.id)}`;
        if (typeof raw.id !== "string" || taskIds.has(raw.id)) fail(`${tid}: task id missing or duplicate`, n);
        taskIds.add(raw.id as string);
        if (!LAB_KINDS.has(String(raw.kind))) fail(`${tid}: unknown task kind "${String(raw.kind)}"`, n);
        if (typeof raw.points !== "number" || raw.points <= 0) fail(`${tid}: points must be a positive number`, n);
        if (typeof raw.title !== "string" || typeof raw.prompt !== "string") fail(`${tid}: title and prompt are required`, n);
        if (!Array.isArray(raw.panels)) fail(`${tid}: panels must be an array`, n);
        for (const panel of raw.panels as unknown[]) {
            if (!isObj(panel) || typeof panel.title !== "string") fail(`${tid}: every panel needs a title`, n);
            const shapes = ["rows", "table", "timeline", "text"].filter((key) => (panel as Record<string, unknown>)[key] !== undefined);
            // A title-only panel is a plain scenario statement (spec gap: the Panel type listed a body as mandatory).
            if (shapes.length > 1) fail(`${tid}: panel "${String((panel as Record<string, unknown>).title)}" has more than one of rows/table/timeline/text`, n);
        }
        const options = raw.options as Array<Record<string, unknown>> | undefined;
        switch (raw.kind) {
            case "choice": {
                if (!Array.isArray(options) || options.length < 2) fail(`${tid}: choice needs options`, n);
                const correct = (options ?? []).filter((o) => o.correct === true);
                if (correct.length !== 1) fail(`${tid}: choice needs exactly one correct option (found ${correct.length})`, n);
                for (const o of options ?? []) {
                    if (typeof o.id !== "string" || typeof o.label !== "string" || typeof o.feedback !== "string") fail(`${tid}: choice option needs id/label/feedback`, n);
                }
                break;
            }
            case "multi": {
                if (!Array.isArray(options) || options.length < 3) fail(`${tid}: multi needs options`, n);
                const ids = new Set((options ?? []).map((o) => String(o.id)));
                if ((options ?? []).filter((o) => o.correct === true).length < 1) fail(`${tid}: multi needs at least one correct option`, n);
                for (const id of (raw.criticalWrong as string[] | undefined) ?? []) {
                    if (!ids.has(id)) fail(`${tid}: criticalWrong "${id}" is not an option`, n);
                }
                break;
            }
            case "ledger": {
                const accounts = raw.accounts as string[] | undefined;
                const expected = raw.expected as Array<Record<string, unknown>> | undefined;
                if (!Array.isArray(accounts) || !Array.isArray(expected) || expected.length === 0) fail(`${tid}: ledger needs accounts and expected`, n);
                for (const line of expected ?? []) {
                    if (!accounts?.includes(String(line.account))) fail(`${tid}: expected account "${String(line.account)}" is not in accounts`, n);
                    if (line.side !== "DR" && line.side !== "CR") fail(`${tid}: expected side must be DR or CR`, n);
                    if (typeof line.amount !== "string" || !/^\d+(\.\d+)?$/.test(line.amount)) fail(`${tid}: expected amount must be a decimal string`, n);
                }
                if (typeof raw.feedback !== "string") fail(`${tid}: ledger needs feedback`, n);
                break;
            }
            case "order": {
                const items = raw.items as Array<Record<string, unknown>> | undefined;
                const correctOrder = raw.correctOrder as string[] | undefined;
                if (!Array.isArray(items) || items.length < 3 || !Array.isArray(correctOrder)) fail(`${tid}: order needs items and correctOrder`, n);
                const ids = (items ?? []).map((item) => String(item.id)).sort();
                if (JSON.stringify(ids) !== JSON.stringify([...(correctOrder ?? [])].sort())) fail(`${tid}: correctOrder must be a permutation of the item ids`, n);
                if (typeof raw.feedback !== "string") fail(`${tid}: order needs feedback`, n);
                break;
            }
            case "checklist": {
                const items = raw.items as Array<Record<string, unknown>> | undefined;
                if (!Array.isArray(items) || items.length === 0) fail(`${tid}: checklist needs items`, n);
                const ids = new Set((items ?? []).map((item) => String(item.id)));
                for (const item of items ?? []) {
                    if (typeof item.shouldTick !== "boolean" || typeof item.why !== "string") fail(`${tid}: checklist item needs shouldTick and why`, n);
                }
                for (const id of (raw.criticalWrong as string[] | undefined) ?? []) {
                    if (!ids.has(id)) fail(`${tid}: criticalWrong "${id}" is not an item`, n);
                }
                break;
            }
            case "numeric": {
                if (typeof raw.answer !== "string" || !/^-?\d+(\.\d+)?$/.test(raw.answer)) fail(`${tid}: numeric needs a decimal-string answer`, n);
                if (typeof raw.tolerance !== "string") fail(`${tid}: numeric needs a tolerance string`, n);
                if (typeof raw.feedback !== "string") fail(`${tid}: numeric needs feedback`, n);
                break;
            }
        }
    }
    return (lab.tasks as unknown[]).length;
};

// ---------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------

const stableWrite = (file: string, value: unknown): void => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const main = (): void => {
    if (!existsSync(SOURCE_PATH)) fail(`academy design file not found: ${SOURCE_PATH}`);
    const source = readFileSync(SOURCE_PATH, "utf8").replace(/\r\n/g, "\n");
    const lines: SourceLine[] = source.split("\n").map((text, index) => ({ text, n: index + 1 }));

    const begin = lines.findIndex((line) => line.text === "<!-- CONTENT:BEGIN -->");
    const end = lines.findIndex((line) => line.text === "<!-- CONTENT:END -->");
    if (begin < 0 || end < 0 || end <= begin) fail("missing or inverted CONTENT:BEGIN / CONTENT:END marker lines");

    const guide = loadGuideIndex();

    // 1. Split into blocks.
    const blocks: Block[] = [];
    for (let i = begin + 1; i < end; i += 1) {
        const line = lines[i];
        if (!line.text.startsWith("@@")) continue;
        if (line.text.startsWith("@@end")) fail("@@end without an open block", line.n);
        const header = parseHeader(line);
        if (ONE_LINE_KINDS.has(header.kind)) {
            blocks.push({ header, body: [] });
            continue;
        }
        const body: SourceLine[] = [];
        let closed = false;
        let j = i + 1;
        for (; j < end; j += 1) {
            if (lines[j].text === "@@end") {
                closed = true;
                break;
            }
            if (lines[j].text.startsWith("@@") && /^@@[a-zA-Z_-]+\b/.test(lines[j].text)) break;
            body.push(lines[j]);
        }
        if (!closed) fail(`@@${header.kind} ${header.attrs.id ?? ""} has no @@end`, line.n);
        blocks.push({ header, body });
        i = j;
    }

    const seen = new Map<string, Set<string>>();
    const unique = (kind: string, id: string, n: number): void => {
        const set = seen.get(kind) ?? new Set<string>();
        if (set.has(id)) fail(`duplicate ${kind} id "${id}"`, n);
        set.add(id);
        seen.set(kind, set);
    };

    // 2. Tracks and modules.
    const tracks = blocks
        .filter((b) => b.header.kind === "track")
        .map((b) => {
            const h = b.header;
            const id = need(h, "id");
            unique("track", id, h.n);
            if (!(TRACK_IDS as readonly string[]).includes(id)) fail(`unknown track id "${id}"`, h.n);
            const requiresRaw = need(h, "requires");
            return {
                id: id as TrackId,
                title: need(h, "title"),
                badge: need(h, "badge"),
                hours: need(h, "hours"),
                requires: requiresRaw === "-" ? [] : list(requiresRaw),
                description: h.rest,
            };
        });
    for (const track of tracks) {
        for (const required of track.requires) {
            if (!tracks.some((t) => t.id === required)) fail(`track ${track.id} requires unknown track "${required}"`);
        }
    }

    const modules = blocks
        .filter((b) => b.header.kind === "module")
        .map((b) => {
            const h = b.header;
            const id = need(h, "id");
            unique("module", id, h.n);
            return { id, title: need(h, "title"), minutes: needInt(h, "minutes", 1), objective: h.rest };
        });
    const moduleIds = new Set(modules.map((m) => m.id));
    const checkTracks = (value: string[], where: string, n: number): void => {
        for (const entry of value) {
            if (entry !== "ALL" && !(TRACK_IDS as readonly string[]).includes(entry)) fail(`${where}: unknown track "${entry}"`, n);
        }
    };
    const checkRefs = (value: string[], where: string, n: number): void => {
        for (const ref of value) {
            if (!guide.articles.has(ref)) fail(`${where}: unresolved Guide article id "${ref}"`, n);
        }
    };

    // 3. Questions (parsed first so lessons can resolve their checks).
    const questions = blocks.filter((b) => b.header.kind === "q").map(parseQuestion);
    const questionLine = new Map(blocks.filter((b) => b.header.kind === "q").map((b) => [b.header.attrs.id, b.header.n]));
    for (const q of questions) {
        const n = questionLine.get(q.id) ?? 0;
        unique("question", q.id, n);
        if (!moduleIds.has(q.module)) fail(`question ${q.id}: unknown module "${q.module}"`, n);
        checkTracks(q.tracks, `question ${q.id}`, n);
        checkRefs(q.refs, `question ${q.id}`, n);
    }

    // 4. Lessons.
    const lessons = blocks
        .filter((b) => b.header.kind === "lesson")
        .map((b) => {
            const h = b.header;
            const id = need(h, "id");
            unique("lesson", id, h.n);
            const module = need(h, "module");
            if (!moduleIds.has(module)) fail(`lesson ${id}: unknown module "${module}"`, h.n);
            const tracksList = list(need(h, "tracks"));
            checkTracks(tracksList, `lesson ${id}`, h.n);
            const reading = list(need(h, "reading"));
            checkRefs(reading, `lesson ${id}`, h.n);

            const text = b.body.map((line) => line.text).join("\n").trim();
            const headings = [...text.matchAll(/^### (.+)$/gm)].map((m) => m[1].trim());
            if (JSON.stringify(headings) !== JSON.stringify(LESSON_SECTIONS)) {
                fail(`lesson ${id}: sections must be exactly ${JSON.stringify(LESSON_SECTIONS)} in order (found ${JSON.stringify(headings)})`, h.n);
            }
            const checkLine = /^Questions:\s*(.+)$/m.exec(text);
            if (!checkLine) fail(`lesson ${id}: "### Check yourself" needs a "Questions: …" line`, h.n);
            const checkIds = list((checkLine as RegExpExecArray)[1]);
            if (checkIds.length !== 2) fail(`lesson ${id}: needs exactly two checks (found ${checkIds.length})`, h.n);
            const readNow = [...text.matchAll(/\[\[a:([a-z0-9-]+)(?:\|[^\]]+)?\]\]/g)].map((m) => m[1]);
            const readSection = text.split("### Read now")[1]?.split("### Check yourself")[0] ?? "";
            const readList = [...readSection.matchAll(/\[\[a:([a-z0-9-]+)(?:\|[^\]]+)?\]\]/g)].map((m) => m[1]);
            if (JSON.stringify(readList) !== JSON.stringify(reading)) {
                fail(`lesson ${id}: "### Read now" links ${JSON.stringify(readList)} must equal reading=${JSON.stringify(reading)}`, h.n);
            }
            for (const article of readNow) {
                if (!guide.articles.has(article)) fail(`lesson ${id}: unresolved Guide article "${article}"`, h.n);
            }
            return {
                id,
                module,
                order: needInt(h, "order", 1),
                title: need(h, "title"),
                minutes: needInt(h, "minutes", 1),
                tracks: tracksList,
                reading,
                markdown: text,
                checkIds,
                line: h.n,
            };
        });
    const lessonIds = new Set(lessons.map((l) => l.id));

    // Lesson checks: each lesson names exactly two; each @@q lesson= is named by exactly one lesson.
    const namedBy = new Map<string, string>();
    for (const lesson of lessons) {
        for (const checkId of lesson.checkIds) {
            const q = questions.find((candidate) => candidate.id === checkId);
            if (!q) fail(`lesson ${lesson.id}: unresolved check question "${checkId}"`, lesson.line);
            if (q?.lesson !== lesson.id) fail(`lesson ${lesson.id}: check ${checkId} has lesson="${q?.lesson ?? ""}"`, lesson.line);
            if (namedBy.has(checkId)) fail(`check ${checkId} is named by two lessons (${namedBy.get(checkId)}, ${lesson.id})`, lesson.line);
            namedBy.set(checkId, lesson.id);
        }
    }
    for (const q of questions) {
        if (q.lesson) {
            if (!lessonIds.has(q.lesson)) fail(`question ${q.id}: unknown lesson "${q.lesson}"`, questionLine.get(q.id));
            if (!namedBy.has(q.id)) fail(`question ${q.id}: lesson check not named by any lesson`, questionLine.get(q.id));
        }
    }

    // 5. Labs.
    let labTaskCount = 0;
    const labs = blocks
        .filter((b) => b.header.kind === "lab")
        .map((b) => {
            const h = b.header;
            const id = need(h, "id");
            unique("lab", id, h.n);
            const json = fencedJson(b);
            if (!isObj(json)) return fail(`lab ${id}: JSON must be an object`, h.n);
            if (json.id !== id) fail(`lab ${id}: JSON id "${String(json.id)}" differs from the header`, h.n);
            if (!moduleIds.has(String(json.module))) fail(`lab ${id}: unknown module "${String(json.module)}"`, h.n);
            if (String(json.module) !== need(h, "module")) fail(`lab ${id}: JSON module differs from the header`, h.n);
            const labTracks = list(need(h, "tracks"));
            checkTracks(labTracks, `lab ${id}`, h.n);
            const refs = list(h.attrs.refs);
            checkRefs(refs, `lab ${id}`, h.n);
            labTaskCount += validateLab(json, `lab ${id}`, h.n);
            return { ...(json as Record<string, unknown>), tracks: labTracks, refs } as Record<string, unknown> & { id: string; module: string; tracks: string[] };
        });

    // 6. Exams.
    const exams = blocks
        .filter((b) => b.header.kind === "exam")
        .map((b) => {
            const h = b.header;
            const id = need(h, "id");
            unique("exam", id, h.n);
            const json = fencedJson(b);
            if (!isObj(json)) return fail(`exam ${id}: JSON must be an object`, h.n);
            const track = need(h, "track");
            if (json.id !== id || json.track !== track) fail(`exam ${id}: JSON id/track differ from the header`, h.n);
            if (!tracks.some((t) => t.id === track)) fail(`exam ${id}: unknown track "${track}"`, h.n);
            for (const key of ["questionCount", "passPercent", "timeLimitMinutes", "criticalPick", "cooldownMinutes"]) {
                if (typeof json[key] !== "number") fail(`exam ${id}: "${key}" must be a number`, h.n);
            }
            const composition = json.composition as Array<{ module: string; count: number }>;
            if (!Array.isArray(composition) || composition.length === 0) fail(`exam ${id}: composition is required`, h.n);
            for (const entry of composition) {
                if (!moduleIds.has(entry.module)) fail(`exam ${id}: composition names unknown module "${entry.module}"`, h.n);
            }
            return json as {
                id: string;
                track: TrackId;
                questionCount: number;
                passPercent: number;
                timeLimitMinutes: number;
                composition: Array<{ module: string; count: number }>;
                criticalPick: number;
                cooldownMinutes: number;
            };
        });

    // 7. Drills and pages.
    const drills = blocks
        .filter((b) => b.header.kind === "drill")
        .map((b) => {
            const h = b.header;
            const id = need(h, "id");
            unique("drill", id, h.n);
            const refs = list(h.attrs.refs);
            checkRefs(refs, `drill ${id}`, h.n);
            const markdown = resolveLinks(b.body.map((l) => l.text).join("\n").trim(), guide, `drill ${id}`, h.n);
            return { id, title: need(h, "title"), rail: need(h, "rail"), minutes: needInt(h, "minutes", 1), refs, markdown, html: renderMarkdown(markdown), plainText: plainText(markdown) };
        });

    let labVectors: unknown = null;
    const pages = blocks
        .filter((b) => b.header.kind === "page")
        .map((b) => {
            const h = b.header;
            const id = need(h, "id");
            unique("page", id, h.n);
            if (id === "lab-vectors") {
                labVectors = fencedJson(b);
                return { id, title: need(h, "title"), markdown: "", html: "", plainText: "" };
            }
            const markdown = resolveLinks(b.body.map((l) => l.text).join("\n").trim(), guide, `page ${id}`, h.n);
            return { id, title: need(h, "title"), markdown, html: renderMarkdown(markdown), plainText: plainText(markdown) };
        });
    if (!labVectors) fail('missing @@page id=lab-vectors');

    // 8. Cross-references that need everything parsed.
    const labIds = new Set(labs.map((lab) => lab.id));
    const examByTrack = new Map(exams.map((e) => [e.track as string, e.id]));
    for (const track of tracks) {
        if (!examByTrack.has(track.id)) fail(`track ${track.id} has no exam`);
    }
    if (exams.length !== new Set(exams.map((e) => e.track)).size) fail("two exams share a track");

    // 9. Derive module/track membership.
    const inTrack = (list: string[], track: string): boolean => list.includes(track) || list.includes("ALL");
    const sortedLessons = [...lessons].sort((a, b) => {
        const am = modules.findIndex((m) => m.id === a.module);
        const bm = modules.findIndex((m) => m.id === b.module);
        return am - bm || a.order - b.order;
    });
    const moduleOut = modules.map((m) => ({
        ...m,
        lessonIds: sortedLessons.filter((l) => l.module === m.id).map((l) => l.id),
        labIds: labs.filter((lab) => lab.module === m.id).map((lab) => lab.id),
    }));
    for (const m of moduleOut) {
        if (m.lessonIds.length === 0) fail(`module ${m.id} has no lessons`);
    }
    const trackOut = tracks.map((track) => {
        const trackLessons = sortedLessons.filter((l) => inTrack(l.tracks, track.id));
        const trackLabs = labs.filter((lab) => inTrack(lab.tracks, track.id));
        const moduleOrder = modules
            .map((m) => m.id)
            .filter((id) => trackLessons.some((l) => l.module === id) || trackLabs.some((lab) => lab.module === id));
        return {
            ...track,
            moduleIds: moduleOrder,
            lessonIds: trackLessons.map((l) => l.id),
            labIds: trackLabs.map((lab) => lab.id),
            examId: examByTrack.get(track.id) as string,
        };
    });
    for (const track of trackOut) {
        if (track.lessonIds.length === 0) fail(`track ${track.id} has no lessons`);
    }

    // 10. Outputs.
    const checks = questions.filter((q) => q.lesson);
    const pool = questions.filter((q) => q.exam);
    const leaked = questions.filter((q) => q.lesson && q.exam);
    if (leaked.length > 0) fail(`question ${leaked[0].id} is both a lesson check and an exam-pool question`);
    const orphans = questions.filter((q) => !q.lesson && !q.exam);
    if (orphans.length > 0) fail(`question ${orphans[0].id} is neither a lesson check (lesson=) nor an exam-pool question (exam=true)`);

    const regionText = lines.slice(begin + 1, end).map((l) => l.text).join("\n");
    const contentHash = createHash("sha256").update(regionText).digest("hex");
    const counts = {
        tracks: tracks.length,
        modules: modules.length,
        lessons: lessons.length,
        lessonChecks: checks.length,
        examPoolQuestions: pool.length,
        examPoolSingle: pool.filter((q) => q.type === "single").length,
        examPoolNumber: pool.filter((q) => q.type === "number").length,
        examPoolOrder: pool.filter((q) => q.type === "order").length,
        criticalExamPoolQuestions: pool.filter((q) => q.critical).length,
        labs: labs.length,
        labTasks: labTaskCount,
        exams: exams.length,
        drills: drills.length,
        pages: pages.length,
    };
    const epoch = process.env.SOURCE_DATE_EPOCH ? Number(process.env.SOURCE_DATE_EPOCH) * 1000 : 0;
    const generatedAt = new Date(epoch).toISOString();

    const lessonOut = sortedLessons.map((lesson) => {
        const markdown = resolveLinks(lesson.markdown, guide, `lesson ${lesson.id}`, lesson.line);
        return {
            id: lesson.id,
            module: lesson.module,
            order: lesson.order,
            title: lesson.title,
            minutes: lesson.minutes,
            tracks: lesson.tracks,
            reading: lesson.reading,
            body: lesson.markdown,
            html: renderMarkdown(markdown),
            plainText: plainText(markdown),
            checkIds: lesson.checkIds,
        };
    });

    const publicQuestion = (q: Question) => ({
        id: q.id,
        module: q.module,
        type: q.type,
        difficulty: q.difficulty,
        critical: q.critical,
        lesson: q.lesson,
        refs: q.refs,
        stem: q.stem,
        options: q.options,
        ...(q.answer !== undefined ? { answer: q.answer } : {}),
        ...(q.tolerance !== undefined ? { tolerance: q.tolerance } : {}),
        why: q.why,
    });

    stableWrite(path.join(OUTPUT_DIR, "meta.json"), {
        contentVersion: CONTENT_VERSION,
        recertifyFrom: RECERTIFY_FROM,
        generatedAt,
        contentHash,
        counts,
    });
    stableWrite(path.join(OUTPUT_DIR, "tracks.json"), trackOut);
    stableWrite(path.join(OUTPUT_DIR, "modules.json"), moduleOut);
    stableWrite(path.join(OUTPUT_DIR, "lessons.en.json"), lessonOut);
    stableWrite(path.join(OUTPUT_DIR, "checks.en.json"), checks.map(publicQuestion));
    stableWrite(path.join(OUTPUT_DIR, "labs.en.json"), labs);
    stableWrite(path.join(OUTPUT_DIR, "drills.en.json"), drills);
    stableWrite(path.join(OUTPUT_DIR, "pages.en.json"), pages.filter((p) => p.id !== "lab-vectors"));
    stableWrite(path.join(OUTPUT_DIR, "lab-vectors.json"), labVectors);
    stableWrite(
        path.join(OUTPUT_DIR, "exam-blueprints.public.json"),
        exams.map((e) => ({
            id: e.id,
            track: e.track,
            questionCount: e.questionCount,
            passPercent: e.passPercent,
            timeLimitMinutes: e.timeLimitMinutes,
            cooldownMinutes: e.cooldownMinutes,
            composition: e.composition,
        })),
    );

    // Server-side catalog: what each track requires (eligibility, team view). No question content.
    stableWrite(CATALOG_PATH, {
        contentVersion: CONTENT_VERSION,
        recertifyFrom: RECERTIFY_FROM,
        contentHash,
        tracks: trackOut.map((t) => ({
            id: t.id,
            badge: t.badge,
            requires: t.requires,
            moduleIds: t.moduleIds,
            lessonIds: t.lessonIds,
            labIds: t.labIds,
            examId: t.examId,
        })),
        modules: moduleOut.map((m) => ({ id: m.id, title: m.title, lessonIds: m.lessonIds, labIds: m.labIds })),
        lessons: sortedLessons.map((l) => ({ id: l.id, module: l.module, title: l.title })),
        labs: labs.map((lab) => ({ id: lab.id, module: lab.module, title: String(lab.title), passPercent: lab.passPercent })),
    });

    stableWrite(EXAM_BANK_PATH, {
        contentVersion: CONTENT_VERSION,
        contentHash,
        blueprints: exams,
        questions: pool.map((q) => ({
            id: q.id,
            module: q.module,
            type: q.type,
            difficulty: q.difficulty,
            critical: q.critical,
            tracks: q.tracks,
            refs: q.refs,
            stem: q.stem,
            options: q.options,
            ...(q.answer !== undefined ? { answer: q.answer } : {}),
            ...(q.tolerance !== undefined ? { tolerance: q.tolerance } : {}),
            why: q.why,
        })),
    });

    console.log(
        `extract-academy-content: ${counts.tracks} tracks, ${counts.modules} modules, ${counts.lessons} lessons, ` +
            `${counts.lessonChecks} checks, ${counts.examPoolQuestions} exam-pool questions (${counts.criticalExamPoolQuestions} critical), ` +
            `${counts.labs} labs / ${counts.labTasks} tasks, ${counts.exams} exams, ${counts.drills} drills, ${counts.pages} pages`,
    );
    const mismatches = (Object.keys(EXPECTED_COUNTS) as Array<keyof typeof EXPECTED_COUNTS>).filter(
        (key) => counts[key] !== EXPECTED_COUNTS[key],
    );
    if (mismatches.length > 0) {
        console.warn(
            `extract-academy-content: count differs from spec II-2.5 → ${mismatches
                .map((key) => `${key}: ${counts[key]} (expected ${EXPECTED_COUNTS[key]})`)
                .join(", ")}`,
        );
    }
};

main();
