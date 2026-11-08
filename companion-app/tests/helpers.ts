import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { CompanionBundle } from "@/content/types";

export const loadBundle = (): CompanionBundle =>
    JSON.parse(
        readFileSync(fileURLToPath(new URL("../public/content/bundle.json", import.meta.url)), "utf8"),
    ) as CompanionBundle;

export const toMap = <T extends { id: string }>(items: T[]): Map<string, T> =>
    new Map(items.map((item) => [item.id, item]));
