import { readFileSync } from "node:fs";
import path from "node:path";
import type {
  CatalogColumnDef,
  CatalogDomain,
  CatalogModelDef,
  CatalogRelationDef,
  ModelOptimizationRule,
} from "../../lib/reportEngineSdk/types/hostConfig";

type ScalarType = CatalogColumnDef["type"];

interface RawField {
  name: string;
  typeName: string;
  isList: boolean;
  isOptional: boolean;
  attributes: string;
}

interface RawModel {
  name: string;
  tableName: string;
  fields: RawField[];
  indexFields: Set<string>;
  uniqueFields: Set<string>;
}

interface RawRelation {
  modelName: string;
  fieldName: string;
  targetModelName: string;
  isList: boolean;
  fromFields: string[];
  references: string[];
}

const FORBIDDEN_SECRET_COLUMNS = new Set([
  "password_hash",
  "mfa_secret_ciphertext",
  "entries_ciphertext",
  "mtls_cert_ciphertext",
  "token_hash",
  "invitation_token_hash",
  "context_ciphertext",
  "content_ciphertext",
  "secret_ciphertext",
  "private_key",
  "api_secret",
  "kms_key",
  "payout_account_hash",
]);

const PII_COLUMNS = new Set([
  "phone",
  "email",
  "contact_phone",
  "contact_email",
  "support_phone",
  "support_email",
  "national_id",
  "date_of_birth",
  "full_name",
  "iban",
  "account_number",
  "bank_account",
]);

const MONEY_FIELD = /(amount|balance|fee|commission|volume|total|net|price)$/i;

const parseModels = (source: string): { models: RawModel[]; enums: Record<string, string[]> } => {
  const enums: Record<string, string[]> = {};
  for (const match of source.matchAll(/^enum\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const name = match[1]!;
    enums[name] = match[2]!
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("//") && !line.startsWith("@@"))
      .map((line) => line.split(/\s+/)[0]!)
      .filter(Boolean);
  }

  const models: RawModel[] = [];
  for (const match of source.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const name = match[1]!;
    const body = match[2]!;
    const tableMatch = /@@map\("([^"]+)"\)/.exec(body);
    const tableName = tableMatch?.[1] ?? name;
    const indexFields = new Set<string>();
    const uniqueFields = new Set<string>();
    for (const idx of body.matchAll(/@@(index|unique)\(\[([^\]]+)\]/g)) {
      const target = idx[1] === "index" ? indexFields : uniqueFields;
      for (const field of idx[2]!.split(",")) {
        const cleaned = field.trim().replace(/\(.*$/, "");
        if (cleaned) target.add(cleaned);
      }
    }
    const fields: RawField[] = [];
    for (const line of body.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("///") || trimmed.startsWith("@@")) {
        continue;
      }
      const fieldMatch = /^(\w+)\s+([A-Za-z0-9_]+)(\[\])?(\?)?\s*(.*)$/.exec(trimmed);
      if (!fieldMatch) continue;
      fields.push({
        name: fieldMatch[1]!,
        typeName: fieldMatch[2]!,
        isList: Boolean(fieldMatch[3]),
        isOptional: Boolean(fieldMatch[4]),
        attributes: fieldMatch[5] ?? "",
      });
    }
    models.push({ name, tableName, fields, indexFields, uniqueFields });
  }
  return { models, enums };
};

const rawRelations = (models: RawModel[]): RawRelation[] => {
  const modelNames = new Set(models.map((m) => m.name));
  const relations: RawRelation[] = [];
  for (const model of models) {
    for (const field of model.fields) {
      if (!modelNames.has(field.typeName)) continue;
      const fieldsMatch = /fields:\s*\[([^\]]+)\]/.exec(field.attributes);
      const referencesMatch = /references:\s*\[([^\]]+)\]/.exec(field.attributes);
      relations.push({
        modelName: model.name,
        fieldName: field.name,
        targetModelName: field.typeName,
        isList: field.isList,
        fromFields: fieldsMatch ? fieldsMatch[1]!.split(",").map((v) => v.trim()) : [],
        references: referencesMatch ? referencesMatch[1]!.split(",").map((v) => v.trim()) : [],
      });
    }
  }
  return relations;
};

const domainFor = (tableName: string): CatalogDomain => {
  if (/^(journal|gl_|commission|adjustment|ledger)/.test(tableName)) return "LEDGER";
  if (/^(payment|wallet|cashout|dispute|refund|settlement)/.test(tableName)) return "PAYMENTS";
  if (/^(merchant|application|join_request|kyb|pos_|payment_link)/.test(tableName)) return "MERCHANTS";
  if (/^(aml|compliance|regulatory|screening|reporting_rule)/.test(tableName)) return "COMPLIANCE_AML";
  if (/^(gateway|rail|flow|credential|asset|crypto)/.test(tableName)) return "GATEWAYS";
  if (/^(reconciliation|statement)/.test(tableName)) return "RECONCILIATION";
  if (/^(user|session|audit|access_token|mfa|worker_cursor|deadline_stage)/.test(tableName)) {
    return "SECURITY_AUDIT";
  }
  return "OPERATIONS";
};

const authorityFor = (domain: CatalogDomain): { authorities: string[]; roles: string[] } => {
  switch (domain) {
    case "LEDGER":
      return { authorities: ["finance:read"], roles: ["FINANCE"] };
    case "PAYMENTS":
      return { authorities: ["merchant:read"], roles: ["OPERATOR", "FINANCE", "SUPPORT"] };
    case "MERCHANTS":
      return { authorities: ["merchant:read"], roles: ["OPERATOR", "FINANCE", "SUPPORT"] };
    case "COMPLIANCE_AML":
      return { authorities: ["aml:read", "compliance:read"], roles: ["COMPLIANCE", "MLRO"] };
    case "GATEWAYS":
      return { authorities: ["gateway:read"], roles: ["GATEWAY_ADMIN"] };
    case "RECONCILIATION":
      return { authorities: ["reconciliation:read"], roles: ["FINANCE", "OPERATOR"] };
    case "SECURITY_AUDIT":
      return { authorities: ["security:read"], roles: ["SECURITY_ADMIN"] };
    case "OPERATIONS":
    default:
      return { authorities: ["operator:read"], roles: ["OPERATOR", "SUPPORT"] };
  }
};

const defaultOptimizationRule = (tableName: string): ModelOptimizationRule => {
  if (tableName === "journal_lines") {
    return {
      mandatoryFilterColumns: [
        {
          column: "created_at",
          allowedOperators: ["between", "gte_lte"],
          maxDateRangeDays: 366,
          rationale:
            "journal_lines is monthly range-partitioned by created_at; queries without a bounded created_at range scan all 72+ partitions.",
          aiFixHint:
            "Add a WHERE predicate on column 'created_at' with op='between' bound to a 'daterange' input with validation.max_range_days <= 366.",
        },
      ],
      requireIndexedFilter: true,
      maxRowsReturned: 10_000,
      transcriptOptimizationNote:
        "ALWAYS filter journal_lines by created_at (max 366 days) to trigger PostgreSQL 18 partition pruning. For current live GL balances, query gl_account_shards instead of summing journal_lines.",
    };
  }
  if (tableName === "payment_attempts" || tableName === "journal_entries") {
    return {
      mandatoryFilterColumns: [
        {
          column: "created_at",
          allowedOperators: ["between", "gte_lte"],
          maxDateRangeDays: 180,
          rationale: `${tableName} is a large history table; a bounded created_at range keeps the report query indexed.`,
          aiFixHint:
            "Add a WHERE predicate on column 'created_at' with op='between' bound to a 'daterange' input with validation.max_range_days <= 180.",
        },
      ],
      requireIndexedFilter: true,
      maxRowsReturned: 10_000,
      transcriptOptimizationNote: `Always bound ${tableName}.created_at and filter on an indexed column such as merchant_id.`,
    };
  }
  if (tableName === "audit_log") {
    return {
      mandatoryFilterColumns: [
        {
          column: "created_at",
          allowedOperators: ["between", "gte_lte"],
          maxDateRangeDays: 180,
          rationale: "audit_log is a large append-only security table.",
          aiFixHint:
            "Add a WHERE predicate on column 'created_at' with op='between' bound to a 'daterange' input with validation.max_range_days <= 180.",
        },
      ],
      requireIndexedFilter: true,
      maxRowsReturned: 10_000,
      transcriptOptimizationNote: "Bound audit_log.created_at and filter by actor or entity.",
    };
  }
  if (tableName === "outbox_events") {
    return {
      mandatoryFilterColumns: [
        {
          column: "created_at",
          allowedOperators: ["between", "gte_lte"],
          maxDateRangeDays: 30,
          rationale: "outbox_events is an append-only operational table.",
          aiFixHint:
            "Add a WHERE predicate on column 'created_at' with op='between' bound to a 'daterange' input with validation.max_range_days <= 30.",
        },
      ],
      requireIndexedFilter: true,
      maxRowsReturned: 10_000,
      transcriptOptimizationNote: "Bound outbox_events.created_at.",
    };
  }
  if (tableName === "gl_account_shards") {
    return {
      requireIndexedFilter: false,
      maxRowsReturned: 5_000,
      transcriptOptimizationNote:
        "Use gl_account_shards with SUM(balance_minor) GROUP BY gl_account_id for live account balances.",
    };
  }
  return {
    requireIndexedFilter: false,
    maxRowsReturned: 10_000,
    transcriptOptimizationNote: `Prefer indexed filters (ids, status, created_at) when querying ${tableName}.`,
  };
};

const descriptionFor = (tableName: string): string => {
  const descriptions: Record<string, string> = {
    journal_lines: "Monthly range-partitioned double-entry ledger lines.",
    journal_entries: "Journal entry headers (one per domain reference).",
    gl_accounts: "Chart-of-accounts rows.",
    gl_account_shards: "Hot-account balance shards (live balances).",
    payment_attempts: "Payment attempts across every rail.",
    merchants: "Merchant master records.",
    applications: "Merchant applications/channels.",
    wallets: "Merchant wallets.",
    aml_cases: "Confidential AML cases.",
    gateways: "Configured payment gateways.",
    gateway_versions: "Immutable gateway versions.",
    reconciliation_runs: "Statement reconciliation runs.",
    reconciliation_items: "Reconciliation line items.",
    audit_log: "Append-only audit trail.",
    users: "Backoffice and merchant users.",
    credential_sets: "Gateway credential sets (secrets are forbidden).",
    payment_links: "Hosted payment links.",
    disputes: "Chargebacks and disputes.",
    cashout_requests: "Merchant cash-out requests.",
    commission_profiles: "Commission profiles.",
    rails: "Payment rails.",
  };
  return descriptions[tableName] ?? `Reportable table ${tableName}.`;
};

const typeFor = (raw: RawField, enums: Record<string, string[]>): ScalarType => {
  if (enums[raw.typeName]) return "enum";
  switch (raw.typeName) {
    case "String":
      return /@db\.Uuid/.test(raw.attributes) ? "uuid" : "string";
    case "Int":
      return "int";
    case "BigInt":
      return "bigint";
    case "Decimal":
      return "decimal";
    case "Boolean":
      return "boolean";
    case "DateTime":
      return "datetime";
    case "Json":
      return "json";
    default:
      return "string";
  }
};

export function buildSchemaCatalog(schemaPath = path.join(import.meta.dir, "../../prisma/schema.prisma")): {
  models: Record<string, CatalogModelDef>;
  enums: Record<string, string[]>;
} {
  const source = readFileSync(schemaPath, "utf8");
  const { models: rawModels, enums } = parseModels(source);
  const relations = rawRelations(rawModels);
  const byModel = new Map(rawModels.map((m) => [m.name, m]));
  const tableByModel = new Map(rawModels.map((m) => [m.name, m.tableName]));
  const models: Record<string, CatalogModelDef> = {};

  for (const raw of rawModels) {
    const domain = domainFor(raw.tableName);
    const { authorities, roles } = authorityFor(domain);
    const columns: Record<string, CatalogColumnDef> = {};
    const indexColumns = new Set([...raw.indexFields, ...raw.uniqueFields]);
    for (const field of raw.fields) {
      if (byModel.has(field.typeName) || field.isList) continue;
      const dbColumnName = /@map\("([^"]+)"\)/.exec(field.attributes)?.[1] ?? field.name;
      const type = typeFor(field, enums);
      const sensitivity =
        FORBIDDEN_SECRET_COLUMNS.has(dbColumnName) || FORBIDDEN_SECRET_COLUMNS.has(field.name)
          ? "FORBIDDEN_SECRET"
          : PII_COLUMNS.has(dbColumnName)
            ? "PII_MASKED"
            : type === "decimal" || type === "bigint" || type === "uuid"
              ? "INTERNAL"
              : "PUBLIC";
      const indexed =
        /@id\b/.test(field.attributes) ||
        /@unique\b/.test(field.attributes) ||
        indexColumns.has(field.name) ||
        relations.some(
          (r) =>
            r.modelName === raw.name &&
            r.fromFields.includes(field.name) &&
            r.references.length > 0,
        );
      columns[dbColumnName] = {
        name: dbColumnName,
        dbColumnName,
        type,
        enumName: enums[field.typeName] ? field.typeName : undefined,
        nullable: field.isOptional,
        indexed,
        sensitivity,
        description: `${raw.tableName}.${dbColumnName}`,
        redactionStrategy:
          sensitivity === "PII_MASKED"
            ? /email|phone|mobile|fax/i.test(dbColumnName)
              ? "MASK_MIDDLE"
              : "OMIT"
            : undefined,
      };
      if (type === "decimal" && MONEY_FIELD.test(field.name)) {
        const minorName = `${field.name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`).replace(/^_/, "")}_minor`;
        if (!columns[minorName]) {
          columns[minorName] = {
            name: minorName,
            dbColumnName,
            type: "bigint",
            nullable: field.isOptional,
            indexed: false,
            sensitivity: "INTERNAL",
            description: `${raw.tableName}.${dbColumnName} in minor units (scale 1000).`,
            minorUnitScale: 1000,
          };
        }
      }
    }

    if (raw.tableName === "journal_lines" && columns.amount && !columns.amount_minor) {
      columns.amount_minor = {
        name: "amount_minor",
        dbColumnName: columns.amount.dbColumnName,
        type: "bigint",
        nullable: false,
        indexed: false,
        sensitivity: "INTERNAL",
        description: "Ledger line amount in minor units (scale 1000).",
        minorUnitScale: 1000,
      };
    }
    if (raw.tableName === "gl_account_shards") {
      if (columns.shard_id) {
        columns.shard_no = {
          name: "shard_no",
          dbColumnName: columns.shard_id.dbColumnName,
          type: "int",
          nullable: false,
          indexed: true,
          sensitivity: "INTERNAL",
          description: "Shard number.",
        };
      }
      if (columns.current_balance) {
        columns.balance_minor = {
          name: "balance_minor",
          dbColumnName: columns.current_balance.dbColumnName,
          type: "bigint",
          nullable: false,
          indexed: false,
          sensitivity: "INTERNAL",
          description: "Signed shard balance in minor units (scale 1000).",
          minorUnitScale: 1000,
        };
      }
    }

    const modelRelations: Record<string, CatalogRelationDef> = {};
    for (const rel of relations.filter((r) => r.modelName === raw.name)) {
      const targetTable = tableByModel.get(rel.targetModelName) ?? rel.targetModelName;
      const dbNameOf = (modelName: string, fieldName: string): string => {
        const model = byModel.get(modelName);
        const field = model?.fields.find((f) => f.name === fieldName);
        return field ? (/@map\("([^"]+)"\)/.exec(field.attributes)?.[1] ?? field.name) : fieldName;
      };
      if (rel.isList) {
        const inverse = relations.find(
          (r) => r.modelName === rel.targetModelName && r.targetModelName === raw.name && !r.isList,
        );
        const targetKey = inverse?.fromFields[0]
          ? dbNameOf(rel.targetModelName, inverse.fromFields[0])
          : "id";
        modelRelations[rel.fieldName] = {
          name: rel.fieldName,
          targetModel: targetTable,
          cardinality: "ONE_TO_MANY",
          sourceKey: dbNameOf(raw.name, "id"),
          targetKey,
        };
      } else {
        modelRelations[rel.fieldName] = {
          name: rel.fieldName,
          targetModel: targetTable,
          cardinality: "MANY_TO_ONE",
          sourceKey: rel.fromFields[0] ? dbNameOf(raw.name, rel.fromFields[0]) : "id",
          targetKey: rel.references[0] ? dbNameOf(rel.targetModelName, rel.references[0]) : "id",
        };
      }
    }

    const merchantColumn = columns.merchant_id?.dbColumnName;
    const merchantScopable =
      raw.tableName === "merchants"
        ? { merchantIdColumn: "id" }
        : merchantColumn
          ? { merchantIdColumn: merchantColumn }
          : undefined;

    models[raw.tableName] = {
      modelName: raw.tableName,
      tableName: raw.tableName,
      domain,
      description: descriptionFor(raw.tableName),
      partitionedBy: raw.tableName === "journal_lines" ? "created_at" : undefined,
      columns,
      relations: modelRelations,
      requiredAuthorities: authorities,
      naturalRoles: roles,
      confidentialAmlOnly: raw.tableName === "aml_cases" || raw.tableName === "aml_screenings",
      merchantScopable,
      optimizationRule: defaultOptimizationRule(raw.tableName),
    };
  }

  return { models, enums };
}
