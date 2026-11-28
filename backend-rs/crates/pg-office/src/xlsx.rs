//! XLSX workbook structure.
//!
//! Port of the `XlsxWorkbookSchema` types in `core-back/engine/compliance/reporting/types.ts`
//! and `core-back/lib/xlsx/regulatoryWorkbook.ts` (structure only; `rust_xlsxwriter` rendering is
//! a later P8-T03 step).
//!
//! Money stays exact: a numeric cell carries its decimal **string** (`"1500.0000"`), never an
//! `f64`. The renderer writes it as a number with the declared number format.

#![forbid(unsafe_code)]

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::error::OfficeError;

/// `schemaVersion`.
pub const XLSX_SCHEMA_VERSION: u8 = 1;
/// The maximum Excel sheet-name length.
pub const MAX_SHEET_NAME_CHARS: usize = 31;

/// `XlsxColumn.type`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum XlsxColumnType {
    /// `string`.
    #[serde(rename = "string")]
    Text,
    /// `number` (a decimal string in a [`XlsxCell`]).
    #[serde(rename = "number")]
    Number,
    /// `date` (`YYYY-MM-DD`).
    #[serde(rename = "date")]
    Date,
    /// `boolean`.
    #[serde(rename = "boolean")]
    Boolean,
    /// `list` (validated against [`XlsxColumn::list`]).
    #[serde(rename = "list")]
    List,
}

impl XlsxColumnType {
    /// The wire value.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Text => "string",
            Self::Number => "number",
            Self::Date => "date",
            Self::Boolean => "boolean",
            Self::List => "list",
        }
    }

    /// True for numeric columns (the only columns a total may target).
    #[must_use]
    pub const fn is_numeric(self) -> bool {
        matches!(self, Self::Number)
    }
}

/// `XlsxColumn`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct XlsxColumn {
    pub key: String,
    pub header: String,
    #[serde(rename = "type")]
    pub kind: XlsxColumnType,
    #[serde(default)]
    pub required: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub number_format: Option<String>,
    /// Allowed values for a `list` column.
    #[serde(default)]
    pub list: Vec<String>,
}

impl XlsxColumn {
    /// A column with a key, header and type.
    #[must_use]
    pub fn new(key: impl Into<String>, header: impl Into<String>, kind: XlsxColumnType) -> Self {
        Self {
            key: key.into(),
            header: header.into(),
            kind,
            required: false,
            width: None,
            number_format: None,
            list: Vec::new(),
        }
    }

    /// Marks the column as required.
    #[must_use]
    pub fn required(mut self) -> Self {
        self.required = true;
        self
    }

    /// Sets the list of allowed values (`XlsxColumnType::List`).
    #[must_use]
    pub fn allowed_values<S: Into<String>>(mut self, values: impl IntoIterator<Item = S>) -> Self {
        self.list = values.into_iter().map(Into::into).collect();
        self
    }
}

/// `XlsxColumn.type` of a cell value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum XlsxCellKind {
    /// A string.
    #[serde(rename = "text")]
    Text,
    /// A decimal string.
    #[serde(rename = "number")]
    Number,
    /// An ISO date.
    #[serde(rename = "date")]
    Date,
    /// A boolean (`"true"`/`"false"`).
    #[serde(rename = "boolean")]
    Boolean,
    /// No value (the cell is omitted).
    #[serde(rename = "empty")]
    Empty,
}

/// One cell. The value is always text so money never becomes a float.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct XlsxCell {
    pub kind: XlsxCellKind,
    #[serde(default)]
    pub text: String,
}

impl XlsxCell {
    /// A text cell.
    #[must_use]
    pub fn text(value: impl Into<String>) -> Self {
        Self {
            kind: XlsxCellKind::Text,
            text: value.into(),
        }
    }

    /// A numeric cell holding an exact decimal string.
    #[must_use]
    pub fn number(value: impl Into<String>) -> Self {
        Self {
            kind: XlsxCellKind::Number,
            text: value.into(),
        }
    }

    /// A date cell holding `YYYY-MM-DD`.
    #[must_use]
    pub fn date(value: impl Into<String>) -> Self {
        Self {
            kind: XlsxCellKind::Date,
            text: value.into(),
        }
    }

    /// A boolean cell.
    #[must_use]
    pub fn boolean(value: bool) -> Self {
        Self {
            kind: XlsxCellKind::Boolean,
            text: value.to_string(),
        }
    }

    /// An empty cell.
    #[must_use]
    pub fn empty() -> Self {
        Self {
            kind: XlsxCellKind::Empty,
            text: String::new(),
        }
    }

    /// True for an empty or whitespace-only cell.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.kind == XlsxCellKind::Empty || self.text.trim().is_empty()
    }
}

/// One row, keyed by column key.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct XlsxRow {
    #[serde(default)]
    pub values: BTreeMap<String, XlsxCell>,
}

impl XlsxRow {
    /// An empty row.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Sets one cell.
    #[must_use]
    pub fn with(mut self, column: impl Into<String>, cell: XlsxCell) -> Self {
        self.values.insert(column.into(), cell);
        self
    }

    /// The cell for a column, when present.
    #[must_use]
    pub fn get(&self, column: &str) -> Option<&XlsxCell> {
        self.values.get(column)
    }
}

/// `XlsxTotals.function` (only `sum` is defined).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TotalFunction {
    /// `sum`.
    #[serde(rename = "sum")]
    Sum,
}

/// A totals row entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct XlsxTotal {
    pub column: String,
    pub function: TotalFunction,
}

impl XlsxTotal {
    /// A `sum` total on `column`.
    #[must_use]
    pub fn sum(column: impl Into<String>) -> Self {
        Self {
            column: column.into(),
            function: TotalFunction::Sum,
        }
    }
}

/// `XlsxSheet`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct XlsxSheet {
    pub name: String,
    pub order: u32,
    pub columns: Vec<XlsxColumn>,
    #[serde(default)]
    pub rows: Vec<XlsxRow>,
    #[serde(default)]
    pub totals: Vec<XlsxTotal>,
}

impl XlsxSheet {
    /// A sheet with a name and its columns.
    #[must_use]
    pub fn new(name: impl Into<String>, order: u32, columns: Vec<XlsxColumn>) -> Self {
        Self {
            name: name.into(),
            order,
            columns,
            rows: Vec::new(),
            totals: Vec::new(),
        }
    }

    /// Finds a column by key.
    #[must_use]
    pub fn column(&self, key: &str) -> Option<&XlsxColumn> {
        self.columns.iter().find(|column| column.key == key)
    }

    /// Rows whose required columns are all populated.
    #[must_use]
    pub fn missing_required_cells(&self) -> Vec<(usize, &str)> {
        let mut missing = Vec::new();
        for (index, row) in self.rows.iter().enumerate() {
            for column in self.columns.iter().filter(|column| column.required) {
                let empty = row.get(&column.key).is_none_or(XlsxCell::is_empty);
                if empty {
                    missing.push((index, column.key.as_str()));
                }
            }
        }
        missing
    }

    /// Structural validation before rendering.
    ///
    /// # Errors
    /// [`OfficeError`] for an unusable sheet definition.
    pub fn validate(&self) -> Result<(), OfficeError> {
        validate_sheet_name(&self.name)?;
        let mut keys: Vec<&str> = Vec::new();
        for column in &self.columns {
            if column.key.trim().is_empty() || keys.contains(&column.key.as_str()) {
                return Err(OfficeError::DuplicateColumn {
                    sheet: self.name.clone(),
                    column: column.key.clone(),
                });
            }
            keys.push(column.key.as_str());
            if column.kind == XlsxColumnType::List && column.list.is_empty() {
                return Err(OfficeError::EmptyListColumn {
                    sheet: self.name.clone(),
                    column: column.key.clone(),
                });
            }
        }
        for (index, row) in self.rows.iter().enumerate() {
            for key in row.values.keys() {
                if !keys.contains(&key.as_str()) {
                    return Err(OfficeError::UnknownColumn {
                        sheet: self.name.clone(),
                        row: index,
                        column: key.clone(),
                    });
                }
            }
        }
        let missing = self.missing_required_cells();
        if let Some((row, column)) = missing.first() {
            return Err(OfficeError::MissingRequiredCell {
                sheet: self.name.clone(),
                row: *row,
                column: (*column).to_owned(),
            });
        }
        for total in &self.totals {
            let Some(column) = self.column(&total.column) else {
                return Err(OfficeError::UnknownTotalColumn {
                    sheet: self.name.clone(),
                    column: total.column.clone(),
                });
            };
            if !column.kind.is_numeric() {
                return Err(OfficeError::NonNumericTotal {
                    sheet: self.name.clone(),
                    column: total.column.clone(),
                });
            }
        }
        Ok(())
    }

    /// The decimal strings of a numeric column, in row order (empty cells skipped).
    #[must_use]
    pub fn numeric_values(&self, column: &str) -> Vec<&str> {
        self.rows
            .iter()
            .filter_map(|row| row.get(column))
            .filter(|cell| cell.kind == XlsxCellKind::Number && !cell.text.trim().is_empty())
            .map(|cell| cell.text.as_str())
            .collect()
    }
}

/// Validates a workbook's sheet names and order values.
///
/// # Errors
/// [`OfficeError`] when a sheet cannot be rendered.
pub fn validate_workbook(sheets: &[XlsxSheet]) -> Result<(), OfficeError> {
    let mut names: Vec<&str> = Vec::new();
    let mut orders: Vec<u32> = Vec::new();
    for sheet in sheets {
        sheet.validate()?;
        if names.contains(&sheet.name.as_str()) {
            return Err(OfficeError::DuplicateSheetName(sheet.name.clone()));
        }
        names.push(sheet.name.as_str());
        if orders.contains(&sheet.order) {
            return Err(OfficeError::DuplicateSheetOrder(sheet.order));
        }
        orders.push(sheet.order);
    }
    Ok(())
}

fn validate_sheet_name(name: &str) -> Result<(), OfficeError> {
    let length = name.chars().count();
    let forbidden = ['[', ']', ':', '*', '?', '/', '\\'];
    if length == 0
        || length > MAX_SHEET_NAME_CHARS
        || name
            .chars()
            .any(|character| forbidden.contains(&character) || character.is_control())
        || name.starts_with('\'')
        || name.ends_with('\'')
    {
        return Err(OfficeError::InvalidSheetName(name.to_owned()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payments_sheet() -> XlsxSheet {
        let mut sheet = XlsxSheet::new(
            "Payments",
            1,
            vec![
                XlsxColumn::new("rail", "Rail", XlsxColumnType::List)
                    .required()
                    .allowed_values(["edfali", "sadad"]),
                XlsxColumn::new("attempts", "Attempts", XlsxColumnType::Number).required(),
                XlsxColumn::new("volume", "Volume", XlsxColumnType::Number),
                XlsxColumn::new("settledOn", "Settled on", XlsxColumnType::Date),
            ],
        );
        sheet.rows = vec![
            XlsxRow::new()
                .with("rail", XlsxCell::text("edfali"))
                .with("attempts", XlsxCell::number("120"))
                .with("volume", XlsxCell::number("1500.0000"))
                .with("settledOn", XlsxCell::date("2026-11-30")),
            XlsxRow::new()
                .with("rail", XlsxCell::text("sadad"))
                .with("attempts", XlsxCell::number("80"))
                .with("volume", XlsxCell::number("900.5000")),
        ];
        sheet.totals = vec![XlsxTotal::sum("volume")];
        sheet
    }

    #[test]
    fn a_valid_sheet_passes_and_keeps_money_as_text() {
        let sheet = payments_sheet();
        sheet.validate().expect("sheet validates");
        assert_eq!(
            sheet.numeric_values("volume"),
            vec!["1500.0000", "900.5000"]
        );
        assert_eq!(sheet.numeric_values("rail").len(), 0);
        assert!(sheet.missing_required_cells().is_empty());
        assert_eq!(
            sheet.column("attempts").map(|column| column.kind),
            Some(XlsxColumnType::Number)
        );
        assert_eq!(XlsxCell::boolean(true).text, "true");
        assert!(XlsxCell::empty().is_empty());
    }

    #[test]
    fn a_missing_required_cell_is_rejected() {
        let mut sheet = payments_sheet();
        sheet.rows[1].values.remove("attempts");
        assert_eq!(
            sheet.validate(),
            Err(OfficeError::MissingRequiredCell {
                sheet: "Payments".to_owned(),
                row: 1,
                column: "attempts".to_owned(),
            })
        );
        assert_eq!(sheet.missing_required_cells(), vec![(1, "attempts")]);
    }

    #[test]
    fn unknown_and_duplicate_columns_are_rejected() {
        let mut unknown = payments_sheet();
        unknown.rows[0]
            .values
            .insert("mystery".to_owned(), XlsxCell::text("x"));
        assert_eq!(
            unknown.validate(),
            Err(OfficeError::UnknownColumn {
                sheet: "Payments".to_owned(),
                row: 0,
                column: "mystery".to_owned(),
            })
        );

        let mut duplicate = XlsxSheet::new(
            "S",
            1,
            vec![
                XlsxColumn::new("a", "A", XlsxColumnType::Text),
                XlsxColumn::new("a", "B", XlsxColumnType::Text),
            ],
        );
        duplicate.rows = Vec::new();
        assert_eq!(
            duplicate.validate(),
            Err(OfficeError::DuplicateColumn {
                sheet: "S".to_owned(),
                column: "a".to_owned(),
            })
        );
    }

    #[test]
    fn totals_must_target_a_numeric_column() {
        let mut sheet = payments_sheet();
        sheet.totals = vec![XlsxTotal::sum("rail")];
        assert_eq!(
            sheet.validate(),
            Err(OfficeError::NonNumericTotal {
                sheet: "Payments".to_owned(),
                column: "rail".to_owned(),
            })
        );
        sheet.totals = vec![XlsxTotal::sum("missing")];
        assert_eq!(
            sheet.validate(),
            Err(OfficeError::UnknownTotalColumn {
                sheet: "Payments".to_owned(),
                column: "missing".to_owned(),
            })
        );
    }

    #[test]
    fn sheet_names_follow_the_excel_rules() {
        assert_eq!(
            XlsxSheet::new("bad:name", 1, Vec::new()).validate(),
            Err(OfficeError::InvalidSheetName("bad:name".to_owned()))
        );
        assert_eq!(
            XlsxSheet::new("a".repeat(32), 1, Vec::new()).validate(),
            Err(OfficeError::InvalidSheetName("a".repeat(32)))
        );
        assert!(XlsxSheet::new("PSP return 2026-11", 1, Vec::new())
            .validate()
            .is_ok());
    }

    #[test]
    fn a_list_column_needs_allowed_values() {
        let sheet = XlsxSheet::new(
            "S",
            1,
            vec![XlsxColumn::new("rail", "Rail", XlsxColumnType::List)],
        );
        assert_eq!(
            sheet.validate(),
            Err(OfficeError::EmptyListColumn {
                sheet: "S".to_owned(),
                column: "rail".to_owned(),
            })
        );
    }

    #[test]
    fn a_workbook_has_unique_names_and_orders() {
        let first = payments_sheet();
        let second = XlsxSheet::new("Summary", 2, Vec::new());
        validate_workbook(&[first.clone(), second.clone()]).expect("workbook validates");
        assert_eq!(
            validate_workbook(&[first.clone(), first.clone()]),
            Err(OfficeError::DuplicateSheetName("Payments".to_owned()))
        );
        let mut same_order = second;
        same_order.name = "Other".to_owned();
        same_order.order = 1;
        assert_eq!(
            validate_workbook(&[first, same_order]),
            Err(OfficeError::DuplicateSheetOrder(1))
        );
    }

    #[test]
    fn column_types_keep_the_ts_wire_values() {
        assert_eq!(XlsxColumnType::Text.as_str(), "string");
        assert_eq!(XlsxColumnType::Number.as_str(), "number");
        assert!(XlsxColumnType::Number.is_numeric());
        assert!(!XlsxColumnType::Text.is_numeric());
        assert_eq!(XLSX_SCHEMA_VERSION, 1);
        assert_eq!(MAX_SHEET_NAME_CHARS, 31);
    }
}
