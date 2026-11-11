import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SDK_ROOT = join(import.meta.dir, "../../lib/reportEngineSdk");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith(".ts") ? [full] : [];
  });
}

const FORBIDDEN = [
  /from\s+["'][^"']*core-back\/(api|engine|generated|prisma)/,
  /from\s+["'][^"']*\/api\//,
  /from\s+["'][^"']*\/engine\//,
  /from\s+["'][^"']*\/generated\/prisma/,
  /from\s+["']@prisma\/client["']/,
  /from\s+["'][^"']*\/prisma\/client/,
];

describe("RE-T22: SDK decoupling", () => {
  test("the report engine SDK never imports host application modules", () => {
    const files = walk(SDK_ROOT);
    expect(files.length).toBeGreaterThan(10);
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const pattern of FORBIDDEN) {
        if (pattern.test(source)) offenders.push(`${file} matched ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
