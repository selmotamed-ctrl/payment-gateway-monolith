import { describe, expect, test } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
const cwd = process.cwd();
const root = path.basename(cwd) === "tests" ? path.dirname(cwd) : cwd;
const adminDir = path.join(root, "admin-front/src/lib/reportEngineSdk");
const merchantDir = path.join(root, "merchant-front/src/lib/reportEngineSdk");

const filesUnder = (dir: string, prefix = ""): string[] => {
  const entries: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "__tests__") continue;
    const full = path.join(dir, name);
    const relative = path.join(prefix, name);
    if (statSync(full).isDirectory()) entries.push(...filesUnder(full, relative));
    else entries.push(relative);
  }
  return entries.sort();
};

describe("report engine client SDK mirror", () => {
  test("merchant-front is a byte-identical copy of admin-front (excluding __tests__)", () => {
    const adminFiles = filesUnder(adminDir);
    expect(filesUnder(merchantDir)).toEqual(adminFiles);
    for (const relative of adminFiles) {
      const admin = readFileSync(path.join(adminDir, relative), "utf8");
      const merchant = readFileSync(path.join(merchantDir, relative), "utf8");
      expect(merchant, relative).toBe(admin);
    }
  });
});
