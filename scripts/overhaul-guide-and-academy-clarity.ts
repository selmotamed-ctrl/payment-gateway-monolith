#!/usr/bin/env bun
/**
 * Keep Guide and Academy inline cross-references readable.
 *
 * The readers extract parenthetical references such as `(see [[a:b02-06]])`
 * into a clean section tray at render time, so this script only labels bare
 * links that remain in prose and reading lists. Without a label the reader
 * would inject the target's full 10-to-15-word title into the sentence.
 * Table cells stay bare: a `|` inside a link label would split the cell, and
 * the readers shorten bare table links at render time.
 *
 * It is deliberately idempotent: run it with `--check` in a verification step
 * and without flags to rewrite the two canonical content files.
 */
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

const REF_RE = /\[\[([acgs]):([a-z0-9-]+)(?:\|([^\]]+))?\]\]/g;
const BLOCK_START_RE = /^@@(article|card|situation|lesson|faq)\b/;

interface LabelMaps {
    articles: Map<string, string>;
    cards: Map<string, string>;
    situations: Map<string, string>;
    terms: Map<string, string>;
}

const shortArticleLabel = (title: string): string => {
    const trimmed = title.trim();
    if (!trimmed) return "";
    const colon = trimmed.indexOf(":");
    if (colon > 0) return trimmed.slice(0, colon).trim();
    const words = trimmed.split(/\s+/);
    return words.length > 12 ? words.slice(0, 12).join(" ") : trimmed;
};

const attribute = (header: string, name: string): string | undefined =>
    new RegExp(`\\b${name}="((?:[^"\\\\]|\\\\.)*)"`).exec(header)?.[1];

const buildLabelMaps = (source: string): LabelMaps => {
    const maps: LabelMaps = {
        articles: new Map(),
        cards: new Map(),
        situations: new Map(),
        terms: new Map(),
    };
    for (const line of source.split("\n")) {
        if (line.startsWith("@@article ")) {
            const id = /\bid=([a-z0-9-]+)/.exec(line)?.[1];
            const title = attribute(line, "title");
            if (id && title) maps.articles.set(id, shortArticleLabel(title));
        } else if (line.startsWith("@@card ")) {
            const id = /\bid=([a-z0-9-]+)/.exec(line)?.[1];
            const title = attribute(line, "title");
            if (id && title) maps.cards.set(id, title);
        } else if (line.startsWith("@@situation ")) {
            const id = /\bid=([a-z0-9-]+)/.exec(line)?.[1];
            const title = attribute(line, "title");
            if (id && title) maps.situations.set(id, title);
        } else if (line.startsWith("@@term ")) {
            const slug = /\bslug=([a-z0-9-]+)/.exec(line)?.[1];
            const term = attribute(line, "term");
            if (slug && term) maps.terms.set(slug, term);
        }
    }
    return maps;
};

const labelFor = (maps: LabelMaps, kind: string, id: string): string | undefined => {
    if (kind === "a") return maps.articles.get(id);
    if (kind === "c") return maps.cards.get(id);
    if (kind === "s") return maps.situations.get(id);
    if (kind === "g") return maps.terms.get(id);
    return undefined;
};

const labelLine = (line: string, maps: LabelMaps): string => {
    if (!line.includes("[[")) return line;
    return line
        .split(/(`[^`]*`)/g)
        .map((part, index) => {
            if (index % 2 === 1) return part;
            return part.replace(REF_RE, (full, kind: string, id: string, label?: string) => {
                if (label) return full;
                const short = labelFor(maps, kind, id);
                return short ? `[[${kind}:${id}|${short}]]` : full;
            });
        })
        .join("");
};

interface ProcessResult {
    text: string;
    changedLines: number;
    labelled: number;
    unresolved: string[];
}

const processSource = (source: string, maps: LabelMaps): ProcessResult => {
    const normalized = source.replace(/\r\n/g, "\n");
    const lines = normalized.split("\n");
    const output: string[] = [];
    let inBody = false;
    let insideFence = false;
    let changedLines = 0;
    let labelled = 0;
    const unresolved = new Set<string>();

    for (const line of lines) {
        if (BLOCK_START_RE.test(line)) {
            inBody = true;
            output.push(line);
            continue;
        }
        if (line.startsWith("@@body")) {
            inBody = true;
            output.push(line);
            continue;
        }
        if (line.startsWith("@@end")) {
            inBody = false;
            output.push(line);
            continue;
        }
        if (!inBody) {
            output.push(line);
            continue;
        }

        if (line.trim().startsWith("```")) {
            insideFence = !insideFence;
            output.push(line);
            continue;
        }
        if (insideFence) {
            output.push(line);
            continue;
        }

        // Table cells must stay unlabelled: a `|` inside `[[kind:id|label]]`
        // would split the cell. The readers shorten bare table links instead.
        if (line.trim().startsWith("|")) {
            output.push(line);
            continue;
        }

        const before = [...line.matchAll(REF_RE)].length;
        const next = labelLine(line, maps);
        if (next !== line) {
            changedLines += 1;
            const after = [...next.matchAll(REF_RE)].filter((match) => !match[3]).length;
            labelled += Math.max(0, before - after);
            output.push(next);
        } else {
            output.push(line);
        }
        for (const match of next.matchAll(REF_RE)) {
            if (!match[3]) {
                const short = labelFor(maps, match[1]!, match[2]!);
                if (!short) unresolved.add(`${match[1]}:${match[2]}`);
            }
        }
    }

    return {
        text: output.join("\n"),
        changedLines,
        labelled,
        unresolved: [...unresolved],
    };
};

const main = (): void => {
    const check = process.argv.includes("--check");
    const guideSource = readFileSync(GUIDE_PATH, "utf8");
    const academySource = readFileSync(ACADEMY_PATH, "utf8");
    const maps = buildLabelMaps(guideSource);

    const guide = processSource(guideSource, maps);
    const academy = processSource(academySource, maps);
    const changed = guide.changedLines > 0 || academy.changedLines > 0;
    const unresolved = [...new Set([...guide.unresolved, ...academy.unresolved])];

    if (check) {
        if (changed) {
            console.error(
                `clarity: inline references need labels (guide ${guide.changedLines} lines, academy ${academy.changedLines} lines). Run bun scripts/overhaul-guide-and-academy-clarity.ts`,
            );
            process.exit(1);
        }
        console.log("clarity: inline references are labelled");
    } else if (changed) {
        writeFileSync(GUIDE_PATH, guide.text, "utf8");
        writeFileSync(ACADEMY_PATH, academy.text, "utf8");
        console.log(
            `clarity: labelled ${guide.labelled + academy.labelled} references on ${
                guide.changedLines + academy.changedLines
            } lines`,
        );
    } else {
        console.log("clarity: nothing to change");
    }

    if (unresolved.length > 0) {
        console.error(`clarity: unresolved reference targets: ${unresolved.join(", ")}`);
        process.exit(1);
    }
};

main();
