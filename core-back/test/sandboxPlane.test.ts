import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { PoolClient } from "pg";
import {
  accessTokenPrefixForPlane,
  getExecutionPlane,
  isLivePlane,
  isSandboxPlane,
  tokenMatchesPlane,
} from "../lib/executionPlane";
import { verifyExecutionPlaneFenceOnBoot, type PlaneFenceClient } from "../engine/PlaneFenceGuard";
import {
  createPool,
  createSchema,
  databaseIsReachable,
  describeDatabase,
  dropSchema,
  safeSchemaName,
} from "./storage-engine/helpers/db";

describe("execution plane resolution", () => {
  test("defaults to LIVE and accepts both explicit planes", () => {
    const previous = process.env.EXECUTION_PLANE;
    try {
      delete process.env.EXECUTION_PLANE;
      expect(getExecutionPlane()).toBe("LIVE");
      process.env.EXECUTION_PLANE = "sandbox";
      expect(getExecutionPlane()).toBe("SANDBOX");
      expect(isSandboxPlane()).toBe(true);
      expect(isLivePlane()).toBe(false);
      process.env.EXECUTION_PLANE = "LIVE";
      expect(isLivePlane()).toBe(true);
    } finally {
      process.env.EXECUTION_PLANE = previous;
      if (previous === undefined) delete process.env.EXECUTION_PLANE;
    }
  });

  test("an invalid plane aborts", () => {
    const previous = process.env.EXECUTION_PLANE;
    try {
      process.env.EXECUTION_PLANE = "STAGING";
      expect(() => getExecutionPlane()).toThrow(/EXECUTION_PLANE/);
    } finally {
      process.env.EXECUTION_PLANE = previous;
      if (previous === undefined) delete process.env.EXECUTION_PLANE;
    }
  });

  test("API token prefixes are plane-bound", () => {
    expect(accessTokenPrefixForPlane("LIVE")).toBe("pg_live_");
    expect(accessTokenPrefixForPlane("SANDBOX")).toBe("pg_test_");
    expect(tokenMatchesPlane("pg_live_abc", "LIVE")).toBe(true);
    expect(tokenMatchesPlane("pg_live_abc", "SANDBOX")).toBe(false);
    expect(tokenMatchesPlane("pg_test_abc", "SANDBOX")).toBe(true);
    expect(tokenMatchesPlane("pg_test_abc", "LIVE")).toBe(false);
    expect(tokenMatchesPlane("session.jwt.token", "LIVE")).toBe(true);
    expect(tokenMatchesPlane("session.jwt.token", "SANDBOX")).toBe(true);
  });
});

const fakeClient = (row: { plane: string; allowFakeRails: boolean } | null): PlaneFenceClient => ({
  systemExecutionPlane: {
    findUnique: async () => (row ? { id: 1, ...row } : null),
    create: async ({ data }) => ({ ...data, plane: data.plane }),
  },
});

describe("boot plane fence guard", () => {
  test("refuses a process whose plane differs from the connected database", async () => {
    await expect(
      verifyExecutionPlaneFenceOnBoot({
        db: fakeClient({ plane: "LIVE", allowFakeRails: false }),
        processEnv: { NODE_ENV: "test" },
        expectedPlane: "SANDBOX",
      }),
    ).rejects.toThrow(/FATAL_PLANE_FENCE_VIOLATION/);
  });

  test("refuses Fake Rails on a LIVE process unless the development escape hatch is set", async () => {
    await expect(
      verifyExecutionPlaneFenceOnBoot({
        db: fakeClient({ plane: "LIVE", allowFakeRails: false }),
        processEnv: { NODE_ENV: "production", FAKE_RAILS_ENABLED: "true" },
        expectedPlane: "LIVE",
      }),
    ).rejects.toThrow(/FAKE_RAILS_ENABLED/);

    await expect(
      verifyExecutionPlaneFenceOnBoot({
        db: fakeClient({ plane: "LIVE", allowFakeRails: false }),
        processEnv: {
          NODE_ENV: "production",
          FAKE_RAILS_ENABLED: "true",
          PLANE_FENCE_ALLOW_FAKE_RAILS_ON_LIVE: "true",
        },
        expectedPlane: "LIVE",
      }),
    ).resolves.toBeUndefined();
  });

  test("refuses a LIVE database whose allow_fake_rails flag is set", async () => {
    await expect(
      verifyExecutionPlaneFenceOnBoot({
        db: fakeClient({ plane: "LIVE", allowFakeRails: true }),
        processEnv: { NODE_ENV: "production", FAKE_RAILS_ENABLED: "false" },
        expectedPlane: "LIVE",
      }),
    ).rejects.toThrow(/allow_fake_rails/);
  });

  test("provisions the plane row on first boot and accepts a matching plane", async () => {
    await expect(
      verifyExecutionPlaneFenceOnBoot({
        db: fakeClient(null),
        processEnv: { NODE_ENV: "test" },
        expectedPlane: "SANDBOX",
      }),
    ).resolves.toBeUndefined();
  });
});

const dbTest = databaseIsReachable ? test : test.skip;
const schema = safeSchemaName("sandbox_plane");

const withStrictSession = async <T>(
  pool: ReturnType<typeof createPool>,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.plane_fence_strict', 'true', true)");
    const result = await work(client);
    await client.query("ROLLBACK");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
};

describeDatabase("database execution-plane fence", () => {
  beforeAll(async () => {
    await createSchema(schema);
    const pool = createPool({ schema });
    try {
      await pool.query(`
        CREATE TABLE system_execution_plane (
          id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
          plane VARCHAR(16) NOT NULL,
          allow_fake_rails BOOLEAN NOT NULL DEFAULT FALSE
        );
        CREATE TABLE payment_links (id TEXT PRIMARY KEY, env VARCHAR(16) NOT NULL DEFAULT 'LIVE');
        CREATE TABLE gateways (code TEXT PRIMARY KEY, env VARCHAR(16) NOT NULL DEFAULT 'LIVE');
        CREATE TABLE gateway_environments (id TEXT PRIMARY KEY, enabled BOOLEAN NOT NULL DEFAULT TRUE, base_urls JSONB);
        CREATE FUNCTION enforce_execution_plane_env_fence()
        RETURNS TRIGGER AS $$
        DECLARE
          v_plane VARCHAR(16);
          v_strict BOOLEAN;
        BEGIN
          SELECT "plane" INTO v_plane FROM "system_execution_plane" WHERE "id" = 1;
          IF v_plane IS NULL THEN
            RAISE EXCEPTION 'SANDBOX_FENCE_VIOLATION: system_execution_plane row is missing' USING ERRCODE = 'P0001';
          END IF;
          v_strict := v_plane = 'SANDBOX'
            OR LOWER(COALESCE(current_setting('app.plane_fence_strict', true), 'false')) IN ('1', 'true', 'yes', 'on');
          IF v_strict AND NEW."env"::text <> v_plane THEN
            RAISE EXCEPTION 'SANDBOX_FENCE_VIOLATION: Cannot write row with env=% into % database plane (table=%)',
              NEW."env", v_plane, TG_TABLE_NAME USING ERRCODE = 'P0001';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        CREATE FUNCTION enforce_no_fake_rails_on_live_plane()
        RETURNS TRIGGER AS $$
        DECLARE
          v_plane VARCHAR(16);
          v_allow_fake BOOLEAN;
        BEGIN
          SELECT "plane", "allow_fake_rails" INTO v_plane, v_allow_fake
          FROM "system_execution_plane" WHERE "id" = 1;
          IF v_plane = 'LIVE'
             AND COALESCE(v_allow_fake, FALSE) = FALSE
             AND LOWER(COALESCE(current_setting('app.plane_fence_strict', true), 'false')) IN ('1', 'true', 'yes', 'on') THEN
            IF TG_TABLE_NAME = 'gateways' THEN
              IF NEW."code" ILIKE 'FAKE%' OR NEW."code" ILIKE '%FAKE_RAILS%' THEN
                RAISE EXCEPTION 'SANDBOX_FENCE_VIOLATION: Fake Rails gateway (%) cannot be registered on LIVE execution plane', NEW."code" USING ERRCODE = 'P0001';
              END IF;
            ELSIF TG_TABLE_NAME = 'gateway_environments' THEN
              IF NEW."enabled" = TRUE AND NEW."base_urls"::text ILIKE '%fake-rails%' THEN
                RAISE EXCEPTION 'SANDBOX_FENCE_VIOLATION: a gateway environment pointed at Fake Rails cannot be enabled on LIVE execution plane' USING ERRCODE = 'P0001';
              END IF;
            END IF;
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER trg_test_plane_links BEFORE INSERT OR UPDATE ON payment_links
          FOR EACH ROW EXECUTE FUNCTION enforce_execution_plane_env_fence();
        CREATE TRIGGER trg_test_plane_gateways BEFORE INSERT OR UPDATE ON gateways
          FOR EACH ROW EXECUTE FUNCTION enforce_no_fake_rails_on_live_plane();
        CREATE TRIGGER trg_test_plane_gateway_envs BEFORE INSERT OR UPDATE ON gateway_environments
          FOR EACH ROW EXECUTE FUNCTION enforce_no_fake_rails_on_live_plane();
        INSERT INTO system_execution_plane (id, plane, allow_fake_rails) VALUES (1, 'LIVE', FALSE);
      `);
    } finally {
      await pool.end();
    }
  });

  afterAll(async () => {
    await dropSchema(schema);
  });

  dbTest("a strict LIVE database rejects a SANDBOX row", async () => {
    const pool = createPool({ schema });
    try {
      const failure = await withStrictSession(pool, (client) =>
        client
          .query(`INSERT INTO payment_links (id, env) VALUES ('l1', 'SANDBOX')`)
          .then(() => null)
          .catch((error: unknown) => error as Error),
      );
      expect(failure).not.toBeNull();
      expect(String(failure?.message)).toContain("SANDBOX_FENCE_VIOLATION");
    } finally {
      await pool.end();
    }
  });

  dbTest("a SANDBOX database rejects a LIVE row and accepts SANDBOX rows", async () => {
    const pool = createPool({ schema });
    try {
      await pool.query(`UPDATE system_execution_plane SET plane = 'SANDBOX', allow_fake_rails = TRUE WHERE id = 1`);
      await pool.query(`INSERT INTO payment_links (id, env) VALUES ('s1', 'SANDBOX')`);
      const failure = await pool
        .query(`INSERT INTO payment_links (id, env) VALUES ('l2', 'LIVE')`)
        .then(() => null)
        .catch((error: unknown) => error as Error);
      expect(String(failure?.message)).toContain("SANDBOX_FENCE_VIOLATION");
      const rows = await pool.query(`SELECT env FROM payment_links`);
      expect(rows.rowCount).toBe(1);
    } finally {
      await pool.end();
    }
  });

  dbTest("a LIVE database refuses a FAKE gateway and a Fake Rails environment", async () => {
    const pool = createPool({ schema });
    try {
      await pool.query(`UPDATE system_execution_plane SET plane = 'LIVE', allow_fake_rails = FALSE WHERE id = 1`);
      const fakeGateway = await withStrictSession(pool, (client) =>
        client
          .query(`INSERT INTO gateways (code, env) VALUES ('FAKE_RAILS', 'LIVE')`)
          .then(() => null)
          .catch((error: unknown) => error as Error),
      );
      const fakeEnvironment = await withStrictSession(pool, (client) =>
        client
          .query(`INSERT INTO gateway_environments (id, enabled, base_urls) VALUES ('e1', TRUE, '{"api":"http://fake-rails:4104"}')`)
          .then(() => null)
          .catch((error: unknown) => error as Error),
      );
      expect(String(fakeGateway?.message)).toContain("SANDBOX_FENCE_VIOLATION");
      expect(String(fakeEnvironment?.message)).toContain("SANDBOX_FENCE_VIOLATION");
    } finally {
      await pool.end();
    }
  });

  dbTest("the development opt-in permits Fake Rails on a LIVE database", async () => {
    const pool = createPool({ schema });
    try {
      await pool.query(`UPDATE system_execution_plane SET plane = 'LIVE', allow_fake_rails = TRUE WHERE id = 1`);
      await pool.query(`INSERT INTO gateways (code, env) VALUES ('FAKE_RAILS', 'LIVE')`);
      await pool.query(`INSERT INTO gateway_environments (id, enabled, base_urls) VALUES ('e2', TRUE, '{"api":"http://fake-rails:4104"}')`);
      const rows = await pool.query(`SELECT COUNT(*)::int AS count FROM gateway_environments`);
      expect(rows.rows[0].count).toBe(1);
    } finally {
      await pool.end();
    }
  });
});
