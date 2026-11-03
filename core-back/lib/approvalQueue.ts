export const APPROVAL_DOMAIN_SUBJECT_TYPES: Record<string, string[]> = {
  ONBOARDING: ["JOIN_REQUEST", "KYB_DOCUMENT"],
  MERCHANT: ["MERCHANT", "APPLICATION"],
  FINANCE: ["ADJUSTMENT", "CASHOUT_REQUEST", "COMMISSION_PROFILE", "VELOCITY_RULE"],
  COMPLIANCE: ["AML_CASE", "AML_RULE", "REPORTING_RULE", "REGULATORY_REPORT"],
  OPERATIONS: ["OPERATOR_CASE"],
  GATEWAY: ["GATEWAY_VERSION", "GATEWAY", "CREDENTIAL_SET"],
  SECURITY: ["USER", "BACKUP_POLICY"],
  SETTINGS: ["PLATFORM_SETTING"],
};

export const APPROVAL_PENDING_STATES = ["DRAFT", "PENDING_REVIEW"] as const;

const APPROVAL_SUBJECT_TYPE_ALIASES: Record<string, string> = {
  JOINREQUEST: "JOIN_REQUEST",
  KYBDOCUMENT: "KYB_DOCUMENT",
  OPERATORCASE: "OPERATOR_CASE",
  GATEWAYVERSION: "GATEWAY_VERSION",
  AMLCASE: "AML_CASE",
  AMLRULE: "AML_RULE",
  REPORTINGRULE: "REPORTING_RULE",
  REGULATORYREPORT: "REGULATORY_REPORT",
  PLATFORMSETTING: "PLATFORM_SETTING",
  COMMISSIONPROFILE: "COMMISSION_PROFILE",
  VELOCITYRULE: "VELOCITY_RULE",
  CASHOUTREQUEST: "CASHOUT_REQUEST",
  CREDENTIALSET: "CREDENTIAL_SET",
};

export const normalizeApprovalSubjectType = (value: string | null | undefined): string => {
  const normalized = String(value ?? "")
    .trim()
    .replace(/[\s-]+/g, "_")
    .toUpperCase();
  return APPROVAL_SUBJECT_TYPE_ALIASES[normalized.replaceAll("_", "")] ?? normalized;
};

const pascalCaseApprovalSubjectType = (normalized: string): string =>
  normalized
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");

export const approvalSubjectTypeVariants = (value: string | null | undefined): string[] => {
  const normalized = normalizeApprovalSubjectType(value);
  if (!normalized) return [];
  const variants = new Set<string>([normalized, pascalCaseApprovalSubjectType(normalized), normalized.toLowerCase()]);
  return [...variants];
};

export const approvalDomain = (subjectType: string | null | undefined): string => {
  const type = normalizeApprovalSubjectType(subjectType);
  for (const [domain, types] of Object.entries(APPROVAL_DOMAIN_SUBJECT_TYPES)) {
    if (types.includes(type)) return domain;
  }
  return "OTHER";
};

export const approvalChangeKind = (approval: { subjectType: string; payloadDiffJson: unknown }): string => {
  const payload = approval.payloadDiffJson;
  if (Array.isArray(payload)) return "FIELD_EDIT";
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    if (typeof record.kind === "string") return record.kind.toUpperCase();
    if (Array.isArray(record.patch)) return "FIELD_EDIT";
    if (typeof record.type === "string") return record.type.toUpperCase();
    if (typeof record.action === "string") return record.action.toUpperCase();
    if (typeof record.decision === "string") return record.decision.toUpperCase();
    if (typeof record.field === "string" && (record.from !== undefined || record.to !== undefined)) return "FIELD_EDIT";
  }
  return normalizeApprovalSubjectType(approval.subjectType) === "MERCHANT" ? "EDIT" : "CHANGE";
};

export const approvalAgeHours = (createdAt: Date, now = Date.now()): number =>
  Math.max(0, Math.floor((now - createdAt.getTime()) / 3_600_000));

export const approvalExpiresInHours = (expiresAt: Date | null, now = Date.now()): number | null =>
  expiresAt ? Math.ceil((expiresAt.getTime() - now) / 3_600_000) : null;

export const approvalIsExpired = (expiresAt: Date | null, now = Date.now()): boolean =>
  Boolean(expiresAt && expiresAt.getTime() < now);

export const approvalListRow = (approval: {
  id: string;
  subjectType: string;
  subjectId: string;
  state: string;
  mode: string;
  baseVersion: number | null;
  payloadDiffJson: unknown;
  makerUserId: string;
  makerReason: string | null;
  rejectionReason: string | null;
  riskAcceptanceNote: string | null;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date | null;
  ratifyDueAt: Date | null;
  maker?: { email: string } | null;
  checker?: { email: string } | null;
}) => ({
  id: approval.id,
  subjectType: normalizeApprovalSubjectType(approval.subjectType),
  subjectId: approval.subjectId,
  domain: approvalDomain(approval.subjectType),
  kind: approvalChangeKind(approval),
  state: approval.state,
  mode: approval.mode,
  baseVersion: approval.baseVersion,
  makerUserId: approval.makerUserId,
  makerName: approval.maker?.email ?? "",
  checkerName: approval.checker?.email ?? "",
  makerReason: approval.makerReason,
  rejectionReason: approval.rejectionReason,
  riskAcceptanceNote: approval.riskAcceptanceNote,
  payloadDiff: approval.payloadDiffJson,
  createdAt: approval.createdAt,
  updatedAt: approval.updatedAt,
  expiresAt: approval.expiresAt,
  ratifyDueAt: approval.ratifyDueAt,
  expired: approvalIsExpired(approval.expiresAt),
  ageHours: approvalAgeHours(approval.createdAt),
  expiresInHours: approvalExpiresInHours(approval.expiresAt),
});
