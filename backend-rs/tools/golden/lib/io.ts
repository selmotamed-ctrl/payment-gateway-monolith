/**
 * Small helpers shared by the golden-vector generator and its checker.
 *
 * A vector file is `{ generatedBy, contract, cases, notes? }`. Cases are sorted by `id` so the
 * bytes are stable no matter how the builder assembled them.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface VectorCase {
  id: string;
  [key: string]: unknown;
}

export interface VectorFile {
  generatedBy: string;
  contract: string;
  notes?: string[];
  cases: VectorCase[];
  [key: string]: unknown;
}

/** Plain code-point comparison; locale-independent so every host writes the same order. */
export const compareIds = (left: { id: string }, right: { id: string }): number =>
  left.id < right.id ? -1 : left.id > right.id ? 1 : 0;

export const sortCases = <T extends VectorCase>(cases: readonly T[]): T[] =>
  [...cases].sort(compareIds);

/** Render a vector file deterministically: two-space JSON plus one trailing newline. */
export const renderVector = (
  generatedBy: string,
  contract: string,
  cases: readonly VectorCase[],
  extras: Record<string, unknown> = {},
  notes?: readonly string[],
): string => {
  const ids = new Set<string>();
  for (const entry of cases) {
    if (ids.has(entry.id)) {
      throw new Error(`duplicate case id: ${entry.id}`);
    }
    ids.add(entry.id);
  }
  const body: VectorFile = {
    generatedBy,
    contract,
    ...(notes && notes.length > 0 ? { notes: [...notes] } : {}),
    ...extras,
    cases: sortCases(cases),
  };
  return `${JSON.stringify(body, null, 2)}\n`;
};

export const writeVector = (
  directory: string,
  name: string,
  generatedBy: string,
  contract: string,
  cases: readonly VectorCase[],
  extras: Record<string, unknown> = {},
  notes?: readonly string[],
): string => {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, name);
  writeFileSync(path, renderVector(generatedBy, contract, cases, extras, notes), "utf8");
  return path;
};

export const readJsonFile = <T>(path: string): T | undefined => {
  if (!existsSync(path)) {
    return undefined;
  }
  return JSON.parse(readFileSync(path, "utf8")) as T;
};

/** Load a previously committed vector so random payloads can be reused across regenerations. */
export const loadPreviousCases = (
  directory: string | undefined,
  name: string,
): Map<string, VectorCase> => {
  const cases = new Map<string, VectorCase>();
  if (!directory) {
    return cases;
  }
  const file = readJsonFile<VectorFile>(join(directory, name));
  if (!file || !Array.isArray(file.cases)) {
    return cases;
  }
  for (const entry of file.cases) {
    if (entry && typeof entry.id === "string") {
      cases.set(entry.id, entry);
    }
  }
  return cases;
};

export const defaultVectorDir = fileURLToPath(new URL("../../../tests/golden-vectors/", import.meta.url));
