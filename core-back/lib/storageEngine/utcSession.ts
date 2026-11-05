import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client";
import { buildPostgresPoolConfig } from "../db/connectionConfig";

/**
 * Timezone pinning (GAP-030).
 *
 * Every connection the storage engine opens starts with `timezone=UTC` as a
 * startup parameter, so the session timezone is UTC regardless of the server's
 * `postgresql.conf`, the role's `ALTER ROLE ... SET timezone` or the host. The
 * columns that matter are `timestamptz`, and `now()` / `clock_timestamp()` /
 * `CURRENT_TIMESTAMP` casts into `timestamp` columns would otherwise depend on
 * the session zone.
 *
 * The parameter is carried in the connection URL (`options=-c timezone=UTC`)
 * because node-postgres lets the connection string override explicit config.
 */
export const UTC_STARTUP_OPTION = "-c timezone=UTC";

const hasTimezoneOption = (options: string): boolean => /(^|\s)-c\s*timezone\s*=/i.test(options) || /--timezone\s*=/i.test(options);

export const pinUtcInConnectionUrl = (databaseUrl: string): string => {
  const url = new URL(databaseUrl);
  const existing = url.searchParams.get("options") ?? "";
  if (hasTimezoneOption(existing)) {
    // Any other timezone in the URL is replaced: the engine is UTC by contract.
    const stripped = existing
      .replace(/(^|\s)-c\s*timezone\s*=\s*\S+/gi, " ")
      .replace(/--timezone\s*=\s*\S+/gi, " ")
      .trim();
    url.searchParams.set("options", `${stripped} ${UTC_STARTUP_OPTION}`.trim());
    return url.toString();
  }
  url.searchParams.set("options", `${existing} ${UTC_STARTUP_OPTION}`.trim());
  return url.toString();
};

/** A Prisma client whose every pooled connection runs in UTC. */
export const createUtcPinnedClient = (databaseUrl: string): PrismaClient =>
  new PrismaClient({
    adapter: new PrismaPg(buildPostgresPoolConfig(pinUtcInConnectionUrl(databaseUrl))),
    log: [],
  });

export const readSessionTimeZone = async (db: {
  $queryRawUnsafe: (sql: string) => Promise<unknown>;
}): Promise<string | null> => {
  const rows = (await db.$queryRawUnsafe("SHOW timezone")) as Array<{ TimeZone?: string; timezone?: string }> | null;
  const row = Array.isArray(rows) ? rows[0] : undefined;
  return row?.TimeZone ?? row?.timezone ?? null;
};
