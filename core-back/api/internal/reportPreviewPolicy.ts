import { isActorAllowedByPolicy } from "../../lib/reportEngineSdk";
import type { ReportActorContext } from "../../lib/reportEngineSdk/types/hostConfig";

/**
 * The access decision of a staff report PREVIEW (`POST /report-engine/specs/preview`).
 *
 * A preview executes a draft against live data, so it must obey the policy a published report would get: the natural
 * roles or the authorities inferred from the models the draft queries. `report_engine:author` and `report:review`
 * authorise writing and reviewing specs, not reading every catalog model. No stored override exists for a draft, and a
 * missing inference fails closed (nobody but a security admin is allowed).
 */
export interface DraftAuthorityInference {
  effectiveAccessPolicy: { mode: string };
  inferredNaturalRoles: string[];
  inferredRequiredAuthorities: string[];
  queriedModels?: string[];
}

export interface PreviewAccessDecision {
  allowed: boolean;
  queriedModels: string[];
  requiredAuthorities: string[];
}

export const previewAccessDecision = (
  inference: DraftAuthorityInference | null | undefined,
  actor: ReportActorContext,
): PreviewAccessDecision => {
  const requiredAuthorities = inference?.inferredRequiredAuthorities ?? [];
  return {
    allowed: isActorAllowedByPolicy(
      {
        authorityMode: inference?.effectiveAccessPolicy.mode ?? "INFERRED_STRICT",
        inferredRoles: inference?.inferredNaturalRoles ?? [],
        inferredAuthorities: requiredAuthorities,
        overrideAllowedRoles: [],
        overrideAllowedAuthorities: [],
      },
      actor,
    ),
    queriedModels: inference?.queriedModels ?? [],
    requiredAuthorities,
  };
};
