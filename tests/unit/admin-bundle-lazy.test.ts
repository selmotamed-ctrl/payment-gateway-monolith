import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * The admin portal's landing page used to ship a 1.27 MB spreadsheet library and a 609 kB chart library because
 * pages imported them statically. They load on first use now (export click, first chart render). This guard fails
 * if a static import brings either back into a page, a shared component or the entry.
 */
const SRC = join(__dirname, "..", "..", "admin-front", "src");

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !name.endsWith(".d.ts") ? [path] : [];
  });

const files = sourceFiles(SRC).map((path) => ({ path, rel: relative(SRC, path).split(sep).join("/"), text: readFileSync(path, "utf8") }));
const staticImports = (text: string): string[] =>
  [...text.matchAll(/^\s*import\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/gm)].map((match) => match[1]!);

describe("heavy libraries are loaded on first use, not with the page", () => {
  test("only the spreadsheet module itself imports exceljs / xlsx / file-saver", () => {
    const offenders = files
      .filter((file) => file.rel !== "utils/xlsx/templateDownload.ts")
      .filter((file) => staticImports(file.text).some((spec) => ["exceljs", "xlsx", "file-saver"].includes(spec)));
    expect(offenders.map((file) => file.rel)).toEqual([]);
  });

  test("nothing but the lazy facade reaches the spreadsheet module, and only dynamically", () => {
    const offenders = files.filter((file) =>
      staticImports(file.text).some((spec) => /(^|\/)templateDownload$/.test(spec) || spec === "@/utils/xlsx/templateDownload"),
    );
    expect(offenders.map((file) => file.rel)).toEqual([]);
    const facade = files.find((file) => file.rel === "utils/xlsx/index.ts")!;
    expect(facade.text).toContain('import("./templateDownload")');
  });

  test("charts live in @pg/ui and pages never import a second copy or echarts directly", () => {
    const oldCopy = files.filter((file) => staticImports(file.text).some((spec) => /^@\/charts(\/|$)/.test(spec)));
    expect(oldCopy.map((file) => file.rel)).toEqual([]);
    const directEchartsPages = files
      .filter((file) => file.rel.startsWith("pages/"))
      .filter((file) => staticImports(file.text).includes("echarts"));
    expect(directEchartsPages.map((file) => file.rel)).toEqual([]);
    expect(() => statSync(join(SRC, "charts"))).toThrow();
    const dashboard = files.find((file) => file.rel === "pages/dashboard/index.tsx")!;
    expect(dashboard.text).toContain("PgChart");
    expect(dashboard.text).toContain('from "@pg/ui"');
  });

  test("the facade keeps the whole pipeline API, all async", () => {
    const facade = files.find((file) => file.rel === "utils/xlsx/index.ts")!.text;
    for (const name of ["downloadXlsxFromCsvLines", "downloadXlsxFromCsvText", "downloadXlsxFromHeadersAndData", "uploadXlsxFromHeadersAndData"]) {
      expect(facade).toMatch(new RegExp(`${name}: async`));
    }
  });
});
