import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, describe, expect, test } from "vitest";

const REPO_ROOT = resolve(process.cwd(), "..");
const GENERATED_DIR = join(REPO_ROOT, "admin-front/src/content/guide/generated");
const ROUTER_FILE = join(REPO_ROOT, "admin-front/src/router/index.ts");

const EXPECTED_COUNTS = {
    books: 14,
    articles: 134,
    glossaryTerms: 151,
    safeguardCards: 25,
    safeguardChecklistItems: 112,
    situations: 32,
    readingPaths: 8,
    quickAnswers: 58,
    dataBlocks: 3,
    contextMapScreens: 25,
    errorCodes: 19,
    edgeCases: 140,
};

const EXPECTED_CARD_IDS = [
    "sg-approve-request",
    "sg-reject-request",
    "sg-propose-adjustment",
    "sg-reverse-adjustment",
    "sg-process-cashout",
    "sg-reject-cashout",
    "sg-resolve-unknown",
    "sg-release-reservation",
    "sg-bulk-inquiry",
    "sg-approve-join-request",
    "sg-reject-join-request",
    "sg-suspend-merchant",
    "sg-reinstate-merchant",
    "sg-edit-merchant-sensitive",
    "sg-aml-propose-resolution",
    "sg-aml-disposition",
    "sg-aml-rule-change",
    "sg-aml-report",
    "sg-submit-gateway-version",
    "sg-edit-route",
    "sg-ai-import-draft",
    "sg-run-reconciliation",
    "sg-trigger-backup",
    "sg-run-restore-drill",
    "sg-update-backup-policy",
];

const readJson = <T>(name: string): T =>
    JSON.parse(readFileSync(join(GENERATED_DIR, name), "utf8")) as T;

const tempDirectory = mkdtempSync(join(tmpdir(), "guide-content-"));

afterAll(() => {
    rmSync(tempDirectory, { recursive: true, force: true });
});

describe("guide content extractor", () => {
    test("re-running the extractor produces byte-identical committed JSON", () => {
        execFileSync("bun", [join(REPO_ROOT, "admin-front/scripts/extract-guide-content.ts")], {
            cwd: REPO_ROOT,
            env: { ...process.env, GUIDE_OUTPUT_DIR: tempDirectory },
            stdio: "pipe",
        });
        const files = readdirSync(GENERATED_DIR).filter((name) => name.endsWith(".json")).sort();
        expect(files.length).toBeGreaterThan(0);
        for (const file of files) {
            const generated = readFileSync(join(tempDirectory, file));
            const committed = readFileSync(join(GENERATED_DIR, file));
            expect(
                Buffer.compare(generated, committed),
                `${file} is not byte-identical; run bun run content:guide`,
            ).toBe(0);
        }
    });

    test("meta counts equal the design contract", () => {
        const meta = readJson<{ counts: typeof EXPECTED_COUNTS }>("meta.json");
        expect(meta.counts).toEqual(EXPECTED_COUNTS);
    });

    test("articles are non-empty and contain no external URLs", () => {
        const articles = readJson<Array<{ id: string; body: string; related: string[] }>>(
            "articles.en.json",
        );
        const ids = new Set(articles.map((article) => article.id));
        for (const article of articles) {
            expect(article.body.trim().length, `${article.id} body`).toBeGreaterThan(0);
            expect(article.body, `${article.id} external URL`).not.toMatch(/https?:\/\//);
            for (const related of article.related) {
                expect(ids.has(related), `${article.id} -> ${related}`).toBe(true);
            }
        }
    });

    test("glossary slugs are unique and every term is linked from a valid collection", () => {
        const terms = readJson<Array<{ slug: string; related: string[] }>>("glossary.en.json");
        const slugs = terms.map((term) => term.slug);
        expect(new Set(slugs).size).toBe(slugs.length);
        const slugSet = new Set(slugs);
        for (const term of terms) {
            for (const related of term.related) {
                expect(slugSet.has(related), `${term.slug} -> ${related}`).toBe(true);
            }
        }
    });

    test("every safeguard card has the required checklist and card id", () => {
        const cards = readJson<Array<{ id: string; checklist: string[] }>>("cards.en.json");
        const ids = cards.map((card) => card.id);
        expect(ids.sort()).toEqual([...EXPECTED_CARD_IDS].sort());
        for (const card of cards) {
            expect(card.checklist.length, `${card.id} checklist`).toBeGreaterThan(0);
        }
    });

    test("every router name except Login/NotFound has a context-map screen", () => {
        const routerSource = readFileSync(ROUTER_FILE, "utf8");
        const routeNames = [...routerSource.matchAll(/name:\s*"([^"]+)"/g)].map(
            (match) => match[1],
        );
        const unique = [...new Set(routeNames)].filter(
            (name) => name !== "Login" && name !== "NotFound",
        );
        const map = readJson<{
            fallbackScreenId: string;
            screens: Array<{ screenId: string; routeNames: string[] }>;
        }>("context-map.json");
        const mapped = new Set(map.screens.flatMap((screen) => screen.routeNames));
        expect(map.screens.some((screen) => screen.screenId === map.fallbackScreenId)).toBe(true);
        const missing = unique.filter((name) => !mapped.has(name));
        expect(missing, `routes without context-map coverage: ${missing.join(", ")}`).toEqual([]);
    });

    test("every widget placeholder has an implemented component", () => {
        const articles = readJson<Array<{ body: string }>>("articles.en.json");
        const usedWidgets = new Set<string>();
        for (const article of articles) {
            for (const match of article.body.matchAll(/\{\{widget:([a-z0-9-]+)\}\}/g)) {
                usedWidgets.add(match[1]);
            }
        }
        const implemented = new Set([
            "transform-sandbox",
            "crypto-lab",
            "ledger-explorer",
            "visible-rails",
            "attempt-states",
        ]);
        for (const widget of usedWidgets) {
            expect(implemented.has(widget), `widget ${widget}`).toBe(true);
        }
    });

    test("total gzip size of generated JSON stays below 400 KB", () => {
        const files = readdirSync(GENERATED_DIR).filter((name) => name.endsWith(".json"));
        const total = files.reduce(
            (sum, file) => sum + gzipSync(readFileSync(join(GENERATED_DIR, file))).byteLength,
            0,
        );
        expect(total).toBeLessThan(400 * 1024);
    });

    test("the design source file exists in the repository", () => {
        const candidates = [
            join(REPO_ROOT, "design/07-guides-and-academy/guide_system_design_and_content.md"),
        ];
        expect(candidates.some((candidate) => existsSync(candidate))).toBe(true);
    });

    test("inline guide references keep short labels", () => {
        execFileSync(
            "bun",
            [join(REPO_ROOT, "scripts/overhaul-guide-and-academy-clarity.ts"), "--check"],
            { cwd: REPO_ROOT, stdio: "pipe" },
        );
    });
});
