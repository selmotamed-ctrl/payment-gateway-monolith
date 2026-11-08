import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

type Pair = [string, string];
export interface Catalogue { name: string; entries: Record<string, Pair> }

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" || name === "__tests__" ? [] : walk(path);
    return /\.(ts|tsx)$/.test(name) && !name.endsWith(".d.ts") ? [path] : [];
  });

/** Every literal key passed to `t("...")` in a front-end's source (dynamic keys cannot be checked statically). */
export const literalKeys = (srcDir: string): Map<string, string[]> => {
  const used = new Map<string, string[]>();
  for (const file of walk(srcDir)) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/(?<![A-Za-z0-9_$.])t\(\s*(?:"((?:[^"\\\n]|\\.)+)"|'((?:[^'\\\n]|\\.)+)')/g)) {
      const key = (match[1] ?? match[2])!.replace(/\\(["'])/g, "$1");
      const list = used.get(key) ?? [];
      list.push(relative(srcDir, file).split(sep).join("/"));
      used.set(key, list);
    }
  }
  return used;
};

/** The merged catalogue exactly as the app builds it (later catalogues win), plus every key defined twice with different Arabic. */
export const analyse = (srcDir: string, catalogues: Catalogue[]) => {
  const merged = new Set<string>();
  const arabic = new Map<string, Map<string, string>>();
  for (const catalogue of catalogues) {
    for (const [key, [, ar]] of Object.entries(catalogue.entries)) {
      merged.add(key);
      const byCatalogue = arabic.get(key) ?? new Map<string, string>();
      byCatalogue.set(catalogue.name, ar);
      arabic.set(key, byCatalogue);
    }
  }
  const conflicts = [...arabic]
    .filter(([, byCatalogue]) => new Set(byCatalogue.values()).size > 1)
    .map(([key, byCatalogue]) => ({ key, values: Object.fromEntries(byCatalogue) }));
  const missing = [...literalKeys(srcDir).keys()].filter((key) => !merged.has(key)).sort();
  return { missing, conflicts };
};
