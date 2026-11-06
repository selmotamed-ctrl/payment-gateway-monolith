#!/usr/bin/env bun
/**
 * Run the canonical guide/academy extractors into companion-app/.cache.
 *
 * The extractors support output overrides, so this script never writes into
 * admin-front/src/content/** or core-back/content/**. The generated exam bank
 * and server catalog stay in .cache and are never copied into the app.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import {
    ACADEMY_CACHE_DIR,
    ADMIN_FRONT_DIR,
    CATALOG_CACHE_PATH,
    EXAM_BANK_CACHE_PATH,
    GUIDE_CACHE_DIR,
    assertAdminDependencies,
} from "./paths";

const run = (script: string, env: Record<string, string>): void => {
    execFileSync("bun", [`scripts/${script}`], {
        cwd: ADMIN_FRONT_DIR,
        env: { ...process.env, ...env, SOURCE_DATE_EPOCH: "0" },
        stdio: "inherit",
    });
};

const main = (): void => {
    assertAdminDependencies();

    rmSync(GUIDE_CACHE_DIR, { recursive: true, force: true });
    rmSync(ACADEMY_CACHE_DIR, { recursive: true, force: true });
    rmSync(EXAM_BANK_CACHE_PATH, { force: true });
    rmSync(CATALOG_CACHE_PATH, { force: true });
    mkdirSync(GUIDE_CACHE_DIR, { recursive: true });
    mkdirSync(ACADEMY_CACHE_DIR, { recursive: true });

    run("extract-guide-content.ts", { GUIDE_OUTPUT_DIR: GUIDE_CACHE_DIR });
    run("extract-academy-content.ts", {
        ACADEMY_OUTPUT_DIR: ACADEMY_CACHE_DIR,
        ACADEMY_EXAM_BANK_PATH: EXAM_BANK_CACHE_PATH,
        ACADEMY_CATALOG_PATH: CATALOG_CACHE_PATH,
    });

    console.log(`\ncontent extracted into ${GUIDE_CACHE_DIR} and ${ACADEMY_CACHE_DIR}`);
};

main();
