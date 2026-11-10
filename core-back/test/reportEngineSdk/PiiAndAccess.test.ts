import { describe, expect, test } from "bun:test";
import { executeReport, ReportAccessDeniedError } from "../../lib/reportEngineSdk";
import { inferReportAuthorities } from "../../lib/reportEngineSdk/verifier/AuthorityInferenceEngine";
import { createTestHostConfig, FakeReadOnlyPort, financeActor, securityAdminActor } from "./helpers";
import type { ReportDescriptorSpec } from "../../lib/reportEngineSdk/types/reportSpec";

function usersSpec(): ReportDescriptorSpec {
  return {
    spec_kind: "REPORT_DESCRIPTOR",
    spec_version: "1.0",
    report: {
      code: "users-report",
      version: 1,
      category: "SECURITY_AUDIT",
      audience_scope: "BACKOFFICE_INTERNAL",
      classification: "INTERNAL",
    },
    page_layout: {
      paper_size: "A4",
      orientation: "PORTRAIT",
      margins_mm: { top: 26, right: 14, bottom: 24, left: 14 },
      header_mode: "NONE",
      footer_mode: "NONE",
      allow_runtime_chrome_selection: true,
      global_scoped_css: "",
    },
    required_assets: [],
    i18n: {
      default_locale: "en",
      prompt_user_when_multi_locale: false,
      locales: { en: {}, ar: {} },
    },
    inputs: [],
    datasets: [
      {
        dataset_id: "users",
        description: "Users",
        from_model: "users",
        from_alias: "u",
        joins: [],
        select: [{ alias: "email", column: "email", expression: "COLUMN", format_hint: "RAW" }],
        group_by: [],
        having: [],
        window_fields: [],
        order_by: [],
        limit: 10,
      },
    ],
    transforms: [],
    sections: [],
  };
}

function amlSpec(): ReportDescriptorSpec {
  return {
    ...usersSpec(),
    report: { ...usersSpec().report, code: "aml-report", category: "COMPLIANCE_AML" },
    datasets: [
      {
        dataset_id: "cases",
        description: "Cases",
        from_model: "aml_cases",
        from_alias: "ac",
        joins: [],
        select: [{ alias: "case_id", column: "id", expression: "COLUMN", format_hint: "RAW" }],
        group_by: [],
        having: [],
        window_fields: [],
        order_by: [],
        limit: 10,
      },
    ],
  };
}

describe("report PII masking and confidential AML access", () => {
  test("PII_MASKED columns are masked unless the actor has security:write", async () => {
    const fake = new FakeReadOnlyPort();
    fake.rows = [{ email: "user@example.com" }];
    const host = createTestHostConfig({ dbReadOnlyPort: fake });
    const finance = await executeReport(host, {
      spec: usersSpec(),
      inputs: {},
      actor: financeActor,
      chromeRegistry: [],
    });
    expect(finance.datasets.users?.[0]?.email).toBe("u***@example.com");
    const security = await executeReport(host, {
      spec: usersSpec(),
      inputs: {},
      actor: securityAdminActor,
      chromeRegistry: [],
    });
    expect(security.datasets.users?.[0]?.email).toBe("user@example.com");
  });

  test("confidential AML reports are denied without AML access or an approved bypass", async () => {
    const fake = new FakeReadOnlyPort();
    fake.rows = [{ case_id: "case-1" }];
    const host = createTestHostConfig({ dbReadOnlyPort: fake });
    const inference = inferReportAuthorities(amlSpec(), host);
    expect(inference.requiresConfidentialAmlAccess).toBe(true);
    await expect(
      executeReport(host, {
        spec: amlSpec(),
        inputs: {},
        actor: financeActor,
        chromeRegistry: [],
      }),
    ).rejects.toThrow(ReportAccessDeniedError);
    const bypassed = await executeReport(host, {
      spec: amlSpec(),
      inputs: {},
      actor: financeActor,
      chromeRegistry: [],
      allowConfidentialAmlBypass: true,
    });
    expect(bypassed.datasets.cases?.[0]?.case_id).toBe("case-1");
  });
});
