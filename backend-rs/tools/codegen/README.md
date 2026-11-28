# Prisma codegen for the Rust workspace (P0-T05)

`gen.ts` reads the Prisma schema text and emits the Rust surface that must stay in lock-step with
the TypeScript core:

| Output | Purpose |
| :--- | :--- |
| `backend-rs/crates/pg-types/src/generated/enums.rs` | One Rust enum per Prisma enum, with `sqlx::Type` + serde mappings, `as_str` / `from_db_str`, and round-trip tests. |
| `backend-rs/crates/pg-types/src/generated/models.rs` | One `sqlx::FromRow` row struct per Prisma model (scalar fields only). |
| `backend-rs/crates/pg-types/src/generated/meta.rs` | `TableMeta` per table (`id_kind`, `updated_at_column`, nullable Json columns, `now()` defaults) and the schema version constants. |
| `backend-rs/tools/codegen/report-schema-catalog.json` | Model/field/enum catalogue for Report Studio (P8), replacing runtime parsing of `schema.prisma`. |

The schema version in `core-back/prisma/schemaVersion.ts` is copied into `meta.rs`, so a schema
bump without regenerating is detected.

## Commands

```bash
# Regenerate all four files in place.
bun backend-rs/tools/codegen/gen.ts

# CI: regenerate in memory, compare with the committed files, exit 1 on drift.
bun backend-rs/tools/codegen/gen.ts --check

# Show usage.
bun backend-rs/tools/codegen/gen.ts --help
```

`--check` prints the relative paths of the files that are stale. It has no side effects.

The generator is deliberately dependency-free (Bun + `node:fs`/`node:path` only). It does **not**
use `@prisma/internals`; `core-back` does not install it, and adding a dependency would break the
"no new dependencies" rule.

## Determinism

- Enums and models appear in schema declaration order; fields appear in column order. Nothing is
  sorted.
- No timestamps, no random bytes, no environment reads, no absolute paths in the output.
- A fixed header names the generator and the Prisma schema version.
- `--check` compares the exact bytes, so any drift (including a schema-version bump) fails CI.
- Generated Rust is formatted in rustfmt's style; `#[rustfmt::skip]` is used only for the large
  `TABLES` literal and the generated test modules, which contain deliberately long fixture lines.
  `cargo fmt --check` therefore leaves the files untouched.

Do not hand-edit the generated files. Change `schema.prisma`, then run the generator.

## What the parser understands

The parser is small and strict. It handles exactly what `core-back/prisma/schema.prisma` uses and
fails loudly on anything else rather than silently dropping a model or column.

- `enum Name { ... }`, including `@@map("db_type")` and per-value `@map("DB_VALUE")`.
- `model Name { ... }`, including `@@map("table")`, `@@id([...])`, `@@index`/`@@unique` (skipped),
  field `@map("column")`, `?`, `[]`, `@id`, `@unique`, `@updatedAt`, `@default(...)`,
  `@relation(...)` (the relation field itself is skipped), and `@db.*` native types.
- Comments (`//`, `///`, `/* ... */`) are removed outside string literals.
- `datasource` and `generator` blocks are ignored. Prisma `view` and `type` blocks are rejected with
  an explicit error: supporting them silently would make the generated table list incomplete.
- Relations are detected by type name against the model set, so a field whose type is another model
  is never emitted (including self-relations and relation lists). The foreign-key scalar field is
  emitted normally.

Anything the parser does not recognise (an unknown field type, an unknown native type, an unknown
enum attribute, a malformed block) is an error that names the model/field.

## Enums

Variant names are the Prisma value converted to UpperCamelCase (`PARTIALLY_REFUNDED` →
`PartiallyRefunded`; `P1` stays `P1`; an already-CamelCase value keeps its inner capitals).

- `#[sqlx(type_name = "<db enum name>")]` uses `@@map` when present, otherwise the Prisma name.
- `#[sqlx(rename = "<db value>")]` is emitted when the DB label differs from the Rust variant.
- `#[serde(rename = "<Prisma value>")]` is emitted when the Prisma value differs from the variant.
- `as_str()` returns the **DB** label (the value SQL writes/reads); `from_db_str()` accepts it.
- `ENUM_COUNT` is the number of generated enums.
- The generated test module asserts `ENUM_COUNT`, and for every value checks `as_str` →
  `from_db_str` round-trip plus serde round-trip (serialise to the Prisma JSON value, deserialise
  back).

## Models and the Rust type mapping

A struct is emitted for every model that has at least one scalar/enum field. A model with no such
field is an error (the current schema has none). Relation fields are skipped, so a struct never
contains another model.

| Prisma | Native type | Rust |
| :--- | :--- | :--- |
| `String` | `@db.Uuid` | `uuid::Uuid` |
| `String` | `@db.VarChar`, `@db.Char`, `@db.Text`, none | `String` |
| `Int` | `@db.SmallInt`, `@db.Integer`, none | `i32` |
| `BigInt` | `@db.BigInt`, none | `i64` |
| `Float` | `@db.DoublePrecision`, `@db.Real`, none | `f64` (see below) |
| `Decimal` | `@db.Decimal(...)` | `rust_decimal::Decimal` |
| `Boolean` | none | `bool` |
| `DateTime` | `@db.Timestamptz` | `chrono::DateTime<chrono::Utc>` |
| `DateTime` | `@db.Date` | `chrono::NaiveDate` |
| `DateTime` | `@db.Time` | `chrono::NaiveTime` |
| `DateTime` | `@db.Timestamp`, none | `chrono::NaiveDateTime` |
| `Json` | `@db.Json`, `@db.JsonB`, none | `serde_json::Value` |
| `Bytes` | `@db.ByteA`, none | `Vec<u8>` |
| enum `E` | none | `enums::E` |

`T[]` becomes `Vec<T>`; `T?` becomes `Option<T>`. Lists are never optional in Prisma, so
`Vec<Option<T>>` is not generated.

**Money.** `Decimal` is always `rust_decimal::Decimal`. `Float` maps to `f64`, but the generator
rejects a `Float` field whose name looks like money (`amount`, `balance`, `fee`, `commission`,
`volume`, `total`, `net`, `price`, `rate`). The current schema has **zero** `Float` columns, so no
money value goes through `f64`.

**Serde.** Every struct has `#[serde(rename_all = "camelCase")]`. A field whose Prisma name differs
from the camelCase form gets an explicit `#[serde(rename = "<Prisma name>")]`; a Rust-keyword field
(`r#type`) also gets an explicit rename. JSON therefore always uses the Prisma field names the TS
API uses.

**sqlx.** Every field whose DB column differs from the Prisma field name gets
`#[sqlx(rename = "<column>")]`. `sqlx::FromRow` strips `r#` from raw identifiers, so
`pub r#type` reads the `type` column. The generated test module proves that every struct implements
`FromRow`.

## `meta.rs`

```rust
pub struct TableMeta {
    pub model: &'static str,
    pub table: &'static str,
    pub id_column: &'static str,
    pub id_kind: IdKind,
    pub updated_at_column: Option<&'static str>,
    pub json_nullable_columns: &'static [&'static str],
    pub default_now_columns: &'static [&'static str],
}

pub enum IdKind {
    UuidV7,
    UuidV4,
    Cuid,
    None,
}
```

- `TABLES` keeps schema model order.
- `updated_at_column` is the single `@updatedAt` column, if any. The repository layer sets it
  explicitly (the TS/Prisma behaviour).
- `json_nullable_columns` lists `Json?` columns where a handler must choose SQL `NULL`
  (`Prisma.DbNull`) versus JSON `null` (`Prisma.JsonNull`). Non-null `Json` columns are not listed.
- `default_now_columns` lists columns with `@default(now())`. Some have a database default and some
  do not; the repository layer treats this as "Rust must supply `now()` when Prisma would".
- `REQUIRED_SCHEMA_VERSION` and `GENERATED_SCHEMA_VERSION` both come from
  `core-back/prisma/schemaVersion.ts`.

### `IdKind` detection

- Single `@id` with `@default(uuid(7))` → `UuidV7`.
- Single `@id` with `@default(uuid())`, `uuid(4)` → `UuidV4`.
- Single `@id` with `@default(cuid())` → `Cuid`.
- Single `@id` with `@default(autoincrement())`, `@default(dbgenerated(...))`, a literal default or
  no default → `None` (the database or caller supplies it).
- Composite `@@id([...])`: if exactly one member has a generated uuid/cuid default, that member
  supplies `id_column`/`id_kind` (this is how `journal_lines.id` stays `UuidV7` even though its
  primary key is `(id, created_at)`). Otherwise `id_column` is the comma-joined column list of the
  composite key and `id_kind` is `None`.
- A model with no `@id` and no `@@id` is an error.
- `new_id()` is **not** duplicated here; `pg-db::meta::TableMeta` owns the helper. This file only
  exposes the data.

## `report-schema-catalog.json`

```json
{
  "schemaVersion": 46,
  "models": [
    {
      "name": "Merchant",
      "table": "merchants",
      "fields": [
        { "name": "id", "column": "id", "type": "uuid", "nullable": false },
        { "name": "status", "column": "status", "type": "enum", "nullable": false, "enum": "MerchantStatus" }
      ]
    }
  ],
  "enums": [
    { "name": "MerchantStatus", "dbName": "MerchantStatus", "values": [{ "name": "ACTIVE", "dbValue": "ACTIVE" }] }
  ]
}
```

- `models` and their `fields` are in schema order. Relation fields are omitted; the foreign-key
  column is present as a scalar.
- `type` is the Report Studio scalar vocabulary used by the TS catalogue
  (`core-back/lib/reportEngineSdk/types/hostConfig.ts`): `uuid`, `string`, `int`, `bigint`,
  `decimal`, `boolean`, `datetime`, `date`, `time`, `json`, `bytes`, `float`, `enum`.
- `enum` is the enum name when `type` is `enum`; the full enum definition is in `enums`.
- `list: true` marks `T[]`. `nullable` is the `T?`/nullable flag. Lists are not nullable.
- This file is intentionally JSON (not Rust) so the future `pg-report-engine` can embed it without
  duplicating the Prisma reader.

## Known limitations / approximations

- **No `@prisma/internals`.** The schema is parsed as text. The parser is strict and covers the
  current schema; an unsupported construct fails the build instead of being skipped. After P10 the
  plan switches this generator to database introspection (`core-rs schema codegen`).
- **Composite primary keys** use the rule above. `id_column` for a pure composite key is a
  comma-joined column list (`"gl_account_id,shard_id"`), not a single column, so callers must not
  treat it as one column; `id_kind` is `None`.
- **Decimal precision/scale** is not represented in the Rust type (all `Decimal`) or in the
  catalogue; `@db.Decimal(p,s)` only validates the native-type mapping.
- **Native type precision** (`VarChar(n)`, `Char(n)`, `Timestamptz(3)`, `Decimal(p,s)`) is not
  carried into the generated Rust types or catalogue. The Rust types are more permissive; the
  database columns still enforce the limits.
- **`Float`** is unused today. If one is added, it maps to `f64`; money-like names are rejected so a
  future column cannot silently introduce binary floating point into money.
- **`view` / `type` Prisma blocks** are unsupported and fail the generator. There are none today.
- **Serde on the row structs is structural**: it reproduces the Prisma field names, enum values and
  nullability, but not the handler-level wire formats. Use `pg_types::JsDate`, `Money4` and
  `DecimalJs` at the HTTP boundary where chapter 2 §12/§13 requires the exact TS string form.
- **`@ignore`** is not used by the schema. A field marked `@ignore` would currently still be
  emitted; add support here if the schema starts using it.
- **Enum value collisions**: two Prisma values that normalise to the same Rust variant, or two DB
  labels that are identical, fail the generator. Prisma should reject those first, but the codegen
  does not rely on it.

## References

- Design: `design/14-rust-port/03_target_architecture.md` §5 (codegen) and
  `design/14-rust-port/02_contracts_reference.md` §13 (JSON/dates/ids) and §18 (Prisma behaviours).
- Tracker: `backend-rs/IMPLEMENTATION_TRACKER.md` P0-T05.
- Schema: `core-back/prisma/schema.prisma`, `core-back/prisma/schemaVersion.ts`.
