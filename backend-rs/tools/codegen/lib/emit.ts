/**
 * Rust and JSON emitters for the generated Prisma artefacts.
 *
 * Everything here is a pure function of [`SchemaDef`]. Output is stable byte-for-byte: fixed
 * headers, schema order, no timestamps and no environment reads.
 */

import type { EnumDef, FieldDef, ModelDef, SchemaDef } from "./prisma";

/** Render `crates/pg-types/src/generated/enums.rs`. */
export function renderEnums(schema: SchemaDef): string {
  const lines: string[] = [];
  lines.push(...header("Prisma enums", schema.schemaVersion));
  lines.push("");
  lines.push("#![allow(clippy::enum_variant_names)]");
  lines.push("#![allow(clippy::upper_case_acronyms)]");
  lines.push("#![allow(clippy::wrong_self_convention)]");
  lines.push("");

  for (const entry of schema.enums) {
    lines.push("#[derive(");
    lines.push(
      "    Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize, sqlx::Type,",
    );
    lines.push(")]");
    lines.push(`#[sqlx(type_name = "\\"${rustString(entry.dbName)}\\"")]`);
    lines.push(`pub enum ${entry.name} {`);
    for (const value of entry.values) {
      if (value.prisma !== value.variant) {
        lines.push(`    #[serde(rename = "${rustString(value.prisma)}")]`);
      }
      if (value.db !== value.variant) {
        lines.push(`    #[sqlx(rename = "${rustString(value.db)}")]`);
      }
      lines.push(`    ${value.variant},`);
    }
    lines.push("}");
    lines.push("");
    lines.push(`impl ${entry.name} {`);
    lines.push("    pub fn as_str(self) -> &'static str {");
    lines.push("        match self {");
    for (const value of entry.values) {
      lines.push(`            Self::${value.variant} => "${rustString(value.db)}",`);
    }
    lines.push("        }");
    lines.push("    }");
    lines.push("");
    lines.push("    pub fn from_db_str(value: &str) -> Option<Self> {");
    lines.push("        match value {");
    for (const value of entry.values) {
      lines.push(
        `            "${rustString(value.db)}" => Some(Self::${value.variant}),`,
      );
    }
    lines.push("            _ => None,");
    lines.push("        }");
    lines.push("    }");
    lines.push("}");
    lines.push("");
  }

  lines.push(`pub const ENUM_COUNT: usize = ${schema.enums.length};`);
  lines.push("");
  lines.push("#[cfg(test)]");
  lines.push("#[rustfmt::skip]");
  lines.push("mod tests {");
  lines.push("    use super::*;");
  lines.push("");
  lines.push("    #[test]");
  lines.push("    fn enum_count_matches_generated() {");
  lines.push(`        assert_eq!(ENUM_COUNT, ${schema.enums.length});`);
  lines.push("    }");

  for (const entry of schema.enums) {
    lines.push("");
    lines.push("    #[test]");
    lines.push(`    fn ${testName(entry)}_round_trips() {`);
    lines.push("        let cases = [");
    for (const value of entry.values) {
      lines.push(
        `            (${entry.name}::${value.variant}, "${rustString(value.db)}", "${rustString(value.prisma)}"),`,
      );
    }
    lines.push("        ];");
    lines.push("        for (variant, db_value, prisma_value) in cases {");
    lines.push("            assert_eq!(variant.as_str(), db_value);");
    lines.push(`            assert_eq!(${entry.name}::from_db_str(db_value), Some(variant));`);
    lines.push(
      '            let encoded = serde_json::to_string(&variant).expect("enum serializes");',
    );
    lines.push('            assert_eq!(encoded, format!("\\"{prisma_value}\\""));');
    lines.push(
      `            let decoded: ${entry.name} = serde_json::from_str(&encoded).expect("enum deserializes");`,
    );
    lines.push("            assert_eq!(decoded, variant);");
    lines.push("        }");
    lines.push("    }");
  }

  lines.push("}");
  lines.push("");
  return lines.join("\n");
}

/** Render `crates/pg-types/src/generated/models.rs`. */
export function renderModels(schema: SchemaDef): string {
  const lines: string[] = [];
  lines.push(...header("Prisma row models", schema.schemaVersion));
  lines.push("// Money columns map to `rust_decimal::Decimal`; `Float` maps to `f64` and is never");
  lines.push("// allowed for money.");
  lines.push("");
  lines.push("#![allow(non_snake_case)]");
  lines.push("#![allow(clippy::struct_excessive_bools)]");
  lines.push("#![allow(clippy::struct_field_names)]");
  lines.push("#![allow(clippy::upper_case_acronyms)]");
  lines.push("");
  lines.push("use crate::generated::enums;");
  lines.push("");

  for (const model of schema.models) {
    lines.push("#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, sqlx::FromRow)]");
    lines.push('#[serde(rename_all = "camelCase")]');
    lines.push(`pub struct ${model.name} {`);
    for (const field of model.fields) {
      if (field.serdeRename !== null) {
        lines.push(`    #[serde(rename = "${rustString(field.serdeRename)}")]`);
      }
      if (field.sqlxRename !== null) {
        lines.push(`    #[sqlx(rename = "${rustString(field.sqlxRename)}")]`);
      }
      lines.push(`    pub ${field.rustName}: ${field.rustType},`);
    }
    lines.push("}");
    lines.push("");
  }

  lines.push(`pub const MODEL_COUNT: usize = ${schema.models.length};`);
  lines.push("");
  lines.push("#[cfg(test)]");
  lines.push("#[rustfmt::skip]");
  lines.push("mod tests {");
  lines.push("    use super::*;");
  lines.push("");
  lines.push("    fn assert_from_row<T>()");
  lines.push("    where");
  lines.push("        T: for<'r> sqlx::FromRow<'r, sqlx::postgres::PgRow>,");
  lines.push("    {");
  lines.push("    }");
  lines.push("");
  lines.push("    #[test]");
  lines.push("    fn model_count_matches_generated() {");
  lines.push(`        assert_eq!(MODEL_COUNT, ${schema.models.length});`);
  lines.push("    }");
  lines.push("");
  lines.push("    #[test]");
  lines.push("    fn row_structs_implement_from_row() {");
  for (const model of schema.models) {
    lines.push(`        assert_from_row::<${model.name}>();`);
  }
  lines.push("    }");
  lines.push("}");
  lines.push("");
  return lines.join("\n");
}

/** Render `crates/pg-types/src/generated/meta.rs`. */
export function renderMeta(schema: SchemaDef): string {
  const lines: string[] = [];
  lines.push(...header("Prisma table metadata", schema.schemaVersion));
  lines.push("");
  lines.push("#[derive(Debug, Clone, Copy, PartialEq, Eq)]");
  lines.push("pub struct TableMeta {");
  lines.push("    pub model: &'static str,");
  lines.push("    pub table: &'static str,");
  lines.push("    pub id_column: &'static str,");
  lines.push("    pub id_kind: IdKind,");
  lines.push("    pub updated_at_column: Option<&'static str>,");
  lines.push("    pub json_nullable_columns: &'static [&'static str],");
  lines.push("    pub default_now_columns: &'static [&'static str],");
  lines.push("}");
  lines.push("");
  lines.push("#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]");
  lines.push("pub enum IdKind {");
  lines.push("    UuidV7,");
  lines.push("    UuidV4,");
  lines.push("    Cuid,");
  lines.push("    None,");
  lines.push("}");
  lines.push("");
  lines.push(`pub const REQUIRED_SCHEMA_VERSION: u32 = ${schema.schemaVersion};`);
  lines.push(`pub const GENERATED_SCHEMA_VERSION: u32 = ${schema.schemaVersion};`);
  lines.push("");
  lines.push("#[rustfmt::skip]");
  lines.push("pub const TABLES: &[TableMeta] = &[");
  for (const model of schema.models) {
    lines.push("    TableMeta {");
    lines.push(`        model: "${rustString(model.name)}",`);
    lines.push(`        table: "${rustString(model.table)}",`);
    lines.push(`        id_column: "${rustString(model.idColumn)}",`);
    lines.push(`        id_kind: IdKind::${model.idKind},`);
    lines.push(
      `        updated_at_column: ${
        model.updatedAtColumn === null
          ? "None"
          : `Some("${rustString(model.updatedAtColumn)}")`
      },`,
    );
    lines.push(
      `        json_nullable_columns: &[${model.jsonNullableColumns
        .map((column) => `"${rustString(column)}"`)
        .join(", ")}],`,
    );
    lines.push(
      `        default_now_columns: &[${model.defaultNowColumns
        .map((column) => `"${rustString(column)}"`)
        .join(", ")}],`,
    );
    lines.push("    },");
  }
  lines.push("];");
  lines.push("");
  lines.push("#[cfg(test)]");
  lines.push("#[rustfmt::skip]");
  lines.push("mod tests {");
  lines.push("    use super::*;");
  lines.push("");
  lines.push("    #[test]");
  lines.push("    fn schema_versions_agree() {");
  lines.push("        assert_eq!(REQUIRED_SCHEMA_VERSION, GENERATED_SCHEMA_VERSION);");
  lines.push(`        assert_eq!(GENERATED_SCHEMA_VERSION, ${schema.schemaVersion});`);
  lines.push("    }");
  lines.push("");
  lines.push("    #[test]");
  lines.push("    fn table_metadata_is_unique() {");
  lines.push(`        assert_eq!(TABLES.len(), ${schema.models.length});`);
  lines.push("        let mut table_names = TABLES.iter().map(|entry| entry.table).collect::<Vec<_>>();");
  lines.push("        table_names.sort_unstable();");
  lines.push("        table_names.dedup();");
  lines.push("        assert_eq!(table_names.len(), TABLES.len());");
  lines.push("        let mut model_names = TABLES.iter().map(|entry| entry.model).collect::<Vec<_>>();");
  lines.push("        model_names.sort_unstable();");
  lines.push("        model_names.dedup();");
  lines.push("        assert_eq!(model_names.len(), TABLES.len());");
  lines.push("    }");
  lines.push("}");
  lines.push("");
  return lines.join("\n");
}

/** Render `tools/codegen/report-schema-catalog.json`. */
export function renderCatalog(schema: SchemaDef): string {
  const catalog = {
    schemaVersion: schema.schemaVersion,
    models: schema.models.map((model: ModelDef) => ({
      name: model.name,
      table: model.table,
      fields: model.fields.map((field: FieldDef) => ({
        name: field.name,
        column: field.column,
        type: catalogType(field),
        nullable: field.isNullable,
        ...(field.isList ? { list: true } : {}),
        ...(field.isEnum ? { enum: field.typeName } : {}),
      })),
    })),
    enums: schema.enums.map((entry: EnumDef) => ({
      name: entry.name,
      dbName: entry.dbName,
      values: entry.values.map((value) => ({ name: value.prisma, dbValue: value.db })),
    })),
  };

  return `${JSON.stringify(catalog, null, 2)}\n`;
}

/* ------------------------------------------------------------------------------------------------
 * Small helpers
 * ---------------------------------------------------------------------------------------------- */

/**
 * Report Studio scalar vocabulary (mirrors `CatalogColumnDef["type"]` in the TS catalog, extended
 * with `date`, `time`, `bytes` and `float`).
 */
function catalogType(field: FieldDef): string {
  if (field.isEnum) {
    return "enum";
  }
  switch (field.typeName) {
    case "String":
      return field.nativeType === "Uuid" ? "uuid" : "string";
    case "Int":
      return "int";
    case "BigInt":
      return "bigint";
    case "Float":
      return "float";
    case "Decimal":
      return "decimal";
    case "Boolean":
      return "boolean";
    case "DateTime":
      if (field.nativeType === "Date") {
        return "date";
      }
      if (field.nativeType === "Time") {
        return "time";
      }
      return "datetime";
    case "Json":
      return "json";
    case "Bytes":
      return "bytes";
    default:
      throw new Error(`internal codegen error: no catalog type for ${field.typeName}`);
  }
}

function header(subject: string, schemaVersion: number): string[] {
  return [
    "// @generated by backend-rs/tools/codegen/gen.ts from core-back/prisma/schema.prisma.",
    "// Do not edit this file by hand: run `bun backend-rs/tools/codegen/gen.ts` to regenerate.",
    `// ${subject} (Prisma schema version ${schemaVersion}).`,
  ];
}

function testName(entry: EnumDef): string {
  return entry.name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

/** Escape a value for a Rust string literal. */
function rustString(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}
