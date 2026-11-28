import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expandCasePlaceholders, loadFixtures, seedFixturesFromInventory } from "./fixtures";

const tempDirs: string[] = [];

const tempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(process.env.PARITY_TMP_DIR ?? os.tmpdir(), "pg-parity-fixtures-"));
  tempDirs.push(dir);
  return dir;
};

afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe("smoke fixtures", () => {
  test("loads the ten curated read cases in channel order", () => {
    const fixtures = loadFixtures();
    expect(fixtures.map((fixture) => fixture.channel)).toEqual([
      "checkout",
      "merchant",
      "admin",
    ]);
    expect(fixtures.map((fixture) => fixture.cases.length)).toEqual([4, 3, 3]);
    const cases = fixtures.flatMap((fixture) => fixture.cases);
    expect(cases).toHaveLength(10);
    for (const fixtureCase of cases) {
      expect(fixtureCase.method).toBe("GET");
      expect(typeof fixtureCase.headers?.["x-request-id"]).toBe("string");
    }
    const requestIds = cases.map((fixtureCase) => fixtureCase.headers!["x-request-id"]);
    expect(new Set(requestIds).size).toBe(requestIds.length);
  });

  test("expands auth placeholders in headers and paths", () => {
    const expanded = expandCasePlaceholders(
      {
        method: "GET",
        path: "/api/v1/pay/{{TOKEN}}",
        headers: { authorization: "Bearer {{TOKEN}}" },
      },
      { TOKEN: "abc" },
    );
    expect(expanded.path).toBe("/api/v1/pay/abc");
    expect(expanded.headers?.authorization).toBe("Bearer abc");
  });

  test("seeds deterministic GET fixtures from the real inventory", () => {
    const dir = tempDir();
    const written = seedFixturesFromInventory({ outDir: dir, perChannel: 2 });
    expect(written.map((entry) => entry.channel)).toEqual(["checkout", "merchant", "admin"]);
    for (const entry of written) {
      const parsed = JSON.parse(fs.readFileSync(entry.file, "utf8")) as {
        channel: string;
        cases: Array<{ method: string; path: string; headers: Record<string, string> }>;
      };
      expect(parsed.channel).toBe(entry.channel);
      expect(parsed.cases).toHaveLength(2);
      for (const fixtureCase of parsed.cases) {
        expect(fixtureCase.method).toBe("GET");
        expect(fixtureCase.path.startsWith("/api/v1/")).toBe(true);
        expect(fixtureCase.headers["x-request-id"]).toMatch(/^parity-/);
      }
    }
  });
});
