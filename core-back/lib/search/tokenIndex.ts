/**
 * Unified search-token index maintenance.
 *
 * The index is intentionally denormalized: every searchable row owns a small
 * set of normalized tokens with a stable base weight. Global search can then
 * answer a token query with one indexed range scan instead of running
 * `LIKE '%q%'` across twenty tables.
 */

export const SEARCH_TOKEN_WEIGHTS = {
  exact: 1000,
  primary: 800,
  secondary: 500,
} as const;

const MAX_TOKEN_LENGTH = 128;
const MAX_TOKENS_PER_ENTITY = 96;
const SHA256_HEX = /^[a-f0-9]{64}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface ExtractedEntitySearchToken {
  token: string;
  isSensitive: boolean;
  baseWeight: number;
}

export interface EntitySearchTokenRow {
  token: string;
  entityType: string;
  entityId: string;
  merchantId: string | null;
  isSensitive: boolean;
  baseWeight: number;
  title: string;
  subtitle: string | null;
  reference: string | null;
  status: string | null;
  operatorCaseId: string | null;
  entityCreatedAt: Date;
}

type EntityRecord = Record<string, unknown>;
type FieldSpec = string | { path: string; sensitive?: boolean; phone?: boolean; weight?: number };

interface EntityTokenSpec {
  exact?: FieldSpec[];
  names?: FieldSpec[];
  secondary?: FieldSpec[];
  title: (entity: EntityRecord) => string;
  subtitle?: (entity: EntityRecord) => string | null;
  reference?: (entity: EntityRecord) => string | null;
  status?: (entity: EntityRecord) => string | null;
  merchantId?: (entity: EntityRecord) => string | null;
  operatorCaseId?: (entity: EntityRecord) => string | null;
  createdAt?: (entity: EntityRecord) => Date | string | null | undefined;
}

const asRecord = (value: unknown): EntityRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as EntityRecord)
    : {};

const getPath = (entity: EntityRecord, path: string): unknown => {
  let current: unknown = entity;
  for (const part of path.split(".")) {
    const record = asRecord(current);
    current = record[part];
    if (current === undefined || current === null) {
      return undefined;
    }
  }
  return current;
};

const asText = (value: unknown): string | null => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  return null;
};

const firstText = (...values: unknown[]): string | null => {
  for (const value of values) {
    const text = asText(value);
    if (text) {
      return text;
    }
  }
  return null;
};

const compactText = (values: unknown[]): string | null => {
  const parts = values
    .map((value) => asText(value))
    .filter((value): value is string => Boolean(value));
  return parts.length > 0 ? parts.join(" · ") : null;
};

const clampText = (value: string | null, maxLength: number): string | null => {
  if (!value) {
    return null;
  }
  return value.slice(0, maxLength);
};

const toDate = (value: unknown): Date | null => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
};

export const normalizeSearchToken = (value: string): string =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TOKEN_LENGTH);

const tokenizeWords = (value: string): string[] => {
  const normalized = normalizeSearchToken(value);
  if (!normalized) {
    return [];
  }
  return normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
};

const phoneTokenVariants = (value: string): string[] => {
  const compact = value.replace(/[\s().-]/g, "");
  const digits = compact.replace(/[^\d]/g, "");
  if (digits.length < 6) {
    return [];
  }

  const variants = new Set<string>();
  variants.add(compact);
  variants.add(digits);
  if (compact.startsWith("+")) {
    variants.add(`+${digits}`);
  }

  let normalized = digits;
  if (normalized.startsWith("00")) {
    normalized = normalized.slice(2);
  }

  if (normalized.startsWith("218")) {
    const national = normalized.slice(3);
    variants.add(normalized);
    variants.add(`+${normalized}`);
    if (national.startsWith("0")) {
      const withoutZero = national.slice(1);
      if (withoutZero) {
        variants.add(`0${withoutZero}`);
        variants.add(withoutZero);
      }
    } else if (national) {
      variants.add(`0${national}`);
    }
  } else if (normalized.startsWith("0")) {
    const withoutZero = normalized.slice(1);
    if (withoutZero) {
      variants.add(`218${withoutZero}`);
      variants.add(`+218${withoutZero}`);
    }
  } else if (normalized.startsWith("9") && normalized.length === 9) {
    variants.add(`0${normalized}`);
    variants.add(`218${normalized}`);
    variants.add(`+218${normalized}`);
  }

  return Array.from(variants)
    .map((variant) => normalizeSearchToken(variant))
    .filter((variant) => variant.length > 0);
};

interface TokenAccumulator {
  add: (value: unknown, weight: number, sensitive?: boolean) => void;
  addExact: (value: unknown, weight?: number, sensitive?: boolean) => void;
  addWords: (value: unknown, weight: number, sensitive?: boolean) => void;
  addPhone: (value: unknown, weight?: number, sensitive?: boolean) => void;
  values: () => ExtractedEntitySearchToken[];
}

const createAccumulator = (): TokenAccumulator => {
  const tokens = new Map<string, { baseWeight: number; isSensitive: boolean }>();

  const add = (value: unknown, weight: number, sensitive = false): void => {
    const text = asText(value);
    if (!text) {
      return;
    }
    const token = normalizeSearchToken(text);
    if (!token) {
      return;
    }
    const existing = tokens.get(token);
    if (existing) {
      existing.baseWeight = Math.max(existing.baseWeight, weight);
      existing.isSensitive = existing.isSensitive || sensitive;
      return;
    }
    if (tokens.size < MAX_TOKENS_PER_ENTITY) {
      tokens.set(token, { baseWeight: weight, isSensitive: sensitive });
    }
  };

  const addExact = (value: unknown, weight: number = SEARCH_TOKEN_WEIGHTS.exact, sensitive = false): void => {
    const text = asText(value);
    if (!text) {
      return;
    }
    add(text, weight, sensitive);
    if (EMAIL.test(text.trim())) {
      const domain = text.split("@").pop();
      if (domain) {
        add(domain, weight, sensitive);
      }
    }
    if (SHA256_HEX.test(text.trim())) {
      add(text.trim().slice(0, 16), weight, sensitive);
    }
  };

  const addWords = (value: unknown, weight: number, sensitive = false): void => {
    const text = asText(value);
    if (!text) {
      return;
    }
    for (const word of tokenizeWords(text)) {
      if (word.length >= 2) {
        add(word, weight, sensitive);
      }
    }
  };

  const addPhone = (value: unknown, weight: number = SEARCH_TOKEN_WEIGHTS.exact, sensitive = false): void => {
    const text = asText(value);
    if (!text) {
      return;
    }
    addExact(text, weight, sensitive);
    for (const variant of phoneTokenVariants(text)) {
      add(variant, weight, sensitive);
    }
  };

  return {
    add,
    addExact,
    addWords,
    addPhone,
    values: () =>
      Array.from(tokens.entries())
        .map(([token, meta]) => ({
          token,
          isSensitive: meta.isSensitive,
          baseWeight: meta.baseWeight,
        }))
        .sort((left, right) => {
          if (right.baseWeight !== left.baseWeight) {
            return right.baseWeight - left.baseWeight;
          }
          return left.token.localeCompare(right.token);
        }),
  };
};

const fieldPath = (field: FieldSpec): string => (typeof field === "string" ? field : field.path);
const fieldWeight = (field: FieldSpec, fallback: number): number =>
  typeof field === "string" ? fallback : field.weight ?? fallback;
const fieldSensitive = (field: FieldSpec): boolean =>
  typeof field !== "string" && Boolean(field.sensitive);
const fieldIsPhone = (field: FieldSpec): boolean => {
  const path = fieldPath(field).toLowerCase();
  return (typeof field !== "string" && Boolean(field.phone)) || path.includes("phone");
};

const addField = (
  accumulator: TokenAccumulator,
  entity: EntityRecord,
  field: FieldSpec,
  fallbackWeight: number,
): void => {
  const value = getPath(entity, fieldPath(field));
  if (value === undefined || value === null) {
    return;
  }
  const weight = fieldWeight(field, fallbackWeight);
  const sensitive = fieldSensitive(field);
  if (fieldIsPhone(field)) {
    accumulator.addPhone(value, weight, sensitive);
  } else {
    accumulator.addExact(value, weight, sensitive);
  }
  if (sensitive) {
    accumulator.addWords(value, SEARCH_TOKEN_WEIGHTS.primary, true);
  }
};

const genericSpec: EntityTokenSpec = {
  exact: [
    "id",
    "reference",
    "ourReference",
    "providerReference",
    "networkReference",
    "gatewayReference",
    "externalDisputeRef",
    "submissionRef",
    "providerRequestRef",
    "code",
    "email",
    "contactEmail",
    "phone",
    "contactPhone",
    "sha256",
  ],
  names: ["legalName", "tradeName", "displayName", "name", "nameEn", "nameAr", "originalFileName", "fileName"],
  secondary: ["status", "kind", "type", "role", "action", "entityType"],
  title: (entity) =>
    firstText(
      entity.displayName,
      entity.tradeName,
      entity.legalName,
      entity.nameEn,
      entity.name,
      entity.reference,
      entity.email,
      entity.id,
    ) ?? "",
  subtitle: (entity) =>
    compactText([entity.legalName, entity.contactEmail, entity.status, entity.riskTier]),
  reference: (entity) => firstText(entity.reference, entity.code, entity.entityId, entity.id),
  status: (entity) => firstText(entity.status, entity.state),
  merchantId: (entity) => firstText(entity.merchantId),
  operatorCaseId: (entity) => firstText(entity.operatorCaseId),
  createdAt: (entity) => toDate(entity.createdAt ?? entity.entityCreatedAt ?? entity.updatedAt),
};

const entitySpecs: Record<string, EntityTokenSpec> = {
  merchant: {
    exact: [
      "id",
      "contactEmail",
      "contactPhone",
      "supportEmail",
      { path: "supportPhone", phone: true },
      { path: "taxId", sensitive: true },
      { path: "registrationNo", sensitive: true },
      "payoutAccountHash",
    ],
    names: ["displayName", "tradeName", "legalName"],
    secondary: ["businessCategory", "country", "riskTier", "status", "kybStatus"],
    title: (entity) =>
      firstText(entity.displayName, entity.tradeName, entity.legalName, entity.id) ?? "",
    subtitle: (entity) =>
      compactText([entity.legalName, entity.contactEmail, entity.riskTier]),
    reference: (entity) => firstText(entity.id),
    status: (entity) => firstText(entity.status),
    merchantId: (entity) => firstText(entity.id),
    createdAt: (entity) => toDate(entity.createdAt),
  },
  payment_attempt: {
    exact: [
      "id",
      "reference",
      "providerReference",
      "networkReference",
      "gatewayReference",
      "idempotencyKey",
    ],
    names: ["merchant.tradeName", "merchant.legalName"],
    secondary: ["status", "currency", "rail.code", "providerReference"],
    title: (entity) => {
      const reference = firstText(entity.reference, entity.id) ?? "";
      const amount = asText(entity.totalChargedAmount ?? entity.requestedAmount);
      const currency = asText(entity.currency);
      return [reference, amount, currency].filter(Boolean).join(" · ");
    },
    subtitle: (entity) =>
      compactText([
        (getPath(entity, "merchant.tradeName") as string | null | undefined) ??
          (getPath(entity, "merchant.legalName") as string | null | undefined) ??
          entity.merchantId,
        (getPath(entity, "rail.code") as string | null | undefined)?.toUpperCase(),
        entity.providerReference ? `Prov: ${String(entity.providerReference)}` : null,
      ]),
    reference: (entity) => firstText(entity.reference, entity.id),
    status: (entity) => firstText(entity.status),
    merchantId: (entity) => firstText(entity.merchantId),
    createdAt: (entity) => toDate(entity.createdAt),
  },
  join_request: {
    exact: ["id", "merchantId", "approvalRequestId"],
    names: ["merchant.tradeName", "merchant.legalName", "merchant.displayName"],
    secondary: ["status", "onboardingChannel", "proposedRiskTier", "decision"],
    title: (entity) =>
      `Join request · ${firstText(entity.status, entity.id) ?? ""}`,
    subtitle: (entity) =>
      compactText([
        getPath(entity, "merchant.tradeName") ?? getPath(entity, "merchant.legalName"),
        entity.onboardingChannel,
        entity.proposedRiskTier,
      ]),
    reference: (entity) => firstText(entity.id),
    status: (entity) => firstText(entity.status),
    merchantId: (entity) => firstText(entity.merchantId),
    createdAt: (entity) => toDate(entity.createdAt),
  },
  kyb_document: {
    exact: ["id", "sha256", "merchantId", "joinRequestId", "uploadedById", "reviewedById"],
    names: ["originalFileName", "docType", "mime"],
    secondary: ["status", "avStatus", "docType", "subjectType"],
    title: (entity) =>
      `${firstText(entity.docType, "Document") ?? "Document"} · ${
        firstText(entity.originalFileName, "Document") ?? "Document"
      }`,
    subtitle: (entity) =>
      compactText([
        getPath(entity, "merchant.tradeName") ?? getPath(entity, "merchant.legalName"),
        entity.avStatus,
      ]),
    reference: (entity) => {
      const sha256 = firstText(entity.sha256);
      return sha256 ? sha256.slice(0, 12) : firstText(entity.id);
    },
    status: (entity) => firstText(entity.status),
    merchantId: (entity) => firstText(entity.merchantId),
    createdAt: (entity) => toDate(entity.createdAt),
  },
  operator_case: {
    exact: ["id", "attemptId", "approvalRequestId", "reconciliationItemId", "assignee.email"],
    names: ["kind", "priority", "attempt.reference", "attempt.merchant.tradeName", "attempt.merchant.legalName"],
    secondary: ["state", "priority", "kind"],
    title: (entity) =>
      `${firstText(entity.kind, "Case") ?? "Case"} · ${firstText(entity.priority, "") ?? ""}`,
    subtitle: (entity) =>
      compactText([
        getPath(entity, "attempt.reference") ?? entity.attemptId,
        getPath(entity, "attempt.merchantId"),
        entity.assigneeUserId,
      ]),
    reference: (entity) =>
      firstText(getPath(entity, "attempt.reference"), entity.attemptId, entity.id),
    status: (entity) => firstText(entity.state),
    merchantId: (entity) => firstText(getPath(entity, "attempt.merchantId")),
    operatorCaseId: (entity) => firstText(entity.id),
    createdAt: (entity) => toDate(entity.createdAt),
  },
  user: {
    exact: ["id", "email", { path: "phone", phone: true }, "merchantId"],
    names: ["email", "role"],
    secondary: ["role", "status"],
    title: (entity) => firstText(entity.email, entity.phone, entity.id) ?? "",
    subtitle: (entity) =>
      compactText([
        entity.role,
        getPath(entity, "merchant.tradeName") ?? getPath(entity, "merchant.legalName"),
      ]),
    reference: (entity) => firstText(entity.id),
    status: (entity) => firstText(entity.status),
    merchantId: (entity) => firstText(entity.merchantId),
    createdAt: (entity) => toDate(entity.createdAt),
  },
  approval: {
    exact: ["id", "subjectId", "approvalRequestId", "maker.email", "checker.email"],
    names: ["subjectType", "makerReason", "kind", "maker.email", "checker.email"],
    secondary: ["state", "subjectType", "mode"],
    title: (entity) => `Approval · ${firstText(entity.subjectType, entity.id) ?? ""}`,
    subtitle: (entity) => compactText([entity.subjectType, entity.state, entity.makerReason]),
    reference: (entity) => firstText(entity.subjectId, entity.id),
    status: (entity) => firstText(entity.state, entity.status),
    merchantId: (entity) => firstText(entity.merchantId),
    operatorCaseId: (entity) => firstText(entity.operatorCaseId),
    createdAt: (entity) => toDate(entity.createdAt),
  },
  audit_log: {
    exact: ["id", "entityId", "actorId", "actor.email"],
    names: ["action", "entityType", "actor.email"],
    secondary: ["action", "entityType", "role"],
    title: (entity) =>
      `${firstText(entity.action, "Audit") ?? "Audit"} (${firstText(entity.entityType, "") ?? ""})`,
    subtitle: (entity) => compactText([entity.actorId, entity.role]),
    reference: (entity) => firstText(entity.entityId, entity.id),
    status: (entity) => firstText(entity.status),
    merchantId: (entity) => firstText(entity.merchantId),
    createdAt: (entity) => toDate(entity.createdAt),
  },
  gateway_inquiry: {
    exact: ["id", "operatorCaseId", "attemptId", "attempt.reference"],
    names: ["source", "status", "reason"],
    secondary: ["status", "source"],
    title: (entity) =>
      `Inquiry ${firstText(getPath(entity, "attempt.reference"), entity.id) ?? ""}`,
    subtitle: (entity) => compactText([entity.source, entity.status, entity.reason]),
    reference: (entity) =>
      firstText(getPath(entity, "attempt.reference"), entity.id),
    status: (entity) => firstText(entity.status),
    merchantId: (entity) => firstText(getPath(entity, "attempt.merchantId")),
    operatorCaseId: (entity) => firstText(entity.operatorCaseId),
    createdAt: (entity) => toDate(entity.createdAt),
  },
  gateway: {
    exact: ["id", "code"],
    names: ["name", "operator"],
    secondary: ["status", "code"],
    title: (entity) =>
      `${firstText(entity.name, entity.code, entity.id) ?? ""}${
        entity.code ? ` (${String(entity.code)})` : ""
      }`,
    subtitle: (entity) => firstText(entity.operator),
    reference: (entity) => firstText(entity.code, entity.id),
    status: (entity) => firstText(entity.status),
    createdAt: (entity) => toDate(entity.createdAt),
  },
  rail: {
    exact: ["id", "code"],
    names: ["nameEn", "nameAr"],
    secondary: ["collectionMode", "currency", "status"],
    title: (entity) =>
      `${firstText(entity.nameEn, entity.code, entity.id) ?? ""}${
        entity.nameAr ? ` (${String(entity.nameAr)})` : ""
      }`,
    subtitle: (entity) => compactText([entity.collectionMode, entity.currency]),
    reference: (entity) => firstText(entity.code, entity.id),
    status: (entity) => firstText(entity.status),
    createdAt: (entity) => toDate(entity.createdAt),
  },
  route: {
    exact: ["id", "railId", "gatewayId"],
    names: ["rail.code", "rail.nameEn", "rail.nameAr", "gateway.code", "gateway.name"],
    secondary: ["healthState", "priority"],
    title: (entity) =>
      `${firstText(getPath(entity, "rail.code"), "Rail") ?? "Rail"} → ${
        firstText(getPath(entity, "gateway.code"), "Gateway") ?? "Gateway"
      }`,
    subtitle: (entity) =>
      compactText([
        entity.priority === undefined ? null : `Priority ${String(entity.priority)}`,
        entity.healthState,
      ]),
    reference: (entity) => firstText(entity.id),
    status: (entity) => firstText(entity.healthState, entity.status),
    createdAt: (entity) => toDate(entity.createdAt),
  },
  dispute: {
    exact: ["id", "externalDisputeRef", "attemptId", "attempt.reference"],
    names: ["reasonCode", "reason", "status"],
    secondary: ["status", "reasonCode"],
    title: (entity) =>
      `Dispute ${firstText(entity.externalDisputeRef, entity.id) ?? ""}`,
    subtitle: (entity) =>
      compactText([getPath(entity, "attempt.reference"), entity.status]),
    reference: (entity) =>
      firstText(entity.externalDisputeRef, getPath(entity, "attempt.reference"), entity.id),
    status: (entity) => firstText(entity.status),
    merchantId: (entity) => firstText(getPath(entity, "attempt.merchantId")),
    createdAt: (entity) => toDate(entity.createdAt),
  },
  adjustment: {
    exact: ["id", "sourceAttemptId", "sourceAttempt.reference"],
    names: ["type", "reasonCode"],
    secondary: ["type", "state", "reasonCode"],
    title: (entity) => `${firstText(entity.type, "Adjustment") ?? "Adjustment"}`,
    subtitle: (entity) =>
      compactText([getPath(entity, "sourceAttempt.reference"), entity.state]),
    reference: (entity) =>
      firstText(getPath(entity, "sourceAttempt.reference"), entity.id),
    status: (entity) => firstText(entity.state, entity.status),
    merchantId: (entity) => firstText(getPath(entity, "sourceAttempt.merchantId")),
    createdAt: (entity) => toDate(entity.createdAt),
  },
  cashout: {
    exact: ["id", "merchantId", "adjustmentId"],
    names: ["state", "destination"],
    secondary: ["state", "currency"],
    title: (entity) => `Cash-out ${firstText(entity.id) ?? ""}`,
    subtitle: (entity) => compactText([entity.state, entity.currency]),
    reference: (entity) => firstText(entity.id),
    status: (entity) => firstText(entity.state, entity.status),
    merchantId: (entity) => firstText(entity.merchantId),
    createdAt: (entity) => toDate(entity.createdAt),
  },
  aml_case: {
    exact: ["id", "subjectId", "screeningId", "approvalRequestId"],
    names: ["triggerReason", "rule.code", "rule.name"],
    secondary: ["status", "severity", "subjectType"],
    title: (entity) =>
      `AML Case · ${firstText(
        getPath(entity, "rule.code"),
        entity.triggerReason,
        entity.id,
      ) ?? ""}`,
    subtitle: (entity) => compactText([entity.subjectType, entity.status, entity.severity]),
    reference: (entity) => firstText(entity.id),
    status: (entity) => firstText(entity.status),
    merchantId: (entity) => firstText(entity.merchantId),
    createdAt: (entity) => toDate(entity.createdAt),
  },
  aml_screening: {
    exact: ["id", "subjectId", "providerRequestRef", "providerCode"],
    names: ["providerCode", "result"],
    secondary: ["result", "subjectType"],
    title: (entity) => `Screening · ${firstText(entity.providerCode, entity.id) ?? ""}`,
    subtitle: (entity) => compactText([entity.subjectType, entity.result]),
    reference: (entity) => firstText(entity.providerRequestRef, entity.id),
    status: (entity) => firstText(entity.result, entity.status),
    merchantId: (entity) => firstText(entity.merchantId),
    createdAt: (entity) => toDate(entity.createdAt),
  },
  aml_rule: {
    exact: ["id", "code"],
    names: ["name", "description"],
    secondary: ["ruleType", "action"],
    title: (entity) =>
      `${firstText(entity.code, entity.id) ?? ""} · ${firstText(entity.name, "") ?? ""}`,
    subtitle: (entity) => compactText([entity.ruleType, entity.action]),
    reference: (entity) => firstText(entity.code, entity.id),
    status: (entity) => firstText(entity.status),
    createdAt: (entity) => toDate(entity.createdAt),
  },
  aml_report: {
    exact: ["id", "subjectId", "submissionRef"],
    names: ["reportType", "authority"],
    secondary: ["status", "authority", "reportType"],
    title: (entity) =>
      `${firstText(entity.reportType, "Report") ?? "Report"} · ${
        firstText(entity.subjectId, entity.id) ?? ""
      }`,
    subtitle: (entity) => compactText([entity.authority, entity.status]),
    reference: (entity) => firstText(entity.submissionRef, entity.id),
    status: (entity) => firstText(entity.status),
    merchantId: (entity) => firstText(entity.merchantId),
    createdAt: (entity) => toDate(entity.createdAt),
  },
  reconciliation_run: {
    exact: ["id", "statementSourceId"],
    names: ["statementSource.gateway.code", "statementSource.gateway.name", "status"],
    secondary: ["status", "kind"],
    title: (entity) =>
      firstText(getPath(entity, "statementSource.gateway.code"), "Reconciliation") ?? "Reconciliation",
    subtitle: (entity) => compactText([entity.status, entity.kind]),
    reference: (entity) => firstText(entity.id),
    status: (entity) => firstText(entity.status),
    createdAt: (entity) => toDate(entity.createdAt),
  },
};

export function extractEntitySearchTokens(
  entityType: string,
  entityValue: unknown,
): ExtractedEntitySearchToken[] {
  const entity = asRecord(entityValue);
  const spec = entitySpecs[entityType] ?? genericSpec;
  const accumulator = createAccumulator();

  for (const field of spec.exact ?? []) {
    addField(accumulator, entity, field, SEARCH_TOKEN_WEIGHTS.exact);
  }
  for (const field of spec.names ?? []) {
    const value = getPath(entity, fieldPath(field));
    if (value !== undefined && value !== null) {
      accumulator.addWords(value, fieldWeight(field, SEARCH_TOKEN_WEIGHTS.primary), fieldSensitive(field));
    }
  }
  for (const field of spec.secondary ?? []) {
    const value = getPath(entity, fieldPath(field));
    if (value !== undefined && value !== null) {
      accumulator.addWords(value, fieldWeight(field, SEARCH_TOKEN_WEIGHTS.secondary), fieldSensitive(field));
    }
  }

  return accumulator.values();
}

export function buildEntitySearchTokenRows(
  entityType: string,
  entityValue: unknown,
): EntitySearchTokenRow[] {
  const entity = asRecord(entityValue);
  const entityId = firstText(entity.id);
  if (!entityId) {
    return [];
  }
  const spec = entitySpecs[entityType] ?? genericSpec;
  const tokens = extractEntitySearchTokens(entityType, entity);
  if (tokens.length === 0) {
    return [];
  }

  const createdAt =
    toDate(spec.createdAt?.(entity)) ??
    toDate(entity.createdAt) ??
    toDate(entity.updatedAt) ??
    new Date();
  const title = clampText(spec.title(entity), 255) ?? entityId.slice(0, 255);
  const subtitle = clampText(spec.subtitle?.(entity) ?? null, 255);
  const reference = clampText(spec.reference?.(entity) ?? null, 128);
  const status = clampText(spec.status?.(entity) ?? null, 64);
  const merchantId = clampText(spec.merchantId?.(entity) ?? null, 191);
  const operatorCaseId = clampText(spec.operatorCaseId?.(entity) ?? null, 191);

  return tokens.map((token) => ({
    token: token.token,
    entityType,
    entityId,
    merchantId,
    isSensitive: token.isSensitive,
    baseWeight: token.baseWeight,
    title,
    subtitle,
    reference,
    status,
    operatorCaseId,
    entityCreatedAt: createdAt,
  }));
}

interface EntitySearchTokenDelegate {
  deleteMany: (args: unknown) => Promise<{ count: number }>;
  createMany: (args: unknown) => Promise<{ count: number }>;
}

const entitySearchTokenDelegate = (client: unknown): EntitySearchTokenDelegate | null => {
  const delegate = (client as { entitySearchToken?: Partial<EntitySearchTokenDelegate> } | null)
    ?.entitySearchToken;
  if (
    !delegate ||
    typeof delegate.deleteMany !== "function" ||
    typeof delegate.createMany !== "function"
  ) {
    return null;
  }
  return delegate as EntitySearchTokenDelegate;
};

export async function upsertEntitySearchTokens(
  client: unknown,
  entityType: string,
  entity: unknown,
): Promise<number> {
  const delegate = entitySearchTokenDelegate(client);
  const entityId = firstText(asRecord(entity).id);
  if (!delegate || !entityId) {
    return 0;
  }
  const rows = buildEntitySearchTokenRows(entityType, entity);
  await delegate.deleteMany({ where: { entityType, entityId } });
  if (rows.length === 0) {
    return 0;
  }
  await delegate.createMany({ data: rows, skipDuplicates: true });
  return rows.length;
}

export async function deleteEntitySearchTokens(
  client: unknown,
  entityType: string,
  entityId: string,
): Promise<number> {
  const delegate = entitySearchTokenDelegate(client);
  if (!delegate || !entityId) {
    return 0;
  }
  const result = await delegate.deleteMany({ where: { entityType, entityId } });
  return result.count;
}

/** Best-effort write hook: search indexing must never break the domain write. */
export async function safeUpsertEntitySearchTokens(
  client: unknown,
  entityType: string,
  entity: unknown,
): Promise<number> {
  try {
    return await upsertEntitySearchTokens(client, entityType, entity);
  } catch {
    return 0;
  }
}

/** Best-effort delete hook: search indexing must never break the domain write. */
export async function safeDeleteEntitySearchTokens(
  client: unknown,
  entityType: string,
  entityId: string,
): Promise<number> {
  try {
    return await deleteEntitySearchTokens(client, entityType, entityId);
  } catch {
    return 0;
  }
}

export function extractSearchQueryTokens(term: string): string[] {
  const normalized = normalizeSearchToken(term);
  if (!normalized || /\s/.test(normalized) || !/[\p{L}\p{N}]/u.test(normalized)) {
    return [];
  }

  const tokens = new Set<string>();
  tokens.add(normalized);
  if (normalized.startsWith("@")) {
    tokens.add(normalized.slice(1));
  }
  if (EMAIL.test(normalized)) {
    const domain = normalized.split("@").pop();
    if (domain) {
      tokens.add(domain);
    }
    const local = normalized.split("@")[0];
    if (local && local.length >= 2) {
      tokens.add(local);
    }
  }
  for (const variant of phoneTokenVariants(normalized)) {
    tokens.add(variant);
  }
  return Array.from(tokens).filter((token) => token.length >= 2);
}

export interface KybDocumentHashStatResult {
  sha256: string;
  docCount: number;
  merchantCount: number;
}

interface KybStatsDocumentDelegate {
  count: (args: unknown) => Promise<number>;
  findMany: (args: unknown) => Promise<Array<{ merchantId?: string | null }>>;
}

interface KybDocumentHashStatDelegate {
  deleteMany: (args: unknown) => Promise<{ count: number }>;
  upsert: (args: unknown) => Promise<unknown>;
}

/**
 * Recomputes one hash row exactly from `kyb_documents`. This is intentionally
 * called after upload/delete inside the same transaction so the materialized
 * table can never drift from the document table.
 */
export async function recomputeKybDocumentHashStat(
  client: unknown,
  sha256: string,
): Promise<KybDocumentHashStatResult | null> {
  const documents = (client as { kybDocument?: Partial<KybStatsDocumentDelegate> } | null)
    ?.kybDocument;
  const stats = (client as { kybDocumentHashStat?: Partial<KybDocumentHashStatDelegate> } | null)
    ?.kybDocumentHashStat;
  if (
    !documents ||
    typeof documents.count !== "function" ||
    typeof documents.findMany !== "function" ||
    !stats ||
    typeof stats.deleteMany !== "function" ||
    typeof stats.upsert !== "function"
  ) {
    return null;
  }

  const [docCount, merchantRows] = await Promise.all([
    documents.count({ where: { sha256 } }),
    documents.findMany({
      where: { sha256 },
      select: { merchantId: true },
      distinct: ["merchantId"],
    }),
  ]);

  if (docCount === 0) {
    await stats.deleteMany({ where: { sha256 } });
    return null;
  }

  const merchantCount = new Set(
    merchantRows
      .map((row) => row.merchantId)
      .filter((merchantId): merchantId is string => Boolean(merchantId)),
  ).size;

  await stats.upsert({
    where: { sha256 },
    create: { sha256, docCount, merchantCount },
    update: { docCount, merchantCount },
  });

  return { sha256, docCount, merchantCount };
}

export async function safeRecomputeKybDocumentHashStat(
  client: unknown,
  sha256: string,
): Promise<KybDocumentHashStatResult | null> {
  try {
    return await recomputeKybDocumentHashStat(client, sha256);
  } catch {
    return null;
  }
}
