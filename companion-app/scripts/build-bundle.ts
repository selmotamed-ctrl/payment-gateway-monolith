#!/usr/bin/env bun
/**
 * Validate canonical extractor output and write the mobile content snapshot.
 *
 * The bundle is the only content input to the application. It deliberately
 * excludes the exam question bank and the server catalog.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
    ACADEMY_CACHE_DIR,
    BUNDLE_PATH,
    EXAM_BANK_CACHE_PATH,
    GUIDE_CACHE_DIR,
    MANIFEST_PATH,
    PUBLIC_CONTENT_DIR,
} from "./paths";

const SCHEMA = 1;
const APP_ID = "ly.paymentgateway.companion";

const fail = (message: string): never => {
    throw new Error(`content: ${message}`);
};

const readJson = (dir: string, file: string): any => {
    const path = join(dir, file);
    if (!existsSync(path)) fail(`missing extracted file ${path}`);
    try {
        return JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
        fail(`invalid JSON in ${path}: ${(error as Error).message}`);
    }
};

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) fail(message);
}

const asArray = (value: unknown, label: string): any[] => {
    assert(Array.isArray(value) && value.length > 0, `${label} must be a non-empty array`);
    return value;
};

const idsOf = (items: any[], label: string, key = "id"): Set<string> => {
    const ids = new Set<string>();
    for (const item of items) {
        const id = String(item?.[key] ?? "");
        assert(id.length > 0, `${label} contains an item without ${key}`);
        assert(!ids.has(id), `${label} has duplicate ${key} ${id}`);
        ids.add(id);
    }
    return ids;
};

const walkStrings = (value: unknown, visit: (text: string, path: string) => void, path = "$"): void => {
    if (typeof value === "string") {
        visit(value, path);
        return;
    }
    if (Array.isArray(value)) {
        value.forEach((item, index) => walkStrings(item, visit, `${path}[${index}]`));
        return;
    }
    if (value && typeof value === "object") {
        for (const [key, item] of Object.entries(value)) {
            walkStrings(item, visit, `${path}.${key}`);
        }
    }
};

const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

const main = (): void => {
    const guideDir = process.env.COMPANION_GUIDE_DIR?.trim()
        ? resolve(process.env.COMPANION_GUIDE_DIR)
        : GUIDE_CACHE_DIR;
    const academyDir = process.env.COMPANION_ACADEMY_DIR?.trim()
        ? resolve(process.env.COMPANION_ACADEMY_DIR)
        : ACADEMY_CACHE_DIR;
    const guideMeta = readJson(guideDir, "meta.json");
    const academyMeta = readJson(academyDir, "meta.json");

    const books = asArray(readJson(guideDir, "books.json"), "books");
    const articles = asArray(readJson(guideDir, "articles.en.json"), "articles");
    const glossary = asArray(readJson(guideDir, "glossary.en.json"), "glossary");
    const cards = asArray(readJson(guideDir, "cards.en.json"), "cards");
    const playbook = asArray(readJson(guideDir, "playbook.en.json"), "playbook");
    const paths = asArray(readJson(guideDir, "paths.json"), "paths");
    const faq = asArray(readJson(guideDir, "faq.en.json"), "faq");
    const data = readJson(guideDir, "data.json");
    const errorCodes = asArray(readJson(guideDir, "error-codes.en.json"), "errorCodes");
    const edgeCases = asArray(readJson(guideDir, "edge-cases.en.json"), "edgeCases");

    const tracks = asArray(readJson(academyDir, "tracks.json"), "tracks");
    const modules = asArray(readJson(academyDir, "modules.json"), "modules");
    const lessons = asArray(readJson(academyDir, "lessons.en.json"), "lessons");
    const checks = asArray(readJson(academyDir, "checks.en.json"), "checks");
    const labs = asArray(readJson(academyDir, "labs.en.json"), "labs");
    const drills = asArray(readJson(academyDir, "drills.en.json"), "drills");
    const pages = asArray(readJson(academyDir, "pages.en.json"), "pages");
    const examBlueprints = asArray(
        readJson(academyDir, "exam-blueprints.public.json"),
        "examBlueprints",
    );

    // ---- fixed counts from the canonical extractors --------------------------------
    assert(guideMeta.counts?.books === books.length, "book count does not match guide meta");
    assert(guideMeta.counts?.articles === articles.length, "article count does not match guide meta");
    assert(guideMeta.counts?.glossaryTerms === glossary.length, "glossary count does not match guide meta");
    assert(guideMeta.counts?.safeguardCards === cards.length, "card count does not match guide meta");
    assert(guideMeta.counts?.situations === playbook.length, "playbook count does not match guide meta");
    assert(guideMeta.counts?.readingPaths === paths.length, "path count does not match guide meta");
    assert(guideMeta.counts?.quickAnswers === faq.length, "FAQ count does not match guide meta");
    assert(guideMeta.counts?.errorCodes === errorCodes.length, "error-code count does not match guide meta");
    assert(guideMeta.counts?.edgeCases === edgeCases.length, "edge-case count does not match guide meta");

    assert(academyMeta.counts?.tracks === tracks.length, "track count does not match academy meta");
    assert(academyMeta.counts?.modules === modules.length, "module count does not match academy meta");
    assert(academyMeta.counts?.lessons === lessons.length, "lesson count does not match academy meta");
    assert(academyMeta.counts?.lessonChecks === checks.length, "check count does not match academy meta");
    assert(academyMeta.counts?.labs === labs.length, "lab count does not match academy meta");
    assert(academyMeta.counts?.drills === drills.length, "drill count does not match academy meta");
    assert(academyMeta.counts?.exams === examBlueprints.length, "exam count does not match academy meta");

    const articleIds = idsOf(articles, "articles");
    const bookIds = idsOf(books, "books");
    const glossaryIds = idsOf(glossary, "glossary", "slug");
    const cardIds = idsOf(cards, "cards");
    const situationIds = idsOf(playbook, "playbook");
    const edgeCaseNumbers = new Set(edgeCases.map((entry) => Number(entry.n)));
    const trackIds = idsOf(tracks, "tracks");
    const moduleIds = idsOf(modules, "modules");
    const lessonIds = idsOf(lessons, "lessons");
    const checkIds = idsOf(checks, "checks");
    const labIds = idsOf(labs, "labs");
    const blueprintIds = idsOf(examBlueprints, "examBlueprints");

    for (const article of articles) {
        assert(bookIds.has(String(article.book)), `article ${article.id} references unknown book ${article.book}`);
        for (const related of article.related ?? []) {
            assert(articleIds.has(related), `article ${article.id} references unknown related article ${related}`);
        }
    }
    for (const path of paths) {
        for (const articleId of path.articles ?? []) {
            assert(articleIds.has(articleId), `reading path ${path.role} references unknown article ${articleId}`);
        }
    }
    for (const answer of faq) {
        assert(articleIds.has(answer.article), `FAQ ${answer.id} references unknown article ${answer.article}`);
    }
    for (const situation of playbook) {
        for (const articleId of situation.articles ?? []) {
            assert(articleIds.has(articleId), `situation ${situation.id} references unknown article ${articleId}`);
        }
        for (const edgeCase of situation.cases ?? []) {
            assert(edgeCaseNumbers.has(Number(edgeCase)), `situation ${situation.id} references unknown case ${edgeCase}`);
        }
    }
    for (const term of glossary) {
        for (const related of term.related ?? []) {
            assert(glossaryIds.has(related), `term ${term.slug} references unknown term ${related}`);
        }
    }

    for (const track of tracks) {
        for (const moduleId of track.moduleIds ?? []) {
            assert(moduleIds.has(moduleId), `track ${track.id} references unknown module ${moduleId}`);
        }
        for (const lessonId of track.lessonIds ?? []) {
            assert(lessonIds.has(lessonId), `track ${track.id} references unknown lesson ${lessonId}`);
        }
        for (const labId of track.labIds ?? []) {
            assert(labIds.has(labId), `track ${track.id} references unknown lab ${labId}`);
        }
        assert(blueprintIds.has(track.examId), `track ${track.id} references unknown exam ${track.examId}`);
    }
    for (const module of modules) {
        for (const lessonId of module.lessonIds ?? []) {
            assert(lessonIds.has(lessonId), `module ${module.id} references unknown lesson ${lessonId}`);
        }
        for (const labId of module.labIds ?? []) {
            assert(labIds.has(labId), `module ${module.id} references unknown lab ${labId}`);
        }
    }
    for (const lesson of lessons) {
        assert(moduleIds.has(lesson.module), `lesson ${lesson.id} references unknown module ${lesson.module}`);
        for (const articleId of lesson.reading ?? []) {
            assert(articleIds.has(articleId), `lesson ${lesson.id} references unknown article ${articleId}`);
        }
        for (const checkId of lesson.checkIds ?? []) {
            assert(checkIds.has(checkId), `lesson ${lesson.id} references unknown check ${checkId}`);
        }
    }
    for (const check of checks) {
        assert(moduleIds.has(check.module), `check ${check.id} references unknown module ${check.module}`);
    }
    for (const lab of labs) {
        assert(moduleIds.has(lab.module), `lab ${lab.id} references unknown module ${lab.module}`);
        for (const ref of lab.refs ?? []) {
            assert(articleIds.has(ref), `lab ${lab.id} references unknown article ${ref}`);
        }
    }
    for (const blueprint of examBlueprints) {
        assert(trackIds.has(blueprint.track), `exam ${blueprint.id} references unknown track ${blueprint.track}`);
    }

    const guide = {
        books,
        articles,
        glossary,
        cards,
        playbook,
        paths,
        faq,
        data,
        errorCodes,
        edgeCases,
    };
    const academy = {
        meta: academyMeta,
        tracks,
        modules,
        lessons,
        checks,
        labs,
        drills,
        pages,
        examBlueprints,
    };

    // ---- cross-document links, URLs and secrets -----------------------------------
    const linkTargets: Record<string, Set<string>> = {
        a: articleIds,
        c: cardIds,
        s: situationIds,
        g: glossaryIds,
    };
    walkStrings({ guide, academy }, (text, path) => {
        if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) {
            fail(`private-key marker found at ${path}`);
        }
        if (/https?:\/\//i.test(text)) {
            fail(`external URL found at ${path}`);
        }
        if (/postgres(?:ql)?:\/\/[^\s"]+:[^\s"]+@/i.test(text)) {
            fail(`credential-shaped database URL found at ${path}`);
        }
        for (const match of text.matchAll(/\[\[([acgs]):([a-z0-9-]+)(?:\|[^\]]+)?\]\]/g)) {
            const kind = match[1]!;
            const id = match[2]!;
            if (!linkTargets[kind]?.has(id)) {
                fail(`unresolved internal link ${kind}:${id} at ${path}`);
            }
        }
    });

    // ---- exam bank must never be in learner content ------------------------------
    const examBankPath = process.env.COMPANION_EXAM_BANK_PATH?.trim() || EXAM_BANK_CACHE_PATH;
    if (existsSync(examBankPath)) {
        const examBank = JSON.parse(readFileSync(examBankPath, "utf8")) as {
            questions?: Array<{ id?: string; stem?: string }>;
        };
        const serialised = JSON.stringify({ guide, academy });
        for (const question of examBank.questions ?? []) {
            if (question.id && serialised.includes(question.id)) {
                fail(`exam question id ${question.id} leaked into the learner bundle`);
            }
        }
    }

    const counts = {
        ...guideMeta.counts,
        ...academyMeta.counts,
        guideArticles: articles.length,
        guideGlossaryTerms: glossary.length,
        guideCards: cards.length,
        guideEdgeCases: edgeCases.length,
        academyLessons: lessons.length,
        academyLabs: labs.length,
        academyChecks: checks.length,
    };
    const contentHash = sha256(JSON.stringify({ schema: SCHEMA, guide, academy }));
    const meta = {
        schema: SCHEMA,
        appId: APP_ID,
        contentVersion: String(guideMeta.contentVersion ?? "0.0.0"),
        contentHash,
        guideSourceSha256: String(guideMeta.sourceSha256 ?? ""),
        academyContentHash: String(academyMeta.contentHash ?? ""),
        generatedAt: String(guideMeta.generatedAt ?? "1970-01-01T00:00:00.000Z"),
        counts,
    };
    const bundle = { schema: SCHEMA, meta, guide, academy };
    const bundleText = `${JSON.stringify(bundle, null, 2)}\n`;
    const bundleBytes = Buffer.byteLength(bundleText);
    if (bundleBytes > 6 * 1024 * 1024) {
        fail(`bundle is unexpectedly large: ${bundleBytes} bytes`);
    }

    const outputDir = process.env.COMPANION_BUNDLE_OUT?.trim()
        ? resolve(process.env.COMPANION_BUNDLE_OUT)
        : PUBLIC_CONTENT_DIR;
    mkdirSync(outputDir, { recursive: true });
    const bundlePath = join(outputDir, "bundle.json");
    const manifestPath = join(outputDir, "manifest.json");
    writeFileSync(bundlePath, bundleText, "utf8");
    const bundleSha256 = sha256(readFileSync(bundlePath));
    const manifest = {
        schema: SCHEMA,
        appId: APP_ID,
        contentVersion: meta.contentVersion,
        contentHash,
        bundleSha256,
        bundleBytes,
        guideSourceSha256: meta.guideSourceSha256,
        academyContentHash: meta.academyContentHash,
        generatedAt: meta.generatedAt,
        counts,
        bundlePath: "content/bundle.json",
    };
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    if (outputDir === PUBLIC_CONTENT_DIR) {
        console.log(
            [
                "content bundle",
                `  ${bundlePath}`,
                `  ${bundlePath === BUNDLE_PATH ? "" : BUNDLE_PATH}`,
                `  ${manifestPath === MANIFEST_PATH ? "" : MANIFEST_PATH}`,
                `  ${(bundleBytes / 1024).toFixed(1)} KiB, sha256 ${bundleSha256.slice(0, 16)}…`,
                `  ${articles.length} articles, ${lessons.length} lessons, ${labs.length} labs, ${edgeCases.length} edge cases`,
            ]
                .filter((line) => line.trim().length > 0)
                .join("\n"),
        );
    }
};

main();
