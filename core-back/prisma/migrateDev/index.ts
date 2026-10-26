import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { env } from "../../lib/env";
import { REQUIRED_SCHEMA_VERSION } from "../schemaVersion";

const prismaRoot = path.join(import.meta.dirname, "..");
const migrationsDirectory = path.join(prismaRoot, "migrations");
const schemaPath = path.join(prismaRoot, "schema.prisma");

const schemaVersionsTable = "schema_versions";

const runPrisma = (argumentsList: string[]) =>
  execFileSync("bunx", ["--bun", "prisma", ...argumentsList], {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: env.DATABASE_URL },
  });

const listMigrationDirectories = () =>
  fs
    .readdirSync(migrationsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

const schemaVersionSql = `-- Schema version support (single-row table managed outside the Prisma datamodel).
CREATE TABLE IF NOT EXISTS "${schemaVersionsTable}" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "${schemaVersionsTable}_pkey" PRIMARY KEY ("id")
);

INSERT INTO "${schemaVersionsTable}" ("id", "version") VALUES (1, ${REQUIRED_SCHEMA_VERSION})
ON CONFLICT ("id") DO UPDATE SET "version" = EXCLUDED."version";
`;

export const patchMigrationSql = (migrationSql: string): string => {
  const lines = migrationSql.split("\n");
  const withoutSchemaVersionDrop: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === `DROP TABLE "${schemaVersionsTable}";`) {
      while (
        withoutSchemaVersionDrop.length > 0 &&
        /^--\s*Drop/i.test(
          withoutSchemaVersionDrop[withoutSchemaVersionDrop.length - 1] as string,
        )
      ) {
        withoutSchemaVersionDrop.pop();
      }
      continue;
    }
    withoutSchemaVersionDrop.push(line);
  }

  return `${withoutSchemaVersionDrop.join("\n").trimEnd()}\n\n${schemaVersionSql}`;
};

const patchMigration = (migrationDirectory: string) => {
  const migrationFilePath = path.join(migrationDirectory, "migration.sql");
  const migrationSql = fs.readFileSync(migrationFilePath, "utf8");
  fs.writeFileSync(migrationFilePath, patchMigrationSql(migrationSql));
};

const createMigration = () => {
  const before = listMigrationDirectories();
  runPrisma([
    "migrate",
    "dev",
    "--create-only",
    "--name",
    "init",
    `--schema=${schemaPath}`,
  ]);
  const after = listMigrationDirectories();
  const created = after.filter((directory) => !before.includes(directory));
  if (created.length === 0) {
    return null;
  }
  return path.join(migrationsDirectory, created.sort().at(-1) as string);
};

const runMigrateDev = () => {
  const migrationDirectory = createMigration();
  if (!migrationDirectory) {
    process.stdout.write("No schema changes detected.\n");
    return;
  }

  patchMigration(migrationDirectory);
  runPrisma(["migrate", "deploy", `--schema=${schemaPath}`]);
  process.stdout.write(`Migration applied from ${migrationDirectory}\n`);
};

if (import.meta.main) {
  try {
    runMigrateDev();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
}
