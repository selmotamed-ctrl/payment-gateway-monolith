import type { ReportEngineHostConfig } from "../../lib/reportEngineSdk/types/hostConfig";
import { PostgresReadOnlyReportExecutor } from "../../lib/reportEngineSdk/runtime/PostgresReadOnlyExecutor";
import { buildPaymentGatewayAutocompleteProviders } from "./autocompleteProviders";
import { buildSchemaCatalog } from "./schemaCatalog";
import { LocalReportAssetStorage } from "./assetStorage";
import { env } from "../../lib/env";

let cached: ReportEngineHostConfig | null = null;

export function createPaymentGatewayReportHostConfig(deps: {
  readOnlyConnectionString?: string;
  assetStoragePort?: ReportEngineHostConfig["assetStoragePort"];
} = {}): ReportEngineHostConfig {
  const replicaUrl = env.DATABASE_REPLICA_URLS.split(",").map((v) => v.trim()).filter(Boolean)[0];
  const dbReadOnlyPort = new PostgresReadOnlyReportExecutor({
    connectionString:
      deps.readOnlyConnectionString ??
      process.env.REPORT_READONLY_DATABASE_URL ??
      replicaUrl ??
      env.DATABASE_URL,
    maxPoolConnections: 8,
    defaultStatementTimeoutMs: 15_000,
    workMemMb: 32,
  });
  const catalog = buildSchemaCatalog();
  const assetStoragePort = deps.assetStoragePort ?? new LocalReportAssetStorage();

  return {
    engineVersion: "1.0",
    institutionName: "Libyan National Payment Gateway",
    defaultCurrency: "LYD",
    defaultTimezone: "Africa/Tripoli",
    supportedLocales: ["en", "ar", "fr", "it", "tr"],
    mandatoryDefaultLocales: ["en", "ar"],
    models: catalog.models,
    enums: catalog.enums,
    rolesCatalog: [
      "GATEWAY_ADMIN",
      "SECURITY_ADMIN",
      "FINANCE",
      "OPERATOR",
      "COMPLIANCE",
      "MLRO",
      "SUPPORT",
    ],
    authoritiesCatalog: [
      "merchant:read",
      "merchant:write",
      "kyb:read",
      "compliance:read",
      "compliance:write",
      "aml:read",
      "aml:write",
      "report:review",
      "report:approve",
      "finance:read",
      "finance:write",
      "cashout:read",
      "commission:read",
      "velocity:read",
      "reconciliation:read",
      "gateway:read",
      "operator:read",
      "security:read",
      "security:write",
      "report_engine:author",
      "report_engine:run",
    ],
    securityOverrideAuthority: "security:write",
    securityOverrideRoles: ["SECURITY_ADMIN"],
    piiUnmaskAuthorities: ["security:write"],
    defaultCurrencyMinorUnitScale: 1000,
    authorityConflictMatrix: [
      {
        domainA: "COMPLIANCE_AML",
        domainB: "GATEWAYS",
        conflictCode: "AML_CONFIDENTIAL_WITH_GATEWAY_OPS",
        description:
          "Combining confidential AML case tables with gateway engineering tables leaves zero default roles able to run the report.",
        resolutionHint:
          "Split into separate Compliance and Gateway reports, or have a SECURITY_ADMIN assign an explicit Authority Override.",
      },
      {
        domainA: "COMPLIANCE_AML",
        domainB: "OPERATIONS",
        conflictCode: "AML_CONFIDENTIAL_WITH_SUPPORT_OPS",
        description:
          "Support/Operations roles are barred from confidential AML records by hasConfidentialAmlAccess.",
        resolutionHint:
          "Restrict this report to MLRO/COMPLIANCE roles or remove aml_cases joins.",
      },
    ],
    autocompleteProviders: buildPaymentGatewayAutocompleteProviders(dbReadOnlyPort),
    dbReadOnlyPort,
    assetStoragePort,
    globalLimits: {
      maxDatasetsPerReport: 64,
      maxJoinsPerDataset: 6,
      maxRowsPerDataset: 10_000,
      maxQueryTimeoutMs: 15_000,
      maxExplainCost: 150_000,
      maxAssetZipBytes: 15 * 1024 * 1024,
      maxSingleAssetBytes: 5 * 1024 * 1024,
    },
  };
}

export function getPaymentGatewayReportHostConfig(): ReportEngineHostConfig {
  if (!cached) {
    cached = createPaymentGatewayReportHostConfig();
  }
  return cached;
}
