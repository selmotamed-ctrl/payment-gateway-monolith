import type { tryCast } from "typescript/unstable/ast";
import { env } from "../../lib/env";
import path from "path";
import fs from "fs";
import { execSync } from "child_process";
import { REQUIRED_SCHEMA_VERSION } from "../schemaVersion";

const databaseUrl = env.DATABASE_URL;
const prismaRoot = path.join(import.meta.dirname, "../");
const migrationsDirectory = path.join(prismaRoot, "migrations");
const schemaPath = path.join(prismaRoot, "schema.prisma");
const createMigration = async () => {
  const oldMigrationsContent = fs.readdirSync(migrationsDirectory);
  execSync(
    `DATABASE_URL="${databaseUrl}" bunx --bun prisma migrate dev --create-only --name init --schema="${schemaPath}"`,
    {
      stdio: "inherit",
    },
  );
  const afterMigrationContent = fs.readdirSync(migrationsDirectory);
  for (const item of afterMigrationContent) {
    const itemFullPath = path.join(migrationsDirectory, item);
    const itemStats = fs.statSync(itemFullPath);
    if (!itemStats.isDirectory()) {
      continue;
    }
    const migrationFilePath = path.join(itemFullPath, "migration.sql");
    if (!fs.existsSync(migrationFilePath)) {
      continue;
    }
    const migrationFileContent = fs.readFileSync(migrationFilePath, "utf-8");
    if (migrationFileContent.startsWith("-- This is an empty migration.")) {
      fs.rmSync(itemFullPath, {
        recursive: true,
        force: true,
      });
    }
  }

  const afterCleanContent = fs.readdirSync(migrationsDirectory);
  if (afterCleanContent.length == oldMigrationsContent.length) {
    let sameContent = true;
    for (const item of oldMigrationsContent) {
      if (
        !afterCleanContent.find((newItem) => {
          return item == newItem;
        })
      ) {
        sameContent = false;
        break;
      }
    }
    if (sameContent) {
      return null;
    }
  }

  const lastMigrationDirectory = afterCleanContent
    .map((item) => {
      const itemFullPath = path.join(migrationsDirectory, item);
      const itemStats = fs.statSync(itemFullPath);
      return {
        item,
        itemFullPath,
        itemStats,
      };
    })
    .filter((item) => {
      return item.itemStats.isDirectory();
    })
    .sort((itemA, itemB) => {
      return itemB.itemStats.mtimeMs - itemA.itemStats.mtimeMs;
    })
    .at(0);
  if (!lastMigrationDirectory) {
    throw new Error("no migration found");
  }
  return lastMigrationDirectory.itemFullPath;
};

const appendSchemaVersionToMigration = (migrationDirFullPath: string) => {
  const migraitonFileFullPath = path.join(
    migrationDirFullPath,
    "migration.sql",
  );
  const upsertSql = `
INSERT INTO SchemaVersion (id, version)
VALUES (1, ${REQUIRED_SCHEMA_VERSION})
ON DUPLICATE KEY UPDATE version = VALUES(version);
`;
  fs.appendFileSync(migraitonFileFullPath, `\n${upsertSql}`);
};

const runMigrateDev = async () => {
  const newMigration = await createMigration();
  if (!newMigration) {
    console.log("No changes");
    process.exit(0);
  }
  appendSchemaVersionToMigration(newMigration);
  execSync(
    `DATABASE_URL=${env.DATABASE_URL} bunx prisma migrate deploy --schema="${schemaPath}"`,
    {
      stdio: "inherit",
    },
  );

  console.log(
    "Migration created, SQL patched with version upsert. \ndeployed for database:",
    env.DATABASE_NAME,
    "\nnew migration at:",
    newMigration,
  );
};

if (require.main === module) {
  try {
    await runMigrateDev();
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
