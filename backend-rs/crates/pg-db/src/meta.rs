//! Prisma-managed column metadata.
//!
//! Until P10 the generator (`tools/codegen/gen.ts`) emits one [`TableMeta`] per model; the
//! repository layer applies `updated_at = now()` and the right id kind without the database
//! defaults doing it (89 `@updatedAt` columns, 105 v7 / 6 v4 / 1 cuid).

#![forbid(unsafe_code)]

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdKind {
    UuidV7,
    UuidV4,
    Cuid,
    None,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TableMeta {
    pub model: &'static str,
    /// Physical table name (`@@map`).
    pub table: &'static str,
    pub id_column: &'static str,
    pub id_kind: IdKind,
    pub updated_at_column: Option<&'static str>,
    /// Nullable Json columns where handlers must choose SQL NULL vs JSON `null`.
    pub json_nullable_columns: &'static [&'static str],
    pub default_now_columns: &'static [&'static str],
}

impl TableMeta {
    /// Generate the id for an insert according to Prisma's default.
    #[must_use]
    pub fn new_id(&self) -> Option<String> {
        match self.id_kind {
            IdKind::UuidV7 => Some(pg_types::new_v7().to_string()),
            IdKind::UuidV4 => Some(pg_types::new_v4().to_string()),
            IdKind::Cuid => Some(pg_types::cuid()),
            IdKind::None => None,
        }
    }

    /// True when the repository must set `updated_at` explicitly.
    #[must_use]
    pub fn sets_updated_at(&self) -> bool {
        self.updated_at_column.is_some()
    }
}

/// Aggregated generated metadata.
#[derive(Debug, Clone, Default)]
pub struct PrismaMeta {
    pub tables: Vec<TableMeta>,
}

impl PrismaMeta {
    #[must_use]
    pub fn for_table(&self, table: &str) -> Option<&TableMeta> {
        self.tables.iter().find(|meta| meta.table == table)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn id_kinds_generate_the_right_shape() {
        let meta = TableMeta {
            model: "PaymentAttempt",
            table: "payment_attempts",
            id_column: "id",
            id_kind: IdKind::UuidV7,
            updated_at_column: Some("updated_at"),
            json_nullable_columns: &[],
            default_now_columns: &["created_at"],
        };
        let id = meta.new_id().expect("id");
        assert_eq!(id.len(), 36);
        assert!(meta.sets_updated_at());
    }
}
