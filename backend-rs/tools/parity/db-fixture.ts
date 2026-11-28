/**
 * P0-T11 database fixture helper: a COMPACT synthetic seed dump with a checksum and a restore
 * command, stored under `backend-rs/tests/parity-fixtures/db/`.
 *
 * The dump is a CI artefact, not a committed binary: it is produced once from a database populated
 * with the TS synthetic seeder (`SYNTHETIC_SEED_PROFILE=COMPACT`), verified with a SHA-256 sidecar,
 * and restored into the two dual-DB parity databases before a write replay.
 *
 * Commands:
 *   bun backend-rs/tools/parity/db-fixture.ts dump      # DATABASE_URL -> fixture dir
 *   bun backend-rs/tools/parity/db-fixture.ts verify    # checksum + manifest
 *   bun backend-rs/tools/parity/db-fixture.ts status    # what is on disk
 *   bun backend-rs/tools/parity/db-fixture.ts restore --yes   # DATABASE_URL_B <- dump
 *
 * The restore is destructive (`--clean --if-exists`). It refuses to run without `--yes`.
 * `pg_dump` and `pg_restore` are system tools; `PG_BIN_DIR` can point at a PostgreSQL 18 bin
 * directory when they are not on PATH. The SHA-256 is computed in-process.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
export const DB_FIXTURE_DIR = path.join(REPO_ROOT, "backend-rs", "tests", "parity-fixtures", "db");
export const DUMP_NAME = "compact.dump";
export const MANIFEST_NAME = "compact.json";

export interface DbFixtureManifest {
  name: string;
  format: "pg_dump-custom";
  bytes: number;
  sha256: string;
  createdAt: string;
  schemaVersion: string | null;
  seededProfile: string;
  note: string;
}

const tool = (name: string): string => {
  const binDir = process.env.PG_BIN_DIR;
  if (binDir) {
    const candidate = path.join(binDir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return name;
};

const redact = (url: string): string => {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = "***";
    return parsed.toString();
  } catch {
    return "<invalid url>";
  }
};

const run = async (command: string[]): Promise<void> => {
  const env = { ...process.env } as Record<string, string>;
  if (process.env.PGPASSWORD === undefined) delete env.PGPASSWORD;
  const proc = Bun.spawn({
    cmd: command,
    env,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "ignore",
  });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`${command[0]} exited with ${code}`);
  }
};

const sha256File = (file: string): string => {
  const hash = createHash("sha256");
  hash.update(fs.readFileSync(file));
  return hash.digest("hex");
};

const readManifest = (dir: string): DbFixtureManifest | null => {
  const file = path.join(dir, MANIFEST_NAME);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8")) as DbFixtureManifest;
};

const dump = async (dir: string): Promise<void> => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required for `dump` (a COMPACT-seeded TS database)");
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, DUMP_NAME);
  console.log(`Dumping ${redact(url)} -> ${target}`);
  await run([
    tool("pg_dump"),
    "--format=custom",
    "--compress=9",
    "--no-owner",
    "--no-privileges",
    `--file=${target}`,
    url,
  ]);
  const bytes = fs.statSync(target).size;
  const sha256 = sha256File(target);
  let schemaVersion: string | null = null;
  try {
    const SQL = (globalThis as { Bun?: { SQL?: unknown } }).Bun?.SQL;
    if (typeof SQL === "function") {
      const sql = new (SQL as new (url: string) => {
        unsafe: (query: string) => Promise<Record<string, unknown>[]>;
        close: () => Promise<void>;
      })(url);
      try {
        const rows = await sql.unsafe("select max(version)::text as version from schema_versions");
        schemaVersion = rows[0]?.version ? String(rows[0].version) : null;
      } finally {
        await sql.close();
      }
    }
  } catch {
    // The version is informative; the dump itself is already valid.
  }
  const manifest: DbFixtureManifest = {
    name: DUMP_NAME,
    format: "pg_dump-custom",
    bytes,
    sha256,
    createdAt: new Date().toISOString(),
    schemaVersion,
    seededProfile: process.env.SYNTHETIC_SEED_PROFILE ?? "COMPACT",
    note: "Restore with `db-fixture.ts restore --yes`; compare with `db-diff.ts`.",
  };
  fs.writeFileSync(path.join(dir, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`Wrote ${MANIFEST_NAME}: ${bytes} bytes, sha256 ${sha256}`);
};

const verify = (dir: string): void => {
  const manifest = readManifest(dir);
  if (!manifest) throw new Error(`no ${MANIFEST_NAME} in ${dir}; run \`dump\` first`);
  const target = path.join(dir, manifest.name);
  if (!fs.existsSync(target)) throw new Error(`manifest names ${manifest.name} but the file is missing`);
  const bytes = fs.statSync(target).size;
  const sha256 = sha256File(target);
  if (bytes !== manifest.bytes) throw new Error(`size mismatch: manifest ${manifest.bytes}, file ${bytes}`);
  if (sha256 !== manifest.sha256) throw new Error(`sha256 mismatch: manifest ${manifest.sha256}, file ${sha256}`);
  console.log(`OK ${manifest.name}: ${bytes} bytes, sha256 ${sha256}, schema ${manifest.schemaVersion ?? "unknown"}`);
};

const status = (dir: string): void => {
  const manifest = readManifest(dir);
  if (!manifest) {
    console.log(`No database fixture in ${dir}.`);
    console.log("Create one: DATABASE_URL=<compact-seeded> bun backend-rs/tools/parity/db-fixture.ts dump");
    return;
  }
  const target = path.join(dir, manifest.name);
  const present = fs.existsSync(target);
  const bytes = present ? fs.statSync(target).size : 0;
  console.log(`fixture: ${manifest.name}`);
  console.log(`present: ${present} (${bytes} bytes)`);
  console.log(`sha256:  ${manifest.sha256}`);
  console.log(`schema:  ${manifest.schemaVersion ?? "unknown"}`);
  console.log(`created: ${manifest.createdAt}`);
  if (present && bytes !== manifest.bytes) console.log("WARNING: file size differs from the manifest");
};

const restore = async (dir: string, confirmed: boolean): Promise<void> => {
  if (!confirmed) {
    throw new Error("refusing a destructive restore without --yes (it drops and recreates objects)");
  }
  const url = process.env.DATABASE_URL_B;
  if (!url) throw new Error("DATABASE_URL_B is required for `restore` (the Rust-side parity database)");
  verify(dir);
  const manifest = readManifest(dir)!;
  const source = path.join(dir, manifest.name);
  console.log(`Restoring ${source} -> ${redact(url)} (clean)`);
  await run([
    tool("pg_restore"),
    "--clean",
    "--if-exists",
    "--no-owner",
    "--no-privileges",
    "--exit-on-error",
    `--dbname=${url}`,
    source,
  ]);
  console.log("Restore complete. Next: run the scenario, then `db-diff.ts`.");
};

const HELP = `Usage: bun backend-rs/tools/parity/db-fixture.ts <command> [options]

Commands:
  dump                 pg_dump DATABASE_URL into tests/parity-fixtures/db/compact.dump + manifest
  verify               Recompute the checksum and compare with the manifest
  status               Show the fixture and manifest state
  restore --yes        pg_restore the fixture into DATABASE_URL_B (destructive)

Environment:
  DATABASE_URL         Source (TS) database for dump.
  DATABASE_URL_B       Target (Rust) database for restore.
  SYNTHETIC_SEED_PROFILE  Recorded in the manifest (default COMPACT).
  PG_BIN_DIR           Directory holding pg_dump/pg_restore when they are not on PATH.

The dump is not committed; store it as a CI artefact together with compact.json.
`;

const main = async (): Promise<number> => {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const dir = process.env.PARITY_DB_FIXTURE_DIR
    ? path.resolve(process.env.PARITY_DB_FIXTURE_DIR)
    : DB_FIXTURE_DIR;
  try {
    switch (command) {
      case "dump":
        await dump(dir);
        return 0;
      case "verify":
        verify(dir);
        return 0;
      case "status":
        status(dir);
        return 0;
      case "restore":
        await restore(dir, argv.includes("--yes"));
        return 0;
      case "--help":
      case "-h":
      case undefined:
        console.log(HELP);
        return command === undefined ? 2 : 0;
      default:
        console.error(`unknown command ${command}`);
        console.error(HELP);
        return 2;
    }
  } catch (error) {
    console.error((error as Error).message);
    return 2;
  }
};

if (import.meta.main) {
  process.exitCode = await main();
}
