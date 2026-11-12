import "dotenv/config";
import { client } from "../prisma/client";

/**
 * Deploy helper: marks the current database as the LIVE or SANDBOX plane and
 * enables the strict execution-plane fence for the sandbox database.
 *
 *   bun run set-execution-plane LIVE
 *   bun run set-execution-plane SANDBOX
 */
const raw = process.argv[2]?.trim().toUpperCase();
if (raw !== "LIVE" && raw !== "SANDBOX") {
  console.error("usage: bun run set-execution-plane LIVE|SANDBOX");
  process.exit(1);
}

await client.$executeRawUnsafe(
  `INSERT INTO "sandbox_sync_watermarks" ("id", "execution_plane", "updated_at")
   VALUES ('singleton', $1::"GatewayEnvironmentType", now())
   ON CONFLICT ("id") DO UPDATE
     SET "execution_plane" = EXCLUDED."execution_plane", "updated_at" = now()`,
  raw,
);

const strict = raw === "SANDBOX" ? "on" : "off";
await client.$executeRawUnsafe(`
  DO $$
  BEGIN
    EXECUTE format('ALTER DATABASE %I SET pgw.execution_plane = %L', current_database(), '${raw}');
    EXECUTE format('ALTER DATABASE %I SET pgw.strict_plane_fence = %L', current_database(), '${strict}');
  END $$;
`);

console.log(`execution plane set to ${raw}${raw === "SANDBOX" ? " (strict fence on)" : ""}`);
await client.$disconnect();
