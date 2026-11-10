import { describe, expect, test } from "bun:test";
import { buildSchemaCatalog, classifyColumnSensitivity } from "../../engine/reportStudio/schemaCatalog";
import { inferReportAuthorities } from "../../lib/reportEngineSdk/verifier/AuthorityInferenceEngine";
import { compileDatasetQueryToSql } from "../../lib/reportEngineSdk/compiler/QueryAstToSqlCompiler";
import type { ReportDescriptorSpec } from "../../lib/reportEngineSdk/types/reportSpec";
import { createTestHostConfig, baseReportSpec } from "./helpers";

const catalog = buildSchemaCatalog();

describe("remediation A02/A13: catalog sensitivity classification", () => {
  test("ciphertext, token and hash columns are FORBIDDEN_SECRET", () => {
    expect(catalog.models.credential_sets?.columns.entries_ciphertext?.sensitivity).toBe("FORBIDDEN_SECRET");
    expect(catalog.models.access_tokens?.columns.token_hash?.sensitivity).toBe("FORBIDDEN_SECRET");
    expect(catalog.models.users?.columns.password_hash?.sensitivity).toBe("FORBIDDEN_SECRET");
  });

  test("KYB file names, people names and JSON payloads are PII_MASKED", () => {
    expect(catalog.models.kyb_documents?.columns.original_file_name?.sensitivity).toBe("PII_MASKED");
    expect(catalog.models.users?.columns.academy_progress_json?.sensitivity).toBe("PII_MASKED");
    expect(catalog.models.users?.columns.email?.sensitivity).toBe("PII_MASKED");
    expect(classifyColumnSensitivity("beneficial_owners", "full_name_ar", "string")).toBe("PII_MASKED");
  });

  test("integrity hashes stay INTERNAL instead of being over-classified", () => {
    expect(catalog.models.gateway_versions?.columns.content_hash?.sensitivity).toBe("INTERNAL");
    expect(catalog.models.reconciliation_runs?.columns.file_hash?.sensitivity).toBe("INTERNAL");
  });

  test("every COMPLIANCE_AML model is confidential", () => {
    const amlModels = Object.values(catalog.models).filter((model) => model.domain === "COMPLIANCE_AML");
    expect(amlModels.length).toBeGreaterThan(0);
    expect(amlModels.every((model) => model.confidentialAmlOnly)).toBe(true);
    expect(catalog.models.regulatory_reports?.confidentialAmlOnly).toBe(true);
    expect(catalog.models.reporting_rules?.confidentialAmlOnly).toBe(true);
  });
});

describe("remediation A03: relation parsing", () => {
  const users = catalog.models.users!;

  test("named back-relations use the correct checker/maker column", () => {
    expect(users.relations.makerApprovalRequests?.targetKey).toBe("maker_user_id");
    expect(users.relations.checkerApprovalRequests?.targetKey).toBe("checker_user_id");
    expect(users.relations.submittedJoinRequests?.targetKey).toBe("submitted_by_user_id");
  });

  test("composite keys produce ANDed key pairs", () => {
    const checkpoint = catalog.models.gl_account_shards?.relations.checkpoint;
    expect(checkpoint?.cardinality).toBe("ONE_TO_ONE");
    expect(checkpoint?.keyPairs).toEqual([
      { sourceKey: "gl_account_id", targetKey: "gl_account_id" },
      { sourceKey: "shard_id", targetKey: "shard_id" },
    ]);
  });

  test("the compiler emits every composite key pair", () => {
    const host = createTestHostConfig({ models: catalog.models, enums: catalog.enums });
    const compiled = compileDatasetQueryToSql(
      {
        dataset_id: "shards",
        description: "shards",
        from_model: "gl_account_shards",
        from_alias: "s",
        joins: [
          {
            join_type: "LEFT",
            relation_name: "checkpoint",
            target_model: "gl_shard_checkpoints",
            alias: "c",
          },
        ],
        select: [{ alias: "id", column: "gl_account_id", expression: "COLUMN", format_hint: "RAW" }],
        group_by: [],
        having: [],
        window_fields: [],
        order_by: [],
        limit: 10,
      },
      host,
      {},
    );
    expect(compiled.sql).toContain('"s"."gl_account_id" = "c"."gl_account_id"');
    expect(compiled.sql).toContain('"s"."shard_id" = "c"."shard_id"');
  });
});

describe("remediation A01: referenced columns drive PII inference", () => {
  const piiSpec = (): ReportDescriptorSpec => {
    const spec = baseReportSpec();
    spec.report.audience_scope = "BACKOFFICE_INTERNAL";
    spec.report.merchant_scope_input_key = undefined as unknown as string;
    spec.datasets = [
      {
        dataset_id: "users",
        description: "Users",
        from_model: "users",
        from_alias: "u",
        joins: [],
        select: [{ alias: "id", column: "id", expression: "COLUMN", format_hint: "RAW" }],
        where: undefined,
        group_by: [],
        having: [],
        window_fields: [
          {
            alias: "rn",
            window_fn: "ROW_NUMBER",
            target_field: "id",
            partition_by: [],
            order_by: [{ field: "email", direction: "ASC" }],
          },
        ],
        order_by: [],
        limit: 10,
      },
    ];
    return spec;
  };

  test("a PII column used only by a window ORDER BY is still detected", () => {
    const result = inferReportAuthorities(piiSpec(), createTestHostConfig());
    expect(result.containsMaskedPiiColumns).toBe(true);
  });

  test("a PII column used only in a WHERE predicate is still detected", () => {
    const spec = piiSpec();
    spec.datasets[0]!.window_fields = [];
    spec.datasets[0]!.where = {
      kind: "PREDICATE",
      column: "email",
      op: "ilike_prefix",
      binding: { source: "LITERAL", value: "a" },
    };
    const result = inferReportAuthorities(spec, createTestHostConfig());
    expect(result.containsMaskedPiiColumns).toBe(true);
  });
});
