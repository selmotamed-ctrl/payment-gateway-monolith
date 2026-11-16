import { afterAll, describe, expect, test } from "bun:test";
import { createRow } from "./exhaustive/_dbFactory";
import { databaseIsReachable, exhaustiveClient } from "./exhaustive/_harness";

/**
 * Database-level guarantees of migration 20261111090000 (needs a migrated PostgreSQL; skipped without one):
 *  - a merchant's report spec can only use its own merchant's asset bundle, and an audit row only its own spec;
 *  - the execution audit is append-only in every way: no UPDATE, DELETE, TRUNCATE or SET NULL through a deleted spec;
 *  - one report can be open or completed only once per filing adapter.
 */

const describeDb = databaseIsReachable ? describe : describe.skip;
const db = () => exhaustiveClient();

const refused = async (work: Promise<unknown>): Promise<string | null> =>
  work.then(() => null, (error: unknown) => (error instanceof Error ? error.message : String(error)));

const created: Array<[table: string, id: string]> = [];
const make = async (table: string, overrides: Record<string, unknown> = {}) => {
  const row = await createRow(table, overrides);
  created.push([table, String(row.id)]);
  return row;
};

afterAll(async () => {
  // The execution audit is append-only, so a test leaves its rows behind; everything else is removed best-effort.
  for (const [table, id] of created.reverse()) {
    await db().$executeRawUnsafe(`DELETE FROM "${table}" WHERE "id" = $1::uuid`, id).catch(() => undefined);
  }
});

describeDb("merchant report tenant isolation (database level)", () => {
  test("a spec cannot reference another merchant's asset bundle", async () => {
    const merchantA = await make("merchants");
    const merchantB = await make("merchants");
    const bundleOfB = await make("merchant_report_asset_bundles", { merchant_id: merchantB.id });

    const crossTenant = await refused(make("merchant_report_specs", { merchant_id: merchantA.id, asset_bundle_id: bundleOfB.id }));
    expect(crossTenant).not.toBeNull();
    expect(crossTenant).toContain("merchant_report_specs_asset_bundle_tenant_fkey");

    const own = await make("merchant_report_specs", { merchant_id: merchantB.id, asset_bundle_id: bundleOfB.id });
    expect(own.asset_bundle_id).toBe(bundleOfB.id);
  });

  test("a spec without a bundle is allowed, and deleting a bundle clears only the reference", async () => {
    const merchant = await make("merchants");
    const bundle = await make("merchant_report_asset_bundles", { merchant_id: merchant.id });
    const spec = await make("merchant_report_specs", { merchant_id: merchant.id, asset_bundle_id: bundle.id });
    const bare = await make("merchant_report_specs", { merchant_id: merchant.id, asset_bundle_id: null });
    expect(bare.asset_bundle_id).toBeNull();

    await db().$executeRawUnsafe(`DELETE FROM "merchant_report_asset_bundles" WHERE "id" = $1::uuid`, bundle.id);
    const after = (await db().$queryRawUnsafe(`SELECT asset_bundle_id, merchant_id FROM merchant_report_specs WHERE id = $1::uuid`, spec.id)) as Array<Record<string, unknown>>;
    expect(after[0]?.asset_bundle_id).toBeNull();
    expect(after[0]?.merchant_id).toBe(merchant.id); // the tenant column is untouched
  });

  test("an audit row cannot carry another merchant's spec", async () => {
    const merchantA = await make("merchants");
    const merchantB = await make("merchants");
    const specOfB = await make("merchant_report_specs", { merchant_id: merchantB.id });

    const crossTenant = await refused(make("merchant_report_execution_audit", { merchant_id: merchantA.id, merchant_spec_id: specOfB.id }));
    expect(crossTenant).not.toBeNull();
    expect(crossTenant).toContain("merchant_report_execution_audit_spec_tenant_fkey");
    expect(await refused(make("merchant_report_execution_audit", { merchant_id: merchantB.id, merchant_spec_id: specOfB.id }))).toBeNull();
  });

  test("merchant_id must be a real merchant on every merchant report table", async () => {
    const ghost = "00000000-0000-7000-8000-00000000dead";
    for (const [table, overrides] of [
      ["merchant_report_rate_events", { merchant_id: ghost }],
      ["merchant_report_studio_status", { merchant_id: ghost }],
    ] as const) {
      const message = await refused(db().$executeRawUnsafe(
        table === "merchant_report_rate_events"
          ? `INSERT INTO "${table}" ("id", "merchant_id", "action") VALUES (gen_random_uuid(), $1::uuid, 'execute')`
          : `INSERT INTO "${table}" ("merchant_id", "updated_at") VALUES ($1::uuid, now())`,
        overrides.merchant_id,
      ));
      expect(message, table).toContain("violates foreign key constraint");
    }
  });
});

describeDb("merchant report execution audit is append-only", () => {
  test("UPDATE, DELETE and TRUNCATE are refused", async () => {
    const merchant = await make("merchants");
    const audit = await make("merchant_report_execution_audit", { merchant_id: merchant.id, merchant_spec_id: null });
    expect(await refused(db().$executeRawUnsafe(`UPDATE "merchant_report_execution_audit" SET "row_count_total" = 99 WHERE "id" = $1::uuid`, audit.id))).toContain("append-only");
    expect(await refused(db().$executeRawUnsafe(`DELETE FROM "merchant_report_execution_audit" WHERE "id" = $1::uuid`, audit.id))).toContain("append-only");
    expect(await refused(db().$executeRawUnsafe(`TRUNCATE "merchant_report_execution_audit"`))).toContain("append-only");
  });

  test("deleting a spec that audit rows reference is refused cleanly (no SET NULL update against the trigger)", async () => {
    const merchant = await make("merchants");
    const spec = await make("merchant_report_specs", { merchant_id: merchant.id });
    await make("merchant_report_execution_audit", { merchant_id: merchant.id, merchant_spec_id: spec.id });

    const message = await refused(db().$executeRawUnsafe(`DELETE FROM "merchant_report_specs" WHERE "id" = $1::uuid`, spec.id));
    expect(message).not.toBeNull();
    expect(message).toContain("violates RESTRICT setting of foreign key constraint"); // not the trigger's "append-only" error
    expect(message).not.toContain("append-only");
    const still = (await db().$queryRawUnsafe(`SELECT count(*)::int AS n FROM merchant_report_specs WHERE id = $1::uuid`, spec.id)) as Array<{ n: number }>;
    expect(still[0]?.n).toBe(1);
  });
});

describeDb("external filing submissions are filed at most once per report and adapter", () => {
  const submission = async (reportId: unknown, adapterId: unknown, status: string) =>
    createRow("external_submissions", { report_id: reportId, adapter_id: adapterId, status }).then((row) => {
      created.push(["external_submissions", String(row.id)]);
      return row;
    });

  test("a second open or completed submission is refused, a failed or rejected one can be retried", async () => {
    const report = await make("regulatory_reports");
    const adapter = await make("external_filing_adapters");

    const first = await submission(report.id, adapter.id, "PENDING");
    for (const status of ["PENDING", "SUBMITTED", "ACKNOWLEDGED"]) {
      const message = await refused(submission(report.id, adapter.id, status));
      expect(message, status).toContain("external_submissions_open_report_adapter_key");
    }

    // The first one fails: the report may be filed again.
    await db().$executeRawUnsafe(`UPDATE "external_submissions" SET "status" = 'FAILED' WHERE "id" = $1::uuid`, first.id);
    expect(await refused(submission(report.id, adapter.id, "PENDING"))).toBeNull();
    // ... but only one retry may be open.
    expect(await refused(submission(report.id, adapter.id, "PENDING"))).toContain("external_submissions_open_report_adapter_key");
  });

  test("another adapter or another report is independent", async () => {
    const report = await make("regulatory_reports");
    const otherReport = await make("regulatory_reports");
    const adapter = await make("external_filing_adapters");
    const otherAdapter = await make("external_filing_adapters");
    await submission(report.id, adapter.id, "SUBMITTED");
    expect(await refused(submission(report.id, otherAdapter.id, "PENDING"))).toBeNull();
    expect(await refused(submission(otherReport.id, adapter.id, "PENDING"))).toBeNull();
  });
});
