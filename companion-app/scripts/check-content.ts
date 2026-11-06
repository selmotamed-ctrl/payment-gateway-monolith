#!/usr/bin/env bun
/**
 * Fail if the committed content snapshot is stale or not byte-identical to a
 * fresh extraction from the canonical design sources.
 */
import { execFileSync } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    rmSync,
} from "node:fs";
import { join } from "node:path";
import {
    ACADEMY_CACHE_DIR,
    ADMIN_FRONT_DIR,
    CACHE_DIR,
    EXAM_BANK_CACHE_PATH,
    CATALOG_CACHE_PATH,
    COMPANION_DIR,
    GUIDE_CACHE_DIR,
    MANIFEST_PATH,
    PUBLIC_CONTENT_DIR,
    assertAdminDependencies,
} from "./paths";

const CHECK_DIR = join(CACHE_DIR, "check");
const CHECK_GUIDE = join(CHECK_DIR, "guide");
const CHECK_ACADEMY = join(CHECK_DIR, "academy");
const CHECK_OUT = join(CHECK_DIR, "bundle");

const run = (script: string, env: Record<string, string>): void => {
    execFileSync("bun", [`scripts/${script}`], {
        cwd: ADMIN_FRONT_DIR,
        env: { ...process.env, ...env, SOURCE_DATE_EPOCH: "0" },
        stdio: "pipe",
    });
};

const fail = (message: string): never => {
    console.error(`content:check: ${message}`);
    process.exit(1);
};

const compareDirectory = (fresh: string, committed: string, label: string): void => {
    if (!existsSync(committed)) {
        fail(`${label} generated directory is missing: ${committed}`);
    }
    const files = readdirSync(fresh).filter((name) => name.endsWith(".json")).sort();
    for (const file of files) {
        const freshPath = join(fresh, file);
        const committedPath = join(committed, file);
        if (!existsSync(committedPath)) {
            fail(`${label}/${file} is missing from admin-front generated content`);
        }
        if (Buffer.compare(readFileSync(freshPath), readFileSync(committedPath)) !== 0) {
            fail(
                `${label}/${file} drifted from the canonical extractor output. Run the admin-front content generator and commit the result.`,
            );
        }
    }
};

const main = (): void => {
    assertAdminDependencies();
    if (!existsSync(join(PUBLIC_CONTENT_DIR, "bundle.json"))) {
        fail("public/content/bundle.json is missing. Run `bun run content:sync`.");
    }

    rmSync(CHECK_DIR, { recursive: true, force: true });
    mkdirSync(CHECK_GUIDE, { recursive: true });
    mkdirSync(CHECK_ACADEMY, { recursive: true });

    run("extract-guide-content.ts", { GUIDE_OUTPUT_DIR: CHECK_GUIDE });
    run("extract-academy-content.ts", {
        ACADEMY_OUTPUT_DIR: CHECK_ACADEMY,
        ACADEMY_EXAM_BANK_PATH: join(CHECK_DIR, "exam-bank.json"),
        ACADEMY_CATALOG_PATH: join(CHECK_DIR, "catalog.json"),
    });

    compareDirectory(
        CHECK_GUIDE,
        join(ADMIN_FRONT_DIR, "src", "content", "guide", "generated"),
        "guide",
    );
    compareDirectory(
        CHECK_ACADEMY,
        join(ADMIN_FRONT_DIR, "src", "content", "academy", "generated"),
        "academy",
    );

    // Build into a temporary directory, then compare byte-for-byte with the snapshot.
    execFileSync("bun", ["scripts/build-bundle.ts"], {
        cwd: COMPANION_DIR,
        env: {
            ...process.env,
            COMPANION_BUNDLE_OUT: CHECK_OUT,
            COMPANION_GUIDE_DIR: CHECK_GUIDE,
            COMPANION_ACADEMY_DIR: CHECK_ACADEMY,
            COMPANION_EXAM_BANK_PATH: join(CHECK_DIR, "exam-bank.json"),
        },
        stdio: "pipe",
    });

    for (const file of ["bundle.json", "manifest.json"]) {
        const fresh = join(CHECK_OUT, file);
        const committed = join(PUBLIC_CONTENT_DIR, file);
        if (!existsSync(fresh)) fail(`temporary ${file} was not produced`);
        if (!existsSync(committed)) fail(`public/content/${file} is missing`);
        if (Buffer.compare(readFileSync(fresh), readFileSync(committed)) !== 0) {
            fail(
                `public/content/${file} is stale. Run \`bun run content:sync\` and commit the updated snapshot.`,
            );
        }
    }

    rmSync(CHECK_DIR, { recursive: true, force: true });
    console.log("content:check: canonical content snapshot is current and valid");
};

main();
