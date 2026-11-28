/**
 * Golden-vector drift check.
 *
 * Regenerates every vector into a temporary directory from the real TypeScript modules and
 * compares the bytes with the committed files. Exits 1 on any difference, missing file or
 * structural problem.
 *
 * The only non-deterministic inputs are the random `vault`/`pgos1` payloads. They are reused from
 * the committed vectors and re-decrypted by the generator, so a drift here means the committed
 * payload no longer opens with the fixed key (or the deterministic fields changed).
 *
 * Usage (from the repo root):
 *   bun backend-rs/tools/golden/check.ts
 */

import { Buffer } from "node:buffer";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generate } from "./generate.ts";
import { defaultVectorDir } from "./lib/io.ts";

interface CommittedVector {
  generatedBy?: unknown;
  contract?: unknown;
  cases?: unknown;
}

const firstDifference = (left: Buffer, right: Buffer): string => {
  const limit = Math.min(left.length, right.length);
  for (let index = 0; index < limit; index += 1) {
    if (left[index] !== right[index]) {
      const line = left.subarray(0, index).toString("utf8").split("\n").length;
      return `first difference at byte ${index} (line ${line}): committed ${JSON.stringify(
        left.subarray(index, index + 24).toString("utf8"),
      )} vs generated ${JSON.stringify(right.subarray(index, index + 24).toString("utf8"))}`;
    }
  }
  if (left.length !== right.length) {
    return `length differs: committed ${left.length} bytes, generated ${right.length} bytes`;
  }
  return "no difference";
};

const checkStructure = (name: string, bytes: Buffer, problems: string[]): void => {
  let parsed: CommittedVector;
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as CommittedVector;
  } catch (error) {
    problems.push(`${name}: not valid JSON (${error instanceof Error ? error.message : String(error)})`);
    return;
  }
  if (typeof parsed.generatedBy !== "string" || parsed.generatedBy.length === 0) {
    problems.push(`${name}: missing generatedBy`);
  }
  if (typeof parsed.contract !== "string" || parsed.contract.length === 0) {
    problems.push(`${name}: missing contract`);
  }
  if (!Array.isArray(parsed.cases) || parsed.cases.length === 0) {
    problems.push(`${name}: cases must be a non-empty array`);
    return;
  }
  let previous = "";
  const seen = new Set<string>();
  for (const entry of parsed.cases as Array<{ id?: unknown }>) {
    if (typeof entry?.id !== "string" || entry.id.length === 0) {
      problems.push(`${name}: a case has no id`);
      continue;
    }
    if (seen.has(entry.id)) {
      problems.push(`${name}: duplicate case id ${entry.id}`);
    }
    seen.add(entry.id);
    if (previous && entry.id < previous) {
      problems.push(`${name}: cases are not sorted (${previous} before ${entry.id})`);
    }
    previous = entry.id;
  }
};

const main = async (): Promise<void> => {
  const outDir = defaultVectorDir;
  const scratch = mkdtempSync(join(tmpdir(), "pg-golden-check-"));
  const problems: string[] = [];

  try {
    const result = await generate({ outDir: scratch, reuseFrom: outDir });

    for (const file of result.files) {
      const committedPath = join(outDir, file.name);
      let committed: Buffer;
      try {
        committed = readFileSync(committedPath);
      } catch {
        problems.push(`${file.name}: committed file is missing`);
        continue;
      }
      const generated = readFileSync(join(scratch, file.name));
      if (!committed.equals(generated)) {
        problems.push(`${file.name}: drift — ${firstDifference(committed, generated)}`);
      }
      checkStructure(file.name, committed, problems);
      console.log(
        `${committed.equals(generated) ? "ok  " : "DIFF"} ${file.name.padEnd(20)} ${String(file.cases).padStart(4)} cases ${String(committed.length).padStart(9)} bytes`,
      );
    }
    // Other vector families (for example `route-inventory/`) live in this directory but are owned
    // by their own generators; this checker only compares the eight files above.
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  if (problems.length > 0) {
    console.error(`\ngolden vectors have drift (${problems.length} problem(s)):`);
    for (const problem of problems) {
      console.error(`  - ${problem}`);
    }
    console.error("\nRun: bun backend-rs/tools/golden/generate.ts");
    process.exitCode = 1;
    return;
  }
  console.log("\ngolden vectors are up to date");
};

await main();
