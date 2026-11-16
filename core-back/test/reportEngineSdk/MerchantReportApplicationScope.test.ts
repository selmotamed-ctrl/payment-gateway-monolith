import { describe, expect, test } from "bun:test";
import { compileDatasetQueryToSql } from "../../lib/reportEngineSdk/compiler/QueryAstToSqlCompiler";
import { MERCHANT_REPORT_MODEL_ALLOWLIST, getMerchantReportHostConfig } from "../../engine/reportStudio/merchantHostConfig";
import { merchantCacheKey } from "../../engine/reportStudio/merchantReportEngine";
import { buildPaymentGatewayAutocompleteProviders } from "../../engine/reportStudio/autocompleteProviders";
import { baseReportSpec } from "./helpers";

/**
 * Regression: a merchant SESSION user can be restricted to some applications (`app_scope_ids`) and the other merchant
 * routes honour it. The merchant report engine ignored it: such a user could run (or author) a report over
 * payment_attempts, wallets, cash-outs or the daily stats and receive the rows of EVERY application of the merchant.
 *
 * A restricted user may now report only on models whose rows belong to one application (payment_attempts), narrowed to
 * their applications by the engine; merchant-wide models are refused, as the merchant overview is.
 */

const MERCHANT_ID = "11111111-1111-4111-8111-111111111111";
const APP_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const APP_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const datasetOn = (model: string, alias: string) => {
  const spec = baseReportSpec();
  const dataset = spec.datasets[0]!;
  dataset.from_model = model;
  dataset.from_alias = alias;
  dataset.joins = [];
  dataset.select = [{ alias: "m", column: "merchant_id", expression: "COLUMN", format_hint: "RAW" }];
  dataset.where = { kind: "GROUP", logic: "AND", conditions: [] };
  dataset.group_by = [];
  dataset.having = [];
  return dataset;
};

describe("the merchant host declares which models belong to one application", () => {
  test("only payment_attempts carries an application column; the rest are merchant-wide", () => {
    const host = getMerchantReportHostConfig();
    const narrowable = MERCHANT_REPORT_MODEL_ALLOWLIST.filter((name) => host.models[name]?.merchantScopable?.applicationIdColumn);
    expect(narrowable).toEqual(["payment_attempts"]);
    expect(host.models.payment_attempts?.merchantScopable?.applicationIdColumn).toBe("application_id");
    for (const name of ["wallets", "cashout_requests", "rm_merchant_daily_stats"]) {
      expect(host.models[name], name).toBeDefined();
      expect(host.models[name]?.merchantScopable?.applicationIdColumn, name).toBeUndefined();
    }
  });
});

describe("the compiler narrows a restricted user's report to their applications", () => {
  test("payment_attempts gets the merchant predicate AND an application predicate, both bound", () => {
    const compiled = compileDatasetQueryToSql(
      datasetOn("payment_attempts", "pa"), getMerchantReportHostConfig(), {}, undefined,
      { merchantScope: { merchantId: MERCHANT_ID, applicationIds: [APP_A, APP_B] } },
    );
    expect(compiled.sql).toContain('"pa"."merchant_id" = $');
    expect(compiled.sql).toMatch(/"pa"\."application_id" = ANY\(\$\d+::uuid\[\]\)/);
    expect(compiled.values).toContain(MERCHANT_ID);
    expect(compiled.values.some((value) => Array.isArray(value) && value.join() === [APP_A, APP_B].join())).toBe(true);
    expect(compiled.sql).not.toContain(APP_A);
  });

  test("an unrestricted user gets no application predicate (unchanged behaviour)", () => {
    for (const applicationIds of [undefined, []]) {
      const compiled = compileDatasetQueryToSql(
        datasetOn("payment_attempts", "pa"), getMerchantReportHostConfig(), {}, undefined,
        { merchantScope: { merchantId: MERCHANT_ID, applicationIds } },
      );
      expect(compiled.sql).not.toContain("application_id");
    }
  });

  test("a merchant-wide model cannot be narrowed, so the compiler refuses it for a restricted user", () => {
    for (const model of ["wallets", "cashout_requests", "rm_merchant_daily_stats"]) {
      expect(() => compileDatasetQueryToSql(
        datasetOn(model, "t"), getMerchantReportHostConfig(), {}, undefined,
        { merchantScope: { merchantId: MERCHANT_ID, applicationIds: [APP_A] } },
      ), model).toThrow("APP_SCOPE_MODEL_NOT_ALLOWED");
      // ... while the same dataset compiles for an unrestricted user.
      expect(() => compileDatasetQueryToSql(
        datasetOn(model, "t"), getMerchantReportHostConfig(), {}, undefined,
        { merchantScope: { merchantId: MERCHANT_ID } },
      ), model).not.toThrow();
    }
  });
});

describe("the result cache never mixes restricted and unrestricted users", () => {
  const spec = baseReportSpec();
  const key = (applicationIds?: readonly string[]) => merchantCacheKey({ merchantId: MERCHANT_ID, spec, inputs: {}, applicationIds });

  test("a restricted user's key differs from an unrestricted one's, and from another restriction's", () => {
    expect(key([APP_A])).not.toBe(key());
    expect(key([APP_A])).not.toBe(key([APP_B]));
    expect(key([APP_A, APP_B])).toBe(key([APP_B, APP_A])); // the order of the scope does not matter
    expect(key()).toBe(key(undefined));
  });
});

describe("the merchant execute route", () => {
  test("refuses merchant-wide specs to a restricted user before it executes, and passes the scope on", async () => {
    const source = (await Bun.file(new URL("../../api/internal/merchantReportEngine.ts", import.meta.url)).text()).split("\r\n").join("\n");
    const start = source.indexOf("const applicationIds = applicationScopeOf(request);");
    expect(start).toBeGreaterThan(-1);
    expect(source).toContain('"APP_SCOPE_RESTRICTED"');
    expect(source.indexOf("assertSpecFitsApplicationScope(spec, applicationIds)")).toBeLessThan(source.indexOf("await assertMerchantBudget(merchantId);", start));
    expect(source).toContain("merchantCacheKey({ merchantId, spec, inputs: forcedInputs, applicationIds, chromeFingerprint })");
    expect(source).toMatch(/merchantScope: \{\s+merchantId,\s+applicationIds,/);
    // An API token is bound to one application by the token itself: only a session carries app_scope_ids.
    expect(source).toContain('if (principal.kind !== "session") return undefined;');
  });
});

describe("merchant report autocomplete", () => {
  // The input pickers of a report (application, payment link, POS terminal) searched the whole merchant: a
  // user restricted to some applications could look up the names and ids of the others.
  const capture = () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const db = {
      executeReadOnlyQuery: async (params: { sql: string; values: unknown[] }) => {
        calls.push({ sql: params.sql, values: params.values });
        return { rows: [] };
      },
    };
    return { calls, providers: buildPaymentGatewayAutocompleteProviders(db as never) };
  };
  const actor = { userId: "u", role: "MERCHANT_STAFF", authorities: [], merchantId: MERCHANT_ID } as never;
  const APP_A = "22222222-2222-4222-8222-222222222222";

  test.each([
    ["applications", "AND id = ANY($3::uuid[])"],
    ["payment_links", "AND a.id = ANY($3::uuid[])"],
    ["pos_terminals", "AND a.id = ANY($3::uuid[])"],
  ])("%s is narrowed to the caller's applications when a scope is given", async (source, clause) => {
    const { calls, providers } = capture();
    await providers[source]!.search({ query: "x", limit: 10, actor, dependentValues: { merchantId: MERCHANT_ID, applicationIds: [APP_A] } });
    expect(calls[0]!.sql).toContain(clause);
    expect(calls[0]!.values).toEqual(["%x%", MERCHANT_ID, [APP_A], 10]);
  });

  test("without a scope (or with an empty list) the search covers the whole merchant, as before", async () => {
    for (const dependentValues of [{ merchantId: MERCHANT_ID }, { merchantId: MERCHANT_ID, applicationIds: [] }]) {
      const { calls, providers } = capture();
      await providers.payment_links!.search({ query: "x", limit: 10, actor, dependentValues });
      expect(calls[0]!.sql).not.toContain("ANY(");
      expect(calls[0]!.values).toEqual(["%x%", MERCHANT_ID, 10]);
    }
  });

  test("the route sets the merchant and the scope itself, after the client's own parameters", async () => {
    const source = (await Bun.file(new URL("../../api/internal/merchantReportEngine.ts", import.meta.url)).text()).split("\r\n").join("\n");
    expect(source).toContain("dependentValues: { ...(dependentValues ?? {}), merchantId, applicationIds: applicationScopeOf(request) ?? [] },");
  });
});

describe("the merchant Studio preview route", () => {
  // The plan branch added a LIVE preview that executes a draft. It must apply the rule of the execute route:
  // before this check a user restricted to some applications could preview every application's rows.
  test("a LIVE preview refuses merchant-wide specs to a restricted user and passes the scope on; MOCK reads no data", async () => {
    const source = (await Bun.file(new URL("../../api/internal/merchantReportEngine.ts", import.meta.url)).text()).split("\r\n").join("\n");
    const start = source.indexOf('router.post("/report-engine/studio/preview"');
    expect(start).toBeGreaterThan(-1);
    const route = source.slice(start, source.indexOf('router.post("/report-engine/studio/specs"', start));
    const check = route.indexOf("assertSpecFitsApplicationScope(parsedSpec, previewApplicationIds)");
    expect(check).toBeGreaterThan(-1);
    expect(route).toContain("const previewApplicationIds = applicationScopeOf(request);");
    // After the MOCK branch (which returns without reading data), before the execution.
    expect(check).toBeGreaterThan(route.indexOf('mode: "MOCK"'));
    expect(check).toBeLessThan(route.indexOf("engine.executeReport("));
    expect(route).toContain("merchantScope: { merchantId, applicationIds: previewApplicationIds }");
    expect(route).not.toContain("merchantScope: { merchantId }");
  });
});
