import { describe, expect, test } from "bun:test";
import {
  canApplySecurityOverride,
  inferReportAuthorities,
  isActorAllowedByPolicy,
} from "../../lib/reportEngineSdk/verifier/AuthorityInferenceEngine";
import {
  addAmlDataset,
  addGatewayDataset,
  baseReportSpec,
  createTestHostConfig,
  financeActor,
  securityAdminActor,
} from "./helpers";

describe("RE-T08..RE-T11: authority inference and Security Admin override", () => {
  test("RE-T08: a single-domain ledger report infers finance:read / FINANCE", () => {
    const spec = baseReportSpec();
    spec.datasets[0]!.joins = [
      {
        join_type: "LEFT",
        relation_name: "gl_account",
        target_model: "gl_accounts",
        alias: "ga",
      },
    ];
    const result = inferReportAuthorities(spec, createTestHostConfig());
    expect(result.inferredRequiredAuthorities).toEqual(["finance:read"]);
    expect(result.inferredNaturalRoles).toEqual(["FINANCE"]);
    expect(result.conflictStatus).toBe("NONE");
  });

  test("RE-T09: a confidential AML + gateway + ledger report flags a conflict", () => {
    const spec = addGatewayDataset(addAmlDataset(baseReportSpec()));
    const result = inferReportAuthorities(spec, createTestHostConfig());
    expect(result.inferredNaturalRoles).toEqual([]);
    expect(result.requiresConfidentialAmlAccess).toBe(true);
    expect(result.conflictStatus).toBe("CONFIDENTIAL_DOMAIN_MIX");
    expect(result.conflictDetails.some((d) => d.code === "AML_CONFIDENTIAL_WITH_GATEWAY_OPS")).toBe(true);
  });

  test("RE-T10: only a Security Admin with security:write may override", () => {
    const host = createTestHostConfig();
    expect(canApplySecurityOverride(financeActor, host)).toBe(false);
    expect(canApplySecurityOverride(securityAdminActor, host)).toBe(true);
    expect(
      canApplySecurityOverride({ ...securityAdminActor, authorities: ["report:approve"] }, host),
    ).toBe(false);
  });

  test("RE-T11: an override grants the configured roles and is reflected in the policy", () => {
    const host = createTestHostConfig();
    const spec = addGatewayDataset(addAmlDataset(baseReportSpec()));
    const override = {
      allowedRoles: ["FINANCE", "COMPLIANCE"],
      requiredAnyAuthorities: [],
      justification: "The finance and compliance managers need this cross-domain report.",
      overriddenByUserId: securityAdminActor.userId,
      overriddenAtIso: new Date().toISOString(),
    };
    const result = inferReportAuthorities(spec, host, override);
    expect(result.effectiveAccessPolicy.mode).toBe("SECURITY_ADMIN_OVERRIDE");
    expect(result.effectiveAccessPolicy.allowedRoles).toEqual(["FINANCE", "COMPLIANCE"]);
    const record = {
      authorityMode: result.effectiveAccessPolicy.mode,
      inferredRoles: result.inferredNaturalRoles,
      inferredAuthorities: result.inferredRequiredAuthorities,
      overrideAllowedRoles: result.effectiveAccessPolicy.allowedRoles,
      overrideAllowedAuthorities: result.effectiveAccessPolicy.requiredAnyAuthorities,
    };
    expect(isActorAllowedByPolicy(record, financeActor)).toBe(true);
    expect(isActorAllowedByPolicy(record, { ...financeActor, role: "SUPPORT", authorities: [] })).toBe(false);
  });
});
