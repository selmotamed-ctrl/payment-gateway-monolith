/**
 * Full migration-diff guard for SQL-only objects (GAP-076).
 *
 * Prisma cannot model composite tenant FKs, partial indexes, SQL defaults and
 * the `schema_versions` table. `prisma migrate diff` therefore wants to drop
 * them on every drift check. This script allows exactly the reviewed inventory
 * in `prisma/sql-only-objects.allowlist.json`; any NEW or MISSING object fails
 * the gate, so an unreviewed `migrate dev` cannot silently erase one.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const allowlist = JSON.parse(readFileSync(join(root, "prisma/sql-only-objects.allowlist.json"), "utf8")) as {
  objects: Array<{ kind: string; name: string }>;
};

const proc = Bun.spawn(
  ["bunx", "--bun", "prisma", "migrate", "diff", "--from-config-datasource", "--to-schema", "prisma/schema.prisma", "--script"],
  { cwd: root, env: process.env, stdout: "pipe", stderr: "pipe" },
);
const sql = await new Response(proc.stdout).text();
const stderr = await new Response(proc.stderr).text();
const exitCode = await proc.exited;
if (exitCode !== 0) {
  console.error(`prisma migrate diff failed (${exitCode}): ${stderr.trim().slice(0, 1000)}`);
  process.exit(1);
}

const found = new Map<string, { kind: string; name: string }>();
const add = (kind: string, name: string) => found.set(`${kind}:${name}`, { kind, name });
for (const match of sql.matchAll(/DROP\s+(INDEX|CONSTRAINT|TRIGGER|FUNCTION|TYPE|VIEW|TABLE)\s+"([^"]+)"/gi)) {
  add(match[1]!.toUpperCase(), match[2]!);
}
for (const block of sql.matchAll(/ALTER TABLE "([^"]+)"([^;]+);/gi)) {
  const table = block[1]!;
  for (const column of block[2]!.matchAll(/ALTER COLUMN "([^"]+)" DROP DEFAULT/gi)) {
    add("DEFAULT", `${table}.${column[1]!}`);
  }
}

const expected = new Set(allowlist.objects.map((object) => `${object.kind}:${object.name}`));
const actual = new Set(found.keys());
const added = [...actual].filter((key) => !expected.has(key));
const missing = [...expected].filter((key) => !actual.has(key));
if (added.length || missing.length) {
  if (added.length) console.error(`New unguarded SQL-only objects would be dropped:\n  ${added.join("\n  ")}`);
  if (missing.length) console.error(`Allowlisted SQL-only objects are no longer present in the diff:\n  ${missing.join("\n  ")}`);
  process.exit(1);
}
console.log(`SQL-only object guard passed: ${expected.size} reviewed objects.`);
