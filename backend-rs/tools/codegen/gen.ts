#!/usr/bin/env bun
/**
 * Deterministic code generator for the Prisma-owned Rust surface (P0-T05).
 *
 * Inputs:
 *   - `core-back/prisma/schema.prisma` (enums, models, `@map`/`@@map`, native types, defaults)
 *   - `core-back/prisma/schemaVersion.ts` (`REQUIRED_SCHEMA_VERSION`)
 *
 * Outputs:
 *   - `backend-rs/crates/pg-types/src/generated/enums.rs`
 *   - `backend-rs/crates/pg-types/src/generated/models.rs`
 *   - `backend-rs/crates/pg-types/src/generated/meta.rs`
 *   - `backend-rs/tools/codegen/report-schema-catalog.json`
 *
 * Usage:
 *   bun backend-rs/tools/codegen/gen.ts          # write the four files
 *   bun backend-rs/tools/codegen/gen.ts --check  # compare in memory; exit 1 when stale
 *
 * No timestamps, no sorting, no environment reads: the same schema bytes produce the same output
 * bytes on every host. See `README.md` in this directory for the type mapping and the known
 * limitations.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { parsePrismaSchema } from "./lib/prisma";
import { renderCatalog, renderEnums, renderMeta, renderModels } from "./lib/emit";

interface OutputFile {
  /** Absolute path on disk. */
  path: string;
  content: string;
}

const CODEGEN_DIR = dirname(fileURLToPath(import.meta.url));
const BACKEND_RS_DIR = resolve(CODEGEN_DIR, "..", "..");
const REPO_ROOT = resolve(BACKEND_RS_DIR, "..");
const SCHEMA_PATH = join(REPO_ROOT, "core-back", "prisma", "schema.prisma");
const SCHEMA_VERSION_PATH = join(REPO_ROOT, "core-back", "prisma", "schemaVersion.ts");
const GENERATED_DIR = join(BACKEND_RS_DIR, "crates", "pg-types", "src", "generated");
const CATALOG_PATH = join(CODEGEN_DIR, "report-schema-catalog.json");

function main(argv: readonly string[]): number {
  let check = false;

  for (const argument of argv) {
    if (argument === "--check") {
      check = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      printUsage();
      return 0;
    }
    throw new Error(`unknown argument "${argument}" (try --help)`);
  }

  const schemaSource = readFileSync(SCHEMA_PATH, "utf8");
  const versionSource = readFileSync(SCHEMA_VERSION_PATH, "utf8");
  const schemaVersion = readSchemaVersion(versionSource);
  const schema = parsePrismaSchema(schemaSource, schemaVersion);

  const outputs: OutputFile[] = [
    { path: join(GENERATED_DIR, "enums.rs"), content: renderEnums(schema) },
    { path: join(GENERATED_DIR, "models.rs"), content: renderModels(schema) },
    { path: join(GENERATED_DIR, "meta.rs"), content: renderMeta(schema) },
    { path: CATALOG_PATH, content: renderCatalog(schema) },
  ];

  if (check) {
    return checkOutputs(outputs, schema.models.length, schema.enums.length, schema.schemaVersion);
  }

  writeOutputs(outputs);
  console.log(
    `codegen: ${schema.models.length} models, ${schema.enums.length} enums, ` +
      `${schema.fieldCount} scalar fields (schema version ${schema.schemaVersion})`,
  );
  let total = 0;
  for (const output of outputs) {
    const bytes = Buffer.byteLength(output.content, "utf8");
    total += bytes;
    console.log(`  ${repoPath(output.path)}: ${bytes} bytes`);
  }
  console.log(`  total: ${total} bytes`);

  return 0;
}

function checkOutputs(
  outputs: readonly OutputFile[],
  modelCount: number,
  enumCount: number,
  schemaVersion: number,
): number {
  const stale = outputs.filter((output) => {
    if (!existsSync(output.path)) {
      return true;
    }
    return readFileSync(output.path, "utf8") !== output.content;
  });

  if (stale.length === 0) {
    console.log(
      `codegen: up to date (${modelCount} models, ${enumCount} enums, ` +
        `schema version ${schemaVersion})`,
    );
    return 0;
  }

  console.error(`codegen: ${stale.length} generated file(s) out of date:`);
  for (const output of stale) {
    console.error(`  - ${repoPath(output.path)}`);
  }
  console.error("Run `bun backend-rs/tools/codegen/gen.ts` to regenerate them.");
  return 1;
}

function writeOutputs(outputs: readonly OutputFile[]): void {
  for (const output of outputs) {
    mkdirSync(dirname(output.path), { recursive: true });
    writeFileSync(output.path, output.content, "utf8");
  }
}

function readSchemaVersion(source: string): number {
  const match = /export\s+const\s+REQUIRED_SCHEMA_VERSION\s*=\s*(\d+)\s*;/.exec(source);
  if (match === null) {
    throw new Error(
      `could not find "export const REQUIRED_SCHEMA_VERSION = <number>;" in ${repoPath(
        SCHEMA_VERSION_PATH,
      )}`,
    );
  }
  const value = Number.parseInt(match[1]!, 10);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`invalid REQUIRED_SCHEMA_VERSION "${match[1]!}"`);
  }
  return value;
}

function repoPath(absolutePath: string): string {
  return relative(REPO_ROOT, absolutePath).split(sep).join("/");
}

function printUsage(): void {
  console.log(
    [
      "Usage: bun backend-rs/tools/codegen/gen.ts [--check]",
      "",
      "  --check   Regenerate in memory and exit 1 when a committed file differs.",
      "  --help    Show this message.",
      "",
      "Inputs:  core-back/prisma/schema.prisma, core-back/prisma/schemaVersion.ts",
      "Outputs: backend-rs/crates/pg-types/src/generated/{enums,models,meta}.rs",
      "         backend-rs/tools/codegen/report-schema-catalog.json",
    ].join("\n"),
  );
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`codegen: ${message}`);
  process.exitCode = 1;
}
