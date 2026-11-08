import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const COMPANION_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_ROOT = resolve(COMPANION_DIR, "..");
export const ADMIN_FRONT_DIR = join(REPO_ROOT, "admin-front");
export const CACHE_DIR = join(COMPANION_DIR, ".cache");
export const GUIDE_CACHE_DIR = join(CACHE_DIR, "guide");
export const ACADEMY_CACHE_DIR = join(CACHE_DIR, "academy");
export const EXAM_BANK_CACHE_PATH = join(CACHE_DIR, "exam-bank.json");
export const CATALOG_CACHE_PATH = join(CACHE_DIR, "catalog.json");
export const PUBLIC_CONTENT_DIR = join(COMPANION_DIR, "public", "content");
export const BUNDLE_PATH = join(PUBLIC_CONTENT_DIR, "bundle.json");
export const MANIFEST_PATH = join(PUBLIC_CONTENT_DIR, "manifest.json");

export const assertAdminDependencies = (): void => {
    if (!existsSync(join(ADMIN_FRONT_DIR, "node_modules", "markdown-it"))) {
        throw new Error(
            "admin-front dependencies are missing. Run `bun install` in admin-front before extracting content.",
        );
    }
};
