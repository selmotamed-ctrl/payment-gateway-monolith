#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..");
const PD = join(ROOT, "project-design");
const PARTS = join(PD, "parts");
const CHECK = process.argv.includes("--check");

type Status = "implemented" | "partial" | "missing" | "deferred" | "deprecated" | "historical";
type Confidence = "high" | "medium" | "low";

interface Part {
  path: string;
  rel: string;
  id: string;
  title: string;
  status: Status;
  confidence: Confidence;
  lastVerified: string;
  verifiedAgainst: string;
  code: string[];
  designSources: string[];
  tests: string[];
  gaps: string[];
  body: string;
}

const STATUS_VALUES = new Set<Status>(["implemented", "partial", "missing", "deferred", "deprecated", "historical"]);
const CONFIDENCE_VALUES = new Set<Confidence>(["high", "medium", "low"]);

const fail = (message: string): never => {
  console.error(`project-design: ${message}`);
  process.exit(1);
};

const walk = (directory: string, suffix = ".md"): string[] => {
  if (!existsSync(directory)) return [];
  const output: string[] = [];
  // readdirSync order depends on the file system (NTFS, ext4, overlayfs differ), which made the
  // generated test inventory machine-dependent and `--check` fail on any other machine.
  // Plain code-unit order (not localeCompare, which depends on the ICU locale) is identical everywhere.
  const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...walk(path, suffix));
    else if (entry.isFile() && entry.name.endsWith(suffix)) output.push(path);
  }
  return output;
};

const parseScalar = (value: string): string => {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

const parseFrontmatter = (source: string): { data: Record<string, string | string[]>; body: string } => {
  if (!source.startsWith("---\n")) {
    fail("part is missing YAML frontmatter");
  }
  const end = source.indexOf("\n---", 4);
  if (end === -1) fail("part frontmatter is not closed");
  const raw = source.slice(4, end).trimEnd();
  const body = source.slice(end + 4).replace(/^\s*\n/, "");
  const data: Record<string, string | string[]> = {};
  let currentKey: string | null = null;
  for (const line of raw.split("\n")) {
    if (/^\s*-\s+/.test(line)) {
      if (!currentKey) fail(`array item without key: ${line}`);
      const existing = data[currentKey];
      const value = parseScalar(line.replace(/^\s*-\s+/, ""));
      data[currentKey] = Array.isArray(existing) ? [...existing, value] : [value];
      continue;
    }
    const match = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (!match) fail(`invalid frontmatter line: ${line}`);
    const [, key, value] = match as unknown as [string, string, string];
    currentKey = key;
    data[key] = value.trim().length === 0 ? [] : parseScalar(value);
  }
  return { data, body };
};

const asString = (value: string | string[] | undefined, label: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) fail(`${label} must be a non-empty string`);
  return value.trim();
};

const asArray = (value: string | string[] | undefined): string[] => {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
};

const parsePart = (path: string): Part => {
  const source = readFileSync(path, "utf8");
  const { data, body } = parseFrontmatter(source);
  const id = asString(data.id, `${path}: id`);
  const title = asString(data.title, `${path}: title`);
  const status = asString(data.status, `${path}: status`) as Status;
  const confidence = asString(data.confidence, `${path}: confidence`) as Confidence;
  if (!STATUS_VALUES.has(status)) fail(`${path}: invalid status '${status}'`);
  if (!CONFIDENCE_VALUES.has(confidence)) fail(`${path}: invalid confidence '${confidence}'`);
  if (body.trim().length < 400) fail(`${path}: body is too short to be a full design part`);
  return {
    path,
    rel: relative(ROOT, path).split(sep).join("/"),
    id,
    title,
    status,
    confidence,
    lastVerified: asString(data.last_verified, `${path}: last_verified`),
    verifiedAgainst: asString(data.verified_against, `${path}: verified_against`),
    code: asArray(data.code),
    designSources: asArray(data.design_sources),
    tests: asArray(data.tests),
    gaps: asArray(data.gaps),
    body,
  };
};

const existsForPattern = (pattern: string): boolean => {
  const withoutFragment = pattern.split("#")[0]!;
  const star = withoutFragment.indexOf("*");
  const candidate = star === -1 ? withoutFragment : withoutFragment.slice(0, star);
  return existsSync(join(ROOT, candidate.replace(/\/+$/, "")));
};

const parts = walk(PARTS)
  .map(parsePart)
  .sort((left, right) => left.rel.localeCompare(right.rel));

if (parts.length === 0) fail("no parts found under project-design/parts");
const ids = new Set<string>();
for (const part of parts) {
  if (ids.has(part.id)) fail(`duplicate part id '${part.id}'`);
  ids.add(part.id);
  for (const code of part.code) {
    if (!existsForPattern(code)) fail(`${part.rel}: code path '${code}' does not exist`);
  }
  for (const source of part.designSources) {
    if (!existsForPattern(source)) fail(`${part.rel}: design source '${source}' does not exist`);
  }
  for (const test of part.tests) {
    if (!existsForPattern(test)) fail(`${part.rel}: test path '${test}' does not exist`);
  }
}

const generatedHeader = (source: string): string =>
  `<!-- GENERATED FILE. Edit ${source} instead. Do not hand-edit this file. -->\n\n`;

const renderProjectDesign = (): string => {
  const lines: string[] = [
    "# Payment Gateway — Complete Project Design",
    "",
    "This is the generated, verbose master design document. It is assembled from `project-design/parts/**`.",
    "Historical `design/**` files are source lineage only; this document and the part files are canonical.",
    "",
    "## Contents",
    "",
  ];
  for (const part of parts) {
    lines.push(`- [${part.title}](#${part.id.replaceAll(".", "")}) — \`${part.status}\``);
  }
  lines.push("", "---", "");
  for (const part of parts) {
    lines.push(`<a id="${part.id.replaceAll(".", "")}"></a>`, "");
    lines.push(`> **Part ID:** \`${part.id}\` · **Status:** \`${part.status}\` · **Last verified:** ${part.lastVerified} · **Verified against:** \`${part.verifiedAgainst}\``);
    lines.push("");
    lines.push(part.body.trim());
    lines.push("", "---", "");
  }
  return `${generatedHeader("project-design/parts/**")}${lines.join("\n").trimEnd()}\n`;
};

const renderStatus = (): string => {
  const lines = [
    "# Project Design Status",
    "",
    generatedHeader("project-design/parts/**").trim(),
    "",
    "| Part | ID | Status | Confidence | Last verified | Open gaps |",
    "| :--- | :--- | :--- | :--- | :--- | :--- |",
  ];
  for (const part of parts) {
    const gaps = part.gaps.length === 0 ? "—" : part.gaps.map((gap) => gap.replaceAll("|", "\\|")).join("; ");
    lines.push(
      `| [${part.title}](parts/${part.rel.replace(/^project-design\/parts\//, "")}) | \`${part.id}\` | \`${part.status}\` | ${part.confidence} | ${part.lastVerified} | ${gaps} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
};

const renderIndex = (): string => {
  const byArea = new Map<string, Part[]>();
  for (const part of parts) {
    const area = part.rel.replace(/^project-design\/parts\//, "").split("/")[0] ?? "other";
    byArea.set(area, [...(byArea.get(area) ?? []), part]);
  }
  const lines = [
    "# Project Design Index",
    "",
    generatedHeader("project-design/parts/**").trim(),
    "",
    "This is the canonical entrypoint for the payment-gateway project design.",
    "",
    "## Authority",
    "",
    "- `project-design/parts/**` — editable source of truth.",
    "- `PROJECT_DESIGN.md` — generated centralized verbose master.",
    "- `STATUS.md` — generated implementation status.",
    "- `TRACKER.md` — append-only change, gap, decision and verification log.",
    "- `design/**` — historical/reference only.",
    "",
    "## Parts",
    "",
  ];
  for (const [area, areaParts] of [...byArea.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`### ${area}`, "");
    for (const part of areaParts) {
      lines.push(`- [${part.title}](parts/${part.rel.replace(/^project-design\/parts\//, "")}) — \`${part.id}\` · \`${part.status}\``);
    }
    lines.push("");
  }
  lines.push(
    "## Generated artifacts",
    "",
    "- [PROJECT_DESIGN.md](PROJECT_DESIGN.md)",
    "- [STATUS.md](STATUS.md)",
    "- [TRACKER.md](TRACKER.md)",
    "- [schema catalog](appendices/schema-catalog.md)",
    "- [migration catalog](appendices/migration-catalog.md)",
    "- [API route matrix](appendices/api-route-matrix.md)",
    "- [environment matrix](appendices/env-and-config-matrix.md)",
    "- [test inventory](appendices/test-inventory.md)",
    "- [design source map](appendices/design-source-map.md)",
    "- [stale claims register](appendices/stale-claims-register.md)",
    "",
  );
  return lines.join("\n");
};

const blueprintGroups: Array<{ path: string; ids: string[] }> = [
  { path: "core-back/blueprint.md", ids: ["core.foundations", "core.api", "core.engine", "core.ledger", "core.governance", "core.workers", "core.storage", "core.data", "core.search", "core.backup", "core.seeder", "core.tests"] },
  { path: "admin-back/blueprint.md", ids: ["edge.shared", "edge.admin"] },
  { path: "merchant-back/blueprint.md", ids: ["edge.shared", "edge.merchant"] },
  { path: "checkout-back/blueprint.md", ids: ["edge.shared", "edge.checkout"] },
  { path: "admin-front/blueprint.md", ids: ["admin-ui.system", "admin-ui.routes", "admin-ui.tables", "admin-ui.guide", "admin-ui.help", "admin-ui.operations"] },
  { path: "merchant-front/blueprint.md", ids: ["merchant-ui.portal", "merchant-ui.guide"] },
  { path: "checkout-front/blueprint.md", ids: ["checkout-ui.flow", "checkout-ui.help"] },
  { path: "fake-rails-back/blueprint.md", ids: ["fake-rails.backend", "fake-rails.protocol", "fake-rails.chaos", "fake-rails.integration"] },
  { path: "fake-rails-front/blueprint.md", ids: ["fake-rails.chaos", "fake-rails.integration"] },
  { path: "deploy/blueprint.md", ids: ["deploy.topology", "deploy.planner", "deploy.pki", "deploy.firewall", "deploy.pipeline", "deploy.storage", "deploy.backup", "deploy.health"] },
  { path: "deploy/backup-daemon/blueprint.md", ids: ["deploy.backup"] },
];

const stripLeadingTitle = (body: string): string =>
  body.replace(/^#\s+[^\n]+\n+/, "").trim();

const renderBlueprint = (blueprint: { path: string; ids: string[] }): string => {
  const selected = blueprint.ids.map((id) => parts.find((part) => part.id === id)).filter((part): part is Part => Boolean(part));
  if (selected.length === 0) fail(`blueprint ${blueprint.path} has no matching parts`);
  const missing = blueprint.ids.filter((id) => !selected.some((part) => part.id === id));
  if (missing.length > 0) fail(`blueprint ${blueprint.path} references missing parts: ${missing.join(", ")}`);
  const lines = [
    generatedHeader("project-design/parts/**").trim(),
    "",
    `# ${blueprint.path.split("/").slice(-2, -1)[0]} blueprint`,
    "",
    `Generated from: ${selected.map((part) => `\`${part.id}\``).join(", ")}.`,
    "",
    ...selected.flatMap((part) => [
      `## ${part.title}`,
      "",
      `> Status: \`${part.status}\` · Last verified: ${part.lastVerified}`,
      "",
      stripLeadingTitle(part.body),
      "",
    ]),
  ];
  return lines.join("\n").trimEnd() + "\n";
};

const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");

const renderSchemaCatalog = (): string => {
  const schema = read("core-back/prisma/schema.prisma");
  const models = [...schema.matchAll(/^model\s+(\w+)\s*\{/gm)].map((match) => match[1]!);
  const enums = [...schema.matchAll(/^enum\s+(\w+)\s*\{/gm)].map((match) => match[1]!);
  const migrations = readdirSync(join(ROOT, "core-back/prisma/migrations"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const lines = [
    "# Schema Catalog",
    "",
    generatedHeader("core-back/prisma/schema.prisma").trim(),
    "",
    `- Models: **${models.length}**`,
    `- Enums: **${enums.length}**`,
    `- Schema version: **${read("core-back/prisma/schemaVersion.ts").match(/=\s*(\d+)/)?.[1] ?? "unknown"}**`,
    `- Migrations: **${migrations.length}**`,
    "",
    "## Models",
    "",
    ...models.map((model) => `- \`${model}\``),
    "",
    "## Enums",
    "",
    ...enums.map((name) => `- \`${name}\``),
    "",
    "## Migrations",
    "",
    ...migrations.map((name) => `- \`${name}\``),
    "",
  ];
  return lines.join("\n");
};

const renderMigrationCatalog = (): string => {
  const migrations = readdirSync(join(ROOT, "core-back/prisma/migrations"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const lines = [
    "# Migration Catalog",
    "",
    generatedHeader("core-back/prisma/migrations/**").trim(),
    "",
    "| Migration | Lines | First comment |",
    "| :--- | ---: | :--- |",
  ];
  for (const migration of migrations) {
    const path = join(ROOT, "core-back/prisma/migrations", migration, "migration.sql");
    if (!existsSync(path)) continue;
    const sql = readFileSync(path, "utf8");
    const firstComment = sql.split("\n").find((line) => line.trim().startsWith("--"))?.replace(/^--\s*/, "") ?? "";
    lines.push(`| \`${migration}\` | ${sql.split("\n").length} | ${firstComment.replaceAll("|", "\\|")} |`);
  }
  lines.push("");
  return lines.join("\n");
};

const routeFiles = [
  "core-back/api/internal/admin.ts",
  "core-back/api/internal/merchant.ts",
  "core-back/api/internal/checkout.ts",
  "core-back/api/internal/backups.ts",
  "core-back/api/internal/index.ts",
  "core-back/api/index.ts",
  "admin-back/api/protected/index.ts",
  "admin-back/api/protected/backups.ts",
  "admin-back/api/protected/search.ts",
  "merchant-back/api/index.ts",
  "merchant-back/api/external/index.ts",
  "checkout-back/api/index.ts",
  "checkout-back/api/public/pay.ts",
  "checkout-back/api/public/return.ts",
  "checkout-back/api/public/inbound.ts",
  "fake-rails-back/api/index.ts",
];

const renderRouteMatrix = (): string => {
  const lines = [
    "# API Route Matrix",
    "",
    generatedHeader("core-back/api/**, admin-back/api/**, merchant-back/api/**, checkout-back/api/**, fake-rails-back/api/**").trim(),
    "",
    "| File | Line | Method | Path |",
    "| :--- | ---: | :--- | :--- |",
  ];
  const routePattern = /\.(get|post|put|patch|delete|all|use)\(\s*["'`]([^"'`]+)["'`]/g;
  for (const file of routeFiles) {
    const path = join(ROOT, file);
    if (!existsSync(path)) continue;
    const source = readFileSync(path, "utf8");
    const sourceLines = source.split("\n");
    for (let index = 0; index < sourceLines.length; index += 1) {
      const line = sourceLines[index]!;
      routePattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = routePattern.exec(line))) {
        lines.push(`| \`${file}\` | ${index + 1} | \`${match[1]!.toUpperCase()}\` | \`${match[2]}\` |`);
      }
    }
  }
  lines.push("");
  return lines.join("\n");
};

const renderEnvMatrix = (): string => {
  const lines = [
    "# Environment and Configuration Matrix",
    "",
    generatedHeader("deploy/deploy.env.example, core-back/lib/env/index.ts, edge env schemas, backup-daemon config").trim(),
    "",
    "| Source | Key |",
    "| :--- | :--- |",
  ];
  const envExample = read("deploy/deploy.env.example");
  for (const line of envExample.split("\n")) {
    const match = /^([A-Z][A-Z0-9_]+)=/.exec(line.trim());
    if (match) lines.push(`| \`deploy/deploy.env.example\` | \`${match[1]}\` |`);
  }
  const envSchemas = [
    "core-back/lib/env/index.ts",
    "admin-back/lib/env/index.ts",
    "merchant-back/lib/env/index.ts",
    "checkout-back/lib/env/index.ts",
    "deploy/backup-daemon/src/config.ts",
    "fake-rails-back/lib/env/index.ts",
  ];
  for (const file of envSchemas) {
    const path = join(ROOT, file);
    if (!existsSync(path)) continue;
    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(/^\s{2}([A-Z][A-Z0-9_]+):/gm)) {
      lines.push(`| \`${file}\` | \`${match[1]}\` |`);
    }
  }
  lines.push("");
  return lines.join("\n");
};

const testRoots = [
  "core-back/test",
  "admin-back/test",
  "merchant-back/test",
  "checkout-back/test",
  "fake-rails-back/test",
  "deploy/test",
  "deploy/backup-daemon/test",
  "tests/e2e",
  "tests/e2e-live",
  "tests/unit",
];

const renderTestInventory = (): string => {
  const lines = [
    "# Test Inventory",
    "",
    generatedHeader("test files").trim(),
    "",
    "| File | Lines | Literal test declarations |",
    "| :--- | ---: | ---: |",
  ];
  let totalFiles = 0;
  let totalTests = 0;
  for (const root of testRoots) {
    for (const file of walk(join(ROOT, root), ".ts")) {
      const source = readFileSync(file, "utf8");
      const count = (source.match(/\b(?:test|it)\s*\(/g) ?? []).length;
      totalFiles += 1;
      totalTests += count;
      lines.push(`| \`${relative(ROOT, file).split(sep).join("/")}\` | ${source.split("\n").length} | ${count} |`);
    }
  }
  lines.push("", `- Total files: **${totalFiles}**`, `- Total literal test declarations: **${totalTests}**`, "");
  return lines.join("\n");
};

const renderCodeSurfaceMap = (): string => {
  const lines = [
    "# Code Surface Map",
    "",
    generatedHeader("project-design/parts/** frontmatter").trim(),
    "",
    "| Part | Status | Code paths |",
    "| :--- | :--- | :--- |",
  ];
  for (const part of parts) {
    lines.push(`| \`${part.id}\` | \`${part.status}\` | ${part.code.map((code) => `\`${code}\``).join("<br>") || "—"} |`);
  }
  lines.push("");
  return lines.join("\n");
};

const outputs = new Map<string, string>();
outputs.set("project-design/PROJECT_DESIGN.md", renderProjectDesign());
outputs.set("project-design/STATUS.md", renderStatus());
outputs.set("project-design/INDEX.md", renderIndex());
outputs.set("project-design/appendices/schema-catalog.md", renderSchemaCatalog());
outputs.set("project-design/appendices/migration-catalog.md", renderMigrationCatalog());
outputs.set("project-design/appendices/api-route-matrix.md", renderRouteMatrix());
outputs.set("project-design/appendices/env-and-config-matrix.md", renderEnvMatrix());
outputs.set("project-design/appendices/test-inventory.md", renderTestInventory());
outputs.set("project-design/appendices/code-surface-map.md", renderCodeSurfaceMap());
for (const blueprint of blueprintGroups) {
  outputs.set(blueprint.path, renderBlueprint(blueprint));
}

let stale = 0;
for (const [path, content] of outputs) {
  const absolute = join(ROOT, path);
  const current = existsSync(absolute) ? readFileSync(absolute, "utf8") : undefined;
  if (current === content) continue;
  if (CHECK) {
    stale += 1;
    console.error(`out of date: ${path}`);
  } else {
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
    console.log(`wrote ${path}`);
  }
}

if (CHECK && stale > 0) {
  console.error(`project-design: ${stale} generated file(s) out of date. Run bun scripts/project-design/build.ts`);
  process.exit(1);
}
if (CHECK) console.log("project-design: generated files are up to date");
