//! The shared list contract (filters, sort, offset and keyset pagination) as SQL.
//!
//! Port of `core-back/lib/listQuery.ts` (GAP-002): `parseListQuery`, `buildListQuery`,
//! `keysetWhere`, `encodeListCursor`, `decodeListCursor`, `countUnlessSkipped`, `listResponse`.
//!
//! TS builds a Prisma `where`/`orderBy`; the Rust port builds the equivalent SQL. Everything that
//! is observable to a client is identical:
//!
//! - query parsing (`page`, `pageSize` clamp 1..200, `sortDirection`, `includeTotal`, every other
//!   key trimmed and first-value-wins);
//! - search/contains/equals/in/booleans/dates/ranges semantics (search paths OR-ed, filter keys
//!   AND-ed, dates inclusive with `to` at `23:59:59.999`);
//! - sort resolution (unknown `sortKey` silently falls back to the default sort) with `id DESC`
//!   always appended;
//! - keyset eligibility (only top-level NOT NULL columns: `createdAt`, `updatedAt`, `id` plus
//!   `keysetFields`), the opaque base64url cursor format and the `nextCursor` envelope;
//! - `includeTotal=false` skips the COUNT;
//! - an invalid cursor is ignored (falls back to OFFSET), exactly like `decodeListCursor`.
//!
//! A dot path (`status`, `createdAt`) is mapped to a SQL expression by [`ColumnMap`]; an unmapped
//! path is a programming error and fails the build instead of silently dropping a filter.

#![forbid(unsafe_code)]

use std::collections::{BTreeMap, BTreeSet};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use chrono::{DateTime, NaiveDateTime};
use rust_decimal::Decimal;
use serde_json::{json, Map, Value};
use sqlx::postgres::PgArguments;
use sqlx::query::Query;
use sqlx::Postgres;
use sqlx::Row;

use crate::error::DbError;

/// Maximum page size accepted from a client.
pub const MAX_PAGE_SIZE: f64 = 200.0;
/// Default page size when neither the request nor the spec names one.
pub const DEFAULT_PAGE_SIZE: f64 = 50.0;
/// Columns always eligible for keyset pagination.
pub const DEFAULT_KEYSET_FIELDS: [&str; 3] = ["createdAt", "updatedAt", "id"];
/// Cursor tokens above this length are rejected before JSON parsing.
pub const MAX_CURSOR_LENGTH: usize = 2_048;

/// `ListQuery` — the parsed request.
#[derive(Debug, Clone, PartialEq)]
pub struct ListQuery {
    pub page: f64,
    pub page_size: f64,
    pub sort_key: Option<String>,
    pub sort_direction: SortDirection,
    pub include_total: bool,
    pub cursor: Option<String>,
    /// Every other query key, trimmed, first occurrence wins (`asString`).
    pub values: BTreeMap<String, String>,
}

impl ListQuery {
    #[must_use]
    pub fn get(&self, key: &str) -> Option<&str> {
        self.values.get(key).map(String::as_str)
    }
}

/// A sort direction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SortDirection {
    Asc,
    Desc,
}

impl SortDirection {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Asc => "asc",
            Self::Desc => "desc",
        }
    }

    #[must_use]
    pub fn sql(self) -> &'static str {
        match self {
            Self::Asc => "ASC",
            Self::Desc => "DESC",
        }
    }

    #[must_use]
    pub fn parse(raw: &str) -> Self {
        if raw == "desc" {
            Self::Desc
        } else {
            Self::Asc
        }
    }
}

/// `asString`: arrays take the first entry, blank values are dropped.
#[must_use]
fn as_string(value: &Value) -> Option<String> {
    match value {
        Value::Array(entries) => entries.first().and_then(|entry| match entry {
            Value::String(text) if !text.trim().is_empty() => Some(text.trim().to_owned()),
            _ => None,
        }),
        Value::String(text) if !text.trim().is_empty() => Some(text.trim().to_owned()),
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(flag) => Some(flag.to_string()),
        _ => None,
    }
}

/// `parseListQuery` from a pre-parsed query map (Express `req.query` shape: repeated keys are
/// arrays).
#[must_use]
pub fn parse_list_query(raw: &Map<String, Value>) -> ListQuery {
    let page_raw = as_string(raw.get("page").unwrap_or(&Value::Null));
    let page = number_or(page_raw.as_deref(), 1.0).max(1.0);
    let page_size_raw = as_string(raw.get("pageSize").unwrap_or(&Value::Null));
    let page_size = clamp_page_size(number_or(page_size_raw.as_deref(), DEFAULT_PAGE_SIZE));
    let direction = as_string(raw.get("sortDirection").unwrap_or(&Value::Null))
        .map(|value| SortDirection::parse(&value))
        .unwrap_or(SortDirection::Asc);

    let mut values = BTreeMap::new();
    for (key, value) in raw {
        if matches!(key.as_str(), "page" | "pageSize" | "sortDirection") {
            continue;
        }
        if let Some(scalar) = as_string(value) {
            values.insert(key.clone(), scalar);
        }
    }
    let include_total = values.get("includeTotal").map(String::as_str) != Some("false");
    let sort_key = values.get("sortKey").cloned();
    let cursor = values.get("cursor").cloned();
    ListQuery {
        page,
        page_size,
        sort_key,
        sort_direction: direction,
        include_total,
        cursor,
        values,
    }
}

/// Same behaviour as `parse_list_query` but from the query-string pairs in order, keeping the
/// first value of a repeated key (Express collects repeats into an array and `asString` takes
/// `value[0]`).
#[must_use]
pub fn parse_list_query_pairs<'a, I>(pairs: I) -> ListQuery
where
    I: IntoIterator<Item = (&'a str, &'a str)>,
{
    let mut map: Map<String, Value> = Map::new();
    for (key, value) in pairs {
        map.entry(key.to_owned())
            .or_insert_with(|| Value::String(value.to_owned()));
    }
    parse_list_query(&map)
}

/// JavaScript `Number(text)` → `None` for `NaN`. `None` is falsy in TS (`|| default`).
#[must_use]
pub fn js_number(text: &str) -> Option<f64> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Some(0.0);
    }
    if trimmed.eq_ignore_ascii_case("infinity") || trimmed == "+Infinity" {
        return Some(f64::INFINITY);
    }
    if trimmed.eq_ignore_ascii_case("-infinity") {
        return Some(f64::NEG_INFINITY);
    }
    if let Some(hex) = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
    {
        return i64::from_str_radix(hex, 16).ok().map(|value| value as f64);
    }
    trimmed.parse::<f64>().ok()
}

fn number_or(text: Option<&str>, fallback: f64) -> f64 {
    match text {
        Some(text) => match js_number(text) {
            // `Number(x) || fallback`: 0 and NaN are falsy.
            Some(value) if value != 0.0 && value.is_finite() => value,
            _ => fallback,
        },
        None => fallback,
    }
}

fn clamp_page_size(value: f64) -> f64 {
    value.clamp(1.0, MAX_PAGE_SIZE)
}

/// The SQL type of a mapped column; decides the placeholder cast and how cursor values bind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColumnKind {
    Text,
    Uuid,
    Bool,
    Timestamp,
    Timestamptz,
    Decimal,
    BigInt,
    Integer,
}

impl ColumnKind {
    #[must_use]
    pub fn cast(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Uuid => "uuid",
            Self::Bool => "boolean",
            Self::Timestamp => "timestamp",
            Self::Timestamptz => "timestamptz",
            Self::Decimal => "numeric",
            Self::BigInt => "bigint",
            Self::Integer => "integer",
        }
    }
}

/// One logical field mapped to a SQL expression.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Column {
    /// A ready SQL expression, including any cast the column needs (`m.status::text`).
    pub sql: String,
    pub kind: ColumnKind,
}

impl Column {
    #[must_use]
    pub fn new(sql: impl Into<String>, kind: ColumnKind) -> Self {
        Self {
            sql: sql.into(),
            kind,
        }
    }
}

/// The path → expression map of one list endpoint.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ColumnMap {
    columns: BTreeMap<String, Column>,
}

impl ColumnMap {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    #[must_use]
    pub fn with(mut self, path: &str, sql: impl Into<String>, kind: ColumnKind) -> Self {
        self.columns.insert(path.to_owned(), Column::new(sql, kind));
        self
    }

    #[must_use]
    pub fn get(&self, path: &str) -> Option<&Column> {
        self.columns.get(path)
    }

    #[must_use]
    pub fn contains(&self, path: &str) -> bool {
        self.columns.contains_key(path)
    }

    pub fn iter(&self) -> impl Iterator<Item = (&String, &Column)> {
        self.columns.iter()
    }
}

/// A date filter (`dates` in [`ListSpec`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DateFilter {
    /// The spec key (`createdAt`) that drives the default `createdAtFrom`/`createdAtTo` names.
    pub name: String,
    pub path: String,
    pub from_key: Option<String>,
    pub to_key: Option<String>,
}

impl DateFilter {
    #[must_use]
    pub fn new(name: &str, path: &str) -> Self {
        Self {
            name: name.to_owned(),
            path: path.to_owned(),
            from_key: None,
            to_key: None,
        }
    }

    #[must_use]
    pub fn with_keys(mut self, from_key: &str, to_key: &str) -> Self {
        self.from_key = Some(from_key.to_owned());
        self.to_key = Some(to_key.to_owned());
        self
    }

    #[must_use]
    pub fn from_key(&self) -> String {
        self.from_key
            .clone()
            .unwrap_or_else(|| format!("{}From", self.name))
    }

    #[must_use]
    pub fn to_key(&self) -> String {
        self.to_key
            .clone()
            .unwrap_or_else(|| format!("{}To", self.name))
    }
}

/// The parse mode of a numeric range.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RangeKind {
    Decimal,
    Number,
}

/// A numeric range filter (`amountMin`/`amountMax`, `minScore`/`maxScore`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RangeFilter {
    pub name: String,
    pub path: String,
    pub kind: RangeKind,
}

impl RangeFilter {
    #[must_use]
    pub fn new(name: &str, path: &str, kind: RangeKind) -> Self {
        Self {
            name: name.to_owned(),
            path: path.to_owned(),
            kind,
        }
    }
}

/// The per-endpoint declaration (`ListSpec`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ListSpec {
    /// Dot paths searched with a case-insensitive `contains`, OR-ed.
    pub search: Vec<String>,
    /// Query key → dot paths; several paths OR-ed, different keys AND-ed.
    pub contains: BTreeMap<String, Vec<String>>,
    /// Query key → dot path, exact equality.
    pub equals: BTreeMap<String, String>,
    /// Query key → dot path, comma-separated `in` list.
    pub in_: BTreeMap<String, String>,
    /// Query key → dot path, `"true"`/`"false"`.
    pub booleans: BTreeMap<String, String>,
    pub dates: Vec<DateFilter>,
    pub ranges: Vec<RangeFilter>,
    /// Client sort key → dot path. Only these are accepted.
    pub sortable: BTreeMap<String, String>,
    /// Default ORDER BY terms (before the always-appended `id DESC`).
    pub default_sort: Vec<(String, SortDirection)>,
    pub default_page_size: Option<f64>,
    /// Extra top-level NOT NULL columns allowed as keyset fields.
    pub keyset_fields: Vec<String>,
}

impl ListSpec {
    #[must_use]
    pub fn with_search(mut self, paths: &[&str]) -> Self {
        self.search = paths.iter().map(|path| (*path).to_owned()).collect();
        self
    }

    #[must_use]
    pub fn with_contains(mut self, key: &str, paths: &[&str]) -> Self {
        self.contains.insert(
            key.to_owned(),
            paths.iter().map(|path| (*path).to_owned()).collect(),
        );
        self
    }

    #[must_use]
    pub fn with_equals(mut self, key: &str, path: &str) -> Self {
        self.equals.insert(key.to_owned(), path.to_owned());
        self
    }

    #[must_use]
    pub fn with_in(mut self, key: &str, path: &str) -> Self {
        self.in_.insert(key.to_owned(), path.to_owned());
        self
    }

    #[must_use]
    pub fn with_boolean(mut self, key: &str, path: &str) -> Self {
        self.booleans.insert(key.to_owned(), path.to_owned());
        self
    }

    #[must_use]
    pub fn with_date(mut self, filter: DateFilter) -> Self {
        self.dates.push(filter);
        self
    }

    #[must_use]
    pub fn with_range(mut self, filter: RangeFilter) -> Self {
        self.ranges.push(filter);
        self
    }

    #[must_use]
    pub fn with_sortable(mut self, key: &str, path: &str) -> Self {
        self.sortable.insert(key.to_owned(), path.to_owned());
        self
    }

    #[must_use]
    pub fn with_default_sort(mut self, path: &str, direction: SortDirection) -> Self {
        self.default_sort.push((path.to_owned(), direction));
        self
    }

    #[must_use]
    pub fn with_default_page_size(mut self, page_size: f64) -> Self {
        self.default_page_size = Some(page_size);
        self
    }

    #[must_use]
    pub fn with_keyset_field(mut self, path: &str) -> Self {
        self.keyset_fields.push(path.to_owned());
        self
    }
}

/// A structured SQL condition. Rendering happens against a [`ColumnMap`].
#[derive(Debug, Clone, PartialEq)]
pub enum Condition {
    /// OR over the columns with `ILIKE '%value%'`.
    Contains {
        columns: Vec<String>,
        value: String,
    },
    Equals {
        column: String,
        value: String,
    },
    In {
        column: String,
        values: Vec<String>,
    },
    Bool {
        column: String,
        value: bool,
    },
    DateRange {
        column: String,
        from: Option<NaiveDateTime>,
        to: Option<NaiveDateTime>,
    },
    Range {
        column: String,
        min: Option<Decimal>,
        max: Option<Decimal>,
    },
    Keyset {
        plan: KeysetPlan,
        values: Vec<CursorValue>,
    },
    And(Vec<Condition>),
}

/// One ORDER BY term eligible for cursor pagination.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeysetField {
    pub path: String,
    pub direction: SortDirection,
}

/// The cursor plan of a query.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeysetPlan {
    pub fields: Vec<KeysetField>,
}

/// A value inside a cursor token. The JSON shape matches TS `CursorValue`
/// (`{d}` for dates, `{n}` for decimals/bigints, plain string/number/bool otherwise).
#[derive(Debug, Clone, PartialEq)]
pub enum CursorValue {
    Text(String),
    Number(f64),
    Bool(bool),
    Date(String),
    Numeric(String),
}

impl CursorValue {
    #[must_use]
    pub fn to_json(&self) -> Value {
        match self {
            Self::Text(text) => Value::String(text.clone()),
            Self::Bool(flag) => Value::Bool(*flag),
            Self::Number(number) => js_number_value(*number),
            Self::Date(iso) => json!({ "d": iso }),
            Self::Numeric(text) => json!({ "n": text }),
        }
    }

    fn from_json(value: &Value) -> Option<Self> {
        match value {
            Value::String(text) => Some(Self::Text(text.clone())),
            Value::Bool(flag) => Some(Self::Bool(*flag)),
            Value::Number(number) => number.as_f64().map(Self::Number),
            Value::Object(map) => {
                if let Some(Value::String(iso)) = map.get("d") {
                    return Some(Self::Date(iso.clone()));
                }
                if let Some(Value::String(text)) = map.get("n") {
                    if is_decimal_text(text) {
                        return Some(Self::Numeric(text.clone()));
                    }
                }
                None
            }
            _ => None,
        }
    }

    /// Bind text for the comparison placeholder (`$n`) of a column.
    #[must_use]
    pub fn bind_text(&self) -> String {
        match self {
            Self::Text(text) | Self::Date(text) | Self::Numeric(text) => text.clone(),
            Self::Bool(flag) => flag.to_string(),
            Self::Number(number) => js_number_text(*number),
        }
    }
}

/// `^-?\d+(\.\d+)?$` from `decodeCursorValue`.
#[must_use]
pub fn is_decimal_text(text: &str) -> bool {
    let body = text.strip_prefix('-').unwrap_or(text);
    let mut parts = body.split('.');
    let Some(integer) = parts.next() else {
        return false;
    };
    if integer.is_empty() || !integer.bytes().all(|byte| byte.is_ascii_digit()) {
        return false;
    }
    match parts.next() {
        None => true,
        Some(fraction) => {
            parts.next().is_none()
                && !fraction.is_empty()
                && fraction.bytes().all(|byte| byte.is_ascii_digit())
        }
    }
}

/// JavaScript number formatting for the values a list cursor can carry (integers, scores).
#[must_use]
pub fn js_number_text(value: f64) -> String {
    if value.fract() == 0.0 && value.abs() < 1e21 {
        format!("{}", value as i64)
    } else {
        value.to_string()
    }
}

/// A JSON number that prints like JavaScript (`2.0` → `2`).
#[must_use]
pub fn js_number_value(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
        Value::from(value as i64)
    } else {
        Value::from(value)
    }
}

/// A SQL placeholder value.
#[derive(Debug, Clone, PartialEq)]
pub enum SqlBind {
    Text(String),
    Bool(bool),
}

/// A built query: the WHERE clause, its binds and the pagination.
#[derive(Debug, Clone, PartialEq)]
pub struct BuiltListQuery {
    /// `WHERE …` or empty.
    pub where_sql: String,
    pub binds: Vec<SqlBind>,
    pub order_by_sql: String,
    pub page: f64,
    pub page_size: f64,
    pub take: i64,
    pub skip: i64,
    pub keyset: Option<KeysetPlan>,
    pub cursor_applied: bool,
    pub include_total: bool,
    pub sort_applied: bool,
}

impl BuiltListQuery {
    /// `SELECT <columns> FROM <table> <where> ORDER BY <order> LIMIT $n OFFSET $m`.
    #[must_use]
    pub fn select_sql(&self, table: &str, columns: &[&str]) -> String {
        let projection = if columns.is_empty() {
            "*".to_owned()
        } else {
            columns.join(", ")
        };
        let where_clause = if self.where_sql.is_empty() {
            String::new()
        } else {
            format!(" {}", self.where_sql)
        };
        format!(
            "SELECT {projection} FROM {table}{where_clause} ORDER BY {} LIMIT ${} OFFSET ${}",
            self.order_by_sql,
            self.binds.len() + 1,
            self.binds.len() + 2
        )
    }

    /// `SELECT count(*) FROM <table> <where>` (same binds, no ORDER BY/LIMIT).
    #[must_use]
    pub fn count_sql(&self, table: &str) -> String {
        let where_clause = if self.where_sql.is_empty() {
            String::new()
        } else {
            format!(" {}", self.where_sql)
        };
        format!("SELECT count(*) FROM {table}{where_clause}")
    }

    /// Bind the WHERE values into an already-built row query.
    pub fn bind_rows<'q>(&'q self, sql: &str) -> Query<'q, Postgres, PgArguments> {
        let mut query = sqlx::query(sqlx::AssertSqlSafe(sql));
        for bind in &self.binds {
            query = match bind {
                SqlBind::Text(value) => query.bind(value.as_str()),
                SqlBind::Bool(value) => query.bind(*value),
            };
        }
        query.bind(self.take).bind(self.skip)
    }

    /// Bind the WHERE values into an already-built count query.
    pub fn bind_count<'q>(&'q self, sql: &str) -> Query<'q, Postgres, PgArguments> {
        let mut query = sqlx::query(sqlx::AssertSqlSafe(sql));
        for bind in &self.binds {
            query = match bind {
                SqlBind::Text(value) => query.bind(value.as_str()),
                SqlBind::Bool(value) => query.bind(*value),
            };
        }
        query
    }
}

/// Render a condition into SQL, collecting placeholders.
struct Renderer<'a> {
    columns: &'a ColumnMap,
    binds: Vec<SqlBind>,
}

impl Renderer<'_> {
    fn column(&self, path: &str) -> Result<Column, DbError> {
        self.columns
            .get(path)
            .cloned()
            .ok_or_else(|| DbError::InvalidFilter {
                field: path.to_owned(),
            })
    }

    fn text_placeholder(&mut self, column: Column, value: String) -> String {
        self.binds.push(SqlBind::Text(value));
        format!("${}::{}", self.binds.len(), column.kind.cast())
    }

    fn render(&mut self, condition: &Condition) -> Result<String, DbError> {
        match condition {
            Condition::Contains { columns, value } => {
                if columns.is_empty() {
                    return Ok("TRUE".to_owned());
                }
                // One pattern value shared by every searched column.
                self.binds.push(SqlBind::Text(format!("%{value}%")));
                let placeholder = format!("${}::text", self.binds.len());
                let mut clauses = Vec::with_capacity(columns.len());
                for path in columns {
                    let column = self.column(path)?;
                    clauses.push(format!("{} ILIKE {}", column.sql, placeholder));
                }
                Ok(if clauses.len() == 1 {
                    format!("({})", clauses[0])
                } else {
                    format!("({})", clauses.join(" OR "))
                })
            }
            Condition::Equals { column, value } => {
                let column = self.column(column)?;
                let placeholder = self.text_placeholder(column.clone(), value.clone());
                Ok(format!("{} = {}", column.sql, placeholder))
            }
            Condition::In { column, values } => {
                let column = self.column(column)?;
                if values.is_empty() {
                    return Ok("FALSE".to_owned());
                }
                let mut placeholders = Vec::with_capacity(values.len());
                for value in values {
                    placeholders.push(self.text_placeholder(column.clone(), value.clone()));
                }
                Ok(format!("{} IN ({})", column.sql, placeholders.join(", ")))
            }
            Condition::Bool { column, value } => {
                let column = self.column(column)?;
                self.binds.push(SqlBind::Bool(*value));
                Ok(format!("{} = ${}::boolean", column.sql, self.binds.len()))
            }
            Condition::DateRange { column, from, to } => {
                let column = self.column(column)?;
                let mut clauses = Vec::new();
                if let Some(from) = from {
                    let placeholder =
                        self.text_placeholder(column.clone(), format_timestamp(*from));
                    clauses.push(format!("{} >= {}", column.sql, placeholder));
                }
                if let Some(to) = to {
                    let placeholder = self.text_placeholder(column.clone(), format_timestamp(*to));
                    clauses.push(format!("{} <= {}", column.sql, placeholder));
                }
                if clauses.is_empty() {
                    return Ok("TRUE".to_owned());
                }
                Ok(clauses.join(" AND "))
            }
            Condition::Range { column, min, max } => {
                let column = self.column(column)?;
                let mut clauses = Vec::new();
                if let Some(min) = min {
                    let placeholder = self.text_placeholder(column.clone(), min.to_string());
                    clauses.push(format!("{} >= {}", column.sql, placeholder));
                }
                if let Some(max) = max {
                    let placeholder = self.text_placeholder(column.clone(), max.to_string());
                    clauses.push(format!("{} <= {}", column.sql, placeholder));
                }
                if clauses.is_empty() {
                    return Ok("TRUE".to_owned());
                }
                Ok(clauses.join(" AND "))
            }
            Condition::Keyset { plan, values } => self.render_keyset(plan, values),
            Condition::And(conditions) => {
                let rendered: Result<Vec<String>, DbError> =
                    conditions.iter().map(|item| self.render(item)).collect();
                let rendered = rendered?;
                if rendered.is_empty() {
                    return Ok("TRUE".to_owned());
                }
                Ok(format!("({})", rendered.join(" AND ")))
            }
        }
    }

    /// `OR_k (f1 = v1 AND … AND f(k-1) = v(k-1) AND fk (>|<) vk)`.
    fn render_keyset(
        &mut self,
        plan: &KeysetPlan,
        values: &[CursorValue],
    ) -> Result<String, DbError> {
        if values.len() != plan.fields.len() {
            return Err(DbError::InvalidCursor);
        }
        let mut branches = Vec::with_capacity(plan.fields.len());
        for index in 0..plan.fields.len() {
            let mut clauses = Vec::with_capacity(index + 1);
            for prior in 0..index {
                let field = &plan.fields[prior];
                let column = self.column(&field.path)?;
                let placeholder = self.text_placeholder(column.clone(), values[prior].bind_text());
                clauses.push(format!("{} = {}", column.sql, placeholder));
            }
            let field = &plan.fields[index];
            let column = self.column(&field.path)?;
            let placeholder = self.text_placeholder(column.clone(), values[index].bind_text());
            clauses.push(format!(
                "{} {} {}",
                column.sql,
                if field.direction == SortDirection::Asc {
                    ">"
                } else {
                    "<"
                },
                placeholder
            ));
            branches.push(format!("({})", clauses.join(" AND ")));
        }
        Ok(format!("({})", branches.join(" OR ")))
    }
}

fn format_timestamp(value: NaiveDateTime) -> String {
    value.format("%Y-%m-%dT%H:%M:%S%.3f").to_string()
}

/// `parseDate`: a bare `YYYY-MM-DD` becomes start-of-day or end-of-day; anything else is parsed
/// as an ISO instant. `None` means "no filter" (TS: an invalid date is ignored).
#[must_use]
pub fn parse_date(value: &str, end_of_day: bool) -> Option<NaiveDateTime> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let is_bare_date =
        trimmed.len() == 10 && trimmed.as_bytes()[4] == b'-' && trimmed.as_bytes()[7] == b'-';
    if is_bare_date {
        let suffix = if end_of_day {
            "T23:59:59.999"
        } else {
            "T00:00:00.000"
        };
        return NaiveDateTime::parse_from_str(
            &format!("{trimmed}{suffix}"),
            "%Y-%m-%dT%H:%M:%S%.f",
        )
        .ok();
    }
    if let Ok(parsed) = DateTime::parse_from_rfc3339(trimmed) {
        return Some(parsed.naive_utc());
    }
    for format in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%d %H:%M:%S%.f"] {
        if let Ok(parsed) = NaiveDateTime::parse_from_str(trimmed, format) {
            return Some(parsed);
        }
    }
    None
}

fn parse_decimal(field: &str, value: &str) -> Result<Decimal, DbError> {
    use std::str::FromStr;
    Decimal::from_str(value).map_err(|_| DbError::InvalidFilter {
        field: field.to_owned(),
    })
}

/// `csv`: comma-separated values, trimmed, empties dropped.
#[must_use]
pub fn csv(value: Option<&str>) -> Vec<String> {
    value
        .map(|value| {
            value
                .split(',')
                .map(str::trim)
                .filter(|entry| !entry.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

/// `encodeListCursor`: base64url(JSON) of the sort values in plan order.
#[must_use]
pub fn encode_cursor(plan: &KeysetPlan, values: &[CursorValue]) -> Option<String> {
    if values.len() != plan.fields.len() {
        return None;
    }
    let encoded: Vec<Value> = values.iter().map(CursorValue::to_json).collect();
    let text = serde_json::to_string(&encoded).ok()?;
    Some(URL_SAFE_NO_PAD.encode(text.as_bytes()))
}

/// `decodeListCursor`: `None` when the token is too long, malformed or the wrong shape.
#[must_use]
pub fn decode_cursor(plan: &KeysetPlan, token: &str) -> Option<Vec<CursorValue>> {
    if token.len() > MAX_CURSOR_LENGTH {
        return None;
    }
    let bytes = URL_SAFE_NO_PAD.decode(token).ok()?;
    let text = String::from_utf8(bytes).ok()?;
    let parsed: Value = serde_json::from_str(&text).ok()?;
    let Value::Array(entries) = parsed else {
        return None;
    };
    if entries.len() != plan.fields.len() {
        return None;
    }
    entries.iter().map(CursorValue::from_json).collect()
}

/// Build the SQL query for a request.
pub fn build_list_query(
    raw: &Map<String, Value>,
    spec: &ListSpec,
    columns: &ColumnMap,
) -> Result<BuiltListQuery, DbError> {
    let query = parse_list_query(raw);
    let mut conditions: Vec<Condition> = Vec::new();

    if !spec.search.is_empty() {
        if let Some(value) = query.get("search") {
            conditions.push(Condition::Contains {
                columns: spec.search.clone(),
                value: value.to_owned(),
            });
        }
    }
    for (key, paths) in &spec.contains {
        let Some(value) = query.get(key) else {
            continue;
        };
        if value.is_empty() {
            continue;
        }
        conditions.push(Condition::Contains {
            columns: paths.clone(),
            value: value.to_owned(),
        });
    }
    for (key, path) in &spec.equals {
        if let Some(value) = query.get(key) {
            if !value.is_empty() {
                conditions.push(Condition::Equals {
                    column: path.clone(),
                    value: value.to_owned(),
                });
            }
        }
    }
    for (key, path) in &spec.in_ {
        let values = csv(query.get(key));
        if !values.is_empty() {
            conditions.push(Condition::In {
                column: path.clone(),
                values,
            });
        }
    }
    for (key, path) in &spec.booleans {
        match query.get(key) {
            Some("true") => conditions.push(Condition::Bool {
                column: path.clone(),
                value: true,
            }),
            Some("false") => conditions.push(Condition::Bool {
                column: path.clone(),
                value: false,
            }),
            _ => {}
        }
    }
    for filter in &spec.dates {
        let from_raw = query
            .get(&filter.from_key())
            .map(str::to_owned)
            .or_else(|| {
                if filter.name == "createdAt" {
                    query.get("from").map(str::to_owned)
                } else {
                    None
                }
            });
        let to_raw = query.get(&filter.to_key()).map(str::to_owned).or_else(|| {
            if filter.name == "createdAt" {
                query.get("to").map(str::to_owned)
            } else {
                None
            }
        });
        let from = from_raw
            .as_deref()
            .and_then(|value| parse_date(value, false));
        let to = to_raw.as_deref().and_then(|value| parse_date(value, true));
        if from.is_some() || to.is_some() {
            conditions.push(Condition::DateRange {
                column: filter.path.clone(),
                from,
                to,
            });
        }
    }
    for filter in &spec.ranges {
        let min_raw = query.get(&format!("{}Min", filter.name));
        let max_raw = query.get(&format!("{}Max", filter.name));
        let min = min_raw
            .map(|value| match filter.kind {
                RangeKind::Decimal => parse_decimal(&format!("{}Min", filter.name), value),
                RangeKind::Number => parse_decimal(&format!("{}Min", filter.name), value),
            })
            .transpose()?;
        let max = max_raw
            .map(|value| match filter.kind {
                RangeKind::Decimal => parse_decimal(&format!("{}Max", filter.name), value),
                RangeKind::Number => parse_decimal(&format!("{}Max", filter.name), value),
            })
            .transpose()?;
        if min.is_some() || max.is_some() {
            conditions.push(Condition::Range {
                column: filter.path.clone(),
                min,
                max,
            });
        }
    }

    // ORDER BY: the client sort when it maps, else the default; `id DESC` is always appended.
    let sort_path = query
        .sort_key
        .as_deref()
        .and_then(|key| spec.sortable.get(key));
    let order_terms: Vec<(String, SortDirection)> = match sort_path {
        Some(path) => vec![
            (path.clone(), query.sort_direction),
            ("id".to_owned(), SortDirection::Desc),
        ],
        None => {
            let mut terms = spec.default_sort.clone();
            terms.push(("id".to_owned(), SortDirection::Desc));
            terms
        }
    };
    let mut order_parts = Vec::with_capacity(order_terms.len());
    for (path, direction) in &order_terms {
        let column = columns.get(path).ok_or_else(|| DbError::InvalidFilter {
            field: path.clone(),
        })?;
        order_parts.push(format!("{} {}", column.sql, direction.sql()));
    }
    let order_by_sql = order_parts.join(", ");

    // Keyset eligibility: every term is a top-level NOT NULL column.
    let mut allowed: BTreeSet<&str> = DEFAULT_KEYSET_FIELDS.iter().copied().collect();
    for field in &spec.keyset_fields {
        allowed.insert(field.as_str());
    }
    let mut keyset_fields = Vec::with_capacity(order_terms.len());
    let mut keysetable = true;
    for (path, direction) in &order_terms {
        if path.contains('.') || !allowed.contains(path.as_str()) {
            keysetable = false;
            break;
        }
        keyset_fields.push(KeysetField {
            path: path.clone(),
            direction: *direction,
        });
    }
    let keyset = if keysetable && !keyset_fields.is_empty() {
        Some(KeysetPlan {
            fields: keyset_fields,
        })
    } else {
        None
    };

    let cursor_values = match (&keyset, query.cursor.as_deref()) {
        (Some(plan), Some(token)) => decode_cursor(plan, token),
        _ => None,
    };

    // Pagination. `pageSize` explicitly sent wins; otherwise the spec default applies.
    let page_size = query.page_size;
    let raw_page_size = raw.get("pageSize").and_then(as_string);
    let page_size = if raw_page_size.is_some() {
        page_size
    } else {
        spec.default_page_size.map_or(page_size, clamp_page_size)
    };
    let take = page_size.round().max(1.0) as i64;

    let effective_conditions = if let (Some(plan), Some(values)) = (&keyset, cursor_values.clone())
    {
        let mut with_cursor = conditions.clone();
        with_cursor.push(Condition::Keyset {
            plan: plan.clone(),
            values,
        });
        Condition::And(with_cursor)
    } else {
        Condition::And(conditions)
    };

    let mut renderer = Renderer {
        columns,
        binds: Vec::new(),
    };
    let rendered = renderer.render(&effective_conditions)?;
    let where_sql = if rendered == "TRUE" {
        String::new()
    } else {
        format!("WHERE {rendered}")
    };

    let cursor_applied = cursor_values.is_some();
    let skip = if cursor_applied {
        0
    } else {
        ((query.page - 1.0) * page_size).round().max(0.0) as i64
    };

    Ok(BuiltListQuery {
        where_sql,
        binds: renderer.binds,
        order_by_sql,
        page: query.page,
        page_size,
        take,
        skip,
        keyset,
        cursor_applied,
        include_total: query.include_total,
        sort_applied: sort_path.is_some(),
    })
}

/// `countUnlessSkipped`: the COUNT is skipped when the client sent `includeTotal=false`.
pub async fn count_unless_skipped(
    built: &BuiltListQuery,
    table: &str,
    pool: &sqlx::PgPool,
) -> Result<Option<i64>, DbError> {
    if !built.include_total {
        return Ok(None);
    }
    let sql = built.count_sql(table);
    let count: i64 = built
        .bind_count(&sql)
        .fetch_one(pool)
        .await?
        .get::<i64, _>(0);
    Ok(Some(count))
}

/// `listResponse`: `{<key>, total, page, pageSize, nextCursor?}`.
#[must_use]
pub fn list_response(
    key: &str,
    rows: Value,
    total: Option<i64>,
    built: &BuiltListQuery,
    source_rows: &[Vec<CursorValue>],
) -> Value {
    let mut response = Map::new();
    response.insert(key.to_owned(), rows);
    response.insert("total".to_owned(), total.map_or(Value::Null, Value::from));
    response.insert("page".to_owned(), js_number_value(built.page));
    response.insert("pageSize".to_owned(), js_number_value(built.page_size));
    if let Some(plan) = &built.keyset {
        let full_page = source_rows.len() as f64 >= built.page_size;
        if full_page {
            if let Some(last) = source_rows.last() {
                if let Some(cursor) = encode_cursor(plan, last) {
                    response.insert("nextCursor".to_owned(), Value::String(cursor));
                }
            }
        }
    }
    Value::Object(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(pairs: &[(&str, &str)]) -> Map<String, Value> {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_owned(), Value::String((*value).to_owned())))
            .collect()
    }

    fn columns() -> ColumnMap {
        ColumnMap::new()
            .with("id", "m.id", ColumnKind::Uuid)
            .with("legalName", "m.legal_name", ColumnKind::Text)
            .with("status", "m.status::text", ColumnKind::Text)
            .with("riskTier", "m.risk_tier::text", ColumnKind::Text)
            .with("createdAt", "m.created_at", ColumnKind::Timestamp)
            .with("updatedAt", "m.updated_at", ColumnKind::Timestamp)
            .with("active", "m.active", ColumnKind::Bool)
    }

    fn spec() -> ListSpec {
        ListSpec::default()
            .with_search(&["legalName", "status"])
            .with_equals("status", "status")
            .with_in("riskTier", "riskTier")
            .with_boolean("active", "active")
            .with_date(DateFilter::new("createdAt", "createdAt"))
            .with_sortable("createdAt", "createdAt")
            .with_sortable("legalName", "legalName")
            .with_default_sort("createdAt", SortDirection::Desc)
    }

    #[test]
    fn parsing_matches_the_ts_defaults_and_clamps() {
        let query = parse_list_query(&map(&[]));
        assert_eq!(query.page, 1.0);
        assert_eq!(query.page_size, 50.0);
        assert_eq!(query.sort_direction, SortDirection::Asc);
        assert!(query.include_total);

        let query = parse_list_query(&map(&[
            ("page", "0"),
            ("pageSize", "5000"),
            ("sortDirection", "desc"),
            ("includeTotal", "false"),
            ("search", "  acme  "),
        ]));
        assert_eq!(query.page, 1.0, "page 0 falls back to 1");
        assert_eq!(query.page_size, 200.0, "pageSize is clamped to 200");
        assert_eq!(query.sort_direction, SortDirection::Desc);
        assert!(!query.include_total);
        assert_eq!(query.get("search"), Some("acme"));

        let query = parse_list_query(&map(&[("page", "abc"), ("pageSize", "0")]));
        assert_eq!(query.page, 1.0);
        // `Number("0") || 50` is 50 in TS: zero is falsy.
        assert_eq!(query.page_size, 50.0);
    }

    #[test]
    fn repeated_query_keys_keep_the_first_value() {
        let query = parse_list_query_pairs([("status", "ACTIVE"), ("status", "SUSPENDED")]);
        assert_eq!(query.get("status"), Some("ACTIVE"));
    }

    #[test]
    fn build_renders_filters_sort_and_pagination() {
        let built = build_list_query(
            &map(&[
                ("search", "acme"),
                ("status", "ACTIVE"),
                ("riskTier", "LOW,HIGH"),
                ("active", "true"),
                ("from", "2026-01-01"),
                ("to", "2026-01-31"),
                ("sortKey", "legalName"),
                ("sortDirection", "asc"),
                ("page", "2"),
                ("pageSize", "25"),
            ]),
            &spec(),
            &columns(),
        )
        .expect("build");

        assert!(built.sort_applied);
        assert!(!built.cursor_applied);
        assert_eq!(built.take, 25);
        assert_eq!(built.skip, 25);
        assert_eq!(built.order_by_sql, "m.legal_name ASC, m.id DESC");
        assert!(built
            .where_sql
            .contains("m.legal_name ILIKE $1::text OR m.status::text ILIKE $1::text"));
        assert!(built.where_sql.contains("m.status::text = $2::text"));
        assert!(built
            .where_sql
            .contains("m.risk_tier::text IN ($3::text, $4::text)"));
        assert!(built.where_sql.contains("m.active = $5::boolean"));
        assert!(built.where_sql.contains("m.created_at >= $6::timestamp"));
        assert!(built.where_sql.contains("m.created_at <= $7::timestamp"));
        assert_eq!(
            built.binds[5],
            SqlBind::Text("2026-01-01T00:00:00.000".to_owned())
        );
        assert_eq!(
            built.binds[6],
            SqlBind::Text("2026-01-31T23:59:59.999".to_owned())
        );
        assert_eq!(
            built.select_sql(
                "merchants m",
                &["m.id", "m.created_at", "m.legal_name", "m.status::text"]
            ),
            format!(
                "SELECT m.id, m.created_at, m.legal_name, m.status::text FROM merchants m {} ORDER BY m.legal_name ASC, m.id DESC LIMIT $8 OFFSET $9",
                built.where_sql
            )
        );
    }

    #[test]
    fn unknown_sort_key_falls_back_to_the_default_sort() {
        let built = build_list_query(
            &map(&[("sortKey", "secretColumn"), ("sortDirection", "desc")]),
            &spec(),
            &columns(),
        )
        .expect("build");
        assert!(!built.sort_applied);
        assert_eq!(built.order_by_sql, "m.created_at DESC, m.id DESC");
        assert!(built.where_sql.is_empty());
        assert_eq!(built.keyset.as_ref().map(|plan| plan.fields.len()), Some(2));
    }

    #[test]
    fn default_page_size_applies_when_the_client_sent_none() {
        let spec = spec().with_default_page_size(25.0);
        let built = build_list_query(&map(&[]), &spec, &columns()).expect("build");
        assert_eq!(built.page_size, 25.0);
        assert_eq!(built.take, 25);
    }

    #[test]
    fn cursor_round_trip_is_base64url_json() {
        let plan = KeysetPlan {
            fields: vec![
                KeysetField {
                    path: "createdAt".to_owned(),
                    direction: SortDirection::Desc,
                },
                KeysetField {
                    path: "id".to_owned(),
                    direction: SortDirection::Desc,
                },
            ],
        };
        let values = vec![
            CursorValue::Date("2026-01-02T03:04:05.006Z".to_owned()),
            CursorValue::Text("00000000-0000-4000-8000-000000000001".to_owned()),
        ];
        let token = encode_cursor(&plan, &values).expect("cursor");
        assert!(!token.contains('='), "base64url without padding");
        // Same bytes TS produces: `Buffer.from(JSON.stringify(values)).toString("base64url")`.
        let decoded =
            String::from_utf8(URL_SAFE_NO_PAD.decode(&token).expect("decode")).expect("utf8");
        assert_eq!(
            decoded,
            r#"[{"d":"2026-01-02T03:04:05.006Z"},"00000000-0000-4000-8000-000000000001"]"#
        );
        assert_eq!(decode_cursor(&plan, &token), Some(values));
    }

    #[test]
    fn invalid_cursors_are_ignored() {
        let plan = KeysetPlan {
            fields: vec![KeysetField {
                path: "id".to_owned(),
                direction: SortDirection::Desc,
            }],
        };
        assert_eq!(decode_cursor(&plan, "not-base64!!"), None);
        assert_eq!(decode_cursor(&plan, &"A".repeat(3000)), None);
        let wrong_length = URL_SAFE_NO_PAD.encode(br#"["a","b"]"#);
        assert_eq!(decode_cursor(&plan, &wrong_length), None);
    }

    #[test]
    fn cursor_pagination_replaces_the_offset() {
        let plan = KeysetPlan {
            fields: vec![
                KeysetField {
                    path: "createdAt".to_owned(),
                    direction: SortDirection::Desc,
                },
                KeysetField {
                    path: "id".to_owned(),
                    direction: SortDirection::Desc,
                },
            ],
        };
        let cursor = encode_cursor(
            &plan,
            &[
                CursorValue::Date("2026-01-02T00:00:00.000Z".to_owned()),
                CursorValue::Text("00000000-0000-4000-8000-000000000009".to_owned()),
            ],
        )
        .expect("cursor");
        let built = build_list_query(
            &map(&[("cursor", &cursor), ("page", "40"), ("pageSize", "10")]),
            &spec(),
            &columns(),
        )
        .expect("build");
        assert!(built.cursor_applied);
        assert_eq!(built.skip, 0, "a cursor replaces OFFSET");
        assert_eq!(built.take, 10);
        assert!(built.where_sql.contains("m.created_at < $1::timestamp"));
        assert!(built
            .where_sql
            .contains("m.created_at = $2::timestamp AND m.id < $3::uuid"));
    }

    #[test]
    fn list_response_carries_the_next_cursor_only_on_a_full_page() {
        let built = BuiltListQuery {
            where_sql: String::new(),
            binds: Vec::new(),
            order_by_sql: "m.id DESC".to_owned(),
            page: 1.0,
            page_size: 2.0,
            take: 2,
            skip: 0,
            keyset: Some(KeysetPlan {
                fields: vec![KeysetField {
                    path: "id".to_owned(),
                    direction: SortDirection::Desc,
                }],
            }),
            cursor_applied: false,
            include_total: true,
            sort_applied: false,
        };
        let row = vec![CursorValue::Text(
            "00000000-0000-4000-8000-000000000002".to_owned(),
        )];
        let response = list_response("merchants", json!([]), Some(7), &built, &[row.clone(), row]);
        assert_eq!(response["total"], json!(7));
        assert_eq!(response["page"], json!(1));
        assert_eq!(response["pageSize"], json!(2));
        assert!(response["nextCursor"].is_string());

        let short = list_response("merchants", json!([]), None, &built, &[]);
        assert_eq!(short["total"], Value::Null);
        assert!(short.get("nextCursor").is_none());
    }

    #[test]
    fn date_parsing_accepts_bare_dates_and_offsets() {
        assert_eq!(
            parse_date("2026-01-31", true),
            NaiveDateTime::parse_from_str("2026-01-31T23:59:59.999", "%Y-%m-%dT%H:%M:%S%.f").ok()
        );
        assert_eq!(
            parse_date("2026-01-01T10:00:00+02:00", false),
            NaiveDateTime::parse_from_str("2026-01-01T08:00:00", "%Y-%m-%dT%H:%M:%S").ok()
        );
        assert_eq!(parse_date("yesterday", false), None);
    }

    #[test]
    fn inconsistent_dates_are_ignored() {
        let built =
            build_list_query(&map(&[("from", "not-a-date")]), &spec(), &columns()).expect("build");
        assert!(built.where_sql.is_empty());
    }

    #[test]
    fn numeric_ranges_reject_non_numbers() {
        let spec = spec().with_range(RangeFilter::new("amount", "amount", RangeKind::Decimal));
        let columns = columns().with("amount", "m.amount", ColumnKind::Decimal);
        let error = build_list_query(&map(&[("amountMin", "abc")]), &spec, &columns)
            .expect_err("invalid decimal");
        assert!(matches!(error, DbError::InvalidFilter { .. }));
    }

    #[test]
    fn keyset_is_unavailable_for_relation_or_other_columns() {
        let spec = spec().with_sortable("status", "status");
        let built =
            build_list_query(&map(&[("sortKey", "status")]), &spec, &columns()).expect("build");
        assert!(built.sort_applied);
        assert_eq!(built.keyset, None, "nullable/categorical sorts use OFFSET");
    }

    #[test]
    fn mapped_paths_must_exist() {
        let spec = spec().with_equals("status", "missing");
        let error = build_list_query(&map(&[("status", "ACTIVE")]), &spec, &columns())
            .expect_err("unmapped path");
        assert!(matches!(error, DbError::InvalidFilter { field } if field == "missing"));
    }

    #[test]
    fn decimal_text_matches_the_ts_regex() {
        for value in ["0", "12", "-3.5", "0.0001"] {
            assert!(is_decimal_text(value), "{value}");
        }
        for value in ["", "1e5", ".5", "5.", "1.2.3", "abc"] {
            assert!(!is_decimal_text(value), "{value}");
        }
    }
}
