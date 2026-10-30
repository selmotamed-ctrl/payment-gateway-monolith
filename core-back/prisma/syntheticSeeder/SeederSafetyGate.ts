import type { PrismaClient } from "../../generated/prisma/client";

/**
 * Five-layer pre-flight safety gate.
 *
 * Test servers may legitimately run with `NODE_ENV=production` to match the
 * production build, so the gate never relies on `NODE_ENV` alone. The seeder
 * refuses to run unless:
 *
 *  1. `IS_TEST_SERVER=true`;
 *  2. `FAKE_RAILS_ENABLED=true` and a public base URL are set;
 *  3. in production, `FAKE_RAILS_ALLOW_IN_PRODUCTION=true`;
 *  4. every configured gateway environment points ONLY at Fake Rails hosts;
 *  5. a live handshake with the Fake Rails service succeeds.
 */

export interface FakeRailsHealthReport {
  ok: boolean;
  service?: string;
  ready?: boolean;
  rails?: number;
  transactionCount?: number;
  at?: string;
  [key: string]: unknown;
}

const allowedFakeHosts = (): Set<string> =>
  new Set(
    (process.env.FAKE_RAILS_ALLOWED_HOSTS ?? "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );

export const assertSafeToSeedSyntheticData = async (
  prisma: PrismaClient,
): Promise<FakeRailsHealthReport> => {
  if (process.env.IS_TEST_SERVER !== "true") {
    throw new Error(
      "SEEDER_BLOCKED_NOT_TEST_SERVER: Refusing to run synthetic seeder because IS_TEST_SERVER is not 'true'. " +
        "This seeder is strictly restricted to designated test/sandbox servers.",
    );
  }

  if (process.env.FAKE_RAILS_ENABLED !== "true" || !process.env.FAKE_RAILS_PUBLIC_BASE_URL) {
    throw new Error(
      "SEEDER_BLOCKED_FAKE_RAILS_DISABLED: FAKE_RAILS_ENABLED='true' and FAKE_RAILS_PUBLIC_BASE_URL are required.",
    );
  }

  if (process.env.NODE_ENV === "production" && process.env.FAKE_RAILS_ALLOW_IN_PRODUCTION !== "true") {
    throw new Error(
      "SEEDER_BLOCKED_PROD_GUARD: NODE_ENV is 'production' but FAKE_RAILS_ALLOW_IN_PRODUCTION is not 'true'.",
    );
  }

  const allowed = allowedFakeHosts();
  if (allowed.size === 0) {
    throw new Error("SEEDER_BLOCKED_NO_ALLOWED_HOSTS: FAKE_RAILS_ALLOWED_HOSTS is empty.");
  }
  const environments = await prisma.gatewayEnvironment.findMany({
    include: { gatewayVersion: { include: { gateway: true } } },
  });
  if (environments.length === 0) {
    throw new Error("SEEDER_BLOCKED_NO_FAKE_RAILS_SEEDED: Run seedFakeRails.ts first so fake gateways exist.");
  }
  for (const environment of environments) {
    const urls = Object.values((environment.baseUrls as Record<string, string>) ?? {});
    for (const rawUrl of urls) {
      let hostname = "";
      try {
        hostname = new URL(rawUrl).hostname.toLowerCase();
      } catch {
        throw new Error(
          `SEEDER_BLOCKED_INVALID_GATEWAY_URL: Gateway '${environment.gatewayVersion.gateway.code}' has an invalid base URL '${rawUrl}'.`,
        );
      }
      if (!allowed.has(hostname)) {
        throw new Error(
          `SEEDER_BLOCKED_EXTERNAL_HOST_DETECTED: Gateway '${environment.gatewayVersion.gateway.code}' points to '${hostname}', ` +
            "which is not in FAKE_RAILS_ALLOWED_HOSTS. Synthetic data can only be seeded against Fake Rails.",
        );
      }
    }
  }

  const healthUrl = new URL("/portal-api/internal/seeder-handshake", process.env.FAKE_RAILS_PUBLIC_BASE_URL);
  let response: Response;
  try {
    response = await fetch(healthUrl.toString(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-fake-rails-seeder-token": process.env.FAKE_RAILS_SEEDER_TOKEN ?? "",
      },
      body: JSON.stringify({ check: "PRE_FLIGHT_SEEDER_SYNC" }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new Error(
      `SEEDER_BLOCKED_FAKE_RAILS_UNREACHABLE: Fake Rails handshake failed: ${error instanceof Error ? error.message : "network error"}`,
    );
  }
  if (!response.ok) {
    throw new Error(`SEEDER_BLOCKED_FAKE_RAILS_UNREACHABLE: Fake Rails handshake failed with HTTP ${response.status}`);
  }
  return (await response.json()) as FakeRailsHealthReport;
};
