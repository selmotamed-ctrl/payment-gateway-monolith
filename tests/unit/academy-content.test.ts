import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, describe, expect, test } from "vitest";

const REPO_ROOT = resolve(process.cwd(), "..");
const SCRIPT = join(REPO_ROOT, "admin-front/scripts/extract-academy-content.ts");
const GENERATED_DIR = join(REPO_ROOT, "admin-front/src/content/academy/generated");
const EXAM_BANK = join(REPO_ROOT, "core-back/content/academy/exam-bank.json");
const CATALOG = join(REPO_ROOT, "core-back/content/academy/catalog.json");
const SOURCE = join(REPO_ROOT, "design/07-guides-and-academy/academy_system_design_and_content.md");
const GUIDE_ARTICLES = join(REPO_ROOT, "admin-front/src/content/guide/generated/articles.en.json");

const EXPECTED_COUNTS = {
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
};

const SECTIONS = [
    "You will be able to",
    "Key ideas",
    "A worked example",
    "Common mistakes",
    "Read now",
    "Check yourself",
];

const readJson = <T>(name: string): T => JSON.parse(readFileSync(join(GENERATED_DIR, name), "utf8")) as T;

interface Opt { id: string; text: string; correct: boolean }
interface Question { id: string; module: string; type: string; critical: boolean; tracks: string[]; refs: string[]; options?: Opt[]; why: string; lesson?: string }
interface Lesson { id: string; module: string; tracks: string[]; reading: string[]; body: string; checkIds: string[] }
interface Module { id: string; lessonIds: string[]; labIds: string[] }
interface Track { id: string; requires: string[]; moduleIds: string[]; lessonIds: string[]; labIds: string[]; examId: string }
interface Lab { id: string; module: string; tracks: string[]; refs: string[]; tasks: unknown[] }
interface Blueprint { id: string; track: string; questionCount: number; composition: { module: string; count: number }[]; criticalPick?: number }

const tmp = mkdtempSync(join(tmpdir(), "academy-content-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const runExtractor = (env: Record<string, string>) =>
    spawnSync("bun", [SCRIPT], {
        cwd: REPO_ROOT,
        env: { ...process.env, ...env },
        encoding: "utf8",
    });

const bank = JSON.parse(readFileSync(EXAM_BANK, "utf8")) as { blueprints: Blueprint[]; questions: Question[] };
const tracks = readJson<Track[]>("tracks.json");
const modules = readJson<Module[]>("modules.json");
const lessons = readJson<Lesson[]>("lessons.en.json");
const checks = readJson<Question[]>("checks.en.json");
const labs = readJson<Lab[]>("labs.en.json");
const publicBlueprints = readJson<Blueprint[]>("exam-blueprints.public.json");
const articleIds = new Set(
    (JSON.parse(readFileSync(GUIDE_ARTICLES, "utf8")) as { id: string }[]).map((article) => article.id),
);

describe("academy content extractor output", () => {
    test("re-running the extractor reproduces the committed files byte for byte", () => {
        const out = join(tmp, "generated");
        const bankOut = join(tmp, "exam-bank.json");
        const catalogOut = join(tmp, "catalog.json");
        const run = runExtractor({
            ACADEMY_OUTPUT_DIR: out,
            ACADEMY_EXAM_BANK_PATH: bankOut,
            ACADEMY_CATALOG_PATH: catalogOut,
        });
        expect(run.status, run.stderr).toBe(0);
        const files = readdirSync(GENERATED_DIR).filter((name) => name.endsWith(".json")).sort();
        expect(files.length).toBeGreaterThan(0);
        expect(readdirSync(out).filter((name) => name.endsWith(".json")).sort()).toEqual(files);
        for (const file of files) {
            expect(
                Buffer.compare(readFileSync(join(out, file)), readFileSync(join(GENERATED_DIR, file))),
                `${file} differs; run the extractor`,
            ).toBe(0);
        }
        expect(Buffer.compare(readFileSync(bankOut), readFileSync(EXAM_BANK)), "exam-bank.json differs").toBe(0);
        expect(Buffer.compare(readFileSync(catalogOut), readFileSync(CATALOG)), "catalog.json differs").toBe(0);
    }, 60_000);

    test("meta counts equal the spec table II-2.5", () => {
        const meta = readJson<{ counts: typeof EXPECTED_COUNTS }>("meta.json");
        expect(meta.counts).toEqual(EXPECTED_COUNTS);
        expect(tracks.length).toBe(8);
        expect(modules.length).toBe(11);
        expect(lessons.length).toBe(50);
        expect(checks.length).toBe(100);
        expect(labs.length).toBe(16);
        expect(labs.reduce((sum, lab) => sum + lab.tasks.length, 0)).toBe(92);
        expect(bank.questions.length).toBe(223);
        expect(bank.questions.filter((q) => q.type === "single").length).toBe(208);
        expect(bank.questions.filter((q) => q.type === "number").length).toBe(13);
        expect(bank.questions.filter((q) => q.type === "order").length).toBe(2);
        expect(bank.questions.filter((q) => q.critical).length).toBe(43);
        expect(bank.blueprints.length).toBe(8);
        expect(readJson<unknown[]>("drills.en.json").length).toBe(11);
        // 6 pages in pages.en.json + lab-vectors.json
        const pages = readJson<{ id: string }[]>("pages.en.json");
        expect(pages.length).toBe(6);
        expect(pages.some((page) => page.id === "lab-vectors")).toBe(false);
        expect(existsSync(join(GENERATED_DIR, "lab-vectors.json"))).toBe(true);
    });

    test("every reference resolves", () => {
        const moduleIds = new Set(modules.map((m) => m.id));
        const lessonIds = new Set(lessons.map((l) => l.id));
        const labIds = new Set(labs.map((l) => l.id));
        const trackIds = new Set(tracks.map((t) => t.id));
        const checkIds = new Set(checks.map((c) => c.id));
        for (const lesson of lessons) {
            expect(moduleIds.has(lesson.module), `${lesson.id} module`).toBe(true);
            for (const ref of lesson.reading) expect(articleIds.has(ref), `${lesson.id} -> ${ref}`).toBe(true);
            for (const id of lesson.tracks) expect(trackIds.has(id), `${lesson.id} track ${id}`).toBe(true);
        }
        for (const lab of labs) {
            expect(moduleIds.has(lab.module), `${lab.id} module`).toBe(true);
            for (const ref of lab.refs) expect(articleIds.has(ref), `${lab.id} -> ${ref}`).toBe(true);
            for (const id of lab.tracks) expect(trackIds.has(id), `${lab.id} track ${id}`).toBe(true);
        }
        for (const q of [...checks, ...bank.questions]) {
            expect(moduleIds.has(q.module), `${q.id} module`).toBe(true);
            for (const ref of q.refs) expect(articleIds.has(ref), `${q.id} -> ${ref}`).toBe(true);
            for (const id of q.tracks ?? []) expect(trackIds.has(id), `${q.id} track ${id}`).toBe(true);
        }
        for (const q of checks) expect(lessonIds.has(q.lesson ?? ""), `${q.id} lesson`).toBe(true);
        for (const mod of modules) {
            for (const id of mod.lessonIds) expect(lessonIds.has(id), `${mod.id} lesson ${id}`).toBe(true);
            for (const id of mod.labIds) expect(labIds.has(id), `${mod.id} lab ${id}`).toBe(true);
        }
        for (const track of tracks) {
            for (const id of track.requires) expect(trackIds.has(id), `${track.id} requires ${id}`).toBe(true);
            for (const id of track.moduleIds) expect(moduleIds.has(id), `${track.id} module ${id}`).toBe(true);
            for (const id of track.lessonIds) expect(lessonIds.has(id), `${track.id} lesson ${id}`).toBe(true);
            for (const id of track.labIds) expect(labIds.has(id), `${track.id} lab ${id}`).toBe(true);
            expect(bank.blueprints.some((b) => b.id === track.examId && b.track === track.id), `${track.id} exam`).toBe(true);
        }
        for (const lesson of lessons) for (const id of lesson.checkIds) expect(checkIds.has(id)).toBe(true);
    });

    test("every lesson has the fixed sections in order and exactly two checks", () => {
        for (const lesson of lessons) {
            const headings = [...lesson.body.matchAll(/^### (.+)$/gm)].map((m) => m[1].trim());
            expect(headings, lesson.id).toEqual(SECTIONS);
            expect(lesson.checkIds.length, `${lesson.id} checks`).toBe(2);
        }
    });

    test("each lesson check is named by exactly one lesson and every module has a lesson", () => {
        const named = lessons.flatMap((l) => l.checkIds);
        expect(new Set(named).size).toBe(named.length);
        expect([...named].sort()).toEqual(checks.map((c) => c.id).sort());
        for (const check of checks) {
            const owners = lessons.filter((l) => l.checkIds.includes(check.id));
            expect(owners.length, check.id).toBe(1);
            expect(owners[0].id).toBe(check.lesson);
        }
        for (const mod of modules) expect(mod.lessonIds.length, `${mod.id} lessons`).toBeGreaterThanOrEqual(1);
    });

    test("question validity", () => {
        for (const q of [...checks, ...bank.questions]) {
            expect(q.why?.trim().length, `${q.id} why`).toBeGreaterThan(0);
            if (q.type === "single") {
                expect(q.options!.filter((o) => o.correct).length, `${q.id} single`).toBe(1);
            }
            if (q.type === "multi") {
                expect(q.options!.filter((o) => o.correct).length, `${q.id} multi`).toBeGreaterThanOrEqual(2);
            }
        }
        const ids = [...checks, ...bank.questions].map((q) => q.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    test("exam blueprints sum to questionCount with a 1.25x pool per module", () => {
        expect(bank.blueprints.length).toBe(8);
        for (const bp of bank.blueprints) {
            expect(bp.composition.reduce((sum, c) => sum + c.count, 0), `${bp.id} sum`).toBe(bp.questionCount);
            for (const c of bp.composition) {
                const pool = bank.questions.filter((q) => q.module === c.module && q.tracks.includes(bp.track));
                expect(pool.length, `${bp.id}/${c.module} pool ${pool.length} < 1.25x${c.count}`).toBeGreaterThanOrEqual(
                    Math.ceil(c.count * 1.25),
                );
            }
            const critical = bank.questions.filter(
                (q) => q.critical && q.tracks.includes(bp.track) && bp.composition.some((c) => c.module === q.module),
            );
            expect(bp.criticalPick ?? 0, `${bp.id} criticalPick`).toBeLessThanOrEqual(critical.length);
        }
    });

    test("public blueprints mirror the bank without leaking ids or keys", () => {
        expect(publicBlueprints.map((b) => b.id)).toEqual(bank.blueprints.map((b) => b.id));
        expect(JSON.stringify(publicBlueprints)).not.toMatch(/"q-[a-z0-9-]+"/);
        for (const bp of publicBlueprints) {
            expect(bp.composition.reduce((s, c) => s + c.count, 0)).toBe(bp.questionCount);
        }
    });

    test("total gzip size of generated JSON is below 600 KB", () => {
        const total = readdirSync(GENERATED_DIR)
            .filter((n) => n.endsWith(".json"))
            .reduce((sum, f) => sum + gzipSync(readFileSync(join(GENERATED_DIR, f))).byteLength, 0);
        expect(total).toBeLessThan(600 * 1024);
    });

    test("key-leak guard: no exam-pool question id or exam key under generated/", () => {
        const examIds = bank.questions.map((q) => q.id);
        expect(examIds.length).toBe(223);
        for (const file of readdirSync(GENERATED_DIR)) {
            const text = readFileSync(join(GENERATED_DIR, file), "utf8");
            for (const id of examIds) expect(text.includes(id), `${file} leaks ${id}`).toBe(false);
        }
        // Practice checks/labs may legitimately reuse a stem; every other file must not carry exam stems.
        const generatedText = readdirSync(GENERATED_DIR)
            .filter((f) => f !== "checks.en.json" && f !== "labs.en.json")
            .map((f) => readFileSync(join(GENERATED_DIR, f), "utf8"))
            .join("\n");
        for (const q of bank.questions) {
            expect(generatedText.includes(JSON.stringify(q.stem)), `stem of ${q.id} leaked`).toBe(false);
        }
        // `correct` flags only exist on lesson-check options and lab options, never on a question with an exam id
        for (const q of checks) expect(q.id.startsWith("q-")).toBe(false);
    });
});

describe("academy extractor fails on corrupted source", () => {
    const source = readFileSync(SOURCE, "utf8");
    const run = (name: string, mutate: (text: string) => string) => {
        const file = join(tmp, `${name}.md`);
        const mutated = mutate(source);
        expect(mutated, `mutation ${name} must change the source`).not.toBe(source);
        writeFileSync(file, mutated);
        return runExtractor({
            ACADEMY_SOURCE_FILE: file,
            ACADEMY_OUTPUT_DIR: join(tmp, `${name}-out`),
            ACADEMY_EXAM_BANK_PATH: join(tmp, `${name}-bank.json`),
            ACADEMY_CATALOG_PATH: join(tmp, `${name}-catalog.json`),
        });
    };
    const replaceOnce = (text: string, from: string, to: string): string => {
        const index = text.indexOf(from);
        if (index < 0) throw new Error(`fixture text not found: ${from}`);
        return text.slice(0, index) + to + text.slice(index + from.length);
    };

    test("sanity: an unmodified copy of the source extracts fine", () => {
        const file = join(tmp, "clean.md");
        writeFileSync(file, source);
        const result = runExtractor({
            ACADEMY_SOURCE_FILE: file,
            ACADEMY_OUTPUT_DIR: join(tmp, "clean-out"),
            ACADEMY_EXAM_BANK_PATH: join(tmp, "clean-bank.json"),
            ACADEMY_CATALOG_PATH: join(tmp, "clean-catalog.json"),
        });
        expect(result.status, result.stderr).toBe(0);
    }, 60_000);

    test("missing @@end", () => {
        const result = run("noend", (t) => replaceOnce(t, "Why: Rule 6: no guessing; use Inquire.\n@@end\n", "Why: Rule 6: no guessing; use Inquire.\n"));
        expect(result.status).not.toBe(0);
    });

    test("duplicate id", () => {
        const result = run("dup", (t) => replaceOnce(t, "@@q id=q-m0-002 ", "@@q id=q-m0-001 "));
        expect(result.status).not.toBe(0);
    });

    test("unresolved article reference", () => {
        const result = run("badref", (t) =>
            replaceOnce(t, "@@q id=q-m0-001 module=m0 type=single difficulty=2 critical=true exam=true tracks=FOUNDATION refs=b00-03", "@@q id=q-m0-001 module=m0 type=single difficulty=2 critical=true exam=true tracks=FOUNDATION refs=b99-99"),
        );
        expect(result.status).not.toBe(0);
    });

    test("single question with two [x]", () => {
        const result = run("twox", (t) => replaceOnce(t, "- [ ] Always write a real reason.", "- [x] Always write a real reason."));
        expect(result.status).not.toBe(0);
    });

    test("question without Why:", () => {
        const result = run("nowhy", (t) => replaceOnce(t, "Why: Rule 6: no guessing; use Inquire.\n", ""));
        expect(result.status).not.toBe(0);
    });

    test("invalid lab JSON", () => {
        const result = run("badlab", (t) => replaceOnce(t, '{\n "id": "lab-flow-tracer",', '{\n "id": "lab-flow-tracer" BROKEN,'));
        expect(result.status).not.toBe(0);
    });
});
