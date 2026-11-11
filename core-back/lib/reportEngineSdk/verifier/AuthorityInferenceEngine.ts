import type { CatalogModelDef, ReportEngineHostConfig } from "../types/hostConfig";
import type {
  DatasetQuerySpec,
  ReportDescriptorSpec,
  WhereFilterNode,
} from "../types/reportSpec";

interface ReferencedColumn {
  model: CatalogModelDef | undefined;
  column: string;
}

/**
 * Every column a dataset references, not only the select list. Window/order
 * base columns are hidden from the output by the compiler, but they are still
 * read by PostgreSQL, so authority/PII inference must see them (A01).
 */
export function collectReferencedColumns(
  ds: DatasetQuerySpec,
  host: ReportEngineHostConfig,
): ReferencedColumn[] {
  const out: ReferencedColumn[] = [];
  const modelForAlias = (alias: string | undefined): CatalogModelDef | undefined => {
    const resolved = alias ?? ds.from_alias;
    if (resolved === ds.from_alias) return host.models[ds.from_model];
    const join = ds.joins.find((entry) => entry.alias === resolved);
    return join ? host.models[join.target_model] : undefined;
  };
  const selectByAlias = new Map(ds.select.map((sel) => [sel.alias, sel]));
  const push = (model: CatalogModelDef | undefined, column: string): void => {
    if (model?.columns[column]) out.push({ model, column });
  };
  const visitWhere = (node: WhereFilterNode | undefined): void => {
    if (!node) return;
    if (node.kind === "GROUP") {
      node.conditions.forEach(visitWhere);
      return;
    }
    push(modelForAlias(node.table_alias), node.column);
  };

  for (const sel of ds.select) push(modelForAlias(sel.table_alias), sel.column);
  visitWhere(ds.where);
  for (const join of ds.joins) visitWhere(join.additional_on);
  for (const group of ds.group_by) {
    const selected = selectByAlias.get(group);
    if (selected) push(modelForAlias(selected.table_alias), selected.column);
    else push(modelForAlias(undefined), group);
  }
  for (const order of ds.order_by) {
    const selected = selectByAlias.get(order.field);
    if (selected) push(modelForAlias(selected.table_alias), selected.column);
    else push(modelForAlias(undefined), order.field);
  }
  for (const window of ds.window_fields) {
    const selectedTarget = selectByAlias.get(window.target_field);
    if (selectedTarget) push(modelForAlias(selectedTarget.table_alias), selectedTarget.column);
    else push(modelForAlias(undefined), window.target_field);
    for (const field of [...window.partition_by, ...window.order_by.map((order) => order.field)]) {
      const selected = selectByAlias.get(field);
      if (selected) push(modelForAlias(selected.table_alias), selected.column);
      else push(modelForAlias(undefined), field);
    }
  }
  return out;
}

export interface AuthorityInferenceResult {
  queriedModels: string[];
  queriedDomains: string[];
  inferredRequiredAuthorities: string[];
  inferredNaturalRoles: string[];
  requiresConfidentialAmlAccess: boolean;
  containsMaskedPiiColumns: boolean;
  conflictStatus:
    | "NONE"
    | "CROSS_DOMAIN_INTERSECTION_NARROW"
    | "OVER_CONFLICTING_ZERO_NATURAL_ROLES"
    | "CONFIDENTIAL_DOMAIN_MIX";
  conflictDetails: Array<{
    code: string;
    message: string;
    resolutionHint: string;
  }>;
  effectiveAccessPolicy: {
    mode: "INFERRED_STRICT" | "SECURITY_ADMIN_OVERRIDE";
    allowedRoles: string[];
    requiredAnyAuthorities: string[];
    requiredAllAuthorities: string[];
  };
}

export function inferReportAuthorities(
  spec: ReportDescriptorSpec,
  host: ReportEngineHostConfig,
  securityOverride?: {
    allowedRoles: string[];
    requiredAnyAuthorities: string[];
    justification: string;
    overriddenByUserId: string;
    overriddenAtIso: string;
  } | null,
): AuthorityInferenceResult {
  const modelNames = new Set<string>();
  for (const ds of spec.datasets) {
    modelNames.add(ds.from_model);
    for (const j of ds.joins) {
      modelNames.add(j.target_model);
    }
  }

  const queriedModels = [...modelNames];
  const domains = new Set<string>();
  const requiredAuthSet = new Set<string>();
  let naturalRolesIntersection: Set<string> | null = null;
  let requiresConfidentialAmlAccess = false;
  let containsMaskedPiiColumns = false;

  for (const mName of queriedModels) {
    const model = host.models[mName];
    if (!model) continue;
    domains.add(model.domain);
    for (const auth of model.requiredAuthorities) {
      requiredAuthSet.add(auth);
    }
    if (model.confidentialAmlOnly) {
      requiresConfidentialAmlAccess = true;
    }
    const modelRoles = new Set(model.naturalRoles);
    if (naturalRolesIntersection === null) {
      naturalRolesIntersection = modelRoles;
    } else {
      const previousRoles = naturalRolesIntersection as Set<string>;
      naturalRolesIntersection = new Set(
        [...previousRoles].filter((role) => modelRoles.has(role)),
      );
    }
  }

  for (const ds of spec.datasets) {
    for (const ref of collectReferencedColumns(ds, host)) {
      const col = ref.model?.columns[ref.column];
      if (col?.sensitivity === "PII_MASKED") {
        containsMaskedPiiColumns = true;
      }
      if (col?.sensitivity === "CONFIDENTIAL_AML") {
        requiresConfidentialAmlAccess = true;
      }
    }
  }

  const queriedDomains = [...domains];
  const inferredNaturalRoles = [...(naturalRolesIntersection ?? [])];
  const inferredRequiredAuthorities = [...requiredAuthSet];
  const conflictDetails: AuthorityInferenceResult["conflictDetails"] = [];

  for (const rule of host.authorityConflictMatrix) {
    if (domains.has(rule.domainA) && domains.has(rule.domainB)) {
      conflictDetails.push({
        code: rule.conflictCode,
        message: rule.description,
        resolutionHint: rule.resolutionHint,
      });
    }
  }

  for (const role of spec.suggested_access?.roles ?? []) {
    if (!inferredNaturalRoles.includes(role)) {
      conflictDetails.push({
        code: "SUGGESTED_ACCESS_CONFLICT",
        message: `suggested_access grants role "${role}", but the queried models do not naturally allow that role.`,
        resolutionHint:
          "Remove the suggestion or use a Security Admin authority override with a written justification.",
      });
    }
  }
  for (const authority of spec.suggested_access?.authorities ?? []) {
    if (!inferredRequiredAuthorities.includes(authority)) {
      conflictDetails.push({
        code: "SUGGESTED_AUTHORITY_NOT_REQUIRED",
        message: `suggested_access grants authority "${authority}", but the queried models do not require it.`,
        resolutionHint: "Keep only authorities the queried models actually require.",
      });
    }
  }

  let conflictStatus: AuthorityInferenceResult["conflictStatus"] = "NONE";
  if (
    requiresConfidentialAmlAccess &&
    queriedDomains.some((d) => d !== "COMPLIANCE_AML" && d !== "MERCHANTS")
  ) {
    conflictStatus = "CONFIDENTIAL_DOMAIN_MIX";
  } else if (inferredNaturalRoles.length === 0 && queriedModels.length > 0) {
    conflictStatus = "OVER_CONFLICTING_ZERO_NATURAL_ROLES";
    conflictDetails.push({
      code: "ZERO_NATURAL_ROLE_INTERSECTION",
      message: `Queries span [${queriedDomains.join(", ")}], leaving no single default role holding all required authorities (${inferredRequiredAuthorities.join(", ")}). This is a non-blocking warning; the report needs an explicit access policy.`,
      resolutionHint:
        "A Security Admin (SECURITY_ADMIN / security:write) can configure an Authority Override with the roles or authorities allowed to view and run this report.",
    });
  } else if (queriedDomains.length > 2) {
    conflictStatus = "CROSS_DOMAIN_INTERSECTION_NARROW";
  }

  if (securityOverride) {
    return {
      queriedModels,
      queriedDomains,
      inferredRequiredAuthorities,
      inferredNaturalRoles,
      requiresConfidentialAmlAccess,
      containsMaskedPiiColumns,
      conflictStatus,
      conflictDetails,
      effectiveAccessPolicy: {
        mode: "SECURITY_ADMIN_OVERRIDE",
        allowedRoles: securityOverride.allowedRoles,
        requiredAnyAuthorities: securityOverride.requiredAnyAuthorities,
        requiredAllAuthorities: [],
      },
    };
  }

  return {
    queriedModels,
    queriedDomains,
    inferredRequiredAuthorities,
    inferredNaturalRoles,
    requiresConfidentialAmlAccess,
    containsMaskedPiiColumns,
    conflictStatus,
    conflictDetails,
    effectiveAccessPolicy: {
      mode: "INFERRED_STRICT",
      allowedRoles: inferredNaturalRoles,
      requiredAnyAuthorities: [],
      requiredAllAuthorities: inferredRequiredAuthorities,
    },
  };
}

import type { ReportActorContext } from "../types/hostConfig";

/** A Security Admin (or an actor with the configured override authority) may attach an override. */
export function canApplySecurityOverride(
  actor: ReportActorContext,
  host: ReportEngineHostConfig,
): boolean {
  return (
    host.securityOverrideRoles.includes(actor.role) &&
    actor.authorities.includes(host.securityOverrideAuthority)
  );
}

/** Evaluates the stored effective access policy against an actor. */
export function isActorAllowedByPolicy(
  record: {
    authorityMode: string;
    inferredRoles: string[];
    inferredAuthorities: string[];
    overrideAllowedRoles: string[];
    overrideAllowedAuthorities: string[];
  },
  actor: ReportActorContext,
): boolean {
  if (actor.role === "SECURITY_ADMIN" || actor.authorities.includes("security:write")) {
    return true;
  }
  if (record.authorityMode === "SECURITY_ADMIN_OVERRIDE") {
    return (
      record.overrideAllowedRoles.includes(actor.role) ||
      record.overrideAllowedAuthorities.some((authority) => actor.authorities.includes(authority))
    );
  }
  return (
    record.inferredRoles.includes(actor.role) ||
    (record.inferredAuthorities.length > 0 &&
      record.inferredAuthorities.every((authority) => actor.authorities.includes(authority)))
  );
}
