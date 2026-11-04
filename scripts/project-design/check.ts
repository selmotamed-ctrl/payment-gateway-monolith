#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..");
const required = [
  "project-design/INDEX.md",
  "project-design/PROJECT_DESIGN.md",
  "project-design/STATUS.md",
  "project-design/TRACKER.md",
  "project-design/GLOSSARY.md",
  "project-design/DECISIONS.md",
  "project-design/appendices/design-source-map.md",
  "project-design/appendices/stale-claims-register.md",
  "AGENTS.md",
  "opencode.json",
  "CLAUDE.md",
  "GEMINI.md",
  ".cursor/rules/project-design.mdc",
  ".windsurfrules",
  ".github/copilot-instructions.md",
];

let failed = false;
for (const path of required) {
  if (!existsSync(join(ROOT, path))) {
    console.error(`missing required design/instruction file: ${path}`);
    failed = true;
  }
}

const staleFiles = [
  "admin-front/SCALING_FEATURE.md",
  "merchant-front/SCALING_FEATURE.md",
  "checkout-front/SCALING_FEATURE.md",
  "admin-front/notes.md",
  "merchant-front/notes.md",
  "checkout-front/notes.md",
];
for (const path of staleFiles) {
  if (existsSync(join(ROOT, path))) {
    console.error(`stale documentation still present: ${path}`);
    failed = true;
  }
}

const generated = Bun.spawnSync(["bun", "scripts/project-design/build.ts", "--check"], {
  cwd: ROOT,
  stdout: "inherit",
  stderr: "inherit",
});
if ((generated.exitCode ?? 1) !== 0) failed = true;

const sourceMap = existsSync(join(ROOT, "project-design/appendices/design-source-map.md"))
  ? readFileSync(join(ROOT, "project-design/appendices/design-source-map.md"), "utf8")
  : "";
// Every design/**/*.md (except README.md) must be mapped in the design source map.
const designFiles = [...new Bun.Glob("design/**/*.md").scanSync({ cwd: ROOT })]
  .filter((file) => !file.endsWith("README.md"))
  .sort();
if (designFiles.length === 0) {
  console.error("no design/**/*.md files found");
  failed = true;
}
for (const file of designFiles) {
  if (!sourceMap.includes(file)) {
    console.error(`design source not mapped: ${file}`);
    failed = true;
  }
}

if (failed) {
  console.error("project-design check failed");
  process.exit(1);
}
console.log("project-design check passed");
